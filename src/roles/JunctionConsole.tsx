/**
 * Police control console for one junction: a live diagram of its roads (light, countdown,
 * queue and wait per approach — tap a road to give it green), the signal cycle, a timing
 * editor, alerts, and the details (feeders, movements, neighbours) folded away.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { serverClient, type JunctionDetail, type MovementRow, type CoordinationPlan, type CoordAction } from '../services/serverClient';
import { groupTiming } from '../utils/signalTiming';
import { COORD_COLOR } from '../components/mapLayers';
import TurnsEditor from './TurnsEditor';
import type { TrafficSignal } from '../types';

const LIGHT = { RED: '#FF1744', YELLOW: '#FFD600', GREEN: '#00E676' } as const;
const STATUS = { ok: '#4CAF50', busy: '#FF9800', critical: '#F44336' } as const;
const HOLD_CHOICES = [30, 60, 90, 120, 180];

interface Props {
  detail: JunctionDetail;
  /** When the detail was fetched (ms), to run the countdowns between refreshes */
  fetchedAt: number;
  canControl: boolean;
  movements: { hours: number; rows: MovementRow[] } | null;
  onBack: () => void;
  onSelect: (id: string) => void;
  onAction: (fn: () => Promise<{ changes: string[] }>) => Promise<void>;
  busy: boolean;
  changes: string[];
  onDownloadCsv: () => void;
  /** The coordination preview being shown (null when closed), for the map */
  onPreview?: (plan: CoordinationPlan | null) => void;
}

/** "Tumkur Road" or "Tumkur Road + Outer Ring Road" for a signal group. */
function groupName(d: JunctionDetail, g: string): string {
  const roads = [...new Set(d.approaches.filter(a => a.group === g).map(a => a.road || 'Unnamed road'))];
  return roads.join(' + ') || g;
}

