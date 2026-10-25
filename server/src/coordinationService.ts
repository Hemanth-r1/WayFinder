/**
 * Coordinated green: what giving one road green for H seconds means for the junctions
 * around it, worked out as traffic flow (all quantities in real vehicles).
 *
 *   Queue on a released approach   N = queue metres × lanes / JAM_M
 *   Discharge capacity             c = SAT × lanes (vehicles/s), first LOST s lost to start-up
 *   Released in H seconds          R(H) = min(N + λH, c · max(0, H − LOST))     λ = arrivals/s
 *   Time to clear the queue        T = LOST + N / (c − λ)                      (c > λ)
 *
 * The released traffic splits over the exits — left, straight, right — by the turning
 * shares counted at the junction (defaults until enough are counted). Each exit leading
 * to a neighbouring signal D within reach gets:
 *
 *   free space at D        F = (link metres − D's queue metres) × lanes / JAM_M
 *   arrival window         t1 = LOST + τ  …  t2 = H + τ         τ = travel time to D's queue
 *   green wave at D        starts at max(0, t1 − T_D) (D first clears its own queue),
 *                          lasts until t2 (bounded)
 *   absorbable at D        F + c_D · (green − LOST)
 *
 * and H is shortened until every exit's share fits what D can absorb. Outward traffic
 * comes first; junctions feeding the released road get a green only if their traffic can
 * still pass before the hold ends; junctions feeding the roads that now wait get their
 * green cut only if those queues would otherwise spill back into them.
 */
import { getSimulationEngine } from './simulationEngine.js';
import { getJunction, junctionLinks, memberNodes, edgeById, recordControl, ControlError, MAX_WAIT_S, type JunctionLink } from './junctionService.js';
import { movesFrom, allowedTurns, rulesOf, type Movement } from './turnRules.js';
import { junctionMovements } from './countsService.js';

/** Saturation flow per lane (vehicles/s): 1800 per hour. */
const SAT = 0.5;
/** Start-up lost time when a light turns green (s). */
const LOST = 2;
/** Road length one queued vehicle takes per lane, Bangalore mix incl. two-wheelers (m). */
const JAM_M = 7;
/** Shortest and longest hold, and longest green wave at a neighbour (s). */
const MIN_HOLD = 10, MAX_HOLD = 180, MAX_WAVE = 90;
/** Most neighbours one action adjusts, and how far (m). */
const MAX_ACTIONS = 6, MAX_REACH_M = 3000;
/** Turning shares before enough vehicles are counted (left-hand traffic: left is easy). */
const DEFAULT_SHARE = { straight: 0.6, left: 0.25, right: 0.15, uturn: 0.02 } as const;
const MIN_COUNTED = 20;
/** Share of a feeding junction's saturation flow sent into one road on a normal cycle (green ≈ 40%, ~75% of it this way) */
const FEED_SHARE = 0.3;

type Turn = 'left' | 'straight' | 'right' | 'uturn';

export interface CoordAction {
  kind: 'wave-out' | 'wave-in' | 'gate';
  junctionId: string;
  name: string;
  lat: number;
  lng: number;
  group: string;
  road: string;
  /** Seconds from now until the change starts */
  startIn: number;
  seconds: number;
  /** Gates: green cut to this share */
  factor?: number;
  /** Vehicles this action serves (moved on, or held back) */
  vehicles: number;
  /** Free road space towards this junction, in vehicles */
  freeVehicles?: number;
  metres: number;
  turns?: Turn[];
  reason: string;
}

export interface CoordinationPlan {
  junctionId: string;
  name: string;
  lat: number;
  lng: number;
  group: string;
  road: string;
  requestedSeconds: number;
  holdSeconds: number;
  /** Why the hold is shorter than asked */
  limits: string[];
  queueVehicles: number;
  clearSeconds: number;
  releasedVehicles: number;
  actions: CoordAction[];
  warnings: string[];
}

