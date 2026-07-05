import { describe, test, expect } from 'vitest';
import { applyL2 } from './L2_overrideQueue';
import { makeSignal } from './__fixtures__';
import type { OverrideRequest } from './types';

function makeReq(signalId: string, priority: number, overrides: Partial<OverrideRequest> = {}): OverrideRequest {
  return {
    id: `O-${Math.random()}`,
    signalId,
    targetGroup: 'NS',
    targetColor: 'GREEN',
    duration: 30,
    priority,
    source: 'user',
    expiresAt: 1000,
    createdAt: 0,
    ...overrides,
  };
}

describe('L2 — Override Queue', () => {
  test('expired requests are filtered out', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const queue = [
      makeReq(signal.id, 80, { expiresAt: 100 }),
      makeReq(signal.id, 90, { expiresAt: 2000 }),
    ];

    const processed = applyL2(signals, queue, 500);

    expect(processed).toHaveLength(1);
    expect(processed[0].id).toBe(queue[1].id);
  });

  test('highest priority request wins per signal', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const queue = [
      makeReq(signal.id, 30, { targetGroup: 'NS', targetColor: 'GREEN' }),
      makeReq(signal.id, 99, { targetGroup: 'EW', targetColor: 'GREEN' }),
      makeReq(signal.id, 50, { targetGroup: 'NS', targetColor: 'RED' }),
    ];

    applyL2(signals, queue, 0);

    const ewGreen = signal.phases.find(p => p.group === 'EW' && p.color === 'GREEN');
    expect(ewGreen).toBeDefined();
  });

  test('GREEN target on NS sets NS-GREEN and cross-RED with short cross duration', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const queue = [
      makeReq(signal.id, 80, {
        targetGroup: 'NS',
        targetColor: 'GREEN',
        duration: 30,
      }),
    ];

    applyL2(signals, queue, 0);

    const nsPhases = signal.phases.filter(p => p.group === 'NS');
    const ewPhases = signal.phases.filter(p => p.group === 'EW');
    expect(nsPhases.every(p => p.color === 'GREEN')).toBe(true);
    expect(ewPhases.every(p => p.color === 'RED')).toBe(true);
    expect(ewPhases[0].duration).toBeLessThan(30);
  });

  test('RED target on NS sets NS-RED and cross-GREEN with duration', () => {
    const signal = makeSignal();
    const signals = new Map([[signal.id, signal]]);
    const queue = [
      makeReq(signal.id, 80, {
        targetGroup: 'NS',
        targetColor: 'RED',
        duration: 5,
      }),
    ];

    applyL2(signals, queue, 0);

    expect(signal.phases.filter(p => p.group === 'NS').every(p => p.color === 'RED')).toBe(true);
    expect(signal.phases.filter(p => p.group === 'EW').every(p => p.color === 'GREEN')).toBe(true);
    expect(signal.phases.find(p => p.group === 'EW' && p.color === 'GREEN')?.duration).toBe(5);
  });

  test('skip when target signal does not exist', () => {
    const signals = new Map<string, ReturnType<typeof makeSignal>>();
    const queue = [
      makeReq('NON-EXISTENT', 80),
    ];

    expect(() => applyL2(signals, queue, 0)).not.toThrow();
  });

  test('return value lists all active (non-expired) processed requests across signals', () => {
    const s1 = makeSignal({ id: 'S1' });
    const s2 = makeSignal({ id: 'S2' });
    const signals = new Map([[s1.id, s1], [s2.id, s2]]);
    const queue = [
      makeReq(s1.id, 80, { expiresAt: 100 }),
      makeReq(s1.id, 90, { expiresAt: 2000 }),
      makeReq(s2.id, 50, { expiresAt: 1500 }),
    ];

    const processed = applyL2(signals, queue, 200);
    expect(processed).toHaveLength(2);
    const signalIds = processed.map(p => p.signalId).sort();
    expect(signalIds).toEqual(['S1', 'S2']);
  });
});
