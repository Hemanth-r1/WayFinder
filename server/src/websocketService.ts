import { WebSocketServer, WebSocket } from 'ws';
import { getSimulationEngine, type BBox } from './simulationEngine.js';
import { getConditions } from './conditionsService.js';

/** What a client is looking at; vehicles are sent only for this area. */
export interface Viewport {
  bbox: BBox | null;
  zoom: number;
}

interface WSClient {
  ws: WebSocket;
  userId?: string;
  view: Viewport;
  lastTraffic: number;
}

const wss = new WebSocketServer({ noServer: true });
const clients = new Map<WebSocket, WSClient>();
/** Simulation ticks at ~20 Hz; clients animate between these frames. */
const BROADCAST_INTERVAL_MS = 500;
/** City-wide traffic colours change slowly. */
const TRAFFIC_INTERVAL_MS = 3000;
/** Below this zoom vehicles are dots too small to matter; the traffic layer shows the city. */
const VEHICLE_MIN_ZOOM = 13.5;
const MAX_VEHICLES_PER_UPDATE = 2500;
let lastBroadcast = 0;

/** Parses "w,s,e,n" into a bbox (or null). */
export function parseBBox(raw: unknown): BBox | null {
  const parts = Array.isArray(raw) ? raw.map(Number) : typeof raw === 'string' ? raw.split(',').map(Number) : [];
  return parts.length === 4 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2], parts[3]] : null;
}

/**
 * Live update for one viewer: vehicles in view (all navigating users always), each
 * signal's current phase, stats, conditions, and — when asked — traffic per road.
 */
export function buildUpdate(view: Viewport, includeTraffic: boolean): Record<string, unknown> | null {
  const engine = getSimulationEngine();
  if (!engine) return null;

  const showVehicles = view.bbox !== null && view.zoom >= VEHICLE_MIN_ZOOM;
  const vehicles = showVehicles
    ? engine.getVehiclesIn(padBBox(view.bbox!), MAX_VEHICLES_PER_UPDATE)
    : engine.getVehicles().filter(v => v.isNavigated);

  const signalStates: Record<string, [number, number]> = {};
  for (const s of engine.getSignals()) signalStates[s.id] = [s.currentPhaseIndex, Math.round(s.timer * 10) / 10];

  const data: Record<string, unknown> = {
    vehicles, signalStates, stats: engine.getStats(), conditions: getConditions(), at: Date.now(),
  };
  if (includeTraffic) data.traffic = [...engine.getTraffic()].filter(([, level]) => level > 0);
  return data;
}

/** Bbox grown by 20% on each side so vehicles entering the screen are already there. */
function padBBox([w, s, e, n]: BBox): BBox {
  const dx = (e - w) * 0.2, dy = (n - s) * 0.2;
  return [w - dx, s - dy, e + dx, n + dy];
}

export function handleWebSocketUpgrade(request: any, socket: any, head: any) {
  wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
    wss.emit('connection', ws, request);
  });
}

export function initializeWebSocket() {
  wss.on('connection', (ws: WebSocket) => {
    const client: WSClient = { ws, view: { bbox: null, zoom: 0 }, lastTraffic: 0 };
    clients.set(ws, client);
    sendTo(client, 'initial', true);

    ws.on('message', (data: string) => {
      try {
        handleMessage(client, JSON.parse(data));
      } catch (err: any) {
        console.error('[WebSocket] Invalid message:', err);
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  getSimulationEngine()?.onUpdate(() => broadcast());
}

function handleMessage(client: WSClient, message: any) {
  switch (message.type) {
    case 'viewport':
      client.view = { bbox: parseBBox(message.bbox), zoom: Number(message.zoom) || 0 };
      break;
    case 'setUserId':
      client.userId = message.userId;
      break;
    case 'subscribe':
    case 'unsubscribe':
      break; // everything is sent; kept for older clients
    default:
      console.warn('[WebSocket] Unknown message type:', message.type);
  }
}

function sendTo(client: WSClient, type: 'initial' | 'update', forceTraffic = false) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  const includeTraffic = forceTraffic || now - client.lastTraffic >= TRAFFIC_INTERVAL_MS;
  const data = buildUpdate(client.view, includeTraffic);
  if (!data) {
    client.ws.send(JSON.stringify({ type: 'error', message: 'Simulation engine not running' }));
    return;
  }
  if (includeTraffic) client.lastTraffic = now;
  client.ws.send(JSON.stringify({ type, data }));
}

function broadcast() {
  const now = Date.now();
  if (clients.size === 0 || now - lastBroadcast < BROADCAST_INTERVAL_MS) return;
  lastBroadcast = now;
  for (const client of clients.values()) sendTo(client, 'update');
}

export function broadcastToUser(userId: string, message: any) {
  for (const client of clients.values()) {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}
