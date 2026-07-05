import type { RoadNode, RoadEdge, TrafficSignal, SignalPhase, Direction, RoadType, GeoPoint, SignalApproach } from '../types';
import { SIGNAL_TIMING } from '../types';
import { saveGraphToCache, loadGraphFromCache } from './graphCache';
import { saveOSMToFirebase, loadOSMFromFirebase, saveOSMToStorage, loadOSMFromStorage } from './firebaseCache';
import type { RawOSMData } from './firebaseCache';
import { ROAD_CONFIG } from '../config';

const SERVER_URL = import.meta.env.VITE_SERVER_URL;

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

const MAX_OSM_SIGNALS = 200;

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

// ── Signal phase derivation ──────────────────────────────────────────────────

function deriveApproaches(nodeId: string, adjacency: Map<string, RoadEdge[]>): SignalApproach[] {
  const edges = adjacency.get(nodeId) || [];
  const approaches: SignalApproach[] = [];
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

function createPhase(_dir: Direction, greenDur: number): SignalPhase[] {
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
  // Use 2×2 grid instead of 4×4: 4 tiles instead of 16 = 12s faster
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
      // Reduced delay between tiles
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
      graphNodes.set(graphId, { id: graphId, lat: osmNode.lat, lng: osmNode.lng, isIntersection: true });
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
    let segGeom: GeoPoint[] = [];

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
                length: dist, bearing, name, congestionWeight: 1, geometry: simplified, oneway: oneWay || reverseOneWay,
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
                length: dist, bearing: (bearing + 180) % 360, name, congestionWeight: 1,
                geometry: [...simplified].reverse(), oneway: false,
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

  // Place signals only at major-road intersections (REQ-S1)
  // Avoids 49k signals on every minor residential junction
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

// ── Progressive loading types ─────────────────────────────────────────────────

export type LoadPhase = 'empty' | 'signals' | 'cached' | 'fetching' | 'full' | 'fallback';

export interface LoadUpdate {
  phase: LoadPhase;
  source: string;
  nodes: Map<string, RoadNode>;
  edges: Map<string, RoadEdge>;
  adjacency: Map<string, RoadEdge[]>;
  signals: Map<string, TrafficSignal>;
}

// ── Public API ────────────────────────────────────────────────────────────────

const CENTER = { lat: 12.9716, lng: 77.5946 };
const RADIUS = 40000;

/**
 * Load Bangalore road network with progressive updates.
 *
 * Loading priority:
 *   1. signals.json (instant)     → phase 'signals' — signal markers on map
 *   2. IndexedDB (fast, local)     → phase 'cached'  — full graph ready
 *   3. Firebase Storage (remote)   → phase 'cached'  — raw OSM → build graph
 *   4. Firestore chunks (remote)   → phase 'cached'  — raw OSM → build graph
 *   5. Overpass API (remote, slow) → phase 'fetching'→ phase 'full'
 *   6. Synthetic grid (fallback)   → phase 'fallback'
 *
 * @param onUpdate Called progressively as data becomes available.
 * @param forceRefresh Skip all caches and fetch fresh from Overpass.
 * @returns Promise resolving to the final graph data.
 */
export async function loadBangaloreNetwork(
  onUpdate?: (update: LoadUpdate) => void,
  forceRefresh = false,
): Promise<{ nodes: Map<string, RoadNode>; edges: Map<string, RoadEdge>; adjacency: Map<string, RoadEdge[]>; signals: Map<string, TrafficSignal> }> {

  // ── Phase 0: empty (map renders immediately) ──
  const empty = { nodes: new Map<string, RoadNode>(), edges: new Map<string, RoadEdge>(), adjacency: new Map<string, RoadEdge[]>(), signals: new Map<string, TrafficSignal>() };
  onUpdate?.({ ...empty, phase: 'empty', source: 'none' });

  // ── Phase 0.5: signals.json (instant signal markers) ──
  let signalOnly: typeof empty | null = null;
  try {
    const signalPoints = await tryLoadSignalPoints();
    if (signalPoints) {
      const nodes = new Map<string, RoadNode>();
      const signals = new Map<string, TrafficSignal>();
      for (const sp of signalPoints) {
        nodes.set(sp.nodeId, { id: sp.nodeId, lat: sp.lat, lng: sp.lng, isIntersection: true });
        signals.set(sp.nodeId, {
          id: sp.id, nodeId: sp.nodeId, phases: createPhase('N', 12),
          currentPhaseIndex: 0, timer: 0, cycleLength: 34, offset: 0,
          greenWaveDirection: null, congestionLevel: 0, adaptiveTiming: true, approaches: [],
        });
      }
      signalOnly = { nodes, edges: new Map(), adjacency: new Map(), signals };
      onUpdate?.({ ...signalOnly, phase: 'signals', source: 'signals.json' });
    }
  } catch { /* signals.json not available */ }

  // ── Phase 1: cache checks (fastest wins) ──
  if (!forceRefresh) {
    // Check local IndexedDB cache
    const cached = await loadGraphFromCache(CENTER.lat, CENTER.lng, RADIUS);
    if (cached) {
      const result = { nodes: cached.graph.nodes, edges: cached.graph.edges, adjacency: cached.graph.adjacency, signals: cached.signals };
      onUpdate?.({ ...result, phase: 'cached', source: 'IndexedDB' });
      return result;
    }

    // Check Firebase Storage (single blob download)
    try {
      const storageRaw = await loadOSMFromStorage(CENTER.lat, CENTER.lng, RADIUS);
      if (storageRaw && storageRaw.ways.length > 5) {
        const result = buildGraphFromOSM(storageRaw.nodes as Map<number, OSMNode>, storageRaw.ways as OSMWay[], CENTER.lat, CENTER.lng);
        onUpdate?.({ ...result, phase: 'cached', source: 'Firebase Storage' });
        // Re-cache to IndexedDB for faster next load
        saveGraphToCache(CENTER.lat, CENTER.lng, RADIUS, { nodes: result.nodes, edges: result.edges, adjacency: result.adjacency }, result.signals);
        return result;
      }
    } catch { /* Storage unavailable */ }

    // Check Firestore chunks (multi-doc)
    try {
      const firebaseRaw = await loadOSMFromFirebase(CENTER.lat, CENTER.lng, RADIUS);
      if (firebaseRaw && firebaseRaw.ways.length > 5) {
        const result = buildGraphFromOSM(firebaseRaw.nodes as Map<number, OSMNode>, firebaseRaw.ways as OSMWay[], CENTER.lat, CENTER.lng);
        onUpdate?.({ ...result, phase: 'cached', source: 'Firestore' });
        saveGraphToCache(CENTER.lat, CENTER.lng, RADIUS, { nodes: result.nodes, edges: result.edges, adjacency: result.adjacency }, result.signals);
        return result;
      }
    } catch { /* Firestore unavailable */ }
  }

  // ── Phase 2a: try server fetch if configured ──
  if (SERVER_URL) {
    try {
      const res = await fetch(`${SERVER_URL}/api/graph`);
      if (res.ok) {
        const data = await res.json();
        const { graphFromJSON } = await import('../engine/serverSync');
        const { graph: g, signals: sigs } = graphFromJSON(data);
        const result = { nodes: g.nodes, edges: g.edges, adjacency: g.adjacency, signals: sigs };
        onUpdate?.({ ...result, phase: 'full', source: data.source || 'server' });
        return result;
      }
    } catch { /* fall through to client-side fetch */ }
  }

  // ── Phase 2: emit fallback immediately, then fetch Overpass in background ──
  const fallbackGraph = loadFallback();
  onUpdate?.({ ...fallbackGraph, phase: 'fallback', source: 'synthetic grid' });

  // Background Overpass fetch (NO timeout — user already has the synthetic grid)
  (async () => {
    try {
      console.log('[WayFinder] Background: fetching OSM data for Bangalore (40km)…');
      const osmResult = await fetchOSMRoads(CENTER.lat, CENTER.lng, RADIUS);
      if (!osmResult || osmResult.ways.length < 5) {
        console.warn('[WayFinder] Background OSM fetch returned too few ways, keeping synthetic');
        return;
      }
      console.log(`[WayFinder] Background OSM: ${osmResult.nodes.size} nodes, ${osmResult.ways.length} ways`);
      const result = buildGraphFromOSM(osmResult.nodes, osmResult.ways as OSMWay[], CENTER.lat, CENTER.lng);
      console.log(`[WayFinder] Background graph: ${result.nodes.size}n, ${result.edges.size}e, ${result.signals.size}s`);
      onUpdate?.({ ...result, phase: 'full', source: 'Overpass API' });

      // Save to all caches
      const rawData: RawOSMData = { nodes: osmResult.nodes as Map<number, any>, ways: osmResult.ways as any[] };
      saveGraphToCache(CENTER.lat, CENTER.lng, RADIUS, { nodes: result.nodes, edges: result.edges, adjacency: result.adjacency }, result.signals);
      const storageOk = await saveOSMToStorage(CENTER.lat, CENTER.lng, RADIUS, rawData);
      if (storageOk) {
        console.log('[WayFinder] OSM data saved to Firebase Storage ✓');
      } else {
        console.warn('[WayFinder] Storage save failed, trying Firestore fallback');
        saveOSMToFirebase(CENTER.lat, CENTER.lng, RADIUS, rawData);
      }
    } catch (err) {
      console.error('[WayFinder] Background OSM fetch failed:', err);
    }
  })();

  return fallbackGraph;
}

/** Load signals.json quickly, returns null if not available */
async function tryLoadSignalPoints() {
  try {
    const { loadSignalPoints } = await import('./signalStore');
    return await loadSignalPoints();
  } catch { return null; }
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

export function getEdgeNodes(adjacency: Map<string, RoadEdge[]>): string[] {
  const result: string[] = [];
  for (const [id, edges] of adjacency) {
    if (edges.length >= 1 && edges.length <= 2) result.push(id);
  }
  return result;
}
