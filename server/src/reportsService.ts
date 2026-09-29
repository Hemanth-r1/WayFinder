/**
 * Crowd-sourced road reports: blocks, waterlogging and local heavy rain.
 *
 * A report affects routing a little while unconfirmed and fully once confirmed — by a
 * second person, by a supporter/controller, or by GPS showing drivers stuck near it.
 * It clears when enough people say so, when real drivers pass through at normal speed,
 * or when it expires.
 */
import type { GraphIndex } from './pathfindingService.js';

export type ReportType = 'block' | 'waterlogging' | 'rain';
export type ReportStatus = 'unconfirmed' | 'confirmed';
export type Vote = 'confirm' | 'clear';

interface ReportRecord {
  id: string;
  type: ReportType;
  status: ReportStatus;
  lat: number;
  lng: number;
  radius: number;
  roadName: string;
  edgeIds: string[];
  reportedBy: string;
  confirmedBy: Set<string>;
  clearedBy: Set<string>;
  /** GPS evidence: when each driver was first seen stuck near the report */
  stuckSince: Map<string, number>;
  /** GPS evidence: drivers seen moving normally through it */
  passedBy: Set<string>;
  confirmSource: 'people' | 'operator' | 'gps' | null;
  createdAt: number;
  expiresAt: number;
}

/** What clients see — no voter identities. */
export interface PublicReport {
  id: string;
  type: ReportType;
  status: ReportStatus;
  lat: number;
  lng: number;
  radius: number;
  roadName: string;
  edgeIds: string[];
  confirmations: number;
  clears: number;
  confirmSource: ReportRecord['confirmSource'];
  createdAt: number;
  expiresAt: number;
}

interface TypeRules {
  /** Metres around the point the report covers (blocks cover their road segment) */
  radius: number;
  /** Reports of the same type closer than this merge into one */
  mergeWithin: number;
  unconfirmedTtl: number;
  confirmedTtl: number;
  /** Travel-time multiplier on affected roads */
  unconfirmedTimeFactor: number;
  confirmedTimeFactor: number;
  /** GPS: slower than this near the report counts as stuck (km/h) */
  stuckBelowKmh: number | null;
  /** GPS: faster than this on the affected road counts as passing (km/h) */
  passingAboveKmh: number | null;
}

const MIN = 60 * 1000;
const RULES: Record<ReportType, TypeRules> = {
  block: {
    radius: 0, mergeWithin: 80, unconfirmedTtl: 45 * MIN, confirmedTtl: 120 * MIN,
    unconfirmedTimeFactor: 3, confirmedTimeFactor: Infinity, stuckBelowKmh: 5, passingAboveKmh: 15,
  },
  waterlogging: {
    radius: 150, mergeWithin: 120, unconfirmedTtl: 45 * MIN, confirmedTtl: 90 * MIN,
    unconfirmedTimeFactor: 1.6, confirmedTimeFactor: 3, stuckBelowKmh: 8, passingAboveKmh: 25,
  },
  rain: {
    radius: 1500, mergeWithin: 1000, unconfirmedTtl: 30 * MIN, confirmedTtl: 45 * MIN,
    unconfirmedTimeFactor: 1.1, confirmedTimeFactor: 1.3, stuckBelowKmh: null, passingAboveKmh: null,
  },
};
/** Distinct people (reporter included) needed to confirm, or to clear */
export const PEOPLE_TO_CONFIRM = 2;
export const PEOPLE_TO_CLEAR = 2;
/** Real drivers passing normally needed to clear */
const DRIVERS_TO_CLEAR = 2;
/** A driver stuck this long near a report confirms it */
const STUCK_CONFIRM_MS = 45 * 1000;
/** Stuck drivers count within this distance of a block */
const STUCK_NEAR_BLOCK_M = 150;

const reports = new Map<string, ReportRecord>();
let index: GraphIndex | null = null;
let counter = 0;
/** edgeId -> combined effect, rebuilt whenever reports change */
let effects = new Map<string, { blocked: boolean; timeFactor: number; speedFactor: number }>();

