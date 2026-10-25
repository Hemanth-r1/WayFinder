/**
 * Who is calling. With Firebase configured, requests carry a Firebase ID token
 * (`Authorization: Bearer …`) that is verified here, and the role comes from Firestore
 * `users/{uid}.role`, which admins change in the app (Admin panel). The first admins come
 * from ADMIN_EMAILS (comma-separated): those accounts become admin when they sign in.
 * A disabled account (`users/{uid}.disabled`) is refused. Without Firebase (demo mode) the
 * browser's `X-Demo-User` / `X-Demo-Role` headers are trusted so everything can be tried.
 */
import type { Request, Response, NextFunction } from 'express';
import { getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDb } from './firebaseClient.js';

/**
 * user: drivers · responder: ambulance / fire / police drivers (emergency runs) ·
 * supporter: wardens / volunteers (verify reports, map signals, view junctions) ·
 * controller: traffic police (signal control) · admin: everything, plus users and roles
 */
export type Role = 'user' | 'supporter' | 'controller' | 'responder' | 'admin';
export const ROLES: Role[] = ['user', 'responder', 'supporter', 'controller', 'admin'];
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));

/** Operators see junctions and conditions; controllers and admins also control signals. */
export const isOperator = (role: Role) => role === 'supporter' || role === 'controller' || role === 'admin';
export const canControl = (role: Role) => role === 'controller' || role === 'admin';

export interface Caller {
  uid: string;
  role: Role;
  /** Supporters and controllers: their reports and decisions take effect at once */
  trusted: boolean;
}

const ROLE_CACHE_MS = 5 * 60 * 1000;
const roleCache = new Map<string, { role: Role; disabled: boolean; at: number }>();

/** An admin changed this user: use the new role / status on their next request. */
export function forgetRole(uid: string): void {
  roleCache.delete(uid);
}

/** When each user was last seen (written to their profile at most every 10 min). */
const lastSeenWritten = new Map<string, number>();
const LAST_SEEN_MS = 10 * 60 * 1000;
function noteSeen(uid: string, email?: string): void {
  const now = Date.now();
  if (now - (lastSeenWritten.get(uid) ?? 0) < LAST_SEEN_MS) return;
  lastSeenWritten.set(uid, now);
  getDb()?.collection('users').doc(uid).set({ lastSeenAt: now, ...(email ? { email } : {}) }, { merge: true }).catch(() => {});
  demoSeen.set(uid, now);
}
/** Demo mode: users seen recently, for the Admin panel */
export const demoSeen = new Map<string, number>();
// Drop expired roles, or the cache grows with every user ever seen
setInterval(() => {
  const cutoff = Date.now() - ROLE_CACHE_MS;
  for (const [uid, r] of roleCache) if (r.at < cutoff) roleCache.delete(uid);
}, ROLE_CACHE_MS).unref();

export function authMode(): 'firebase' | 'demo' {
  return getApps().length > 0 ? 'firebase' : 'demo';
}

async function roleFor(uid: string, email?: string): Promise<{ role: Role; disabled: boolean }> {
  const cached = roleCache.get(uid);
  if (cached && Date.now() - cached.at < ROLE_CACHE_MS) return cached;
  let role: Role = 'user', disabled = false;
  try {
    const ref = getDb()?.collection('users').doc(uid);
    const data = (await ref?.get())?.data();
    if (ROLES.includes(data?.role)) role = data!.role;
    disabled = data?.disabled === true;
    // Bootstrap: accounts listed in ADMIN_EMAILS are admins (set once, then managed in the app)
    if (email && ADMIN_EMAILS.has(email.toLowerCase()) && role !== 'admin') {
      role = 'admin';
      await ref?.set({ role: 'admin', roleChangedBy: 'ADMIN_EMAILS', roleChangedAt: Date.now() }, { merge: true });
    }
  } catch (err) {
    console.warn('[Auth] Role lookup failed:', (err as Error).message);
  }
  const entry = { role, disabled, at: Date.now() };
  roleCache.set(uid, entry);
  return entry;
}

