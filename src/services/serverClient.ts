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
  approaches: Array<{ edgeId: string; bearing: number; color: string; duration: number }>;
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
export type DriveMode = 'gps' | 'simulated';

export interface RoadBlock {
  id: string;
  edgeIds: string[];
  lat: number;
  lng: number;
  roadName: string;
  reason: string;
  reportedBy: string | null;
  createdAt: number;
  expiresAt: number;
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
  trafficLevel: TrafficLevel;
  blocks: RoadBlock[];
}

export interface RerouteOffer {
  reason: 'faster' | 'blocked';
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
}

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
  private shouldReconnect = false;
  private connectTimer: number | null = null;
  private pollTimer: number | null = null;

  async fetchGraph(forceRefresh = false) {
    const url = `${SERVER_URL}/api/graph${forceRefresh ? '?refresh=true' : ''}`;
    const response = await fetch(url);
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
    const response = await fetch(`${SERVER_URL}/api/route`, {
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

  async setTrafficLevel(level: TrafficLevel): Promise<Conditions> {
    return this.post('/api/conditions/traffic', { level }, 'Failed to set traffic level');
  }

  /** Blocks the road nearest (lat, lng) in both directions. */
  async reportBlock(lat: number, lng: number, radiusMetres?: number, userId?: string, reason?: string): Promise<RoadBlock> {
    return this.post('/api/blocks', { lat, lng, radius: radiusMetres, userId, reason }, 'Failed to report road block');
  }

  async removeBlock(id: string): Promise<void> {
    const response = await fetch(`${SERVER_URL}/api/blocks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to clear road block'));
  }

  private async post<T>(path: string, body: unknown, failure: string): Promise<T> {
    const response = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await errorMessage(response, failure));
    return response.json();
  }

  async getUserPosition(userId: string): Promise<ServerVehicle> {
    const response = await fetch(`${SERVER_URL}/api/user/${encodeURIComponent(userId)}/position`);
    if (!response.ok) throw new Error(`Failed to fetch user position: ${response.statusText}`);
    return response.json();
  }

  async getUserNavigation(userId: string): Promise<NavigationResponse> {
    const response = await fetch(`${SERVER_URL}/api/user/${encodeURIComponent(userId)}/navigation`);
    if (!response.ok) throw new Error(`Failed to fetch user navigation: ${response.statusText}`);
    return response.json();
  }

  async removeUserVehicle(userId: string): Promise<{ success: boolean }> {
    const response = await fetch(`${SERVER_URL}/api/user/${encodeURIComponent(userId)}`, {
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
        const response = await fetch(`${SERVER_URL}/api/state`);
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
