/**
 * Junction movement counts for traffic studies and urban planning: how many vehicles
 * (and roughly how many people) go from which approach to which exit at every
 * signalised junction, by vehicle type, in 15-minute bins — a turning movement count.
 *
 * Counts from real app users (GPS) and from the simulation are kept apart: only the
 * real ones measure the city; simulated ones show what the model expects. No user
 * identities are stored — only aggregate counts.
 *
 * Storage: the last 24 hours in memory (for the police view and CSV export); every
 * finished bin is also written to Firestore (`junctionCounts`) when it's configured.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MovementEvent } from './simulationEngine.js';
import { describeMovement, type MovementLabel } from './junctionService.js';
import { getDb } from './firebaseClient.js';

const BIN_MS = 15 * 60 * 1000;
const KEEP_BINS = 96; // 24 h
/** Optional: also append finished bins as JSON lines to this folder (local analysis) */
const COUNTS_DIR = process.env.COUNTS_DIR;

/** Average people per vehicle on Bangalore roads (rough planning figures). */
const OCCUPANCY: Record<string, number> = {
  bike: 1.3, hatchback: 1.8, sedan: 1.8, suv: 2.2, auto: 1.8, bus: 35, truck: 1.5, van: 2, emergency: 2,
};

type Source = MovementEvent['source'];

interface Cell {
  /** Vehicles counted, by type and source (simulated ones are not yet scaled) */
  counted: Record<string, number>;
  /** Estimated real vehicles and people (simulated × scale + real users) */
  vehicles: number;
  persons: number;
  real: number;
  waitSum: number;
  n: number;
}

interface Bin {
  start: number;
  /** junction → "fromEdge>toEdge" → cell */
  junctions: Map<string, Map<string, Cell>>;
}

const binStart = (t: number) => Math.floor(t / BIN_MS) * BIN_MS;
let current: Bin = { start: binStart(Date.now()), junctions: new Map() };
const history: Bin[] = [];

const movementListeners = new Set<(m: MovementEvent) => void>();
/** Scenarios listen to junction passages (e.g. to time how fast a queue clears). */
export function onMovement(fn: (m: MovementEvent) => void): () => void {
  movementListeners.add(fn);
  return () => movementListeners.delete(fn);
}

export function recordMovement(m: MovementEvent): void {
  for (const fn of movementListeners) fn(m);
  rollover(m.at);
  let j = current.junctions.get(m.signalId);
  if (!j) { j = new Map(); current.junctions.set(m.signalId, j); }
  const key = `${m.fromEdge}>${m.toEdge}`;
  let c = j.get(key);
  if (!c) { c = { counted: {}, vehicles: 0, persons: 0, real: 0, waitSum: 0, n: 0 }; j.set(key, c); }
  const typeKey = `${m.vehicleType}:${m.source}`;
  c.counted[typeKey] = (c.counted[typeKey] ?? 0) + 1;
  c.vehicles += m.scale;
  c.persons += m.scale * (OCCUPANCY[m.vehicleType] ?? 1.5);
  if (m.source === 'gps') c.real++;
  c.waitSum += m.waitSeconds;
  c.n++;
}

function rollover(now: number): void {
  if (now < current.start + BIN_MS) return;
  const done = current;
  history.push(done);
  while (history.length > KEEP_BINS) history.shift();
  current = { start: binStart(now), junctions: new Map() };
  persist(done).catch(err => console.warn('[Counts] Could not store bin:', (err as Error).message));
}

/** Finished bins rolled over even when no vehicle passes at the boundary. */
export function startCounts(): void {
  setInterval(() => rollover(Date.now()), 30 * 1000).unref();
}

interface MovementRow extends MovementLabel {
  junctionId: string;
  fromEdge: string;
  toEdge: string;
  /** Estimated real vehicles and people in the window, and per hour */
  vehicles: number;
  persons: number;
  vehiclesPerHour: number;
  personsPerHour: number;
  /** Counted from real app users' GPS */
  realVehicles: number;
  /** Vehicles by type (estimated real numbers) */
  byType: Record<string, number>;
  avgWaitSeconds: number;
}

function binRows(bin: Bin, junctionFilter?: string): MovementRow[] {
  const rows: MovementRow[] = [];
  for (const [junctionId, moves] of bin.junctions) {
    if (junctionFilter && junctionId !== junctionFilter) continue;
    for (const [key, c] of moves) {
      const [fromEdge, toEdge] = key.split('>');
      const byType: Record<string, number> = {};
      for (const [tk, n] of Object.entries(c.counted)) {
        const [type, source] = tk.split(':') as [string, Source];
        byType[type] = (byType[type] ?? 0) + (source === 'sim' ? n * (c.vehicles / Math.max(1, c.n)) : n);
      }
      rows.push({
        junctionId, fromEdge, toEdge, ...describeMovement(junctionId, fromEdge, toEdge),
        vehicles: c.vehicles, persons: c.persons, vehiclesPerHour: 0, personsPerHour: 0,
        realVehicles: c.real, byType, avgWaitSeconds: c.n ? c.waitSum / c.n : 0,
      });
    }
  }
  return rows;
}

