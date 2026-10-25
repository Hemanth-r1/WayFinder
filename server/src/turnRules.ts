/**
 * Turn rules and turn-based signal phases, set by controllers once per junction.
 *
 * A movement is one way through a junction: approach road → exit road, with its turn
 * (left / straight / right / U-turn, India drives on the left). Movements are found by
 * walking every road out of the approach's stop line until it leaves the junction area,
 * so junctions drawn with several nodes (dual carriageways, stop lines before the
 * crossing) still give one movement per exit.
 *
 * Rules per approach: which turns are allowed, and "free left" (left turn never stops for
 * the signal, gives way instead). Banned movements are closed in the simulation and in
 * route planning by banning the first step of their path that no allowed movement uses.
 *
 * Phases: instead of whole roads (group A / B), each phase lets a set of movements go,
 * e.g. "Tumkur Road from the south-east: all turns", then "Tumkur Road both ways:
 * straight + left", then "right turns". Each green gets its amber and all-red.
 * Rules are kept in Firestore `junctionRules/{junctionId}` and applied at start-up.
 */
import type { RoadEdge, TrafficSignal, SignalPhase } from './types.js';
import type { GraphIndex } from './pathfindingService.js';
import { getDb } from './firebaseClient.js';
import { clearSignalCache } from './signalTiming.js';
import { getSimulationEngine } from './simulationEngine.js';

export type Turn = 'left' | 'straight' | 'right' | 'uturn';
export const TURNS: Turn[] = ['left', 'straight', 'right', 'uturn'];

export interface Movement {
  approachEdgeId: string;
  exitEdgeId: string;
  turn: Turn;
  /** Edges after the approach, up to and including the exit edge */
  path: string[];
  /** Exit road name and the direction it heads */
  road: string;
  heading: number;
}

export interface ApproachRule {
  edgeId: string;
  allowed: Turn[];
  /** Left turn goes without waiting for green (gives way instead) */
  freeLeft: boolean;
}

export interface PhaseSpec {
  green: number;
  moves: { edgeId: string; turns: Turn[] }[];
}

export interface JunctionRules {
  approaches: ApproachRule[];
  /** null: keep the road-based phases (group A / B) */
  phases: PhaseSpec[] | null;
  by: string;
  at: number;
}

const AREA_MIN_M = 30;
const AREA_PAD_M = 25;
const MAX_PATH_M = 220;
const STRAIGHT_DEG = 35;
const UTURN_DEG = 150;
const MIN_GREEN = 5;
const MAX_GREEN = 180;

let indexRef: GraphIndex | null = null;
const signalsById = new Map<string, TrafficSignal>();
/** approach edge id → its movements */
const movesByApproach = new Map<string, Movement[]>();
/** approach edge id → junction id */
const junctionOfApproach = new Map<string, string>();
const rulesById = new Map<string, JunctionRules>();
/** Original phases and approach groups, to go back to defaults */
const defaults = new Map<string, { phases: SignalPhase[]; groups: Map<string, string> }>();
/** "fromEdge>toEdge" steps closed by turn rules */
let banned = new Set<string>();
/** junction id → movements its rules ban but cannot close without closing allowed ones */
const unenforceable = new Map<string, string[]>();
type BanListener = (pairs: [string, string][]) => void;
const banListeners = new Set<BanListener>();

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const kx = 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 111320);
}

function bearingOf(e: RoadEdge, end = false): number {
  const g = e.geometry;
  if (!g || g.length < 2) return e.bearing;
  const [a, b] = end ? [g[g.length - 2], g[g.length - 1]] : [g[0], g[1]];
  const y = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180), x = b.lat - a.lat;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Turn from arriving on `inBearing` to leaving on `outBearing` (+ right, − left). */
export function turnFor(inBearing: number, outBearing: number, backAlongApproach = false): Turn {
  const d = ((outBearing - inBearing + 540) % 360) - 180;
  if (backAlongApproach || Math.abs(d) > UTURN_DEG) return 'uturn';
  if (Math.abs(d) <= STRAIGHT_DEG) return 'straight';
  return d < 0 ? 'left' : 'right';
}

