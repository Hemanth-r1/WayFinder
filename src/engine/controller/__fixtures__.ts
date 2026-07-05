import type {
  TrafficSignal, RoadNode, RoadEdge, RoadGraph, Vehicle, VehicleType,
} from '../../types';
import { SIGNAL_TIMING } from '../../types';

export function makeNode(id: string, lat: number, lng: number): RoadNode {
  return { id, lat, lng, isIntersection: true };
}

export function makeSignal(opts: {
  id?: string;
  nodeId?: string;
  phases?: TrafficSignal['phases'];
  currentPhaseIndex?: number;
  timer?: number;
} = {}): TrafficSignal {
  const yellowDur = SIGNAL_TIMING.yellowDuration;
  const phases = opts.phases ?? [
    { group: 'NS', color: 'GREEN', duration: SIGNAL_TIMING.minGreen, yellowDuration: yellowDur },
    { group: 'NS', color: 'YELLOW', duration: yellowDur, yellowDuration: 0 },
    { group: 'EW', color: 'GREEN', duration: SIGNAL_TIMING.minGreen, yellowDuration: yellowDur },
    { group: 'EW', color: 'YELLOW', duration: yellowDur, yellowDuration: 0 },
  ];
  return {
    id: opts.id ?? 'SIG-1',
    nodeId: opts.nodeId ?? 'N-1',
    phases,
    currentPhaseIndex: opts.currentPhaseIndex ?? 0,
    timer: opts.timer ?? 0,
    cycleLength: SIGNAL_TIMING.minGreen * 2 + yellowDur * 2,
    offset: 0,
    greenWaveDirection: null,
    congestionLevel: 0,
    adaptiveTiming: true,
    approaches: [],
  };
}

export function makeVehicle(opts: {
  id?: string;
  type?: VehicleType;
  lat?: number;
  lng?: number;
  bearing?: number;
  speed?: number;
  currentEdgeId?: string;
} = {}): Vehicle {
  return {
    id: opts.id ?? 'V-1',
    type: opts.type ?? 'sedan',
    lat: opts.lat ?? 12.9716,
    lng: opts.lng ?? 77.5946,
    bearing: opts.bearing ?? 0,
    speed: opts.speed ?? 13,
    targetSpeed: 17,
    acceleration: 1.5,
    deceleration: 4,
    currentEdgeId: opts.currentEdgeId ?? '',
    edgeProgress: 0,
    targetNodeId: '',
    destinationNodeId: '',
    route: [],
    routeIndex: 0,
    color: '#2196F3',
    length: 4,
    width: 2,
    stuckTime: 0,
    rerouted: false,
    responseDelay: 1,
    reactionTimer: 0,
    waitingForSignal: false,
    driverAggression: 1,
    routeETA: 0,
    distanceTravelled: 0,
    timeTravelled: 0,
    laneIndex: 0,
    segmentIndex: 0,
  };
}

export function makeEdge(
  id: string, from: string, to: string,
  bearing: number, length = 100,
): RoadEdge {
  const fromNode = fakeNodes.get(from);
  const toNode = fakeNodes.get(to);
  const a = { lat: fromNode?.lat ?? 0, lng: fromNode?.lng ?? 0 };
  const b = { lat: toNode?.lat ?? 0, lng: toNode?.lng ?? 0 };
  return {
    id, from, to,
    roadType: 'secondary',
    speedLimit: 50,
    lanes: 2,
    length,
    bearing,
    congestionWeight: 0,
    geometry: [a, b],
    oneway: true,
  };
}

const fakeNodes = new Map<string, RoadNode>();

export function makeGraph(): RoadGraph {
  fakeNodes.clear();
  const nodes = new Map<string, RoadNode>();
  const adj = new Map<string, RoadEdge[]>();
  const edges = new Map<string, RoadEdge>();

  fakeNodes.set('N-S', makeNode('N-S', 12.9716, 77.5946));

  return { nodes, edges, adjacency: adj };
}

export function graphWithSignal(opts: {
  nodeLat?: number;
  nodeLng?: number;
  edges?: Array<{ id: string; from: string; to: string; bearing: number }>;
  nodes?: Array<{ id: string; lat: number; lng: number }>;
} = {}): { graph: RoadGraph; signal: TrafficSignal; node: RoadNode } {
  const { graph, signal } = makeGraphAndSignal(opts);
  return { graph, signal, node: graph.nodes.get(signal.nodeId)! };
}

export function makeGraphAndSignal(opts: {
  nodeLat?: number;
  nodeLng?: number;
  edges?: Array<{ id: string; from: string; to: string; bearing: number }>;
  nodes?: Array<{ id: string; lat: number; lng: number }>;
} = {}): { graph: RoadGraph; signal: TrafficSignal } {
  const lat = opts.nodeLat ?? 12.9716;
  const lng = opts.nodeLng ?? 77.5946;
  const signalNode = makeNode('N-SIG', lat, lng);

  const graph: RoadGraph = {
    nodes: new Map([[signalNode.id, signalNode]]),
    edges: new Map(),
    adjacency: new Map([[signalNode.id, []]]),
  };

  if (opts.nodes) {
    for (const n of opts.nodes) {
      graph.nodes.set(n.id, { id: n.id, lat: n.lat, lng: n.lng, isIntersection: false });
    }
  }

  if (opts.edges) {
    for (const e of opts.edges) {
      const reverseId = `${e.to}-${e.from}`;
      const edge: RoadEdge = {
        id: e.id,
        from: e.from,
        to: e.to,
        roadType: 'secondary',
        speedLimit: 50,
        lanes: 2,
        length: 200,
        bearing: e.bearing,
        congestionWeight: 0,
        geometry: [],
        oneway: true,
      };
      graph.edges.set(e.id, edge);
      graph.edges.set(reverseId, {
        ...edge,
        id: reverseId,
        from: e.to,
        to: e.from,
        bearing: (e.bearing + 180) % 360,
      });
      const forwardAdj = graph.adjacency.get(e.from) ?? [];
      forwardAdj.push(edge);
      graph.adjacency.set(e.from, forwardAdj);
      const revAdj = graph.adjacency.get(e.to) ?? [];
      revAdj.push(graph.edges.get(reverseId)!);
      graph.adjacency.set(e.to, revAdj);
    }
  }

  const signal = makeSignal({ nodeId: signalNode.id });
  signalNode.trafficSignalId = signal.id;
  return { graph, signal };
}
