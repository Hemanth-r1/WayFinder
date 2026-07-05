import type { RoadNode, RoadEdge, TrafficSignal, RoadGraph, SignalPhase } from './types.js';

const SIGNAL_TIMING = { yellowDuration: 5 };

function bearingFromDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dx = lng2 - lng1;
  const dy = lat2 - lat1;
  return ((Math.atan2(dx, dy) * 180 / Math.PI) % 360 + 360) % 360;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function polylineLength(points: { lat: number; lng: number }[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += haversineMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return len;
}

function rdp(points: { lat: number; lng: number }[], epsilon: number): { lat: number; lng: number }[] {
  if (points.length <= 2) return points;
  let maxDist = 0; let maxIdx = 0;
  const start = points[0]; const end = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDist(points[i], start, end);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, maxIdx + 1), epsilon);
    const right = rdp(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

function perpendicularDist(p: { lat: number; lng: number }, a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dx = b.lng - a.lng; const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt((p.lat - a.lat) ** 2 + (p.lng - a.lng) ** 2);
  const t = Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2));
  return Math.sqrt((p.lng - a.lng - t * dx) ** 2 + (p.lat - a.lat - t * dy) ** 2);
}

function speedForHighway(type: string): number {
  switch (type) {
    case 'motorway': case 'trunk': return 60;
    case 'primary': return 50;
    case 'secondary': return 40;
    case 'tertiary': return 35;
    default: return 30;
  }
}

function lanesForHighway(type: string): number {
  switch (type) {
    case 'motorway': case 'trunk': case 'primary': return 3;
    case 'secondary': return 2;
    default: return 2;
  }
}

function roadTypeFromHighway(type: string): string {
  if (type === 'motorway' || type === 'trunk') return 'motorway';
  if (type === 'primary') return 'primary';
  if (type === 'secondary') return 'secondary';
  if (type === 'tertiary') return 'tertiary';
  return 'residential';
}

function isOneway(tags: Record<string, string>): boolean {
  return tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true';
}

function isReverseOneway(tags: Record<string, string>): boolean {
  return tags.oneway === '-1' || tags.oneway === 'reverse';
}

function deriveApproaches(nodeId: string, adjacency: Map<string, RoadEdge[]>): { edgeId: string; bearing: number; color: string; duration: number }[] {
  const edges = adjacency.get(nodeId) || [];
  const approaches: { edgeId: string; bearing: number; color: string; duration: number }[] = [];
  for (const edge of edges) {
    const approachBearing = (edge.bearing + 180) % 360;
    approaches.push({
      edgeId: edge.id,
      bearing: approachBearing,
      color: 'RED',
      duration: 12,
    });
  }
  const ns = approaches.filter(a => {
    const b = a.bearing;
    return (b >= 315 || b < 45) || (b >= 135 && b < 225);
  });
  const ew = approaches.filter(a => !ns.includes(a));
  for (const a of ns) a.color = 'GREEN';
  for (const a of ew) a.color = 'RED';
  return approaches;
}

function createPhase(_dir: string, greenDur: number): SignalPhase[] {
  return [
    { group: 'NS', color: 'GREEN', duration: greenDur, yellowDuration: SIGNAL_TIMING.yellowDuration },
    { group: 'NS', color: 'YELLOW', duration: SIGNAL_TIMING.yellowDuration, yellowDuration: 0 },
    { group: 'EW', color: 'GREEN', duration: Math.round(greenDur * 0.8), yellowDuration: SIGNAL_TIMING.yellowDuration },
    { group: 'EW', color: 'YELLOW', duration: SIGNAL_TIMING.yellowDuration, yellowDuration: 0 },
  ];
}

// ── OSM types ────────────────────────────────────────────────────────────────

interface OSMNode { id: number; lat: number; lng: number; }
interface OSMWay { id: number; nodes: number[]; tags: Record<string, string>; }
interface OSMResponse { elements: Array<{ type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> }>; }

