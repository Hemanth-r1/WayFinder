### Task 5: Server Firestore Command Listener

**Files:**
- Create: `server/src/firebaseClient.ts`
- Modify: `server/src/index.ts` — initialize Firebase Admin + start listener

**Interfaces:**
- Produces: Listens to `commands/{docId}` in Firestore
- Produces: Initialize Firebase Admin SDK with service account from env var `FIREBASE_SERVICE_ACCOUNT`

**Step 1: Create `server/src/firebaseClient.ts`**

```typescript
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export function initFirebase(): void {
  if (getApps().length > 0) return;
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : undefined;
  initializeApp(
    serviceAccount
      ? { credential: cert(serviceAccount) }
      : { projectId: process.env.GOOGLE_CLOUD_PROJECT }
  );
}

export function getDb() {
  return getFirestore();
}
```

**Step 2: Wire Firebase init + command listener in `server/src/index.ts`**

Add after `app.use(express.json())`:

```typescript
import { initFirebase, getDb } from './firebaseClient.js';

initFirebase();
const db = getDb();

// Listen for unprocessed commands
const unsubCommands = db.collection('commands')
  .where('processed', '==', false)
  .onSnapshot(async (snapshot) => {
    for (const doc of snapshot.docs) {
      try {
        const cmd = doc.data();
        console.log('[WayFinder Server] Processing command:', cmd.type, doc.id);
        await db.collection('commands').doc(doc.id).update({ processed: true, processedAt: new Date() });
      } catch (err) {
        console.error('Command processing error:', err);
      }
    }
  });

process.on('SIGTERM', () => { unsubCommands(); process.exit(0); });
```

**Step 3: Verify compilation**

```bash
cd server && npx tsc --noEmit
```
Expected: No errors.

**Step 4: Commit**

```bash
git add server/src/firebaseClient.ts server/src/index.ts
git commit -m "feat(server): Firestore command listener with Firebase Admin SDK"
```
