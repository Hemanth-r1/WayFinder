import type { AppRole } from '../types/roles';

/** Generate a simple user ID based on role + timestamp */
export function generateUserId(role: AppRole): string {
  return `${role}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Validate if a string is a valid AppRole */
export function isValidRole(role: string): role is AppRole {
  return ['user', 'supporter', 'controller'].includes(role);
}

/** Get default role for new users */
export function getDefaultRole(): AppRole {
  return 'user';
}

/** Check if user can switch to a specific role */
export function canSwitchRole(currentRole: AppRole, targetRole: AppRole): boolean {
  // All roles can switch to any other role in this implementation
  // Could add restrictions here if needed
  return currentRole !== targetRole;
}