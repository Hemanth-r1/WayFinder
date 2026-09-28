import type { NavigationResponse } from '../services/serverClient';

interface Props {
  navigation: NavigationResponse;
  onClear: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  return `${Math.round(seconds / 60)} min`;
}

export default function NavigationGuide({ navigation, onClear }: Props) {
  const displayInfo = navigation;
  const nextSignal = displayInfo.signals[0];
  const trafficConditions = displayInfo.trafficConditions;
  const via = displayInfo.routeInfo.roadNames.slice(0, 3).join(', ');

  return (
    <div style={{
      position: 'fixed',
      bottom: 20,
      left: 360,
      right: 20,
      background: 'rgba(8,8,18,0.95)',
      border: '1px solid #222',
      borderRadius: 12,
      padding: 16,
      zIndex: 1000,
      boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
        paddingBottom: 12,
        borderBottom: '1px solid #1a1a2e',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>🧭</span>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: '#fff' }}>
            Navigation Active
          </span>
        </div>
        <button
          onClick={onClear}
          style={{
            padding: '6px 12px',
            background: '#F44336',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 'bold',
          }}
        >
          End Navigation
        </button>
      </div>

      {/* Route Info */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Distance</div>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: '#fff' }}>
            {(displayInfo.distance / 1000).toFixed(1)} km
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Duration</div>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: '#fff' }}>
            {formatDuration(displayInfo.duration)}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Signals</div>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: '#fff' }}>
            {displayInfo.signals.length}
          </div>
        </div>
      </div>

      {(via || displayInfo.routeInfo.sharedUsers > 0) && (
        <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
          {via && <>via {via}</>}
          {displayInfo.routeInfo.sharedUsers > 0 && (
            <span style={{ color: '#FF9800' }}>
              {via ? ' · ' : ''}{displayInfo.routeInfo.sharedUsers} other navigator{displayInfo.routeInfo.sharedUsers > 1 ? 's' : ''} on part of this route
            </span>
          )}
        </div>
      )}

      {/* Traffic Conditions */}
      <div style={{
        background: trafficConditions.congestionLevel > 0.5 ? '#F4433622' : '#4CAF5022',
        border: `1px solid ${trafficConditions.congestionLevel > 0.5 ? '#F4433644' : '#4CAF5044'}`,
        borderRadius: 8,
        padding: 10,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Traffic Conditions</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 12 }}>
              {trafficConditions.congestionLevel > 0.7 ? '🔴' : trafficConditions.congestionLevel > 0.4 ? '🟡' : '🟢'}
            </span>
            <span style={{ fontSize: 12, color: '#fff' }}>
              {trafficConditions.congestionLevel > 0.7 ? 'Heavy' : trafficConditions.congestionLevel > 0.4 ? 'Moderate' : 'Light'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#aaa' }}>
            Avg: {trafficConditions.avgSpeed.toFixed(1)} km/h
          </div>
        </div>
      </div>

      {/* Next Signal */}
      {nextSignal && (
        <div style={{
          background: '#1a1a2e',
          borderRadius: 8,
          padding: 10,
        }}>
          <div style={{ fontSize: 10, color: '#666', marginBottom: 6 }}>Next Signal</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: nextSignal.currentState === 'GREEN' ? '#4CAF50' : nextSignal.currentState === 'YELLOW' ? '#FFD600' : '#F44336',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
            }}>
              {nextSignal.currentState === 'GREEN' ? '●' : nextSignal.currentState === 'YELLOW' ? '●' : '●'}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: '#fff', fontWeight: 'bold' }}>
                {nextSignal.currentState} Signal
              </div>
              <div style={{ fontSize: 10, color: '#888' }}>
                {(nextSignal.distance).toFixed(0)}m ahead · Est. wait: {Math.floor(nextSignal.estimatedWait)}s
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Signals Ahead List */}
      {displayInfo.signals.length > 1 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: '#666', marginBottom: 6 }}>Signals Ahead</div>
          <div style={{ maxHeight: 80, overflow: 'auto' }}>
            {displayInfo.signals.slice(1, 4).map((signal, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                  fontSize: 10,
                  color: '#aaa',
                }}
              >
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: signal.currentState === 'GREEN' ? '#4CAF50' : signal.currentState === 'YELLOW' ? '#FFD600' : '#F44336',
                }} />
                <span>{(signal.distance).toFixed(0)}m</span>
                <span>·</span>
                <span>{signal.currentState}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
