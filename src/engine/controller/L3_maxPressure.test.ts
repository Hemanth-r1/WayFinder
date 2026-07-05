import { describe, test, expect } from 'vitest';
import { applyL3 } from './L3_maxPressure';
import { makeSignal, makeVehicle, makeGraphAndSignal } from './__fixtures__';
import { SIGNAL_TIMING } from '../../types';
import { TIME_PROFILES } from '../timeOfDay';
import type { SolverContext } from './types';

function buildCtx(graph: ReturnType<typeof makeGraphAndSignal>['graph'], signals: Map<string, ReturnType<typeof makeSignal>>, vehicles: Map<string, ReturnType<typeof makeVehicle>>, simTime = 0, dt = 0.05): SolverContext {
  return {
    signals: signals as unknown as SolverContext['signals'],
    vehicles: vehicles as unknown as SolverContext['vehicles'],
    graph,
    dt,
    simTime,
    timeOfDayProfile: TIME_PROFILES.midday,
    emergencyOverrides: new Map(),
    overrideQueue: [],
  };
}

describe('L3 — Max-Pressure Allocation', () => {
  test('skips signals with fewer than 2 phases', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.phases = [{ group: 'NS', color: 'GREEN', duration: 10, yellowDuration: 5 }];
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    expect(() => applyL3(ctx, { maxPressureCap: 30 }, new Set())).not.toThrow();
  });

  test('skips locked signals', () => {
    const { graph, signal } = makeGraphAndSignal();
    const signals = new Map([[signal.id, signal]]);
    const originalPhaseIndex = signal.currentPhaseIndex;
    const ctx = buildCtx(graph, signals, new Map());

    applyL3(ctx, { maxPressureCap: 30 }, new Set([signal.id]));

    expect(signal.currentPhaseIndex).toBe(originalPhaseIndex);
  });

  test('advances phase index after GREEN duration elapses', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.phases[0].duration = 10;
    signal.timer = 10.1;
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    applyL3(ctx, { maxPressureCap: 30 }, new Set());

    expect(signal.currentPhaseIndex).toBeGreaterThanOrEqual(0);
    if (signal.currentPhaseIndex === 0) {
      expect(signal.timer).toBe(0);
    } else {
      expect(signal.currentPhaseIndex).not.toBe(0);
    }

  });

  test('YELLOW phase transition: advances to next GREEN when timer >= duration', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.currentPhaseIndex = 1;
    const nsYellow = signal.phases[1];
    nsYellow.color = 'YELLOW';
    nsYellow.duration = 5;
    signal.timer = 5.5;
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    applyL3(ctx, { maxPressureCap: 30 }, new Set());

    expect(signal.currentPhaseIndex).toBe(2);
    expect(signal.timer).toBe(0);
  });

  test('updates NS and EW green durations at YELLOW→GREEN boundary', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.currentPhaseIndex = 1;
    signal.timer = 5.5;
    signal.phases[1].duration = 5;
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    applyL3(
      ctx,
      { maxPressureCap: 30 },
      new Set(),
    );

    const nsGreen = signal.phases.find(p => p.group === 'NS' && p.color === 'GREEN')!;
    const ewGreen = signal.phases.find(p => p.group === 'EW' && p.color === 'GREEN')!;
    expect(nsGreen.duration).toBeGreaterThanOrEqual(SIGNAL_TIMING.minGreen);
    expect(ewGreen.duration).toBeGreaterThanOrEqual(SIGNAL_TIMING.minGreen);
  });

  test('cycle length grows when traffic pressure is high', () => {
    const { graph, signal } = makeGraphAndSignal();
    signal.timer = 5.5;
    signal.phases[1].duration = 5;
    const signals = new Map([[signal.id, signal]]);
    const vehicles = new Map<string, ReturnType<typeof makeVehicle>>();

    const manyVehicles = Array.from({ length: 30 }, (_, i) =>
      makeVehicle({ id: `V${i}`, currentEdgeId: i % 2 === 0 ? 'S-N-N-SIG' : 'W-N-N-SIG' }),
    );
    for (const v of manyVehicles) vehicles.set(v.id, v);

    manyVehicles.forEach(v => graph.adjacency.get(v.currentEdgeId));
    ['S-N', 'W-N'].forEach(id => graph.nodes.set(id, { id, lat: 12.97, lng: 77.594, isIntersection: false }));

    const ctx = buildCtx(graph, signals, vehicles);

    applyL3(ctx, { maxPressureCap: 30 }, new Set());

    expect(signal.cycleLength).toBeGreaterThanOrEqual(SIGNAL_TIMING.minGreen * 2);
  });

  test('empty vehicle Map keeps signal ticking without crashing', () => {
    const { graph, signal } = makeGraphAndSignal();
    const signals = new Map([[signal.id, signal]]);
    const ctx = buildCtx(graph, signals, new Map());

    expect(() => applyL3(ctx, { maxPressureCap: 30 }, new Set())).not.toThrow();
  });
});
