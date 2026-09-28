import { WebSocketServer, WebSocket } from 'ws';
import { getSimulationEngine } from './simulationEngine.js';
import type { SimState } from './simulationEngine.js';
import { getConditions } from './conditionsService.js';

interface WSClient {
  ws: WebSocket;
  userId?: string;
  subscribedChannels: Set<string>;
}

const wss = new WebSocketServer({ noServer: true });
const clients = new Map<WebSocket, WSClient>();
/** Simulation ticks at ~20 Hz; clients only need a few frames per second. */
const BROADCAST_INTERVAL_MS = 250;
let lastBroadcast = 0;

export function handleWebSocketUpgrade(request: any, socket: any, head: any) {
  wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
    wss.emit('connection', ws, request);
  });
}

export function initializeWebSocket() {
  wss.on('connection', (ws: WebSocket) => {
    const client: WSClient = {
      ws,
      subscribedChannels: new Set(['vehicles', 'signals', 'stats']),
    };
    clients.set(ws, client);

    console.log('[WebSocket] Client connected');

    // Send initial state
    sendInitialState(client);

    ws.on('message', (data: string) => {
      try {
        const message = JSON.parse(data);
        handleMessage(client, message);
      } catch (err: any) {
        console.error('[WebSocket] Invalid message:', err);
      }
    });

    ws.on('close', () => {
      console.log('[WebSocket] Client disconnected');
      clients.delete(ws);
    });

    ws.on('error', (err: any) => {
      console.error('[WebSocket] Error:', err);
      clients.delete(ws);
    });
  });

  // Subscribe to simulation engine updates
  const engine = getSimulationEngine();
  if (engine) {
    engine.onUpdate((state: SimState) => {
      broadcastStateUpdate(state);
    });
  }
}

function handleMessage(client: WSClient, message: any) {
  switch (message.type) {
    case 'subscribe':
      if (message.channels && Array.isArray(message.channels)) {
        message.channels.forEach((ch: string) => client.subscribedChannels.add(ch));
        sendAck(client, 'subscribed', message.channels);
      }
      break;
    case 'unsubscribe':
      if (message.channels && Array.isArray(message.channels)) {
        message.channels.forEach((ch: string) => client.subscribedChannels.delete(ch));
        sendAck(client, 'unsubscribed', message.channels);
      }
      break;
    case 'setUserId':
      client.userId = message.userId;
      sendAck(client, 'userIdSet', message.userId);
      break;
    default:
      console.warn('[WebSocket] Unknown message type:', message.type);
  }
}

function sendInitialState(client: WSClient) {
  const engine = getSimulationEngine();
  if (!engine) {
    client.ws.send(JSON.stringify({ type: 'error', message: 'Simulation engine not running' }));
    return;
  }

  const vehicles = engine.getVehicles();
  const signals = engine.getSignals();
  const stats = engine.getStats();

  client.ws.send(JSON.stringify({
    type: 'initial',
    data: {
      vehicles,
      signals,
      stats,
    },
  }));
}

function broadcastStateUpdate(state: SimState) {
  const now = Date.now();
  if (clients.size === 0 || now - lastBroadcast < BROADCAST_INTERVAL_MS) return;
  lastBroadcast = now;

  const vehicles = Array.from(state.vehicles.values());
  const signals = Array.from(state.signals.values());
  const stats = getSimulationEngine()?.getStats();

  const message = JSON.stringify({
    type: 'update',
    data: {
      vehicles,
      signals,
      stats,
      conditions: getConditions(),
    },
  });

  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

function sendAck(client: WSClient, action: string, data: any) {
  client.ws.send(JSON.stringify({
    type: 'ack',
    action,
    data,
  }));
}

export function broadcastToUser(userId: string, message: any) {
  for (const client of clients.values()) {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}
