/**
 * City-wide traffic simulation for Bangalore.
 *
 * - Vehicle mix as seen on Bangalore roads: mostly two-wheelers, then cars, autos,
 *   BMTC buses and goods vehicles, each with its own length, pickup and road space (PCU).
 * - Left-hand traffic: vehicles keep to lanes on the left of the road centre line.
 * - Car following per lane with smooth acceleration and braking; vehicles queue at red
 *   lights, behind each other and across junctions into the next road.
 * - Demand follows the time of day (or an operator's setting) and concentrates on
 *   arterials. Each simulated vehicle stands for several real ones when computing
 *   congestion, so the busy corridors and known choke points slow down like the real city.
 */
import type { RoadGraph, RoadEdge, TrafficSignal, Vehicle, TrafficStats } from './types.js';
import {
  getGraphIndex, congestionFactor, edgeCapacity, activeRouteEdgeIds, recordObservedSpeed, type GraphIndex,
} from './pathfindingService.js';
import { signalControl, approachState } from './signalTiming.js';
import { movesFrom, allowedTurns, isFreeLeft, isTurnBanned, movementAlong, movementLight, movementOpen, type Turn } from './turnRules.js';
import { createHmac, randomBytes } from 'node:crypto';
import { getWeather, getDemand, getBehaviour, type Behaviour } from './conditionsService.js';
import { jamSpeedFactor } from './jamService.js';
import { isEdgeBlocked, edgeSpeedFactor } from './reportsService.js';

export interface SimState {
  vehicles: Map<string, Vehicle>;
  signals: Map<string, TrafficSignal>;
  graph: RoadGraph;
  running: boolean;
  simTime: number;
  lastUpdate: number;
}

export interface GpsMatch {
  /** Snapped onto the route within GPS_MATCH_METRES */
  onRoute: boolean;
  arrived: boolean;
  /** Metres from the nearest point on the upcoming route */
  offset: number;
  /** Route edge the fix was matched to (null when off-route) */
  edgeId: string | null;
  /** km/h, from the phone or derived from successive fixes */
  speedKmh: number;
}

export interface NavigationProgress {
  /** Index into the route's edgeIds of the edge being driven */
  edgeIndex: number;
  /** Metres driven along that edge */
  edgeProgress: number;
  vehicle: Vehicle;
}

/** [west, south, east, north] */
export type BBox = [number, number, number, number];

/** What a controller (or the coordination engine) has done to a signal. */
export interface SignalControlState {
  /** Hold this group's green from `from` until `until` (ms timestamps) */
  hold?: { group: string; from: number; until: number; by: string };
  /** Timing plan replacing the default greens, per group (s) */
  plan?: { greens: Record<string, number>; by: string; at: number };
  /** Emergency vehicle approaching: this group green until then (beats holds and scaling) */
  emergency?: { group: string; until: number; corridorId: string };
  /** Temporary green scaling for a group (gating upstream traffic) */
  scale?: { group: string; factor: number; until: number; by: string };
}

/** One vehicle passing through a signalised junction: where it came from and left by. */
export interface MovementEvent {
  signalId: string;
  vehicleId: string;
  /** Approach edge it arrived on, and exit edge it left by */
  fromEdge: string;
  toEdge: string;
  vehicleType: string;
  /** 'sim' = simulated (stands for `scale` real vehicles), 'gps' = real app user, 'user' = user on a simulated drive */
  source: 'sim' | 'gps' | 'user';
  scale: number;
  /** Seconds spent stopped or crawling on the approach */
  waitSeconds: number;
  at: number;
}

/** Live numbers for one approach road of a junction. */
export interface ApproachStats {
  /** Stopped vehicles in real-vehicle equivalents */
  queueVehicles: number;
  /** Stopped vehicles as simulated (physical queue: what discharges at the stop line) */
  queueAgents: number;
  /** Metres from the stop line back to the last stopped vehicle */
  queueMetres: number;
  /** Arrivals in real vehicles per hour (smoothed) */
  arrivalsPerHour: number;
}

/** Seconds between arrival-rate updates, and the smoothing weight of each update. */
const RATE_WINDOW_S = 30;
const RATE_ALPHA = 0.3;

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Simulated vehicles on the network at peak hour (scaled by demand). */
const PEAK_VEHICLES = 20000;
/** Each simulated vehicle counts as this many real ones for congestion. */
const DEMAND_SCALE = 6;
/** Share of new simulated vehicles placed on routes real users are driving. */
const CORRIDOR_SHARE = 0.3;
/** Chance a corridor vehicle keeps to a user route at each junction. */
const CORRIDOR_STICKINESS = 0.7;
/** GPS points further than this from the upcoming route count as off-route. */
const GPS_MATCH_METRES = 50;
/** How many upcoming route edges to search when matching GPS. */
const GPS_LOOKAHEAD_EDGES = 12;
/** Within this distance of the destination counts as arrived. */
const ARRIVAL_METRES = 30;
/** Lane width (m) used to place vehicles left of the centre line. */
const LANE_WIDTH = 3.2;
/** Background vehicles leave after this many seconds of driving. */
const LIFETIME = { min: 300, max: 1200 };
/** Background vehicles stuck (not at a red light) this long are removed. */
const STUCK_SECONDS = 240;
/** In a queue behind another vehicle, a vehicle may stand this many times longer (40 min). */
const QUEUE_STUCK_FACTOR = 10;
/** How often per-edge traffic levels are recomputed (s). */
const TRAFFIC_INTERVAL = 2;
/** Physics step: 5 Hz (traffic-simulation.de steps 0.1–0.25 s of simulated time per frame). */
const TICK_MS = 200;
/**
 * Drivers need about a second to notice the vehicle ahead (or the light) and pull away.
 * This is what makes a restart travel back through a queue at ~15–20 km/h, so a 1 km
 * jam takes minutes, not seconds, to start moving at its tail.
 */
function reactionSeconds(k: { T: number }): number {
  return (0.55 + 0.5 * k.T) * (0.75 + Math.random() * 0.5);
}
/**
 * Public id of a real user's vehicle: stable while the server runs, but it doesn't reveal
 * who the driver is (no Firebase uid on the live map). Only the driver's own app learns it,
 * from its signed-in navigation calls.
 */
const VEHICLE_ID_SECRET = randomBytes(16);
export function userVehicleKey(userId: string): string {
  return 'nav_' + createHmac('sha256', VEHICLE_ID_SECRET).update(userId).digest('hex').slice(0, 12);
}
/** Give-way checks start this close to a junction (m). */
const GIVE_WAY_METRES = 30;
/** Drivers giving way stop this far before the junction point (m). */
const GIVE_WAY_SETBACK = 3;
/** Seconds a driver waits to give way before going anyway. */
const YIELD_PATIENCE = 10;
/** Road load can slow drivers to at most 1/this of free-flow speed (the drawn queue does the rest). */
const MAX_LOAD_SLOWDOWN = 2;
/** Stretches shorter than this (junction boxes, stop-line links) aren't slowed by load. */
const JUNCTION_STRETCH_M = 80;
const lane_ = (sv: { lane: number }) => sv.lane;
/** Vehicles moved per slice of a step before yielding to waiting requests. */
const VEHICLES_PER_SLICE = 2500;
/** Seconds over which road load is averaged. */
const LOAD_SMOOTHING_S = 30;

/**
 * Driving behaviour per vehicle type. Car following is the Intelligent Driver Model and
 * lane changing is MOBIL (Treiber & Kesting, see traffic-simulation.de), with parameters
 * for Bangalore: two-wheelers and autos keep short gaps and weave; buses and trucks are
 * slow to pick up and keep left.
 */
export interface VehicleKind {
  type: string; color: string;
  /** Share of vehicles on the road */
  share: number;
  /** Metres */
  length: number;
  /** Passenger car units: road space relative to a car */
  pcu: number;
  /** IDM desired speed relative to the road's free-flow speed */
  speedFactor: number;
  /** IDM time gap T (s) */
  T: number;
  /** IDM minimum gap s0 (m) */
  s0: number;
  /** IDM maximum acceleration a (m/s²) */
  a: number;
  /** IDM comfortable braking b (m/s²) */
  b: number;
  /** MOBIL politeness p (0 = selfish) */
  politeness: number;
  /** MOBIL switching threshold (m/s²) */
  lcThreshold: number;
  /** MOBIL bias towards the left (kerb) lane (m/s²); India keeps left */
  keepLeft: number;
  /** Lowest road rank it spawns on (buses keep to bus routes, trucks to highways) */
  minRank: number;
  /** Share of drivers who jump a red light that has just turned */
  redJump: number;
  /** Chance of taking a short wrong-way stretch against a one-way at a junction */
  wrongWay: number;
  /** Kerbside stop for passengers about every this many metres (buses, autos) */
  stopEvery?: number;
  /** Seconds stopped [min, max] */
  dwell?: [number, number];
  /** Sideways drift within the lane, in lanes (two-wheelers straddle lanes) */
  weave: number;
  /** Top speed of this vehicle type (km/h); a driver never goes faster, whatever the road allows */
  maxKmh: number;
  /** Heavy goods vehicle: kept off city roads in the IST peak hours */
  heavy?: boolean;
}

/** IST hours when heavy goods vehicles stay off city roads (7–11, 16–21). */
function heavyBanned(): boolean {
  const h = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
  return (h >= 7 && h < 11) || (h >= 16 && h < 21);
}

/** Bangalore traffic mix (two-wheelers dominate). */
const KINDS: VehicleKind[] = [
  { type: 'bike', color: '#FFB300', share: 0.44, maxKmh: 60, length: 2, pcu: 0.5, speedFactor: 1.0, T: 0.8, s0: 1, a: 2.0, b: 3.0, politeness: 0, lcThreshold: 0.1, keepLeft: 0, minRank: 0, redJump: 0.12, wrongWay: 0.04, weave: 0.7 },
  { type: 'hatchback', color: '#42A5F5', share: 0.12, maxKmh: 70, length: 3.8, pcu: 1, speedFactor: 0.95, T: 1.2, s0: 2, a: 1.5, b: 2.5, politeness: 0.2, lcThreshold: 0.2, keepLeft: 0.05, minRank: 0, redJump: 0.03, wrongWay: 0.002, weave: 0.1 },
  { type: 'sedan', color: '#1E88E5', share: 0.08, maxKmh: 80, length: 4.5, pcu: 1, speedFactor: 0.95, T: 1.2, s0: 2, a: 1.5, b: 2.5, politeness: 0.2, lcThreshold: 0.2, keepLeft: 0.05, minRank: 0, redJump: 0.03, wrongWay: 0.002, weave: 0.1 },
  { type: 'suv', color: '#26A69A', share: 0.05, maxKmh: 80, length: 4.4, pcu: 1.1, speedFactor: 0.95, T: 1.3, s0: 2, a: 1.4, b: 2.5, politeness: 0.2, lcThreshold: 0.2, keepLeft: 0.05, minRank: 0, redJump: 0.03, wrongWay: 0.002, weave: 0.1 },
  { type: 'xuv', color: '#00897B', share: 0.04, maxKmh: 80, length: 4.9, pcu: 1.3, speedFactor: 0.97, T: 1.3, s0: 2, a: 1.5, b: 2.5, politeness: 0.15, lcThreshold: 0.2, keepLeft: 0.05, minRank: 0, redJump: 0.03, wrongWay: 0.002, weave: 0.1 },
  { type: 'auto', color: '#8BC34A', share: 0.11, maxKmh: 40, length: 2.8, pcu: 0.8, speedFactor: 0.75, T: 1.0, s0: 1.2, a: 1.2, b: 2.5, politeness: 0.1, lcThreshold: 0.15, keepLeft: 0.15, minRank: 0, redJump: 0.08, wrongWay: 0.02, stopEvery: 2500, dwell: [5, 15], weave: 0.3 },
  { type: 'bus', color: '#EF5350', share: 0.05, maxKmh: 50, length: 12, pcu: 3, speedFactor: 0.75, T: 1.6, s0: 2.5, a: 0.8, b: 2.0, politeness: 0.3, lcThreshold: 0.3, keepLeft: 0.3, minRank: 3, redJump: 0.02, wrongWay: 0, stopEvery: 700, dwell: [15, 35], weave: 0.05 },
  { type: 'van', color: '#7E57C2', share: 0.03, maxKmh: 60, length: 5, pcu: 1.4, speedFactor: 0.85, T: 1.3, s0: 2, a: 1.2, b: 2.5, politeness: 0.2, lcThreshold: 0.2, keepLeft: 0.1, minRank: 0, redJump: 0.04, wrongWay: 0.005, weave: 0.1 },
  { type: 'tempo', color: '#5C6BC0', share: 0.02, maxKmh: 60, length: 4.6, pcu: 1.4, speedFactor: 0.8, T: 1.4, s0: 2, a: 1.0, b: 2.3, politeness: 0.2, lcThreshold: 0.25, keepLeft: 0.2, minRank: 0, redJump: 0.04, wrongWay: 0.005, weave: 0.05 },
  { type: 'minitruck', color: '#A1887F', share: 0.02, maxKmh: 50, length: 5.5, pcu: 1.5, speedFactor: 0.75, T: 1.5, s0: 2.2, a: 0.9, b: 2.2, politeness: 0.25, lcThreshold: 0.25, keepLeft: 0.25, minRank: 0, redJump: 0.03, wrongWay: 0.002, weave: 0.05 },
  { type: 'truck', color: '#8D6E63', share: 0.01, maxKmh: 45, length: 8, pcu: 2.5, speedFactor: 0.7, T: 1.8, s0: 2.5, a: 0.7, b: 2.0, politeness: 0.3, lcThreshold: 0.3, keepLeft: 0.3, minRank: 3, redJump: 0.01, wrongWay: 0, weave: 0.05, heavy: true },
  { type: 'lorry', color: '#6D4C41', share: 0.015, maxKmh: 40, length: 10, pcu: 3, speedFactor: 0.65, T: 1.9, s0: 2.5, a: 0.6, b: 1.8, politeness: 0.3, lcThreshold: 0.3, keepLeft: 0.35, minRank: 4, redJump: 0.01, wrongWay: 0, weave: 0.03, heavy: true },
  { type: 'tipper', color: '#F9A825', share: 0.01, maxKmh: 40, length: 8.5, pcu: 3, speedFactor: 0.65, T: 1.8, s0: 2.5, a: 0.6, b: 1.8, politeness: 0.2, lcThreshold: 0.3, keepLeft: 0.35, minRank: 3, redJump: 0.02, wrongWay: 0, weave: 0.03, heavy: true },
  { type: 'trailer', color: '#546E7A', share: 0.005, maxKmh: 35, length: 16, pcu: 4.5, speedFactor: 0.6, T: 2.2, s0: 3, a: 0.45, b: 1.5, politeness: 0.4, lcThreshold: 0.4, keepLeft: 0.4, minRank: 5, redJump: 0, wrongWay: 0, weave: 0.02, heavy: true },
];

