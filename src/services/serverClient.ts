// Production is served by Firebase Hosting, which forwards /api/** to Cloud Run on the same origin.
const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? 'http://localhost:8080' : '');
const WS_URL = SERVER_URL
  ? SERVER_URL.replace('http://', 'ws://').replace('https://', 'wss://')
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
/** Hosting rewrites don't carry WebSockets; if no socket opens within this time, poll instead. */
const WS_CONNECT_TIMEOUT_MS = 4000;
/** Matches the CDN cache time of /api/live/* (1 s) */
const POLL_INTERVAL_MS = 1000;
/** Same grid as the server's liveSnapshot.ts */
const CELL_DEG = 0.02;
const VEHICLE_MIN_ZOOM = 13.5;
/** More cells than this (zoomed far out): no vehicles, the traffic colours show the city */
const MAX_CELLS = 25;
/** Colour per vehicle type (the server's KINDS) */
const TYPE_COLOR: Record<string, string> = {
  bike: '#FFB300', hatchback: '#42A5F5', sedan: '#1E88E5', suv: '#26A69A', xuv: '#00897B', auto: '#8BC34A',
  bus: '#EF5350', van: '#7E57C2', tempo: '#5C6BC0', minitruck: '#A1887F', truck: '#8D6E63', lorry: '#6D4C41',
  tipper: '#F9A825', trailer: '#546E7A',
};

/** Live vehicles arrive as [id, lat, lng, km/h, bearing, type, flag] (flag 1 wrong way, 2 ran a red). */
function decodeVehicles(raw: unknown[]): ServerVehicle[] {
  return raw.map(v => {
    if (!Array.isArray(v)) return v as ServerVehicle;
    const [id, lat, lng, speed, bearing, type, flag] = v as [string, number, number, number, number, string, number];
    return {
      id, lat, lng, speed, bearing, type, color: TYPE_COLOR[type] ?? '#1E88E5', isNavigated: false,
      wrongWay: flag === 1 || undefined, violation: flag === 2 || undefined,
    };
  });
}

function decodeMessage(msg: any): any {
  if ((msg?.type === 'update' || msg?.type === 'initial') && Array.isArray(msg.data?.vehicles)) {
    msg.data.vehicles = decodeVehicles(msg.data.vehicles);
  }
  return msg;
}

export interface ServerVehicle {
  id: string;
  lat: number;
  lng: number;
  speed: number;
  bearing: number;
  type: string;
  color: string;
  isNavigated: boolean;
  wrongWay?: boolean;
  violation?: boolean;
}

export interface ServerSignal {
  id: string;
  nodeId: string;
  phases: Array<{ group: string; color: string; duration: number; yellowDuration: number }>;
  currentPhaseIndex: number;
  timer: number;
  cycleLength: number;
  offset: number;
  greenWaveDirection: string | null;
  congestionLevel: number;
  adaptiveTiming: boolean;
  nodeIds?: string[];
  axis?: number;
  approaches?: Array<{ edgeId: string; bearing: number; group: string }>;
}

export interface ServerStats {
  totalVehicles: number;
  avgSpeed: number;
  avgDelay: number;
  congestionHotspots: number;
  greenWaveActive: boolean;
  signalCoordinationScore: number;
  throughput: number;
  maxCongestion: number;
  slaSpeed: number;
  slaCompliant: boolean;
  emergencySlaSpeed: number;
  activeCorridors: number;
  simulatedVehicles?: number;
  realVehicles?: number;
}

export type WeatherCondition = 'clear' | 'rain' | 'heavy_rain';
export type WeatherMode = 'live' | WeatherCondition;
export type TrafficLevel = 'light' | 'normal' | 'heavy';
/** 'auto' follows Bangalore's time of day */
export type TrafficMode = 'auto' | TrafficLevel;
export type DriveMode = 'gps' | 'simulated';

export type ReportType = 'block' | 'tree' | 'waterlogging' | 'rain';

