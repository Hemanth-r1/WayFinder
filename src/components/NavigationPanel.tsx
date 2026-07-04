import { useState } from 'react';

export default function NavigationPanel() {
  const [expanded, setExpanded] = useState(true);

  return (
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 1000,
      background: 'rgba(10,10,20,0.92)', border: '1px solid #333',
      borderRadius: 8, padding: 0,
      maxHeight: 'calc(100vh - 24px)',
      fontFamily: 'system-ui, sans-serif', fontSize: 12, color: '#ccc',
      backdropFilter: 'blur(4px)',
      transition: 'width 0.2s',
      width: expanded ? 260 : 36,
      overflow: 'hidden',
    }}>
      {expanded && (
        <div style={{ padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 'bold', color: '#fff', fontSize: 13 }}>🧭 Navigation</span>
            <button
              onClick={() => setExpanded(false)}
              style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
            >✕</button>
          </div>
          <div style={{ fontSize: 11, color: '#666' }}>
            Route finding — coming soon
          </div>
        </div>
      )}
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            position: 'absolute', top: '50%', left: 12, transform: 'translateY(-50%)',
            background: 'rgba(10,10,20,0.92)', border: '1px solid #333',
            borderRadius: 8, color: '#888', cursor: 'pointer', fontSize: 16,
            padding: '8px 6px', lineHeight: '1',
          }}
        >🧭</button>
      )}
    </div>
  );
}
