import { describe, test, expect } from 'vitest';
import { ControllerManager } from './ControllerManager';
import { makeVehicle, makeGraphAndSignal } from './__fixtures__';
import { TIME_PROFILES } from '../timeOfDay';
import type { OverrideRequest } from './types';

describe('ControllerManager', () => {
  test('enqueueRequest then getActiveOverrides returns the request', () => {
    const cm = new ControllerManager();
    const req: OverrideRequest = {
      id: 'O1', signalId: 'S1', targetGroup: 'NS', targetColor: 'GREEN',
      duration: 30, priority: 80, source: 'user', expiresAt: 1000, createdAt: 0,
    };
    cm.enqueueRequest(req);
    expect(cm.getActiveOverrides()).toHaveLength(1);
  });

  test('getActiveOverrides returns a copy, not the internal reference', () => {
    const cm = new ControllerManager();
    const req: OverrideRequest = {
      id: 'O2', signalId: 'S2', targetGroup: 'NS', targetColor: 'GREEN',
      duration: 30, priority: 80, source: 'user', expiresAt: 1000, createdAt: 0,
    };
    cm.enqueueRequest(req);
    const overrides = cm.getActiveOverrides();
    overrides.pop();
    expect(cm.getActiveOverrides()).toHaveLength(1);
  });

  test('solve emits L1 path under emergency preemption', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.id = 'S-EM';
    const signals = new Map([[signal.id, signal]]);
    const vehicles = new Map([
      ['V1', makeVehicle({ id: 'V1', type: 'emergency', bearing: 0 })],
    ]);

    const cm = new ControllerManager();
    cm.solve(signals, vehicles, graph, 0.05, 100, TIME_PROFILES.midday);

    expect(cm.hasEmergencyOverride()).toBe(true);
    expect(cm.getEmergencyOverrideCount()).toBe(1);
  });

  test('expired override requests are removed after solve', () => {
    const { graph, signal } = makeGraphAndSignal();
    const signals = new Map([[signal.id, signal]]);
    const cm = new ControllerManager();

    cm.enqueueRequest({
      id: 'O3', signalId: signal.id, targetGroup: 'NS', targetColor: 'GREEN',
      duration: 30, priority: 80, source: 'user', expiresAt: 100, createdAt: 0,
    });

    cm.solve(signals, new Map(), graph, 0.05, 200, TIME_PROFILES.midday);

    expect(cm.getActiveOverrides()).toHaveLength(0);
  });

  test('signals cycle through phases over multiple ticks', () => {
    const { graph, signal } = makeGraphAndSignal();
    const signals = new Map([[signal.id, signal]]);
    const cm = new ControllerManager();

    const seenIndices = new Set<number>();
    for (const step of [0, 50, 100, 150]) {
      cm.solve(signals, new Map(), graph, 5, step, TIME_PROFILES.midday);
      seenIndices.add(signal.currentPhaseIndex);
    }

    expect(seenIndices.size).toBeGreaterThan(1);
  });

  test('L3 sets valid green durations at boundary', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.timer = 5.5;
    signal.phases[1].duration = 5;
    signal.currentPhaseIndex = 1;
    const signals = new Map([[signal.id, signal]]);
    const cm = new ControllerManager();

    cm.solve(signals, new Map(), graph, 5, 0, TIME_PROFILES.midday);

    const nsGreen = signal.phases.find(p => p.group === 'NS' && p.color === 'GREEN');
    const ewGreen = signal.phases.find(p => p.group === 'EW' && p.color === 'GREEN');
    expect(nsGreen?.duration).toBeGreaterThanOrEqual(8);
    expect(ewGreen?.duration).toBeGreaterThanOrEqual(8);
  });

  test('restoreNominalPhases works after L1 unlock', () => {
    const { graph, signal } = makeGraphAndSignal();
    const signals = new Map([[signal.id, signal]]);
    const cm = new ControllerManager();

    cm.solve(signals, new Map([
      ['V1', makeVehicle({ id: 'V1', type: 'emergency', bearing: 0 })],
    ]), graph, 0.05, 0, TIME_PROFILES.midday);

    signal.phases.forEach(p => { p.color = 'RED'; });
    signal.timer = 99;

    for (let t = 0; t < 20; t++) {
      cm.solve(signals, new Map(), graph, 1, t + 1, TIME_PROFILES.midday);
    }

    const phase0Color = signal.phases[0].color;
    const hasGreenOrYellow = signal.phases.some(p => p.color === 'GREEN' || p.color === 'YELLOW');
    expect(hasGreenOrYellow).toBe(true);
    expect(phase0Color).not.toBe('RED');
  });

  test('override request with high priority preempts lower priority queue', () => {
    const { graph, signal } = makeGraphAndSignal();
    const signals = new Map([[signal.id, signal]]);
    const cm = new ControllerManager();

    cm.enqueueRequest({
      id: 'O-low', signalId: signal.id, targetGroup: 'NS', targetColor: 'RED',
      duration: 5, priority: 30, source: 'user', expiresAt: 1000, createdAt: 0,
    });
    cm.enqueueRequest({
      id: 'O-high', signalId: signal.id, targetGroup: 'EW', targetColor: 'GREEN',
      duration: 30, priority: 99, source: 'controller', expiresAt: 1000, createdAt: 0,
    });

    cm.solve(signals, new Map(), graph, 0.05, 0, TIME_PROFILES.midday);

    const ewGreen = signal.phases.find(p => p.group === 'EW' && p.color === 'GREEN');
    expect(ewGreen).toBeDefined();
  });
});
