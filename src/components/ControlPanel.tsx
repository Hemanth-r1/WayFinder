export default function ControlPanel() {
  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, zIndex: 1000,
      background: 'rgba(10,10,20,0.92)', border: '1px solid #333',
      borderRadius: 8, padding: 12,
      maxHeight: 'calc(100vh - 24px)',
      fontFamily: 'system-ui, sans-serif', fontSize: 12, color: '#ccc',
      backdropFilter: 'blur(4px)',
      minWidth: 180,
    }}>
      <div style={{ fontWeight: 'bold', color: '#fff', fontSize: 13, marginBottom: 8 }}>
        ⚙️ Controls
      </div>
      <div style={{ fontSize: 11, color: '#666' }}>
        Control panel — coming soon
      </div>
    </div>
  );
}
