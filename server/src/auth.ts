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

/** At most `max` calls per caller per window (in memory, per server instance). */
export function rateLimit(name: string, max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (_req: Request, res: Response, next: NextFunction) => {
    const key = caller(res).uid;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
      const retry = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: `Too many ${name} — try again in ${Math.ceil(retry / 60)} min` });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
