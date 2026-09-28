import type { CSSProperties } from 'react';
import type { Conditions, WeatherMode, TrafficLevel } from '../services/serverClient';
import { REPORT_LABEL } from '../utils/reports';

interface Props {
  conditions: Conditions | null;
  onWeather: (mode: WeatherMode) => void;
  onTraffic: (level: TrafficLevel) => void;
  onRemoveReport: (id: string) => void;
}

const CONFIRMED_BY: Record<string, string> = {
  people: 'confirmed by drivers', operator: 'confirmed by operator', gps: 'confirmed by GPS (traffic stuck)',
};

const WEATHER_OPTIONS: { value: WeatherMode; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'clear', label: '☀️ Clear' },
  { value: 'rain', label: '🌧 Rain' },
  { value: 'heavy_rain', label: '⛈ Heavy' },
];
const TRAFFIC_OPTIONS: { value: TrafficLevel; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'normal', label: 'Normal' },
  { value: 'heavy', label: 'Heavy' },
];

/** Operator controls for weather and simulated traffic, and review of crowd reports. */
export default function ConditionsPanel({ conditions, onWeather, onTraffic, onRemoveReport }: Props) {
  if (!conditions) return null;
  const { weather } = conditions;
  const liveNote = weather.source === 'unavailable'
    ? 'live feed unavailable'
    : weather.precipitation !== null ? `${weather.precipitation.toFixed(1)} mm/h` : '';

  return (
    <div style={{ padding: '12px 14px', borderTop: '1px solid #222' }}>
      <div style={styles.title}>Road conditions</div>

      <div style={styles.label}>Weather {conditions.weatherMode === 'live' && liveNote && <span style={{ color: '#666' }}>· {liveNote}</span>}</div>
      <Segmented options={WEATHER_OPTIONS} value={conditions.weatherMode} onChange={onWeather} />

      <div style={styles.label}>Simulated traffic</div>
      <Segmented options={TRAFFIC_OPTIONS} value={conditions.trafficLevel} onChange={onTraffic} />

      <div style={styles.label}>Driver reports ({conditions.reports.length})</div>
      {conditions.reports.length === 0 && (
        <div style={{ fontSize: 11, color: '#666' }}>None right now. Drivers report by tapping a road on the map.</div>
      )}
      {conditions.reports.map(r => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #1a1a2e' }}>
          <span style={{ opacity: r.status === 'confirmed' ? 1 : 0.6 }}>{REPORT_LABEL[r.type].icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#ddd' }}>{REPORT_LABEL[r.type].label} · {r.roadName || 'Unnamed road'}</div>
            <div style={{ fontSize: 10, color: r.status === 'confirmed' ? '#FF9800' : '#777' }}>
              {r.status === 'confirmed' ? (r.confirmSource ? CONFIRMED_BY[r.confirmSource] : 'confirmed') : 'unconfirmed'}
              {' · '}{r.confirmations} yes / {r.clears} clear
              {' · '}until {new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
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
          background: o.value === value ? '#4488FF33' : '#1a1a2e',
          border: `1px solid ${o.value === value ? '#4488FF' : '#2a2a40'}`,
          color: o.value === value ? '#fff' : '#aaa',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  title: { fontSize: 11, color: '#777', textTransform: 'uppercase', marginBottom: 8, fontWeight: 'bold', letterSpacing: 0.5 },
  label: { fontSize: 11, color: '#999', marginBottom: 4 },
  small: {
    padding: '3px 10px', background: '#222', color: '#ccc', border: '1px solid #444',
    borderRadius: 4, cursor: 'pointer', fontSize: 11,
  },
};