/** Every movement out of each approach of every signal. Call once the graph is built. */
export function initTurnRules(index: GraphIndex, signals: TrafficSignal[]): void {
  indexRef = index;
  for (const s of signals) {
    signalsById.set(s.id, s);
    defaults.set(s.id, { phases: s.phases.map(p => ({ ...p })), groups: new Map(s.approaches.map(a => [a.edgeId, a.group])) });
    const members = s.nodeIds ?? [s.nodeId];
    const centre = index.nodes.get(s.nodeId);
    if (!centre) continue;
    const pts = members.map(id => index.nodes.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
    const radius = Math.max(AREA_MIN_M, ...pts.map(p => metres(centre, p) + AREA_PAD_M));
    const inside = (nodeId: string) => { const n = index.nodes.get(nodeId); return !!n && metres(centre, n) <= radius; };
    for (const a of s.approaches) {
      if (a.group === 'FREE') continue;
      const start = index.edges.get(a.edgeId);
      if (!start) continue;
      junctionOfApproach.set(a.edgeId, s.id);
      const arrive = bearingOf(start, true);
      const best = new Map<string, { path: string[]; len: number }>();
      // Depth-first over the roads inside the junction area
      const walk = (node: string, path: string[], len: number, seen: Set<string>) => {
        for (const e of index.outEdges.get(node) ?? []) {
          if (seen.has(e.to)) continue;
          const p = [...path, e.id], l = len + e.length;
          if (!inside(e.to) || l > MAX_PATH_M) {
            const had = best.get(e.id);
            if (!had || l < had.len) best.set(e.id, { path: p, len: l });
            continue;
          }
          seen.add(e.to);
          walk(e.to, p, l, seen);
          seen.delete(e.to);
        }
      };
      walk(start.to, [], 0, new Set([start.from, start.to]));
      const moves: Movement[] = [];
      for (const [exitId, { path }] of best) {
        const exit = index.edges.get(exitId)!;
        const back = exit.to === start.from || (exit.name !== '' && exit.name === start.name && Math.abs(((bearingOf(exit) - arrive + 540) % 360) - 180) > 120);
        moves.push({ approachEdgeId: a.edgeId, exitEdgeId: exitId, turn: turnFor(arrive, bearingOf(exit), back), path, road: exit.name || 'Unnamed road', heading: Math.round(bearingOf(exit)) });
      }
      movesByApproach.set(a.edgeId, moves);
    }
  }
}

/** Movements out of an approach edge (undefined when the edge is no signal approach). */
export function movesFrom(approachEdgeId: string): Movement[] | undefined {
  return movesByApproach.get(approachEdgeId);
}

export function movementsOf(junctionId: string): Movement[] {
  const s = signalsById.get(junctionId);
  return s ? s.approaches.flatMap(a => movesByApproach.get(a.edgeId) ?? []) : [];
}

export function rulesOf(junctionId: string): JunctionRules | undefined {
  return rulesById.get(junctionId);
}

/** Allowed turns from an approach (all, when the junction has no rules). */
export function allowedTurns(approachEdgeId: string): Turn[] {
  const j = junctionOfApproach.get(approachEdgeId);
  const r = j ? rulesById.get(j)?.approaches.find(a => a.edgeId === approachEdgeId) : undefined;
  return r ? r.allowed : TURNS;
}

export function isFreeLeft(approachEdgeId: string): boolean {
  const j = junctionOfApproach.get(approachEdgeId);
  return !!(j && rulesById.get(j)?.approaches.find(a => a.edgeId === approachEdgeId)?.freeLeft);
}

/** True when the step from one edge to the next is closed by a turn rule. */
export function isTurnBanned(fromEdgeId: string, toEdgeId: string): boolean {
  return banned.size > 0 && banned.has(fromEdgeId + '>' + toEdgeId);
}

export function bannedSteps(): [string, string][] {
  return [...banned].map(k => k.split('>') as [string, string]);
}

/** Route workers listen here to keep their copy of the closed steps. */
export function onBansChanged(fn: BanListener): void {
  banListeners.add(fn);
}

export function unenforceableMoves(junctionId: string): string[] {
  return unenforceable.get(junctionId) ?? [];
}

/** The movement a vehicle on `approachEdgeId` makes when its next edges are `ahead`. */
export function movementAlong(approachEdgeId: string, ahead: string[]): Movement | undefined {
  const moves = movesByApproach.get(approachEdgeId);
  if (!moves || ahead.length === 0) return undefined;
  let best: Movement | undefined;
  for (const m of moves) {
    let k = 0;
    while (k < m.path.length && k < ahead.length && m.path[k] === ahead[k]) k++;
    if (k === m.path.length || (k === ahead.length && k > 0)) {
      if (!best || m.path.length > best.path.length) best = m;
    }
  }
  return best;
}

// ── Phases ───────────────────────────────────────────────────────────────────

const moveKey = (edgeId: string, turn: Turn) => `${edgeId}:${turn}`;

/** Light shown to a movement, or null when the signal runs road-based phases. */
export function movementLight(signal: TrafficSignal, approachEdgeId: string, turn: Turn): 'GREEN' | 'YELLOW' | 'RED' | null {
  const phase = signal.phases[signal.currentPhaseIndex];
  if (!phase?.moves) return null;
  if (!phase.moves.includes(moveKey(approachEdgeId, turn))) return 'RED';
  return phase.color === 'GREEN' ? 'GREEN' : phase.color === 'YELLOW' ? 'YELLOW' : 'RED';
}

/** Builds green / amber / all-red phases from a phase list, timings taken from the default plan. */
function buildPhases(s: TrafficSignal, specs: PhaseSpec[]): SignalPhase[] {
  const base = defaults.get(s.id)?.phases ?? s.phases;
  const amber = base.find(p => p.color === 'YELLOW')?.duration ?? 3;
  const allRed = base.find(p => p.group === 'ALL')?.duration ?? 2;
  const out: SignalPhase[] = [];
  specs.forEach((sp, i) => {
    const group = `P${i + 1}`;
    const moves = sp.moves.flatMap(m => m.turns.map(t => moveKey(m.edgeId, t)));
    out.push({ group, color: 'GREEN', duration: Math.round(sp.green), yellowDuration: amber, moves });
    out.push({ group, color: 'YELLOW', duration: amber, yellowDuration: 0, moves });
    out.push({ group: 'ALL', color: 'RED', duration: allRed, yellowDuration: 0, moves: [] });
  });
  return out;
}

// ── Checking and applying ────────────────────────────────────────────────────

export class RuleError extends Error {
  status = 400;
}

/**
 * Movements that cross: two movements from different approaches whose paths over the
 * junction circle interleave (entries and exits placed by direction, left-hand traffic).
 */
function crosses(a: Movement, b: Movement, arrive: Map<string, number>): boolean {
  if (a.approachEdgeId === b.approachEdgeId) return false;
  if (a.exitEdgeId === b.exitEdgeId) return true; // both merge into the same road
  const pos = (from: number, exit: boolean) => (((exit ? from - 4 : from + 4) % 360) + 360) % 360;
  const a1 = pos((arrive.get(a.approachEdgeId)! + 180) % 360, false), a2 = pos(a.heading, true);
  const b1 = pos((arrive.get(b.approachEdgeId)! + 180) % 360, false), b2 = pos(b.heading, true);
  const between = (x: number, lo: number, hi: number) => lo < hi ? x > lo && x < hi : x > lo || x < hi;
  return between(b1, a1, a2) !== between(b2, a1, a2);
}

export interface RulesCheck { warnings: string[] }

/** Validates rules for a junction; throws RuleError on bad input, returns warnings. */
export function checkRules(junctionId: string, input: { approaches: ApproachRule[]; phases: PhaseSpec[] | null }): RulesCheck {
  const s = signalsById.get(junctionId);
  if (!s || !indexRef) throw Object.assign(new RuleError(`Unknown junction ${junctionId}`), { status: 404 });
  const idx = indexRef;
  const ids = new Set(s.approaches.filter(a => a.group !== 'FREE').map(a => a.edgeId));
  const warnings: string[] = [];
  const name = (edgeId: string) => {
    const e = idx.edges.get(edgeId);
    return `${e?.name || 'Unnamed road'} from the ${compassWord(((e ? bearingOf(e, true) : 0) + 180) % 360)}`;
  };
  for (const r of input.approaches) {
    if (!ids.has(r.edgeId)) throw new RuleError(`Not an approach of ${junctionId}: ${r.edgeId}`);
    if (!Array.isArray(r.allowed) || r.allowed.some(t => !TURNS.includes(t))) throw new RuleError('allowed must list left / straight / right / uturn');
    const has = new Set((movesByApproach.get(r.edgeId) ?? []).map(m => m.turn));
    const missing = r.allowed.filter(t => !has.has(t));
    if (missing.length) warnings.push(`${name(r.edgeId)}: no road for ${missing.join(', ')} here`);
    if (r.allowed.length === 0) warnings.push(`${name(r.edgeId)}: every turn closed — vehicles can only arrive here to be rerouted`);
  }
  if (input.phases) {
    if (input.phases.length < 1 || input.phases.length > 8) throw new RuleError('1 to 8 phases');
    const allowed = new Map(input.approaches.map(r => [r.edgeId, new Set(r.allowed)]));
    const served = new Set<string>();
    const arrive = new Map<string, number>();
    for (const a of s.approaches) { const e = idx.edges.get(a.edgeId); if (e) arrive.set(a.edgeId, bearingOf(e, true)); }
    input.phases.forEach((p, i) => {
      if (!(p.green >= MIN_GREEN && p.green <= MAX_GREEN)) throw new RuleError(`Phase ${i + 1}: green must be ${MIN_GREEN}–${MAX_GREEN} s`);
      if (!Array.isArray(p.moves) || p.moves.length === 0) throw new RuleError(`Phase ${i + 1} lets nothing go`);
      const inPhase: Movement[] = [];
      for (const m of p.moves) {
        if (!ids.has(m.edgeId)) throw new RuleError(`Phase ${i + 1}: not an approach: ${m.edgeId}`);
        for (const t of m.turns) {
          if (!TURNS.includes(t)) throw new RuleError(`Phase ${i + 1}: unknown turn ${t}`);
          if (allowed.has(m.edgeId) && !allowed.get(m.edgeId)!.has(t)) warnings.push(`Phase ${i + 1}: ${name(m.edgeId)} ${t} is a closed turn`);
          served.add(moveKey(m.edgeId, t));
          inPhase.push(...(movesByApproach.get(m.edgeId) ?? []).filter(x => x.turn === t));
        }
      }
      // Conflicts inside the phase (right turns across oncoming straight traffic only give way)
      const said = new Set<string>();
      for (let x = 0; x < inPhase.length; x++) for (let y = x + 1; y < inPhase.length; y++) {
        const a = inPhase[x], b = inPhase[y];
        if (!crosses(a, b, arrive)) continue;
        const key = [moveKey(a.approachEdgeId, a.turn), moveKey(b.approachEdgeId, b.turn)].sort().join('|');
        if (said.has(key)) continue;
        said.add(key);
        const giveWay = (a.turn === 'right' && b.turn === 'straight') || (b.turn === 'right' && a.turn === 'straight');
        warnings.push(`Phase ${i + 1}: ${name(a.approachEdgeId)} ${a.turn} ${giveWay ? 'gives way to' : 'crosses'} ${name(b.approachEdgeId)} ${b.turn}`);
      }
    });
    for (const a of s.approaches) {
      if (a.group === 'FREE') continue;
      const allow = allowed.get(a.edgeId) ?? new Set(TURNS);
      const free = input.approaches.find(r => r.edgeId === a.edgeId)?.freeLeft;
      const has = new Set((movesByApproach.get(a.edgeId) ?? []).map(m => m.turn));
      for (const t of allow) {
        if (!has.has(t) || (t === 'left' && free) || served.has(moveKey(a.edgeId, t))) continue;
        warnings.push(`${name(a.edgeId)} ${t} never gets green`);
      }
    }
  }
  return { warnings };
}

function compassWord(b: number): string {
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round((((b % 360) + 360) % 360) / 45) % 8];
}