const vehiclesIn = (metres: number, lanes: number) => Math.max(0, metres) * Math.max(1, lanes) / JAM_M;

/**
 * Where one approach's released traffic goes: its allowed movements (turn rules), with
 * the turning shares counted per exit road, else defaults by turn. With turn-based phases
 * only the movements the held phase lets go count.
 */
function movementShares(approachEdgeId: string, junctionId: string, phaseTurns?: Set<string>): { m: Movement; share: number }[] {
  const allowed = new Set(allowedTurns(approachEdgeId));
  const moves = (movesFrom(approachEdgeId) ?? []).filter(m => allowed.has(m.turn) && (!phaseTurns || phaseTurns.has(m.turn)));
  if (!moves.length) return [];
  const rows = junctionMovements(junctionId, 1).rows.filter(r => r.fromEdge === approachEdgeId);
  const counted = rows.filter(r => moves.some(m => m.exitEdgeId === r.toEdge)).reduce((t, r) => t + r.vehicles, 0);
  if (counted >= MIN_COUNTED) {
    const out = moves.map(m => ({ m, share: rows.filter(r => r.toEdge === m.exitEdgeId).reduce((t, r) => t + r.vehicles, 0) / counted }));
    if (out.some(x => x.share > 0)) return out.filter(x => x.share > 0);
  }
  const perTurn = new Map<Turn, number>();
  for (const m of moves) perTurn.set(m.turn, (perTurn.get(m.turn) ?? 0) + 1);
  const total = [...perTurn.keys()].reduce((t, k) => t + DEFAULT_SHARE[k], 0) || 1;
  return moves.map(m => ({ m, share: DEFAULT_SHARE[m.turn] / total / perTurn.get(m.turn)! }));
}

/**
 * Downstream links a movement leads to: links whose first steps out of this junction
 * follow the movement's path from the last stop line it passes (several when the road
 * forks before the next signal; nearest link per junction).
 */
function linksForMovement(junctionId: string, m: Movement): JunctionLink[] {
  const members = memberNodes(junctionId);
  let k = 0;
  m.path.forEach((id, i) => { const e = edgeById(id); if (e && members.has(e.from)) k = i; });
  const tail = m.path.slice(k);
  const nearest = new Map<string, JunctionLink>();
  for (const l of junctionLinks(junctionId).downstream) {
    if (!tail.every((id, i) => l.headEdges[i] === id)) continue;
    const n = nearest.get(l.to);
    if (!n || l.metres < n.metres) nearest.set(l.to, l);
  }
  return [...nearest.values()];
}

/** Queue, lanes and arrival rate of one approach at a junction. */
function approachState(junctionId: string, edgeId: string) {
  const a = getJunction(junctionId)?.approaches.find(x => x.edgeId === edgeId);
  if (!a) return null;
  return { lanes: Math.max(1, a.lanes), queueMetres: a.queueMetres, arrivals: a.arrivalsPerHour / 3600, wait: a.waitSeconds, road: a.road };
}

/**
 * The coordinated plan for holding `group` green at junction `id` for about
 * `requested` seconds. Nothing is changed (see applyCoordination).
 */
