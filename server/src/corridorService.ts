import type { Vehicle } from './types.js';

export function detectActiveCorridors(vehicles: Vehicle[]): number {
  const directions = vehicles.filter(v => v.speed > 10).length;
  return directions > 20 ? Math.floor(directions / 10) : 0;
}
