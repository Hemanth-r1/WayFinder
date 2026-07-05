import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats } from '../types';
import type { RouteInfo } from '../types';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8080';

export function graphFromJSON(data: {
  nodes: any[]; edges: any[]; adjacency: [string, string[]][];
  signals: any[];
}): { graph: RoadGraph; signals: Map<string, TrafficSignal> } {
  const nodes = new Map(data.nodes.map((n: any) => [n.id, n]));
  const edges = new Map(data.edges.map((e: any) => [e.id, e]));
  const adjacency = new Map<string, string[]>(data.adjacency);
  const signals = new Map(data.signals.map((s: any) => [s.nodeId, s]));
  return { graph: { nodes, edges, adjacency } as unknown as RoadGraph, signals };
}

export async function fetchGraphFromServer(): Promise<{
  graph: RoadGraph; signals: Map<string, TrafficSignal>; source: string; version: number;
}> {
  const res = await fetch(`${SERVER_URL}/api/graph`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();
  const { graph, signals } = graphFromJSON(data);
  return { graph, signals, source: data.source, version: data.version };
}

export async function fetchCongestion(
  vehicles: Map<string, Vehicle>, nodes: Map<string, any>
): Promise<{ zones: CongestionZone[]; stats: TrafficStats }> {
  const vehicleArray = Array.from(vehicles.values()).map(v => ({
    id: v.id, lat: v.lat, lng: v.lng, speed: v.speed, bearing: v.bearing,
    type: v.type, color: v.color, isNavigated: v.isNavigated,
  }));
  const nodeArray = Array.from(nodes.values()).map(n => ({
    id: n.id, lat: n.lat, lng: n.lng,
  }));
  const res = await fetch(`${SERVER_URL}/api/congestion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicles: vehicleArray, nodes: nodeArray }),
  });
  if (!res.ok) return { zones: [], stats: {} as TrafficStats };
  return res.json();
}

export async function fetchSLA(vehicles: Map<string, Vehicle>): Promise<{
  slaSpeed: number; slaCompliant: boolean; emergencySlaSpeed: number;
}> {
  const vehicleArray = Array.from(vehicles.values()).map(v => ({
    id: v.id, lat: v.lat, lng: v.lng, speed: v.speed, type: v.type,
  }));
  const res = await fetch(`${SERVER_URL}/api/sla`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicles: vehicleArray }),
  });
  if (!res.ok) return { slaSpeed: 0, slaCompliant: false, emergencySlaSpeed: 0 };
  return res.json();
}

export async function fetchRoute(
  graph: RoadGraph, signals: Map<string, TrafficSignal>,
  sourceId: string, destId: string
): Promise<RouteInfo | null> {
  const graphArray = {
    nodes: Array.from(graph.nodes.values()).map(n => ({ id: n.id, lat: n.lat, lng: n.lng })),
    edges: Array.from(graph.edges.values()).map(e => ({
      id: e.id, from: e.from, to: e.to, name: e.name,
      roadType: e.roadType, speedLimit: e.speedLimit, length: e.length, bearing: e.bearing,
      geometry: e.geometry,
    })),
    adjacency: Array.from(graph.adjacency.entries()),
  };
  const signalArray = Array.from(signals.values()).map(s => ({
    id: s.id, nodeId: s.nodeId,
    phases: s.phases, currentPhaseIndex: s.currentPhaseIndex,
    timer: s.timer, cycleLength: s.cycleLength, offset: s.offset,
    greenWaveDirection: s.greenWaveDirection,
    congestionLevel: s.congestionLevel, adaptiveTiming: s.adaptiveTiming,
  }));
  const res = await fetch(`${SERVER_URL}/api/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      graph: graphArray, signals: signalArray,
      sourceId, destId,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.route;
}
