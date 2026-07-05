import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/useAuth';

export default function LoginScreen() {
  const { signIn, signUp, resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

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
        {!isSignUp && (
          <button type="button" onClick={async () => {
            if (!email) return;
            setBusy(true);
            try {
              await resetPassword(email);
              setResetSent(true);
              setTimeout(() => setResetSent(false), 4000);
            } catch (err: any) {
              setError(err.message || 'Failed to send reset email');
            }
            setBusy(false);
          }} disabled={!email || resetSent} style={{
            background: 'none', border: 'none', color: resetSent ? '#4CAF50' : '#555',
            cursor: email ? 'pointer' : 'default', fontSize: 11,
            textDecoration: 'underline',
          }}>
            {resetSent ? '✓ Reset link sent!' : 'Forgot password?'}
          </button>
        )}
      </form>
    </div>
  );
}
