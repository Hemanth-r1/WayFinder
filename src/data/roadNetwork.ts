import type { RoadNode, RoadEdge, TrafficSignal, SignalPhase, Direction, RoadType } from '../types';

const bearingFromDxDy = (dx: number, dy: number): number => {
  const angle = Math.atan2(dx, dy) * 180 / Math.PI;
  return ((angle % 360) + 360) % 360;
};

function createPhase(dir: Direction, greenDur: number): SignalPhase[] {
  const isNS = dir === 'N' || dir === 'S';
  return [
    { direction: 'N', color: isNS ? 'GREEN' : 'RED', duration: isNS ? greenDur : 2, yellowDuration: 3 },
    { direction: 'S', color: isNS ? 'GREEN' : 'RED', duration: isNS ? greenDur : 2, yellowDuration: 3 },
    { direction: 'E', color: isNS ? 'RED' : 'GREEN', duration: isNS ? 2 : Math.round(greenDur * 0.8), yellowDuration: 3 },
    { direction: 'W', color: isNS ? 'RED' : 'GREEN', duration: isNS ? 2 : Math.round(greenDur * 0.8), yellowDuration: 3 },
  ];
}

function speedForHighway(type: string): number {
  switch (type) {
    case 'motorway': case 'trunk': return 60;
    case 'primary': return 50;
    case 'secondary': return 40;
    case 'tertiary': return 35;
    case 'residential': case 'unclassified': return 25;
    default: return 30;
  }
}

function lanesForHighway(type: string): number {
  switch (type) {
    case 'motorway': case 'trunk': return 3;
    case 'primary': return 3;
    case 'secondary': return 2;
    default: return 2;
  }
}

function roadTypeFromHighway(type: string): RoadType {
  if (type === 'motorway' || type === 'trunk') return 'motorway';
  if (type === 'primary') return 'primary';
  if (type === 'secondary') return 'secondary';
  if (type === 'tertiary') return 'tertiary';
  return 'residential';
}

interface OSMNode {
  id: number;
  lat: number;
  lng: number;
}

interface OSMWay {
  id: number;
  nodes: number[];
  tags: Record<string, string>;
}

interface OSMResponse {
  elements: Array<{ type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> }>;
}

async function fetchOSMRoads(centerLat: number, centerLng: number, radiusMeters: number): Promise<{ nodes: Map<number, OSMNode>; ways: OSMWay[] }> {
  const query = `
    [out:json][timeout:30];
    (
      way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified"](around:${radiusMeters},${centerLat},${centerLng});
    );
    out body;
    >;
    out skel qt;
  `;

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!response.ok) throw new Error(`Overpass API error: ${response.status}`);
  const data: OSMResponse = await response.json();

  const nodes = new Map<number, OSMNode>();
  const ways: OSMWay[] = [];

  for (const el of data.elements) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      nodes.set(el.id, { id: el.id, lat: el.lat, lng: el.lon });
    }
    if (el.type === 'way' && el.nodes && el.tags) {
      ways.push({ id: el.id, nodes: el.nodes, tags: el.tags });
    }
  }

  return { nodes, ways };
}

