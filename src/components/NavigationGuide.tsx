import type { CSSProperties } from 'react';
import type { NavigationResponse } from '../services/serverClient';

interface Props {
  navigation: NavigationResponse;
  onClear: () => void;
  onOpenGoogleMaps: () => void;
  destLabel: string | null;
  isMobile: boolean;
  /** Show the reroute offer (false once the driver chose to keep their route) */
  showReroute: boolean;
  rerouting: boolean;
  onAcceptReroute: () => void;
  onDismissReroute: () => void;
}

const WEATHER_NOTE: Record<string, string> = {
  rain: '🌧 Rain — slower speeds included',
  heavy_rain: '⛈ Heavy rain — expect delays, avoid flooded underpasses',
};

const LIGHT: Record<string, string> = { GREEN: '#4CAF50', YELLOW: '#FFD600', RED: '#F44336' };

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;
}

export default function NavigationGuide({
  navigation, onClear, onOpenGoogleMaps, destLabel, isMobile,
  showReroute, rerouting, onAcceptReroute, onDismissReroute,
}: Props) {
  const offer = showReroute ? navigation.reroute : null;
  const nextSignal = navigation.signals[0];
  const traffic = navigation.trafficConditions;
  const trafficText = traffic.congestionLevel > 0.7 ? 'Heavy traffic' : traffic.congestionLevel > 0.4 ? 'Moderate traffic' : 'Light traffic';
  const trafficColor = traffic.congestionLevel > 0.7 ? '#F44336' : traffic.congestionLevel > 0.4 ? '#FF9800' : '#4CAF50';
  const arrival = new Date(Date.now() + navigation.duration * 1000)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const container: CSSProperties = isMobile
    ? { position: 'fixed', left: 8, right: 8, bottom: 8 }
    : { position: 'fixed', right: 20, bottom: 20, width: 380 };

  return (
    <div style={{
      ...container,
      background: 'rgba(8,8,18,0.96)', border: '1px solid #2a2a40', borderRadius: 14,
      padding: 14, zIndex: 1500, boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
      fontFamily: 'system-ui, sans-serif', color: '#ccc',
    }}>
      {/* Reroute offer */}
      {offer && (
        <div style={{
          background: offer.reason === 'blocked' ? '#FF174422' : '#00E67618',
          border: `1px solid ${offer.reason === 'blocked' ? '#FF174466' : '#00E67655'}`,
          borderRadius: 10, padding: '10px 12px', marginBottom: 12,
        }}>
          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#fff' }}>
            {offer.reason === 'blocked' ? '🚧 Road blocked ahead' : `⚡ Faster route: save ${formatDuration(offer.savedSeconds)}`}
          </div>
          <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>
            New route {formatDuration(offer.estimatedTime)} · {formatDistance(offer.distance)}
            {offer.roadNames.length > 0 && ` via ${offer.roadNames.slice(0, 2).join(', ')}`}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={onAcceptReroute} disabled={rerouting} style={{
              flex: 1, height: 36, background: '#00C853', color: '#fff', border: 'none',
              borderRadius: 18, cursor: 'pointer', fontSize: 13, fontWeight: 'bold',
            }}>{rerouting ? 'Rerouting…' : 'Reroute'}</button>
            <button onClick={onDismissReroute} style={{
              height: 36, padding: '0 14px', background: 'transparent', color: '#aaa',
              border: '1px solid #444', borderRadius: 18, cursor: 'pointer', fontSize: 12,
            }}>Keep route</button>
          </div>
        </div>
      )}
      {navigation.blockedAhead && (
        <div style={{ background: '#FF174422', border: '1px solid #FF174466', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 13, color: '#fff' }}>
          🚧 Road blocked ahead — no way around found yet
        </div>
      )}

      {/* ETA row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 24, fontWeight: 'bold', color: '#4CAF50' }}>{formatDuration(navigation.duration)}</span>
        <span style={{ fontSize: 14, color: '#aaa' }}>{formatDistance(navigation.distance)}</span>
        <span style={{ fontSize: 13, color: '#777', marginLeft: 'auto' }}>arrive {arrival}</span>
      </div>
      <div style={{ fontSize: 12, color: '#999', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {destLabel ? `to ${destLabel}` : 'to destination'}
        {navigation.routeInfo.roadNames.length > 0 && ` · via ${navigation.routeInfo.roadNames.slice(0, 2).join(', ')}`}
      </div>

      <div style={{ fontSize: 11, color: '#777', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>{navigation.mode === 'gps' ? '📍 Live GPS' : '🚗 Simulated drive'}</span>
        {WEATHER_NOTE[navigation.weather] && <span style={{ color: '#64B5F6' }}>{WEATHER_NOTE[navigation.weather]}</span>}
      </div>

      {/* Next signal + traffic */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <div style={{ flex: 1, background: '#1a1a2e', borderRadius: 10, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
          {nextSignal ? (
            <>
              <span style={{ width: 22, height: 22, borderRadius: 11, background: LIGHT[nextSignal.currentState], flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, color: '#fff' }}>Signal in {formatDistance(nextSignal.distance)}</div>
                <div style={{ fontSize: 11, color: '#888' }}>
                  {nextSignal.currentState.charAt(0) + nextSignal.currentState.slice(1).toLowerCase()} now · {nextSignal.estimatedWait < 1 ? 'green when you get there' : `~${Math.round(nextSignal.estimatedWait)} s wait when you get there`}
                </div>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: '#888' }}>No signals ahead</div>
          )}
        </div>
        <div style={{ background: '#1a1a2e', borderRadius: 10, padding: '8px 10px', minWidth: 96 }}>
          <div style={{ fontSize: 12, color: trafficColor, fontWeight: 'bold' }}>{trafficText}</div>
          <div style={{ fontSize: 11, color: '#888' }}>{Math.round(traffic.avgSpeed)} km/h avg</div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={onOpenGoogleMaps} style={{
          flex: 1, height: 40, background: 'transparent', color: '#8ab4ff', border: '1px solid #33466a',
          borderRadius: 20, cursor: 'pointer', fontSize: 13,
        }}>Open in Google Maps</button>
        <button onClick={onClear} style={{
          height: 40, padding: '0 18px', background: '#F44336', color: '#fff', border: 'none',
          borderRadius: 20, cursor: 'pointer', fontSize: 13, fontWeight: 'bold',
        }}>End</button>
      </div>
    </div>
  );
}
