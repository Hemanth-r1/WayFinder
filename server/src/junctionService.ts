/**
 * Junctions for traffic police: every signalised junction with a permanent ID, its
 * approaches and neighbours, live queues and arrivals, a recommended timing plan and
 * advice for the junctions next to it.
 *
 * Officers read this view and apply changes in their own signal system. Controllers can
 * also try changes in the simulation: holding a green, or a new timing plan. With
 * coordination on, the neighbours react: downstream junctions open a green wave for the
 * released traffic, and upstream junctions feeding the held (red) approaches shorten
 * their green towards it so queues don't spill back into them.
 */
import type { RoadEdge, TrafficSignal, SignalArm } from './types.js';
import type { GraphIndex } from './pathfindingService.js';
import { getSimulationEngine } from './simulationEngine.js';
import { approachState } from './signalTiming.js';
import { getDb } from './firebaseClient.js';

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Saturation flow per lane (PCU/h) — IRC:93 urban value, rounded. */
const SATURATION_PER_LANE = 1800;
/** Lost time per phase change: yellow + all-red (s). */
const LOST_PER_PHASE = 5;
/** Cycle limits used by Bangalore signals (s). */
const MIN_CYCLE = 60;
const MAX_CYCLE = 180;
const MIN_GREEN = 15;
/** Largest cycle change one recommendation suggests (share of the current cycle). */
const MAX_STEP = 0.3;
/** Neighbour search: follow a road at most this far to the next junction (m). */
const MAX_LINK_METRES = 1500;
/** Queue reaching this share of the road to the upstream junction risks blocking it. */
const SPILLBACK_SHARE = 0.75;
/** Upstream gating: shorten the feeding green to this share while a hold lasts. */
const GATE_FACTOR = 0.6;
/** Downstream green-wave holds last at most this long (s). */
const WAVE_HOLD_MAX = 60;
/** Nobody should wait longer than this at one signal (s) — Bangalore drivers already face ~5–6 min. */
export const MAX_WAIT_S = 300;
/** Vehicles leaving per lane per second of green (≈ 1800 per hour). */
const DISCHARGE_PER_LANE_S = 0.5;

// ── Network of junctions ─────────────────────────────────────────────────────

/** A road from one junction to the next (upstream U → downstream J). */
export interface JunctionLink {
  from: string;
  to: string;
  /** Group at U whose green sends traffic towards J */
  fromGroup: string;
  /** Approach edge at J and its group there */
  approachEdgeId: string;
  toGroup: string;
  metres: number;
  /** Free-flow travel time (s) */
  seconds: number;
  road: string;
  /** Direction traffic leaves U on this road (degrees) */
  departure: number;
}

interface JunctionNet {
  signals: Map<string, TrafficSignal>;
  upstream: Map<string, JunctionLink[]>;
  downstream: Map<string, JunctionLink[]>;
}

let net: JunctionNet | null = null;
let indexRef: GraphIndex | null = null;

function groupFor(arrival: number, axis: number): 'A' | 'B' {
  const rel = ((arrival - axis) % 180 + 180) % 180;
  return rel < 45 || rel >= 135 ? 'A' : 'B';
}

/** Direction of travel on the first stretch of an edge (as it leaves its start node). */
function departureBearing(e: RoadEdge): number {
  const g = e.geometry;
  if (g.length < 2) return e.bearing;
  const y = (g[1].lng - g[0].lng) * Math.cos(g[0].lat * Math.PI / 180);
  const x = g[1].lat - g[0].lat;
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function turn(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360) - 180);
}

