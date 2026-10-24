/**
 * "Use Bangalore offline": downloads the map for the whole city to this device. Roads,
 * junctions and signals are saved automatically whenever the app loads them.
 */
import { useEffect, useRef, useState } from 'react';
import { downloadOfflineMap, offlineMapInfo, storageUsedMb, type OfflineProgress } from '../services/offlineMap';

export default function OfflineCard({ online }: { online: boolean }) {
  const [progress, setProgress] = useState<OfflineProgress | null>(null);
  const [info, setInfo] = useState(offlineMapInfo);
  const [usedMb, setUsedMb] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { storageUsedMb().then(setUsedMb); }, [info]);

  const start = async () => {
    abortRef.current = new AbortController();
    try {
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
          {info ? 'Update offline Bangalore map' : '⬇ Download Bangalore for offline use (~50 MB)'}
        </button>
      )}
    </div>
  );
}