/** Applies rules to the live signal (phases, groups) and recomputes the closed steps. */
function apply(junctionId: string, rules: JunctionRules | null): void {
  const s = signalsById.get(junctionId);
  const def = defaults.get(junctionId);
  if (!s || !def) return;
  if (rules) rulesById.set(junctionId, rules); else rulesById.delete(junctionId);

  if (rules?.phases) {
    s.phases = buildPhases(s, rules.phases);
    // Each approach's group = the phase that lets its straight traffic (else any of it) go
    for (const a of s.approaches) {
      if (a.group === 'FREE' && !movesByApproach.has(a.edgeId)) continue;
      const phase = s.phases.find(p => p.color === 'GREEN' && p.moves?.includes(moveKey(a.edgeId, 'straight')))
        ?? s.phases.find(p => p.color === 'GREEN' && p.moves?.some(k => k.startsWith(a.edgeId + ':')));
      a.group = phase?.group ?? 'NONE';
    }
  } else {
    s.phases = def.phases.map(p => ({ ...p }));
    for (const a of s.approaches) a.group = def.groups.get(a.edgeId) ?? a.group;
  }
  s.currentPhaseIndex = 0;
  s.timer = 0;
  s.cycleLength = s.phases.reduce((t, p) => t + p.duration, 0);
  clearSignalCache(s);
  getSimulationEngine()?.phasesReplaced(junctionId);
  rebuildBans();
}

