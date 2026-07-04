import { useState, useCallback } from 'react';
import type { RouteInfo } from '../types';

interface NavPanelProps {
  selectedSource: string | null;
  selectedDest: string | null;
  onSelectSource: (id: string | null) => void;
  onSelectDest: (id: string | null) => void;
  onStartNavigation: () => void;
  routeInfo: RouteInfo | null;
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

  return (
    <div style={{
      position: 'absolute', top: 12, left: 12,
      zIndex: 1000,
      background: 'rgba(10,10,20,0.92)',
      border: navigatedVehicle ? '1px solid #4488FF' : '1px solid #333',
      borderRadius: 8, padding: 0,
      fontFamily: 'system-ui, sans-serif', fontSize: 12, color: '#ccc',
      backdropFilter: 'blur(4px)',
      transition: 'width 0.2s',
      width: expanded ? 260 : 36,
      overflow: 'hidden',
    }}>
      {expanded ? (
        <div style={{ padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 'bold', color: '#fff', fontSize: 13 }}>
              {navigatedVehicle ? '🛣️ Navigating' : '🧭 Navigation'}
            </span>
            <button
              onClick={() => setExpanded(false)}
              style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
            >✕</button>
          </div>

          {/* Source */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 10, color: '#888', marginBottom: 2 }}>Origin</div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: '#1a1a2e', borderRadius: 4, padding: '4px 8px',
            }}>
              <span style={{ color: '#4CAF50' }}>●</span>
              <span style={{ fontSize: 11, flex: 1, color: selectedSource ? '#ccc' : '#555' }}>
                {selectedSource ?? 'Right-click a road to set'}
              </span>
              {selectedSource && (
                <button onClick={() => onSelectSource(null)} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 10, padding: 0 }}>✕</button>
              )}
            </div>
          </div>

          {/* Dest */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: '#888', marginBottom: 2 }}>Destination</div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: '#1a1a2e', borderRadius: 4, padding: '4px 8px',
            }}>
              <span style={{ color: '#F44336' }}>●</span>
              <span style={{ fontSize: 11, flex: 1, color: selectedDest ? '#ccc' : '#555' }}>
                {selectedDest ?? 'Right-click a road to set'}
              </span>
              {selectedDest && (
                <button onClick={() => onSelectDest(null)} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 10, padding: 0 }}>✕</button>
              )}
            </div>
          </div>

          {/* Route info */}
          {routeInfo && !navigatedVehicle && (
            <div style={{ marginBottom: 8, padding: 6, background: '#1a1a2e', borderRadius: 4 }}>
              <div style={{ fontSize: 10, color: '#aaa', marginBottom: 2 }}>Route</div>
              <div style={{ fontSize: 11, color: '#fff' }}>
                {routeInfo.path.length - 1} segments · {(routeInfo.distance / 1000).toFixed(1)} km
              </div>
              <div style={{ fontSize: 10, color: '#888' }}>
                ~{(routeInfo.estimatedTime / 60).toFixed(0)} min · {routeInfo.signalCount} signals
              </div>
              {routeInfo.roadNames.length > 0 && (
                <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>
                  via {routeInfo.roadNames.slice(0, 3).join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Navigated vehicle info */}
          {navigatedVehicle && routeInfo && (
            <div style={{ marginBottom: 8, padding: 6, background: '#0a1a2e', border: '1px solid #4488FF33', borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: '#4488FF', fontWeight: 'bold' }}>Vehicle en route</div>
              <div style={{ fontSize: 10, color: '#888' }}>
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
                  flex: 1, padding: '8px', background: '#4488FF', color: '#fff',
                  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  fontWeight: 'bold',
                }}
              >▶ Start Navigation</button>
            )}
            {(selectedSource || selectedDest || navigatedVehicle) && (
              <button
                onClick={handleClear}
                style={{
                  padding: '8px 12px', background: '#222', color: '#888',
                  border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                }}
              >Clear</button>
            )}
          </div>

          <div style={{ marginTop: 6, fontSize: 9, color: '#444', lineHeight: 1.4 }}>
            Right-click a road → <span style={{ color: '#4CAF50' }}>Set Origin</span> / <span style={{ color: '#F44336' }}>Set Destination</span>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setExpanded(true)}
          style={{
            position: 'absolute', top: '50%', left: 12, transform: 'translateY(-50%)',
            background: 'rgba(10,10,20,0.92)', border: navigatedVehicle ? '1px solid #4488FF' : '1px solid #333',
            borderRadius: 8, color: navigatedVehicle ? '#4488FF' : '#888', cursor: 'pointer', fontSize: 16,
            padding: '8px 6px', lineHeight: '1',
          }}
        >🧭</button>
      )}
    </div>
  );
}
