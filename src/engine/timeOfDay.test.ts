import { describe, test, expect } from 'vitest';
import {
  classifyHour, createSimClock, tickClock, formatSimTime, getCurrentProfile, TIME_PROFILES,
} from './timeOfDay';

describe('classifyHour', () => {
  test('early morning', () => { expect(classifyHour(3)).toBe('early_morning'); });
  test('morning rush', () => { expect(classifyHour(8)).toBe('morning_rush'); });
  test('midday', () => { expect(classifyHour(12)).toBe('midday'); });
  test('evening rush', () => { expect(classifyHour(18)).toBe('evening_rush'); });
  test('night', () => { expect(classifyHour(22)).toBe('night'); });
  test('midnight', () => { expect(classifyHour(0)).toBe('early_morning'); });
});

describe('createSimClock', () => {
  test('starts at given hour', () => {
    const clock = createSimClock(8, 2);
    expect(clock.hour).toBe(8);
    expect(clock.minute).toBe(0);
    expect(clock.elapsed).toBe(0);
    expect(clock.simMinutesPerRealSecond).toBe(2);
  });
});

describe('tickClock', () => {
  test('advances time correctly', () => {
    const clock = createSimClock(8, 2); // 2 sim-min per real-sec
    const after = tickClock(clock, 30); // 30 real seconds = 60 sim minutes = 1 hour
    expect(after.elapsed).toBe(30);
    expect(after.hour).toBe(9); // 8 + 1 hour
    expect(after.minute).toBe(0);
  });

  test('wraps at midnight', () => {
    const clock = createSimClock(23, 120); // 120 sim-min per real-sec
    const after = tickClock(clock, 60); // 60 seconds = 7200 sim minutes = 120 sim hours → wraps
    expect(after.hour).toBeGreaterThanOrEqual(0);
    expect(after.hour).toBeLessThan(24);
  });
});

describe('formatSimTime', () => {
  test('pads hours and minutes', () => {
    const clock = createSimClock(8, 2);
    expect(formatSimTime(clock)).toBe('08:00');
  });

  test('formats noon correctly', () => {
    const clock = createSimClock(12, 2);
    expect(formatSimTime(clock)).toBe('12:00');
  });
});

describe('getCurrentProfile', () => {
  test('returns morning rush profile at 8am', () => {
    const clock = createSimClock(8, 2);
    const profile = getCurrentProfile(clock);
    expect(profile).toBe(TIME_PROFILES.morning_rush);
    expect(profile.volumeMultiplier).toBeGreaterThan(1);
  });

  test('returns night profile at 11pm', () => {
    const clock = createSimClock(23, 2);
    const profile = getCurrentProfile(clock);
    expect(profile).toBe(TIME_PROFILES.night);
    expect(profile.volumeMultiplier).toBeLessThan(0.5);
  });
});
