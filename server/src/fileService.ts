/**
 * Users' files (report photos, profile pictures, documents), stored through the server.
 *
 * Production: a private Cloud Storage bucket of WayFinder's own (FILES_BUCKET, default
 * "<project>-wayfinder-files" — never the project's default bucket, which belongs to
 * another app), metadata in Firestore `userFiles/{id}` (Admin SDK only). Without Firebase
 * (local / demo): files on disk in FILES_DIR (default server/.files), metadata in memory.
 *
 * Files never change once stored (a new upload gets a new id), so they are served with a
 * year-long immutable cache header: each device downloads a file once.
 * Access: the owner; operators can open report photos. Quota per user: MAX_FILES and MAX_BYTES.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { getDb } from './firebaseClient.js';

export type FilePurpose = 'report-photo' | 'profile' | 'document';
export const FILE_PURPOSES: FilePurpose[] = ['report-photo', 'profile', 'document'];
export const FILE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_BYTES = 100 * 1024 * 1024;

export interface FileMeta {
  id: string;
  owner: string;
  name: string;
  type: string;
  size: number;
  purpose: FilePurpose;
  reportId?: string;
  createdAt: number;
}

export class FileError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const LOCAL_DIR = process.env.FILES_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.files');
const memory = new Map<string, FileMeta>();

function bucket() {
  if (!getApps().length) return null;
  const name = process.env.FILES_BUCKET || (process.env.GOOGLE_CLOUD_PROJECT ? `${process.env.GOOGLE_CLOUD_PROJECT}-wayfinder-files` : '');
  return name ? getStorage().bucket(name) : null;
}

const objectPath = (m: FileMeta) => `users/${m.owner}/${m.id}.${FILE_TYPES[m.type] ?? 'bin'}`;

export async function listFiles(owner: string): Promise<FileMeta[]> {
  const db = getDb();
  if (!db) return [...memory.values()].filter(m => m.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
  const snap = await db.collection('userFiles').where('owner', '==', owner).get();
  return snap.docs.map((d: any) => d.data() as FileMeta).sort((a: FileMeta, b: FileMeta) => b.createdAt - a.createdAt);
}

export async function getFileMeta(id: string): Promise<FileMeta | null> {
  if (!/^[\w-]{10,64}$/.test(id)) return null;
  const db = getDb();
  if (!db) return memory.get(id) ?? null;
  const doc = await db.collection('userFiles').doc(id).get();
  return doc.exists ? doc.data() as FileMeta : null;
}

/** Stores an upload after checking type, size and the owner's quota. */
export async function saveFile(owner: string, input: { name: string; type: string; purpose: FilePurpose; reportId?: string; data: Buffer }): Promise<FileMeta> {
  if (!FILE_TYPES[input.type]) throw new FileError(`Only ${Object.keys(FILE_TYPES).join(', ')} files`);
  if (!FILE_PURPOSES.includes(input.purpose)) throw new FileError(`purpose must be ${FILE_PURPOSES.join(', ')}`);
  if (input.data.length === 0) throw new FileError('Empty file');
  if (input.data.length > MAX_FILE_BYTES) throw new FileError(`Files up to ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413);
  const mine = await listFiles(owner);
  if (mine.length >= MAX_FILES || mine.reduce((t, m) => t + m.size, 0) + input.data.length > MAX_BYTES) {
    throw new FileError(`Storage full: ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB per person — delete some first`, 413);
  }
  const meta: FileMeta = {
    id: randomUUID(), owner, name: input.name.replace(/[^\w .()-]/g, '_').slice(0, 120) || 'file',
    type: input.type, size: input.data.length, purpose: input.purpose, createdAt: Date.now(),
    ...(input.reportId ? { reportId: input.reportId } : {}),
  };
  const b = bucket();
  if (b) await b.file(objectPath(meta)).save(input.data, { contentType: meta.type, resumable: false, metadata: { cacheControl: 'private, max-age=31536000' } });
  else { mkdirSync(join(LOCAL_DIR, 'users', owner), { recursive: true }); writeFileSync(join(LOCAL_DIR, objectPath(meta)), input.data); }
  const db = getDb();
  if (db) await db.collection('userFiles').doc(meta.id).set(meta);
  else memory.set(meta.id, meta);
  return meta;
}

/** The file's bytes (the caller has already checked access). */
export async function readFile(meta: FileMeta): Promise<Buffer> {
  const b = bucket();
  if (b) return (await b.file(objectPath(meta)).download())[0];
  const p = join(LOCAL_DIR, objectPath(meta));
  if (!existsSync(p)) throw new FileError('File missing', 404);
  return readFileSync(p);
}

export async function deleteFile(meta: FileMeta): Promise<void> {
  const b = bucket();
  if (b) await b.file(objectPath(meta)).delete({ ignoreNotFound: true });
  else { const p = join(LOCAL_DIR, objectPath(meta)); if (existsSync(p)) unlinkSync(p); }
  const db = getDb();
  if (db) await db.collection('userFiles').doc(meta.id).delete();
  else memory.delete(meta.id);
}
