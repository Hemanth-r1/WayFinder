/**
 * WayFinder roles (the server's auth.ts has the same list):
 * - user: drivers — plan trips, navigate, report road problems
 * - responder: ambulance / fire / police drivers — emergency runs (green corridors)
 * - supporter: traffic wardens / volunteers — verify reports at once, map signals, view junctions
 * - controller: traffic police — control signals, turn rules, emergency dispatch
 * - admin: everything a controller can do, plus users, roles, announcements and the audit log
 */
export type AppRole = 'user' | 'responder' | 'supporter' | 'controller' | 'admin';
export const ROLES: AppRole[] = ['user', 'responder', 'supporter', 'controller', 'admin'];

export const ROLE_INFO: Record<AppRole, { label: string; colour: string; summary: string }> = {
  user: { label: 'User', colour: '#2fe4cc', summary: 'Drivers: trips, navigation, road reports' },
  responder: { label: 'Responder', colour: '#ff7a59', summary: 'Ambulance, fire and police drivers: emergency runs' },
  supporter: { label: 'Supporter', colour: '#4f8ef7', summary: 'Wardens and volunteers: verify reports, map signals, view junctions' },
  controller: { label: 'Controller', colour: '#fbbf24', summary: 'Traffic police: signals, turn rules, emergency dispatch' },
  admin: { label: 'Admin', colour: '#a78bfa', summary: 'Everything, plus users, roles and announcements' },
};

/** Drivers' view (trip planner): users and responders. */
export const isDriver = (role: string) => role === 'user' || role === 'responder';
/** Signal control: controllers and admins. */
export const canControl = (role: string) => role === 'controller' || role === 'admin';
/** Operators' tools (junctions, conditions, reports): supporters, controllers, admins. */
export const isOperator = (role: string) => role === 'supporter' || canControl(role);

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
