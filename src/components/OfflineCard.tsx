/**
 * "Use Bangalore offline": downloads the map for the whole city to this device — map tiles
 * and the road network with junctions and signals (~55 MB) — so later visits load from the
 * device and only live traffic comes over the network. Suggested once to new users.
 */
import { useEffect, useRef, useState } from 'react';
import { downloadOfflineMap, offlineMapInfo, storageUsedMb, type OfflineProgress } from '../services/offlineMap';
import { progressiveLoader } from '../services/progressiveLoader';

import { OFFLINE_SKIP_KEY as PROMPT_KEY } from './OfflineSetup';
function promptDismissed(): boolean {
  try { return localStorage.getItem(PROMPT_KEY) === '1'; } catch { return true; }
}

export default function OfflineCard({ online }: { online: boolean }) {
  const [progress, setProgress] = useState<OfflineProgress | null>(null);
  const [info, setInfo] = useState(offlineMapInfo);
  const [usedMb, setUsedMb] = useState<number | null>(null);
  const [showPrompt, setShowPrompt] = useState(() => !offlineMapInfo() && !promptDismissed());
  const dismiss = () => { setShowPrompt(false); try { localStorage.setItem(PROMPT_KEY, '1'); } catch { /* private mode */ } };
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { storageUsedMb().then(setUsedMb); }, [info]);

  const start = async () => {
    abortRef.current = new AbortController();
    setShowPrompt(false);
    try {
      await progressiveLoader.downloadForOffline().catch(err => console.warn('Road network not saved:', err));
      await downloadOfflineMap(setProgress, abortRef.current.signal);
      setInfo(offlineMapInfo());
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  };

  const downloading = progress !== null;
  return (
    <div style={{ padding: '10px 14px', borderTop: '1px solid #222', fontSize: 11, color: '#999' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: online ? '#4CAF50' : '#FF9800' }}>●</span>
        <span style={{ flex: 1 }}>
          {online ? 'Online' : 'Offline — showing saved map; routes use typical speeds'}
          {info && <span style={{ color: '#666' }}> · city map saved {new Date(info.at).toLocaleDateString()}{usedMb !== null ? ` (${usedMb} MB)` : ''}</span>}
        </span>
      </div>
      {showPrompt && online && !downloading && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: '#12233d', border: '1px solid #2c4a7a', borderRadius: 8, color: '#cfe0ff' }}>
          Save Bangalore on this device (~55 MB, best on Wi-Fi)? The app then opens faster and
          only live traffic is downloaded each time.
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button onClick={start} style={{ flex: 1, padding: 6, background: '#4488FF', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>Download</button>
            <button onClick={dismiss} style={{ padding: '6px 10px', background: 'none', color: '#9ab', border: '1px solid #2c4a7a', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>Not now</button>
          </div>
        </div>
      )}
      {downloading ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ height: 4, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${Math.round(progress.done / Math.max(1, progress.total) * 100)}%`, height: '100%', background: '#4488FF' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span>{progress.done} / {progress.total} files · {Math.round(progress.bytes / 1e6)} MB</span>
            <button onClick={() => abortRef.current?.abort()} style={{ background: 'none', border: 'none', color: '#4FC3F7', cursor: 'pointer', fontSize: 11 }}>Stop</button>
          </div>
        </div>
      ) : online && (
        <button onClick={start} style={{
          marginTop: 6, width: '100%', padding: '7px', background: '#1a2a44', color: '#cfe0ff',
          border: '1px solid #2c4a7a', borderRadius: 6, cursor: 'pointer', fontSize: 11,
        }}>
          {info ? 'Update offline Bangalore map' : '⬇ Download Bangalore for offline use (~55 MB)'}
        </button>
      )}
    </div>
  );
}
