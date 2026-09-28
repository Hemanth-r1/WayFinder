const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8080';
const WS_URL = SERVER_URL.replace('http://', 'ws://').replace('https://', 'wss://');

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
  async startNavigation(userId: string, sourceNodeId: string, destNodeId: string, edgeIds?: string[]): Promise<NavigationResponse> {
    const response = await fetch(`${SERVER_URL}/api/user/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sourceNodeId, destNodeId, edgeIds }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to start navigation'));
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

    this.ws.onopen = () => {
      console.log('[ServerClient] WebSocket connected');
      this.connectionState = 'connected';
      
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
      if (this.shouldReconnect) this.scheduleReconnect(userId);
    };

    this.ws.onerror = (err) => {
      console.error('[ServerClient] WebSocket error:', err);
    };
  }

  disconnectWebSocket(): void {
    this.shouldReconnect = false;
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

  private scheduleReconnect(userId?: string): void {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      console.log('[ServerClient] Reconnecting WebSocket...');
      this.connectWebSocket(userId);
    }, 3000);
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