/** A trip handed to the spawner: the route, where on it to start, and whether the driver uses the app. */
export interface TripPlan { route: string[]; startIndex: number; progress: number; app: boolean }
/** Gives a trip for a vehicle of this kind (warm: the network is filling up, start mid-route). */
export type TripSource = (kind: VehicleKind, warm: boolean) => TripPlan | null;
/** While fewer vehicles than this share of the target are out, trips start mid-route (fast fill). */
const WARM_SHARE = 0.8;
/** App users wait this long at a block for a reroute before improvising (s). */
const BLOCK_PATIENCE = 20;

/** Ambulance / fire engine / police vehicle (dispatched runs only, never spawned at random). */
export const EMERGENCY_KIND: VehicleKind = { type: 'emergency', color: '#FFFFFF', share: 0, maxKmh: 80, length: 5.5, pcu: 1.5, speedFactor: 1.1, T: 0.9, s0: 1.5, a: 2.2, b: 3.5, politeness: 0, lcThreshold: 0.05, keepLeft: -0.3, minRank: 0, redJump: 0, wrongWay: 0, weave: 0 };
/** How far ahead of an emergency vehicle traffic makes way (m), and the speed share it slows to. */
const MAKE_WAY_METRES = 150;
const MAKE_WAY_SPEED = 0.55;

/**
 * MOBIL safe braking for the new follower (m/s²): strict at full speed, relaxed in slow
 * traffic where squeezing in is normal (as in Treiber's MOBIL with bSafe rising as v → 0).
 */
const B_SAFE = 4;
const B_SAFE_SLOW = 12;
/** Pull (m/s²) towards the lane needed for the next turn, within this many metres of the junction. */
const TURN_LANE_BIAS = 1.5;
const TURN_LANE_METRES = 100;
/** ACC "coolness": how calmly drivers react to cut-ins (Kesting, Treiber & Helbing 2010). */
const COOLNESS = 0.99;
/** White acceleration noise intensity (m²/s³), so vehicles don't move in lockstep. */
const ACC_NOISE = 0.1;
/** Each vehicle reconsiders its lane about this often (s). */
const LANE_CHANGE_INTERVAL = 1;
/** Lanes per second a vehicle drifts sideways when changing lane (for drawing). */
const LATERAL_SPEED = 0.8;

/**
 * Intelligent Driver Model acceleration for gap `s` (m) to a leader driving at `vLead`
 * (s = Infinity for a free road).
 */
function idm(k: VehicleKind, v: number, v0: number, s: number, vLead: number): number {
  const free = 1 - (v / Math.max(0.1, v0)) ** 4;
  if (!Number.isFinite(s)) return k.a * free;
  const sStar = k.s0 + Math.max(0, v * k.T + v * (v - vLead) / (2 * Math.sqrt(k.a * k.b)));
  return Math.max(-9, k.a * (free - (sStar / Math.max(0.1, s)) ** 2));
}

/**
 * ACC model: IDM blended with the constant-acceleration heuristic, so a vehicle that
 * cuts in close ahead (common on Bangalore roads) causes calm, not emergency, braking.
 * Formula from Kesting, Treiber & Helbing, Phil. Trans. R. Soc. A 368 (2010).
 */
function accModel(k: VehicleKind, v: number, v0: number, s: number, vLead: number, aLead: number): number {
  const aIdm = idm(k, v, v0, s, vLead);
  if (!Number.isFinite(s)) return aIdm;
  const aT = Math.min(aLead, k.a);
  const dv = v - vLead;
  const gap = Math.max(0.1, s);
  const aCah = vLead * dv <= -2 * gap * aT
    ? (v * v * aT) / Math.max(0.01, vLead * vLead - 2 * gap * aT)
    : aT - (dv > 0 ? dv * dv : 0) / (2 * gap);
  if (aIdm >= aCah) return aIdm;
  return Math.max(-9, (1 - COOLNESS) * aIdm + COOLNESS * (aCah + k.b * Math.tanh((aIdm - aCah) / k.b)));
}
// Real users' cars look like any sedan to other viewers; the driver's own app highlights theirs
const USER_KIND: VehicleKind = { ...KINDS[2] };

const ROAD_RANK: Record<string, number> = {
  motorway: 5, trunk: 5, primary: 4, secondary: 3, tertiary: 2, link: 1, unclassified: 1, residential: 0, living_street: 0, service: 0,
};
/** Traffic concentrates on arterials: spawn and turn weight per road rank. */
const RANK_WEIGHT = [0.25, 1, 1.5, 3, 5, 6];

interface SimVehicle {
  pub: Vehicle;
  kind: VehicleKind;
  edge: RoadEdge;
  /** Metres along `edge` (front of the vehicle) */
  progress: number;
  /** Lane index, 0 = leftmost (kerb side) */
  lane: number;
  /** Drawn lateral position in lanes; drifts towards `lane` during a lane change */
  latPos: number;
  /** Seconds until the next MOBIL lane-change check */
  lcTimer: number;
  /** Index in its lane list this step (front = 0) */
  idx: number;
  /** Geometry segment last drawn on (search starts here) */
  seg: number;
  /** m/s */
  v: number;
  /** Current IDM acceleration (m/s²) */
  acc: number;
  speedFactor: number;
  /** Next edge after this one (chosen on entry, so queues can see across junctions) */
  next: RoadEdge | null;
  /** Rest of the way through the junction ahead (background vehicles), and the turn made there */
  through?: string[];
  turn?: Turn;
  /** Road the vehicle leaves the junction ahead by (for movement counts) */
  moveExit?: string;
  /** Emergency run (siren on): drives faster, passes reds slowly, others make way */
  emergency?: boolean;
  /** Close to a red light on an emergency run: crawl through */
  crawl?: boolean;
  /** Origin–destination trip (tripService): app users get rerouted around blocks; others keep their route */
  trip?: { app: boolean; startedAt: number; waitedAtBlock: number };
  /** Making way for an emergency vehicle behind, until this tick, and the lane it drives in */
  yieldUntil?: number;
  yieldLane?: number;
  /** Seconds left before a background vehicle leaves */
  ttl: number;
  stuck: number;
  /** Waiting at a red light this tick */
  atRed: boolean;
  /** Navigated vehicles: route edges and current index */
  userId?: string;
  route?: string[];
  routeIndex: number;
  /** Real driver: position comes from GPS updates, not the simulation */
  gps?: { at: number; lat: number; lng: number };
  /** Simulated vehicle that keeps to real users' routes */
  corridor?: boolean;
  /** Jumps reds that have just turned */
  violator: boolean;
  /** Fixed sideways offset within the lane (lanes) */
  weave: number;
  /** Metres driven */
  odo: number;
  /** Odometer reading of the next kerbside stop (buses, autos) */
  nextStopAt: number;
  /** Progress on the current edge where it is stopping at the kerb, and seconds left */
  stopAt: number | null;
  dwellLeft: number;
  /** Seconds the 'ran a red' flag stays on */
  violationTimer: number;
  /** Seconds spent giving way at the current junction (patience runs out after a while) */
  yieldWait: number;
  /** Junction approach being driven (for movement counts), and seconds spent waiting on it */
  approach?: { signalId: string; edgeId: string };
  approachWait: number;
  /** Took a wrong-way stretch already: from then on drives by the rules */
  reformed?: boolean;
  /** Seconds left before a stopped driver reacts to the gap opening ahead */
  reactLeft?: number;
}

export const rankOf = (e: RoadEdge) => ROAD_RANK[e.roadType] ?? 1;

/** Bangalore's centre (Vidhana Soudha / MG Road area). */
const CITY_CENTRE = { lat: 12.9716, lng: 77.5946 };

/**
 * Traffic is densest in the core and inside the Outer Ring Road, thinning towards the
 * outskirts: ×1.8 within 6 km of the centre, falling to ×0.3 beyond 20 km.
 */
function coreWeight(e: RoadEdge): number {
  const mid = e.geometry[Math.floor(e.geometry.length / 2)];
  const dy = (mid.lat - CITY_CENTRE.lat) * 111.32;
  const dx = (mid.lng - CITY_CENTRE.lng) * 111.32 * Math.cos(CITY_CENTRE.lat * Math.PI / 180);
  const km = Math.hypot(dx, dy);
  return km <= 6 ? 1.8 : km >= 20 ? 0.3 : 1.8 - (km - 6) * (1.5 / 14);
}

/** Smallest absolute difference between two bearings (0–180). */
function turnAngle(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360) - 180);
}

