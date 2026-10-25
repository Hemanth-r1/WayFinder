import type { CSSProperties } from 'react';
import type { Conditions, WeatherMode, TrafficMode, Behaviour, Jam } from '../services/serverClient';
import { REPORT_LABEL } from '../utils/reports';
import { fileUrl } from '../services/userData';

interface Props {
  conditions: Conditions | null;
  onWeather: (mode: WeatherMode) => void;
  onTraffic: (level: TrafficMode) => void;
  onRemoveReport: (id: string) => void;
  onBehaviour: (change: Partial<Behaviour>) => void;
  jams: Jam[];
  /** Controllers can remove jams */
  onRemoveJam?: (id: string) => void;
}

const BEHAVIOURS: { key: keyof Behaviour; label: string; hint: string }[] = [
  { key: 'wrongWay', label: 'Wrong-way riders', hint: 'a few bikes/autos take short stretches against one-ways, then drive normally' },
  { key: 'redJumping', label: 'Red-light jumping', hint: 'some drivers go in the first seconds of red' },
  { key: 'laneWeaving', label: 'Lane weaving', hint: 'two-wheelers straddle lanes and creep past the stop line' },
];
const ON_OFF: { value: 'on' | 'off'; label: string }[] = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];

const CONFIRMED_BY: Record<string, string> = {
  people: 'confirmed by drivers', operator: 'confirmed by operator', gps: 'confirmed by GPS (traffic stuck)',
};

const WEATHER_OPTIONS: { value: WeatherMode; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'clear', label: '☀️ Clear' },
  { value: 'rain', label: '🌧 Rain' },
  { value: 'heavy_rain', label: '⛈ Heavy' },
];
const TRAFFIC_OPTIONS: { value: TrafficMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'normal', label: 'Normal' },
  { value: 'heavy', label: 'Heavy' },
];

/** Operator controls for weather and simulated traffic, and review of crowd reports. */
export default function ConditionsPanel({ conditions, onWeather, onTraffic, onRemoveReport, onBehaviour, jams, onRemoveJam }: Props) {
  if (!conditions) return null;
  const { weather } = conditions;
  const liveNote = weather.source === 'unavailable'
    ? 'live feed unavailable'
    : weather.precipitation !== null ? `${weather.precipitation.toFixed(1)} mm/h` : '';

  return (
    <div style={{ padding: '12px 14px', borderTop: '1px solid var(--wf-border)' }}>
      <div style={styles.title}>Road conditions</div>

      <div style={styles.label}>Weather {conditions.weatherMode === 'live' && liveNote && <span style={{ color: 'var(--wf-soft)' }}>· {liveNote}</span>}</div>
      <Segmented options={WEATHER_OPTIONS} value={conditions.weatherMode} onChange={onWeather} />

      <div style={styles.label}>
        Simulated traffic
        {conditions.demand !== undefined && (
          <span style={{ color: 'var(--wf-soft)' }}> · {Math.round(conditions.demand * 100)}% of peak{conditions.trafficMode === 'auto' ? ' (Bangalore time of day)' : ''}</span>
        )}
      </div>
      <Segmented options={TRAFFIC_OPTIONS} value={conditions.trafficMode ?? conditions.trafficLevel} onChange={onTraffic} />

      {conditions.behaviour && <>
        <div style={styles.label}>Driver behaviour <span style={{ color: 'var(--wf-soft)' }}>· everyone else follows the road rules</span></div>
        {BEHAVIOURS.map(b => (
          <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={b.hint}>
            <div style={{ flex: 1, fontSize: 11, color: 'var(--wf-text-2)', marginBottom: 10 }}>{b.label}</div>
            <div style={{ width: 96 }}>
              <Segmented options={ON_OFF} value={conditions.behaviour![b.key] ? 'on' : 'off'}
                onChange={v => onBehaviour({ [b.key]: v === 'on' })} />
            </div>
          </div>
        ))}
      </>}

      <div style={styles.label}>Test jams ({jams.length}) <span style={{ color: 'var(--wf-soft)' }}>· right-click a road → Jam this road</span></div>
      {jams.map(j => (
        <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--wf-bg)' }}>
          <span>{j.severity === 'stopped' ? '🛑' : '🐢'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--wf-text-2)' }}>{j.road}</div>
            <div style={{ fontSize: 10, color: 'var(--wf-soft)' }}>
              {j.severity === 'stopped' ? 'standstill' : 'slow'} · {j.metres} m queue · {j.vehicles} vehicles
              {' · '}until {new Date(j.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          {onRemoveJam && <button onClick={() => onRemoveJam(j.id)} style={styles.small}>Remove</button>}
        </div>
      ))}
      <div style={{ height: 10 }} />

      <div style={styles.label}>Driver reports ({conditions.reports.length})</div>
      {conditions.reports.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--wf-soft)' }}>None right now. Drivers report by tapping a road on the map.</div>
      )}
      {conditions.reports.map(r => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--wf-bg)' }}>
          <span style={{ opacity: r.status === 'confirmed' ? 1 : 0.6 }}>{REPORT_LABEL[r.type].icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--wf-text-2)' }}>{REPORT_LABEL[r.type].label} · {r.roadName || 'Unnamed road'}</div>
            <div style={{ fontSize: 10, color: r.status === 'confirmed' ? '#FF9800' : 'var(--wf-soft)' }}>
              {r.status === 'confirmed' ? (r.confirmSource ? CONFIRMED_BY[r.confirmSource] : 'confirmed') : 'unconfirmed'}
              {' · '}{r.confirmations} yes / {r.clears} clear
              {' · '}until {new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          {r.photoId && <button onClick={() => fileUrl(r.photoId!).then(u => window.open(u, '_blank', 'noopener')).catch(() => {})} style={styles.small} title="Photo from the reporter">📷</button>}
          <button onClick={() => onRemoveReport(r.id)} style={styles.small}>Remove</button>
        </div>
      ))}
    </div>
  );
}

function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} style={{
          flex: 1, padding: '6px 4px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
          background: o.value === value ? '#4488FF33' : 'var(--wf-bg)',
          border: `1px solid ${o.value === value ? '#4f8ef7' : 'var(--wf-border)'}`,
          color: o.value === value ? 'var(--wf-text-strong)' : 'var(--wf-muted)',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  title: { fontSize: 11, color: 'var(--wf-soft)', textTransform: 'uppercase', marginBottom: 8, fontWeight: 'bold', letterSpacing: 0.5 },
  label: { fontSize: 11, color: 'var(--wf-muted)', marginBottom: 4 },
  small: {
    padding: '3px 10px', background: 'var(--wf-border)', color: 'var(--wf-text-2)', border: '1px solid var(--wf-border)',
    borderRadius: 4, cursor: 'pointer', fontSize: 11,
  },
};
