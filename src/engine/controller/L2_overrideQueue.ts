import type { TrafficSignal } from '../../types';
import type { OverrideRequest } from './types';

export function applyL2(
  signals: Map<string, TrafficSignal>,
  queue: OverrideRequest[],
  simTime: number,
): OverrideRequest[] {
  const active: OverrideRequest[] = [];

  for (const req of queue) {
    if (simTime >= req.expiresAt) continue;
    active.push(req);
  }

  active.sort((a, b) => b.priority - a.priority);

  const processedSignals = new Set<string>();
  const processed: OverrideRequest[] = [];

  for (const req of active) {
    if (processedSignals.has(req.signalId)) continue;
    const sig = signals.get(req.signalId);
    if (!sig) continue;

    for (const phase of sig.phases) {
      if (phase.group === req.targetGroup) {
        phase.color = req.targetColor;
        phase.duration = req.duration;
      } else {
        phase.color = req.targetColor === 'GREEN' ? 'RED' : 'GREEN';
        phase.duration = req.targetColor === 'GREEN' ? Math.max(2, req.duration * 0.3) : req.duration;
      }
    }

    processedSignals.add(req.signalId);
    processed.push(req);
  }

  return processed;
}