function rebuildBans(): void {
  const next = new Set<string>();
  unenforceable.clear();
  for (const [jid, rules] of rulesById) {
    const s = signalsById.get(jid);
    if (!s) continue;
    const seq = (m: Movement) => [m.approachEdgeId, ...m.path];
    const steps = (ids: string[]) => ids.slice(1).map((id, k) => ids[k] + '>' + id);
    const allowedSteps = new Set<string>();
    const closed: Movement[] = [];
    for (const a of s.approaches) {
      const allow = new Set(rules.approaches.find(r => r.edgeId === a.edgeId)?.allowed ?? TURNS);
      for (const m of movesByApproach.get(a.edgeId) ?? []) {
        if (allow.has(m.turn)) steps(seq(m)).forEach(k => allowedSteps.add(k));
        else closed.push(m);
      }
    }
    for (const m of closed) {
      const step = steps(seq(m)).find(k => !allowedSteps.has(k));
      if (step) next.add(step);
      else (unenforceable.get(jid) ?? unenforceable.set(jid, []).get(jid)!).push(`${m.road} (${m.turn})`);
    }
  }
  banned = next;
  const pairs = bannedSteps();
  for (const fn of banListeners) fn(pairs);
}

/** Sets (or with null, clears) a junction's rules: applied now and saved. */
export function setRules(junctionId: string, input: { approaches: ApproachRule[]; phases: PhaseSpec[] | null } | null, by: string): RulesCheck {
  if (!input) {
    apply(junctionId, null);
    getDb()?.collection('junctionRules').doc(junctionId).delete().catch(() => {});
    return { warnings: [] };
  }
  const clean = {
    approaches: input.approaches.map(r => ({ edgeId: String(r.edgeId), allowed: [...new Set(r.allowed)] as Turn[], freeLeft: !!r.freeLeft })),
    phases: input.phases ? input.phases.map(p => ({ green: Math.round(Number(p.green)), moves: p.moves.map(m => ({ edgeId: String(m.edgeId), turns: [...new Set(m.turns)] as Turn[] })) })) : null,
  };
  const check = checkRules(junctionId, clean);
  const rules: JunctionRules = { ...clean, by, at: Date.now() };
  apply(junctionId, rules);
  getDb()?.collection('junctionRules').doc(junctionId).set(rules).catch((err: Error) => console.warn('[TurnRules] save failed:', err.message));
  return { warnings: [...check.warnings, ...unenforceableMoves(junctionId).map(m => `cannot close ${m} without closing an allowed turn (shared road inside the junction)`)] };
}