async function fetchOSMBbox(
  south: number, north: number, west: number, east: number,
  highwayFilter: string,
): Promise<{ nodes: Map<number, OSMNode>; ways: OSMWay[] }> {
  const query = `[out:json][timeout:30];(way["highway"~"${highwayFilter}"](${south},${west},${north},${east}););out body;>;out skel qt;`;
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
  const data: OSMResponse = await resp.json();
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOSMRoads(centerLat: number, centerLng: number, radius: number): Promise<{ nodes: Map<number, OSMNode>; ways: OSMWay[] }> {
  const latDeg = radius / 111320;
  const lngDeg = radius / (111320 * Math.cos(centerLat * Math.PI / 180));
  const gridSize = 2;
  const stepLat = (latDeg * 2) / gridSize;
  const stepLng = (lngDeg * 2) / gridSize;
  const allNodes = new Map<number, OSMNode>();
  const allWays: OSMWay[] = [];
  const seenWayIds = new Set<number>();

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const filter = 'motorway|trunk|primary|secondary|tertiary|residential|unclassified';
      const south = centerLat - latDeg + r * stepLat;
      const north = south + stepLat;
      const west = centerLng - lngDeg + c * stepLng;
      const east = west + stepLng;
      if (r > 0 || c > 0) await sleep(1000);
      try {
        const { nodes, ways } = await fetchOSMBbox(south, north, west, east, filter);
        for (const [id, n] of nodes) allNodes.set(id, n);
        for (const w of ways) { if (!seenWayIds.has(w.id)) { seenWayIds.add(w.id); allWays.push(w); } }
        console.log(`[WayFinder] Tile [${r},${c}]: ${nodes.size} nodes, ${ways.length} ways`);
      } catch (err) {
        console.warn(`[WayFinder] Tile [${r},${c}] failed:`, err);
      }
    }
  }

  console.log(`[WayFinder] OSM grid total: ${allNodes.size} nodes, ${allWays.length} ways`);
  return { nodes: allNodes, ways: allWays };
}

// ── Graph builder ──────────────────────────────────────────────────

const MAX_OSM_SIGNALS = 200;

function buildGraphFromOSM(
  osmNodes: Map<number, OSMNode>,
  osmWays: OSMWay[],
  centerLat: number,
  centerLng: number,
) {
  const graphNodes = new Map<string, RoadNode>();
  const graphEdges = new Map<string, RoadEdge>();
  const adjacency = new Map<string, RoadEdge[]>();
  const signals = new Map<string, TrafficSignal>();
  const nodeIdMap = new Map<number, string>();
  let nodeCounter = 0;

  const nodeWayCount = new Map<number, number>();
  for (const way of osmWays) {
    for (const nid of way.nodes) nodeWayCount.set(nid, (nodeWayCount.get(nid) || 0) + 1);
  }

  for (const [nid, osmNode] of osmNodes) {
    const wayCount = nodeWayCount.get(nid) || 0;
    const dist = Math.sqrt((osmNode.lat - centerLat) ** 2 + (osmNode.lng - centerLng) ** 2);
    if (dist > 0.5) continue;
    if (wayCount >= 2) {
      const graphId = `n${nodeCounter++}`;
      nodeIdMap.set(nid, graphId);
      graphNodes.set(graphId, { id: graphId, lat: osmNode.lat, lng: osmNode.lng });
    }
  }

  const RDP_EPSILON = 0.00005;
  let edgeCount = 0;
  const MAX_EDGES = 200000;

  for (const way of osmWays) {
    if (edgeCount >= MAX_EDGES) break;
    const highway = way.tags?.highway || 'residential';
    const roadType = roadTypeFromHighway(highway);
    if (roadType === 'residential') continue;
    const speed = speedForHighway(highway);
    const lanes = lanesForHighway(highway);
    const name = way.tags?.name || '';
    const oneWay = isOneway(way.tags);
    const reverseOneWay = isReverseOneway(way.tags);

    let segStart: string | null = null;
    let segGeom: { lat: number; lng: number }[] = [];

    for (let i = 0; i < way.nodes.length; i++) {
      const osmNid = way.nodes[i];
      const osmN = osmNodes.get(osmNid);
      if (!osmN) continue;
      const graphId = nodeIdMap.get(osmNid);

      if (graphId) {
        segGeom.push({ lat: osmN.lat, lng: osmN.lng });
        if (segStart && segStart !== graphId && segGeom.length >= 2) {
          const fNode = graphNodes.get(segStart)!;
          const tNode = graphNodes.get(graphId)!;
          const simplified = rdp(segGeom, RDP_EPSILON);
          const dist = polylineLength(simplified);
          if (dist < 1) { segStart = graphId; segGeom = [{ lat: osmN.lat, lng: osmN.lng }]; continue; }
          const bearing = bearingFromDeg(fNode.lat, fNode.lng, tNode.lat, tNode.lng);

          if (!reverseOneWay) {
            const eid = `${segStart}-${graphId}`;
            if (!graphEdges.has(eid) && edgeCount < MAX_EDGES) {
              graphEdges.set(eid, {
                id: eid, from: segStart, to: graphId, roadType, speedLimit: speed, lanes,
                length: dist, bearing, name, geometry: simplified,
              });
              edgeCount++;
              if (!adjacency.has(segStart)) adjacency.set(segStart, []);
              adjacency.get(segStart)!.push(graphEdges.get(eid)!);
            }
          }
          if (!oneWay) {
            const eid = `${graphId}-${segStart}`;
            if (!graphEdges.has(eid) && edgeCount < MAX_EDGES) {
              graphEdges.set(eid, {
                id: eid, from: graphId, to: segStart, roadType, speedLimit: speed, lanes,
                length: dist, bearing: (bearing + 180) % 360, name,
                geometry: [...simplified].reverse(),
              });
              edgeCount++;
              if (!adjacency.has(graphId)) adjacency.set(graphId, []);
              adjacency.get(graphId)!.push(graphEdges.get(eid)!);
            }
          }
        }
        segStart = graphId;
        segGeom = [{ lat: osmN.lat, lng: osmN.lng }];
      } else {
        segGeom.push({ lat: osmN.lat, lng: osmN.lng });
      }
    }
  }

  let sigCount = 0;
  for (const [graphId, node] of graphNodes) {
    if (sigCount >= MAX_OSM_SIGNALS) break;
    const adj = adjacency.get(graphId) || [];
    if (adj.length >= 3) {
      const hasMajor = adj.some(e =>
        e.roadType === 'motorway' || e.roadType === 'trunk' ||
        e.roadType === 'primary' || e.roadType === 'secondary'
      );
      if (!hasMajor) continue;
      sigCount++;
      const gd = 12 + Math.floor(Math.random() * 6);
      const approaches = deriveApproaches(graphId, adjacency);
      signals.set(graphId, {
        id: `SIG-${String(sigCount).padStart(3, '0')}`,
        nodeId: graphId,
        phases: createPhase('N', gd),
        currentPhaseIndex: 0, timer: 0,
        cycleLength: gd * 2 + 10,
        offset: Math.floor(Math.random() * 20),
        greenWaveDirection: null, congestionLevel: 0, adaptiveTiming: true,
        approaches,
      });
      node.trafficSignalId = `SIG-${String(sigCount).padStart(3, '0')}`;
    }
  }

  return { nodes: graphNodes, edges: graphEdges, adjacency, signals };
}

