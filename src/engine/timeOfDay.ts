/**
 * Time-of-Day Simulation
 * Modulates traffic density and signal timing based on simulated time.
 * Supports compressed simulation time (1 real second = configurable sim minutes).
 */

export type TimeOfDay = 'early_morning' | 'morning_rush' | 'midday' | 'evening_rush' | 'night';

export interface SimClock {
  /** Simulated hour (0–23) */
  hour: number;
  /** Simulated minute (0–59) */
  minute: number;
  /** Wall-clock elapsed seconds */
  elapsed: number;
  /** Simulation speed multiplier (real seconds per sim minute) */
  simMinutesPerRealSecond: number;
}

export interface TimeProfile {
  label: string;
  icon: string;
  /** Traffic volume multiplier (0.2 = sparse, 1.5 = rush hour) */
  volumeMultiplier: number;
  /** Signal cycle length multiplier */
  cycleLengthMultiplier: number;
  /** Speed limit compliance (lower = more aggressive) */
  driverCompliance: number;
  /** Congestion sensitivity */
  congestionSensitivity: number;
  color: string;
}

export const TIME_PROFILES: Record<TimeOfDay, TimeProfile> = {
  early_morning: {
    label: 'Early Morning',
    icon: '🌙',
    volumeMultiplier: 0.2,
    cycleLengthMultiplier: 0.7,
    driverCompliance: 1.1,
    congestionSensitivity: 0.3,
    color: '#1a237e',
  },
  morning_rush: {
    label: 'Morning Rush',
    icon: '🌅',
    volumeMultiplier: 1.5,
    cycleLengthMultiplier: 1.3,
    driverCompliance: 0.85,
    congestionSensitivity: 1.4,
    color: '#e65100',
  },
  midday: {
    label: 'Midday',
    icon: '☀️',
    volumeMultiplier: 0.8,
    cycleLengthMultiplier: 1.0,
    driverCompliance: 1.0,
    congestionSensitivity: 0.9,
    color: '#f9a825',
  },
  evening_rush: {
    label: 'Evening Rush',
    icon: '🌆',
    volumeMultiplier: 1.4,
    cycleLengthMultiplier: 1.25,
    driverCompliance: 0.8,
    congestionSensitivity: 1.3,
    color: '#bf360c',
  },
  night: {
    label: 'Night',
    icon: '🌃',
    volumeMultiplier: 0.3,
    cycleLengthMultiplier: 0.6,
    driverCompliance: 1.05,
    congestionSensitivity: 0.4,
    color: '#0d47a1',
  },
};

/** Returns time-of-day category for a given hour */
export function classifyHour(hour: number): TimeOfDay {
  if (hour >= 0 && hour < 6) return 'early_morning';
  if (hour >= 6 && hour < 10) return 'morning_rush';
  if (hour >= 10 && hour < 17) return 'midday';
  if (hour >= 17 && hour < 21) return 'evening_rush';
  return 'night';
}

/** Create a new simulation clock starting at a given hour */
export function createSimClock(startHour = 8, simMinutesPerRealSecond = 2): SimClock {
  return { hour: startHour, minute: 0, elapsed: 0, simMinutesPerRealSecond };
}

/** Advance the clock by deltaTime real seconds, returns updated clock */
export function tickClock(clock: SimClock, deltaTime: number): SimClock {
  const newElapsed = clock.elapsed + deltaTime;
  const totalSimMinutes = newElapsed * clock.simMinutesPerRealSecond;
  const totalHours = Math.floor(totalSimMinutes / 60);
  const minute = Math.floor(totalSimMinutes % 60);
  const hour = (clock.hour + totalHours) % 24;
  return { ...clock, elapsed: newElapsed, hour, minute };
}

/** Format sim time as HH:MM string */
export function formatSimTime(clock: SimClock): string {
  const h = clock.hour.toString().padStart(2, '0');
  const m = clock.minute.toString().padStart(2, '0');
  return `${h}:${m}`;
}

/** Get current time profile */
export function getCurrentProfile(clock: SimClock): TimeProfile {
  return TIME_PROFILES[classifyHour(clock.hour)];
}
