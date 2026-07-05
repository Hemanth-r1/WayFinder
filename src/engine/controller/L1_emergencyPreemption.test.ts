import { describe, test, expect } from 'vitest';
import { applyL1 } from './L1_emergencyPreemption';
import { makeSignal, makeVehicle } from './__fixtures__';

describe('L1 — Emergency Preemption', () => {
  test('forces GREEN in emergency direction and RED across', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const nodes = new Map([[signal.nodeId, { id: signal.nodeId, lat: 12.9716, lng: 77.5946, isIntersection: true }]]);
    const vehicles = new Map([
      ['V1', makeVehicle({ id: 'V1', type: 'emergency', bearing: 0 })],
    ]);

    const result = applyL1(vehicles, signals, nodes, new Map(), 0.05, {
      emergencyHoldTime: 15,
      emergencyRadius: 200,
    });

    expect(result.size).toBe(1);
    const nsGreen = signal.phases.find(p => p.group === 'NS' && p.color === 'GREEN');
    const ewRed = signal.phases.find(p => p.group === 'EW' && p.color === 'RED');
    expect(nsGreen).toBeDefined();
    expect(ewRed).toBeDefined();
    expect(result.get(signal.id)?.timeRemaining).toBeGreaterThan(0);
  });

  test('does nothing when no emergency vehicles present', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const nodes = new Map([[signal.nodeId, { id: signal.nodeId, lat: 12.9716, lng: 77.5946, isIntersection: true }]]);
    const vehicles = new Map([
      ['V1', makeVehicle({ id: 'V1', type: 'sedan', bearing: 0 })],
    ]);
    const origPhases = signal.phases.map(p => ({ ...p }));

    const result = applyL1(vehicles, signals, nodes, new Map(), 0.05, {
      emergencyHoldTime: 15,
      emergencyRadius: 200,
    });

    expect(result.size).toBe(0);
    for (let i = 0; i < signal.phases.length; i++) {
      expect(signal.phases[i].color).toBe(origPhases[i].color);
    }
  });

  test('decrements timeRemaining each tick', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const nodes = new Map([[signal.nodeId, { id: signal.nodeId, lat: 12.9716, lng: 77.5946, isIntersection: true }]]);
    const vehicles = new Map();
    const activeOverrides = new Map([
      [signal.id, { signalId: signal.id, vehicleId: 'V1', direction: 'N' as const, timeRemaining: 10 }],
    ]);

    const result = applyL1(vehicles, signals, nodes, activeOverrides, 1, {
      emergencyHoldTime: 15,
      emergencyRadius: 200,
    });

    expect(result.get(signal.id)?.timeRemaining).toBe(9);
  });

  test('expires override when timeRemaining hits zero', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const nodes = new Map([[signal.nodeId, { id: signal.nodeId, lat: 12.9716, lng: 77.5946, isIntersection: true }]]);
    const vehicles = new Map();
    const activeOverrides = new Map([
      [signal.id, { signalId: signal.id, vehicleId: 'V1', direction: 'N' as const, timeRemaining: 0.5 }],
    ]);

    const result = applyL1(vehicles, signals, nodes, activeOverrides, 1, {
      emergencyHoldTime: 15,
      emergencyRadius: 200,
    });

    expect(result.has(signal.id)).toBe(false);
  });

  test('EW-bound emergency forces EW green', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const nodes = new Map([[signal.nodeId, { id: signal.nodeId, lat: 12.9716, lng: 77.5946, isIntersection: true }]]);
    const vehicles = new Map([
      ['V1', makeVehicle({ id: 'V1', type: 'emergency', bearing: 90 })],
    ]);

    applyL1(vehicles, signals, nodes, new Map(), 0.05, {
      emergencyHoldTime: 15,
      emergencyRadius: 200,
    });

    const ewGreen = signal.phases.find(p => p.group === 'EW' && p.color === 'GREEN');
    const nsRed = signal.phases.find(p => p.group === 'NS' && p.color === 'RED');
    expect(ewGreen).toBeDefined();
    expect(nsRed).toBeDefined();
  });

  test('ignores emergency vehicles outside detection radius', () => {
    const signal = makeSignal({ nodeId: 'N-SIG' });
    const signals = new Map([[signal.id, signal]]);
    const nodes = new Map([[signal.nodeId, { id: signal.nodeId, lat: 12.9716, lng: 77.5946, isIntersection: true }]]);
    const vehicles = new Map([
      ['V1', makeVehicle({ id: 'V1', type: 'emergency', bearing: 0, lat: 13.0, lng: 77.9 })],
    ]);

    const result = applyL1(vehicles, signals, nodes, new Map(), 0.05, {
      emergencyHoldTime: 15,
      emergencyRadius: 200,
    });

    expect(result.size).toBe(0);
  });

  test('skips already-overridden signals when re-arming', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const nodes = new Map([[signal.nodeId, { id: signal.nodeId, lat: 12.9716, lng: 77.5946, isIntersection: true }]]);
    const vehicles = new Map([
      ['V1', makeVehicle({ id: 'V1', type: 'emergency', bearing: 0 })],
    ]);
    const preExisting = new Map([
      [signal.id, { signalId: signal.id, vehicleId: 'V-prev', direction: 'N' as const, timeRemaining: 5 }],
    ]);

    const result = applyL1(vehicles, signals, nodes, preExisting, 0.05, {
      emergencyHoldTime: 15,
      emergencyRadius: 200,
    });

    expect(result.get(signal.id)?.vehicleId).toBe('V-prev');
  });
});
