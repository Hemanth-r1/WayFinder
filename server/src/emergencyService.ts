/**
 * Emergency corridors: an ambulance, fire engine or police vehicle on a run gets green at
 * every signal on its route, just in time for the queue in front of it to clear.
 *
 * For each signal ahead (approach edge on the route), every second:
 *   ETA      = time to that stop line at the vehicle's run speed (road limit × 1.25,
 *              never below its current speed)
 *   lead     = switch-over (amber + all-red if another group is green now)
 *            + queue clearance on its approach   LOST + N / (SAT × lanes)
 *            + safety margin
 *   green is requested when ETA ≤ lead and held until the vehicle is past the junction,
 *   then the signal goes back to its normal cycle. Traffic within 150 m in front of the
 *   vehicle slows and pulls to the kerb (simulation), and real drivers on its path are told
 *   to keep left. Runs are started by controllers (simulated vehicle) or by responders
 *   navigating in emergency mode (their own vehicle).
 */
import type { RoadGraph, TrafficSignal } from './types.js';
import { getGraphIndex, nearestRoadSegment, type GraphIndex } from './pathfindingService.js';
import { findRouteOptionsAsync } from './routeWorkers.js';
import { getSimulationEngine, EMERGENCY_KIND } from './simulationEngine.js';
import { signalControl } from './signalTiming.js';
import { movementAlong } from './turnRules.js';
import { getJunction, recordControl } from './junctionService.js';

export type EmergencyKind = 'ambulance' | 'fire' | 'police';

const SAT = 0.5;          // vehicles/s per lane
const LOST = 2;           // start-up lost time (s)
const JAM_M = 7;          // queued metres per vehicle and lane
const MARGIN_S = 6;       // extra lead so the vehicle never meets a closing queue
const LOOKAHEAD = 4;      // signals ahead managed at once
const TICK_MS = 1000;
const PASS_HOLD_S = 8;    // green kept after the expected arrival (s)
const ALERT_METRES = 400; // drivers this far ahead on the vehicle's path are alerted

export interface CorridorSignal {
  junctionId: string;
  name: string;
  /** Route index of the approach edge */
  index: number;
  approachEdgeId: string;
  group: string;
  lat: number;
  lng: number;
  eta: number | null;
  state: 'ahead' | 'green' | 'passed';
}

export interface Corridor {
  id: string;
  kind: EmergencyKind;
  vehicleId: string;
  /** Responder driving it (real user), or none for a simulated run */
  userId?: string;
  route: string[];
  geometry: { lat: number; lng: number }[];
  signals: CorridorSignal[];
  startedBy: string;
  startedAt: number;
  status: 'active' | 'arrived' | 'cancelled';
  /** Seconds to the destination at run speed */
  eta: number;
  position?: { lat: number; lng: number };
}

let graphRef: RoadGraph | null = null;
let signalsRef: TrafficSignal[] = [];
const corridors = new Map<string, Corridor>();
let counter = 0;
let timer: NodeJS.Timeout | null = null;

export function initEmergency(graph: RoadGraph, signals: TrafficSignal[]): void {
  graphRef = graph; signalsRef = signals;
  if (!timer) timer = setInterval(tick, TICK_MS);
  timer.unref();
}

function index(): GraphIndex {
  if (!graphRef) throw new EmergencyError('Road network not loaded', 503);
  return getGraphIndex(graphRef, signalsRef);
}

export class EmergencyError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Signals on a route: each approach edge whose end is a signal stop line. */
function signalsOnRoute(idx: GraphIndex, route: string[]): CorridorSignal[] {
  const out: CorridorSignal[] = [];
  route.forEach((id, i) => {
    const e = idx.edges.get(id);
    if (!e || i === route.length - 1) return;
    const c = signalControl(idx.signalByNode, e);
    if (!c) return;
    if (out.length && out[out.length - 1].junctionId === c.signal.id) return; // same junction, inner stop line
    const n = idx.nodes.get(c.signal.nodeId);
    out.push({
      junctionId: c.signal.id, name: c.signal.name ?? c.signal.id, index: i, approachEdgeId: id, group: c.group,
      lat: n?.lat ?? 0, lng: n?.lng ?? 0, eta: null, state: 'ahead',
    });
  });
  return out;
}

/** The phase group that lets the vehicle's movement go (turn-based phases), else its road's group. */
function groupFor(signal: TrafficSignal, approachEdgeId: string, route: string[], i: number, fallback: string): string {
  const turn = movementAlong(approachEdgeId, route.slice(i + 1, i + 12))?.turn ?? 'straight';
  const key = `${approachEdgeId}:${turn}`;
  return signal.phases.find(p => p.color === 'GREEN' && p.moves?.includes(key))?.group ?? fallback;
}