/** Builds the junction-to-junction links by following each approach road upstream. */
export function initJunctions(index: GraphIndex, signals: TrafficSignal[]): void {
  indexRef = index;
  const inEdges = new Map<string, RoadEdge[]>();
  for (const e of index.edgeList) (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);

  const byId = new Map(signals.map(s => [s.id, s]));
  const upstream = new Map<string, JunctionLink[]>();
  const downstream = new Map<string, JunctionLink[]>();

  for (const j of signals) {
    const members = new Set(j.nodeIds ?? [j.nodeId]);
    for (const a of j.approaches) {
      if (a.group === 'FREE') continue;
      let edge = index.edges.get(a.edgeId);
      let metres = 0, seconds = 0;
      const seen = new Set<string>();
      while (edge && metres < MAX_LINK_METRES && !seen.has(edge.id)) {
        seen.add(edge.id);
        metres += edge.length;
        seconds += edge.length / (Math.max(10, edge.speedLimit) / 3.6);
        const u = index.signalByNode.get(edge.from);
        if (u && !members.has(edge.from) && u.id !== j.id) {
          const link: JunctionLink = {
            from: u.id, to: j.id,
            // Straight-through traffic at U leaves in the direction it arrived: same group
            fromGroup: groupFor(departureBearing(edge), u.axis ?? 0),
            approachEdgeId: a.edgeId, toGroup: a.group,
            metres: Math.round(metres), seconds: Math.round(seconds),
            road: index.edges.get(a.edgeId)?.name || edge.name || '',
            departure: Math.round(departureBearing(edge)),
          };
          (upstream.get(j.id) ?? upstream.set(j.id, []).get(j.id)!).push(link);
          (downstream.get(u.id) ?? downstream.set(u.id, []).get(u.id)!).push(link);
          break;
        }
        // Keep following the same road backwards (straightest predecessor, no U-turns)
        const cur: RoadEdge = edge;
        const preds = (inEdges.get(cur.from) ?? []).filter(p => p.from !== cur.to);
        edge = preds.sort((p, q) => turn(p.bearing, cur.bearing) - turn(q.bearing, cur.bearing))[0];
      }
    }
  }
  net = { signals: byId, upstream, downstream };
  const links = [...upstream.values()].reduce((n, l) => n + l.length, 0);
  console.log(`[Junctions] ${signals.length} junctions, ${links} links between neighbours`);

  // Describe every direction of traffic in words, for drivers and police alike
  for (const j of signals) j.arms = describeArms(j, index, inEdges);
}

/** How far to follow a road to name the next / previous junction for directions (m). */
const NAME_SEARCH_METRES = 5000;

/**
 * Follows a road (straightest continuation, no U-turns) forwards or backwards until it
 * reaches another signalised junction; returns its name and distance, or the first new
 * road name met on the way.
 */
