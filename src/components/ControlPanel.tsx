import { useState } from 'react';

interface ControlPanelProps {
  isRunning: boolean;
  vehicleCount: number;
  avgSpeed: number;
  congestionHotspots: number;
  greenWaveActive: boolean;
  signalCoordination: number;
  onTogglePause: () => void;
  onSpawnVehicle: (direction: 'N' | 'S' | 'E' | 'W') => void;
  onManualOverride: (signalId: string, dir: string, color: string) => void;
  overrideActive: boolean;
  overrideTimeRemaining: number;
  onCancelOverride: () => void;
  signals: Map<string, { id: string; nodeId: string; phases: { direction: string; color: string; duration: number }[]; currentPhaseIndex: number }>;
}

export default function ControlPanel({
  isRunning,
  vehicleCount,
  avgSpeed,
  congestionHotspots,
  greenWaveActive,
  signalCoordination,
  onTogglePause,
  onSpawnVehicle,
  onManualOverride,
  overrideActive,
  overrideTimeRemaining,
  onCancelOverride,
  signals,
}: ControlPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [showSignals, setShowSignals] = useState(false);
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);

  const signalList = Array.from(signals.values());

  if (!expanded) {
    return (
      <button onClick={() => setExpanded(true)} style={styles.expandBtn}>
        Controls
      </button>
    );
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Traffic Control</span>
        <button onClick={() => setExpanded(false)} style={styles.closeBtn}>x</button>
      </div>

      <div style={styles.section}>
        <div style={styles.controlRow}>
          <button
            onClick={onTogglePause}
            style={{
              ...styles.controlBtn,
              background: isRunning ? '#f44336' : '#4CAF50',
            }}
          >
            {isRunning ? 'Pause' : 'Start'}
          </button>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Spawn Vehicle</div>
        <div style={styles.spawnGrid}>
          <button onClick={() => onSpawnVehicle('N')} style={styles.spawnBtn}>
            <span style={{ fontSize: 16 }}>{'\u2B06'}</span> North
          </button>
          <button onClick={() => onSpawnVehicle('S')} style={styles.spawnBtn}>
            <span style={{ fontSize: 16 }}>{'\u2B07'}</span> South
          </button>
          <button onClick={() => onSpawnVehicle('E')} style={styles.spawnBtn}>
            <span style={{ fontSize: 16 }}>{'\u27A1'}</span> East
          </button>
          <button onClick={() => onSpawnVehicle('W')} style={styles.spawnBtn}>
            <span style={{ fontSize: 16 }}>{'\u2B05'}</span> West
          </button>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Live Stats</div>
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Vehicles</span>
          <span style={styles.statValue}>{vehicleCount}</span>
        </div>
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Avg Speed</span>
          <span style={styles.statValue}>{avgSpeed} km/h</span>
        </div>
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Congestion</span>
          <span style={{
            ...styles.statValue,
            color: congestionHotspots > 3 ? '#ff1744' : congestionHotspots > 1 ? '#FF9800' : '#4CAF50',
          }}>
            {congestionHotspots} hotspots
          </span>
        </div>
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Green Wave</span>
          <span style={{ ...styles.statValue, color: greenWaveActive ? '#4CAF50' : '#666' }}>
            {greenWaveActive ? 'ACTIVE' : 'OFF'}
          </span>
        </div>
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Coordination</span>
          <span style={styles.statValue}>{signalCoordination}%</span>
        </div>
      </div>

      {overrideActive && (
        <div style={styles.overrideBanner}>
          <span style={{ color: '#FF9800', fontWeight: 'bold' }}>MANUAL OVERRIDE</span>
          <span style={{ color: '#fff' }}>{Math.round(overrideTimeRemaining)}s</span>
          <button onClick={onCancelOverride} style={styles.cancelBtn}>Cancel</button>
        </div>
      )}

      <div style={styles.section}>
        <div
          style={styles.sectionTitle}
          onClick={() => setShowSignals(!showSignals)}
        >
          Signals ({signalList.length}) {showSignals ? '\u25B2' : '\u25BC'}
        </div>
        {showSignals && (
          <div style={styles.signalList}>
            {signalList.map(sig => {
              const phase = sig.phases[sig.currentPhaseIndex];
              const isGreen = phase.color === 'GREEN';
              return (
                <div
                  key={sig.id}
                  style={{
                    ...styles.signalItem,
                    background: selectedSignal === sig.id ? '#ffffff11' : 'transparent',
                  }}
                  onClick={() => setSelectedSignal(selectedSignal === sig.id ? null : sig.id)}
                >
                  <div style={styles.signalHeader}>
                    <span style={styles.signalId}>{sig.id}</span>
                    <span style={{
                      ...styles.signalDot,
                      background: isGreen ? '#4CAF50' : phase.color === 'YELLOW' ? '#FF9800' : '#f44336',
                    }} />
                    <span style={{ color: isGreen ? '#4CAF50' : '#f44336', fontSize: 11, fontWeight: 'bold' }}>
                      {phase.color}
                    </span>
                  </div>
                  {selectedSignal === sig.id && (
                    <div style={styles.signalOverride}>
                      <div style={styles.overrideRow}>
                        <button
                          onClick={(e) => { e.stopPropagation(); onManualOverride(sig.id, 'N', 'GREEN'); }}
                          style={{ ...styles.overrideBtn, background: '#4CAF50' }}
                        >NS Green</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); onManualOverride(sig.id, 'E', 'GREEN'); }}
                          style={{ ...styles.overrideBtn, background: '#4CAF50' }}
                        >EW Green</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); onManualOverride(sig.id, 'N', 'RED'); }}
                          style={{ ...styles.overrideBtn, background: '#f44336' }}
                        >All Red</button>
                      </div>
                      <div style={styles.signalPhases}>
                        {sig.phases.map((p, i) => (
                          <div key={i} style={{
                            ...styles.phaseRow,
                            background: i === sig.currentPhaseIndex ? '#ffffff11' : 'transparent',
                          }}>
                            <span style={{ color: '#aaa', width: 20 }}>{p.direction}</span>
                            <span style={{
                              color: p.color === 'GREEN' ? '#4CAF50' : p.color === 'YELLOW' ? '#FF9800' : '#f44336',
                              fontWeight: 'bold',
                              fontSize: 11,
                            }}>{p.color}</span>
                            <span style={{ color: '#666', fontSize: 11 }}>{p.duration}s</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 320,
    maxHeight: 'calc(100vh - 24px)',
    background: 'rgba(10,10,20,0.95)',
    color: '#ccc',
    borderRadius: 10,
    border: '1px solid #333',
    overflow: 'hidden',
    zIndex: 1000,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 14px',
    borderBottom: '1px solid #333',
    background: 'rgba(30,30,50,0.8)',
  },
  title: { fontWeight: 'bold', fontSize: 14, color: '#fff' },
  closeBtn: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16, padding: 0 },
  section: { padding: '10px 14px', borderBottom: '1px solid #222' },
  sectionTitle: {
    fontSize: 11,
    color: '#888',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    marginBottom: 8,
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
  },
  controlRow: { display: 'flex', gap: 8 },
  controlBtn: {
    flex: 1,
    padding: '10px',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 'bold',
    fontFamily: 'monospace',
  },
  spawnGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  spawnBtn: {
    padding: '8px',
    background: '#1a1a2e',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  statRow: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
  statLabel: { color: '#888', fontSize: 12 },
  statValue: { color: '#fff', fontWeight: 'bold', fontSize: 12 },
  overrideBanner: {
    padding: '8px 14px',
    background: 'rgba(255,152,0,0.1)',
    borderBottom: '1px solid #FF9800',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 11,
  },
  cancelBtn: {
    padding: '4px 10px',
    background: '#FF9800',
    color: '#000',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 'bold',
  },
  signalList: { maxHeight: 300, overflow: 'auto' },
  signalItem: {
    padding: '6px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    marginBottom: 2,
    transition: 'background 0.15s',
  },
  signalHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  signalId: { color: '#fff', fontWeight: 'bold', fontSize: 11, fontFamily: 'monospace', flex: 1 },
  signalDot: { width: 8, height: 8, borderRadius: '50%' },
  signalOverride: { marginTop: 6 },
  overrideRow: { display: 'flex', gap: 4, marginBottom: 6 },
  overrideBtn: {
    flex: 1,
    padding: '4px 6px',
    color: '#fff',
    border: 'none',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 'bold',
  },
  signalPhases: { fontSize: 11 },
  phaseRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '2px 4px',
    borderRadius: 2,
  },
  expandBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 1000,
    padding: '8px 16px',
    background: 'rgba(0,0,0,0.8)',
    color: '#fff',
    border: '1px solid #555',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'monospace',
    fontSize: 13,
  },
};
