import { useState, useCallback, useMemo } from 'react';
import type { RoadGraph, TrafficSignal, RouteInfo } from '../types';
import { aStarRoute } from '../engine/pathfinding';

interface NavigationPanelProps {
  graph: RoadGraph;
  signals: Map<string, TrafficSignal>;
  onRouteCalculated: (route: RouteInfo | null) => void;
  onNodeSelect: (nodeId: string | null) => void;
  selectedSource: string | null;
  selectedDest: string | null;
}

export default function NavigationPanel({
  graph,
  signals,
  onRouteCalculated,
  onNodeSelect,
  selectedSource,
  selectedDest,
}: NavigationPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [avoidCongestion, setAvoidCongestion] = useState(true);
  const [preferMainRoads, setPreferMainRoads] = useState(true);
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [searchMode, setSearchMode] = useState<'source' | 'dest'>('source');

  const nodeEntries = useMemo(() => {
    const entries: { id: string; label: string; lat: number; lng: number }[] = [];
    for (const [id, node] of graph.nodes) {
      if (node.isIntersection) {
        entries.push({
          id,
          label: `${id}`,
          lat: node.lat,
          lng: node.lng,
        });
      }
    }
    return entries;
  }, [graph.nodes]);

  const calculateRoute = useCallback(() => {
    if (!selectedSource || !selectedDest) return;
    const route = aStarRoute(graph, selectedSource, selectedDest, signals, {
      avoidCongestion,
      preferMainRoads,
    });
    setRouteInfo(route);
    onRouteCalculated(route);
  }, [graph, signals, selectedSource, selectedDest, avoidCongestion, preferMainRoads, onRouteCalculated]);

  const clearRoute = useCallback(() => {
    setRouteInfo(null);
    onRouteCalculated(null);
    onNodeSelect(null);
  }, [onRouteCalculated, onNodeSelect]);

  const handleNodeClick = useCallback((nodeId: string) => {
    if (searchMode === 'source') {
      onNodeSelect(nodeId);
      setSearchMode('dest');
    } else {
      onNodeSelect(nodeId);
      setSearchMode('source');
    }
  }, [searchMode, onNodeSelect]);

  if (!isExpanded) {
    return (
      <button onClick={() => setIsExpanded(true)} style={styles.expandBtn}>
        Navigation
      </button>
    );
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Navigation</span>
        <button onClick={() => setIsExpanded(false)} style={styles.closeBtn}>x</button>
      </div>

      <div style={styles.section}>
        <div style={styles.inputGroup}>
          <label style={styles.label}>From</label>
          <div
            style={{
              ...styles.input,
              borderColor: searchMode === 'source' ? '#4CAF50' : '#555',
            }}
            onClick={() => setSearchMode('source')}
          >
            {selectedSource || 'Click map to select'}
          </div>
        </div>
        <div style={styles.inputGroup}>
          <label style={styles.label}>To</label>
          <div
            style={{
              ...styles.input,
              borderColor: searchMode === 'dest' ? '#FF9800' : '#555',
            }}
            onClick={() => setSearchMode('dest')}
          >
            {selectedDest || 'Click map to select'}
          </div>
        </div>
      </div>

      <div style={styles.section}>
        <label style={styles.checkbox}>
          <input
            type="checkbox"
            checked={avoidCongestion}
            onChange={(e) => setAvoidCongestion(e.target.checked)}
          />
          <span>Avoid congestion</span>
        </label>
        <label style={styles.checkbox}>
          <input
            type="checkbox"
            checked={preferMainRoads}
            onChange={(e) => setPreferMainRoads(e.target.checked)}
          />
          <span>Prefer main roads</span>
        </label>
      </div>

      <div style={styles.buttonRow}>
        <button
          onClick={calculateRoute}
          disabled={!selectedSource || !selectedDest}
          style={{
            ...styles.calcBtn,
            opacity: selectedSource && selectedDest ? 1 : 0.5,
          }}
        >
          Calculate Route
        </button>
        <button onClick={clearRoute} style={styles.clearBtn}>Clear</button>
      </div>

      {routeInfo && (
        <div style={styles.routeInfo}>
          <div style={styles.routeStat}>
            <span style={styles.statLabel}>Distance</span>
            <span style={styles.statValue}>{(routeInfo.distance / 1000).toFixed(1)} km</span>
          </div>
          <div style={styles.routeStat}>
            <span style={styles.statLabel}>ETA</span>
            <span style={styles.statValue}>{Math.round(routeInfo.estimatedTime)}s</span>
          </div>
          <div style={styles.routeStat}>
            <span style={styles.statLabel}>Signals</span>
            <span style={styles.statValue}>{routeInfo.signalCount}</span>
          </div>
          <div style={styles.routeStat}>
            <span style={styles.statLabel}>Congestion</span>
            <span style={{
              ...styles.statValue,
              color: routeInfo.avgCongestion > 0.7 ? '#ff1744' : routeInfo.avgCongestion > 0.4 ? '#FF9800' : '#4CAF50',
            }}>
              {Math.round(routeInfo.avgCongestion * 100)}%
            </span>
          </div>
          {routeInfo.roadNames.length > 0 && (
            <div style={styles.roadList}>
              {routeInfo.roadNames.slice(0, 5).map((name, i) => (
                <span key={i} style={styles.roadTag}>{name}</span>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={styles.nodeList}>
        <div style={styles.nodeListHeader}>Nearby intersections</div>
        {nodeEntries.slice(0, 20).map((entry) => (
          <div
            key={entry.id}
            style={{
              ...styles.nodeItem,
              background: entry.id === selectedSource ? '#4CAF5022' :
                entry.id === selectedDest ? '#FF980022' : 'transparent',
            }}
            onClick={() => handleNodeClick(entry.id)}
          >
            <span style={styles.nodeId}>{entry.id}</span>
            <span style={styles.nodeCoord}>
              {entry.lat.toFixed(4)}, {entry.lng.toFixed(4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 300,
    maxHeight: 'calc(100vh - 24px)',
    background: 'rgba(15,15,25,0.95)',
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
  title: {
    fontWeight: 'bold',
    fontSize: 14,
    color: '#fff',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: 16,
    padding: 0,
  },
  section: {
    padding: '10px 14px',
    borderBottom: '1px solid #333',
  },
  inputGroup: {
    marginBottom: 8,
  },
  label: {
    display: 'block',
    fontSize: 11,
    color: '#888',
    marginBottom: 4,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  input: {
    padding: '8px 10px',
    background: '#1a1a2e',
    border: '1px solid #555',
    borderRadius: 6,
    color: '#fff',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 18,
  },
  checkbox: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    fontSize: 12,
    cursor: 'pointer',
  },
  buttonRow: {
    display: 'flex',
    gap: 8,
    padding: '10px 14px',
    borderBottom: '1px solid #333',
  },
  calcBtn: {
    flex: 1,
    padding: '8px 12px',
    background: '#4CAF50',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 'bold',
  },
  clearBtn: {
    padding: '8px 12px',
    background: '#333',
    color: '#ccc',
    border: '1px solid #555',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
  },
  routeInfo: {
    padding: '10px 14px',
    borderBottom: '1px solid #333',
    background: 'rgba(30,30,50,0.5)',
  },
  routeStat: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  statLabel: {
    color: '#888',
    fontSize: 12,
  },
  statValue: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  roadList: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
    marginTop: 8,
  },
  roadTag: {
    padding: '2px 8px',
    background: '#333',
    borderRadius: 4,
    fontSize: 11,
    color: '#aaa',
  },
  nodeList: {
    overflow: 'auto',
    maxHeight: 200,
    padding: '6px 0',
  },
  nodeListHeader: {
    padding: '4px 14px',
    fontSize: 11,
    color: '#666',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  nodeItem: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 14px',
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  nodeId: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 12,
  },
  nodeCoord: {
    color: '#666',
    fontSize: 11,
  },
  expandBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 1000,
    padding: '8px 16px',
    background: 'rgba(0,0,0,0.75)',
    color: '#fff',
    border: '1px solid #555',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'monospace',
    fontSize: 13,
    backdropFilter: 'blur(4px)',
  },
};