class SimulationEngine {
  private state: SimState;
  private index: GraphIndex;
  private sim = new Map<string, SimVehicle>();
  /** Live load per edge in real-vehicle equivalents (PCU × DEMAND_SCALE) */
  private occupancy = new Map<string, number>();
  private edgeGeomCache = new Map<string, number[]>();
  private twoWay = new Set<string>();
  /** Spawn weights: cumulative over edges, and per vehicle kind's minimum rank */
  private spawnEdges: RoadEdge[] = [];
  private spawnCum: number[] = [];
  private majorEdges: RoadEdge[] = [];
  private majorCum: number[] = [];
  private kindCum: number[] = [];
  /** Per-step lookups: vehicles per edge and lane (front first) and the rear-most per edge */
  private lanesByEdge: (SimVehicle[][] | undefined)[] = [];
  private rearmost: (SimVehicle | undefined)[] = [];
  /** Edge indexes filled in the lane tables this step */
  private usedEdges: number[] = [];
  /** Edges arriving at each node (give-way checks) */
  private inByNode = new Map<string, RoadEdge[]>();
  /** Desired speed per edge before the vehicle's own factor, cached for one step */
  private v0Val: Float64Array;
  private v0Tick: Int32Array;
  private occTimer = 0;
  /** Vehicles entering each edge (PCU) since the last rate update, and the smoothed rate (PCU/h) */
  private entryPcu = new Float64Array(0);
  private arrivalRate = new Float64Array(0);
  private rateTimer = 0;
  /** Controller actions and coordination per signal id */
  private control = new Map<string, SignalControlState>();
  /** Default phase durations per signal id, restored on reset */
  private basePhases = new Map<string, number[]>();
  /** Vehicles on an emergency run */
  private emergencyIds = new Set<string>();
  /** Origin–destination trips (tripService) and their counters */
  private tripSource: TripSource | null = null;
  private tripStats = { started: 0, done: 0, seconds: 0, metres: 0, fallback: 0, improvised: 0, rerouted: 0, collided: 0 };
  /** Wrong-way copies of one-way roads: contra id → real edge id, and by start node */
  private contraBase = new Map<string, string>();
  private contraFrom = new Map<string, RoadEdge[]>();
  /** When red lights were jumped (last 5 min) */
  private redJumpTimes: number[] = [];
  /** Weather speed factor, read once per step */
  private weatherSpeed = 1;
  private behaviour: Behaviour = getBehaviour();
  private tick = 0;
  private positionsTick = -1;
  /** 10 m slots spawned into since the last tick (byLane doesn't know them yet) */
  private spawnBuckets = new Set<string>();
  private tickStats = { ms: 0, n: 0, at: Date.now() };
  private traffic = new Map<string, number>();
  private speedEma = new Map<string, number>();
  private trafficTimer = 0;
  private spawnTimer = 0;
  private vehicleCounter = 0;
  private arrivalHandler: ((userId: string) => void) | null = null;
  /** Scenarios: background spawns only inside this box, and a fixed vehicle count */
  private spawnArea: BBox | null = null;
  private targetOverride: number | null = null;
  private movementHandler: ((m: MovementEvent) => void) | null = null;
  /** Stop-line nodes of each junction controller */
  private clusterOf = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(graph: RoadGraph, signals: TrafficSignal[]) {
    this.state = {
      vehicles: new Map(),
      signals: new Map(signals.map(s => [s.id, s])),
      graph,
      running: false,
      simTime: 0,
      lastUpdate: Date.now(),
    };
    this.index = getGraphIndex(graph, signals);

    for (const e of graph.edges) if (this.index.edges.has(`${e.to}-${e.from}`)) this.twoWay.add(e.id);
    graph.edges.forEach((e, i) => { e.ix = i; });
    // Wrong-way stretches: a reversed copy of every one-way road, used only by wrong-way riders
    let cix = graph.edges.length;
    for (const e of graph.edges) {
      if (this.twoWay.has(e.id)) continue;
      const contra: RoadEdge = {
        ...e, id: `${e.id}~wrong`, from: e.to, to: e.from,
        bearing: (e.bearing + 180) % 360, geometry: [...e.geometry].reverse(),
        speedLimit: Math.round(e.speedLimit * 0.6), ix: cix++,
      };
      this.contraBase.set(contra.id, e.id);
      (this.contraFrom.get(contra.from) ?? this.contraFrom.set(contra.from, []).get(contra.from)!).push(contra);
    }
    this.v0Val = new Float64Array(cix);
    this.v0Tick = new Int32Array(cix).fill(-1);
    this.entryPcu = new Float64Array(cix);
    this.arrivalRate = new Float64Array(cix);
    this.lanesByEdge = new Array(cix);
    this.rearmost = new Array(cix);
    for (const s of signals) this.basePhases.set(s.id, s.phases.map(p => p.duration));
    for (const s of signals) this.clusterOf.set(s.id, new Set(s.nodeIds ?? [s.nodeId]));
    for (const e of graph.edges) (this.inByNode.get(e.to) ?? this.inByNode.set(e.to, []).get(e.to)!).push(e);
    let acc = 0, accMajor = 0;
    for (const e of graph.edges) {
      const w = e.length * (RANK_WEIGHT[rankOf(e)] ?? 1) * e.lanes * coreWeight(e);
      acc += w;
      this.spawnEdges.push(e); this.spawnCum.push(acc);
      if (rankOf(e) >= 3) { accMajor += w; this.majorEdges.push(e); this.majorCum.push(accMajor); }
    }
    let k = 0;
    for (const kind of KINDS) { k += kind.share; this.kindCum.push(k); }
  }

  start(): void {
    this.state.running = true;
    this.state.lastUpdate = Date.now();
    // Start with the city already busy instead of filling up over minutes
    const initial = Math.round(this.targetCount() * 0.8);
    for (let i = 0; i < initial; i++) this.spawnRandomVehicle();
    this.runLoop();
  }

