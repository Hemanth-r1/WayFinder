import { describe, test, expect } from 'vitest';
import { 
  haversineDistance, 
  formatDistance, 
  formatTime, 
  generateId, 
  clamp, 
  randomInRange,
  formatCoordinate
} from './index';

describe('Utility Functions', () => {
  test('haversineDistance calculates correct distance', () => {
    const pointA = { lat: 12.9716, lng: 77.5946 };
    const pointB = { lat: 12.9716, lng: 77.5947 };
    const distance = haversineDistance(pointA, pointB);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(100);
  });

  test('formatDistance formats meters correctly', () => {
    expect(formatDistance(500)).toBe('500 m');
    expect(formatDistance(1500)).toBe('1.5 km');
    expect(formatDistance(10000)).toBe('10.0 km');
  });

  test('formatTime formats seconds correctly', () => {
    expect(formatTime(45)).toBe('45s');
    expect(formatTime(90)).toBe('1m 30s');
    expect(formatTime(3725)).toBe('1h 2m');
  });

  test('generateId creates unique IDs', () => {
    const id1 = generateId('test');
    const id2 = generateId('test');
    expect(id1).toMatch(/^test_\w+_\w+$/);
    expect(id2).toMatch(/^test_\w+_\w+$/);
    expect(id1).not.toBe(id2);
  });

  test('clamp limits values correctly', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  test('randomInRange generates numbers in range', () => {
    for (let i = 0; i < 100; i++) {
      const value = randomInRange(10, 20);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(20);
    }
  });

  test('formatCoordinate formats correctly', () => {
    expect(formatCoordinate(12.9716, 77.5946)).toBe('12.971600, 77.594600');
    expect(formatCoordinate(0, 0)).toBe('0.000000, 0.000000');
  });
});

// Skip ColorUtils tests for now as they require DOM environment