export function initReports(graphIndex: GraphIndex): void {
  index = graphIndex;
  rebuildEffects();
  setInterval(pruneExpired, 30 * 1000).unref();
}

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * 111320;
  const dLng = (b.lng - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

/** Edges whose midpoint lies within `radius` of the point. */
function edgesWithin(lat: number, lng: number, radius: number): string[] {
  if (!index) return [];
  const ids: string[] = [];
  for (const e of index.edgeList) {
    const a = index.nodes.get(e.from), b = index.nodes.get(e.to);
    if (!a || !b) continue;
    if (metres({ lat, lng }, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }) <= radius) ids.push(e.id);
  }
  return ids;
}

function rebuildEffects(): void {
  const next = new Map<string, { blocked: boolean; timeFactor: number; speedFactor: number }>();
  for (const r of reports.values()) {
    const rules = RULES[r.type];
    const factor = r.status === 'confirmed' ? rules.confirmedTimeFactor : rules.unconfirmedTimeFactor;
    for (const id of r.edgeIds) {
      const cur = next.get(id) ?? { blocked: false, timeFactor: 1, speedFactor: 1 };
      if (factor === Infinity) cur.blocked = true;
      else cur.timeFactor = Math.min(10, cur.timeFactor * factor);
      // Simulated traffic slows for weather; it can't know about unconfirmed blocks
      if (r.type !== 'block') cur.speedFactor = Math.min(cur.speedFactor, 1 / factor);
      next.set(id, cur);
    }
  }
  effects = next;
}

function pruneExpired(): void {
  const now = Date.now();
  let changed = false;
  for (const r of reports.values()) {
    if (r.expiresAt <= now) { reports.delete(r.id); changed = true; }
  }
  if (changed) rebuildEffects();
}

function toPublic(r: ReportRecord): PublicReport {
  return {
    id: r.id, type: r.type, status: r.status, lat: r.lat, lng: r.lng, radius: r.radius,
    roadName: r.roadName, edgeIds: r.edgeIds,
    confirmations: r.confirmedBy.size, clears: r.clearedBy.size, confirmSource: r.confirmSource,
    createdAt: r.createdAt, expiresAt: r.expiresAt,
  };
}

function confirm(r: ReportRecord, source: NonNullable<ReportRecord['confirmSource']>): void {
  const wasConfirmed = r.status === 'confirmed';
  r.status = 'confirmed';
  r.confirmSource = wasConfirmed ? r.confirmSource : source;
  r.expiresAt = Math.max(r.expiresAt, Date.now() + RULES[r.type].confirmedTtl);
  rebuildEffects();
}

function remove(id: string): boolean {
  const ok = reports.delete(id);
  if (ok) rebuildEffects();
  return ok;
}

// ── Queries used by routing and the simulation ──────────────────────────────

/** Confirmed road block on this edge. */
export function isEdgeBlocked(edgeId: string): boolean {
  return effects.get(edgeId)?.blocked ?? false;
}

/** Travel-time multiplier from reports (unconfirmed blocks, waterlogging, local rain). */
export function edgeTimeFactor(edgeId: string): number {
  return effects.get(edgeId)?.timeFactor ?? 1;
}

/** Speed multiplier for simulated vehicles (weather reports only). */
export function edgeSpeedFactor(edgeId: string): number {
  return effects.get(edgeId)?.speedFactor ?? 1;
}

/** Reports that touch any of these edges. */
export function reportsOnEdges(edgeIds: string[]): PublicReport[] {
  const set = new Set(edgeIds);
  return [...reports.values()].filter(r => r.edgeIds.some(id => set.has(id))).map(toPublic);
}

export function hasVoted(reportId: string, uid: string): boolean {
  const r = reports.get(reportId);
  return !!r && (r.reportedBy === uid || r.confirmedBy.has(uid) || r.clearedBy.has(uid));
}

export function getReports(): PublicReport[] {
  pruneExpired();
  return [...reports.values()].map(toPublic);
}

// ── People ───────────────────────────────────────────────────────────────────

export interface NewReport {
  type: ReportType;
  lat: number;
  lng: number;
  uid: string;
  trusted: boolean;
  /** For blocks: the road segment (both directions) nearest the point */
  segment?: { edgeIds: string[]; roadName: string; lat: number; lng: number };
  roadName?: string;
}

/**
 * Files a report, or — when one of the same type is already close by — counts it as a
 * confirmation of that one. Returns the report and whether it was merged.
 */
