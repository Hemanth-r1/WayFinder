// Production is served by Firebase Hosting, which forwards /api/** to Cloud Run on the same origin.
const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? 'http://localhost:8080' : '');
const WS_URL = SERVER_URL
  ? SERVER_URL.replace('http://', 'ws://').replace('https://', 'wss://')
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
/** Hosting rewrites don't carry WebSockets; if no socket opens within this time, poll instead. */
const WS_CONNECT_TIMEOUT_MS = 4000;
const POLL_INTERVAL_MS = 1500;

export interface ServerVehicle {
  id: string;
  lat: number;
  lng: number;
  speed: number;
  bearing: number;
  type: string;
  color: string;
  isNavigated: boolean;
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

export interface Conditions {
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
    return fetch(`${SERVER_URL}${path}`, { ...init, headers });
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

  async fetchVehicles(): Promise<{ vehicles: ServerVehicle[] }> {
    const response = await fetch(`${SERVER_URL}/api/vehicles`);
    if (!response.ok) throw new Error(`Failed to fetch vehicles: ${response.statusText}`);
    return response.json();
  }

  async fetchSignals(): Promise<{ signals: ServerSignal[] }> {
    const response = await fetch(`${SERVER_URL}/api/signals`);
    if (!response.ok) throw new Error(`Failed to fetch signals: ${response.statusText}`);
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

  async resetJunction(id: string): Promise<{ changes: string[] }> {
    return this.post(`/api/junctions/${encodeURIComponent(id)}/reset`, {}, 'Failed to reset signal');
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
        const data = JSON.parse(event.data);
        this.notifyCallbacks(data);
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
    const poll = async () => {
      try {
        // Road traffic levels change slowly: every other poll
        const params = new URLSearchParams({ traffic: this.pollCount++ % 2 === 0 ? '1' : '0' });
        if (this.view) {
          params.set('bbox', this.view.bbox.map(v => v.toFixed(5)).join(','));
          params.set('zoom', this.view.zoom.toFixed(1));
        }
        const response = await fetch(`${SERVER_URL}/api/state?${params}`);
        if (response.ok) this.notifyCallbacks({ type: 'update', data: await response.json() });
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