/** A signalised junction in the police list. */
export interface JunctionSummary {
  id: string;
  name: string;
  lat: number;
  lng: number;
  status: 'ok' | 'busy' | 'critical';
  score: number;
  queueVehicles: number;
  cycle: number;
  controlled: boolean;
}

/** A road feeding a junction approach (or merging just after an exit) with live flow. */
export interface FeederRoad {
  edgeId: string;
  road: string;
  kind: 'flyover' | 'ramp' | 'road';
  metres: number;
  from: string;
  joins?: string;
  arrivalsPerHour: number;
}

/** Vehicles moving from one approach to one exit (turning movement count). */
export interface MovementRow {
  fromRoad: string;
  fromDir: string;
  toRoad: string;
  toDir: string;
  turn: 'straight' | 'left' | 'right' | 'U-turn';
  vehicles: number;
  persons: number;
  vehiclesPerHour: number;
  personsPerHour: number;
  realVehicles: number;
  byType: Record<string, number>;
  avgWaitSeconds: number;
}

export interface JunctionApproach {
  edgeId: string;
  road: string;
  group: string;
  bearing: number;
  lanes: number;
  light: 'RED' | 'YELLOW' | 'GREEN';
  queueVehicles: number;
  queueMetres: number;
  arrivalsPerHour: number;
  from?: { id: string; name: string; metres: number };
  /** "from the south-east, towards …" */
  direction: string;
  /** Estimated wait for the last vehicle in the queue (s); over 5 min is flagged */
  waitSeconds: number;
  overLimit: boolean;
  /** Flyovers, ramps and roads feeding this approach before the stop line */
  feeders: FeederRoad[];
}

export interface JunctionDetail extends JunctionSummary {
  axis: number;
  phase: { index: number; group: string; color: string; timer: number; duration: number };
  phases: { group: string; color: string; duration: number }[];
  greens: Record<string, number>;
  approaches: JunctionApproach[];
  recommendation: {
    cycle: number;
    greens: Record<string, number>;
    flowRatio: Record<string, number>;
    saturation: number;
    summary: string;
  };
  advice: string[];
  /** Roads joining the exits just after the junction */
  merges: FeederRoad[];
  neighbours: {
    upstream: { id: string; name: string; road: string; metres: number; seconds: number; toGroup: string }[];
    downstream: { id: string; name: string; road: string; metres: number; seconds: number; fromGroup: string }[];
  };
  control: {
    hold?: { group: string; from: number; until: number; by: string };
    plan?: { greens: Record<string, number>; by: string; at: number };
    scale?: { group: string; factor: number; until: number; by: string };
  } | null;
}

export interface ControlLogEntry {
  at: number;
  by: string;
  junction: string;
  action: string;
  detail: string;
}
export type ReportVote = 'confirm' | 'clear';

/** Crowd report of a road block, waterlogging or local heavy rain. */
export interface RoadReport {
  id: string;
  type: ReportType;
  status: 'unconfirmed' | 'confirmed';
  lat: number;
  lng: number;
  /** Metres covered around the point (0 for blocks, which cover their road segment) */
  radius: number;
  roadName: string;
  edgeIds: string[];
  confirmations: number;
  clears: number;
  confirmSource: 'people' | 'operator' | 'gps' | null;
  createdAt: number;
  expiresAt: number;
}

export interface ReportPrompt {
  id: string;
  type: ReportType;
  status: RoadReport['status'];
  roadName: string;
  distance: number;
  confirmations: number;
}

/** Simulation driver behaviour switches */
export interface Behaviour {
  redJumping: boolean;
  laneWeaving: boolean;
  wrongWay: boolean;
}

export type JamSeverity = 'stopped' | 'slow';

/** An intentional jam placed by an operator in the simulation */
export interface Jam {
  id: string;
  lat: number;
  lng: number;
  road: string;
  severity: JamSeverity;
  metres: number;
  vehicles: number;
  createdAt: number;
  expiresAt: number;
}