function buildGraphFromOSM(
  osmNodes: Map<number, OSMNode>,
  osmWays: OSMWay[],
  centerLat: number,
  centerLng: number,
): { nodes: Map<string, RoadNode>; edges: Map<string, RoadEdge>; adjacency: Map<string, RoadEdge[]>; signals: Map<string, TrafficSignal> } {
  const graphNodes = new Map<string, RoadNode>();
  const graphEdges = new Map<string, RoadEdge>();
  const adjacency = new Map<string, RoadEdge[]>();
  const signals = new Map<string, TrafficSignal>();

  const nodeIdMap = new Map<number, string>();
  let nodeCounter = 0;

  // Build intersection detection: count how many ways pass through each OSM node
  const nodeWayCount = new Map<number, number>();
  const nodeWays = new Map<number, OSMWay[]>();
  for (const way of osmWays) {
    for (const nid of way.nodes) {
      nodeWayCount.set(nid, (nodeWayCount.get(nid) || 0) + 1);
      if (!nodeWays.has(nid)) nodeWays.set(nid, []);
      nodeWays.get(nid)!.push(way);
    }
  }

  // Create graph nodes at intersections and endpoints
  for (const [nid, osmNode] of osmNodes) {
    const wayCount = nodeWayCount.get(nid) || 0;
    const isIntersection = wayCount >= 2;
    const distFromCenter = Math.sqrt(
      Math.pow(osmNode.lat - centerLat, 2) + Math.pow(osmNode.lng - centerLng, 2)
    );

    // Only include nodes within reasonable distance
    if (distFromCenter > 0.02) continue;

    // Include intersections and endpoints (nodes with 1 way = dead end)
    if (isIntersection || wayCount === 1) {
      const graphId = `n${nodeCounter++}`;
      nodeIdMap.set(nid, graphId);
      graphNodes.set(graphId, {
        id: graphId,
        lat: osmNode.lat,
        lng: osmNode.lng,
        isIntersection,
      });
    }
  }

  // Create edges from ways
  for (const way of osmWays) {
    const highway = way.tags?.highway || 'residential';
    const roadType = roadTypeFromHighway(highway);
    const speed = speedForHighway(highway);
    const lanes = lanesForHighway(highway);
    const name = way.tags?.name || '';

    let prevGraphId: string | null = null;

    for (const osmNid of way.nodes) {
      const graphId = nodeIdMap.get(osmNid);
      if (!graphId) {
        // This node wasn't included - skip but carry forward from last valid
        continue;
      }

      if (prevGraphId && prevGraphId !== graphId) {
        const fromNode = graphNodes.get(prevGraphId)!;
        const toNode = graphNodes.get(graphId)!;
        const dx = toNode.lng - fromNode.lng;
        const dy = toNode.lat - fromNode.lat;
        const dist = Math.sqrt(dx * dx + dy * dy) * 111320;
        const bearing = bearingFromDxDy(dx, dy);

        if (dist > 1) { // minimum 1 meter
          const edgeId = `${prevGraphId}-${graphId}`;
          const reverseEdgeId = `${graphId}-${prevGraphId}`;

          if (!graphEdges.has(edgeId)) {
            graphEdges.set(edgeId, {
              id: edgeId, from: prevGraphId, to: graphId,
              roadType, speedLimit: speed, lanes, length: dist,
              bearing, name, congestionWeight: 1,
            });
            if (!adjacency.has(prevGraphId)) adjacency.set(prevGraphId, []);
            adjacency.get(prevGraphId)!.push(graphEdges.get(edgeId)!);
          }

          if (!graphEdges.has(reverseEdgeId)) {
            graphEdges.set(reverseEdgeId, {
              id: reverseEdgeId, from: graphId, to: prevGraphId,
              roadType, speedLimit: speed, lanes, length: dist,
              bearing: (bearing + 180) % 360, name, congestionWeight: 1,
            });
            if (!adjacency.has(graphId)) adjacency.set(graphId, []);
            adjacency.get(graphId)!.push(graphEdges.get(reverseEdgeId)!);
          }
        }
      }

      prevGraphId = graphId;
    }
  }

  // Place signals at major intersections (where 3+ ways meet, or primary/secondary cross)
  let sigCounter = 0;
  for (const [graphId, node] of graphNodes) {
    if (!node.isIntersection) continue;
    const adj = adjacency.get(graphId) || [];
    if (adj.length < 3) continue;

    // Check if any connected road is a major type
    const hasMajorRoad = adj.some(e => {
      const edge = graphEdges.get(e.id);
      return edge && (edge.roadType === 'primary' || edge.roadType === 'secondary' || edge.roadType === 'motorway');
    });

    if (hasMajorRoad || adj.length >= 4) {
      sigCounter++;
      const greenDur = 12 + Math.floor(Math.random() * 6);
      signals.set(graphId, {
        id: `SIG-${String(sigCounter).padStart(3, '0')}`,
        nodeId: graphId,
        phases: createPhase('N', greenDur),
        currentPhaseIndex: 0,
        timer: 0,
        cycleLength: greenDur * 2 + 10,
        offset: Math.floor(Math.random() * 20),
        greenWaveDirection: null,
        congestionLevel: 0,
        adaptiveTiming: true,
      });
      node.trafficSignalId = `SIG-${String(sigCounter).padStart(3, '0')}`;
    }
  }

  return { nodes: graphNodes, edges: graphEdges, adjacency, signals };
}

export async function loadBangaloreNetwork(): Promise<{
  nodes: Map<string, RoadNode>;
  edges: Map<string, RoadEdge>;
  adjacency: Map<string, RoadEdge[]>;
  signals: Map<string, TrafficSignal>;
}> {
  const BANGALORE_CENTER = { lat: 12.9716, lng: 77.5946 };
  const RADIUS = 2000; // 2km radius

  try {
    const { nodes: osmNodes, ways: osmWays } = await fetchOSMRoads(
      BANGALORE_CENTER.lat, BANGALORE_CENTER.lng, RADIUS,
    );

    if (osmWays.length === 0) {
      console.warn('No OSM data returned, falling back to synthetic network');
      return loadFallbackNetwork();
    }

    console.log(`Loaded ${osmNodes.size} nodes, ${osmWays.length} ways from OSM`);
    return buildGraphFromOSM(osmNodes, osmWays, BANGALORE_CENTER.lat, BANGALORE_CENTER.lng);
  } catch (err) {
    console.error('Failed to fetch OSM data:', err);
    return loadFallbackNetwork();
  }
}

