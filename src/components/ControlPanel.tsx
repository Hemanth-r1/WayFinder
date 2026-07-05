const LEGEND_ITEMS = [
  { label: 'Primary Road', color: '#FF6D00', weight: 4 },
  { label: 'Secondary Road', color: '#FF9100', weight: 3 },
  { label: 'Local Road', color: '#FFAB4044', weight: 1.5 },
  { label: 'Green Signal', color: '#00E676', weight: 0 },
  { label: 'Yellow Signal', color: '#FFD600', weight: 0 },
  { label: 'Red Signal', color: '#FF1744', weight: 0 },
];

const VEHICLE_LEGEND = [
  { icon: '🚗', label: 'Car' },
  { icon: '🚌', label: 'Bus' },
  { icon: '🚚', label: 'Truck' },
  { icon: '🚨', label: 'Emergency' },
  { icon: '🛵', label: 'Bike' },
  { icon: '🛺', label: 'Auto' },
];

export default function ControlPanel() {
  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, zIndex: 1000,
      background: 'rgba(10,10,20,0.92)', border: '1px solid #333',
      borderRadius: 8, padding: 10,
      maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
      fontFamily: 'system-ui, sans-serif', fontSize: 11, color: '#ccc',
      backdropFilter: 'blur(4px)',
      minWidth: 160,
    }}>
      <div style={{ fontWeight: 'bold', color: '#fff', fontSize: 12, marginBottom: 8 }}>
        Legend
      </div>
      {/* Road / Signal colors */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Roads</div>
        {LEGEND_ITEMS.slice(0, 3).map(item => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{
              width: 20, height: item.weight || 4, borderRadius: 2,
              background: item.color, display: 'inline-block',
            }} />
            <span style={{ fontSize: 10 }}>{item.label}</span>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Signals</div>
        {LEGEND_ITEMS.slice(3).map(item => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: item.color, display: 'inline-block',
            }} />
            <span style={{ fontSize: 10 }}>{item.label}</span>
          </div>
        ))}
      </div>
      <div>
        <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Vehicles</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
          {VEHICLE_LEGEND.map(v => (
            <div key={v.label} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}>
              <span>{v.icon}</span>
              <span>{v.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