export interface Conditions {
  behaviour?: Behaviour;
  weather: {
    condition: WeatherCondition;
    precipitation: number | null;
    source: 'live' | 'manual' | 'unavailable';
    speedFactor: number;
    capacityFactor: number;
  };
  weatherMode: WeatherMode;
  /** Effective level (follows the clock in 'auto' mode) */
  trafficLevel: TrafficLevel;
  trafficMode?: TrafficMode;
  /** Current traffic as a share of peak (0–1) */
  demand?: number;
  reports: RoadReport[];
}

export interface RerouteOffer {
  /** blocked = confirmed block ahead; reported = unconfirmed block or waterlogging ahead */
  reason: 'faster' | 'blocked' | 'reported';
  savedSeconds: number;
  distance: number;
  estimatedTime: number;
  roadNames: string[];
  geometry: Array<{ lat: number; lng: number }>;
}

export interface PositionResult {
  onRoute: boolean;
  arrived: boolean;
  rerouted: boolean;
}

/** One route option from the server, fastest first. */
export interface RouteOption {
  path: string[];
  edgeIds: string[];
  distance: number;
  estimatedTime: number;
  signalCount: number;
  roadNames: string[];
  geometry: Array<{ lat: number; lng: number }>;
  /** Most other active navigators sharing any single road segment of this route */
  sharedUsers: number;
}

export interface NavigationResponse {
  /** Remaining path geometry */
  path: Array<{ lat: number; lng: number }>;
  distance: number;
  duration: number;
  signals: Array<{
    signalId: string;
    name?: string;
    direction?: string;
    position: { lat: number; lng: number };
    distance: number;
    currentState: 'RED' | 'YELLOW' | 'GREEN';
    estimatedWait: number;
    estimatedArrival: number;
  }>;
  trafficConditions: {
    congestionLevel: number;
    avgSpeed: number;
    vehicleCount: number;
  };
  routeInfo: RouteOption;
  alternatives: RouteOption[];
  arrived: boolean;
  /** This driver's own car on the live map (other drivers' cars are anonymous) */
  vehicleId?: string;
  mode: DriveMode;
  /** Better route available now (road block ahead, or faster with live traffic) */
  reroute: RerouteOffer | null;
  /** A road block is ahead and no way around it was found */
  blockedAhead: boolean;
  weather: WeatherCondition;
  /** A crowd report on the road ahead the driver hasn't answered yet */
  reportPrompt: ReportPrompt | null;
}

/** Headers that identify the caller: a Firebase ID token, or the demo identity. */
export type IdentityProvider = () => Promise<Record<string, string>>;

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    if (body?.error) return body.error;
  } catch { /* not JSON */ }
  return `${fallback}: ${response.status} ${response.statusText}`;
}

class ServerClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private updateCallbacks: Set<(data: any) => void> = new Set();
  private connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private identity: IdentityProvider = async () => ({});

  /** Called when the signed-in user changes. */
  setIdentity(provider: IdentityProvider): void {
    this.identity = provider;
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...(await this.identity()), ...(init.headers as Record<string, string> | undefined) };
    const res = await fetch(`${SERVER_URL}${path}`, { ...init, headers });
    // The server paces repeated calls when it is busy (X-Next-Ms)
    const next = Number(res.headers.get('X-Next-Ms'));
    if (next > 0) this.paceMs[path.endsWith('/position') ? 'gps' : path.endsWith('/navigation') ? 'navigation' : 'other'] = next;
    return res;
  }

  private paceMs: Record<'gps' | 'navigation' | 'other', number> = { gps: 2000, navigation: 2000, other: 2000 };

  /** How long to wait before the next GPS fix or navigation update, as the server asked. */
  pace(kind: 'gps' | 'navigation'): number {
    return this.paceMs[kind];
  }
  private shouldReconnect = false;
  private connectTimer: number | null = null;
  private pollTimer: number | null = null;
  /** Map area on screen ([west, south, east, north]) and zoom; vehicles are sent only for it */
  private view: { bbox: [number, number, number, number]; zoom: number } | null = null;
  private pollCount = 0;

  /** Tells the server which part of the map is visible. */
  setViewport(bbox: [number, number, number, number], zoom: number): void {
    this.view = { bbox, zoom };
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'viewport', bbox, zoom }));
  }

  async fetchGraph() {
    const response = await fetch(`${SERVER_URL}/api/graph`);
    if (!response.ok) throw new Error(`Failed to fetch graph: ${response.statusText}`);
    return response.json();
  }

  async fetchStats(): Promise<ServerStats> {
    const response = await fetch(`${SERVER_URL}/api/stats`);
    if (!response.ok) throw new Error(`Failed to fetch stats: ${response.statusText}`);
    return response.json();
  }

  /** Route options for this user, accounting for routes other users are already driving. */
  async fetchRouteOptions(userId: string | undefined, sourceId: string, destId: string, signal?: AbortSignal): Promise<RouteOption[]> {
    const response = await this.send('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sourceId, destId }),
      signal,
    });
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to plan route'));
    const { routes } = await response.json();
    return routes ?? [];
  }

  /** Starts driving `edgeIds` (a chosen RouteOption); the server falls back to its best route if stale. */
  async startNavigation(
    userId: string, sourceNodeId: string, destNodeId: string, edgeIds?: string[], mode: DriveMode = 'simulated',
  ): Promise<NavigationResponse> {
    return this.post('/api/user/start', { userId, sourceNodeId, destNodeId, edgeIds, mode }, 'Failed to start navigation');
  }

  /** Sends a GPS fix while navigating in 'gps' mode. */
  async sendPosition(userId: string, lat: number, lng: number, speedKmh?: number): Promise<PositionResult> {
    return this.post(`/api/user/${encodeURIComponent(userId)}/position`, { lat, lng, speed: speedKmh }, 'Failed to send position');
  }

  /** Switches to the reroute offered in the latest navigation update. */
  async acceptReroute(userId: string): Promise<{ routeInfo: RouteOption }> {
    return this.post(`/api/user/${encodeURIComponent(userId)}/reroute`, {}, 'Failed to reroute');
  }

  async fetchConditions(): Promise<Conditions> {
    const response = await fetch(`${SERVER_URL}/api/conditions`);
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to load road conditions'));
    return response.json();
  }

  async setWeatherMode(mode: WeatherMode): Promise<Conditions> {
    return this.post('/api/conditions/weather', { mode }, 'Failed to set weather');
  }

  async setTrafficLevel(level: TrafficMode): Promise<Conditions> {
    return this.post('/api/conditions/traffic', { level }, 'Failed to set traffic level');
  }

  async setBehaviour(change: Partial<Behaviour>): Promise<Conditions> {
    return this.post('/api/conditions/behaviour', change, 'Failed to change driver behaviour');
  }

  async listJams(): Promise<Jam[]> {
    const response = await this.send('/api/jams');
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to load jams'));
    return (await response.json()).jams;
  }

  /** Jams the road nearest (lat, lng) in the simulation: a queue `metres` long behind the spot. */
  async createJam(lat: number, lng: number, severity: JamSeverity, metres = 400, minutes = 20): Promise<{ jam: Jam; jams: Jam[] }> {
    return this.post('/api/jams', { lat, lng, severity, metres, minutes }, 'Failed to create jam');
  }

  async removeJam(id: string): Promise<Jam[]> {
    const response = await this.send(`/api/jams/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to remove jam'));
    return (await response.json()).jams;
  }

  /** Blocks the road nearest (lat, lng) in both directions. */
  /** Reports a block, waterlogging or heavy rain at a tapped point (merges with a nearby one). */
  async report(type: ReportType, lat: number, lng: number, radiusMetres?: number): Promise<{ report: RoadReport; merged: boolean }> {
    return this.post('/api/reports', { type, lat, lng, radius: radiusMetres }, 'Failed to send report');
  }

  /** "Still there" / "It's clear". `report` is null once the report has been cleared. */
  async voteReport(id: string, vote: ReportVote): Promise<{ report: RoadReport | null; cleared: boolean }> {
    return this.post(`/api/reports/${encodeURIComponent(id)}/vote`, { vote }, 'Failed to send answer');
  }

  /** Operators remove any report; reporters can withdraw their own unconfirmed one. */
  async removeReport(id: string): Promise<void> {
    const response = await this.send(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to remove report'));
  }

  // ── Junctions (police view and signal control) ───────────────────────────────

  private async getJson<T>(path: string, failure: string): Promise<T> {
    const response = await this.send(path);
    if (!response.ok) throw new Error(await errorMessage(response, failure));
    return response.json();
  }

  async listJunctions(): Promise<JunctionSummary[]> {
    return (await this.getJson<{ junctions: JunctionSummary[] }>('/api/junctions', 'Failed to load junctions')).junctions;
  }

  async getJunction(id: string): Promise<JunctionDetail> {
    return this.getJson(`/api/junctions/${encodeURIComponent(id)}`, 'Failed to load junction');
  }

  /** Controllers: keep a group green; with coordinate, neighbours open a green wave / hold traffic back. */
  async holdJunction(id: string, group: string, seconds: number, coordinate: boolean): Promise<{ changes: string[] }> {
    return this.post(`/api/junctions/${encodeURIComponent(id)}/hold`, { group, seconds, coordinate }, 'Failed to hold signal');
  }

  async planJunction(id: string, plan: Record<string, number> | 'recommended'): Promise<{ changes: string[] }> {
    const body = plan === 'recommended' ? { recommended: true } : { greens: plan };
    return this.post(`/api/junctions/${encodeURIComponent(id)}/plan`, body, 'Failed to set timing');
  }

  /** Demo/training: fill a junction's approaches bumper-to-bumper in the simulation. */
  async surgeJunction(id: string, metres = 600): Promise<{ changes: string[] }> {
    return this.post(`/api/junctions/${encodeURIComponent(id)}/surge`, { metres }, 'Failed to create jam');
  }

  async resetJunction(id: string): Promise<{ changes: string[] }> {
    return this.post(`/api/junctions/${encodeURIComponent(id)}/reset`, {}, 'Failed to reset signal');
  }

  /** Turning movements at a junction over the last `hours`. */
  async junctionMovements(id: string, hours = 1): Promise<{ hours: number; rows: MovementRow[] }> {
    return this.getJson(`/api/junctions/${encodeURIComponent(id)}/movements?hours=${hours}`, 'Failed to load movements');
  }

  /** 15-minute movement counts as a CSV file (all junctions, or one). */
  async countsCsv(hours = 24, junction?: string): Promise<Blob> {
    const params = new URLSearchParams({ hours: String(hours) });
    if (junction) params.set('junction', junction);
    const response = await this.send(`/api/counts.csv?${params}`);
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to export counts'));
    return response.blob();
  }

  async controlLog(): Promise<ControlLogEntry[]> {
    return (await this.getJson<{ log: ControlLogEntry[] }>('/api/control/log', 'Failed to load log')).log;
  }

  private async post<T>(path: string, body: unknown, failure: string): Promise<T> {
    const response = await this.send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await errorMessage(response, failure));
    return response.json();
  }

  async getUserPosition(userId: string): Promise<ServerVehicle> {
    const response = await this.send(`/api/user/${encodeURIComponent(userId)}/position`);
    if (!response.ok) throw new Error(`Failed to fetch user position: ${response.statusText}`);
    return response.json();
  }

  async getUserNavigation(userId: string): Promise<NavigationResponse> {
    const response = await this.send(`/api/user/${encodeURIComponent(userId)}/navigation`);
    if (!response.ok) throw new Error(`Failed to fetch user navigation: ${response.statusText}`);
    return response.json();
  }

  async removeUserVehicle(userId: string): Promise<{ success: boolean }> {
    const response = await this.send(`/api/user/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(`Failed to remove user vehicle: ${response.statusText}`);
    return response.json();
  }

  connectWebSocket(userId?: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.shouldReconnect = true;
    this.connectionState = 'connecting';
    this.ws = new WebSocket(WS_URL);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (this.shouldReconnect && this.connectionState !== 'connected') this.startPolling();
    }, WS_CONNECT_TIMEOUT_MS);

    this.ws.onopen = () => {
      console.log('[ServerClient] WebSocket connected');
      this.connectionState = 'connected';
      this.stopPolling();
      
      if (userId) {
        this.ws?.send(JSON.stringify({ type: 'setUserId', userId }));
      }
      if (this.view) this.ws?.send(JSON.stringify({ type: 'viewport', ...this.view }));
    };

    this.ws.onmessage = (event) => {
      try {
        this.notifyCallbacks(decodeMessage(JSON.parse(event.data)));
      } catch (err) {
        console.error('[ServerClient] Failed to parse WebSocket message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[ServerClient] WebSocket disconnected');
      this.connectionState = 'disconnected';
      this.ws = null;
      if (!this.shouldReconnect) return;
      this.startPolling();
      this.scheduleReconnect(userId);
    };

    this.ws.onerror = (err) => {
      console.error('[ServerClient] WebSocket error:', err);
    };
  }

  disconnectWebSocket(): void {
    this.shouldReconnect = false;
    this.stopPolling();
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connectionState = 'disconnected';
  }

  /** HTTP fallback delivering the same 'update' messages the WebSocket sends. */
  private startPolling(): void {
    if (this.pollTimer) return;
    console.warn('[ServerClient] WebSocket unavailable — polling for live updates');
    // Everyone asks for the same cached pieces (/api/live/*), so the CDN answers most polls
    const getJson = async (path: string) => {
      const res = await fetch(`${SERVER_URL}${path}`);
      return res.ok ? res.json() : null;
    };
    const poll = async () => {
      try {
        const withTraffic = this.pollCount++ % 3 === 0; // road traffic changes slowly
        const cells: string[] = [];
        if (this.view && this.view.zoom >= VEHICLE_MIN_ZOOM) {
          const [w, so, e, n] = this.view.bbox;
          const dx = (e - w) * 0.2, dy = (n - so) * 0.2;
          const x0 = Math.floor((w - dx) / CELL_DEG), x1 = Math.floor((e + dx) / CELL_DEG);
          const y0 = Math.floor((so - dy) / CELL_DEG), y1 = Math.floor((n + dy) / CELL_DEG);
          if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_CELLS) {
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push(`/api/live/cell/${x}/${y}`);
          }
        }
        const [common, traffic, ...vehicleLists] = await Promise.all([
          getJson('/api/live/common'),
          withTraffic ? getJson('/api/live/traffic') : Promise.resolve(null),
          ...cells.map(getJson),
        ]);
        if (!common) return;
        const data = { ...common, vehicles: decodeVehicles(vehicleLists.flatMap(l => l ?? [])), ...(traffic ? { traffic } : {}) };
        this.notifyCallbacks({ type: 'update', data });
      } catch { /* server unreachable; keep trying */ }
    };
    poll();
    this.pollTimer = window.setInterval(poll, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleReconnect(userId?: string): void {
    if (this.reconnectTimer) return;
    // Back off while polling covers updates
    const delay = this.pollTimer ? 30000 : 3000;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      console.log('[ServerClient] Reconnecting WebSocket...');
      this.connectWebSocket(userId);
    }, delay);
  }

  onUpdate(callback: (data: any) => void): void {
    this.updateCallbacks.add(callback);
  }

  removeUpdateCallback(callback: (data: any) => void): void {
    this.updateCallbacks.delete(callback);
  }

  private notifyCallbacks(data: any): void {
    for (const callback of this.updateCallbacks) {
      callback(data);
    }
  }

  getConnectionState(): 'connecting' | 'connected' | 'disconnected' {
    return this.connectionState;
  }

  sendWebSocketMessage(message: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('[ServerClient] WebSocket not connected, cannot send message');
    }
  }
}

export const serverClient = new ServerClient();
