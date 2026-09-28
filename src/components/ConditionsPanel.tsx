import type { CSSProperties } from 'react';
import type { Conditions, WeatherMode, TrafficLevel } from '../services/serverClient';

interface Props {
  conditions: Conditions | null;
  onWeather: (mode: WeatherMode) => void;
  onTraffic: (level: TrafficLevel) => void;
  onClearBlock: (id: string) => void;
}

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

/** Operator controls for weather, simulated traffic and road blocks. */
export default function ConditionsPanel({ conditions, onWeather, onTraffic, onClearBlock }: Props) {
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

      <div style={styles.label}>Road blocks ({conditions.blocks.length})</div>
      {conditions.blocks.length === 0 && (
        <div style={{ fontSize: 11, color: '#666' }}>Tap a road on the map → “Report road blocked”.</div>
      )}
      {conditions.blocks.map(b => (
        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #1a1a2e' }}>
          <span>🚧</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#ddd' }}>{b.roadName}</div>
            <div style={{ fontSize: 10, color: '#777' }}>
              {b.reason} · clears {new Date(b.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          <button onClick={() => onClearBlock(b.id)} style={styles.small}>Clear</button>
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