function geometryOf(idx: GraphIndex, route: string[]): { lat: number; lng: number }[] {
  const pts: { lat: number; lng: number }[] = [];
  route.forEach((id, i) => {
    const g = idx.edges.get(id)?.geometry ?? [];
    pts.push(...(i === 0 ? g : g.slice(1)));
  });
  return pts;
}

/** Run speed on an edge (m/s): limit × 1.25, at most 80 km/h. */
function runSpeed(limitKmh: number): number {
  return Math.min(limitKmh * 1.25, 80) / 3.6;
}

function register(c: Corridor): Corridor {
  corridors.set(c.id, c);
  recordControl(c.startedBy, c.signals[0]?.junctionId ?? '-', 'emergency corridor',
    `${c.kind} ${c.id}: ${c.signals.length} signals, ~${Math.round(c.eta / 60)} min${c.userId ? ' (responder)' : ' (simulated)'}`);
  return c;
}

/** Controllers: dispatch a simulated emergency vehicle from one point to another. */
export async function dispatchEmergency(from: { lat: number; lng: number }, to: { lat: number; lng: number }, kind: EmergencyKind, by: string): Promise<Corridor> {
  const idx = index();
  const engine = getSimulationEngine();
  if (!engine) throw new EmergencyError('Simulation not running', 503);
  const a = nearestRoadSegment(idx, from.lat, from.lng, 300), b = nearestRoadSegment(idx, to.lat, to.lng, 300);
  if (!a || !b) throw new EmergencyError('Start and destination must be on a road');
  const options = await findRouteOptionsAsync(a.edge.from, b.edge.to, { occupancy: engine.getOccupancy() }, 1);
  const best = options[0];
  if (!best || best.edgeIds.length < 2) throw new EmergencyError('No route found', 404);
  const vehicleId = engine.addRoutedVehicle(best.edgeIds, { kind: EMERGENCY_KIND, emergency: true });
  if (!vehicleId) throw new EmergencyError('Could not place the vehicle', 500);
  return register({
    id: `E${++counter}`, kind, vehicleId, route: best.edgeIds, geometry: geometryOf(idx, best.edgeIds),
    signals: signalsOnRoute(idx, best.edgeIds), startedBy: by, startedAt: Date.now(), status: 'active',
    eta: best.edgeIds.reduce((t, id) => t + (idx.edges.get(id)!.length / runSpeed(idx.edges.get(id)!.speedLimit)), 0),
  });
}

/** Responders: their own navigation becomes an emergency run (vehicle already on the road). */
export function startResponderRun(userId: string, vehicleId: string, route: string[], kind: EmergencyKind): Corridor {
  const idx = index();
  for (const c of corridors.values()) if (c.userId === userId && c.status === 'active') finish(c, 'cancelled');
  return register({
    id: `E${++counter}`, kind, vehicleId, userId, route, geometry: geometryOf(idx, route),
    signals: signalsOnRoute(idx, route), startedBy: userId, startedAt: Date.now(), status: 'active',
    eta: route.reduce((t, id) => t + (idx.edges.get(id)!.length / runSpeed(idx.edges.get(id)!.speedLimit)), 0),
  });
}

/** A responder's route changed (reroute): follow the new one. */
export function updateResponderRoute(userId: string, route: string[]): void {
  const c = [...corridors.values()].find(x => x.userId === userId && x.status === 'active');
  if (!c) return;
  const idx = index();
  for (const s of c.signals) if (s.state === 'green') getSimulationEngine()?.clearEmergencyGreen(s.junctionId, c.id);
  c.route = route;
  c.geometry = geometryOf(idx, route);
  c.signals = signalsOnRoute(idx, route);
}

function finish(c: Corridor, status: 'arrived' | 'cancelled'): void {
  if (c.status !== 'active') return;
  c.status = status;
  const engine = getSimulationEngine();
  for (const s of c.signals) engine?.clearEmergencyGreen(s.junctionId, c.id);
  engine?.endEmergency(c.vehicleId);
  setTimeout(() => corridors.delete(c.id), 60_000).unref();
}

export function cancelCorridor(id: string, by: string): boolean {
  const c = corridors.get(id);
  if (!c || c.status !== 'active') return false;
  finish(c, 'cancelled');
  recordControl(by, c.signals[0]?.junctionId ?? '-', 'emergency corridor', `${c.id} cancelled`);
  return true;
}

export function endResponderRun(userId: string): void {
  for (const c of corridors.values()) if (c.userId === userId) finish(c, 'arrived');
}