  stop(): void {
    this.state.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Called with the userId when a navigated vehicle reaches its destination. */
  setArrivalHandler(handler: (userId: string) => void): void {
    this.arrivalHandler = handler;
  }

  /** Scenarios: limit background spawning to a box and/or fix the background count (null = normal). */
  setSpawnArea(bbox: BBox | null, target: number | null = null): void {
    this.spawnArea = bbox;
    this.targetOverride = target;
  }

  /**
   * Scenarios: adds a vehicle that drives `route` (edge ids), starting `startIndex` edges
   * in at `progress` metres and stopped (v = 0) when `queued`. Returns its id.
   */
  addRoutedVehicle(route: string[], opts: { startIndex?: number; progress?: number; lane?: number; queued?: boolean; kind?: VehicleKind; emergency?: boolean } = {}): string | null {
    const startIndex = opts.startIndex ?? 0;
    const edge = this.index.edges.get(route[startIndex]);
    if (!edge) return null;
    const kind = opts.kind ?? this.pickKind();
    this.vehicleCounter++;
    const lanes = Math.max(1, edge.lanes);
    const lane = Math.min(lanes - 1, opts.lane ?? this.pickLane(edge, kind));
    const sv: SimVehicle = {
      pub: {
        id: `v${this.vehicleCounter}`, lat: 0, lng: 0, speed: 0, bearing: edge.bearing,
        type: kind.type, color: kind.color, isNavigated: false,
      },
      kind, edge, progress: Math.min(edge.length, opts.progress ?? 0), lane, latPos: lane,
      lcTimer: Math.random() * LANE_CHANGE_INTERVAL, idx: -1, seg: 1,
      v: opts.queued ? 0 : this.cruiseSpeed({ edge, kind, speedFactor: kind.speedFactor } as SimVehicle) * 0.6, acc: 0,
      speedFactor: kind.speedFactor * (0.9 + Math.random() * 0.2),
      next: null, ttl: Infinity, stuck: 0, atRed: false,
      route, routeIndex: startIndex,
      violator: Math.random() < kind.redJump, weave: (Math.random() - 0.5) * kind.weave,
      odo: 0, nextStopAt: Infinity, stopAt: null, dwellLeft: 0, violationTimer: 0, approachWait: 0, yieldWait: 0,
      emergency: opts.emergency,
    };
    if (opts.emergency) { sv.pub.emergency = true; this.emergencyIds.add(sv.pub.id); }
    sv.next = this.chooseNext(sv);
    // Already on a junction approach: count it as such for movement counts and waits
    const sigTo = this.index.signalByNode.get(edge.to);
    if (sigTo && !this.clusterOf.get(sigTo.id)?.has(edge.from)) sv.approach = { signalId: sigTo.id, edgeId: edge.id };
    this.placeVehicle(sv);
    this.sim.set(sv.pub.id, sv);
    this.state.vehicles.set(sv.pub.id, sv.pub);
    return sv.pub.id;
  }

  /** Scenarios: the route a vehicle is on, where it is on it, and its speed (null if gone). */
  vehicleRoute(id: string): { route: string[]; routeIndex: number; progress: number; v: number } | null {
    const sv = this.sim.get(id);
    return sv?.route ? { route: sv.route, routeIndex: sv.routeIndex, progress: sv.progress, v: sv.v } : null;
  }

  /** Scenarios: sends a routed vehicle a new route that starts with the edge it is on. */
  rerouteVehicle(id: string, edgeIds: string[]): boolean {
    const sv = this.sim.get(id);
    if (!sv || edgeIds[0] !== sv.edge.id) return false;
    sv.route = edgeIds;
    sv.routeIndex = 0;
    sv.through = undefined;
    if (sv.trip) sv.trip.waitedAtBlock = 0;
    sv.next = this.chooseNext(sv);
    return true;
  }

  /** Called for every vehicle that passes through a signalised junction. */
  setMovementHandler(handler: (m: MovementEvent) => void): void {
    this.movementHandler = handler;
  }

  /**
   * Junction movement counting: entering an approach edge (ending at a junction's stop
   * line) starts a passage; leaving the junction on an exit edge completes it.
   */
  private trackMovement(sv: SimVehicle, next: RoadEdge): void {
    if (this.contraBase.has(next.id)) return; // wrong-way stretches aren't junction movements
    const sigFrom = this.index.signalByNode.get(next.from);
    if (sigFrom && sv.approach?.signalId === sigFrom.id && !this.clusterOf.get(sigFrom.id)?.has(next.to)) {
      this.movementHandler?.({
        signalId: sigFrom.id, vehicleId: sv.pub.id, fromEdge: sv.approach.edgeId, toEdge: sv.moveExit ?? next.id, vehicleType: sv.kind.type,
        source: sv.gps ? 'gps' : sv.userId ? 'user' : 'sim',
        scale: sv.userId ? 1 : DEMAND_SCALE, waitSeconds: Math.round(sv.approachWait), at: Date.now(),
      });
      sv.approach = undefined;
      sv.moveExit = undefined;
    }
    const sigTo = this.index.signalByNode.get(next.to);
    if (sigTo && !this.clusterOf.get(sigTo.id)?.has(next.from)) {
      sv.approach = { signalId: sigTo.id, edgeId: next.id };
      sv.approachWait = 0;
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.state.running) return;
    const now = Date.now();
    const dt = Math.min((now - this.state.lastUpdate) / 1000, 0.4);
    this.state.lastUpdate = now;
    this.state.simTime += dt;

    const t0 = performance.now();
    await this.update(dt);
    this.spawnBuckets.clear();
    this.tickStats.ms += performance.now() - t0; this.tickStats.n++;
    if (now - this.tickStats.at > 60_000) {
      console.log(`[Sim] ${this.sim.size} vehicles, ${(this.tickStats.ms / this.tickStats.n).toFixed(1)} ms per step`);
      this.tickStats = { ms: 0, n: 0, at: now };
    }
    this.timer = setTimeout(() => this.runLoop(), TICK_MS);
  }

  async update(dt: number): Promise<void> {
    this.tick++;
    this.weatherSpeed = getWeather().speedFactor;
    this.behaviour = getBehaviour();
    this.spawnVehicles(dt);
    this.updateSignals(dt);
    this.makeWayForEmergencies();
    // Road load changes slowly (30 s smoothing): once a second is enough
    this.occTimer += dt;
    if (this.occTimer >= 1) {
      this.rebuildOccupancy(this.occTimer);
      this.occTimer = 0;
    }
    // Arrivals per edge, as real vehicles per hour, smoothed over a few minutes
    this.rateTimer += dt;
    if (this.rateTimer >= RATE_WINDOW_S) {
      const k = 3600 / this.rateTimer * DEMAND_SCALE;
      for (let i = 0; i < this.entryPcu.length; i++) {
        this.arrivalRate[i] += RATE_ALPHA * (this.entryPcu[i] * k - this.arrivalRate[i]);
        this.entryPcu[i] = 0;
      }
      this.rateTimer = 0;
    }
    // Vehicles per edge and lane, front-most first; and the rear-most vehicle per edge
    // Reuse the per-edge tables: clear only the edges used last step
    const lanesByEdge = this.lanesByEdge;
    const rearmost = this.rearmost;
    for (const ix of this.usedEdges) { lanesByEdge[ix] = undefined; rearmost[ix] = undefined; }
    const used: number[] = [];
    this.usedEdges = used;
    for (const sv of this.sim.values()) {
      const ix = sv.edge.ix!;
      let lanes = lanesByEdge[ix];
      if (!lanes) { lanes = []; lanesByEdge[ix] = lanes; used.push(ix); }
      (lanes[sv.lane] ??= []).push(sv);
    }
    for (const ix of used) {
      let rear: SimVehicle | undefined;
      for (const list of lanesByEdge[ix]!) {
        if (!list) continue;
        if (list.length > 1) list.sort((a, b) => b.progress - a.progress);
        for (let i = 0; i < list.length; i++) list[i].idx = i;
        const last = list[list.length - 1];
        if (!rear || last.progress < rear.progress) rear = last;
      }
      rearmost[ix] = rear;
    }

    let n = 0;
    for (const [id, sv] of this.sim) {
      // Let waiting requests run between slices: the server shares this thread
      if (++n % VEHICLES_PER_SLICE === 0) await new Promise(r => setImmediate(r));
      if (sv.gps) continue; // real drivers move with their GPS updates
      sv.lcTimer -= dt;
      if (sv.lcTimer <= 0) {
        sv.lcTimer = LANE_CHANGE_INTERVAL * (0.7 + Math.random() * 0.6);
        this.considerLaneChange(sv);
      }
      if (!this.updateVehicle(sv, dt)) this.removeVehicle(id);
    }

    this.trafficTimer += dt;
    if (this.trafficTimer >= TRAFFIC_INTERVAL) {
      this.updateTraffic(this.trafficTimer);
      this.trafficTimer = 0;
    }
  }

  /**
   * Road load in real-vehicle equivalents, smoothed over ~30 s: one simulated vehicle
   * stands for several real ones, so the instant count would flicker as it drives past.
   */
  private rebuildOccupancy(dt: number): void {
    const instant = new Map<string, number>();
    for (const sv of this.sim.values()) {
      const load = sv.userId ? 1 : sv.kind.pcu * DEMAND_SCALE;
      // A wrong-way rider gets in the way of the road's real traffic (counted double)
      const base = this.contraBase.get(sv.edge.id);
      const id = base ?? sv.edge.id;
      instant.set(id, (instant.get(id) ?? 0) + (base ? load * 2 : load));
    }
    const a = Math.min(1, dt / LOAD_SMOOTHING_S);
    for (const [id, prev] of this.occupancy) {
      const next = prev + a * ((instant.get(id) ?? 0) - prev);
      if (next < 0.05 && !instant.has(id)) this.occupancy.delete(id);
      else this.occupancy.set(id, next);
    }
    for (const [id, load] of instant) if (!this.occupancy.has(id)) this.occupancy.set(id, a * load);
  }

  private simulatedCount(): number {
    let n = 0;
    for (const sv of this.sim.values()) if (!sv.userId) n++;
    return n;
  }

  private targetCount(): number {
    return this.targetOverride ?? Math.round(PEAK_VEHICLES * getDemand());
  }

  private spawnVehicles(dt: number): void {
    const target = this.targetCount();
    const simulated = this.simulatedCount();
    if (simulated >= target) return;
    this.spawnTimer += dt;
    if (this.spawnTimer < 0.2) return;
    this.spawnTimer = 0;
    // Refill ~5% of the shortfall per step (at least a few vehicles)
    const count = Math.min(target - simulated, Math.max(4, Math.round((target - simulated) * 0.05)));
    for (let i = 0; i < count; i++) this.spawnRandomVehicle();
  }

  private pickWeighted(edges: RoadEdge[], cum: number[]): RoadEdge | null {
    if (edges.length === 0) return null;
    const r = Math.random() * cum[cum.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
    return edges[lo];
  }

  private pickKind(): VehicleKind {
    const banned = heavyBanned();
    for (let tries = 0; ; tries++) {
      const r = Math.random() * this.kindCum[this.kindCum.length - 1];
      const i = this.kindCum.findIndex(c => r <= c);
      const kind = KINDS[i < 0 ? 0 : i];
      if (!kind.heavy || !banned || tries > 4) return kind;
    }
  }

  /** Busy-road-weighted edge, or (for corridor vehicles) one on a real user's route. */
  private pickSpawnEdge(kind: VehicleKind, corridor: boolean): RoadEdge | null {
    if (this.spawnArea) {
      const [w, s, e, n] = this.spawnArea;
      for (let tries = 0; tries < 30; tries++) {
        const edge = this.pickWeighted(this.spawnEdges, this.spawnCum);
        const p = edge?.geometry[0];
        if (edge && p && p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n && rankOf(edge) >= kind.minRank && !isEdgeBlocked(edge.id)) return edge;
      }
      return null;
    }
    if (corridor) {
      const ids = activeRouteEdgeIds();
      for (let tries = 0; tries < 5 && ids.length > 0; tries++) {
        const e = this.index.edges.get(ids[Math.floor(Math.random() * ids.length)]);
        if (e && !isEdgeBlocked(e.id)) return e;
      }
    }
    for (let tries = 0; tries < 8; tries++) {
      const e = kind.minRank >= 3
        ? this.pickWeighted(this.majorEdges, this.majorCum)
        : this.pickWeighted(this.spawnEdges, this.spawnCum);
      if (e && !isEdgeBlocked(e.id) && rankOf(e) >= kind.minRank) return e;
    }
    return null;
  }

  private spawnRandomVehicle(): void {
    const kind = this.pickKind();
    // Origin–destination trips when the trip service has one (scenarios keep their own area)
    const trip = !this.spawnArea && this.tripSource ? this.tripSource(kind, this.simulatedCount() < this.targetCount() * WARM_SHARE) : null;
    const corridor = !trip && activeRouteEdgeIds().length > 0 && Math.random() < CORRIDOR_SHARE;
    const edge = trip ? this.index.edges.get(trip.route[trip.startIndex]) ?? null : this.pickSpawnEdge(kind, corridor);
    if (!edge) return;
    const lane = this.pickLane(edge, kind);
    let progress = trip ? Math.min(edge.length, trip.progress) : Math.random() * edge.length;

    // Don't drop a vehicle on top of another in the same lane; a trip moves along its first street to a free spot
    const free = (at: number) => !this.spawnBuckets.has(`${edge.id}#${lane}#${Math.floor(at / 10)}`)
      && !(this.lanesByEdge[edge.ix!]?.[lane] ?? []).some(other => Math.abs(other.progress - at) < 8);
    if (!free(progress)) {
      let spot = -1;
      if (trip) for (let at = progress + 10; at < edge.length; at += 10) if (free(at)) { spot = at; break; }
      if (spot < 0) { if (trip) this.tripStats.collided++; return; }
      progress = spot;
    }
    this.spawnBuckets.add(`${edge.id}#${lane}#${Math.floor(progress / 10)}`);

    this.vehicleCounter++;
    // Driver temperament (~N(1, 0.15)): aggressive drivers keep shorter gaps, pick up faster, care less
    const aggr = Math.min(1.45, Math.max(0.6, 1 + (Math.random() + Math.random() + Math.random() - 1.5) * 0.3));
    const driver: VehicleKind = {
      ...kind, T: kind.T / aggr, s0: kind.s0 / aggr, a: kind.a * aggr, politeness: kind.politeness / aggr,
    };
    const sv: SimVehicle = {
      pub: {
        id: `v${this.vehicleCounter}`, lat: 0, lng: 0, speed: 0, bearing: edge.bearing,
        type: kind.type, color: kind.color, isNavigated: false,
      },
      kind: driver, edge, progress, lane, latPos: lane,
      lcTimer: Math.random() * LANE_CHANGE_INTERVAL, idx: -1, seg: 1,
      v: 0, acc: 0,
      speedFactor: kind.speedFactor * (0.85 + Math.random() * 0.25) * Math.sqrt(aggr),
      next: null,
      ttl: trip ? Infinity : LIFETIME.min + Math.random() * (LIFETIME.max - LIFETIME.min),
      stuck: 0, atRed: false,
      route: trip?.route,
      routeIndex: trip?.startIndex ?? 0,
      trip: trip ? { app: trip.app, startedAt: this.state.simTime, waitedAtBlock: 0 } : undefined,
      corridor,
      violator: Math.random() < kind.redJump * aggr,
      weave: (Math.random() - 0.5) * kind.weave,
      odo: 0,
      nextStopAt: kind.stopEvery ? Math.random() * kind.stopEvery : Infinity,
      stopAt: null, dwellLeft: 0, violationTimer: 0, approachWait: 0, yieldWait: 0,
    };
    sv.v = this.cruiseSpeed(sv) * (0.4 + Math.random() * 0.4);
    sv.next = this.chooseNext(sv);
    this.placeVehicle(sv);
    this.sim.set(sv.pub.id, sv);
    this.state.vehicles.set(sv.pub.id, sv.pub);
    if (trip) this.tripStats.started++; else if (this.tripSource && !this.spawnArea) this.tripStats.fallback++;
  }

  /** Buses and trucks keep left; others spread over the lanes, two-wheelers anywhere. */
  private pickLane(edge: RoadEdge, kind: VehicleKind): number {
    const lanes = Math.max(1, edge.lanes);
    if (lanes === 1) return 0;
    if (kind.type === 'bus' || kind.heavy || kind.type === 'minitruck' || kind.type === 'tempo') return 0;
    if (kind.type === 'auto') return Math.random() < 0.6 ? 0 : 1;
    return Math.floor(Math.random() * lanes);
  }

  private removeVehicle(id: string): void {
    this.sim.delete(id);
    this.state.vehicles.delete(id);
  }

  /**
   * IDM desired speed v0 (m/s) on the current edge. Each simulated vehicle stands for
   * DEMAND_SCALE real ones, so the unseen traffic slows it through the road's load.
   */
  private cruiseSpeed(sv: SimVehicle): number {
    const edge = sv.edge;
    const ix = edge.ix!;
    if (this.v0Tick[ix] !== this.tick) {
      // The road's load slows drivers for the traffic we don't draw, but only so far:
      // the simulated queue itself already holds them back, and leaving a stop line
      // (short junction stretches) they pull away at normal speed.
      const slow = edge.length < JUNCTION_STRETCH_M ? 1
        : Math.min(MAX_LOAD_SLOWDOWN, congestionFactor(edge, this.occupancy.get(edge.id) ?? 0));
      this.v0Val[ix] = (edge.speedLimit / 3.6) * this.weatherSpeed * edgeSpeedFactor(edge.id) * jamSpeedFactor(edge.id) / slow;
      this.v0Tick[ix] = this.tick;
    }
    // Road speed for this driver, capped at what the vehicle itself can (or may) do
    let v = Math.min(this.v0Val[ix] * sv.speedFactor, (sv.kind.maxKmh / 3.6) * Math.min(1, sv.speedFactor / 0.9));
    if (sv.emergency) {
      // Siren on: a quarter over the limit where the road allows, slow past a red
      v = Math.max(v, Math.min(edge.speedLimit * 1.25, sv.kind.maxKmh) / 3.6 * this.weatherSpeed * jamSpeedFactor(edge.id));
      if (sv.crawl) v = Math.min(v, 4);
    } else if (sv.yieldUntil !== undefined && sv.yieldUntil >= this.tick && sv.lane !== sv.yieldLane) {
      // Beside the siren's lane: slow down so it passes; in its lane: keep moving and pull over
      v *= MAKE_WAY_SPEED;
    }
    return v;
  }

  /**
   * The vehicle ahead in `lane` of the current edge (or, if none, the last vehicle on the
   * road this one turns into) as a gap and speed; a red light counts as a stopped vehicle
   * at the stop line, like the traffic lights on traffic-simulation.de.
   */
  private leaderIn(sv: SimVehicle, lane: number): { s: number; vLead: number; aLead: number; hardLimit: number } {
    const edge = sv.edge;
    let s = Infinity, vLead = 0, aLead = 0, hardLimit = Infinity;
    const list = this.lanesByEdge[edge.ix!]?.[lane];
    let ahead: SimVehicle | undefined;
    if (list) {
      if (list[sv.idx] === sv) {
        ahead = sv.idx > 0 ? list[sv.idx - 1] : undefined;
      } else {
        const i = this.firstBehind(list, sv.progress);
        ahead = i > 0 ? list[i - 1] : undefined;
      }
    }
    if (ahead && ahead.edge !== edge) {
      // The vehicle ahead has just moved onto the next road this step
      s = edge.length - sv.progress + ahead.progress - ahead.kind.length;
      vLead = ahead.v;
      aLead = ahead.acc;
      hardLimit = edge.length + ahead.progress - ahead.kind.length - 0.5;
    } else if (ahead) {
      s = ahead.progress - ahead.kind.length - sv.progress;
      vLead = ahead.v;
      aLead = ahead.acc;
      hardLimit = ahead.progress - ahead.kind.length - 0.5;
    } else if (sv.next) {
      // The last vehicle in the lane we'll enter on the next road (not every lane)
      const nextLanes = this.lanesByEdge[sv.next.ix!];
      const lane = Math.min(lane_(sv), Math.max(1, sv.next.lanes) - 1);
      const laneList = nextLanes?.[lane];
      const rear = laneList && laneList.length > 0 ? laneList[laneList.length - 1] : (sv.next.lanes <= 1 ? this.rearmost[sv.next.ix!] : undefined);
      if (rear && rear !== sv && rear.edge === sv.next) {
        s = edge.length - sv.progress + rear.progress - rear.kind.length;
        vLead = rear.v;
        aLead = rear.acc;
        hardLimit = edge.length + rear.progress - rear.kind.length - 0.5;
      }
    }
    return { s, vLead, aLead, hardLimit };
  }

  /** Index of the first vehicle in a front-first lane list at or behind the given progress. */
  private firstBehind(list: SimVehicle[], progress: number): number {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].progress > progress) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Gap to the stop line if this vehicle must stop at the end of its edge, else Infinity. */
  private stopLineGap(sv: SimVehicle): number {
    const edge = sv.edge;
    const toLine = edge.length - 1 - sv.progress;
    sv.atRed = false;
    sv.crawl = false;
    // A road block on a trip: app users wait for their reroute a while, other drivers improvise
    if (sv.trip && sv.route && sv.next && isEdgeBlocked(sv.next.id) && (!sv.trip.app || sv.trip.waitedAtBlock > BLOCK_PATIENCE)) {
      this.leaveRoute(sv);
    } else if (sv.trip?.app && sv.next && isEdgeBlocked(sv.next.id) && toLine < 30) {
      sv.trip.waitedAtBlock += 0.2;
    }
    // Navigated vehicles wait before a road block on their route until rerouted; dead ends stop
    if ((sv.route && sv.next && isEdgeBlocked(sv.next.id)) || (!sv.next && !sv.route)) return Math.max(0, toLine);
    const isLastEdge = sv.route !== undefined && sv.routeIndex >= sv.route.length - 1;
    // Wrong-way riders don't stop for lights meant for the other direction
    // A free left turn doesn't wait for the signal: it gives way like at an unsignalled junction
    const freeLeft = sv.turn === 'left' && isFreeLeft(edge.id);
    const control = isLastEdge || freeLeft || this.contraBase.has(edge.id) ? null : signalControl(this.index.signalByNode, edge);
    if (!control) {
      // Unsignalled junction: give way as the road rules say
      // (wait a few metres back, where the roads haven't merged yet, not on the junction point)
      if (!isLastEdge && sv.next && toLine < GIVE_WAY_METRES && this.mustGiveWay(sv, null)) return Math.max(0, toLine - GIVE_WAY_SETBACK);
      sv.yieldWait = 0;
      return Infinity;
    }
    // Turn-based phases light each movement on its own; otherwise the road's group decides
    const state = movementLight(control.signal, edge.id, sv.turn ?? 'straight') ?? approachState(control.signal, control.group);
    // Emergency run: no stop for the light, but crawl over the line on red (traffic has made way)
    if (sv.emergency) { sv.crawl = state !== 'GREEN' && toLine < 30; return Infinity; }
    // Green, turning right: wait for a gap in the oncoming traffic
    if (state === 'GREEN' && sv.next && toLine < GIVE_WAY_METRES && this.mustGiveWay(sv, control.group)) {
      return Math.max(0, toLine);
    }
    // Go through yellow only when too close to stop comfortably
    const canStop = toLine > (sv.v * sv.v) / (2 * sv.kind.b);
    if (state === 'RED' || (state === 'YELLOW' && canStop)) {
      if (toLine < -0.5) return Infinity; // already over the line
      // Red-light jumpers go if the red is only seconds old and they're close and moving
      if (sv.violator && this.behaviour.redJumping && state === 'RED' && toLine < 25 && sv.v > 2) {
        const phase = control.signal.phases[control.signal.currentPhaseIndex];
        if (phase.group === 'ALL' || control.signal.timer < 4) {
          if (sv.violationTimer <= 0) this.redJumpTimes.push(Date.now());
          sv.violationTimer = 6;
          return Infinity;
        }
      }
      sv.atRed = toLine < 80;
      // Two-wheelers creep right up to the junction
      // Two-wheelers creep over the line only when lane discipline is switched off
      return Math.max(0, sv.kind.type === 'bike' && this.behaviour.laneWeaving ? toLine + 0.8 : toLine);
    }
    return Infinity;
  }

  /**
   * A standing queue, bumper to bumper as in a real jam: in every lane, vehicles packed
   * back from the queue head by their own length plus a jam gap (s0), along the road
   * each vehicle came by. `pick` gives each vehicle its route and where the queue head is
   * on it (route index, metres along that edge). Returns the vehicle ids.
   */
  addQueue(pick: () => { route: string[]; endIndex: number; endProgress: number }, metres: number, lanes: number): string[] {
    const ids: string[] = [];
    // Space already taken per edge and lane (another queue may share this road)
    const taken = new Map<string, [number, number][]>();
    const take = (edgeId: string, lane: number, rear: number, front: number) => {
      const key = edgeId + '|' + lane;
      (taken.get(key) ?? taken.set(key, []).get(key)!).push([rear, front]);
    };
    for (const v of this.sim.values()) take(v.edge.id, v.lane, v.progress - v.kind.length, v.progress);
    const blocker = (edgeId: string, lane: number, rear: number, front: number): number | null => {
      let worst: number | null = null;
      for (const [r, f] of taken.get(edgeId + '|' + lane) ?? []) {
        if (r < front + 1 && f > rear - 1) worst = worst === null ? r : Math.min(worst, r);
      }
      return worst;
    };
    for (let lane = 0; lane < Math.max(1, lanes); lane++) {
      let back = 0.5; // queue head → this vehicle's front bumper
      while (back < metres) {
        const kind = this.pickKind();
        const r = pick();
        let k = r.endIndex, pos = r.endProgress - back;
        while (pos < 0 && k > 0) { k--; pos += this.index.edges.get(r.route[k])?.length ?? 0; }
        if (pos < 0) break; // ran out of road
        const e = this.index.edges.get(r.route[k]);
        // Narrower road upstream: this lane doesn't exist there
        if (e && lane < Math.max(1, e.lanes)) {
          // Someone is already standing here: queue up behind them instead
          const b = blocker(e.id, lane, pos - kind.length, pos);
          if (b !== null) { back += Math.max(1, pos - b) + kind.s0; continue; }
          const id = this.addRoutedVehicle(r.route, { startIndex: k, progress: pos, lane, queued: true, kind });
          if (id) { ids.push(id); take(e.id, lane, pos - kind.length, pos); }
        }
        back += kind.length + kind.s0 * (0.8 + Math.random() * 0.4);
      }
    }
    return ids;
  }

  /** Front-most vehicle on an edge (any lane). */
  private frontOf(e: RoadEdge): SimVehicle | undefined {
    let best: SimVehicle | undefined;
    for (const list of this.lanesByEdge[e.ix!] ?? []) {
      const f = list?.[0];
      if (f && f.edge === e && (!best || f.progress > best.progress)) best = f;
    }
    return best;
  }

  /**
   * Road rules at a junction (India drives on the left):
   * - at a green signal, a right turn waits for oncoming traffic of the same green;
   * - without a signal, a smaller road gives way to a bigger one, traffic from the right
   *   has priority on equal roads, and right turns give way to oncoming traffic.
   * After YIELD_PATIENCE seconds of waiting a driver goes anyway, as people do, so
   * junctions never lock up.
   */
  private mustGiveWay(sv: SimVehicle, signalGroup: string | null): boolean {
    const edge = sv.edge, next = sv.next!;
    if (sv.yieldWait > YIELD_PATIENCE) return false;
    const myTurn = ((next.bearing - edge.bearing + 540) % 360) - 180; // + right, − left
    const turningRight = myTurn > 35;
    const myRank = rankOf(edge);
    const myEta = (edge.length - sv.progress) / Math.max(1, sv.v);
    for (const o of this.inByNode.get(edge.to) ?? []) {
      if (o === edge || o.from === next.to || this.contraBase.has(o.id)) continue;
      const f = this.frontOf(o);
      if (!f || f.v < 0.5) continue;
      const theirDist = o.length - f.progress;
      if (theirDist > GIVE_WAY_METRES) continue;
      const rel = ((o.bearing - edge.bearing + 540) % 360) - 180; // their heading relative to mine
      const oncoming = Math.abs(rel) > 135;
      if (signalGroup !== null) {
        // Signal: only oncoming traffic released by the same green matters, and only for right turns
        if (!turningRight || !oncoming) continue;
        const g = signalControl(this.index.signalByNode, o);
        if (!g) continue;
        // Turn-based phases: only oncoming traffic whose own movement is green (a protected right goes freely)
        const theirs = movementLight(g.signal, o.id, f.turn ?? 'straight');
        if (theirs !== null ? theirs !== 'GREEN' : g.group !== signalGroup) continue;
        sv.yieldWait += 0.2;
        return true;
      }
      const oRank = rankOf(o);
      let yieldTo = false;
      if (oRank > myRank) yieldTo = true;                              // bigger road
      else if (oRank === myRank) {
        if (oncoming) yieldTo = turningRight;                          // right turn across oncoming
        else yieldTo = rel < -45 && rel > -135;                        // they come from my right
        if (yieldTo && theirDist / Math.max(1, f.v) > myEta + 4) yieldTo = false; // they're far off
      }
      if (yieldTo) { sv.yieldWait += 0.2; return true; }
    }
    return false;
  }

  /**
   * MOBIL lane change: move one lane left or right when it improves this vehicle's
   * acceleration by more than the threshold (plus politeness × the effect on the
   * followers), without forcing the new follower to brake harder than B_SAFE.
   */
  private considerLaneChange(sv: SimVehicle): void {
    const edge = sv.edge;
    const lanes = Math.max(1, edge.lanes);
    if (lanes < 2) return;
    if (edge.length - sv.progress < 15 || sv.progress < 3) return; // not right at junctions
    const k = sv.kind;
    const v0 = this.cruiseSpeed(sv);
    const stop = this.stopLineGap(sv);
    const accIn = (lane: number) => {
      const { s, vLead, aLead } = this.leaderIn(sv, lane);
      return Math.min(accModel(k, sv.v, v0, s, vLead, aLead), idm(k, sv.v, v0, stop, 0));
    };
    const vrel = Math.min(1, sv.v / Math.max(0.1, v0));
    const bSafe = vrel * B_SAFE + (1 - vrel) * B_SAFE_SLOW;
    // Get into the lane for the next turn: left turns from the kerb lane, right turns from the outer lane
    let turnLane = -1;
    if (sv.next && edge.length - sv.progress < TURN_LANE_METRES) {
      const turn = ((sv.next.bearing - edge.bearing + 540) % 360) - 180;
      if (turn < -35) turnLane = 0;
      else if (turn > 35) turnLane = lanes - 1;
    }
    const accOld = accIn(sv.lane);

    // Follower in the current lane: who gains when we leave
    const followerIn = (lane: number) => {
      const list = this.lanesByEdge[edge.ix!]?.[lane];
      if (!list) return undefined;
      let i = this.firstBehind(list, sv.progress);
      if (list[i] === sv) i++;
      return list[i];
    };
    const oldFollower = followerIn(sv.lane);
    const oldLeader = this.leaderIn(sv, sv.lane);
    let oldFollowerGain = 0;
    if (oldFollower) {
      const fv0 = this.cruiseSpeed(oldFollower);
      const withMe = idm(oldFollower.kind, oldFollower.v, fv0, sv.progress - sv.kind.length - oldFollower.progress, sv.v);
      const without = idm(oldFollower.kind, oldFollower.v, fv0, oldLeader.s + sv.progress - oldFollower.progress, oldLeader.vLead);
      oldFollowerGain = without - withMe;
    }

    let best: { lane: number; gain: number } | null = null;
    for (const target of [sv.lane - 1, sv.lane + 1]) {
      if (target < 0 || target >= lanes) continue;
      const lead = this.leaderIn(sv, target);
      if (lead.s < k.s0) continue; // no room beside the vehicle ahead
      const follower = followerIn(target);
      let newFollowerLoss = 0;
      if (follower) {
        const gapBehind = sv.progress - sv.kind.length - follower.progress;
        if (gapBehind < follower.kind.s0) continue;
        const fv0 = this.cruiseSpeed(follower);
        const after = idm(follower.kind, follower.v, fv0, gapBehind, sv.v);
        if (after < -bSafe) continue; // unsafe for the vehicle behind
        const before = idm(follower.kind, follower.v, fv0, lead.s + sv.progress - follower.progress, lead.vLead);
        newFollowerLoss = before - after;
      }
      const accNew = accIn(target);
      // India keeps left: moving towards lane 0 gets the bias, moving away pays it
      let bias = target < sv.lane ? k.keepLeft : -k.keepLeft;
      if (turnLane >= 0) bias += Math.abs(target - turnLane) < Math.abs(sv.lane - turnLane) ? TURN_LANE_BIAS : -TURN_LANE_BIAS;
      // Making way for a siren: pull towards the kerb; the emergency vehicle takes the outer lane
      if (sv.yieldUntil !== undefined && sv.yieldUntil >= this.tick) bias += target < sv.lane ? 3 : -3;
      if (sv.emergency && turnLane < 0) bias += target > sv.lane ? 1.5 : -1.5;
      const gain = accNew - accOld + k.politeness * (oldFollowerGain - newFollowerLoss) + bias;
      if (gain > k.lcThreshold && (!best || gain > best.gain)) best = { lane: target, gain };
    }
    if (best) sv.lane = best.lane;
  }

  /** Advances one vehicle with the IDM; returns false when it should leave the simulation. */
  private updateVehicle(sv: SimVehicle, dt: number): boolean {
    const k = sv.kind;
    const v0 = this.cruiseSpeed(sv);
    const lead = this.leaderIn(sv, sv.lane);
    const stop = this.stopLineGap(sv);
    // Buses and autos pull over at the kerb (left lane) for passengers
    if (k.stopEvery && sv.stopAt === null && sv.odo >= sv.nextStopAt && sv.lane === 0 &&
        rankOf(sv.edge) >= 2 && sv.edge.length - sv.progress > 40) {
      sv.stopAt = sv.progress + 15;
      sv.dwellLeft = k.dwell![0] + Math.random() * (k.dwell![1] - k.dwell![0]);
    }
    let stopGap = stop;
    if (sv.stopAt !== null) {
      const toStop = sv.stopAt - sv.progress;
      stopGap = Math.min(stopGap, Math.max(0, toStop));
      if (toStop < k.s0 + 1.5 && sv.v < 0.5) { // IDM keeps s0 back from the stop point
        sv.dwellLeft -= dt;
        if (sv.dwellLeft <= 0) {
          sv.stopAt = null;
          sv.nextStopAt = sv.odo + k.stopEvery! * (0.7 + Math.random() * 0.6);
          stopGap = stop;
        }
      }
    }
    sv.violationTimer = Math.max(0, sv.violationTimer - dt);
    sv.pub.violation = sv.violationTimer > 0 || undefined;
    sv.acc = Math.min(accModel(k, sv.v, v0, lead.s, lead.vLead, lead.aLead), idm(k, sv.v, v0, stopGap, 0));
    // Standing still: wait a reaction time after the way opens before pulling away
    if (sv.v < 0.3 && sv.acc > 0) {
      sv.reactLeft ??= reactionSeconds(k);
      sv.reactLeft -= dt;
      if (sv.reactLeft > 0) sv.acc = 0;
    } else {
      sv.reactLeft = undefined;
    }
    if (sv.v > 1 && dt > 0) sv.acc += Math.sqrt(ACC_NOISE / dt) * (Math.random() - 0.5);

    // Ballistic update (no reversing): stop exactly when braking to zero within the step
    let moved: number;
    if (sv.v + sv.acc * dt < 0) {
      moved = sv.acc < 0 ? -(sv.v * sv.v) / (2 * sv.acc) : 0;
      sv.v = 0;
    } else {
      moved = sv.v * dt + 0.5 * sv.acc * dt * dt;
      sv.v += sv.acc * dt;
    }
    // Never drive into the vehicle ahead or over a stop line we must hold
    let limit = lead.hardLimit;
    if (Number.isFinite(stop)) limit = Math.min(limit, sv.edge.length - 1);
    moved = Math.max(0, Math.min(moved, limit - sv.progress));
    if (dt > 0 && moved < sv.v * dt * 0.5) sv.v = Math.min(sv.v, moved / dt);
    sv.progress += moved;
    sv.odo += moved;

    // Drift sideways towards the target lane (drawing only)
    const dl = sv.lane - sv.latPos;
    sv.latPos += Math.sign(dl) * Math.min(Math.abs(dl), LATERAL_SPEED * dt);

    sv.pub.speed = Math.round(sv.v * 3.6 * 10) / 10;
    sv.ttl -= dt;
    // Waiting in a queue behind other vehicles is normal (jams last a long time); only a
    // vehicle standing with open road ahead is stuck (a deadlock), removed after STUCK_SECONDS
    const standing = sv.v < 0.3 && !sv.atRed && sv.stopAt === null;
    sv.stuck = standing ? sv.stuck + (lead.s < 15 ? dt / QUEUE_STUCK_FACTOR : dt) : 0;
    if (sv.approach && sv.v < 1.5) sv.approachWait += dt;

    for (let hops = 0; sv.progress >= sv.edge.length && hops < 5; hops++) {
      const overflow = sv.progress - sv.edge.length;
      const next = this.advanceEdge(sv);
      if (!next) {
        if (sv.userId) this.arrivalHandler?.(sv.userId);
        if (sv.trip) {
          this.tripStats.done++;
          this.tripStats.seconds += this.state.simTime - sv.trip.startedAt;
          this.tripStats.metres += sv.odo;
        }
        return false;
      }
      sv.progress = Math.min(overflow, next.length);
      sv.yieldWait = 0;
      // Join the next road's lane table now, so vehicles moving later this step see it
      // (two vehicles can't take the same spot at a merge)
      let lanesArr = this.lanesByEdge[next.ix!];
      if (!lanesArr) { lanesArr = []; this.lanesByEdge[next.ix!] = lanesArr; this.usedEdges.push(next.ix!); }
      const list = (lanesArr[sv.lane] ??= []);
      list.push(sv);
      sv.idx = list.length - 1;
      const rear = this.rearmost[next.ix!];
      if (!rear || rear.edge !== next || sv.progress < rear.progress) this.rearmost[next.ix!] = sv;
    }

    if (!sv.userId && (sv.ttl <= 0 || sv.stuck > STUCK_SECONDS)) return false;
    return true; // map position is computed when someone asks (refreshPositions)
  }

  /** Moves the vehicle onto its next edge; returns that edge, or null at the end of its trip. */
  private advanceEdge(sv: SimVehicle): RoadEdge | null {
    let next: RoadEdge | null;
    if (sv.route) {
      sv.routeIndex++;
      const id = sv.route[sv.routeIndex];
      next = id ? this.index.edges.get(id) ?? null : null;
    } else {
      next = sv.next;
    }
    if (!next) return null;
    const lanes = Math.max(1, next.lanes);
    sv.lane = sv.lane < lanes ? sv.lane : lanes - 1;
    sv.latPos = Math.min(sv.latPos, lanes - 1);
    sv.seg = 1;
    sv.stopAt = null;
    sv.edge = next;
    if (!sv.userId) this.entryPcu[next.ix!] += sv.kind.pcu;
    this.trackMovement(sv, next);
    const wrong = this.contraBase.has(next.id);
    sv.pub.wrongWay = wrong || undefined;
    if (wrong) { sv.lane = 0; sv.latPos = 0; sv.reformed = true; }
    sv.next = this.chooseNext(sv);
    return next;
  }

  /**
   * Next road at the end of the current edge. Navigated vehicles follow their route;
   * others mostly go straight and prefer bigger roads, rarely turning back.
   */
  private chooseNext(sv: SimVehicle): RoadEdge | null {
    const edge = sv.edge;
    sv.turn = undefined;
    if (sv.route) {
      const id = sv.route[sv.routeIndex + 1];
      // A turn closed after this trip was planned: the driver meets the sign and improvises
      // (app users are rerouted before they get here, see tripService)
      if (id && sv.trip && isTurnBanned(edge.id, id)) {
        sv.route = undefined;
        sv.routeIndex = 0;
        sv.ttl = 120 + Math.random() * 180;
        this.tripStats.improvised++;
        return this.chooseNext(sv);
      }
      // On a signal approach: which movement the route makes (for turn-based phases)
      if (id && movesFrom(edge.id)) {
        const m = movementAlong(edge.id, sv.route.slice(sv.routeIndex + 1, sv.routeIndex + 12));
        sv.turn = m?.turn;
        sv.moveExit = m?.exitEdgeId;
      }
      return id ? this.index.edges.get(id) ?? null : null;
    }
    // Inside a junction: keep to the movement chosen on the approach
    if (sv.through?.length) {
      const nextEdge = this.index.edges.get(sv.through.shift()!);
      if (nextEdge && nextEdge.from === edge.to && !isEdgeBlocked(nextEdge.id)) return nextEdge;
      sv.through = undefined;
    }
    sv.through = undefined;
    // On a signal approach: pick one of the allowed movements through the junction
    const moves = this.contraBase.has(edge.id) ? undefined : movesFrom(edge.id);
    if (moves?.length) {
      const allowed = new Set(allowedTurns(edge.id));
      let pool = moves.filter(m => allowed.has(m.turn) && movementOpen(m) && !m.path.some(id => isEdgeBlocked(id)));
      if (sv.kind.minRank > 0) {
        const big = pool.filter(m => { const x = this.index.edges.get(m.exitEdgeId); return x && rankOf(x) >= sv.kind.minRank - 1; });
        if (big.length > 0) pool = big;
      }
      if (pool.length > 0) {
        const weights = pool.map(m => {
          const x = this.index.edges.get(m.exitEdgeId)!;
          const t = m.turn === 'straight' ? 3 : m.turn === 'uturn' ? 0.2 : 1;
          return t * (RANK_WEIGHT[rankOf(x)] ?? 1);
        });
        let r = Math.random() * weights.reduce((s, w) => s + w, 0);
        let pick = pool[pool.length - 1];
        for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) { pick = pool[i]; break; } }
        const first = this.index.edges.get(pick.path[0]);
        if (first) {
          sv.through = pick.path.slice(1);
          sv.turn = pick.turn;
          sv.moveExit = pick.exitEdgeId;
          return first;
        }
      }
    }
    // Now and then a rider takes a short stretch the wrong way down a one-way
    if (this.behaviour.wrongWay && !sv.reformed && sv.kind.wrongWay > 0 && !this.contraBase.has(edge.id) && Math.random() < sv.kind.wrongWay) {
      const shortcuts = (this.contraFrom.get(edge.to) ?? []).filter(c => c.to !== edge.from && c.length < 400);
      if (shortcuts.length > 0) return shortcuts[Math.floor(Math.random() * shortcuts.length)];
    }
    const options = (this.index.outEdges.get(edge.to) ?? []).filter(e => !isEdgeBlocked(e.id) && !isTurnBanned(edge.id, e.id));
    const forward = options.filter(e => e.to !== edge.from);
    let pool = forward.length > 0 ? forward : options;
    if (pool.length === 0) return null;
    if (sv.corridor && Math.random() < CORRIDOR_STICKINESS) {
      const onRoutes = new Set(activeRouteEdgeIds());
      const corridor = pool.filter(e => onRoutes.has(e.id));
      if (corridor.length > 0) pool = corridor;
    }
    if (sv.kind.minRank > 0) {
      const allowed = pool.filter(e => rankOf(e) >= sv.kind.minRank - 1);
      if (allowed.length > 0) pool = allowed;
    }
    const weights = pool.map(e => {
      const angle = turnAngle(edge.bearing, e.bearing);
      const straight = angle < 30 ? 3 : angle < 60 ? 2 : angle < 135 ? 1 : 0.2;
      return straight * (RANK_WEIGHT[rankOf(e)] ?? 1);
    });
    let r = Math.random() * weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  /** Cumulative metres along the edge geometry, for interpolation. */
  private cumulative(edge: RoadEdge): number[] {
    let cum = this.edgeGeomCache.get(edge.id);
    if (!cum) {
      cum = [0];
      const g = edge.geometry;
      for (let i = 1; i < g.length; i++) {
        const dLat = (g[i].lat - g[i - 1].lat) * 111320;
        const dLng = (g[i].lng - g[i - 1].lng) * 111320 * Math.cos(g[i].lat * Math.PI / 180);
        cum.push(cum[i - 1] + Math.hypot(dLat, dLng));
      }
      this.edgeGeomCache.set(edge.id, cum);
    }
    return cum;
  }

