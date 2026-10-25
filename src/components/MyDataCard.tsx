/**
 * "My data": saved places (home, work, favourites — on this device and in the account),
 * the user's files (photos, documents; a photo can go with their latest road report) and
 * what WayFinder keeps on this device.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { serverClient, type FileMeta, type FilePurpose } from '../services/serverClient';
import {
  loadPlaces, savePlace, removePlace, uploadFile, fileUrl, deviceStorage, clearRoadTiles, type SavedPlace,
} from '../services/userData';
import { pushToast } from './Toast';

interface Props {
  uid: string;
  /** Where the trip planner's destination is now (to save it), if set */
  current: { lat: number; lng: number; name: string } | null;
  /** Go to a saved place (sets it as the destination) */
  onGo: (place: SavedPlace) => void;
  /** The user's latest road report, to attach a photo to */
  lastReportId: string | null;
}

const KIND_ICON = { home: '🏠', work: '💼', favourite: '⭐' } as const;

export default function MyDataCard({ uid, current, onGo, lastReportId }: Props) {
  const [open, setOpen] = useState(false);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [used, setUsed] = useState(0);
  const [device, setDevice] = useState<Awaited<ReturnType<typeof deviceStorage>>>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const purpose = useRef<{ purpose: FilePurpose; reportId?: string }>({ purpose: 'document' });

  useEffect(() => { loadPlaces(uid).then(setPlaces); }, [uid]);
  useEffect(() => {
    if (!open) return;
    serverClient.listFiles().then(r => { setFiles(r.files); setUsed(r.usedBytes); }).catch(() => {});
    deviceStorage().then(setDevice);
  }, [open, uid]);

  const pick = (p: FilePurpose, reportId?: string) => { purpose.current = { purpose: p, reportId }; input.current?.click(); };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const meta = await uploadFile(file, purpose.current.purpose, purpose.current.reportId);
      setFiles(f => [meta, ...f]); setUsed(u => u + meta.size);
      pushToast(meta.purpose === 'report-photo' ? 'Photo added to your report' : 'Saved to your account', 'success');
    } catch (err) {
      pushToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const openFile = async (f: FileMeta) => {
    try { window.open(await fileUrl(f.id), '_blank', 'noopener'); } catch (err) { pushToast((err as Error).message, 'error'); }
  };
  const remove = async (f: FileMeta) => {
    try { await serverClient.deleteFile(f.id); setFiles(list => list.filter(x => x.id !== f.id)); setUsed(u => u - f.size); }
    catch (err) { pushToast((err as Error).message, 'error'); }
  };

  return (
    <div style={{ padding: '10px 14px', borderTop: '1px solid #222' }}>
      {/* Saved places are always visible: one tap to go there */}
      {places.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {places.sort((a, b) => a.kind.localeCompare(b.kind)).map(p => (
            <button key={p.id} onClick={() => onGo(p)} title={p.name} style={s.chip}>{KIND_ICON[p.kind]} {p.kind === 'favourite' ? p.name.slice(0, 18) : p.kind}</button>
          ))}
        </div>
      )}
      <button onClick={() => setOpen(o => !o)} style={s.head}>{open ? '▾' : '▸'} My data</button>
      {open && (
        <div>
          <div style={s.label}>Saved places</div>
          {current ? (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
              {(['home', 'work', 'favourite'] as const).map(kind => (
                <button key={kind} style={s.small} onClick={async () => setPlaces(await savePlace(uid, { ...current, kind }))}>
                  Save “{current.name.slice(0, 16)}” as {KIND_ICON[kind]} {kind}
                </button>
              ))}
            </div>
          ) : <div style={s.muted}>Pick a destination, then save it here as home, work or a favourite.</div>}
          {places.map(p => (
            <div key={p.id} style={s.row}>
              <span style={{ flex: 1 }}>{KIND_ICON[p.kind]} {p.name}</span>
              <button style={s.link} onClick={async () => setPlaces(await removePlace(uid, p.id))}>remove</button>
            </div>
          ))}

          <div style={s.label}>My files · {(used / 1e6).toFixed(1)} MB of 100 MB</div>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture={undefined}
            style={{ display: 'none' }} onChange={e => onFile(e.target.files?.[0])} />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
            <button disabled={busy} style={s.small} onClick={() => pick('document')}>{busy ? 'Uploading…' : '⬆ Add a photo or PDF'}</button>
            {lastReportId && <button disabled={busy} style={s.small} onClick={() => pick('report-photo', lastReportId)}>📷 Photo for my last report</button>}
          </div>
          {files.length === 0 && <div style={s.muted}>No files yet.</div>}
          {files.slice(0, 20).map(f => (
            <div key={f.id} style={s.row}>
              <button style={{ ...s.link, flex: 1, textAlign: 'left' }} onClick={() => openFile(f)}>
                {f.type === 'application/pdf' ? '📄' : '🖼'} {f.name} <span style={{ color: '#666' }}>· {Math.round(f.size / 1024)} KB{f.purpose === 'report-photo' ? ' · report photo' : ''}</span>
              </button>
              <button style={s.link} onClick={() => remove(f)}>delete</button>
            </div>
          ))}

          <div style={s.label}>On this device</div>
          {device ? (
            <div style={s.muted}>
              {device.usedMB} MB used (maps, roads, signals){device.persisted ? ' · kept by the browser' : ' · may be cleared when space is low'}
            </div>
          ) : <div style={s.muted}>Storage details not available in this browser.</div>}
          <button style={{ ...s.small, marginTop: 4 }} onClick={async () => { await clearRoadTiles(); setDevice(await deviceStorage()); pushToast('Saved road tiles cleared — they download again as needed', 'success'); }}>
            Free space (road tiles)
          </button>
        </div>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  head: { background: 'none', border: 'none', color: '#9ab', cursor: 'pointer', padding: '4px 0', fontSize: 12, width: '100%', textAlign: 'left' },
  label: { fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 4px', fontWeight: 600 },
  muted: { fontSize: 11, color: '#777' },
  row: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#ddd', padding: '3px 0', borderBottom: '1px solid #1a1a2e' },
  chip: { padding: '6px 10px', fontSize: 12, borderRadius: 14, background: '#1a1a2e', color: '#ddd', border: '1px solid #2a2a40', cursor: 'pointer', textTransform: 'capitalize' },
  small: { padding: '6px 9px', fontSize: 11, borderRadius: 6, background: '#1a1a2e', color: '#ccc', border: '1px solid #2a2a40', cursor: 'pointer' },
  link: { background: 'none', border: 'none', color: '#4FC3F7', cursor: 'pointer', padding: 0, fontSize: 11 },
};