function asRole(value: unknown): Role {
  return ROLES.includes(value as Role) ? value as Role : 'user';
}

async function identify(req: Request): Promise<Caller | null> {
  if (authMode() === 'demo') {
    const uid = req.header('x-demo-user');
    if (!uid || !/^[\w-]{1,64}$/.test(uid)) return null;
    const role = asRole(req.header('x-demo-role'));
    noteSeen(uid);
    demoRoles.set(uid, role);
    return { uid, role, trusted: isOperator(role) };
  }
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const decoded = await getAuth().verifyIdToken(token);
    const { role, disabled } = await roleFor(decoded.uid, decoded.email);
    if (disabled) return null;
    noteSeen(decoded.uid, decoded.email);
    return { uid: decoded.uid, role, trusted: isOperator(role) };
  } catch {
    return null;
  }
}

/** Demo mode: the role each demo user last used (headers are trusted there) */
export const demoRoles = new Map<string, Role>();

export function caller(res: Response): Caller {
  return res.locals.caller as Caller;
}

/** Requires a signed-in caller. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const c = await identify(req);
  if (!c) return res.status(401).json({ error: 'Sign in required' });
  res.locals.caller = c;
  next();
}

/** Identifies the caller if possible, but lets anonymous requests through. */
export async function optionalUser(req: Request, res: Response, next: NextFunction) {
  res.locals.caller = await identify(req);
  next();
}

/** `:userId` in the path must be the caller. */
export function requireSelf(req: Request, res: Response, next: NextFunction) {
  if (req.params.userId !== caller(res).uid) {
    return res.status(403).json({ error: 'You can only act on your own navigation' });
  }
  next();
}

/** Supporters, controllers and admins. */
export function requireOperator(_req: Request, res: Response, next: NextFunction) {
  if (!caller(res).trusted) return res.status(403).json({ error: 'Supporter or controller role required' });
  next();
}

/** Signal control: controllers (traffic police) and admins. */
export function requireController(_req: Request, res: Response, next: NextFunction) {
  if (!canControl(caller(res).role)) return res.status(403).json({ error: 'Controller role required' });
  next();
}

/** Users, roles and app settings: admins only. */
export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  if (caller(res).role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  next();
}

/**
 * Server-set pacing for calls every driver makes repeatedly (GPS fixes, navigation
 * updates): the response says how long to wait before the next call (`X-Next-Ms`).
 * Below `budgetPerSec` calls per second clients keep `baseMs`; above it the wait grows
 * in proportion, so total load stays near the budget however many drivers there are.
 */
export function pace(baseMs: number, budgetPerSec: number) {
  let windowStart = Date.now(), count = 0, rate = 0;
  return (_req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      rate = count * 1000 / (now - windowStart);
      windowStart = now; count = 0;
    }
    count++;
    const wait = Math.min(120_000, Math.round(baseMs * Math.max(1, rate / budgetPerSec)));
    res.setHeader('X-Next-Ms', String(wait));
    next();
  };
}

/** At most `max` calls per caller per window (in memory, per server instance). */
export function rateLimit(name: string, max: number, windowMs: number) {
  // Fixed window per caller: two numbers each, so millions of callers stay small
  const hits = new Map<string, { start: number; count: number }>();
  // Forget callers whose window has passed (memory would grow with every user)
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, h] of hits) if (h.start < cutoff) hits.delete(key);
  }, windowMs).unref();
  return (_req: Request, res: Response, next: NextFunction) => {
    const key = caller(res).uid;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.start >= windowMs) { h = { start: now, count: 0 }; hits.set(key, h); }
    if (h.count >= max) {
      const retry = Math.ceil((windowMs - (now - h.start)) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: `Too many ${name} — try again in ${Math.ceil(retry / 60)} min` });
    }
    h.count++;
    next();
  };
}