// ── Synthetic grid fallback ─────────────────────────────────────────────

function buildSyntheticGrid(centerLat: number, centerLng: number): { graph: RoadGraph; signals: TrafficSignal[]; source: string } {
  const nodes = new Map<string, RoadNode>();
  const edges = new Map<string, RoadEdge>();
  const adjacency = new Map<string, RoadEdge[]>();
  const signals = new Map<string, TrafficSignal>();
  const rows = 8;
  const cols = 8;
  const avenues = ['MG Road', 'Brigade Rd', 'Residency Rd', 'Commercial St', 'Church St', 'Kasturba Rd', 'Infantry Rd', 'St Marks Rd', 'Lavelle Rd', 'Richmond Rd'];
  const streets = ['Vittal Mallya Rd', 'Rest House Rd', 'High Ground', 'Agram Rd', 'Waltaire Rd', 'Richmond Rd', 'Lavelle Rd', 'Cunningham Rd', 'Dickenson Rd', 'Museum Rd'];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `${c},${r}`;
      nodes.set(id, {
        id,
        lat: centerLat + (r - rows / 2) * 0.0014 * (1 + (Math.random() - 0.5) * 0.08),
        lng: centerLng + (c - cols / 2) * 0.0018 * (1 + (Math.random() - 0.5) * 0.08),
      });
    }
  }

  const addEdge = (from: string, to: string, rt: string, sp: number, name: string) => {
    const f = nodes.get(from)!; const t = nodes.get(to)!;
    const geom: { lat: number; lng: number }[] = [{ lat: f.lat, lng: f.lng }, { lat: t.lat, lng: t.lng }];
    const dist = polylineLength(geom);
    if (dist < 1) return;
    const bearing = bearingFromDeg(f.lat, f.lng, t.lat, t.lng);
    const e1: RoadEdge = { id: `${from}-${to}`, from, to, roadType: rt, speedLimit: sp, lanes: 2, length: dist, bearing, name, geometry: geom };
    const e2: RoadEdge = { id: `${to}-${from}`, from: to, to: from, roadType: rt, speedLimit: sp, lanes: 2, length: dist, bearing: (bearing + 180) % 360, name, geometry: [...geom].reverse() };
    edges.set(e1.id, e1); edges.set(e2.id, e2);
    if (!adjacency.has(from)) adjacency.set(from, []);
    if (!adjacency.has(to)) adjacency.set(to, []);
    adjacency.get(from)!.push(e1);
    adjacency.get(to)!.push(e2);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const fid = `${c},${r}`;
      if (c < cols - 1) {
        const isMain = r === 3 || r === 5 || r === 7;
        addEdge(fid, `${c + 1},${r}`, isMain ? 'primary' : 'tertiary', isMain ? 50 : 30, avenues[c % avenues.length]);
      }
      if (r < rows - 1) {
        const isMain = c === 3 || c === 5 || c === 7;
        addEdge(fid, `${c},${r + 1}`, isMain ? 'primary' : 'residential', isMain ? 45 : 25, streets[c % streets.length]);
      }
    }
  }

  let sc = 0;
  for (const [id, node] of nodes) {
    const adj = adjacency.get(id) || [];
    if (adj.length >= 3) {
      sc++;
      const gd = 12 + Math.floor(Math.random() * 6);
      const approaches = deriveApproaches(id, adjacency);
      signals.set(id, {
        id: `SIG-${String(sc).padStart(3, '0')}`, nodeId: id,
        phases: createPhase('N', gd), currentPhaseIndex: 0, timer: 0,
        cycleLength: gd * 2 + 10, offset: Math.floor(Math.random() * 20),
        greenWaveDirection: null, congestionLevel: 0, adaptiveTiming: true,
        approaches,
      });
      node.trafficSignalId = `SIG-${String(sc).padStart(3, '0')}`;
    }
  }
  console.log(`[WayFinder] Fallback: ${nodes.size} nodes, ${edges.size} edges, ${signals.size} signals`);

  const serialized = toSerializable({ nodes, edges, adjacency, signals });
  return { ...serialized, source: 'synthetic grid' };
}

