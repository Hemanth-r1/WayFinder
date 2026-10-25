/**
 * Admin panel: role requests to approve, every user with their role (change it, disable
 * the account), an overview of the system, the activity log and the announcement banner.
 * Roles change here — no Firebase console needed.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { serverClient, type AdminUser, type AdminOverview, type AdminLogEntry, type ControlLogEntry } from '../services/serverClient';
import { ROLES, ROLE_INFO, type AppRole } from '../types/roles';
import { COLORS, FONTS } from '../brand';
import { pushToast } from '../components/Toast';

type Tab = 'requests' | 'users' | 'overview' | 'activity' | 'announce';

function when(ms?: number): string {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ms).toLocaleDateString();
}

export default function AdminPanel({ myUid }: { myUid: string }) {
  const [tab, setTab] = useState<Tab>('requests');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [log, setLog] = useState<{ admin: AdminLogEntry[]; control: ControlLogEntry[] } | null>(null);
  const [text, setText] = useState('');
  const [level, setLevel] = useState<'info' | 'warning'>('info');
  const [busy, setBusy] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try { setUsers(await serverClient.adminUsers({ q: q || undefined, role: roleFilter || undefined, requested: tab === 'requests' })); }
    catch (err) { pushToast((err as Error).message, 'error'); }
  }, [q, roleFilter, tab]);

  useEffect(() => {
    if (tab === 'requests' || tab === 'users') loadUsers();
    if (tab === 'overview') serverClient.adminOverview().then(setOverview).catch(err => pushToast(err.message, 'error'));
    if (tab === 'activity') serverClient.adminLog().then(setLog).catch(err => pushToast(err.message, 'error'));
    if (tab === 'announce') serverClient.announcement().then(a => { setText(a?.text ?? ''); setLevel(a?.level ?? 'info'); }).catch(() => {});
  }, [tab, loadUsers]);

  const act = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    try { await fn(); pushToast(ok, 'success'); await loadUsers(); }
    catch (err) { pushToast((err as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  const userRow = (u: AdminUser) => (
    <div key={u.uid} style={s.row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: u.disabled ? COLORS.textSoft : COLORS.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: u.disabled ? 'line-through' : 'none' }}>
          {u.email ?? u.uid}{u.uid === myUid ? ' (you)' : ''}
        </div>
        <div style={{ fontSize: 10, color: COLORS.textSoft }}>
          seen {when(u.lastSeenAt)}{u.requestedRole && u.requestedRole !== u.role ? <> · <span style={{ color: COLORS.amber }}>asks for {u.requestedRole}</span></> : null}
        </div>
      </div>
      {tab === 'requests' && u.requestedRole ? (
        <>
          <button disabled={!!busy} style={{ ...s.btn, background: COLORS.gradientCta, color: '#04121a' }}
            onClick={() => act(u.uid, () => serverClient.adminSetRole(u.uid, u.requestedRole!), `${u.email ?? u.uid} is now ${u.requestedRole}`)}>Approve</button>
          <button disabled={!!busy} style={s.btn} onClick={() => act(u.uid, () => serverClient.adminDecline(u.uid), 'Request declined')}>Decline</button>
        </>
      ) : (
        <>
          <select value={u.role} disabled={busy === u.uid} aria-label="Role"
            onChange={e => act(u.uid, () => serverClient.adminSetRole(u.uid, e.target.value), `${u.email ?? u.uid} is now ${e.target.value}`)}
            style={{ ...s.select, color: ROLE_INFO[u.role as AppRole]?.colour ?? COLORS.text }}>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
          </select>
          {u.uid !== myUid && (
            <button disabled={!!busy} style={s.btn} title={u.disabled ? 'Allow this account again' : 'Sign this account out and block it'}
              onClick={() => act(u.uid, () => serverClient.adminSetDisabled(u.uid, !u.disabled), u.disabled ? 'Account enabled' : 'Account disabled')}>
              {u.disabled ? 'Enable' : 'Disable'}
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div style={{ padding: '12px 14px', borderTop: `1px solid ${COLORS.border}` }}>
      <div style={{ fontFamily: FONTS.display, fontWeight: 800, fontSize: 14, color: COLORS.purple, marginBottom: 8 }}>Admin</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {([['requests', 'Requests'], ['users', 'Users'], ['overview', 'Overview'], ['activity', 'Activity'], ['announce', 'Announcement']] as const).map(([t, l]) => (
          <button key={t} onClick={() => setTab(t)} style={{ ...s.tab, ...(tab === t ? s.tabOn : {}) }}>{l}</button>
        ))}
      </div>

      {(tab === 'requests' || tab === 'users') && (
        <>
          {tab === 'users' && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadUsers()} placeholder="Search email or ID" style={{ ...s.input, flex: 1 }} />
              <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} style={s.select} aria-label="Filter by role">
                <option value="">All roles</option>
                {ROLES.map(r => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
              </select>
            </div>
          )}
          {users.length === 0 && <div style={s.muted}>{tab === 'requests' ? 'No role requests waiting.' : 'No users match.'}</div>}
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>{users.map(userRow)}</div>
          {tab === 'users' && (
            <div style={{ ...s.muted, marginTop: 8 }}>
              {ROLES.map(r => <div key={r}><b style={{ color: ROLE_INFO[r].colour }}>{ROLE_INFO[r].label}</b> — {ROLE_INFO[r].summary}</div>)}
            </div>
          )}
        </>
      )}

      {tab === 'overview' && overview && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {[
            ['Users', overview.users.total], ['Active today', overview.users.activeToday],
            ['Role requests', overview.users.pendingRequests], ['Disabled', overview.users.disabled],
            ['Vehicles (sim)', overview.live.vehicles], ['Navigating now', overview.live.navigators],
            ['Emergency runs', overview.live.emergencies], ['Trips arrived', overview.trips?.done ?? '—'],
            ['Server memory', `${overview.server.memoryMB} MB`], ['Uptime', `${overview.server.uptimeMin} min`],
          ].map(([k, v]) => (
            <div key={String(k)} style={s.stat}><div style={{ fontSize: 10, color: COLORS.textSoft }}>{k}</div><div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>{v}</div></div>
          ))}
          <div style={{ ...s.muted, gridColumn: '1 / -1' }}>
            By role: {Object.entries(overview.users.byRole).map(([r, n]) => `${ROLE_INFO[r as AppRole]?.label ?? r} ${n}`).join(' · ')}
            {overview.server.mode === 'demo' && ' · demo mode (roles come from the browser)'}
          </div>
        </div>
      )}

      {tab === 'activity' && log && (
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          <div style={s.label}>Admin actions</div>
          {log.admin.length === 0 && <div style={s.muted}>None yet.</div>}
          {log.admin.slice(0, 40).map((e, i) => <div key={i} style={s.logRow}>{new Date(e.at).toLocaleString()} · <b>{e.action}</b> {e.detail} <span style={{ color: COLORS.textSoft }}>· {e.by}</span></div>)}
          <div style={s.label}>Signal control</div>
          {log.control.slice(0, 40).map((e, i) => <div key={i} style={s.logRow}>{new Date(e.at).toLocaleString()} · {e.junction} · <b>{e.action}</b> {e.detail} <span style={{ color: COLORS.textSoft }}>· {e.by}</span></div>)}
        </div>
      )}

      {tab === 'announce' && (
        <div>
          <div style={s.muted}>Shown at the top of the app for everyone (e.g. road closures, events). Empty = none.</div>
          <textarea value={text} onChange={e => setText(e.target.value.slice(0, 280))} rows={3} placeholder="e.g. Hebbal flyover closed 10 pm–5 am for repairs" style={{ ...s.input, width: '100%', marginTop: 6, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <select value={level} onChange={e => setLevel(e.target.value as 'info' | 'warning')} style={s.select} aria-label="Kind">
              <option value="info">Information</option>
              <option value="warning">Warning</option>
            </select>
            <span style={{ ...s.muted, flex: 1 }}>{text.length}/280</span>
            <button disabled={busy === 'ann'} style={{ ...s.btn, background: COLORS.gradientCta, color: '#04121a' }}
              onClick={async () => { setBusy('ann'); try { await serverClient.setAnnouncement(text, level); pushToast(text.trim() ? 'Announcement published' : 'Announcement removed', 'success'); } catch (err) { pushToast((err as Error).message, 'error'); } finally { setBusy(null); } }}>
              {text.trim() ? 'Publish' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  tab: { padding: '6px 10px', fontSize: 11, borderRadius: 999, background: COLORS.surface, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, cursor: 'pointer' },
  tabOn: { background: `${COLORS.purple}26`, color: COLORS.text, borderColor: COLORS.purple },
  row: { display: 'flex', gap: 6, alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${COLORS.border}` },
  btn: { padding: '6px 10px', fontSize: 11, borderRadius: 999, background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, cursor: 'pointer', fontWeight: 600 },
  select: { padding: '6px 8px', fontSize: 11, borderRadius: 10, background: COLORS.bgDeep, border: `1px solid ${COLORS.border}`, color: COLORS.text },
  input: { padding: '8px 10px', fontSize: 12, borderRadius: 10, background: COLORS.bgDeep, border: `1px solid ${COLORS.border}`, color: COLORS.text, outline: 'none' },
  muted: { fontSize: 11, color: COLORS.textSoft, lineHeight: 1.5 },
  stat: { background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '8px 10px' },
  label: { fontSize: 10, color: COLORS.textSoft, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, margin: '10px 0 4px' },
  logRow: { fontSize: 11, color: COLORS.textMuted, padding: '3px 0', borderBottom: `1px solid ${COLORS.border}` },
};