export function createReport(input: NewReport): { report: PublicReport; merged: boolean } {
  pruneExpired();
  const rules = RULES[input.type];
  const at = input.segment ?? { lat: input.lat, lng: input.lng };
  const existing = [...reports.values()].find(r => r.type === input.type && (
    input.type === 'block'
      ? r.edgeIds.some(id => input.segment?.edgeIds.includes(id))
      : metres(r, at) <= rules.mergeWithin));
  if (existing) {
    vote(existing.id, input.uid, 'confirm', input.trusted);
    return { report: toPublic(existing), merged: true };
  }

  const now = Date.now();
  const r: ReportRecord = {
    id: `rpt${++counter}`,
    type: input.type,
    status: 'unconfirmed',
    lat: at.lat, lng: at.lng,
    radius: rules.radius,
    roadName: input.segment?.roadName ?? input.roadName ?? '',
    edgeIds: input.segment?.edgeIds ?? edgesWithin(at.lat, at.lng, rules.radius),
    reportedBy: input.uid,
    confirmedBy: new Set([input.uid]),
    clearedBy: new Set(),
    stuckSince: new Map(),
    passedBy: new Set(),
    confirmSource: null,
    createdAt: now,
    expiresAt: now + rules.unconfirmedTtl,
  };
  reports.set(r.id, r);
  if (input.trusted) confirm(r, 'operator');
  else rebuildEffects();
  return { report: toPublic(r), merged: false };
}

/**
 * Records a person's "still there" / "it's clear". Operators decide on their own.
 * Returns the report, or null once it has been cleared.
 */
export function vote(id: string, uid: string, v: Vote, trusted: boolean): PublicReport | null {
  const r = reports.get(id);
  if (!r) throw new Error('Report not found');

  if (v === 'confirm') {
    r.clearedBy.delete(uid);
    r.confirmedBy.add(uid);
    if (trusted) confirm(r, 'operator');
    else if (r.confirmedBy.size >= PEOPLE_TO_CONFIRM) confirm(r, 'people');
    else r.expiresAt = Math.max(r.expiresAt, Date.now() + RULES[r.type].unconfirmedTtl);
    return toPublic(r);
  }

  r.confirmedBy.delete(uid);
  r.clearedBy.add(uid);
  if (trusted || (r.clearedBy.size >= PEOPLE_TO_CLEAR && r.clearedBy.size >= r.confirmedBy.size)) {
    remove(id);
    return null;
  }
  return toPublic(r);
}

/** Operators, or the reporter while nobody else has confirmed, may withdraw a report. */
export function withdraw(id: string, uid: string, trusted: boolean): boolean {
  const r = reports.get(id);
  if (!r) return false;
  const ownUnconfirmed = r.reportedBy === uid && r.confirmedBy.size <= 1 && r.status === 'unconfirmed';
  if (!trusted && !ownUnconfirmed) throw new Error('Only operators can remove confirmed or shared reports');
  return remove(id);
}

// ── GPS evidence ─────────────────────────────────────────────────────────────

/**
 * A real driver's GPS fix. Drivers stuck near a report confirm it; drivers moving
 * normally through it clear it. Simulated drives must not call this.
 */
export function observeDriver(uid: string, lat: number, lng: number, speedKmh: number, edgeId: string | null): void {
  if (reports.size === 0) return;
  const now = Date.now();
  for (const r of [...reports.values()]) {
    const rules = RULES[r.type];
    const onAffectedRoad = edgeId !== null && r.edgeIds.includes(edgeId);

    if (rules.passingAboveKmh !== null && onAffectedRoad && speedKmh >= rules.passingAboveKmh) {
      r.passedBy.add(uid);
      r.stuckSince.delete(uid);
      if (r.passedBy.size >= DRIVERS_TO_CLEAR) { remove(r.id); continue; }
    }

    if (rules.stuckBelowKmh !== null && r.status === 'unconfirmed') {
      const near = r.type === 'block' ? metres(r, { lat, lng }) <= STUCK_NEAR_BLOCK_M : onAffectedRoad;
      if (near && speedKmh < rules.stuckBelowKmh) {
        const since = r.stuckSince.get(uid) ?? now;
        r.stuckSince.set(uid, since);
        if (now - since >= STUCK_CONFIRM_MS) confirm(r, 'gps');
      } else {
        r.stuckSince.delete(uid);
      }
    }
  }
}
