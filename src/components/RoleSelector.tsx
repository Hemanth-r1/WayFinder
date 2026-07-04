import { useState } from 'react';
import { useAuth } from '../context/useAuth';
import { ROLE_INFO, type AppRole } from '../types/roles';

export default function RoleSelector() {
  const { role, setRole } = useAuth();
  const [open, setOpen] = useState(false);
  const info = ROLE_INFO[role];
  return (
    <div style={{ position: 'relative', zIndex: 1001 }}>
      <button onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: 'rgba(10,10,20,0.92)', border: `2px solid ${info.color}`, borderRadius: 8, cursor: 'pointer', fontFamily: 'monospace', fontSize: 13 }}>
        <span style={{ fontSize: 16 }}>{info.icon}</span>
        <span style={{ fontWeight: 'bold', color: info.color }}>{info.label}</span>
        <span style={{ color: '#888', fontSize: 10 }}>{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'rgba(10,10,20,0.95)', border: '1px solid #333', borderRadius: 8, overflow: 'hidden', minWidth: 280, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          {(Object.keys(ROLE_INFO) as AppRole[]).map((r) => {
            const ri = ROLE_INFO[r];
            return (
              <div key={r} onClick={() => { setRole(r); setOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: r === role ? `${ri.color}22` : 'transparent', borderLeft: r === role ? `3px solid ${ri.color}` : '3px solid transparent' }}>
                <span style={{ fontSize: 20 }}>{ri.icon}</span>
                <div><div style={{ fontWeight: 'bold', fontSize: 13, color: ri.color }}>{ri.label}</div><div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>{ri.description}</div></div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
