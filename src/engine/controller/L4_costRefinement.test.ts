import { describe, test, expect } from 'vitest';
import { applyL4 } from './L4_costRefinement';
import { makeSignal, makeVehicle, makeGraphAndSignal } from './__fixtures__';
import { SIGNAL_TIMING } from '../../types';
import { TIME_PROFILES } from '../timeOfDay';
import type { SolverContext } from './types';

function buildCtx(graph: ReturnType<typeof makeGraphAndSignal>['graph'], signals: Map<string, ReturnType<typeof makeSignal>>, vehicles: Map<string, ReturnType<typeof makeVehicle>>): SolverContext {
  return {
    signals: signals as unknown as SolverContext['signals'],
    vehicles: vehicles as unknown as SolverContext['vehicles'],
    graph,
    dt: 0.05,
    simTime: 0,
    timeOfDayProfile: TIME_PROFILES.midday,
    emergencyOverrides: new Map(),
    overrideQueue: [],
  };
}

const weights = {
  delay: 1.0, throughput: 0.5, queue: 0.8, fairness: 0.3,
};

describe('L4 — Cost Refinement', () => {
  test('skips signals without opposite GREEN phase', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.phases = signal.phases.filter(p => p.group !== 'EW');
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    expect(() => applyL4(ctx, { refinementDelta: 2, weights }, new Set())).not.toThrow();
  });

  test('skips locked signals', () => {
    const { graph, signal } = makeGraphAndSignal();
    const originalDur = signal.phases[0].duration;
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    applyL4(ctx, { refinementDelta: 2, weights }, new Set([signal.id]));

    expect(signal.phases[0].duration).toBe(originalDur);
  });

  test('skips YELLOW phases and only perturbs GREEN', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.currentPhaseIndex = 1;
    const yellowDur = signal.phases[1].duration;
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    applyL4(ctx, { refinementDelta: 2, weights }, new Set());

    expect(signal.phases[1].duration).toBe(yellowDur);
  });

  test('clamped to [minGreen, maxGreen]', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.phases[0].duration = 8;
    signal.phases[2].duration = 45;
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    applyL4(ctx, { refinementDelta: 5, weights }, new Set());

    const nsGreen = signal.phases.find(p => p.group === 'NS' && p.color === 'GREEN')!;
    const ewGreen = signal.phases.find(p => p.group === 'EW' && p.color === 'GREEN')!;
    expect(nsGreen.duration).toBeGreaterThanOrEqual(SIGNAL_TIMING.minGreen);
    expect(nsGreen.duration).toBeLessThanOrEqual(SIGNAL_TIMING.maxGreen);
    expect(ewGreen.duration).toBeGreaterThanOrEqual(SIGNAL_TIMING.minGreen);
    expect(ewGreen.duration).toBeLessThanOrEqual(SIGNAL_TIMING.maxGreen);
  });

  test('opposite green phase receives balanced adjustment', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.phases[0].duration = 15;
    signal.phases[2].duration = 15;
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    const beforeNs = signal.phases[0].duration;
    const beforeEw = signal.phases[2].duration;

    applyL4(ctx, { refinementDelta: 2, weights }, new Set());

    const afterNs = signal.phases[0].duration;
    const afterEw = signal.phases[2].duration;
    const nsDelta = afterNs - beforeNs;
    const ewDelta = afterEw - beforeEw;

    if (nsDelta !== 0 || ewDelta !== 0) {
      expect(Math.abs(nsDelta)).toBeLessThanOrEqual(2);
      expect(Math.abs(ewDelta)).toBeLessThanOrEqual(2);
      expect(nsDelta + ewDelta).toBeCloseTo(0, 5);
    }
  });

  test('does not crash with empty vehicle map', () => {
    const { graph, signal } = makeGraphAndSignal();
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    expect(() => applyL4(ctx, { refinementDelta: 2, weights }, new Set())).not.toThrow();
  });
});