function followRoad(
  start: RoadEdge, index: GraphIndex, inEdges: Map<string, RoadEdge[]>, forward: boolean, skip: Set<string>,
): string {
  let edge: RoadEdge | undefined = start;
  let metres = 0;
  let newRoad = '';
  const seen = new Set<string>();
  while (edge && metres < NAME_SEARCH_METRES && !seen.has(edge.id)) {
    seen.add(edge.id);
    metres += edge.length;
    const node = forward ? edge.to : edge.from;
    if (!newRoad && edge.name && edge.name !== start.name) newRoad = edge.name;
    const sig = index.signalByNode.get(node);
    if (sig && !skip.has(node)) {
      return `${sig.name ?? sig.id} (${metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`})`;
    }
    const cur: RoadEdge = edge;
    const nexts = forward
      ? (index.outEdges.get(cur.to) ?? []).filter(e => e.to !== cur.from)
      : (inEdges.get(cur.from) ?? []).filter(e => e.from !== cur.to);
    edge = nexts.sort((p, q) => turn(p.bearing, cur.bearing) - turn(q.bearing, cur.bearing))[0];
    if (edge && turn(edge.bearing, cur.bearing) > 60) break; // the road ends here
  }
  return newRoad;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function compass(bearing: number): string {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

/**
 * Each approach as "Tumkur Road from the south-east, heading north-west towards
 * <next junction>": straight ahead is the exit with the smallest turn.
 */
function describeArms(j: TrafficSignal, index: GraphIndex, inEdges: Map<string, RoadEdge[]>): SignalArm[] {
  if (!net) return [];
  const members = new Set(j.nodeIds ?? [j.nodeId]);
  const exits: RoadEdge[] = [];
  for (const n of members) for (const e of index.outEdges.get(n) ?? []) if (!members.has(e.to)) exits.push(e);
  const downs = net.downstream.get(j.id) ?? [];
  const ups = net.upstream.get(j.id) ?? [];
  const arms: SignalArm[] = [];
  for (const a of j.approaches) {
    if (a.group === 'FREE') continue;
    const e = index.edges.get(a.edgeId);
    const straight = exits
      .filter(x => x.to !== e?.from)
      .sort((x, y) => turn(departureBearing(x), a.bearing) - turn(departureBearing(y), a.bearing))[0];
    const wave = downs
      .filter(d => turn(d.departure, a.bearing) < 45)
      .sort((x, y) => turn(x.departure, a.bearing) - turn(y.departure, a.bearing))[0];
    const towards = wave ? `${net.signals.get(wave.to)?.name ?? wave.to} (${wave.metres} m)`
      : (straight && followRoad(straight, index, inEdges, true, members)) || straight?.name || '';
    const up = ups.find(u => u.approachEdgeId === a.edgeId);
    const fromJunction = up ? `${net.signals.get(up.from)?.name ?? up.from} (${up.metres} m)`
      : (e && followRoad(e, index, inEdges, false, members)) || undefined;
    arms.push({
      edgeId: a.edgeId, group: a.group, road: e?.name || 'Unnamed road',
      from: compass(a.bearing + 180), heading: compass(a.bearing), towards,
      fromJunction, lanes: e?.lanes ?? 1,
    });
  }
  return arms;
}

// ── Live view and recommendations ────────────────────────────────────────────

export interface ApproachView {
  edgeId: string;
  road: string;
  group: string;
  bearing: number;
  lanes: number;
  light: 'RED' | 'YELLOW' | 'GREEN';
  queueVehicles: number;
  queueMetres: number;
  arrivalsPerHour: number;
  /** Upstream junction this road comes from */
  from?: { id: string; name: string; metres: number };
  /** "from the south-east, towards Yeshwanthpur" */
  direction: string;
  /** Estimated wait for the last vehicle in the queue (s), and whether it breaks MAX_WAIT_S */
  waitSeconds: number;
  overLimit: boolean;
}

export interface JunctionSummary {
  id: string;
  name: string;
  lat: number;
  lng: number;
  status: 'ok' | 'busy' | 'critical';
  /** 0–1+: worst of saturation and queue spillback */
  score: number;
  queueVehicles: number;
  cycle: number;
  controlled: boolean;
}

export interface JunctionDetail extends JunctionSummary {
  axis: number;
  phase: { index: number; group: string; color: string; timer: number; duration: number };
  phases: { group: string; color: string; duration: number }[];
  greens: Record<string, number>;
  approaches: ApproachView[];
  recommendation: {
    cycle: number;
    greens: Record<string, number>;
    /** Flow ratio per group and total (Webster's Y); ≥ 0.9 means oversaturated */
    flowRatio: Record<string, number>;
    saturation: number;
    summary: string;
  };
  advice: string[];
  neighbours: {
    upstream: { id: string; name: string; road: string; metres: number; seconds: number; toGroup: string }[];
    downstream: { id: string; name: string; road: string; metres: number; seconds: number; fromGroup: string }[];
  };
  control: ReturnType<NonNullable<ReturnType<typeof getSimulationEngine>>['getSignalControl']> | null;
}

/**
 * Seconds the last vehicle in a queue waits: until its group's green, plus a full cycle
 * for every extra green the queue needs to clear.
 */
function lastVehicleWait(s: TrafficSignal, group: string, queue: number, lanes: number): number {
  const green = s.phases.filter(p => p.group === group && p.color === 'GREEN').reduce((t, p) => t + p.duration, 0);
  if (green === 0) return 0;
  const C = s.cycleLength;
  const red = Math.max(0, C - green - 3);
  if (queue <= 0) return 0;
  const perCycle = green * Math.max(1, lanes) * DISCHARGE_PER_LANE_S;
  const cycles = Math.ceil(queue / perCycle);
  return red + (cycles - 1) * C;
}

function nameOf(id: string): string {
  return net?.signals.get(id)?.name ?? id;
}

function greensOf(s: TrafficSignal): Record<string, number> {
  const g: Record<string, number> = {};
  for (const p of s.phases) if (p.color === 'GREEN') g[p.group] = p.duration;
  return g;
}

function groupLabel(s: TrafficSignal, group: string, approaches: ApproachView[]): string {
  const roads = [...new Set(approaches.filter(a => a.group === group).map(a => a.road).filter(Boolean))];
  return roads.length ? roads.slice(0, 2).join(' / ') : group === 'A' ? 'main road' : 'cross road';
}

function analyse(s: TrafficSignal): JunctionDetail | null {
  const engine = getSimulationEngine();
  const index = indexRef;
  if (!engine || !index || !net) return null;
  const node = index.nodes.get(s.nodeId);
  if (!node) return null;

  const real = s.approaches.filter(a => a.group !== 'FREE');
  const stats = engine.getApproachStats(real.map(a => a.edgeId));
  const ups = net.upstream.get(s.id) ?? [];
  const approaches: ApproachView[] = real.map(a => {
    const e = index.edges.get(a.edgeId)!;
    const st = stats.get(a.edgeId) ?? { queueVehicles: 0, queueMetres: 0, arrivalsPerHour: 0 };
    const link = ups.find(l => l.approachEdgeId === a.edgeId);
    const arm = s.arms?.find(x => x.edgeId === a.edgeId);
    const lanes = e?.lanes ?? 1;
    const wait = lastVehicleWait(s, a.group, st.queueVehicles, lanes);
    return {
      edgeId: a.edgeId, road: e?.name ?? '', group: a.group, bearing: a.bearing, lanes,
      light: approachState(s, a.group), ...st,
      from: link ? { id: link.from, name: nameOf(link.from), metres: link.metres } : undefined,
      direction: arm ? `from the ${arm.from}${arm.fromJunction ? ` (${arm.fromJunction})` : ''}${arm.towards ? `, towards ${arm.towards}` : ''}` : '',
      waitSeconds: Math.round(wait), overLimit: wait > MAX_WAIT_S,
    };
  });

  // Webster: critical flow ratio per group, optimal cycle, greens in proportion
  const groups = [...new Set(s.phases.filter(p => p.color === 'GREEN').map(p => p.group))];
  const flowRatio: Record<string, number> = {};
  for (const g of groups) {
    flowRatio[g] = Math.max(0, ...approaches.filter(a => a.group === g)
      .map(a => a.arrivalsPerHour / (SATURATION_PER_LANE * Math.max(1, a.lanes))));
  }
  const Y = groups.reduce((t, g) => t + flowRatio[g], 0);
  const L = LOST_PER_PHASE * groups.length + (groups.length === 1 ? 18 : 0);
  const webster = Y >= 0.9 ? MAX_CYCLE : Math.min(MAX_CYCLE, Math.max(MIN_CYCLE, (1.5 * L + 5) / (1 - Y)));
  // Change timing step by step: at most ±30% of the current cycle per recommendation
  const cycle = Math.round(Math.min(s.cycleLength * (1 + MAX_STEP), Math.max(s.cycleLength * (1 - MAX_STEP), webster)));
  const recGreens: Record<string, number> = {};
  for (const g of groups) {
    recGreens[g] = Y > 0.01
      ? Math.max(MIN_GREEN, Math.round((cycle - L) * flowRatio[g] / Y))
      : greensOf(s)[g];
  }

  // Wait guard: give each group enough green to clear its queue within two cycles,
  // so nobody waits past MAX_WAIT_S (as far as the cycle limit allows)
  for (const g of groups) {
    const worst = approaches.filter(a => a.group === g)
      .reduce((m, a) => Math.max(m, a.queueVehicles / (2 * Math.max(1, a.lanes) * DISCHARGE_PER_LANE_S)), 0);
    if (worst > recGreens[g]) recGreens[g] = Math.min(120, Math.round(worst));
  }

  const greens = greensOf(s);
  const changes = groups
    .filter(g => Math.abs((recGreens[g] ?? 0) - (greens[g] ?? 0)) >= 5)
    .map(g => `${groupLabel(s, g, approaches)} ${recGreens[g]} s green (now ${greens[g]} s)`);
  const summary = changes.length
    ? `Suggested cycle ${cycle} s: ${changes.join('; ')}.`
    : 'Current timing fits the traffic.';

  // Advice for neighbours: spillback towards upstream junctions, green waves downstream
  const advice: string[] = [];
  let spill = 0;
  for (const a of approaches) {
    if (!a.from) continue;
    const share = a.queueMetres / Math.max(1, a.from.metres);
    spill = Math.max(spill, share);
    if (share >= SPILLBACK_SHARE) {
      advice.push(`Queue on ${a.road || 'the approach'} reaches ${Math.round(share * 100)}% of the way back to ${a.from.name} (${a.from.id}): ` +
        `shorten ${a.from.id}'s green towards this junction, or give this approach more green.`);
    }
  }
  const heavy = groups.sort((g1, g2) => flowRatio[g2] - flowRatio[g1])[0];
  for (const d of (net.downstream.get(s.id) ?? []).filter(l => l.fromGroup === heavy).slice(0, 3)) {
    advice.push(`Green wave: start ${d.to} (${nameOf(d.to)}) green about ${d.seconds} s after this junction's ` +
      `${groupLabel(s, heavy, approaches)} green turns on (${d.metres} m along ${d.road || 'the road'}).`);
  }
  for (const a of approaches.filter(x => x.overLimit)) {
    advice.unshift(`Drivers on ${a.road || 'an approach'} (${a.direction}) wait up to ${Math.round(a.waitSeconds / 60)} min — over the ${MAX_WAIT_S / 60} min limit: ` +
      `give group ${a.group} more green now (Hold ${a.group}) or apply the suggested timing.`);
  }
  if (Y >= 0.9) advice.unshift(`Oversaturated (flow ratio ${Y.toFixed(2)}): even a ${MAX_CYCLE} s cycle can't clear it — divert traffic upstream.`);

  const queueVehicles = approaches.reduce((t, a) => t + a.queueVehicles, 0);
  const maxWait = Math.max(0, ...approaches.map(a => a.waitSeconds));
  const score = Math.max(Y, spill, maxWait / MAX_WAIT_S * 0.85);
  const control = engine.getSignalControl(s.id) ?? null;
  const phase = s.phases[s.currentPhaseIndex];
  return {
    id: s.id, name: s.name ?? s.id, lat: node.lat, lng: node.lng,
    status: score >= 0.85 ? 'critical' : score >= 0.6 ? 'busy' : 'ok',
    score: Math.round(score * 100) / 100, queueVehicles, cycle: s.cycleLength, controlled: !!control,
    axis: s.axis ?? 0,
    phase: { index: s.currentPhaseIndex, group: phase.group, color: phase.color, timer: Math.round(s.timer), duration: phase.duration },
    phases: s.phases.map(p => ({ group: p.group, color: p.color, duration: p.duration })),
    greens, approaches,
    recommendation: {
      cycle, greens: recGreens,
      flowRatio: Object.fromEntries(Object.entries(flowRatio).map(([g, v]) => [g, Math.round(v * 100) / 100])),
      saturation: Math.round(Y * 100) / 100, summary,
    },
    advice,
    neighbours: {
      upstream: ups.map(l => ({ id: l.from, name: nameOf(l.from), road: l.road, metres: l.metres, seconds: l.seconds, toGroup: l.toGroup })),
      downstream: (net.downstream.get(s.id) ?? []).map(l => ({ id: l.to, name: nameOf(l.to), road: l.road, metres: l.metres, seconds: l.seconds, fromGroup: l.fromGroup })),
    },
    control,
  };
}