  /**
   * Puts the vehicle on the map: along the road's shape, shifted into its lane on the
   * left of the centre line (Indian left-hand traffic).
   */
  private placeVehicle(sv: SimVehicle): void {
    const g = sv.edge.geometry;
    if (!g || g.length < 2) {
      const n = this.index.nodes.get(sv.edge.to);
      if (n) { sv.pub.lat = n.lat; sv.pub.lng = n.lng; }
      sv.pub.bearing = sv.edge.bearing;
      return;
    }
    const cum = this.cumulative(sv.edge);
    const total = cum[cum.length - 1] || 1;
    const d = Math.min(1, Math.max(0, sv.progress / (sv.edge.length || 1))) * total;
    let i = sv.seg >= 1 && sv.seg < cum.length && cum[sv.seg - 1] <= d ? sv.seg : 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    sv.seg = i;
    const segLen = cum[i] - cum[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (d - cum[i - 1]) / segLen));
    const a = g[i - 1], b = g[i];
    const lat = a.lat + (b.lat - a.lat) * t;
    const lng = a.lng + (b.lng - a.lng) * t;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const east = (b.lng - a.lng) * cosLat, north = b.lat - a.lat;
    const heading = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;

    // Lateral offset to the left of travel: two-way roads use the left half, one-ways centre their lanes
    const lanes = Math.max(1, sv.edge.lanes);
    const lat0 = Math.min(lanes - 0.6, Math.max(-0.4, sv.latPos + (this.behaviour.laneWeaving ? sv.weave : 0)));
    const left = this.twoWay.has(sv.edge.id)
      ? (lanes - 0.5 - lat0) * LANE_WIDTH
      : ((lanes - 1) / 2 - lat0) * LANE_WIDTH;
    const h = heading * Math.PI / 180;
    // Left normal of heading (east, north) = (-cos h, sin h)
    sv.pub.lat = Math.round((lat + (left * Math.sin(h)) / 111320) * 1e6) / 1e6;
    sv.pub.lng = Math.round((lng + (-left * Math.cos(h)) / (111320 * cosLat)) * 1e6) / 1e6;
    sv.pub.bearing = Math.round(heading);
  }

  /**
   * Advances every signal. Controller holds keep a group green (switching to it safely
   * through yellow and all-red first); temporary scaling shortens a group's green.
   */
  private updateSignals(dt: number): void {
    const now = Date.now();
    for (const signal of this.state.signals.values()) {
      const ctl = this.control.get(signal.id);
      if (ctl?.hold && now >= ctl.hold.until) delete ctl.hold;
      if (ctl?.scale && now >= ctl.scale.until) delete ctl.scale;
      if (ctl?.emergency && now >= ctl.emergency.until) delete ctl.emergency;
      // An emergency vehicle's green comes before any controller hold
      const hold = ctl?.emergency ? { group: ctl.emergency.group } : ctl?.hold && now >= ctl.hold.from ? ctl.hold : undefined;

      signal.timer += dt;
      const phase = signal.phases[signal.currentPhaseIndex];
      if (hold) {
        if (phase.color === 'GREEN' && phase.group === hold.group) {
          signal.timer = Math.min(signal.timer, Math.max(0, phase.duration - 0.1)); // stay green
          continue;
        }
        if (phase.color === 'GREEN') { // another group is green: end it now via its yellow
          signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
          signal.timer = 0;
          continue;
        }
      }
      const scaled = ctl?.scale && phase.color === 'GREEN' && phase.group === ctl.scale.group
        ? phase.duration * ctl.scale.factor : phase.duration;
      if (signal.timer >= scaled) {
        signal.timer -= scaled;
        signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
      }
    }
  }

  // ── Signal control (controllers and the coordination engine) ──────────────

  getSignalControl(id: string): SignalControlState | undefined {
    const c = this.control.get(id);
    return c && (c.hold || c.plan || c.scale || c.emergency) ? c : undefined;
  }

  /** Keeps `group` green for `seconds`, starting `delay` seconds from now. */
  holdSignal(id: string, group: string, seconds: number, by: string, delay = 0): boolean {
    const s = this.state.signals.get(id);
    if (!s || !s.phases.some(p => p.group === group && p.color === 'GREEN')) return false;
    const from = Date.now() + delay * 1000;
    const ctl = this.control.get(id) ?? {};
    ctl.hold = { group, from, until: from + seconds * 1000, by };
    this.control.set(id, ctl);
    return true;
  }

  /** Replaces green times per group (other phases unchanged). */
  setSignalPlan(id: string, greens: Record<string, number>, by: string): boolean {
    const s = this.state.signals.get(id);
    const base = this.basePhases.get(id);
    if (!s || !base) return false;
    s.phases.forEach((p, i) => {
      p.duration = p.color === 'GREEN' && greens[p.group] !== undefined
        ? Math.round(Math.min(180, Math.max(10, greens[p.group])))
        : base[i];
    });
    s.cycleLength = s.phases.reduce((t, p) => t + p.duration, 0);
    const ctl = this.control.get(id) ?? {};
    ctl.plan = { greens, by, at: Date.now() };
    this.control.set(id, ctl);
    return true;
  }

  /** Shortens (factor < 1) or lengthens a group's green for `seconds`. */
  scaleSignalGreen(id: string, group: string, factor: number, seconds: number, by: string): boolean {
    if (!this.state.signals.has(id)) return false;
    const ctl = this.control.get(id) ?? {};
    ctl.scale = { group, factor, until: Date.now() + seconds * 1000, by };
    this.control.set(id, ctl);
    return true;
  }

  /** Back to the default timing; ends holds and scaling. */
  /** Trips come from here once set (tripService); null goes back to random spawning. */
  setTripSource(source: TripSource | null): void {
    this.tripSource = source;
  }

  /** A trip driver gives up the route (road blocked): drives on like local traffic for a few minutes. */
  private leaveRoute(sv: SimVehicle): void {
    sv.route = undefined;
    sv.routeIndex = 0;
    sv.ttl = 120 + Math.random() * 180;
    sv.through = undefined;
    sv.next = this.chooseNext(sv);
    this.tripStats.improvised++;
  }

  /** App-using trip drivers now on the road, with where they are on their route (for reroutes). */
  *appTrips(): Generator<{ id: string; route: string[]; routeIndex: number; edgeId: string }> {
    for (const sv of this.sim.values()) {
      if (sv.trip?.app && sv.route) yield { id: sv.pub.id, route: sv.route, routeIndex: sv.routeIndex, edgeId: sv.edge.id };
    }
  }

  /** Trip counters since start: started, arrived (with total time and distance), random fallbacks, improvised. */
  getTripStats(): { started: number; done: number; seconds: number; metres: number; fallback: number; improvised: number; rerouted: number; collided: number; onRoad: number; app: number } {
    let onRoad = 0, app = 0;
    for (const sv of this.sim.values()) if (sv.trip && sv.route) { onRoad++; if (sv.trip.app) app++; }
    return { ...this.tripStats, onRoad, app };
  }

  /** Counts a reroute given to an app-using trip driver. */
  countTripReroute(): void {
    this.tripStats.rerouted++;
  }

  /** Vehicles in front of each emergency vehicle (same road, then the next one) slow and pull to the kerb. */
  private makeWayForEmergencies(): void {
    for (const id of this.emergencyIds) {
      const e = this.sim.get(id);
      if (!e) { this.emergencyIds.delete(id); continue; }
      const until = this.tick + 10;
      const mark = (edge: RoadEdge, from: number, to: number) => {
        for (const list of this.lanesByEdge[edge.ix!] ?? []) {
          for (const v of list ?? []) if (v !== e && v.edge === edge && v.progress > from && v.progress <= to) { v.yieldUntil = until; v.yieldLane = e.lane; }
        }
      };
      mark(e.edge, e.progress, e.progress + MAKE_WAY_METRES);
      const left = MAKE_WAY_METRES - (e.edge.length - e.progress);
      if (left > 0 && e.next) mark(e.next, -1, left);
    }
  }

  /** Where an emergency vehicle is on its route (null once it has gone). */
  emergencyProgress(id: string): { route: string[]; routeIndex: number; progress: number; v: number; lat: number; lng: number } | null {
    const sv = this.sim.get(id);
    if (!sv?.route) return null;
    return { route: sv.route, routeIndex: sv.routeIndex, progress: sv.progress, v: sv.v, lat: sv.pub.lat, lng: sv.pub.lng };
  }

  /** Green for an emergency vehicle at a junction until `until` (ms); overrides holds and plans, not another emergency vehicle's green. */
  setEmergencyGreen(id: string, group: string, until: number, corridorId: string): boolean {
    const s = this.state.signals.get(id);
    if (!s || !s.phases.some(p => p.group === group && p.color === 'GREEN')) return false;
    const ctl = this.control.get(id) ?? {};
    // First come, first served: another emergency vehicle's green for a different direction stays
    // until it has passed (this one asks again every second and gets it then)
    const other = ctl.emergency;
    if (other && other.corridorId !== corridorId && other.group !== group && Date.now() < other.until) return false;
    ctl.emergency = { group, until, corridorId };
    this.control.set(id, ctl);
    return true;
  }

  clearEmergencyGreen(id: string, corridorId: string): void {
    const ctl = this.control.get(id);
    if (ctl?.emergency?.corridorId === corridorId) delete ctl.emergency;
  }

  /** Ends an emergency run: the vehicle drives on as normal traffic. */
  endEmergency(vehicleId: string): void {
    const sv = this.sim.get(vehicleId);
    if (sv) { sv.emergency = false; sv.pub.emergency = undefined; }
    this.emergencyIds.delete(vehicleId);
  }

  /** Turn rules replaced a junction's phases: new defaults, earlier controller changes dropped. */
  phasesReplaced(id: string): void {
    const s = this.state.signals.get(id);
    if (!s) return;
    this.basePhases.set(id, s.phases.map(p => p.duration));
    this.control.delete(id);
  }

  resetSignal(id: string): boolean {
    const s = this.state.signals.get(id);
    const base = this.basePhases.get(id);
    if (!s || !base) return false;
    s.phases.forEach((p, i) => { p.duration = base[i]; });
    s.cycleLength = s.phases.reduce((t, p) => t + p.duration, 0);
    this.control.delete(id);
    return true;
  }

  /** Queue and arrival rate on each approach edge. */
  getApproachStats(edgeIds: string[]): Map<string, ApproachStats> {
    const result = new Map<string, ApproachStats>();
    for (const id of edgeIds) {
      const edge = this.index.edges.get(id);
      if (!edge || edge.ix === undefined) continue;
      let queuePcu = 0, agents = 0, back = edge.length;
      for (const list of this.lanesByEdge[edge.ix] ?? []) {
        if (!list) continue;
        // Front-first: count the stopped vehicles from the stop line backwards
        for (const sv of list) {
          if (sv.v > 1.5) break;
          queuePcu += sv.kind.pcu;
          agents++;
          back = Math.min(back, sv.progress - sv.kind.length);
        }
      }
      result.set(id, {
        queueVehicles: Math.round(queuePcu * DEMAND_SCALE),
        queueAgents: agents,
        queueMetres: Math.round(Math.max(0, edge.length - back)),
        arrivalsPerHour: Math.round(this.arrivalRate[edge.ix]),
      });
    }
    return result;
  }

  /**
   * Traffic level per edge (0 free … 3 jammed) from load vs capacity and from the
   * smoothed speed of vehicles not simply waiting at a red light.
   */
  private updateTraffic(elapsed: number): void {
    const sums = new Map<string, { total: number; n: number }>();
    for (const sv of this.sim.values()) {
      if (sv.atRed) continue;
      const s = sums.get(sv.edge.id) ?? { total: 0, n: 0 };
      s.total += sv.v * 3.6; s.n++;
      sums.set(sv.edge.id, s);
    }
    const alpha = Math.min(1, elapsed / 10);
    for (const [id, s] of sums) {
      const prev = this.speedEma.get(id);
      const now = s.total / s.n;
      this.speedEma.set(id, prev === undefined ? now : prev + alpha * (now - prev));
    }
    // Edges nobody drove on recently drift back to free flow
    for (const id of this.speedEma.keys()) if (!sums.has(id) && !this.occupancy.has(id)) this.speedEma.delete(id);

    this.traffic.clear();
    for (const [id, load] of this.occupancy) {
      const edge = this.index.edges.get(id);
      if (!edge || edge.length < 20) continue; // junction internals: too short to colour
      const cf = congestionFactor(edge, load);
      let level = cf < 1.4 ? 0 : cf < 2.2 ? 1 : cf < 3.5 ? 2 : 3;
      const ema = this.speedEma.get(id);
      if (ema !== undefined) {
        const ratio = ema / edge.speedLimit;
        level = Math.max(level, ratio > 0.55 ? 0 : ratio > 0.35 ? 1 : ratio > 0.18 ? 2 : 3);
      }
      this.traffic.set(id, level);
    }
  }


  // ── Public API ─────────────────────────────────────────────────────────────

  /** Puts the user's vehicle at the start of `route` (edge IDs), replacing any previous one. */
  addUserVehicle(userId: string, route: string[], gps = false, emergency = false): Vehicle | null {
    const first = route.length > 0 ? this.index.edges.get(route[0]) : undefined;
    if (!first) return null;
    this.removeUserVehicle(userId);

    const sv: SimVehicle = {
      pub: {
        id: userVehicleKey(userId), lat: 0, lng: 0, speed: 0, bearing: first.bearing,
        type: 'sedan', color: USER_KIND.color, isNavigated: false,
      },
      kind: USER_KIND,
      edge: first, progress: 0, lane: 0, latPos: 0, lcTimer: 1, idx: -1, seg: 1, v: 0, acc: 0,
      speedFactor: 0.9,
      next: null,
      ttl: Infinity, stuck: 0, atRed: false,
      userId,
      route,
      routeIndex: 0,
      violator: false, weave: 0, odo: 0, nextStopAt: Infinity, stopAt: null, dwellLeft: 0, violationTimer: 0, approachWait: 0, yieldWait: 0,
    };
    if (emergency) { sv.emergency = true; sv.pub.emergency = true; this.emergencyIds.add(sv.pub.id); }
    sv.next = this.chooseNext(sv);
    this.placeVehicle(sv);
    if (gps) sv.gps = { at: Date.now(), lat: sv.pub.lat, lng: sv.pub.lng };
    this.sim.set(sv.pub.id, sv);
    this.state.vehicles.set(sv.pub.id, sv.pub);
    return sv.pub;
  }

  removeUserVehicle(userId: string): void {
    this.removeVehicle(userVehicleKey(userId));
  }

  /** Map positions of all simulated vehicles, computed at most once per step. */
  private refreshPositions(): void {
    if (this.positionsTick === this.tick) return;
    this.positionsTick = this.tick;
    for (const sv of this.sim.values()) if (!sv.gps) this.placeVehicle(sv);
  }

  getUserVehicle(userId: string): Vehicle | undefined {
    this.refreshPositions();
    return this.state.vehicles.get(userVehicleKey(userId));
  }

  getNavigationProgress(userId: string): NavigationProgress | null {
    this.refreshPositions();
    const sv = this.sim.get(userVehicleKey(userId));
    if (!sv || !sv.route) return null;
    return { edgeIndex: sv.routeIndex, edgeProgress: sv.progress, vehicle: sv.pub };
  }

  /**
   * Replaces a user's route. `edgeIds[0]` may be the edge they are on (progress is kept)
   * or a fresh start edge (they are placed at its start).
   */
  replaceUserRoute(userId: string, edgeIds: string[]): boolean {
    const sv = this.sim.get(userVehicleKey(userId));
    const first = edgeIds.length > 0 ? this.index.edges.get(edgeIds[0]) : undefined;
    if (!sv || !first) return false;
    if (first.id !== sv.edge.id) {
      sv.edge = first;
      sv.progress = 0;
      sv.lane = 0;
      sv.latPos = 0;
      if (!sv.gps) this.placeVehicle(sv);
    }
    sv.route = edgeIds;
    sv.routeIndex = 0;
    sv.next = this.chooseNext(sv);
    return true;
  }

  /**
   * Moves a real driver's vehicle to their GPS fix, snapped onto the upcoming part of
   * their route. Their measured speed feeds live traffic for everyone's routing.
   */
  updateUserGps(userId: string, lat: number, lng: number, speedKmh?: number): GpsMatch | null {
    const sv = this.sim.get(userVehicleKey(userId));
    if (!sv || !sv.route) return null;
    const now = Date.now();
    const prev = sv.gps;

    let best = { index: -1, along: 0, dist: Infinity, lat, lng };
    const end = Math.min(sv.route.length, sv.routeIndex + GPS_LOOKAHEAD_EDGES);
    for (let i = sv.routeIndex; i < end; i++) {
      const edge = this.index.edges.get(sv.route[i]);
      if (!edge) continue;
      const m = this.project(edge, lat, lng);
      if (m.dist < best.dist) best = { index: i, ...m };
    }

    sv.gps = { at: now, lat, lng };
    const onRoute = best.dist <= GPS_MATCH_METRES;
    // Phones report speed; keep it plausible so one phone can't fake a jam (or a free road)
    let speed = speedKmh === undefined ? undefined : Math.min(150, Math.max(0, speedKmh));
    if (speed === undefined && prev) {
      const secs = (now - prev.at) / 1000;
      if (secs > 0.5) speed = this.metres(prev, { lat, lng }) / secs * 3.6;
    }
    if (speed !== undefined && Number.isFinite(speed)) {
      sv.pub.speed = Math.max(0, speed);
      sv.v = sv.pub.speed / 3.6;
    }

    if (onRoute) {
      const edge = this.index.edges.get(sv.route[best.index])!;
      // Count junction movements for every route edge passed since the last fix
      for (let k = sv.routeIndex + 1; k <= best.index; k++) {
        const passed = this.index.edges.get(sv.route[k]);
        if (passed) this.trackMovement(sv, passed);
      }
      sv.routeIndex = best.index;
      sv.edge = edge;
      sv.progress = best.along;
      sv.next = this.chooseNext(sv);
      sv.pub.lat = best.lat;
      sv.pub.lng = best.lng;
      sv.pub.bearing = edge.bearing;
      if (speed !== undefined && prev && now - prev.at < 30000) recordObservedSpeed(edge.id, sv.pub.speed);
    } else {
      sv.pub.lat = lat;
      sv.pub.lng = lng;
    }

    const last = this.index.edges.get(sv.route[sv.route.length - 1]);
    const destNode = last ? this.index.nodes.get(last.to) : undefined;
    const arrived = !!destNode && this.metres(destNode, { lat, lng }) <= ARRIVAL_METRES;
    if (arrived) {
      this.removeVehicle(sv.pub.id);
      this.arrivalHandler?.(userId);
    }
    return {
      onRoute, arrived, offset: best.dist,
      edgeId: onRoute ? sv.route[best.index] : null,
      speedKmh: sv.pub.speed,
    };
  }

  private metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const dLat = (b.lat - a.lat) * 111320;
    const dLng = (b.lng - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dLat, dLng);
  }

  /** Nearest point on `edge` to (lat, lng): distance, metres along the edge, and the point. */
  private project(edge: RoadEdge, lat: number, lng: number): { dist: number; along: number; lat: number; lng: number } {
    const g = edge.geometry;
    const cum = this.cumulative(edge);
    const total = cum[cum.length - 1] || 1;
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
    let best = { dist: Infinity, along: 0, lat: g[0].lat, lng: g[0].lng };
    for (let i = 1; i < g.length; i++) {
      const ax = (g[i - 1].lng - lng) * kx, ay = (g[i - 1].lat - lat) * ky;
      const bx = (g[i].lng - lng) * kx, by = (g[i].lat - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const dist = Math.hypot(px, py);
      if (dist < best.dist) {
        best = {
          dist,
          along: (cum[i - 1] + t * (cum[i] - cum[i - 1])) / total * edge.length,
          lat: g[i - 1].lat + t * (g[i].lat - g[i - 1].lat),
          lng: g[i - 1].lng + t * (g[i].lng - g[i - 1].lng),
        };
      }
    }
    return best;
  }

  /** Live load per edge ID, in real-vehicle equivalents. */
  getOccupancy(): Map<string, number> {
    return this.occupancy;
  }

  /** Average speed (km/h) of simulated vehicles on each of the given edges. */
  getEdgeSpeeds(edgeIds: Iterable<string>): Map<string, number> {
    const wanted = new Set(edgeIds);
    const sums = new Map<string, { total: number; n: number }>();
    for (const sv of this.sim.values()) {
      if (!wanted.has(sv.edge.id)) continue;
      const s = sums.get(sv.edge.id) ?? { total: 0, n: 0 };
      s.total += sv.pub.speed; s.n++;
      sums.set(sv.edge.id, s);
    }
    return new Map([...sums].map(([id, s]) => [id, s.total / s.n]));
  }

  /** Traffic level per edge (0 free, 1 slow, 2 heavy, 3 jammed) for edges with vehicles. */
  getTraffic(): Map<string, number> {
    return this.traffic;
  }

  getVehicles(): Vehicle[] {
    this.refreshPositions();
    return Array.from(this.state.vehicles.values());
  }

  /** Vehicles inside a box, at most `limit`. */
  getVehiclesIn(bbox: BBox, limit: number): Vehicle[] {
    this.refreshPositions();
    const [w, s, e, n] = bbox;
    const result: Vehicle[] = [];
    for (const v of this.state.vehicles.values()) {
      if (v.lng >= w && v.lng <= e && v.lat >= s && v.lat <= n) {
        result.push(v);
        if (result.length >= limit) break;
      }
    }
    return result;
  }

  getSignals(): TrafficSignal[] {
    return Array.from(this.state.signals.values());
  }

  getStats(): TrafficStats {
    let total = 0, n = 0, simulated = 0, atSignal = 0, queued = 0, wrongWay = 0, kerbStops = 0;
    for (const sv of this.sim.values()) {
      total += sv.pub.speed; n++;
      if (!sv.userId) simulated++;
      if (sv.atRed) atSignal++;
      else if (sv.stopAt !== null) kerbStops++;
      else if (sv.v < 0.5) queued++;
      if (sv.pub.wrongWay) wrongWay++;
    }
    const cutoff = Date.now() - 5 * 60 * 1000;
    while (this.redJumpTimes.length > 0 && this.redJumpTimes[0] < cutoff) this.redJumpTimes.shift();
    const avgSpeed = n > 0 ? total / n : 0;
    let hotspots = 0, maxCongestion = 0;
    for (const [edgeId, load] of this.occupancy) {
      const edge = this.index.edges.get(edgeId);
      if (!edge) continue;
      const level = Math.min(1, load / edgeCapacity(edge));
      maxCongestion = Math.max(maxCongestion, level);
    }
    for (const level of this.traffic.values()) if (level >= 3) hotspots++;

    return {
      totalVehicles: n,
      avgSpeed,
      avgDelay: 0,
      congestionHotspots: hotspots,
      greenWaveActive: false,
      signalCoordinationScore: 0,
      throughput: 0,
      maxCongestion,
      slaSpeed: avgSpeed,
      slaCompliant: avgSpeed >= 24,
      emergencySlaSpeed: 0,
      activeCorridors: 0,
      simulatedVehicles: simulated,
      realVehicles: n - simulated,
      atSignal, queued, wrongWay, kerbStops, redJumps: this.redJumpTimes.length,
    };
  }
}

export type { SimulationEngine };

let globalEngine: SimulationEngine | null = null;

export function initSimulationEngine(graph: RoadGraph, signals: TrafficSignal[]): SimulationEngine {
  if (globalEngine) {
    globalEngine.stop();
  }
  globalEngine = new SimulationEngine(graph, signals);
  return globalEngine;
}

export function getSimulationEngine(): SimulationEngine | null {
  return globalEngine;
}
