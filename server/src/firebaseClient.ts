import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let db: any = null;
/**
 * WayFinder's own named Firestore database. The project's "(default)" database belongs
 * to another app (recruitment data) — WayFinder must never read or write it.
 */
export const FIRESTORE_DATABASE = process.env.FIRESTORE_DATABASE || 'wayfinder';

export function initFirebase(): void {
  if (getApps().length > 0) return;
  
  // Only initialize if Firebase credentials are provided
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  
  if (!serviceAccount && !projectId) {
    console.warn('[Firebase] No credentials provided, running without Firebase');
    return;
  }
  
  try {
    const app = initializeApp(
      serviceAccount
        ? { credential: cert(JSON.parse(serviceAccount)) }
        : { projectId }
    );
    db = getFirestore(app, FIRESTORE_DATABASE);
    console.log(`[Firebase] Initialized (Firestore database "${FIRESTORE_DATABASE}")`);
  } catch (err) {
    console.error('[Firebase] Initialization failed:', err);
  }
}

export function getDb() {
  return db;
}
