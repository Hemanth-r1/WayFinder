/**
 * Admin features: users and their roles (no Firebase console needed), role requests,
 * disabling accounts, an overview of the system, the admin audit log, and an
 * announcement banner shown to everyone.
 *
 * Firestore (WayFinder's `wayfinder` database, Admin SDK only): `users/{uid}` (role,
 * requestedRole, disabled, email, createdAt, lastSeenAt), `adminLog` (who changed what),
 * `appSettings/public` (announcement). Demo mode keeps everything in memory.
 */
import { getAuth } from 'firebase-admin/auth';
import { getDb } from './firebaseClient.js';
import { ROLES, forgetRole, demoSeen, demoRoles, authMode, type Role } from './auth.js';

export interface AdminUser {
  uid: string;
  email?: string;
  role: Role;
  requestedRole?: string;
  disabled: boolean;
  createdAt?: number;
  lastSeenAt?: number;
}

export interface AdminLogEntry { at: number; by: string; action: string; target: string; detail: string }

export class AdminError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const MAX_LIST = 500;
const memoryLog: AdminLogEntry[] = [];
let announcement: { text: string; level: 'info' | 'warning'; by: string; at: number } | null = null;

const toMs = (v: any): number | undefined => (typeof v === 'number' ? v : v?.toMillis?.() ?? undefined);

function record(by: string, action: string, target: string, detail: string): void {
  const e: AdminLogEntry = { at: Date.now(), by, action, target, detail };
  memoryLog.unshift(e);
  if (memoryLog.length > 500) memoryLog.pop();
  getDb()?.collection('adminLog').add(e).catch(() => {});
}

/** Users, newest activity first; filter by text (email or id), role, or pending requests. */
export async function listUsers(opts: { q?: string; role?: string; requested?: boolean }): Promise<AdminUser[]> {
  const db = getDb();
  let users: AdminUser[];
  if (!db) {
    users = [...demoSeen].map(([uid, at]) => ({ uid, role: demoRoles.get(uid) ?? 'user', disabled: false, lastSeenAt: at }));
  } else {
    const snap = await db.collection('users').limit(5000).get();
    users = snap.docs.map((d: any) => {
      const u = d.data();
      return {
        uid: d.id, email: u.email, role: ROLES.includes(u.role) ? u.role : 'user',
        requestedRole: u.requestedRole, disabled: u.disabled === true,
        createdAt: toMs(u.createdAt), lastSeenAt: toMs(u.lastSeenAt),
      } as AdminUser;
    });
  }
  const q = opts.q?.trim().toLowerCase();
  return users
    .filter(u => !q || u.uid.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q))
    .filter(u => !opts.role || u.role === opts.role)
    .filter(u => !opts.requested || (!!u.requestedRole && u.requestedRole !== u.role))
    .sort((a, b) => (b.lastSeenAt ?? b.createdAt ?? 0) - (a.lastSeenAt ?? a.createdAt ?? 0))
    .slice(0, MAX_LIST);
}

/** Sets a user's role (and clears their request). An admin can't remove their own admin role. */
export async function setRole(uid: string, role: string, by: string): Promise<void> {
  if (!ROLES.includes(role as Role)) throw new AdminError(`role must be one of ${ROLES.join(', ')}`);
  if (uid === by && role !== 'admin') throw new AdminError('You cannot remove your own admin role — ask another admin');
  const db = getDb();
  if (db) {
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) throw new AdminError('No such user', 404);
    const before = doc.data()?.role ?? 'user';
    await ref.set({ role, requestedRole: null, roleChangedBy: by, roleChangedAt: Date.now() }, { merge: true });
    record(by, 'role', uid, `${doc.data()?.email ?? uid}: ${before} → ${role}`);
  } else {
    demoRoles.set(uid, role as Role);
    record(by, 'role', uid, `→ ${role} (demo: the browser's role badge still decides)`);
  }
  forgetRole(uid);
}

/** Turns a user's request down (keeps their role). */
export async function declineRequest(uid: string, by: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  const ref = db.collection('users').doc(uid);
  const doc = await ref.get();
  if (!doc.exists) throw new AdminError('No such user', 404);
  await ref.set({ requestedRole: null }, { merge: true });
  record(by, 'request declined', uid, `${doc.data()?.email ?? uid} asked for ${doc.data()?.requestedRole}`);
}

/** Disables (or re-enables) an account: signed out everywhere, refused until enabled. */
export async function setDisabled(uid: string, disabled: boolean, by: string): Promise<void> {
  if (uid === by) throw new AdminError('You cannot disable your own account');
  const db = getDb();
  if (!db) throw new AdminError('Needs Firebase (not available in demo mode)', 501);
  await db.collection('users').doc(uid).set({ disabled }, { merge: true });
  try {
    await getAuth().updateUser(uid, { disabled });
    if (disabled) await getAuth().revokeRefreshTokens(uid);
  } catch (err) {
    console.warn('[Admin] Auth update failed:', (err as Error).message); // profile flag still blocks the API
  }
  forgetRole(uid);
  record(by, disabled ? 'disabled' : 'enabled', uid, '');
}

export async function adminLog(limit = 100): Promise<AdminLogEntry[]> {
  const db = getDb();
  if (!db) return memoryLog.slice(0, limit);
  const snap = await db.collection('adminLog').orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map((d: any) => d.data() as AdminLogEntry);
}

// ── Announcement banner (shown to everyone) ─────────────────────────────────

export async function loadAnnouncement(): Promise<void> {
  try {
    const doc = await getDb()?.collection('appSettings').doc('public').get();
    const a = doc?.data()?.announcement;
    if (a?.text) announcement = a;
  } catch { /* none */ }
}

export function getAnnouncement() {
  return announcement;
}

export async function setAnnouncement(text: string, level: 'info' | 'warning', by: string): Promise<void> {
  const clean = text.trim().slice(0, 280);
  announcement = clean ? { text: clean, level, by, at: Date.now() } : null;
  await getDb()?.collection('appSettings').doc('public').set({ announcement }, { merge: true });
  record(by, 'announcement', '-', clean || '(cleared)');
}

export function authInfo() {
  return { mode: authMode(), adminEmailsSet: !!process.env.ADMIN_EMAILS };
}
