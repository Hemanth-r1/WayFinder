# Task B2: Rewrite AuthContext with Firebase Auth

**Files:**
- Rewrite: `src/context/AuthContext.tsx`
- Update: `src/context/useAuth.ts`

## Requirements

Rewrite the AuthContext to use real Firebase Auth instead of local state. The current implementation uses a mock dropdown — replace it entirely.

### `src/context/AuthContext.tsx`

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

### `src/context/useAuth.ts`

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

### Interface changes

The `useAuth` hook now returns:
- `user: User | null` (Firebase User object, has `.email`, `.uid`)
- `role: string` (from Firestore)
- `loading: boolean` (true while initial auth check is happening)
- `signIn(email, password): Promise<void>`
- `signUp(email, password): Promise<void>`
- `signOut(): Promise<void>`

### Do NOT change any other files in this task.

Run `npm run build` — must pass.

## Global Constraints
- `verbatimModuleSyntax: true` — use `import type` for type-only imports. If you import `User` type from firebase/auth, use `import { type User }` or `import { User }` depending on how firebase exports it.
- `noUnusedLocals` / `noUnusedParameters` are errors
