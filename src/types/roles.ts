/**
 * Role System — Defines the three user roles and their capabilities.
 *
 * Roles:
 * - User: Regular app user, provides route info (source/destination)
 * - Supporter: Map contributor, adds/edits signals, fills infrastructure gaps
 * - Controller: Central signal manager, overrides signals, manages routes
 */

/** The three application roles */
export type AppRole = 'user' | 'supporter' | 'controller';

/** Permission flags for each role */
export interface RolePermissions {
  canViewMap: boolean;
  canClickSignals: boolean;
  canAddSignals: boolean;
  canEditSignals: boolean;
  canDeleteSignals: boolean;
  canOverrideSignals: boolean;
  canOverrideRoute: boolean;
  canViewAnalytics: boolean;
  canSubmitRoute: boolean;
  canViewAllRoutes: boolean;
  canManageController: boolean;
}

/** Default permissions for each role */
export const ROLE_PERMISSIONS: Record<AppRole, RolePermissions> = {
  user: {
    canViewMap: true,
    canClickSignals: true,
    canAddSignals: false,
    canEditSignals: false,
    canDeleteSignals: false,
    canOverrideSignals: false,
    canOverrideRoute: false,
    canViewAnalytics: false,
    canSubmitRoute: true,
    canViewAllRoutes: false,
    canManageController: false,
  },
  supporter: {
    canViewMap: true,
    canClickSignals: true,
    canAddSignals: true,
    canEditSignals: true,
    canDeleteSignals: true,
    canOverrideSignals: false,
    canOverrideRoute: false,
    canViewAnalytics: false,
    canSubmitRoute: true,
    canViewAllRoutes: false,
    canManageController: false,
  },
  controller: {
    canViewMap: true,
    canClickSignals: true,
    canAddSignals: true,
    canEditSignals: true,
    canDeleteSignals: true,
    canOverrideSignals: true,
    canOverrideRoute: true,
    canViewAnalytics: true,
    canSubmitRoute: true,
    canViewAllRoutes: true,
    canManageController: true,
  },
};

/** User-submitted route information */
export interface UserRoute {
  id: string;
  userId: string;
  sourceLat: number;
  sourceLng: number;
  destLat: number;
  destLng: number;
  sourceName: string;
  destName: string;
  timestamp: number;
  signalOverrides: string[]; // Signal IDs used on this route
}

/** Signal override record for controller actions */
export interface SignalOverride {
  id: string;
  controllerId: string;
  signalId: string;
  routeId?: string; // If overriding an entire route
  direction: string;
  color: string;
  timestamp: number;
  reason: string;
  expiresAt: number;
}

/** Supporter-added signal data */
export interface SupporterSignal {
  id: string;
  supporterId: string;
  lat: number;
  lng: number;
  roadName: string;
  signalType: 'auto' | 'manual' | 'smart';
  timestamp: number;
  notes: string;
}
