/**
 * Who is calling. With Firebase configured, requests carry a Firebase ID token
 * (`Authorization: Bearer …`) that is verified here, and the role comes from Firestore
 * `users/{uid}.role`, which only admins can change. Without Firebase (demo mode) the
 * browser's `X-Demo-User` / `X-Demo-Role` headers are trusted so everything can be tried.
 */
import type { Request, Response, NextFunction } from 'express';
import { getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDb } from './firebaseClient.js';

export type Role = 'user' | 'supporter' | 'controller';

export interface Caller {
  uid: string;
  role: Role;
  /** Supporters and controllers: their reports and decisions take effect at once */
  trusted: boolean;
}

const ROLES: Role[] = ['user', 'supporter', 'controller'];
const ROLE_CACHE_MS = 5 * 60 * 1000;
const roleCache = new Map<string, { role: Role; at: number }>();
// Drop expired roles, or the cache grows with every user ever seen
setInterval(() => {
  const cutoff = Date.now() - ROLE_CACHE_MS;
  for (const [uid, r] of roleCache) if (r.at < cutoff) roleCache.delete(uid);
}, ROLE_CACHE_MS).unref();

export function authMode(): 'firebase' | 'demo' {
  return getApps().length > 0 ? 'firebase' : 'demo';
}

async function roleFor(uid: string): Promise<Role> {
  const cached = roleCache.get(uid);
  if (cached && Date.now() - cached.at < ROLE_CACHE_MS) return cached.role;
  let role: Role = 'user';
  try {
    const snap = await getDb()?.collection('users').doc(uid).get();
    const stored = snap?.data()?.role;
    if (ROLES.includes(stored)) role = stored;
  } catch (err) {
    console.warn('[Auth] Role lookup failed:', (err as Error).message);
  }
  roleCache.set(uid, { role, at: Date.now() });
  return role;
}

function asRole(value: unknown): Role {
  return ROLES.includes(value as Role) ? value as Role : 'user';
}

async function identify(req: Request): Promise<Caller | null> {
  if (authMode() === 'demo') {
    const uid = req.header('x-demo-user');
    if (!uid || !/^[\w-]{1,64}$/.test(uid)) return null;
    const role = asRole(req.header('x-demo-role'));
    return { uid, role, trusted: role !== 'user' };
  }
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const decoded = await getAuth().verifyIdToken(token);
    const role = await roleFor(decoded.uid);
    return { uid: decoded.uid, role, trusted: role !== 'user' };
  } catch {
    return null;
  }
}

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

/** Supporters and controllers only. */
export function requireOperator(_req: Request, res: Response, next: NextFunction) {
  if (!caller(res).trusted) return res.status(403).json({ error: 'Supporter or controller role required' });
  next();
}

/** Signal control: controllers (traffic police) only. */
export function requireController(_req: Request, res: Response, next: NextFunction) {
  if (caller(res).role !== 'controller') return res.status(403).json({ error: 'Controller role required' });
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
