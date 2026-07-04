# WayFinder Firebase Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real Firebase Auth + Firestore persistence to WayFinder, replacing the fake auth dropdown and ephemeral state with real user accounts and persistent data.

**Architecture:** Firebase Auth for email/password login. Firestore with 4 collections (users, routes, signals, overrides). Real-time `onSnapshot` listeners for shared data. Security rules enforce role-based access.

**Tech Stack:** Firebase Auth, Firestore, React 19, TypeScript 6

## Global Constraints

- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `erasableSyntaxOnly: true` — no enums, no parameter properties
- `noUnusedLocals` / `noUnusedParameters` are errors — remove unused
- Inline styles only (no CSS modules, no Tailwind)
- Firebase v12 (`^12.15.0` already in package.json)
- VITE_FIREBASE_* env vars from `.env.example` must be set (user creates `.env`)

---

### Task 1: Create Firebase config

**Files:**
- Create: `src/config/firebase.ts`

**Interfaces:**
- Produces: exported `app` (FirebaseApp), `auth` (Auth), `db` (Firestore)

- [ ] **Step 1: Create `src/config/firebase.ts`**

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

- [ ] **Step 2: Run `npm run build` to verify**

The build should pass (the file has no imports from other project files).

- [ ] **Step 3: Remove `ENABLE_FIREBASE` flag**