export function listCorridors(): Corridor[] {
  return [...corridors.values()];
}

/** Every second: ETAs to the signals ahead, green just in time, release behind. */
function tick(): void {
  const engine = getSimulationEngine();
  if (!engine || corridors.size === 0) return;
  const idx = index();
  const now = Date.now();
  for (const c of corridors.values()) {
    if (c.status !== 'active') continue;
    const p = engine.emergencyProgress(c.vehicleId);
    if (!p) { finish(c, 'arrived'); continue; } // vehicle gone: arrived or removed
    c.position = { lat: p.lat, lng: p.lng };
    // Time to the end of each route edge from where the vehicle is
    let t = 0;
    const timeToEnd: number[] = [];
    for (let i = p.routeIndex; i < c.route.length; i++) {
      const e = idx.edges.get(c.route[i]);
      if (!e) break;
      const len = i === p.routeIndex ? Math.max(0, e.length - p.progress) : e.length;
      t += len / Math.max(p.v, runSpeed(e.speedLimit) * 0.8);
      timeToEnd[i] = t;
    }
    c.eta = Math.round(t);
    let managed = 0;
    for (const s of c.signals) {
      if (s.state === 'passed') continue;
      if (s.index < p.routeIndex) {
        s.state = 'passed';
        s.eta = null;
        engine.clearEmergencyGreen(s.junctionId, c.id);
        continue;
      }
      if (managed >= LOOKAHEAD) { s.eta = timeToEnd[s.index] ?? null; continue; }
      managed++;
      const eta = timeToEnd[s.index] ?? Infinity;
      s.eta = Number.isFinite(eta) ? Math.round(eta) : null;
      const sig = idx.signalByNode.get(idx.edges.get(s.approachEdgeId)?.to ?? '');
      if (!sig) continue;
      const group = groupFor(sig, s.approachEdgeId, c.route, s.index, s.group);
      const approach = getJunction(s.junctionId)?.approaches.find(a => a.edgeId === s.approachEdgeId);
      const lanes = Math.max(1, approach?.lanes ?? 1);
      const queued = (approach?.queueMetres ?? 0) * lanes / JAM_M;
      const phase = sig.phases[sig.currentPhaseIndex];
      const switching = phase.color === 'GREEN' && phase.group !== group
        ? (sig.phases.find(x => x.group === phase.group && x.color === 'YELLOW')?.duration ?? 3) + (sig.phases.find(x => x.group === 'ALL')?.duration ?? 2)
        : 0;
      const lead = switching + LOST + queued / (SAT * lanes) + MARGIN_S;
      if (s.state === 'green' || eta <= lead) {
        if (engine.setEmergencyGreen(s.junctionId, group, now + (eta + PASS_HOLD_S) * 1000, c.id)) s.state = 'green';
      }
    }
  }
}

/** For a driver's navigation: an emergency vehicle close behind on the road ahead of them. */
export function emergencyBehind(userId: string, route: string[], routeIndex: number, progress: number): { kind: EmergencyKind; metres: number } | null {
  if (corridors.size === 0 || !graphRef) return null;
  const engine = getSimulationEngine();
  const idx = index();
  const mine = route[routeIndex];
  for (const c of corridors.values()) {
    if (c.status !== 'active' || c.userId === userId) continue;
    const p = engine?.emergencyProgress(c.vehicleId);
    if (!p) continue;
    // Walk the vehicle's path ahead of it, up to ALERT_METRES, looking for this driver's road
    let metres = -p.progress;
    for (let i = p.routeIndex; i < c.route.length && metres < ALERT_METRES; i++) {
      if (c.route[i] === mine) {
        const gap = metres + progress; // the driver's place on that road
        if (gap > 0 && gap < ALERT_METRES) return { kind: c.kind, metres: Math.round(gap) };
        break;
      }
      metres += idx.edges.get(c.route[i])?.length ?? 0;
    }
  }
  return null;
}

/** A responder's own run: how many signals are green ahead and the next one. */
export function emergencyRunOf(userId: string): { id: string; kind: EmergencyKind; signals: number; greenAhead: number; next?: { name: string; eta: number | null; green: boolean } } | null {
  const c = [...corridors.values()].find(x => x.userId === userId && x.status === 'active');
  if (!c) return null;
  const ahead = c.signals.filter(s => s.state !== 'passed');
  const n = ahead[0];
  return {
    id: c.id, kind: c.kind, signals: c.signals.length, greenAhead: ahead.filter(s => s.state === 'green').length,
    next: n ? { name: n.name, eta: n.eta, green: n.state === 'green' } : undefined,
  };
}
