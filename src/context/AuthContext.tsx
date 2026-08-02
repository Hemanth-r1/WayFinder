import { createContext, useEffect, useState, type ReactNode } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendPasswordResetEmail,
  type User,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, isFirebaseReady } from '../config/firebase';

export interface AuthState {
  user: User | null;
  role: string;
  loading: boolean;
  isFirebaseAvailable: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  promoteRole: (newRole: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState('user');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isFirebaseReady) {
      // Firebase not configured - use demo mode
      console.log('[Auth] Firebase not configured, using demo mode');
      setUser({ uid: 'demo-user', email: 'demo@example.com' } as User);
      setRole('user');
      setLoading(false);
      return;
    }

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
    if (!isFirebaseReady) {
      // Demo mode - accept any credentials
      setUser({ uid: 'demo-user', email } as User);
      return;
    }
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUp = async (email: string, password: string) => {
    if (!isFirebaseReady) {
      // Demo mode - accept any credentials
      setUser({ uid: 'demo-user', email } as User);
      return;
    }
    await createUserWithEmailAndPassword(auth, email, password);
  };

  const signOut = async () => {
    if (!isFirebaseReady) {
      setUser(null);
      return;
    }
    await firebaseSignOut(auth);
  };

  const promoteRole = async (newRole: string) => {
    if (!isFirebaseReady || !user) {
      setRole(newRole);
      return;
    }
    await setDoc(doc(db, 'users', user.uid), { role: newRole }, { merge: true });
    setRole(newRole);
  };

  const resetPassword = async (email: string) => {
    if (!isFirebaseReady) {
      console.log('[Auth] Demo mode - password reset not available');
      return;
    }
    await sendPasswordResetEmail(auth, email);
  };

  return (
    <AuthContext.Provider value={{ user, role, loading, isFirebaseAvailable: isFirebaseReady, signIn, signUp, signOut, promoteRole, resetPassword }}>
      {children}
    </AuthContext.Provider>
  );
}