In `src/config/index.ts`, remove the line `FEATURE_FLAGS.ENABLE_FIREBASE: false` (or the entire file if that's all it contains).

- [ ] **Step 4: Commit**

```
git add src/config/firebase.ts src/config/index.ts
git commit -m "feat: add Firebase config with Auth + Firestore"
```

---

### Task 2: Rewrite AuthContext with Firebase Auth

**Files:**
- Rewrite: `src/context/AuthContext.tsx`
- Update: `src/context/useAuth.ts`

**Interfaces:**
- Consumes: `auth` from `src/config/firebase.ts`
- Produces: `AuthContext` with `{ user: User | null, role: string, loading: boolean, signIn, signUp, signOut }`

- [ ] **Step 1: Read current `src/context/AuthContext.tsx` and `src/context/useAuth.ts`**

- [ ] **Step 2: Rewrite `src/context/AuthContext.tsx`**

```typescript
import { createContext, useEffect, useState, type ReactNode } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../config/firebase';

export interface AuthState {
  user: User | null;
  role: string;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState('user');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        const docRef = doc(db, 'users', firebaseUser.uid);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          setRole(snap.data().role || 'user');
        } else {
          await setDoc(docRef, {
            email: firebaseUser.email,
            role: 'user',
            createdAt: serverTimestamp(),
          });
          setRole('user');
        }
      } else {
        setRole('user');
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUp = async (email: string, password: string) => {
    await createUserWithEmailAndPassword(auth, email, password);
  };

  const signOut = async () => {
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, role, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
```

- [ ] **Step 3: Rewrite `src/context/useAuth.ts`**

```typescript
import { useContext } from 'react';
import { AuthContext } from './AuthContext';
import type { AuthState } from './AuthContext';

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
```

- [ ] **Step 4: Run `npm run build` and `npm run lint`**

Both must pass.

- [ ] **Step 5: Commit**

```
git add src/context/AuthContext.tsx src/context/useAuth.ts
git commit -m "feat: add Firebase Auth with email/password login"
```

---

### Task 3: Create LoginScreen component

**Files:**
- Create: `src/components/LoginScreen.tsx`

**Interfaces:**
- Consumes: `useAuth` — `signIn`, `signUp`
- Produces: LoginScreen component rendered when user is null

- [ ] **Step 1: Create `src/components/LoginScreen.tsx`**

```typescript
import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/useAuth';

export default function LoginScreen() {
  const { signIn, signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (isSignUp) {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      width: '100vw', height: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#0a0a14', color: '#fff',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: 'rgba(20,20,35,0.95)', padding: 32, borderRadius: 12,
        border: '1px solid #333', width: 360, display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>
          🚦 WayFinder
        </div>
        <div style={{ fontSize: 13, color: '#888', textAlign: 'center', marginBottom: 8 }}>
          {isSignUp ? 'Create an account' : 'Sign in to continue'}
        </div>
        {error && (
          <div style={{ background: '#f4433615', border: '1px solid #f4433644', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#FF5252' }}>
            {error}
          </div>
        )}
        <input
          type="email" placeholder="Email" required value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: '10px 12px', background: '#111', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 14, outline: 'none' }}
        />
        <input
          type="password" placeholder="Password" required value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: '10px 12px', background: '#111', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 14, outline: 'none' }}
        />
        <button type="submit" disabled={busy} style={{
          padding: 12, background: '#FF6D00', color: '#fff', border: 'none',
          borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 'bold',
          opacity: busy ? 0.6 : 1,
        }}>
          {busy ? 'Please wait...' : isSignUp ? 'Create Account' : 'Sign In'}
        </button>
        <button type="button" onClick={() => setIsSignUp(!isSignUp)} style={{
          background: 'none', border: 'none', color: '#888', cursor: 'pointer',
          fontSize: 12, textDecoration: 'underline',
        }}>
          {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Run `npm run build`**

Must pass.

- [ ] **Step 3: Wire LoginScreen into App.tsx**

Open `src/App.tsx`. After the `useAuth()` hook call at the top of `AppContent`, add:

```typescript
if (loading) return <LoadingOverlay message="Loading..." />;
if (!user) return <LoginScreen />;
```

Also import `LoginScreen` at the top:
```typescript
import LoginScreen from './components/LoginScreen';
```

And add `loading` and `user` to the destructured `useAuth()` result:
```typescript
const { role, user, loading } = useAuth();
```

- [ ] **Step 4: Run `npm run build`**

Must pass.

- [ ] **Step 5: Commit**

```
git add src/components/LoginScreen.tsx src/App.tsx
git commit -m "feat: add LoginScreen with email/password auth"
```

---

### Task 4: Rewrite RoleSelector as profile widget

**Files:**
- Rewrite: `src/components/RoleSelector.tsx`

**Interfaces:**
- Consumes: `useAuth` — `user`, `role`, `signOut`
- Produces: Profile widget showing email, role badge, sign out button

- [ ] **Step 1: Read current `src/components/RoleSelector.tsx`**

- [ ] **Step 2: Rewrite `src/components/RoleSelector.tsx`**

```typescript
import { useAuth } from '../context/useAuth';

export default function RoleSelector() {
  const { user, role, signOut } = useAuth();

  const roleColors: Record<string, string> = {
    user: '#4CAF50',
    supporter: '#4488FF',
    controller: '#FF6D00',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, color: '#888', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {user?.email}
      </span>
      <span style={{
        padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 'bold',
        background: `${roleColors[role] || '#555'}22`, color: roleColors[role] || '#888',
        border: `1px solid ${roleColors[role] || '#555'}44`,
        textTransform: 'capitalize',
      }}>
        {role}
      </span>
      <button onClick={signOut} style={{
        padding: '4px 10px', background: '#333', color: '#ccc',
        border: '1px solid #555', borderRadius: 4, cursor: 'pointer',
        fontSize: 11,
      }}>
        Sign Out
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Run `npm run build`**

Must pass.

- [ ] **Step 4: Commit**

```
git add src/components/RoleSelector.tsx
git commit -m "feat: replace role dropdown with Firebase profile widget"
```

---

### Task 5: Wire UserPanel to Firestore routes

**Files:**
- Modify: `src/roles/UserPanel.tsx`

- [ ] **Step 1: Read current `src/roles/UserPanel.tsx`**

Understand how it reads/writes routes currently (from `App.tsx` state via props).

- [ ] **Step 2: Add Firestore reads and writes**

Import Firestore:
```typescript
import { useEffect, useState } from 'react';
import { collection, query, where, orderBy, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../context/useAuth';
```

Replace the prop-based route list with Firestore query. In the component body:
```typescript
const { user } = useAuth();
const [routes, setRoutes] = useState<any[]>([]);

useEffect(() => {
  if (!user) return;
  const q = query(
    collection(db, 'routes'),
    where('userId', '==', user.uid),
    orderBy('createdAt', 'desc')
  );
  const unsub = onSnapshot(q, (snap) => {
    setRoutes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
  return unsub;
}, [user]);
```

Replace the submit handler to write to Firestore:
```typescript
const handleSubmitRoute = async (source: string, dest: string, avoid: boolean, prefer: boolean) => {
  if (!user) return;
  await addDoc(collection(db, 'routes'), {
    userId: user.uid,
    sourceNodeId: source,
    destNodeId: dest,
    avoidCongestion: avoid,
    preferMainRoads: prefer,
    createdAt: serverTimestamp(),
  });
};
```

Keep the existing callback (`onSubmitRoute`) for instant feedback, but also write to Firestore. Or better — remove the `App.tsx` state array entirely and rely on Firestore as the single source of truth.

Remove `submittedRoutes` and `onSubmitRoute` props — UserPanel gets its data from Firestore directly.

- [ ] **Step 3: Update `App.tsx` to remove `userRoutes` state**

Remove `const [userRoutes, setUserRoutes] = useState<UserRoute[]>([]);`
Remove `onSubmitRoute={handleSubmitRoute}` from UserPanel props.

- [ ] **Step 4: Run `npm run build`**

Must pass.

- [ ] **Step 5: Commit**

```
git add src/roles/UserPanel.tsx src/App.tsx
git commit -m "feat: wire UserPanel routes to Firestore"
```

---

### Task 6: Wire SupporterPanel to Firestore signals (real-time)

**Files:**
- Modify: `src/roles/SupporterPanel.tsx`

- [ ] **Step 1: Read current `src/roles/SupporterPanel.tsx`**

- [ ] **Step 2: Add Firestore real-time sync**

Import and add `onSnapshot` listener for the `signals` collection:
```typescript
import { useEffect, useState } from 'react';
import { collection, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../context/useAuth';

// Inside component:
const { user } = useAuth();
const [signals, setSignals] = useState<any[]>([]);

useEffect(() => {
  const unsub = onSnapshot(collection(db, 'signals'), (snap) => {
    setSignals(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
  return unsub;
}, []);
```

Replace the add-signal handler to write to Firestore:
```typescript
const handleAddSignal = async (nodeId: string, lat: number, lng: number, roadName: string) => {
  if (!user) return;
  await addDoc(collection(db, 'signals'), {
    supporterId: user.uid,
    nodeId,
    lat,
    lng,
    roadName,
    signalType: 'smart',
    timestamp: serverTimestamp(),
  });
};
```

Remove `addedSignals` and `onAddSignal` props — data comes from Firestore.

- [ ] **Step 3: Update `App.tsx`**

Remove `const [addedSignals, setAddedSignals] = useState<SupporterSignal[]>([]);`
Remove `onAddSignal={handleAddSignal}` prop from SupporterPanel.

- [ ] **Step 4: Run `npm run build`**

Must pass.

- [ ] **Step 5: Commit**

```
git add src/roles/SupporterPanel.tsx src/App.tsx
git commit -m "feat: wire SupporterPanel signals to Firestore real-time"
```

---

### Task 7: Wire ControllerPanel to Firestore overrides (real-time)

**Files:**
- Modify: `src/roles/ControllerPanel.tsx`

- [ ] **Step 1: Read current `src/roles/ControllerPanel.tsx`**

- [ ] **Step 2: Add Firestore real-time sync**

Similar to Task 6 but for the `overrides` collection. Filter to active overrides where `active == true` and `expiresAt` is in the future.

```typescript
import { useEffect, useState } from 'react';
import { collection, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../context/useAuth';
```

Add listener:
```typescript
const { user } = useAuth();
const [overrides, setOverrides] = useState<any[]>([]);

useEffect(() => {
  const unsub = onSnapshot(
    query(collection(db, 'overrides'), where('active', '==', true)),
    (snap) => {
      setOverrides(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }
  );
  return unsub;
}, []);
```

Replace override handler:
```typescript
const handleOverride = async (signalId: string, direction: string, color: string) => {
  if (!user) return;
  const expiresAt = new Date(Date.now() + 30_000); // 30 seconds
  await addDoc(collection(db, 'overrides'), {
    controllerId: user.uid,
    signalId,
    direction,
    color,
    active: true,
    expiresAt,
    timestamp: serverTimestamp(),
  });
  // Also apply the override to the engine immediately
  onOverrideSignal(signalId, direction, color);
};
```

- [ ] **Step 3: Run `npm run build`**

Must pass.

- [ ] **Step 4: Commit**

```
git add src/roles/ControllerPanel.tsx
git commit -m "feat: wire ControllerPanel overrides to Firestore real-time"
```

---

### Task 8: Final integration + deployment guide

**Files:**
- Modify: `AGENTS.md` (update Firebase section with setup instructions)
- Create: `firestore.rules` (security rules file at project root)

- [ ] **Step 1: Create `firestore.rules`**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /routes/{routeId} {
      allow read, update, delete: if request.auth != null && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.userId;
    }
    match /signals/{signalId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['supporter', 'controller'];
    }
    match /overrides/{overrideId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'controller';
    }
  }
}
```

- [ ] **Step 2: Update AGENTS.md Firebase section**

Replace the old placeholder section with:
```
## Firebase

1. Create a Firebase project at https://console.firebase.google.com
2. Enable **Authentication** → Sign-in method → Email/Password
3. Create a **Firestore Database** in test mode (apply `firestore.rules` after)
4. Copy `.env.example` → `.env` and fill in your Firebase config values
5. To promote a user to supporter/controller, update their Firestore document:
   `users/{uid}` → set `role: "supporter"` or `role: "controller"`
```

- [ ] **Step 3: Run `npm run build`**

Final full build check.

- [ ] **Step 4: Commit**

```
git add firestore.rules AGENTS.md
git commit -m "docs: add Firestore security rules and deployment guide"
```
