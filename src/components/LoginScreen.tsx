import { useState } from 'react';
import { useAuth } from '../context/useAuth';

export default function LoginScreen() {
  const { signIn, signUp, isFirebaseAvailable } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isLogin) {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDemoLogin = () => {
    setEmail('demo@example.com');
    setPassword('demo');
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(circle at center, #1a1a2e 0%, #0a0a14 100%)', zIndex: 10000,
    }}>
      <div style={{
        background: 'rgba(15,15,28,0.95)', border: '1px solid #222', borderRadius: 16,
        padding: 32, width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🚦</div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 'bold', color: '#fff' }}>WayFinder</h1>
          <p style={{ margin: 4, fontSize: 12, color: '#666' }}>Real-time Traffic Simulation</p>
          {!isFirebaseAvailable && (
            <div style={{
              background: '#FF980022', border: '1px solid #FF980044', borderRadius: 6,
              padding: '6px 12px', marginTop: 8, fontSize: 10, color: '#FF9800', display: 'inline-block',
            }}>
              Demo Mode (Firebase not configured)
            </div>
          )}
        </div>

        {error && (
          <div style={{
            background: '#F4433622', border: '1px solid #F4433644', borderRadius: 8,
            padding: 12, marginBottom: 16, fontSize: 12, color: '#F44336', textAlign: 'center',
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 6 }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              style={{
                width: '100%', padding: '10px 12px', background: '#1a1a2e', border: '1px solid #333',
                borderRadius: 8, color: '#fff', fontSize: 13, boxSizing: 'border-box', outline: 'none',
              }}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 6 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              style={{
                width: '100%', padding: '10px 12px', background: '#1a1a2e', border: '1px solid #333',
                borderRadius: 8, color: '#fff', fontSize: 13, boxSizing: 'border-box', outline: 'none',
              }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '12px', background: '#4488FF', color: '#fff', border: 'none',
              borderRadius: 8, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 'bold',
            }}
          >
            {loading ? 'Processing...' : (isLogin ? 'Sign In' : 'Create Account')}
          </button>
        </form>

        {!isFirebaseAvailable && (
          <button
            type="button"
            onClick={handleDemoLogin}
            style={{
              width: '100%', padding: '10px', background: '#FF9800', color: '#fff', border: 'none',
              borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 'bold', marginTop: 12,
            }}
          >
            Quick Demo Login
          </button>
        )}

        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button
            type="button"
            onClick={() => { setIsLogin(!isLogin); setError(''); }}
            style={{
              background: 'transparent', border: 'none', color: '#4488FF', cursor: 'pointer',
              fontSize: 12, padding: 0,
            }}
          >
            {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
