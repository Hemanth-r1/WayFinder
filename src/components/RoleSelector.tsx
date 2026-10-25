import { useState } from 'react';
import { useAuth } from '../context/useAuth';
import { pushToast } from './Toast';

const NEXT_ROLE: Record<string, string> = {
  user: 'supporter',
  supporter: 'controller',
  controller: 'admin',
  responder: 'supporter',
  admin: 'admin',
};

const ROLE_LABELS: Record<string, string> = {
  user: 'Want to become a supporter?',
  supporter: 'Request controller promotion?',
  controller: 'Admin access?',
  responder: 'Ambulance / fire / police driver',
  admin: 'You have full access',
};

const ROLE_DESCRIPTION: Record<string, string> = {
  user: 'Supporters can add signals and manage overrides',
  supporter: 'Controllers have full system access',
  controller: 'Admins manage users, roles and announcements',
  responder: 'You can start emergency runs from the trip planner',
  admin: 'Manage users and roles in the Admin panel',
};

export default function RoleSelector() {
  const { user, role, signOut, promoteRole, isFirebaseAvailable } = useAuth();
  const [showPromote, setShowPromote] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const roleColors: Record<string, string> = {
    controller: '#fbbf24',
    responder: '#ff7a59',
    user: '#2fe4cc',
    supporter: '#4f8ef7',
    admin: '#a78bfa',
  };

  const handlePromote = async () => {
    const next = NEXT_ROLE[role];
    if (!next || next === role) return;
    setPromoting(true);
    try {
      await promoteRole(next);
      pushToast(isFirebaseAvailable ? `Requested ${next} access — an admin will review it` : `Switched to ${next} (demo)`, 'success');
    } catch {
      pushToast('Role request failed', 'error');
    }
    setPromoting(false);
    setShowPromote(false);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
      <span
        onClick={() => setShowPromote(p => !p)}
        title={user?.email ?? undefined}
        style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 'bold',
          background: `${roleColors[role] || '#555'}22`,
          color: roleColors[role] || '#888',
          border: `1px solid ${roleColors[role] || '#555'}44`,
          textTransform: 'capitalize',
          cursor: role !== 'admin' ? 'pointer' : 'default',
        }}
      >
        {role}
      </span>
      <button onClick={signOut} style={{
        padding: '0 12px', minHeight: 32, background: '#333', color: '#ccc',
        border: '1px solid #555', borderRadius: 6, cursor: 'pointer',
        fontSize: 12,
      }}>
        Sign Out
      </button>

      {showPromote && role !== 'admin' && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6,
          background: 'rgba(10,10,13,0.97)', border: '1px solid #333',
          borderRadius: 8, padding: 12, zIndex: 2000, minWidth: 220,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: '#fff', marginBottom: 4 }}>
            {ROLE_LABELS[role]}
          </div>
          <div style={{ fontSize: 10, color: '#888', marginBottom: 10 }}>
            {ROLE_DESCRIPTION[role]}
          </div>
          <button
            onClick={handlePromote}
            disabled={promoting}
            style={{
              padding: '8px 16px', background: roleColors[NEXT_ROLE[role]] || '#4f8ef7',
              color: '#fff', border: 'none', borderRadius: 6, cursor: promoting ? 'wait' : 'pointer',
              fontSize: 12, fontWeight: 'bold', width: '100%',
            }}
          >
            {promoting ? 'Sending…' : isFirebaseAvailable ? `Request ${NEXT_ROLE[role]} access` : `Switch to ${NEXT_ROLE[role]} (demo)`}
          </button>
          {role !== 'responder' && (
            <button onClick={async () => {
              setPromoting(true);
              try { await promoteRole('responder'); pushToast(isFirebaseAvailable ? 'Requested responder access — an admin will review it' : 'Switched to responder (demo)', 'success'); }
              catch { pushToast('Role request failed', 'error'); }
              setPromoting(false); setShowPromote(false);
            }} disabled={promoting} style={{
              marginTop: 6, padding: '7px 16px', background: '#1a0d10', color: '#FF8A80', border: '1px solid #5a1a24',
              borderRadius: 6, cursor: promoting ? 'wait' : 'pointer', fontSize: 12, width: '100%',
            }}>
              🚑 {isFirebaseAvailable ? 'I drive an ambulance / fire / police vehicle' : 'Switch to responder (demo)'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
