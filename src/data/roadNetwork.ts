/**
 * roadNetwork.ts
 * Fetches real Bangalore roads from OSM Overpass API.
 * REQ-G1: Full geometry preserved on every RoadEdge.
 * REQ-G4: One-way streets respected.
 * REQ-G1/PERF1: Intermediate geometry simplified with Ramer-Douglas-Peucker (ε=5m).
 * REQ-G5: Graph cached in localStorage via graphCache.ts.
 */
import type { RoadNode, RoadEdge, TrafficSignal, SignalPhase, Direction, RoadType, GeoPoint, SignalApproach } from '../types';
import { saveGraphToCache, loadGraphFromCache } from './graphCache';
import { ROAD_CONFIG } from '../config';

// ── Geometry helpers ──────────────────────────────────────────────────────────

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

function polylineLength(points: GeoPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += haversineMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return len;
}

/** Ramer-Douglas-Peucker simplification (ε in degrees ~5m at Bangalore) */
function rdp(points: GeoPoint[], epsilon: number): GeoPoint[] {
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

function perpendicularDist(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const dx = b.lng - a.lng; const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt((p.lat - a.lat) ** 2 + (p.lng - a.lng) ** 2);
  const t = Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2));
  return Math.sqrt((p.lng - a.lng - t * dx) ** 2 + (p.lat - a.lat - t * dy) ** 2);
}

// ── Road type helpers ─────────────────────────────────────────────────────────

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