function loadFallbackNetwork() {
  const nodes = new Map<string, RoadNode>();
  const edges = new Map<string, RoadEdge>();
  const adjacency = new Map<string, RoadEdge[]>();
  const signals = new Map<string, TrafficSignal>();

  const BASE = { lat: 12.9716, lng: 77.5946 };
  const rows = 10;
  const cols = 10;
  const latStep = 0.0012;
  const lngStep = 0.0015;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.set(`${c},${r}`, {
        id: `${c},${r}`,
        lat: BASE.lat + (r - rows / 2) * latStep,
        lng: BASE.lng + (c - cols / 2) * lngStep,
        isIntersection: true,
      });
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const fromId = `${c},${r}`;
      if (c < cols - 1) {
        const toId = `${c + 1},${r}`;
        const f = nodes.get(fromId)!;
        const t = nodes.get(toId)!;
        const dx = t.lng - f.lng;
        const dy = t.lat - f.lat;
        const dist = Math.sqrt(dx * dx + dy * dy) * 111320;
        const bearing = bearingFromDxDy(dx, dy);
        const eid1 = `${fromId}-${toId}`;
        const eid2 = `${toId}-${fromId}`;
        edges.set(eid1, { id: eid1, from: fromId, to: toId, roadType: 'primary', speedLimit: 50, lanes: 3, length: dist, bearing, name: 'MG Road', congestionWeight: 1 });
        edges.set(eid2, { id: eid2, from: toId, to: fromId, roadType: 'primary', speedLimit: 50, lanes: 3, length: dist, bearing: (bearing + 180) % 360, name: 'MG Road', congestionWeight: 1 });
        if (!adjacency.has(fromId)) adjacency.set(fromId, []);
        if (!adjacency.has(toId)) adjacency.set(toId, []);
        adjacency.get(fromId)!.push(edges.get(eid1)!);
        adjacency.get(toId)!.push(edges.get(eid2)!);
      }
      if (r < rows - 1) {
        const toId = `${c},${r + 1}`;
        const f = nodes.get(fromId)!;
        const t = nodes.get(toId)!;
        const dx = t.lng - f.lng;
        const dy = t.lat - f.lat;
        const dist = Math.sqrt(dx * dx + dy * dy) * 111320;
        const bearing = bearingFromDxDy(dx, dy);
        const eid1 = `${fromId}-${toId}`;
        const eid2 = `${toId}-${fromId}`;
        edges.set(eid1, { id: eid1, from: fromId, to: toId, roadType: 'secondary', speedLimit: 40, lanes: 2, length: dist, bearing, name: 'Brigade Road', congestionWeight: 1 });
        edges.set(eid2, { id: eid2, from: toId, to: fromId, roadType: 'secondary', speedLimit: 40, lanes: 2, length: dist, bearing: (bearing + 180) % 360, name: 'Brigade Road', congestionWeight: 1 });
        if (!adjacency.has(fromId)) adjacency.set(fromId, []);
        if (!adjacency.has(toId)) adjacency.set(toId, []);
        adjacency.get(fromId)!.push(edges.get(eid1)!);
        adjacency.get(toId)!.push(edges.get(eid2)!);
      }
    }
  }

  let sigCount = 0;
  for (const [id, node] of nodes) {
    const adj = adjacency.get(id) || [];
    if (adj.length >= 4) {
      sigCount++;
      const gd = 12 + Math.floor(Math.random() * 6);
      signals.set(id, {
        id: `SIG-${String(sigCount).padStart(3, '0')}`,
        nodeId: id,
        phases: createPhase('N', gd),
        currentPhaseIndex: 0, timer: 0,
        cycleLength: gd * 2 + 10, offset: Math.floor(Math.random() * 20),
        greenWaveDirection: null, congestionLevel: 0, adaptiveTiming: true,
      });
      node.trafficSignalId = `SIG-${String(sigCount).padStart(3, '0')}`;
    }
  }

  return { nodes, edges, adjacency, signals };
}

export function findNearestNode(nodes: Map<string, RoadNode>, lat: number, lng: number): RoadNode | null {
  let best: RoadNode | null = null;
  let bestDist = Infinity;
  for (const [, node] of nodes) {
    const d = Math.sqrt(Math.pow(node.lat - lat, 2) + Math.pow(node.lng - lng, 2));
    if (d < bestDist) { bestDist = d; best = node; }
  }
  return best;
}