export function planCoordination(id: string, group: string, requested: number): CoordinationPlan {
  const j = getJunction(id);
  if (!j) throw new ControlError(`Unknown junction ${id}`, 404);
  // Turn-based phases: the movements the held phase lets go, per approach
  const specs = rulesOf(id)?.phases;
  const phaseMoves = specs && /^Pd+$/.test(group) ? specs[Number(group.slice(1)) - 1]?.moves : undefined;
  const turnsOf = (edgeId: string) => phaseMoves ? new Set<string>(phaseMoves.find(m => m.edgeId === edgeId)?.turns ?? []) : undefined;
  const released = phaseMoves ? j.approaches.filter(a => (turnsOf(a.edgeId)?.size ?? 0) > 0) : j.approaches.filter(a => a.group === group);
  if (!released.length) throw new ControlError(`Junction ${id} has no group ${group}`);
  const stopped = j.approaches.filter(a => !released.includes(a));
  const links = junctionLinks(id);
  const req = Math.round(Math.min(MAX_HOLD, Math.max(MIN_HOLD, requested)));

  // Released approaches: queue, discharge capacity, arrivals
  const flows = released.map(a => {
    const lanes = Math.max(1, a.lanes);
    return {
      a, N: vehiclesIn(a.queueMetres, lanes), c: SAT * lanes, lambda: a.arrivalsPerHour / 3600,
      shares: movementShares(a.edgeId, id, turnsOf(a.edgeId)),
    };
  });
  const R = (f: typeof flows[number], H: number) => Math.min(f.N + f.lambda * H, f.c * Math.max(0, H - LOST));
  const queueVehicles = Math.round(flows.reduce((t, f) => t + f.N, 0));
  // Time for the current jam to move away (longest of the released approaches)
  const clear = Math.max(0, ...flows.map(f => f.c > f.lambda ? LOST + f.N / (f.c - f.lambda) : MAX_HOLD));

  // Downstream links reached by the released traffic, with each one's share of it
  interface Out { link: JunctionLink; share: Map<typeof flows[number], number>; turns: Set<Turn>; lanes: number; free: number; queued: number; tau: number; clearD: number; c: number }
  const outs = new Map<string, Out>();
  for (const f of flows) {
    for (const { m, share } of f.shares) {
      const turn = m.turn;
      const reached = linksForMovement(id, m).filter(l => l.metres <= MAX_REACH_M);
      for (const link of reached) {
      let o = outs.get(link.to + '|' + link.approachEdgeId);
      if (!o) {
        const st = approachState(link.to, link.approachEdgeId);
        if (!st) continue;
        const speed = link.metres / Math.max(1, link.seconds);
        const toQueue = Math.max(0, link.metres - st.queueMetres);
        o = {
          link, share: new Map(), turns: new Set(), lanes: st.lanes, queued: vehiclesIn(st.queueMetres, st.lanes),
          free: vehiclesIn(toQueue, st.lanes), tau: toQueue / speed,
          c: SAT * st.lanes, clearD: LOST + vehiclesIn(st.queueMetres, st.lanes) / (SAT * st.lanes),
        };
        outs.set(link.to + '|' + link.approachEdgeId, o);
      }
      o.share.set(f, (o.share.get(f) ?? 0) + share / reached.length);
      o.turns.add(turn);
      }
    }
  }
  const sent = (o: Out, H: number) => [...o.share].reduce((t, [f, s]) => t + R(f, H) * s, 0);
  const wave = (o: Out, H: number) => {
    const t1 = LOST + o.tau, t2 = H + o.tau;
    const start = Math.max(0, t1 - o.clearD);
    return { start, green: Math.min(MAX_WAVE, Math.max(MIN_HOLD, t2 - start + 3)) };
  };
  const absorbable = (o: Out, H: number) => o.free + o.c * Math.max(0, wave(o, H).green - LOST);

  // Hold length: what was asked, no longer than the jam needs, short enough to fit downstream
  const limits: string[] = [];
  let H = req;
  if (H > clear + 10 && clear < MAX_HOLD) {
    H = Math.max(MIN_HOLD, Math.round(clear + 10));
    limits.push(`the queue clears in about ${Math.round(clear)} s — a longer green would only hold the cross roads`);
  }
  let tight: Out | null = null;
  while (H > MIN_HOLD) {
    tight = [...outs.values()].find(o => sent(o, H) > absorbable(o, H)) ?? null;
    if (!tight) break;
    H -= 5;
  }
  H = Math.max(MIN_HOLD, H);
  if (tight) {
    limits.push(`room for only ~${Math.round(absorbable(tight, H))} vehicles towards ${getJunction(tight.link.to)?.name ?? tight.link.to} (${Math.round(tight.free)} fit in the road, the rest leave on its green)`);
  }

  const actions: CoordAction[] = [];
  const nameOf = (jid: string) => getJunction(jid)?.name ?? jid;
  const where = (jid: string) => { const d = getJunction(jid); return { lat: d?.lat ?? 0, lng: d?.lng ?? 0 }; };

  // 1. Outward: green waves where the released traffic goes (left, straight, right)
  for (const o of outs.values()) {
    const v = sent(o, H);
    if (v < 3) continue;
    const w = wave(o, H);
    actions.push({
      kind: 'wave-out', junctionId: o.link.to, name: nameOf(o.link.to), ...where(o.link.to), group: o.link.toGroup,
      road: o.link.road, startIn: Math.round(w.start), seconds: Math.round(w.green), vehicles: Math.round(v),
      freeVehicles: Math.round(o.free), metres: o.link.metres, turns: [...o.turns],
      reason: `~${Math.round(v)} vehicles (${[...o.turns].join('/')}) reach it from ${Math.round(LOST + o.tau)} s; green from ${Math.round(w.start)} s${o.queued >= 1 ? ` so its ${Math.round(o.queued)} queued clear first` : ''}, for ${Math.round(w.green)} s; road holds ~${Math.round(o.free)} more`,
    });
  }

  // 2. Spillback guard: junctions feeding the roads that now wait
  for (const b of stopped) {
    // The nearest feeding junction is the one whose traffic fills the road first
    const up = links.upstream.filter(l => l.approachEdgeId === b.edgeId).sort((x, y) => x.metres - y.metres)[0];
    if (!up || up.metres > MAX_REACH_M) continue;
    const lanes = Math.max(1, b.lanes);
    const free = vehiclesIn(up.metres - b.queueMetres, lanes);
    // What the feeding junction can send while this road waits: measured arrivals, but at
    // least its share of a normal green (a jammed road shows few arrivals; that is the problem)
    // (never more than the road can carry)
    const arriving = Math.min(SAT * lanes, Math.max(b.arrivalsPerHour / 3600, FEED_SHARE * SAT * lanes)) * H;
    if (arriving <= free) continue;
    const factor = Math.min(0.9, Math.max(0.4, free / arriving));
    actions.push({
      kind: 'gate', junctionId: up.from, name: nameOf(up.from), ...where(up.from), group: up.fromGroup, road: up.road,
      startIn: 0, seconds: H, factor: Math.round(factor * 100) / 100, vehicles: Math.round(arriving - free),
      freeVehicles: Math.round(free), metres: up.metres,
      reason: `${b.road || 'the cross road'} waits ${H} s: ~${Math.round(arriving)} arrive but only ${Math.round(free)} fit before ${nameOf(up.from)} — its green cut to ${Math.round(factor * 100)}%`,
    });
  }

  // 3. Inward (only if it still helps): junctions feeding the released road
  for (const f of flows) for (const up of links.upstream) {
    if (up.approachEdgeId !== f.a.edgeId || up.metres > MAX_REACH_M) continue;
    const g = Math.min(60, H - (LOST + up.seconds) - 3);
    if (g < MIN_HOLD) continue;
    actions.push({
      kind: 'wave-in', junctionId: up.from, name: nameOf(up.from), ...where(up.from), group: up.fromGroup, road: up.road,
      startIn: 0, seconds: Math.round(g), vehicles: Math.round(g * SAT * Math.max(1, f.a.lanes) * DEFAULT_SHARE.straight),
      metres: up.metres,
      reason: `traffic from ${nameOf(up.from)} takes ${up.seconds} s and can still pass while ${f.a.road || 'this road'} is green`,
    });
  }

  // Priority: outward, then spillback guards, then inward; one action per junction, nearest within budget
  const rank = { 'wave-out': 0, gate: 1, 'wave-in': 2 } as const;
  const chosen = new Map<string, CoordAction>();
  const clashes: string[] = [];
  for (const a of actions.sort((x, y) => rank[x.kind] - rank[y.kind] || y.vehicles - x.vehicles || x.metres - y.metres)) {
    if (a.junctionId === id) continue;
    const had = chosen.get(a.junctionId);
    if (had) {
      if (had.kind !== 'gate' && a.kind !== 'gate' && had.group === a.group) {
        // The same light serves both platoons: one green window covering both, but only
        // when the windows touch and still fit; otherwise the outward wave keeps its timing
        const start = Math.min(had.startIn, a.startIn);
        const end = Math.max(had.startIn + had.seconds, a.startIn + a.seconds);
        const touch = a.startIn <= had.startIn + had.seconds + 10 && had.startIn <= a.startIn + a.seconds + 10;
        if (touch && end - start <= MAX_WAVE) {
          had.startIn = start;
          had.seconds = end - start;
          had.vehicles += a.vehicles;
          if (!had.reason.includes('also sends')) had.reason += '; the same green also sends traffic towards us';
        }
      } else if (a.kind === 'gate' || had.kind === 'gate') {
        clashes.push(`${a.name}: kept for the ${had.kind === 'gate' ? 'hold-back' : 'green wave'}; ${a.kind === 'gate' ? `${a.road || 'its road'} may back up towards it` : 'inbound traffic not given extra green'}`);
      }
      continue;
    }
    if (chosen.size >= MAX_ACTIONS) continue;
    chosen.set(a.junctionId, { ...a });
  }

  const warnings = [
    ...stopped
      .filter(b => b.waitSeconds + H > MAX_WAIT_S)
      .map(b => `${b.road || 'Cross road'} drivers may wait ~${Math.round((b.waitSeconds + H) / 60)} min — over the ${MAX_WAIT_S / 60} min limit`),
    ...clashes,
  ];

  const totalReleased = flows.reduce((t, f) => t + R(f, H), 0);
  return {
    junctionId: id, name: j.name, lat: j.lat, lng: j.lng, group,
    road: [...new Set(released.map(a => a.road || 'Unnamed road'))].join(' + '),
    requestedSeconds: req, holdSeconds: H, limits,
    queueVehicles, clearSeconds: Math.round(clear), releasedVehicles: Math.round(totalReleased),
    actions: [...chosen.values()], warnings,
  };
}

