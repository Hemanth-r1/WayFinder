/**
 * Turn rules and turn-based phases for one junction (police console). Per approach:
 * which turns are allowed and whether the left turn is free. Phases: either the road
 * phases (main road, then cross road) or a list of turn phases, each letting chosen
 * movements go for its green time (amber and all-red are added after each).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { serverClient, type TurnsView, type Turn, type ApproachRule, type PhaseSpec } from '../services/serverClient';

const ARROW: Record<Turn, string> = { left: '↰', straight: '↑', right: '↱', uturn: '↶' };
const WORD: Record<Turn, string> = { left: 'left', straight: 'straight', right: 'right', uturn: 'U-turn' };

interface Props {
  junctionId: string;
  canControl: boolean;
  /** Road group (A main road / B cross road) of each approach, for the presets */
  groupOf: Record<string, string>;
  onSaved: (changes: string[]) => void;
}

export default function TurnsEditor({ junctionId, canControl, groupOf, onSaved }: Props) {
  const [view, setView] = useState<TurnsView | null>(null);
  const [rules, setRules] = useState<ApproachRule[]>([]);
  const [phases, setPhases] = useState<PhaseSpec[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (v: TurnsView) => {
    setView(v);
    setRules(v.approaches.map(a => ({ edgeId: a.edgeId, allowed: a.allowed, freeLeft: a.freeLeft })));
    setPhases(v.phases);
    setWarnings(v.warnings);
  };
  useEffect(() => {
    setView(null); setError(null);
    serverClient.getTurns(junctionId).then(load).catch(err => setError(err.message));
  }, [junctionId]);

  if (error && !view) return <div style={{ color: '#F44336', fontSize: 11 }}>{error}</div>;
  if (!view) return <div style={{ color: 'var(--wf-soft)', fontSize: 11 }}>Loading turns…</div>;

  const rule = (edgeId: string) => rules.find(r => r.edgeId === edgeId)!;
  const toggleAllowed = (edgeId: string, t: Turn) => setRules(rs => rs.map(r => r.edgeId !== edgeId ? r
    : { ...r, allowed: r.allowed.includes(t) ? r.allowed.filter(x => x !== t) : [...r.allowed, t] }));
  const setFree = (edgeId: string, on: boolean) => setRules(rs => rs.map(r => r.edgeId === edgeId ? { ...r, freeLeft: on } : r));

  // Phase helpers
  const mainGreen = view.defaultGreens[0]?.green ?? 30;
  const crossGreen = view.defaultGreens[1]?.green ?? 25;
  const allowedOf = (edgeId: string) => rule(edgeId).allowed.filter(t => !(t === 'left' && rule(edgeId).freeLeft));
  const presetSplit = () => setPhases(view.approaches.map(a => ({
    green: Math.round((groupOf[a.edgeId] === 'B' ? crossGreen : mainGreen) * 0.6), moves: [{ edgeId: a.edgeId, turns: allowedOf(a.edgeId) }],
  })).filter(p => p.moves[0].turns.length > 0));
  const presetPaired = () => {
    const groups = [...new Set(view.approaches.map(a => groupOf[a.edgeId] ?? 'A'))].sort();
    const out: PhaseSpec[] = [];
    for (const g of groups) {
      const inG = view.approaches.filter(a => (groupOf[a.edgeId] ?? 'A') === g);
      const pick = (want: Turn[]) => inG.map(a => ({ edgeId: a.edgeId, turns: allowedOf(a.edgeId).filter(t => want.includes(t)) })).filter(m => m.turns.length);
      const sl = pick(['straight', 'left']), r = pick(['right', 'uturn']);
      const green = g === 'B' ? crossGreen : mainGreen;
      if (sl.length) out.push({ green: Math.round(green * 0.7), moves: sl });
      if (r.length) out.push({ green: Math.max(10, Math.round(green * 0.3)), moves: r });
    }
    setPhases(out);
  };
  const setPhase = (i: number, p: PhaseSpec) => setPhases(ps => ps!.map((x, k) => k === i ? p : x));
  const toggleMove = (i: number, edgeId: string, t: Turn) => {
    const p = phases![i];
    const has = p.moves.find(m => m.edgeId === edgeId);
    const turns = has ? (has.turns.includes(t) ? has.turns.filter(x => x !== t) : [...has.turns, t]) : [t];
    const moves = [...p.moves.filter(m => m.edgeId !== edgeId), ...(turns.length ? [{ edgeId, turns }] : [])];
    setPhase(i, { ...p, moves });
  };
  const move = (i: number, d: -1 | 1) => setPhases(ps => {
    const a = [...ps!]; const j = i + d;
    if (j < 0 || j >= a.length) return a;
    [a[i], a[j]] = [a[j], a[i]];
    return a;
  });
  const cycle = phases ? phases.reduce((t, p) => t + p.green, 0) : 0;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await serverClient.setTurns(junctionId, rules, phases);
      load(r.view);
      setWarnings(r.warnings);
      onSaved([`Turn rules saved${phases ? ` with ${phases.length} turn phases` : ''}`]);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setError(null);
    try { const r = await serverClient.clearTurns(junctionId); load(r.view); onSaved(['Turn rules cleared: all turns open, road phases']); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div style={s.head}>Allowed turns</div>
      {view.approaches.map(a => (
        <div key={a.edgeId} style={s.row}>
          <div style={{ color: 'var(--wf-text-2)', fontSize: 11 }}>{a.road} <span style={{ color: 'var(--wf-soft)' }}>from the {a.from} · {a.lanes} lanes</span></div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3, alignItems: 'center' }}>
            {a.moves.map(m => {
              const on = rule(a.edgeId).allowed.includes(m.turn);
              return (
                <button key={m.turn} disabled={!canControl} onClick={() => toggleAllowed(a.edgeId, m.turn)} title={`${WORD[m.turn]} → ${m.road} (${m.heading})`}
                  style={{ ...s.turn, ...(on ? s.turnOn : s.turnOff) }}>
                  {ARROW[m.turn]} {WORD[m.turn]}
                </button>
              );
            })}
            {a.moves.some(m => m.turn === 'left') && rule(a.edgeId).allowed.includes('left') && (
              <label style={{ fontSize: 10, color: 'var(--wf-muted)', display: 'flex', gap: 3, alignItems: 'center', marginLeft: 4 }}>
                <input type="checkbox" disabled={!canControl} checked={rule(a.edgeId).freeLeft} onChange={e => setFree(a.edgeId, e.target.checked)} /> free left
              </label>
            )}
          </div>
        </div>
      ))}

      <div style={s.head}>Phases</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
        <button disabled={!canControl} onClick={() => setPhases(null)} style={{ ...s.pill, ...(phases === null ? s.pillOn : {}) }}>Road phases</button>
        <button disabled={!canControl} onClick={presetPaired} style={s.pill}>Straight + left, then rights</button>
        <button disabled={!canControl} onClick={presetSplit} style={s.pill}>One road at a time</button>
      </div>
      {phases === null ? (
        <div style={{ color: 'var(--wf-muted)', fontSize: 11 }}>
          Main road, then cross road: {view.defaultGreens.map(g => `${g.group} ${g.green}s`).join(', ')}. Every allowed turn goes on its road's green (right turns give way).
        </div>
      ) : (
        <>
          {phases.map((p, i) => (
            <div key={i} style={s.phase}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--wf-text-strong)', fontSize: 12, fontWeight: 700 }}>Phase {i + 1}</span>
                <input type="range" min={5} max={120} step={1} value={p.green} disabled={!canControl}
                  onChange={e => setPhase(i, { ...p, green: Number(e.target.value) })} style={{ flex: 1 }} />
                <span style={{ fontFamily: 'monospace', color: '#81C784', fontSize: 11, width: 34, textAlign: 'right' }}>{p.green}s</span>
                {canControl && <>
                  <button onClick={() => move(i, -1)} style={s.mini} aria-label="Move up">▲</button>
                  <button onClick={() => move(i, 1)} style={s.mini} aria-label="Move down">▼</button>
                  <button onClick={() => setPhases(ps => ps!.filter((_, k) => k !== i))} style={s.mini} aria-label="Remove phase">✕</button>
                </>}
              </div>
              {view.approaches.map(a => {
                const turns = a.moves.map(m => m.turn).filter(t => rule(a.edgeId).allowed.includes(t) && !(t === 'left' && rule(a.edgeId).freeLeft));
                if (!turns.length) return null;
                const cur = p.moves.find(m => m.edgeId === a.edgeId)?.turns ?? [];
                return (
                  <div key={a.edgeId} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 3 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: cur.length ? 'var(--wf-text-2)' : 'var(--wf-soft)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.road} · {a.from}</span>
                    {turns.map(t => (
                      <button key={t} disabled={!canControl} onClick={() => toggleMove(i, a.edgeId, t)} title={WORD[t]}
                        style={{ ...s.turnSmall, ...(cur.includes(t) ? s.goOn : s.idle) }}>{ARROW[t]}</button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
          {canControl && phases.length < 8 && (
            <button onClick={() => setPhases(ps => [...ps!, { green: 20, moves: [] }])} style={{ ...s.pill, marginTop: 4 }}>+ Add phase</button>
          )}
          <div style={{ color: 'var(--wf-muted)', fontSize: 10, marginTop: 4 }}>Greens {cycle}s + amber and all-red after each phase. Free lefts never wait.</div>
        </>
      )}

      {warnings.length > 0 && (
        <div style={{ marginTop: 6 }}>{warnings.map((w, i) => <div key={i} style={{ color: '#FFB74D', fontSize: 10 }}>⚠ {w}</div>)}</div>
      )}
      {error && <div style={{ color: '#F44336', fontSize: 11, marginTop: 4 }}>{error}</div>}
      {canControl ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button disabled={busy} onClick={save} style={{ ...s.button, background: '#2E7D32', flex: 1 }}>Save turns{phases ? ' & phases' : ''}</button>
          <button disabled={busy} onClick={clear} style={{ ...s.button, background: '#37474F' }}>All open</button>
        </div>
      ) : <div style={{ color: 'var(--wf-soft)', fontSize: 10, marginTop: 6 }}>View only — controllers can change turns.</div>}
      {view.by && <div style={{ color: 'var(--wf-soft)', fontSize: 10, marginTop: 4 }}>Set by {view.by} · {new Date(view.at!).toLocaleString()}</div>}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  head: { fontSize: 10, color: 'var(--wf-muted)', textTransform: 'uppercase', letterSpacing: 1, margin: '8px 0 4px', fontWeight: 600 },
  row: { padding: '4px 0', borderBottom: '1px solid var(--wf-bg)' },
  turn: { padding: '4px 7px', fontSize: 11, borderRadius: 6, cursor: 'pointer', minHeight: 30 },
  turnSmall: { width: 30, height: 28, fontSize: 13, borderRadius: 6, cursor: 'pointer', padding: 0 },
  turnOn: { background: '#1565C033', color: 'var(--wf-text-strong)', border: '1px solid #4f8ef7' },
  turnOff: { background: 'var(--wf-bg)', color: 'var(--wf-soft)', border: '1px solid var(--wf-border)', textDecoration: 'line-through' },
  idle: { background: 'var(--wf-bg)', color: 'var(--wf-soft)', border: '1px solid var(--wf-border)' },
  goOn: { background: '#1B5E2066', color: '#00E676', border: '1px solid #00E676' },
  pill: { padding: '5px 9px', fontSize: 11, borderRadius: 14, background: 'var(--wf-bg)', color: 'var(--wf-muted)', border: '1px solid var(--wf-border)', cursor: 'pointer' },
  pillOn: { background: '#4488FF33', color: 'var(--wf-text-strong)', borderColor: '#4f8ef7' },
  phase: { background: 'var(--wf-surface)', border: '1px solid var(--wf-border)', borderRadius: 8, padding: 6, marginBottom: 6 },
  mini: { background: 'var(--wf-bg)', color: 'var(--wf-muted)', border: '1px solid var(--wf-border)', borderRadius: 4, cursor: 'pointer', fontSize: 10, width: 22, height: 22, padding: 0 },
  button: { padding: '8px 10px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, minHeight: 36 },
};
