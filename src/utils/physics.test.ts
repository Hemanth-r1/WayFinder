import { describe, test, expect } from 'vitest';
import { VehiclePhysics } from './physics';

describe('VehiclePhysics', () => {
  test('calculateAcceleration calculates correct values', () => {
    // Test with reasonable values
    const acceleration = VehiclePhysics.calculateAcceleration(
      10, // v = 10 m/s
      20, // s = 20 m
      0,  // dv = 0 m/s
      20, // v0 = 20 m/s (desired speed)
      1.0, // T = 1.0 s
      2.8, // a = 2.8 m/s²
      4.5, // b = 4.5 m/s²
      2.0  // s0 = 2.0 m
    );

    expect(acceleration).toBeLessThan(2.8); // Should be less than max acceleration
    expect(acceleration).toBeGreaterThan(0); // Should be positive when speed is below desired
  });

  test('getSafeDistance calculates safe following distance', () => {
    const safeDistance1 = VehiclePhysics.getSafeDistance(10, 1.0, 2.0); // v = 10 m/s
    expect(safeDistance1).toBe(12); // 2.0 + 10 * 1.0 = 12

    const safeDistance2 = VehiclePhysics.getSafeDistance(20, 1.5, 3.0); // v = 20 m/s
    expect(safeDistance2).toBe(33); // 3.0 + 20 * 1.5 = 33
  });

  test('calculateAcceleration handles edge cases', () => {
    // When speed is at desired speed (v = v0)
    const accelAtDesired = VehiclePhysics.calculateAcceleration(
      20, // v = v0
      30, // s = 30 m
      0,  // dv = 0
      20, // v0 = 20 m/s
      1.0,
      2.8,
      4.5,
      2.0
    );
    
    // When distance is very small
    const accelAtSmallDistance = VehiclePhysics.calculateAcceleration(
      10,
      0.5, // Very small distance
      -2, // Lead vehicle slowing down
      20,
      1.0,
      2.8,
      4.5,
      2.0
    );
    
    expect(accelAtDesired).toBeLessThanOrEqual(0); // Should be close to 0 or negative
    expect(accelAtSmallDistance).toBeLessThan(0); // Should be negative (braking)
  });
});