/** Every junction, worst first. */
export function listJunctions(): JunctionSummary[] {
  const engine = getSimulationEngine();
  if (!engine || !net) return [];
  const result: JunctionSummary[] = [];
  for (const s of engine.getSignals()) {
    const d = analyse(s);
    if (!d) continue;
    const { id, name, lat, lng, status, score, queueVehicles, cycle, controlled } = d;
    result.push({ id, name, lat, lng, status, score, queueVehicles, cycle, controlled });
  }
  return result.sort((a, b) => b.score - a.score);
}

export function getJunction(id: string): JunctionDetail | null {
  const s = getSimulationEngine()?.getSignals().find(x => x.id === id);
  return s ? analyse(s) : null;
}

// ── Control (simulation) and audit log ───────────────────────────────────────

export interface ControlLogEntry {
  at: number;
  by: string;
  junction: string;
  action: string;
  detail: string;
}

const log: ControlLogEntry[] = [];
const MAX_LOG = 500;

function record(entry: Omit<ControlLogEntry, 'at'>): void {
  const e = { at: Date.now(), ...entry };
  log.unshift(e);
  if (log.length > MAX_LOG) log.pop();
  // Durable copy when Firestore is configured
  getDb()?.collection('signalControlLog').add(e).catch(() => {});
}

