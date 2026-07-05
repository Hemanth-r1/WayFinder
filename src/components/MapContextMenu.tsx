/**
 * MapContextMenu.tsx — REQ-M1 through REQ-M5
 * Context popup on map click with role-aware actions.
 */
import type { VehicleType } from '../types';

export interface MapContextMenuProps {
  lat: number;
  lng: number;
  nodeId: string | null;
  nodeDegree: number;
  roadNames: string[];
  role: string;
  screenX: number;
  screenY: number;
  onClose: () => void;
  onAddSignal: () => void;
  onSpawnVehicle: (type: VehicleType) => void;
  onSetSource: () => void;
  onSetDest: () => void;
}

const VEHICLE_TYPES: { type: VehicleType; icon: string; label: string }[] = [
  { type: 'sedan',     icon: '🚗', label: 'Sedan' },
  { type: 'suv',       icon: '🚙', label: 'SUV' },
  { type: 'hatchback', icon: '🚗', label: 'Hatchback' },
  { type: 'bus',       icon: '🚌', label: 'Bus' },
  { type: 'truck',     icon: '🚚', label: 'Truck' },
  { type: 'bike',      icon: '🛵', label: 'Bike' },
  { type: 'auto',      icon: '🛺', label: 'Auto' },
  { type: 'van',       icon: '📦', label: 'Van' },
  { type: 'emergency', icon: '🚨', label: 'Emergency' },
];

export default function MapContextMenu({
  lat, lng, nodeId, nodeDegree, roadNames, role,
  screenX, screenY, onClose, onAddSignal, onSpawnVehicle, onSetSource, onSetDest,
}: MapContextMenuProps) {
  // Clamp to viewport
  const menuWidth = 220;
  const left = Math.min(screenX, window.innerWidth - menuWidth - 10);
  const top = Math.min(screenY, Math.max(10, window.innerHeight - 420));

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 2000 }}
        onClick={onClose}
      />
      {/* Menu */}
      <div style={{
        position: 'fixed', left, top, zIndex: 2001,
        background: 'rgba(12,12,22,0.97)', border: '1px solid #333',
        borderRadius: 10, padding: '6px 0', minWidth: menuWidth,
        maxHeight: 'calc(100vh - 20px)', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        fontFamily: 'system-ui, sans-serif', color: '#fff',
      }}>
        {/* Header: node info */}
        <div style={{ padding: '6px 14px 8px', borderBottom: '1px solid #222' }}>
          <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>Map Point</div>
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#888' }}>
            {lat.toFixed(5)}, {lng.toFixed(5)}
          </div>
          {nodeId && (
            <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
              Node {nodeId} · {nodeDegree} connections
            </div>
          )}
          {roadNames.length > 0 && (
            <div style={{ fontSize: 11, color: '#FF9800', marginTop: 2 }}>
              {roadNames.slice(0, 2).join(', ')}
            </div>
          )}
        </div>

        {/* Source / Destination (User + Controller) */}
        {(role === 'user' || role === 'controller') && (
          <div style={{ borderBottom: '1px solid #1a1a2e' }}>
            <MenuItem icon="🟢" label="Set as Origin" onClick={() => { onSetSource(); onClose(); }} />
            <MenuItem icon="🔴" label="Set as Destination" onClick={() => { onSetDest(); onClose(); }} />
          </div>
        )}

        {/* Add Signal (Supporter + Controller) */}
        {(role === 'supporter' || role === 'controller') && nodeId && nodeDegree >= 2 && (
          <div style={{ borderBottom: '1px solid #1a1a2e' }}>
            <MenuItem icon="🚦" label="Add Signal Here" onClick={() => { onAddSignal(); onClose(); }} accent="#FF9800" />
          </div>
        )}

        {/* Spawn Vehicle (all roles) */}
        <div>
          <div style={{ padding: '5px 14px 3px', fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>
            Spawn Vehicle
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, padding: '0 8px 6px' }}>
            {VEHICLE_TYPES.map(vt => (
              <button
                key={vt.type}
                onClick={() => { onSpawnVehicle(vt.type); onClose(); }}
                style={{
                  padding: '5px 4px', background: '#1a1a2e', border: '1px solid #2a2a3e',
                  borderRadius: 6, cursor: 'pointer', color: '#ccc', fontSize: 10,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                }}
              >
                <span style={{ fontSize: 16 }}>{vt.icon}</span>
                <span>{vt.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function MenuItem({ icon, label, onClick, accent }: { icon: string; label: string; onClick: () => void; accent?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', background: 'transparent', border: 'none',
        cursor: 'pointer', color: accent || '#ccc', fontSize: 12, textAlign: 'left',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = '#ffffff0a')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ fontSize: 15, width: 20, textAlign: 'center' }}>{icon}</span>
      {label}
    </button>
  );
}