/** Loads saved rules from Firestore (no-op without Firebase). */
export async function loadSavedRules(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  try {
    const snap = await db.collection('junctionRules').get();
    let n = 0;
    for (const doc of snap.docs) {
      const r = doc.data() as JunctionRules;
      if (!signalsById.has(doc.id)) continue;
      try { checkRules(doc.id, r); apply(doc.id, r); n++; } catch (err) { console.warn(`[TurnRules] ${doc.id} skipped:`, (err as Error).message); }
    }
    if (n) console.log(`[TurnRules] ${n} junctions with turn rules`);
    return n;
  } catch (err) {
    console.warn('[TurnRules] could not load rules:', (err as Error).message);
    return 0;
  }
}

export interface TurnsView {
  junctionId: string;
  approaches: {
    edgeId: string; road: string; from: string; lanes: number;
    moves: { turn: Turn; road: string; heading: string; exitEdgeId: string }[];
    allowed: Turn[]; freeLeft: boolean;
  }[];
  /** Saved phase list, or null for road-based phases */
  phases: PhaseSpec[] | null;
  /** The road-based phases running when no turn phases are set (group, green s) */
  defaultGreens: { group: string; green: number }[];
  by?: string;
  at?: number;
  warnings: string[];
}

/** Everything the police console needs to edit a junction's turns and phases. */
export function turnsView(junctionId: string): TurnsView | null {
  const s = signalsById.get(junctionId);
  if (!s || !indexRef) return null;
  const idx = indexRef;
  const rules = rulesById.get(junctionId);
  const approaches = s.approaches.filter(a => movesByApproach.has(a.edgeId)).map(a => {
    const e = idx.edges.get(a.edgeId);
    const r = rules?.approaches.find(x => x.edgeId === a.edgeId);
    // One entry per turn (the nearest exit road names it)
    const byTurn = new Map<Turn, Movement>();
    for (const m of movesByApproach.get(a.edgeId) ?? []) {
      const had = byTurn.get(m.turn);
      if (!had || m.path.length < had.path.length) byTurn.set(m.turn, m);
    }
    return {
      edgeId: a.edgeId, road: e?.name || 'Unnamed road',
      from: compassWord(((e ? bearingOf(e, true) : 0) + 180) % 360), lanes: e?.lanes ?? 1,
      moves: TURNS.filter(t => byTurn.has(t)).map(t => { const m = byTurn.get(t)!; return { turn: t, road: m.road, heading: compassWord(m.heading), exitEdgeId: m.exitEdgeId }; }),
      allowed: r?.allowed ?? TURNS.filter(t => byTurn.has(t)), freeLeft: r?.freeLeft ?? false,
    };
  });
  const def = defaults.get(junctionId)?.phases ?? [];
  return {
    junctionId, approaches, phases: rules?.phases ?? null,
    defaultGreens: def.filter(p => p.color === 'GREEN').map(p => ({ group: p.group, green: p.duration })),
    by: rules?.by, at: rules?.at,
    warnings: unenforceableMoves(junctionId).map(m => `cannot close ${m} without closing an allowed turn`),
  };
}
