# Task B1: Create Firebase config

**Files:**
- Create: `src/config/firebase.ts`

## Requirements

Create `src/config/firebase.ts` that initializes Firebase using VITE_FIREBASE_* environment variables:

```typescript
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
```

Also check `src/config/index.ts` — if it contains `FEATURE_FLAGS.ENABLE_FIREBASE: false`, remove that line.

Run `npm run build` to verify.

## Global Constraints
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- No test framework exists — verify with `npm run build`
