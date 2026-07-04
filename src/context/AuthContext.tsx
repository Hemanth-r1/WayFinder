/**
 * Auth Context — Manages user role state across the application.
 *
 * Provides:
 * - Current role (user/supporter/controller)
 * - Role switching
 * - Permission checks
 * - User ID for tracking
 *
 * Usage:
 *   import { useAuth } from './context/useAuth';
 *   const { role, setRole, hasPermission } = useAuth();
 */
import { createContext, useState, useCallback, type ReactNode } from 'react';
import type { AppRole, RolePermissions } from '../types/roles';
import { generateUserId } from '../utils/auth';
import { ROLE_PERMISSIONS } from '../utils/rolePermissions';

export interface AuthState {
  role: AppRole;
  userId: string;
  setRole: (role: AppRole) => void;
  hasPermission: (perm: keyof RolePermissions) => boolean;
  getPermissions: () => RolePermissions;
}

export const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<AppRole>('user');
  const [userId, setUserId] = useState(() => generateUserId('user'));

  const setRole = useCallback((newRole: AppRole) => {
    setRoleState(newRole);
    setUserId(generateUserId(newRole));
  }, []);

  const hasPermission = useCallback((perm: keyof RolePermissions): boolean => {
    return ROLE_PERMISSIONS[role][perm];
  }, [role]);

  const getPermissions = useCallback((): RolePermissions => {
    return ROLE_PERMISSIONS[role];
  }, [role]);

  return (
    <AuthContext.Provider value={{ role, userId, setRole, hasPermission, getPermissions }}>
      {children}
    </AuthContext.Provider>
  );
}