// ── Serialization ─────────────────────────────────────────────────────────────

function toSerializable(result: {
  nodes: Map<string, RoadNode>;
  edges: Map<string, RoadEdge>;
  adjacency: Map<string, RoadEdge[]>;
  signals: Map<string, TrafficSignal>;
}): { graph: RoadGraph; signals: TrafficSignal[] } {
  const adjArray: [string, string[]][] = [];
  for (const [nodeId, edgeList] of result.adjacency) {
    adjArray.push([nodeId, edgeList.map(e => e.id)]);
  }
  return {
    graph: {
      nodes: Array.from(result.nodes.values()),
      edges: Array.from(result.edges.values()),
      adjacency: adjArray,
    },
    signals: Array.from(result.signals.values()),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function fetchFromOverpass(
  centerLat: number, centerLng: number, radiusM: number
): Promise<{ graph: RoadGraph; signals: TrafficSignal[]; source: string }> {
  console.log('[WayFinder] Fetching OSM data from Overpass API…');
  const osmResult = await fetchOSMRoads(centerLat, centerLng, radiusM);
  if (!osmResult || osmResult.ways.length < 5) {
    throw new Error('Too few ways from Overpass');
  }
  console.log(`[WayFinder] OSM: ${osmResult.nodes.size} nodes, ${osmResult.ways.length} ways`);
  const result = buildGraphFromOSM(osmResult.nodes, osmResult.ways, centerLat, centerLng);
  console.log(`[WayFinder] Graph: ${result.nodes.size}n, ${result.edges.size}e, ${result.signals.size}s`);
  const serialized = toSerializable(result);
  return { ...serialized, source: 'Overpass API' };
}

export async function buildBangaloreNetwork(
  centerLat: number, centerLng: number, radiusM: number
): Promise<{
  graph: RoadGraph; signals: TrafficSignal[]; source: string;
}> {
  try {
    return await fetchFromOverpass(centerLat, centerLng, radiusM);
  } catch {
    console.log('[WayFinder] Overpass fetch failed, using synthetic grid fallback');
  }
  return buildSyntheticGrid(centerLat, centerLng);
}
