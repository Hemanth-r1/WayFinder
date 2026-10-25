/**
 * Emergency runs for operators: each ambulance / fire engine / police vehicle on a run,
 * its time to arrival, and the signals on its way (green once cleared for it).
 * Controllers dispatch simulated runs from the map's right-click menu and can cancel.
 */
import type { CSSProperties } from 'react';
import type { Corridor } from '../services/serverClient';

const ICON = { ambulance: '🚑', fire: '🚒', police: '🚓' } as const;
const STATE_COLOR = { ahead: '#FF9100', green: '#00E676', passed: '#7a95b0' } as const;

interface Props {
  corridors: Corridor[];
  canControl: boolean;
  /** An ambulance start point is set, waiting for the destination */
  picking: boolean;
  onCancel: (id: string) => void;
  onFocus: (lat: number, lng: number) => void;
}

function minutes(s: number): string {
  return s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`;
}

export default function EmergencyPanel({ corridors, canControl, picking, onCancel, onFocus }: Props) {
  const active = corridors.filter(c => c.status === 'active');
  if (active.length === 0 && !canControl) return null;
  return (
    <div style={{ padding: '10px 14px', borderTop: '1px solid var(--wf-border)' }}>
      <div style={s.title}>Emergency runs{active.length ? ` · ${active.length} active` : ''}</div>
      {active.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--wf-soft)' }}>
          {picking ? 'Start point set — right-click the destination: “Ambulance goes here”.' : 'None. Right-click the map: “Ambulance starts here”, then “goes here”, to send a simulated run.'}
        </div>
      )}
      {active.map(c => {
        const ahead = c.signals.filter(x => x.state !== 'passed');
        return (
          <div key={c.id} style={s.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={() => c.position && onFocus(c.position.lat, c.position.lng)} style={s.link}>
                {ICON[c.kind]} {c.kind} {c.id}
              </button>
              <span style={{ flex: 1, color: 'var(--wf-muted)', fontSize: 11 }}>{c.userId ? 'responder' : 'simulated'} · arrives in ~{minutes(c.eta)}</span>
              {canControl && <button onClick={() => onCancel(c.id)} style={s.cancel}>Cancel</button>}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
              {c.signals.map(x => (
                <span key={x.junctionId} title={x.name} style={{ ...s.chip, color: STATE_COLOR[x.state], borderColor: STATE_COLOR[x.state] + '66' }}>
                  {x.state === 'green' ? '🟢' : x.state === 'passed' ? '✓' : '●'} {x.name.length > 18 ? x.name.slice(0, 17) + '…' : x.name}{x.eta != null && x.state !== 'passed' ? ` ${x.eta}s` : ''}
                </span>
              ))}
            </div>
            {ahead.length === 0 && <div style={{ fontSize: 10, color: '#81C784', marginTop: 3 }}>All signals passed</div>}
          </div>
        );
      })}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  title: { fontSize: 11, color: 'var(--wf-muted)', textTransform: 'uppercase', letterSpacing: 1, margin: '2px 0 6px', fontWeight: 600 },
  card: { background: '#1a0d10', border: '1px solid #5a1a24', borderRadius: 8, padding: 8, marginBottom: 6 },
  link: { background: 'none', border: 'none', color: '#FF8A80', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 700, textTransform: 'capitalize' },
  cancel: { background: '#37474F', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, padding: '4px 8px' },
  chip: { fontSize: 10, border: '1px solid', borderRadius: 6, padding: '1px 5px', fontFamily: 'monospace' },
};
