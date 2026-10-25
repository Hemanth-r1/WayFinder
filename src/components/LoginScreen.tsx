/**
 * Sign-in: WayFinder's brand (a TUFF Foundation company, same look as Avakasha) beside
 * the sign-in / sign-up form. Stacks on phones.
 */
import { useState, type CSSProperties } from 'react';
import { useAuth } from '../context/useAuth';
import { useIsMobile } from '../hooks/useIsMobile';
import { BRAND, COLORS, FONTS } from '../brand';
import { BrandLockup } from './BrandMark';

const POINTS = [
  ['🚦', 'Signals that adapt to live traffic, and police control with green waves'],
  ['🚑', 'Green corridors for ambulances, fire engines and police'],
  ['🧭', 'Routes that spread drivers across the city, with offline maps'],
] as const;

export default function LoginScreen() {
  const { signIn, signUp, isFirebaseAvailable } = useAuth();
  const isMobile = useIsMobile();
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
      if (isLogin) await signIn(email, password);
      else await signUp(email, password);
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, overflowY: 'auto', zIndex: 10000,
      background: `radial-gradient(1200px 600px at 15% 10%, ${COLORS.teal}14, transparent 60%), radial-gradient(900px 500px at 90% 90%, ${COLORS.amber}10, transparent 60%), ${COLORS.bgDeep}`,
      display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', justifyContent: 'center', padding: isMobile ? '28px 16px' : 32,
    }}>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 24 : 48, alignItems: isMobile ? 'stretch' : 'center', maxWidth: 940, width: '100%' }}>
        {/* Brand */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <BrandLockup size={isMobile ? 40 : 52} />
          <h1 style={{
            fontFamily: FONTS.display, fontWeight: 800, fontSize: isMobile ? 26 : 38, lineHeight: 1.15, margin: '22px 0 10px',
            background: COLORS.gradientTitle, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
          }}>
            {BRAND.product.tagline}
          </h1>
          <p style={{ color: COLORS.textMuted, fontSize: 15, lineHeight: 1.55, margin: '0 0 18px', maxWidth: 460 }}>{BRAND.product.summary}</p>
          {!isMobile && POINTS.map(([icon, text]) => (
            <div key={text} style={{ display: 'flex', gap: 10, alignItems: 'center', color: COLORS.text, fontSize: 14, margin: '8px 0' }}>
              <span style={{ width: 30, height: 30, borderRadius: 10, display: 'grid', placeItems: 'center', background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>{icon}</span>
              {text}
            </div>
          ))}
          <div style={{ marginTop: 22, fontSize: 12, color: COLORS.textSoft, lineHeight: 1.6 }}>
            A {BRAND.parent.name} company · Sister company:{' '}
            <a href={BRAND.companies[1].url} target="_blank" rel="noopener" style={{ color: COLORS.teal, textDecoration: 'none' }}>{BRAND.companies[1].name}</a>
          </div>
        </div>

        {/* Form */}
        <div style={{
          width: isMobile ? '100%' : 380, flexShrink: 0, background: 'rgba(10,10,13,0.86)', border: `1px solid ${COLORS.border}`,
          borderRadius: 18, padding: isMobile ? 22 : 30, boxShadow: '0 20px 60px rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)',
        }}>
          <h2 style={{ fontFamily: FONTS.display, fontSize: 20, fontWeight: 700, color: COLORS.text, margin: '0 0 4px' }}>
            {isLogin ? 'Welcome back' : 'Create your account'}
          </h2>
          <p style={{ fontSize: 13, color: COLORS.textSoft, margin: '0 0 18px' }}>{isLogin ? 'Sign in to WayFinder' : 'Free for drivers in Bengaluru'}</p>
          {!isFirebaseAvailable && (
            <div style={{ ...s.note, color: COLORS.amber, borderColor: `${COLORS.amber}55`, background: `${COLORS.amber}14` }}>Demo mode — any email and password work</div>
          )}
          {error && <div style={{ ...s.note, color: '#ff8a80', borderColor: '#ff8a8055', background: '#ff8a8014' }}>{error}</div>}

          <form onSubmit={handleSubmit}>
            <label style={s.label}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" style={s.input} />
            <label style={s.label}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required autoComplete={isLogin ? 'current-password' : 'new-password'} style={s.input} />
            <button type="submit" disabled={loading} style={{ ...s.cta, opacity: loading ? 0.7 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
            </button>
          </form>

          {!isFirebaseAvailable && (
            <button type="button" onClick={() => { setEmail('demo@example.com'); setPassword('demo'); }} style={s.secondary}>Fill demo login</button>
          )}

          <button type="button" onClick={() => { setIsLogin(!isLogin); setError(''); }} style={s.link}>
            {isLogin ? "New here? Create an account" : 'Already have an account? Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  label: { display: 'block', fontSize: 12, color: COLORS.textMuted, margin: '12px 0 6px', fontWeight: 500 },
  input: {
    width: '100%', padding: '11px 13px', background: COLORS.bgDeep, border: `1px solid ${COLORS.border}`,
    borderRadius: 12, color: COLORS.text, fontSize: 14, outline: 'none',
  },
  cta: {
    width: '100%', marginTop: 20, padding: '12px', background: COLORS.gradientCta, color: '#04121a', border: 'none',
    borderRadius: 999, fontSize: 15, fontWeight: 700, fontFamily: FONTS.display,
  },
  secondary: {
    width: '100%', marginTop: 10, padding: '10px', background: 'transparent', color: COLORS.amber, border: `1px solid ${COLORS.amber}66`,
    borderRadius: 999, cursor: 'pointer', fontSize: 13, fontWeight: 600,
  },
  link: { display: 'block', margin: '16px auto 0', background: 'none', border: 'none', color: COLORS.teal, cursor: 'pointer', fontSize: 13 },
  note: { border: '1px solid', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 12 },
};