/** Applies a coordinated hold: the junction itself, then each neighbour's change. */
export function applyCoordination(id: string, group: string, requested: number, by: string): { plan: CoordinationPlan; changes: string[] } {
  const engine = getSimulationEngine();
  if (!engine) throw new ControlError('Simulation not running', 503);
  const plan = planCoordination(id, group, requested);
  if (!engine.holdSignal(id, group, plan.holdSeconds, by)) throw new ControlError(`Junction ${id} has no group ${group}`);
  const changes = [`${plan.name}: ${plan.road} green for ${plan.holdSeconds} s${plan.holdSeconds < plan.requestedSeconds ? ` (asked ${plan.requestedSeconds} s)` : ''} — ~${plan.releasedVehicles} vehicles move`];
  for (const a of plan.actions) {
    const ok = a.kind === 'gate'
      ? engine.scaleSignalGreen(a.junctionId, a.group, a.factor ?? 0.6, a.seconds, `${by} (protecting ${id})`)
      : engine.holdSignal(a.junctionId, a.group, a.seconds, `${by} (${a.kind === 'wave-out' ? 'green wave from' : 'feeding'} ${id})`, a.startIn);
    if (ok) changes.push(`${a.name}: ${a.kind === 'gate' ? `${a.road} green cut to ${Math.round((a.factor ?? 0.6) * 100)}% for ${a.seconds} s` : `${a.road} green in ${a.startIn} s for ${a.seconds} s`} — ${a.reason}`);
  }
  changes.push(...plan.warnings.map(w => `⚠ ${w}`));
  recordControl(by, id, 'coordinated hold', changes.join(' | '));
  return { plan, changes };
}