export function controlLog(limit = 100): ControlLogEntry[] {
  return log.slice(0, limit);
}

export class ControlError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/**
 * Holds \`group\` green at a junction. With \`coordinate\`, downstream neighbours on the
 * released direction get a green wave and upstream neighbours feeding the stopped
 * approaches are gated. Returns what changed.
 */
export function holdGreen(id: string, group: string, seconds: number, coordinate: boolean, by: string): string[] {
  const engine = getSimulationEngine();
  if (!engine || !net) throw new ControlError('Simulation not running', 503);
  const secs = Math.round(Math.min(180, Math.max(10, seconds)));
  if (!engine.holdSignal(id, group, secs, by)) throw new ControlError(`Junction ${id} has no group ${group}`);
  const changes = [`${id} (${nameOf(id)}): group ${group} held green for ${secs} s`];
  const before = getJunction(id);
  for (const a of before?.approaches.filter(x => x.group !== group) ?? []) {
    const wait = a.waitSeconds + secs;
    if (wait > MAX_WAIT_S) {
      changes.push(`⚠ ${a.road || 'Cross road'} (${a.direction}) drivers may now wait ~${Math.round(wait / 60)} min — over the ${MAX_WAIT_S / 60} min limit`);
    }
  }

  if (coordinate) {
    const waved = new Set<string>();
    for (const d of (net.downstream.get(id) ?? []).filter(l => l.fromGroup === group)) {
      const hold = Math.min(WAVE_HOLD_MAX, secs);
      if (!waved.has(d.to) && engine.holdSignal(d.to, d.toGroup, hold, `${by} (green wave from ${id})`, d.seconds)) {
        waved.add(d.to);
        changes.push(`${d.to} (${nameOf(d.to)}): group ${d.toGroup} green in ${d.seconds} s for ${hold} s — green wave`);
      }
    }
    // A junction already opening a green wave isn't also gated
    for (const u of (net.upstream.get(id) ?? []).filter(l => l.toGroup !== group && !waved.has(l.from))) {
      if (engine.scaleSignalGreen(u.from, u.fromGroup, GATE_FACTOR, secs, `${by} (gating for ${id})`)) {
        changes.push(`${u.from} (${nameOf(u.from)}): group ${u.fromGroup} green cut to ${Math.round(GATE_FACTOR * 100)}% for ${secs} s — holds traffic back`);
      }
    }
  }
  record({ by, junction: id, action: 'hold', detail: changes.join(' | ') });
  return changes;
}

/** New green times for a junction (or the recommended ones). */
export function applyPlan(id: string, greens: Record<string, number> | 'recommended', by: string): string[] {
  const engine = getSimulationEngine();
  if (!engine) throw new ControlError('Simulation not running', 503);
  let plan = greens;
  if (plan === 'recommended') {
    const d = getJunction(id);
    if (!d) throw new ControlError(`Unknown junction ${id}`, 404);
    plan = d.recommendation.greens;
  }
  if (!engine.setSignalPlan(id, plan, by)) throw new ControlError(`Unknown junction ${id}`, 404);
  const detail = Object.entries(plan).map(([g, s]) => `${g} ${s} s`).join(', ');
  record({ by, junction: id, action: 'plan', detail });
  return [`${id} (${nameOf(id)}): greens ${detail}`];
}

export function resetJunction(id: string, by: string): string[] {
  const engine = getSimulationEngine();
  if (!engine?.resetSignal(id)) throw new ControlError(`Unknown junction ${id}`, 404);
  record({ by, junction: id, action: 'reset', detail: 'default timing' });
  return [`${id} (${nameOf(id)}): back to default timing`];
}
