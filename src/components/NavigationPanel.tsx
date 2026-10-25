import { useState, useCallback, type CSSProperties } from 'react';
import type { RouteInfo } from '../types';

/** Fields the panel shows; satisfied by both local RouteInfo and server route options. */
export type NavRouteSummary = Pick<RouteInfo, 'path' | 'distance' | 'estimatedTime' | 'signalCount' | 'roadNames'>;

interface NavPanelProps {
  selectedSource: string | null;
  selectedDest: string | null;
  onSelectSource: (id: string | null) => void;
  onSelectDest: (id: string | null) => void;
  onStartNavigation: () => void;
  routeInfo: NavRouteSummary | null;
  clearRoute: () => void;
  navigatedVehicle: boolean;
}

export default function NavigationPanel({
  selectedSource, selectedDest,
  onSelectSource, onSelectDest,
  onStartNavigation, routeInfo, clearRoute, navigatedVehicle,
}: NavPanelProps) {
  const [expanded, setExpanded] = useState(true);

  const handleClear = useCallback(() => {
    onSelectSource(null);
    onSelectDest(null);
    clearRoute();
  }, [onSelectSource, onSelectDest, clearRoute]);

  const containerStyle: CSSProperties = {
    position: 'absolute', top: 12, left: 12,
    zIndex: 1000,
    background: 'rgba(10,10,20,0.92)',
    border: navigatedVehicle ? '1px solid #4f8ef7' : '1px solid var(--wf-border)',
    borderRadius: 8,
    fontFamily: 'inherit', fontSize: 12, color: 'var(--wf-text-2)',
    backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
    transition: 'width 0.2s',
    ...(expanded
      ? { width: 260, padding: 10, overflow: 'hidden' }
      : { width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }
    ),
  };

  return (
    <div
      style={containerStyle}
      onClick={expanded ? undefined : () => setExpanded(true)}
    >
      {expanded ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 'bold', color: 'var(--wf-text-strong)', fontSize: 13 }}>
              {navigatedVehicle ? '🛣️ Navigating' : '🧭 Navigation'}
            </span>
            <button
              onClick={() => setExpanded(false)}
              style={{ background: 'none', border: 'none', color: 'var(--wf-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
              title="Collapse"
            >✕</button>
          </div>

          {/* Source */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 10, color: 'var(--wf-muted)', marginBottom: 2 }}>Origin</div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: 'var(--wf-bg)', borderRadius: 4, padding: '4px 8px',
            }}>
              <span style={{ color: '#4CAF50' }}>●</span>
              <span style={{ fontSize: 11, flex: 1, color: selectedSource ? 'var(--wf-text-2)' : 'var(--wf-soft)' }}>
                {selectedSource ? (routeInfo?.roadNames[0] ?? 'Point on the map') : 'Click a road to set'}
              </span>
              {selectedSource && (
                <button onClick={() => onSelectSource(null)} style={{ background: 'none', border: 'none', color: 'var(--wf-soft)', cursor: 'pointer', fontSize: 10, padding: 0 }} title="Clear origin">✕</button>
              )}
            </div>
          </div>

          {/* Dest */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--wf-muted)', marginBottom: 2 }}>Destination</div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: 'var(--wf-bg)', borderRadius: 4, padding: '4px 8px',
            }}>
              <span style={{ color: '#F44336' }}>●</span>
              <span style={{ fontSize: 11, flex: 1, color: selectedDest ? 'var(--wf-text-2)' : 'var(--wf-soft)' }}>
                {selectedDest ? (routeInfo?.roadNames[routeInfo.roadNames.length - 1] ?? 'Point on the map') : 'Click a road to set'}
              </span>
              {selectedDest && (
                <button onClick={() => onSelectDest(null)} style={{ background: 'none', border: 'none', color: 'var(--wf-soft)', cursor: 'pointer', fontSize: 10, padding: 0 }} title="Clear destination">✕</button>
              )}
            </div>
          </div>

          {/* Route info */}
          {routeInfo && !navigatedVehicle && (
            <div style={{ marginBottom: 8, padding: 6, background: 'var(--wf-bg)', borderRadius: 4 }}>
              <div style={{ fontSize: 10, color: 'var(--wf-muted)', marginBottom: 2 }}>Route</div>
              <div style={{ fontSize: 11, color: 'var(--wf-text-strong)' }}>
                {(routeInfo.distance / 1000).toFixed(1)} km
              </div>
              <div style={{ fontSize: 10, color: 'var(--wf-muted)' }}>
                ~{(routeInfo.estimatedTime / 60).toFixed(0)} min · {routeInfo.signalCount} signals
              </div>
              {routeInfo.roadNames.length > 0 && (
                <div style={{ fontSize: 9, color: 'var(--wf-soft)', marginTop: 2 }}>
                  via {routeInfo.roadNames.slice(0, 3).join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Navigated vehicle info */}
          {navigatedVehicle && routeInfo && (
            <div style={{ marginBottom: 8, padding: 6, background: '#0a1a2e', border: '1px solid #4488FF33', borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: '#4f8ef7', fontWeight: 'bold' }}>Vehicle en route</div>
              <div style={{ fontSize: 10, color: 'var(--wf-muted)' }}>
                {(routeInfo.distance / 1000).toFixed(1)} km · ~{(routeInfo.estimatedTime / 60).toFixed(0)} min
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 4 }}>
            {selectedSource && selectedDest && !navigatedVehicle && (
              <button
                onClick={onStartNavigation}
                style={{
                  flex: 1, padding: '8px', background: '#4f8ef7', color: '#fff',
                  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  fontWeight: 'bold',
                }}
                title="Start navigation"
              >▶ Start Navigation</button>
            )}
            {(selectedSource || selectedDest || navigatedVehicle) && (
              <button
                onClick={handleClear}
                style={{
                  padding: '8px 12px', background: 'var(--wf-border)', color: 'var(--wf-muted)',
                  border: '1px solid var(--wf-border)', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                }}
                title="Clear route"
              >Clear</button>
            )}
          </div>

          <div style={{ marginTop: 6, fontSize: 9, color: 'var(--wf-border)', lineHeight: 1.4 }}>
            Click a road → <span style={{ color: '#4CAF50' }}>Set Origin</span> / <span style={{ color: '#F44336' }}>Set Destination</span>
          </div>
        </>
      ) : (
        <span style={{ fontSize: 18 }}>🧭</span>
      )}
    </div>
  );
}
