/**
 * First launch on a device: download Bangalore before entering the app, the way a game
 * downloads its data after install. Roads, junctions, signals and map tiles (~55 MB) are
 * saved on the device; afterwards the app opens from the device and only live traffic
 * comes over the network. Skipping is allowed (remembered); the side panel offers it later.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { downloadOfflineMap, OFFLINE_SKIP_KEY, type OfflineProgress } from '../services/offlineMap';
import { progressiveLoader } from '../services/progressiveLoader';

export default function OfflineSetup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'ask' | 'roads' | 'tiles' | 'done' | 'error'>('ask');
  const [progress, setProgress] = useState<OfflineProgress | null>(null);
  const [message, setMessage] = useState('');
  const abort = useRef<AbortController | null>(null);
  const conn = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string; saveData?: boolean } }).connection;
  const onMobileData = conn?.type === 'cellular' || conn?.saveData === true;

  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    abort.current = new AbortController();
    try {
      // Ask the browser not to clear it when storage runs low
      await navigator.storage?.persist?.().catch(() => false);
      setStep('roads');
      await progressiveLoader.downloadForOffline();
      setStep('tiles');
      const p = await downloadOfflineMap(setProgress, abort.current.signal);
      if (abort.current.signal.aborted) return;
      setMessage(p.failed > 0 ? `${p.failed} map pieces could not be saved — they load online.` : '');
      setStep('done');
      setTimeout(onDone, 900);
    } catch (err) {
      if (abort.current?.signal.aborted) return;
      setMessage((err as Error).message);
      setStep('error');
    }
  };

  const skip = () => {
    abort.current?.abort();
    try { localStorage.setItem(OFFLINE_SKIP_KEY, '1'); } catch { /* private mode */ }
    onDone();
  };

  const pct = step === 'roads' ? 3 : step === 'tiles' && progress ? 5 + Math.round(progress.done / Math.max(1, progress.total) * 95) : step === 'done' ? 100 : 0;

  return (
    <div style={s.screen}>
      <div style={s.card}>
        <div style={{ fontSize: 40 }}>🗺️</div>
        <div style={s.title}>Get Bangalore on your phone</div>
        <div style={s.text}>
          WayFinder saves the city's roads, junctions, signals and map on this device (about 55 MB, once).
          After that it opens instantly, works with weak signal, and only live traffic is downloaded.
        </div>
        {onMobileData && step === 'ask' && <div style={{ ...s.text, color: '#FFB74D' }}>You seem to be on mobile data — Wi-Fi is better for this.</div>}

        {step === 'ask' && (
          <>
            <button onClick={start} style={s.primary}>Download (≈55 MB)</button>
            <button onClick={skip} style={s.secondary}>Skip for now — load as I go</button>
          </>
        )}

        {(step === 'roads' || step === 'tiles' || step === 'done') && (
          <>
            <div style={s.bar}><div style={{ ...s.fill, width: `${pct}%` }} /></div>
            <div style={s.small}>
              {step === 'roads' && 'Saving roads, junctions and signals…'}
              {step === 'tiles' && progress && `Saving the map: ${pct}% · ${Math.round(progress.bytes / 1e6)} MB`}
              {step === 'tiles' && !progress && 'Saving the map…'}
              {step === 'done' && 'Ready!'}
            </div>
            {step !== 'done' && <button onClick={skip} style={s.secondary}>Continue without waiting</button>}
          </>
        )}

        {step === 'error' && (
          <>
            <div style={{ ...s.small, color: '#ff8a80' }}>Download stopped: {message}</div>
            <button onClick={start} style={s.primary}>Try again</button>
            <button onClick={skip} style={s.secondary}>Continue without it</button>
          </>
        )}
        {message && step === 'done' && <div style={s.small}>{message}</div>}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  screen: {
    position: 'fixed', inset: 0, background: '#0b0f19', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, boxSizing: 'border-box', zIndex: 50,
  },
  card: {
    width: '100%', maxWidth: 380, background: '#121826', border: '1px solid #1f2638', borderRadius: 16,
    padding: '24px 20px', textAlign: 'center', boxSizing: 'border-box',
  },
  title: { color: '#fff', fontSize: 20, fontWeight: 700, margin: '8px 0' },
  text: { color: '#aab', fontSize: 13, lineHeight: 1.5, marginBottom: 12 },
  small: { color: '#99a', fontSize: 12, margin: '8px 0' },
  primary: {
    width: '100%', padding: 14, background: '#4488FF', color: '#fff', border: 'none', borderRadius: 10,
    fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 8, minHeight: 48,
  },
  secondary: {
    width: '100%', padding: 10, background: 'none', color: '#8ab4ff', border: 'none', fontSize: 13,
    cursor: 'pointer', marginTop: 8, minHeight: 44,
  },
  bar: { height: 8, background: '#1f2638', borderRadius: 4, overflow: 'hidden', marginTop: 8 },
  fill: { height: '100%', background: '#4488FF', transition: 'width 0.3s' },
};
