# Task B4: Rewrite RoleSelector as profile widget

**Files:**
- Modify: `src/components/RoleSelector.tsx`

## Requirements

The current RoleSelector shows a dropdown to switch roles. Since roles are now stored in Firestore (read-only, not toggleable from UI), rewrite it as a compact profile widget showing email, role badge, and a sign out button.

```typescript
import { useAuth } from '../context/useAuth';

export default function RoleSelector() {
  const { user, role, signOut } = useAuth();

  const roleColors: Record<string, string> = {
    user: '#4CAF50',
    supporter: '#4488FF',
    controller: '#FF6D00',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{
        fontSize: 11, color: '#888', maxWidth: 140, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {user?.email}
      </span>
      <span style={{
        padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 'bold',
        background: `${roleColors[role] || '#555'}22`,
        color: roleColors[role] || '#888',
        border: `1px solid ${roleColors[role] || '#555'}44`,
        textTransform: 'capitalize',
      }}>
        {role}
      </span>
      <button onClick={signOut} style={{
        padding: '4px 10px', background: '#333', color: '#ccc',
        border: '1px solid #555', borderRadius: 4, cursor: 'pointer',
        fontSize: 11,
      }}>
        Sign Out
      </button>
    </div>
  );
}
```

After replacing, check `src/types/roles.ts` — if `ROLE_INFO` is no longer used anywhere, you can remove it. But be careful — check with grep first.

Run `npm run build` — must pass.

## Global Constraints
- `verbatimModuleSyntax: true`
- `noUnusedLocals` / `noUnusedParameters` are errors — if `ROLE_INFO` becomes unused, remove it