function roadTypeFromHighway(type: string): RoadType {
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

// ── Signal phase derivation (REQ-S1) ─────────────────────────────────────────

function deriveApproaches(nodeId: string, adjacency: Map<string, RoadEdge[]>): SignalApproach[] {
  const edges = adjacency.get(nodeId) || [];
  // Edges arriving at this node are those where to === nodeId; we look at the reverse direction
  // We want approach bearings = bearing from upstream node toward this node
  // = (forward edge bearing + 180) % 360 for each outgoing edge from this node
  const approaches: SignalApproach[] = [];
  for (const edge of edges) {
    // This is an outgoing edge from nodeId, so the vehicle approaches FROM bearing opposite
    const approachBearing = (edge.bearing + 180) % 360;
    approaches.push({
      edgeId: edge.id,
      bearing: approachBearing,
      color: 'RED',
      duration: 12,
    });
  }
  // Group into NS vs EW halves and set alternating GREEN/RED
  const ns = approaches.filter(a => {
    const b = a.bearing;
    return (b >= 315 || b < 45) || (b >= 135 && b < 225);
  });
  const ew = approaches.filter(a => !ns.includes(a));
  for (const a of ns) { a.color = 'GREEN'; }
  for (const a of ew) { a.color = 'RED'; }
  return approaches;
}

function createPhase(dir: Direction, greenDur: number): SignalPhase[] {
  const isNS = dir === 'N' || dir === 'S';
  return [
    { direction: 'N', color: isNS ? 'GREEN' : 'RED', duration: isNS ? greenDur : 2, yellowDuration: 3 },
    { direction: 'S', color: isNS ? 'GREEN' : 'RED', duration: isNS ? greenDur : 2, yellowDuration: 3 },
    { direction: 'E', color: isNS ? 'RED' : 'GREEN', duration: isNS ? 2 : Math.round(greenDur * 0.8), yellowDuration: 3 },
    { direction: 'W', color: isNS ? 'RED' : 'GREEN', duration: isNS ? 2 : Math.round(greenDur * 0.8), yellowDuration: 3 },
  ];
}

// ── OSM types ────────────────────────────────────────────────────────────────

interface OSMNode { id: number; lat: number; lng: number; }
interface OSMWay { id: number; nodes: number[]; tags: Record<string, string>; }
interface OSMResponse { elements: Array<{ type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> }>; }

async function fetchOSMChunk(centerLat: number, centerLng: number, radius: number, highwayFilter: string): Promise<{ nodes: Map<number, OSMNode>; ways: OSMWay[] }> {
  const query = `[out:json][timeout:60];(way["highway"~"${highwayFilter}"](around:${radius},${centerLat},${centerLng}););out body;>;out skel qt;`;
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

async function fetchOSMRoads(centerLat: number, centerLng: number, radius: number): Promise<{ nodes: Map<number, OSMNode>; ways: OSMWay[] }> {
  const allNodes = new Map<number, OSMNode>();
  const allWays: OSMWay[] = [];
  const seenWayIds = new Set<number>();
  const filter = radius > 10000
    ? 'motorway|trunk|primary|secondary'
    : 'motorway|trunk|primary|secondary|tertiary|residential|unclassified';

  if (radius > 10000) {
    const halfR = radius * 0.7;
    const dlat = halfR / 111320;
    const dlng = halfR / (111320 * Math.cos(centerLat * Math.PI / 180));
    const offsets = [[dlat, dlng], [dlat, -dlng], [-dlat, dlng], [-dlat, -dlng]];
    for (const [odlat, odlng] of offsets) {
      const { nodes, ways } = await fetchOSMChunk(centerLat + odlat, centerLng + odlng, halfR, filter);
      for (const [id, n] of nodes) allNodes.set(id, n);
      for (const w of ways) { if (!seenWayIds.has(w.id)) { seenWayIds.add(w.id); allWays.push(w); } }
    }
  } else {
    const { nodes, ways } = await fetchOSMChunk(centerLat, centerLng, radius, filter);
    for (const [id, n] of nodes) allNodes.set(id, n);
    for (const w of ways) allWays.push(w);
  }
  return { nodes: allNodes, ways: allWays };
}

// ── Graph builder — REQ-G1, REQ-G2, REQ-G4 ──────────────────────────────────

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

  // Identify intersection/endpoint OSM nodes
  const nodeWayCount = new Map<number, number>();
  for (const way of osmWays) {
    for (const nid of way.nodes) nodeWayCount.set(nid, (nodeWayCount.get(nid) || 0) + 1);
  }

  for (const [nid, osmNode] of osmNodes) {
    const wayCount = nodeWayCount.get(nid) || 0;
    const dist = Math.sqrt((osmNode.lat - centerLat) ** 2 + (osmNode.lng - centerLng) ** 2);
    if (dist > 0.5) continue;
    // Graph node only for intersections or endpoints — intermediate nodes kept as geometry
    if (wayCount >= 2 || wayCount === 1) {
      const graphId = `n${nodeCounter++}`;
      nodeIdMap.set(nid, graphId);
      graphNodes.set(graphId, { id: graphId, lat: osmNode.lat, lng: osmNode.lng, isIntersection: wayCount >= 2 });
    }
  }

  const RDP_EPSILON = 0.00005; // ~5m in degrees

  for (const way of osmWays) {
    const highway = way.tags?.highway || 'residential';
    const roadType = roadTypeFromHighway(highway);
    const speed = speedForHighway(highway);
    const lanes = lanesForHighway(highway);
    const name = way.tags?.name || '';
    const oneWay = isOneway(way.tags);
    const reverseOneWay = isReverseOneway(way.tags);

    // Collect consecutive graph-node pairs; gather ALL OSM nodes between them as geometry
    let segStart: string | null = null;
    let segGeom: GeoPoint[] = [];

    for (let i = 0; i < way.nodes.length; i++) {
      const osmNid = way.nodes[i];
      const osmN = osmNodes.get(osmNid);
      if (!osmN) continue;

      const graphId = nodeIdMap.get(osmNid);

      if (graphId) {
        // This is a graph node (intersection or endpoint)
        segGeom.push({ lat: osmN.lat, lng: osmN.lng });

        if (segStart && segStart !== graphId && segGeom.length >= 2) {
          const fNode = graphNodes.get(segStart)!;
          const tNode = graphNodes.get(graphId)!;
          // Simplify intermediate geometry
          const simplified = rdp(segGeom, RDP_EPSILON);
          const dist = polylineLength(simplified);
          if (dist < 1) { segStart = graphId; segGeom = [{ lat: osmN.lat, lng: osmN.lng }]; continue; }
          const bearing = bearingFromDeg(fNode.lat, fNode.lng, tNode.lat, tNode.lng);

          const addEdge = (eid: string, from: string, to: string, geom: GeoPoint[], bear: number) => {
            if (graphEdges.has(eid)) return;
            const edge: RoadEdge = {
              id: eid, from, to, roadType, speedLimit: speed, lanes, length: dist,
              bearing: bear, name, congestionWeight: 1,
              geometry: geom,
              oneway: oneWay || reverseOneWay,
            };
            graphEdges.set(eid, edge);
            if (!adjacency.has(from)) adjacency.set(from, []);
            adjacency.get(from)!.push(edge);
          };

          if (!reverseOneWay) {
            addEdge(`${segStart}-${graphId}`, segStart, graphId, simplified, bearing);
          }
          if (!oneWay) {
            addEdge(
              `${graphId}-${segStart}`, graphId, segStart,
              [...simplified].reverse(),
              (bearing + 180) % 360,
            );
          }
        }
        segStart = graphId;
        segGeom = [{ lat: osmN.lat, lng: osmN.lng }];
      } else {
        // Intermediate geometry node — add to current segment geometry
        segGeom.push({ lat: osmN.lat, lng: osmN.lng });
      }
    }
  }

  // Place signals at intersections with ≥3 connections (REQ-S1)
  let sigCount = 0;
  for (const [graphId, node] of graphNodes) {
    const adj = adjacency.get(graphId) || [];
    if (adj.length >= 3) {
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

// ── Public API ────────────────────────────────────────────────────────────────

const CENTER = { lat: 12.9716, lng: 77.5946 };
const RADIUS = 40000;

export async function loadBangaloreNetwork(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = loadGraphFromCache(CENTER.lat, CENTER.lng, RADIUS);
    if (cached) return cached;
  }

  try {
    console.log('[WayFinder] Fetching OSM data for Bangalore (40km)…');
    const { nodes, ways } = await fetchOSMRoads(CENTER.lat, CENTER.lng, RADIUS);
    if (ways.length < 5) {
      console.warn('[WayFinder] Too few ways from OSM, using fallback');
      return loadFallback();
    }
    console.log(`[WayFinder] OSM: ${nodes.size} raw nodes, ${ways.length} ways`);
    const result = buildGraphFromOSM(nodes, ways, CENTER.lat, CENTER.lng);
    console.log(`[WayFinder] Graph: ${result.nodes.size} nodes, ${result.edges.size} edges, ${result.signals.size} signals`);
    saveGraphToCache(CENTER.lat, CENTER.lng, RADIUS, { nodes: result.nodes, edges: result.edges, adjacency: result.adjacency }, result.signals);
    return result;
  } catch (err) {
    console.error('[WayFinder] OSM fetch failed:', err);
    const cached = loadGraphFromCache(CENTER.lat, CENTER.lng, RADIUS);
    if (cached) { console.warn('[WayFinder] Using stale cache after fetch failure'); return cached; }
    return loadFallback();
  }
}

// ── Fallback grid ─────────────────────────────────────────────────────────────

function loadFallback() {
  const nodes = new Map<string, RoadNode>();
  const edges = new Map<string, RoadEdge>();
  const adjacency = new Map<string, RoadEdge[]>();
  const signals = new Map<string, TrafficSignal>();
  const BASE = { lat: 12.9716, lng: 77.5946 };
  const { rows, cols } = ROAD_CONFIG.FALLBACK_GRID_SIZE;
  const avenues = ['MG Road', 'Brigade Rd', 'Residency Rd', 'Commercial St', 'Church St', 'Kasturba Rd', 'Infantry Rd', 'St Marks Rd', 'Lavelle Rd', 'Richmond Rd'];
  const streets = ['Vittal Mallya Rd', 'Rest House Rd', 'High Ground', 'Agram Rd', 'Waltaire Rd', 'Richmond Rd', 'Lavelle Rd', 'Cunningham Rd', 'Dickenson Rd', 'Museum Rd'];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `${c},${r}`;
      nodes.set(id, {
        id, isIntersection: true,
        lat: BASE.lat + (r - rows / 2) * 0.0014 * (1 + (Math.random() - 0.5) * 0.08),
        lng: BASE.lng + (c - cols / 2) * 0.0018 * (1 + (Math.random() - 0.5) * 0.08),
      });
    }
  }

  const addEdge = (from: string, to: string, rt: RoadType, sp: number, name: string) => {
    const f = nodes.get(from)!; const t = nodes.get(to)!;
    const geom: GeoPoint[] = [{ lat: f.lat, lng: f.lng }, { lat: t.lat, lng: t.lng }];
    const dist = polylineLength(geom);
    if (dist < 1) return;
    const bearing = bearingFromDeg(f.lat, f.lng, t.lat, t.lng);
    const e1: RoadEdge = { id: `${from}-${to}`, from, to, roadType: rt, speedLimit: sp, lanes: 2, length: dist, bearing, name, congestionWeight: 1, geometry: geom, oneway: false };
    const e2: RoadEdge = { id: `${to}-${from}`, from: to, to: from, roadType: rt, speedLimit: sp, lanes: 2, length: dist, bearing: (bearing + 180) % 360, name, congestionWeight: 1, geometry: [...geom].reverse(), oneway: false };
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
  return { nodes, edges, adjacency, signals };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function findNearestNode(nodes: Map<string, RoadNode>, lat: number, lng: number): RoadNode | null {
  let best: RoadNode | null = null; let bestDist = Infinity;
  for (const [, node] of nodes) {
    const d = (node.lat - lat) ** 2 + (node.lng - lng) ** 2;
    if (d < bestDist) { bestDist = d; best = node; }
  }
  return best;
}

/** Returns nodes on the periphery of the network — valid spawn/despawn points */
export function getEdgeNodes(adjacency: Map<string, RoadEdge[]>): string[] {
  const result: string[] = [];
  for (const [id, edges] of adjacency) {
    if (edges.length >= 1 && edges.length <= 2) result.push(id);
  }
  return result;
}