function fmt(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`;
}

export default function JunctionConsole({ detail, fetchedAt, canControl, movements, onBack, onSelect, onAction, busy, changes, onDownloadCsv, onPreview }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(t); }, []);
  const elapsed = Math.max(0, (now - fetchedAt) / 1000);

  const groups = useMemo(() => Object.keys(detail.greens), [detail.greens]);
  const sig = useMemo(() => ({ phases: detail.phases, currentPhaseIndex: detail.phase.index, timer: detail.phase.timer }) as unknown as TrafficSignal,
    [detail.phases, detail.phase.index, detail.phase.timer]);
  const timing = (g: string) => groupTiming(sig, g, elapsed);

  const [picked, setPicked] = useState<string | null>(null);
  const [holdFor, setHoldFor] = useState(60);
  const [coordinate, setCoordinate] = useState(true);
  const [draft, setDraft] = useState<Record<string, number>>(detail.greens);
  // New junction (or the plan changed elsewhere): start the editor from what runs now
  const greensKey = JSON.stringify(detail.greens);
  useEffect(() => { setDraft(JSON.parse(greensKey)); }, [detail.id, greensKey]);
  useEffect(() => { setPicked(null); }, [detail.id]);

  // Coordinated hold: preview what the neighbours will do (also drawn on the map), then confirm
  const [plan, setPlanState] = useState<CoordinationPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const setPlan = (p: CoordinationPlan | null) => { setPlanState(p); onPreview?.(p); };
  useEffect(() => () => onPreview?.(null), [detail.id, onPreview]);
  useEffect(() => { setPlanState(null); }, [detail.id]);
  const preview = async (g: string) => {
    setPlanning(true); setPlanError(null);
    try { setPlan(await serverClient.previewCoordination(detail.id, g, holdFor)); }
    catch (err) { setPlanError((err as Error).message); }
    finally { setPlanning(false); }
  };
  const confirm = async () => {
    if (!plan) return;
    const { group } = plan;
    setPlan(null);
    await onAction(() => serverClient.holdJunction(detail.id, group, holdFor, true));
  };

  const lost = detail.phases.filter(p => p.color !== 'GREEN').reduce((t, p) => t + p.duration, 0);
  const draftCycle = groups.reduce((t, g) => t + (draft[g] ?? 0), 0) + lost;
  const draftChanged = groups.some(g => draft[g] !== detail.greens[g]);
  const alerts = [
    ...detail.approaches.filter(a => a.overLimit).map(a => `${a.road || 'An approach'} (${a.direction.split(',')[0]}): drivers wait ${fmt(a.waitSeconds)} — over 5 min`),
    ...detail.advice.filter(a => /reaches|spill/i.test(a)),
  ];

  return (
    <div>
      <button onClick={onBack} style={s.link}>← All junctions</button>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
        <div style={{ color: '#fff', fontSize: 15, fontWeight: 700, flex: 1 }}>{detail.name}</div>
        <span style={{ ...s.chip, background: STATUS[detail.status] + '33', color: STATUS[detail.status] }}>{detail.status}</span>
      </div>
      <div style={{ color: '#777', fontSize: 11, fontFamily: 'monospace', marginBottom: 6 }}>
        {detail.id} · cycle {detail.cycle}s · flow {Math.round(detail.recommendation.saturation * 100)}% of capacity
      </div>

      {alerts.length > 0 && (
        <div style={{ background: '#3a1010', border: '1px solid #7a2020', borderRadius: 8, padding: '6px 8px', marginBottom: 8 }}>
          {alerts.map((a, i) => <div key={i} style={{ color: '#ff8a80', fontSize: 11 }}>⚠ {a}</div>)}
        </div>
      )}

      <Diagram detail={detail} timing={timing} picked={picked} onPick={g => setPicked(p => p === g ? null : g)} />
      <Timeline detail={detail} elapsed={elapsed} />

      {/* Live state per signal group */}
      {groups.map(g => {
        const t = timing(g);
        const queue = Math.max(0, ...detail.approaches.filter(a => a.group === g).map(a => a.queueVehicles));
        return (
          <button key={g} onClick={() => setPicked(p => p === g ? null : g)} style={{ ...s.groupRow, borderColor: picked === g ? '#4f8ef7' : '#26262e' }}>
            <span style={{ ...s.lamp, background: LIGHT[t.light], boxShadow: `0 0 8px ${LIGHT[t.light]}` }} />
            <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
              <span style={{ display: 'block', color: '#eee', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{groupName(detail, g)}</span>
              <span style={{ color: '#888', fontSize: 10 }}>green {detail.greens[g]}s · {queue} queued</span>
            </span>
            <span style={{ fontFamily: 'monospace', textAlign: 'right' }}>
              <span style={{ display: 'block', color: LIGHT[t.light], fontSize: 16, fontWeight: 700 }}>{t.changesIn}s</span>
              <span style={{ color: '#666', fontSize: 9 }}>{t.light === 'RED' ? 'to green' : t.light === 'GREEN' ? 'to amber' : 'to red'}</span>
            </span>
          </button>
        );
      })}

      {detail.control && (
        <div style={{ fontSize: 11, color: '#2fe4cc', margin: '6px 0' }}>
          {detail.control.hold && <div>● Holding {groupName(detail, detail.control.hold.group)} green until {new Date(detail.control.hold.until).toLocaleTimeString()}</div>}
          {detail.control.plan && <div>● Custom timing: {Object.entries(detail.control.plan.greens).map(([g, v]) => `${groupName(detail, g)} ${v}s`).join(', ')}</div>}
          {detail.control.scale && <div>● {groupName(detail, detail.control.scale.group)} green cut to {Math.round(detail.control.scale.factor * 100)}% (coordination)</div>}
        </div>
      )}

      {canControl ? (
        <>
          <div style={s.section}>Give green now</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {HOLD_CHOICES.map(sec => (
              <button key={sec} onClick={() => setHoldFor(sec)} style={{ ...s.pill, ...(holdFor === sec ? s.pillOn : {}) }}>{sec}s</button>
            ))}
            <label style={{ fontSize: 11, color: '#aaa', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
              <input type="checkbox" checked={coordinate} onChange={e => setCoordinate(e.target.checked)} /> also manage neighbours
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: groups.length > 1 ? '1fr 1fr' : '1fr', gap: 6 }}>
            {groups.map(g => (
              <button key={g} disabled={busy || planning} onClick={() => coordinate ? preview(g) : onAction(() => serverClient.holdJunction(detail.id, g, holdFor, false))}
                style={{ ...s.bigButton, outline: picked === g || plan?.group === g ? '2px solid #4f8ef7' : 'none' }}>
                🟢 {groupName(detail, g)}<span style={{ display: 'block', fontSize: 10, fontWeight: 400, opacity: 0.8 }}>for {holdFor}s{coordinate ? ' · preview first' : ''}</span>
              </button>
            ))}
          </div>
          {planError && <div style={{ color: '#F44336', fontSize: 11, marginTop: 4 }}>{planError}</div>}
          {plan && <PlanCard plan={plan} busy={busy} onConfirm={confirm} onCancel={() => setPlan(null)} />}

          <div style={s.section}>Green times</div>
          {groups.map(g => (
            <div key={g} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', fontSize: 11, color: '#ccc' }}>
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{groupName(detail, g)}</span>
                <span style={{ fontFamily: 'monospace', color: '#fff' }}>{draft[g]}s</span>
                <span style={{ fontFamily: 'monospace', color: '#81C784', width: 74, textAlign: 'right' }}>suggest {detail.recommendation.greens[g]}s</span>
              </div>
              <input type="range" min={10} max={180} step={5} value={draft[g] ?? 30}
                onChange={e => setDraft(d => ({ ...d, [g]: Number(e.target.value) }))} style={{ width: '100%' }} />
            </div>
          ))}
          <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
            Cycle {draftCycle}s (incl. {lost}s amber + all-red){draftCycle > 180 ? ' — long: cross roads wait longer' : ''}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button disabled={busy || !draftChanged} onClick={() => onAction(() => serverClient.planJunction(detail.id, draft))} style={{ ...s.button, opacity: draftChanged ? 1 : 0.5 }}>Apply these times</button>
            <button disabled={busy} onClick={() => onAction(() => serverClient.planJunction(detail.id, 'recommended'))} style={{ ...s.button, background: '#2E7D32' }}>Use suggested</button>
            <button disabled={busy} onClick={() => onAction(() => serverClient.resetJunction(detail.id))} style={{ ...s.button, background: '#37474F' }}>Back to normal</button>
          </div>
          <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>{detail.recommendation.summary}</div>
          {changes.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: '#81C784' }}>{changes.map((c, i) => <div key={i}>✓ {c}</div>)}</div>}
          <div style={{ fontSize: 10, color: '#666', marginTop: 6 }}>Changes run in the simulation; apply them in the signal controller on site.</div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: '#777', margin: '8px 0' }}>View only — controllers can change signals.</div>
      )}

      <Fold title="Turns & phases">
        <TurnsEditor junctionId={detail.id} canControl={canControl}
          groupOf={Object.fromEntries(detail.approaches.map(x => [x.edgeId, x.group]))}
          onSaved={c => onAction(async () => ({ changes: c }))} />
      </Fold>

      <Fold title={`Approaches (${detail.approaches.length})`}>
        {detail.approaches.map(a => (
          <div key={a.edgeId} style={{ fontSize: 11, padding: '4px 0', borderBottom: '1px solid #0a0a0d' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={{ ...s.dot, background: LIGHT[a.light] }} />
              <span style={{ flex: 1, color: '#ddd' }}>{a.road || 'Unnamed road'} <span style={{ color: '#777' }}>· {a.lanes} lanes</span></span>
              <span style={{ fontFamily: 'monospace', color: a.overLimit ? '#F44336' : '#aaa' }}>{a.queueVehicles} q · {a.queueMetres} m · wait {fmt(a.waitSeconds)}</span>
            </div>
            <div style={{ color: '#888', fontSize: 10, marginLeft: 14 }}>{a.direction} · {a.arrivalsPerHour}/h</div>
            {a.feeders.filter(f => f.kind !== 'road' || f.arrivalsPerHour >= 100).slice(0, 3).map(f => (
              <div key={f.edgeId} style={{ color: f.kind === 'flyover' ? '#CE93D8' : '#777', fontSize: 10, marginLeft: 14 }}>
                ↳ {f.kind === 'flyover' ? '🛣 ' : ''}{f.road}{f.from ? ` from ${f.from}` : ''} · {f.arrivalsPerHour}/h, joins {f.metres} m before
              </div>
            ))}
          </div>
        ))}
      </Fold>

      {detail.advice.length > 0 && (
        <Fold title="Advice for neighbouring junctions">
          {detail.advice.map((a, i) => <div key={i} style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>• {a}</div>)}
        </Fold>
      )}

      {movements && (
        <Fold title={`Turning movements (last ${movements.hours} h)`}>
          {movements.rows.length === 0 && <div style={{ fontSize: 11, color: '#666' }}>Counting…</div>}
          {movements.rows.slice(0, 10).map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, fontSize: 11, padding: '2px 0' }}>
              <span style={{ width: 54, color: '#888' }}>{r.turn === 'straight' ? '↑ straight' : r.turn === 'left' ? '↰ left' : r.turn === 'right' ? '↱ right' : '↶ U-turn'}</span>
              <span style={{ flex: 1, color: '#ccc' }}>{r.fromRoad} → {r.toRoad}</span>
              <span style={{ fontFamily: 'monospace', color: '#ddd' }}>{r.vehiclesPerHour}/h</span>
            </div>
          ))}
          <button onClick={onDownloadCsv} style={{ ...s.link, marginTop: 4 }}>⬇ Counts for this junction (CSV, 24 h)</button>
        </Fold>
      )}

      {detail.neighbours.upstream.length + detail.neighbours.downstream.length > 0 && (
        <Fold title="Linked junctions">
          {[...detail.neighbours.upstream.map(n => ({ ...n, dir: '↘ from' })), ...detail.neighbours.downstream.map(n => ({ ...n, dir: '↗ to' }))].map((n, i) => (
            <button key={i} onClick={() => onSelect(n.id)} style={{ ...s.link, display: 'block', textAlign: 'left', marginBottom: 3 }}>
              {n.dir} {n.name} · {n.metres} m · {n.seconds}s
            </button>
          ))}
        </Fold>
      )}

      {canControl && (
        <Fold title="Training">
          <button disabled={busy} onClick={() => onAction(() => serverClient.surgeJunction(detail.id))} style={{ ...s.button, background: '#6A1B9A' }}>
            Fill every approach to 100% (600 m queues)
          </button>
        </Fold>
      )}
    </div>
  );
}

/** The junction from above: each approach as a road coming in from its direction. */
function Diagram({ detail, timing, picked, onPick }: {
  detail: JunctionDetail;
  timing: (g: string) => { light: 'GREEN' | 'YELLOW' | 'RED'; changesIn: number };
  picked: string | null;
  onPick: (g: string) => void;
}) {
  const size = 240, c = size / 2;
  const at = (deg: number, r: number) => {
    const a = deg * Math.PI / 180;
    return [c + Math.sin(a) * r, c - Math.cos(a) * r] as const;
  };
  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: '100%', maxWidth: 300, display: 'block', margin: '4px auto 6px' }} role="img" aria-label="Junction diagram">
      <circle cx={c} cy={c} r={22} fill="#2a2f3a" />
      {detail.approaches.map(a => {
        const from = (a.bearing + 180) % 360; // the side traffic comes from
        const t = timing(a.group);
        const [x0, y0] = at(from, 24), [x1, y1] = at(from, 112);
        const queue = Math.min(1, a.queueMetres / 600);
        const [qx, qy] = at(from, 24 + queue * 84);
        const [lx, ly] = at(from, 34);
        const [tx, ty] = at(from, 100);
        const sel = picked === a.group;
        return (
          <g key={a.edgeId} onClick={() => onPick(a.group)} style={{ cursor: 'pointer' }}>
            <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={sel ? '#4f8ef7' : '#3a4150'} strokeWidth={16} strokeLinecap="round" />
            <line x1={x0} y1={y0} x2={qx} y2={qy} stroke={a.overLimit ? '#F44336' : a.queueVehicles > 20 ? '#FF9800' : '#607D8B'} strokeWidth={6} strokeLinecap="round" />
            <circle cx={lx} cy={ly} r={7} fill={LIGHT[t.light]} stroke="#111" strokeWidth={1.5} />
            <text x={lx} y={ly + 3} fontSize={7} textAnchor="middle" fill="#111" fontWeight={700}>{t.changesIn}</text>
            <text x={tx} y={ty} fontSize={8} textAnchor="middle" fill="#ccc">{(a.road || '?').slice(0, 18)}</text>
          </g>
        );
      })}
    </svg>
  );
}

const KIND_TEXT: Record<CoordAction['kind'], string> = {
  'wave-out': 'Green wave ahead',
  gate: 'Hold back (protect)',
  'wave-in': 'Let traffic in',
};

/** The coordinated hold before it is applied: our green, the flow numbers, each neighbour's change. */
function PlanCard({ plan, busy, onConfirm, onCancel }: { plan: CoordinationPlan; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ background: '#0f1a2a', border: '1px solid #2a4a70', borderRadius: 8, padding: 8, marginTop: 8 }}>
      <div style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>
        <span style={{ color: COORD_COLOR.centre }}>●</span> {plan.road}: green {plan.holdSeconds}s
        {plan.holdSeconds !== plan.requestedSeconds && <span style={{ color: '#FFB74D', fontWeight: 400 }}> (asked {plan.requestedSeconds}s)</span>}
      </div>
      <div style={{ color: '#9ab', fontSize: 11, margin: '2px 0 4px' }}>
        {plan.queueVehicles} queued · jam clears in ~{fmt(plan.clearSeconds)} · ~{plan.releasedVehicles} vehicles move
      </div>
      {plan.limits.map((l, i) => <div key={i} style={{ color: '#FFB74D', fontSize: 10 }}>↳ shorter: {l}</div>)}
      <div style={{ ...s.section, margin: '8px 0 4px' }}>Neighbours ({plan.actions.length})</div>
      {plan.actions.length === 0 && <div style={{ color: '#777', fontSize: 11 }}>No linked signal close enough to change — only this junction.</div>}
      {plan.actions.map(a => (
        <div key={a.junctionId} style={{ fontSize: 11, padding: '4px 0', borderBottom: '1px solid #1a2a40' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ color: COORD_COLOR[a.kind] }}>●</span>
            <span style={{ flex: 1, color: '#ddd' }}>{KIND_TEXT[a.kind]} · {a.name}</span>
            <span style={{ fontFamily: 'monospace', color: COORD_COLOR[a.kind] }}>
              {a.kind === 'gate' ? `${Math.round((a.factor ?? 0.6) * 100)}% · ${a.seconds}s` : `${a.startIn > 0 ? `+${a.startIn}s ` : ''}${a.seconds}s`}
            </span>
          </div>
          <div style={{ color: '#889', fontSize: 10, marginLeft: 14 }}>{a.road} · {a.metres} m · {a.reason}</div>
        </div>
      ))}
      {plan.warnings.map((w, i) => <div key={i} style={{ color: '#ff8a80', fontSize: 11, marginTop: 4 }}>⚠ {w}</div>)}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button disabled={busy} onClick={onConfirm} style={{ ...s.button, background: '#2E7D32', flex: 1 }}>Apply all</button>
        <button onClick={onCancel} style={{ ...s.button, background: '#37474F' }}>Cancel</button>
      </div>
      <div style={{ color: '#667', fontSize: 10, marginTop: 4 }}>Shown on the map. Numbers are recomputed from live queues when you apply.</div>
    </div>
  );
}

/** One signal cycle: each phase as a coloured block, with where it is now. */
function Timeline({ detail, elapsed }: { detail: JunctionDetail; elapsed: number }) {
  const total = detail.phases.reduce((t, p) => t + p.duration, 0) || 1;
  let pos = detail.phases.slice(0, detail.phase.index).reduce((t, p) => t + p.duration, 0) + detail.phase.timer + elapsed;
  pos %= total;
  const colour = (p: { group: string; color: string }) => p.color === 'GREEN' ? '#2E7D32' : p.color === 'YELLOW' ? '#F9A825' : '#5d1f1f';
  return (
    <div style={{ position: 'relative', height: 22, display: 'flex', borderRadius: 4, overflow: 'hidden', margin: '2px 0 8px' }} title="Signal cycle">
      {detail.phases.map((p, i) => (
        <div key={i} style={{ width: `${p.duration / total * 100}%`, background: colour(p), color: '#fff', fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {p.color === 'GREEN' && p.duration / total > 0.15 ? `${p.group} ${p.duration}s` : ''}
        </div>
      ))}
      <div style={{ position: 'absolute', left: `${pos / total * 100}%`, top: 0, bottom: 0, width: 2, background: '#fff' }} />
    </div>
  );
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: '1px solid #0a0a0d', marginTop: 8 }}>
      <button onClick={() => setOpen(o => !o)} style={{ ...s.link, color: '#9ab', padding: '6px 0', width: '100%', textAlign: 'left' }}>
        {open ? '▾' : '▸'} {title}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  link: { background: 'none', border: 'none', color: '#2fe4cc', cursor: 'pointer', padding: 0, fontSize: 11 },
  chip: { fontSize: 10, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', fontWeight: 700 },
  section: { fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, margin: '12px 0 6px', fontWeight: 600 },
  groupRow: {
    display: 'flex', gap: 8, alignItems: 'center', width: '100%', padding: '7px 8px', marginBottom: 4,
    background: '#16161a', border: '1px solid #26262e', borderRadius: 8, cursor: 'pointer',
  },
  lamp: { width: 14, height: 14, borderRadius: 7, flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 3, flexShrink: 0 },
  pill: { padding: '5px 9px', fontSize: 11, borderRadius: 14, background: '#0a0a0d', color: '#aaa', border: '1px solid #26262e', cursor: 'pointer' },
  pillOn: { background: '#4488FF33', color: '#fff', borderColor: '#4f8ef7' },
  bigButton: {
    padding: '10px 8px', background: '#1B5E20', color: '#fff', border: 'none', borderRadius: 8,
    cursor: 'pointer', fontSize: 12, fontWeight: 700, textAlign: 'left', minHeight: 44,
  },
  button: { padding: '8px 10px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, minHeight: 36 },
};