/** Movements at one junction over the last `hours` (including the bin in progress). */
export function junctionMovements(junctionId: string, hours = 1): { hours: number; rows: MovementRow[] } {
  const since = Date.now() - hours * 3600 * 1000;
  const bins = [...history.filter(b => b.start + BIN_MS > since), current];
  const covered = Math.max(1 / 60, Math.min(hours, (Date.now() - Math.max(since, bins[0].start)) / 3600000));
  const merged = new Map<string, MovementRow>();
  for (const b of bins) {
    for (const r of binRows(b, junctionId)) {
      const key = `${r.fromEdge}>${r.toEdge}`;
      const m = merged.get(key);
      if (!m) { merged.set(key, { ...r, byType: { ...r.byType } }); continue; }
      const n = m.vehicles + r.vehicles;
      m.avgWaitSeconds = n ? (m.avgWaitSeconds * m.vehicles + r.avgWaitSeconds * r.vehicles) / n : 0;
      m.vehicles = n;
      m.persons += r.persons;
      m.realVehicles += r.realVehicles;
      for (const [t, v] of Object.entries(r.byType)) m.byType[t] = (m.byType[t] ?? 0) + v;
    }
  }
  const rows = [...merged.values()].map(r => ({
    ...r,
    vehicles: Math.round(r.vehicles), persons: Math.round(r.persons),
    vehiclesPerHour: Math.round(r.vehicles / covered), personsPerHour: Math.round(r.persons / covered),
    byType: Object.fromEntries(Object.entries(r.byType).map(([t, v]) => [t, Math.round(v)])),
    avgWaitSeconds: Math.round(r.avgWaitSeconds),
  })).sort((a, b) => b.vehicles - a.vehicles);
  return { hours: Math.round(covered * 100) / 100, rows };
}

const CSV_COLUMNS = [
  'bin_start_ist', 'junction_id', 'from_road', 'from_direction', 'to_road', 'to_direction', 'turn',
  'est_vehicles', 'est_persons', 'real_gps_vehicles', 'avg_wait_s',
  'bike', 'auto', 'hatchback', 'sedan', 'suv', 'van', 'bus', 'truck',
];

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function istTime(ms: number): string {
  return new Date(ms + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

/** Every 15-minute bin of the last `hours` as CSV (one row per junction movement). */
export function countsCsv(hours = 24, junctionId?: string): string {
  const since = Date.now() - hours * 3600 * 1000;
  const lines = [CSV_COLUMNS.join(',')];
  for (const b of [...history, current].filter(x => x.start + BIN_MS > since)) {
    for (const r of binRows(b, junctionId)) {
      lines.push([
        istTime(b.start), r.junctionId, r.fromRoad, r.fromDir, r.toRoad, r.toDir, r.turn,
        Math.round(r.vehicles), Math.round(r.persons), r.realVehicles, Math.round(r.avgWaitSeconds),
        ...['bike', 'auto', 'hatchback', 'sedan', 'suv', 'van', 'bus', 'truck'].map(t => Math.round(r.byType[t] ?? 0)),
      ].map(csvCell).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

/** Durable copy of a finished bin: Firestore (one document per junction) and/or JSON lines. */
async function persist(bin: Bin): Promise<void> {
  if (bin.junctions.size === 0) return;
  const docs = [...bin.junctions.keys()].map(junctionId => ({
    junctionId, binStart: bin.start, binMinutes: BIN_MS / 60000,
    movements: binRows(bin, junctionId).map(r => ({
      from: r.fromEdge, to: r.toEdge, fromRoad: r.fromRoad, fromDir: r.fromDir, toRoad: r.toRoad, toDir: r.toDir,
      turn: r.turn, vehicles: Math.round(r.vehicles), persons: Math.round(r.persons),
      realVehicles: r.realVehicles, avgWaitSeconds: Math.round(r.avgWaitSeconds),
      byType: Object.fromEntries(Object.entries(r.byType).map(([t, v]) => [t, Math.round(v)])),
    })),
  }));

  const db = getDb();
  if (db) {
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      for (const d of docs.slice(i, i + 400)) batch.set(db.collection('junctionCounts').doc(`${d.junctionId}_${d.binStart}`), d);
      await batch.commit();
    }
  }
  if (COUNTS_DIR) {
    await mkdir(COUNTS_DIR, { recursive: true });
    const file = join(COUNTS_DIR, `${istTime(bin.start).slice(0, 10)}.ndjson`);
    await appendFile(file, docs.map(d => JSON.stringify(d)).join('\n') + '\n');
  }
}
