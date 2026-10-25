/**
 * Police view: every signalised junction by permanent ID, worst first, with filters.
 * Selecting one opens the control console (JunctionConsole): live diagram, cycle,
 * give-green buttons, timing editor and details.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { serverClient, type JunctionSummary, type JunctionDetail, type ControlLogEntry, type MovementRow, type CoordinationPlan } from '../services/serverClient';
import JunctionConsole from './JunctionConsole';

interface Props {
  canControl: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Move the map to a junction */
  onFocus: (lat: number, lng: number) => void;
  /** Coordination preview to draw on the map (stable callback) */
  onPreview?: (plan: CoordinationPlan | null) => void;
}

const STATUS_COLOR: Record<JunctionSummary['status'], string> = { ok: '#4CAF50', busy: '#FF9800', critical: '#F44336' };
type Filter = 'attention' | 'all' | 'near';

/** Metres between two points (good enough within a city). */
function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const kx = 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 111320);
}

export default function JunctionPanel({ canControl, selectedId, onSelect, onFocus, onPreview }: Props) {
  const [list, setList] = useState<JunctionSummary[]>([]);
  const [detail, setDetail] = useState<JunctionDetail | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('attention');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState<string[]>([]);
  const [log, setLog] = useState<ControlLogEntry[]>([]);
  const [movements, setMovements] = useState<{ hours: number; rows: MovementRow[] } | null>(null);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  // Officer on the street: junctions sorted by distance from where they stand
  const nearMe = () => {
    if (!navigator.geolocation) { setError('Location is not available on this device'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => { setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setFilter('near'); setError(null); },
      () => setError('Allow location to find the junctions near you'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  // Turning movements for the open junction (refreshed every 30 s)
  useEffect(() => {
    if (!selectedId) { setMovements(null); return; }
    let alive = true;
    const load = () => serverClient.junctionMovements(selectedId, 1).then(m => { if (alive) setMovements(m); }).catch(() => {});
    load();
    const t = window.setInterval(load, 30000);
    return () => { alive = false; window.clearInterval(t); };
  }, [selectedId]);

  const downloadCsv = async (junction?: string) => {
    try {
      const blob = await serverClient.countsCsv(24, junction);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wayfinder-junction-counts-${junction ?? 'all'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Junction list, refreshed every 10 s
  useEffect(() => {
    let alive = true;
    const load = () => serverClient.listJunctions()
      .then(j => { if (alive) { setList(j); setError(null); } })
      .catch(err => alive && setError(err.message));
    load();
    const t = window.setInterval(load, 10000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  // Selected junction, refreshed every 2 s
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let alive = true;
    const load = () => serverClient.getJunction(selectedId)
      .then(d => { if (alive) { setDetail(d); setFetchedAt(Date.now()); } })
      .catch(err => alive && setError(err.message));
    load();
    const t = window.setInterval(load, 2000);
    return () => { alive = false; window.clearInterval(t); };
  }, [selectedId]);

  useEffect(() => { setChanges([]); }, [selectedId]);

  useEffect(() => {
    if (!canControl) return;
    serverClient.controlLog().then(setLog).catch(() => {});
  }, [canControl, changes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return list.filter(j => j.id.toLowerCase().includes(q) || j.name.toLowerCase().includes(q));
    if (filter === 'near' && me) return [...list].sort((a, b) => metresBetween(me, a) - metresBetween(me, b)).slice(0, 15);
    return filter === 'attention' ? list.filter(j => j.status !== 'ok' || j.controlled) : list;
  }, [list, query, filter, me]);

  const act = async (fn: () => Promise<{ changes: string[] }>) => {
    setBusy(true);
    try {
      const r = await fn();
      setChanges(r.changes);
      setError(null);
      if (selectedId) { setDetail(await serverClient.getJunction(selectedId)); setFetchedAt(Date.now()); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const select = (j: { id: string; lat?: number; lng?: number }) => {
    onSelect(j.id);
    const known = j.lat !== undefined ? j : list.find(x => x.id === j.id);
    if (known?.lat !== undefined && known.lng !== undefined) onFocus(known.lat, known.lng);
  };

  const counts = { critical: 0, busy: 0, ok: 0 };
  for (const j of list) counts[j.status]++;

  return (
    <div style={{ padding: '12px 14px', borderTop: '1px solid #222' }}>
      {error && <div style={{ color: '#F44336', fontSize: 11, marginBottom: 6 }}>{error}</div>}

      {detail ? (
        <JunctionConsole
          detail={detail} fetchedAt={fetchedAt} canControl={canControl} movements={movements}
          onBack={() => onSelect(null)} onSelect={id => select({ id })} onAction={act} busy={busy} changes={changes}
          onDownloadCsv={() => downloadCsv(detail.id)} onPreview={onPreview}
        />
      ) : (
        <>
          <div style={styles.title}>Junction control · {list.length} signals</div>
          <div style={{ display: 'flex', gap: 10, fontSize: 11, marginBottom: 8 }}>
            <span style={{ color: STATUS_COLOR.critical }}>● {counts.critical} critical</span>
            <span style={{ color: STATUS_COLOR.busy }}>● {counts.busy} busy</span>
            <span style={{ color: STATUS_COLOR.ok }}>● {counts.ok} ok</span>
          </div>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search junction by name or ID" style={styles.input} />
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            {([['attention', `⚠ Attention (${counts.critical + counts.busy})`], ['all', 'All']] as const).map(([f, label]) => (
              <button key={f} onClick={() => setFilter(f)} style={{ ...styles.tab, ...(filter === f ? styles.tabOn : {}) }}>{label}</button>
            ))}
            <button onClick={nearMe} style={{ ...styles.tab, ...(filter === 'near' ? styles.tabOn : {}) }}>📍 Near me</button>
          </div>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {filtered.length === 0 && <div style={{ fontSize: 11, color: '#666', padding: 8 }}>{query ? 'No junction matches.' : 'All junctions are flowing.'}</div>}
            {filtered.slice(0, 100).map(j => (
              <button key={j.id} onClick={() => select(j)} style={styles.row}>
                <span style={{ color: STATUS_COLOR[j.status], fontSize: 14 }}>●</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', color: '#ddd', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
                  <span style={{ color: '#666', fontSize: 10, fontFamily: 'monospace' }}>
                    {filter === 'near' && me ? `${Math.round(metresBetween(me, j))} m · ` : ''}{j.id} · {j.queueVehicles} queued · cycle {j.cycle}s{j.controlled ? ' · ● controlled' : ''}
                  </span>
                </span>
                <span style={{ color: '#4FC3F7', fontSize: 12 }}>›</span>
              </button>
            ))}
          </div>
          <button onClick={() => downloadCsv()} style={{ ...styles.link, marginTop: 6 }}>⬇ Movement counts for all junctions (CSV, 24 h)</button>
        </>
      )}

      {canControl && log.length > 0 && (
        <>
          <div style={styles.title}>Recent changes</div>
          {log.slice(0, 6).map((e, i) => (
            <div key={i} style={{ fontSize: 10, color: '#777', marginBottom: 3 }}>
              {new Date(e.at).toLocaleTimeString()} · {e.junction} · {e.action} {e.detail} · {e.by}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  title: { fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1, margin: '6px 0', fontWeight: 600 },
  input: {
    width: '100%', padding: '8px 10px', marginBottom: 6, background: '#111', border: '1px solid #333',
    borderRadius: 6, color: '#ddd', fontSize: 12, boxSizing: 'border-box',
  },
  // minWidth 0 + ellipsis: three tabs must fit a phone's width
  tab: {
    flex: 1, minWidth: 0, padding: '6px 4px', fontSize: 11, borderRadius: 6, background: '#1a1a2e', color: '#aaa',
    border: '1px solid #2a2a40', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minHeight: 36,
  },
  tabOn: { background: '#4488FF33', color: '#fff', borderColor: '#4488FF' },
  row: {
    display: 'flex', gap: 8, alignItems: 'center', width: '100%', padding: '8px 4px', background: 'none',
    border: 'none', borderBottom: '1px solid #1a1a2e', cursor: 'pointer', textAlign: 'left', minHeight: 44,
  },
  link: { background: 'none', border: 'none', color: '#4FC3F7', cursor: 'pointer', padding: 0, fontSize: 11 },
};
