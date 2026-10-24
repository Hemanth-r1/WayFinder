/**
 * Police view: every signalised junction by permanent ID, worst first. Selecting one
 * shows its approaches (live light, queue, arrivals), the recommended timing, advice for
 * neighbouring junctions and — for controllers — controls to try changes in the
 * simulation (hold a green with coordinated neighbours, apply a timing plan, reset).
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { serverClient, type JunctionSummary, type JunctionDetail, type ControlLogEntry, type MovementRow } from '../services/serverClient';

interface Props {
  canControl: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Move the map to a junction */
  onFocus: (lat: number, lng: number) => void;
}

const STATUS_COLOR: Record<JunctionSummary['status'], string> = { ok: '#4CAF50', busy: '#FF9800', critical: '#F44336' };
const LIGHT_COLOR = { RED: '#FF1744', YELLOW: '#FFD600', GREEN: '#00E676' } as const;

export default function JunctionPanel({ canControl, selectedId, onSelect, onFocus }: Props) {
  const [list, setList] = useState<JunctionSummary[]>([]);
  const [detail, setDetail] = useState<JunctionDetail | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState<string[]>([]);
  const [coordinate, setCoordinate] = useState(true);
  const [holdSeconds, setHoldSeconds] = useState(60);
  const [log, setLog] = useState<ControlLogEntry[]>([]);
  const [movements, setMovements] = useState<{ hours: number; rows: MovementRow[] } | null>(null);

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
      .then(d => { if (alive) setDetail(d); })
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
    return q ? list.filter(j => j.id.toLowerCase().includes(q) || j.name.toLowerCase().includes(q)) : list;
  }, [list, query]);

  const act = async (fn: () => Promise<{ changes: string[] }>) => {
    setBusy(true);
    try {
      const r = await fn();
      setChanges(r.changes);
      if (selectedId) setDetail(await serverClient.getJunction(selectedId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const select = (j: { id: string; lat?: number; lng?: number }) => {
    onSelect(j.id);
    if (j.lat !== undefined && j.lng !== undefined) onFocus(j.lat, j.lng);
  };

  const counts = { critical: 0, busy: 0, ok: 0 };
  for (const j of list) counts[j.status]++;

  return (
    <div style={{ padding: '12px 14px', borderTop: '1px solid #222' }}>
      <div style={styles.title}>Junctions · {list.length}</div>
      <div style={{ display: 'flex', gap: 10, fontSize: 11, marginBottom: 8 }}>
        <span style={{ color: STATUS_COLOR.critical }}>● {counts.critical} critical</span>
        <span style={{ color: STATUS_COLOR.busy }}>● {counts.busy} busy</span>
        <span style={{ color: STATUS_COLOR.ok }}>● {counts.ok} ok</span>
      </div>
      {error && <div style={{ color: '#F44336', fontSize: 11, marginBottom: 6 }}>{error}</div>}

      {!detail && (
        <>
          <input
            value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by ID or road name"
            style={styles.input}
          />
          <button onClick={() => downloadCsv()} style={{ ...styles.link, marginBottom: 6 }}>⬇ Download movement counts for all junctions (CSV, 24 h)</button>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {filtered.slice(0, 80).map(j => (
              <button key={j.id} onClick={() => select(j)} style={styles.row}>
                <span style={{ color: STATUS_COLOR[j.status], fontSize: 14 }}>●</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', color: '#ddd', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
                  <span style={{ color: '#666', fontSize: 10, fontFamily: 'monospace' }}>
                    {j.id} · {j.queueVehicles} queued · cycle {j.cycle}s{j.controlled ? ' · controlled' : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {detail && (
        <div>
          <button onClick={() => onSelect(null)} style={styles.link}>← All junctions</button>
          <div style={{ color: '#fff', fontSize: 14, fontWeight: 600, marginTop: 4 }}>{detail.name}</div>
          <div style={{ color: '#777', fontSize: 11, fontFamily: 'monospace', marginBottom: 8 }}>
            {detail.id} · <span style={{ color: STATUS_COLOR[detail.status] }}>{detail.status}</span> · flow ratio {detail.recommendation.saturation} ·
            cycle {detail.cycle}s · now {detail.phase.group} {detail.phase.color.toLowerCase()} {detail.phase.timer}/{detail.phase.duration}s
          </div>

          <div style={styles.label}>Approaches</div>
          {detail.approaches.map(a => (
            <div key={a.edgeId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, padding: '4px 0', borderBottom: '1px solid #1a1a2e' }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: LIGHT_COLOR[a.light], flexShrink: 0 }} />
              <span style={{ color: '#aaa', width: 14 }}>{a.group}</span>
              <span style={{ flex: 1, color: '#ddd', minWidth: 0 }}>
                {a.road || 'Unnamed road'}
                {a.direction && <span style={{ display: 'block', color: '#888', fontSize: 10 }}>{a.direction}</span>}
                {a.feeders.filter(f => f.kind !== 'road' || f.arrivalsPerHour >= 100).slice(0, 3).map(f => (
                  <span key={f.edgeId} style={{ display: 'block', color: f.kind === 'flyover' ? '#CE93D8' : '#777', fontSize: 10 }}>
                    ↳ {f.kind === 'flyover' ? '🛣 ' : f.kind === 'ramp' ? '↗ ' : ''}{f.road}{f.from ? ` from ${f.from}` : ''} · {f.arrivalsPerHour}/h, joins {f.metres} m before
                  </span>
                ))}
                {a.from && (
                  <button onClick={() => select({ id: a.from!.id })} style={{ ...styles.link, display: 'block', fontSize: 10 }}>
                    from {a.from.name} ({a.from.metres} m)
                  </button>
                )}
              </span>
              <span style={{ color: a.overLimit ? '#F44336' : a.queueVehicles > 20 ? '#FF9800' : '#888', textAlign: 'right', fontFamily: 'monospace' }}>
                {a.queueVehicles} q · {a.queueMetres} m<br />{a.arrivalsPerHour}/h
                <br />wait {a.waitSeconds >= 60 ? `${Math.floor(a.waitSeconds / 60)}m${a.waitSeconds % 60}s` : `${a.waitSeconds}s`}{a.overLimit ? ' ⚠' : ''}
              </span>
            </div>
          ))}

          <div style={styles.label}>Recommended timing</div>
          <div style={{ fontSize: 12, color: '#ddd' }}>{detail.recommendation.summary}</div>
          <div style={{ fontSize: 10, color: '#666', marginTop: 2, fontFamily: 'monospace' }}>
            now: {Object.entries(detail.greens).map(([g, s]) => `${g} ${s}s`).join(' · ')} → suggested:{' '}
            {Object.entries(detail.recommendation.greens).map(([g, s]) => `${g} ${s}s`).join(' · ')} (cycle {detail.recommendation.cycle}s)
          </div>

          {detail.advice.length > 0 && (
            <>
              <div style={styles.label}>Neighbouring junctions</div>
              {detail.advice.map((a, i) => <div key={i} style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>• {a}</div>)}
            </>
          )}

          {detail.merges.length > 0 && (
            <>
              <div style={styles.label}>Joining just after the junction</div>
              {detail.merges.map(m => (
                <div key={m.edgeId} style={{ fontSize: 11, color: m.kind === 'flyover' ? '#CE93D8' : '#aaa', marginBottom: 3 }}>
                  {m.kind === 'flyover' ? '🛣 ' : m.kind === 'ramp' ? '↗ ' : '• '}{m.road}{m.from ? ` (from ${m.from})` : ''} joins {m.joins} {m.metres} m after · {m.arrivalsPerHour}/h
                </div>
              ))}
            </>
          )}

          {movements && (
            <>
              <div style={styles.label}>Movements · last {movements.hours >= 1 ? `${movements.hours} h` : `${Math.round(movements.hours * 60)} min`} (estimated, per hour)</div>
              {movements.rows.length === 0 && <div style={{ fontSize: 11, color: '#666' }}>Counting… vehicles are counted as they cross the junction.</div>}
              {movements.rows.slice(0, 10).map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '3px 0', borderBottom: '1px solid #1a1a2e' }}>
                  <span style={{ width: 52, color: '#888' }}>{r.turn === 'straight' ? '↑ straight' : r.turn === 'left' ? '↰ left' : r.turn === 'right' ? '↱ right' : '↶ U-turn'}</span>
                  <span style={{ flex: 1, color: '#ccc', minWidth: 0 }}>{r.fromRoad} → {r.toRoad}</span>
                  <span style={{ color: '#ddd', fontFamily: 'monospace', textAlign: 'right' }}>
                    {r.vehiclesPerHour}/h<br /><span style={{ color: '#777' }}>{r.personsPerHour} people/h</span>
                  </span>
                </div>
              ))}
              <button onClick={() => downloadCsv(detail.id)} style={{ ...styles.link, marginTop: 6 }}>⬇ Download this junction's counts (CSV, 24 h)</button>
            </>
          )}

          {detail.control && (
            <div style={{ fontSize: 11, color: '#4FC3F7', marginTop: 8 }}>
              {detail.control.hold && <div>Holding {detail.control.hold.group} green until {new Date(detail.control.hold.until).toLocaleTimeString()}</div>}
              {detail.control.plan && <div>Plan: {Object.entries(detail.control.plan.greens).map(([g, s]) => `${g} ${s}s`).join(', ')}</div>}
              {detail.control.scale && <div>{detail.control.scale.group} green at {Math.round(detail.control.scale.factor * 100)}% (coordination)</div>}
            </div>
          )}

          {canControl ? (
            <div style={{ marginTop: 10 }}>
              <div style={styles.label}>Try in simulation</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, fontSize: 11, color: '#aaa' }}>
                Hold green for
                <select value={holdSeconds} onChange={e => setHoldSeconds(Number(e.target.value))} style={styles.select}>
                  {[30, 60, 90, 120, 180].map(s => <option key={s} value={s}>{s} s</option>)}
                </select>
                <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input type="checkbox" checked={coordinate} onChange={e => setCoordinate(e.target.checked)} /> coordinate neighbours
                </label>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {Object.keys(detail.greens).map(g => (
                  <button key={g} disabled={busy} onClick={() => act(() => serverClient.holdJunction(detail.id, g, holdSeconds, coordinate))} style={styles.button}>
                    Hold {g} ({detail.approaches.find(a => a.group === g)?.road || g})
                  </button>
                ))}
                <button disabled={busy} onClick={() => act(() => serverClient.planJunction(detail.id, 'recommended'))} style={{ ...styles.button, background: '#2E7D32' }}>
                  Apply suggested timing
                </button>
                <button disabled={busy} onClick={() => act(() => serverClient.resetJunction(detail.id))} style={{ ...styles.button, background: '#333' }}>
                  Reset
                </button>
                <button disabled={busy} onClick={() => act(() => serverClient.surgeJunction(detail.id))} style={{ ...styles.button, background: '#6A1B9A' }}
                  title="Demo / training: fills every approach bumper-to-bumper for 600 m">
                  Fill to 100% (demo)
                </button>
              </div>
              {changes.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#81C784' }}>
                  {changes.map((c, i) => <div key={i}>✓ {c}</div>)}
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 10, color: '#666', marginTop: 10 }}>Only controllers can change signals.</div>
          )}

          {detail.neighbours.upstream.length + detail.neighbours.downstream.length > 0 && (
            <>
              <div style={styles.label}>Linked junctions</div>
              {[...detail.neighbours.upstream.map(n => ({ ...n, dir: 'from' })), ...detail.neighbours.downstream.map(n => ({ ...n, dir: 'to' }))].map((n, i) => (
                <button key={i} onClick={() => select({ id: n.id })} style={{ ...styles.link, display: 'block', fontSize: 11, textAlign: 'left' }}>
                  {n.dir === 'from' ? '↘ from' : '↗ to'} {n.name} · {n.metres} m · {n.seconds} s ({n.id})
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {canControl && log.length > 0 && (
        <>
          <div style={styles.label}>Recent changes</div>
          {log.slice(0, 6).map((e, i) => (
            <div key={i} style={{ fontSize: 10, color: '#777', marginBottom: 3 }}>
              {new Date(e.at).toLocaleTimeString()} · {e.junction} · {e.action} · {e.by}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  title: { fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, fontWeight: 600 },
  label: { fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 4px' },
  input: {
    width: '100%', padding: '7px 9px', marginBottom: 6, background: '#111', border: '1px solid #333',
    borderRadius: 6, color: '#ddd', fontSize: 12,
  },
  row: {
    display: 'flex', gap: 8, alignItems: 'center', width: '100%', padding: '6px 4px', background: 'none',
    border: 'none', borderBottom: '1px solid #1a1a2e', cursor: 'pointer', textAlign: 'left',
  },
  link: { background: 'none', border: 'none', color: '#4FC3F7', cursor: 'pointer', padding: 0, fontSize: 11 },
  button: {
    padding: '7px 10px', background: '#1565C0', color: '#fff', border: 'none', borderRadius: 6,
    cursor: 'pointer', fontSize: 11, fontWeight: 600,
  },
  select: { background: '#111', color: '#ddd', border: '1px solid #333', borderRadius: 4, fontSize: 11 },
};
