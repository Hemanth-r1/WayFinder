/**
 * optimizer.ts — Network-level congestion optimizer (REQ-C1 through REQ-C8)
 *
 * Uses simulated annealing over the space of {greenNS, greenEW, offset} per signal.
 * Objective: minimize total estimated vehicle delay across all congestion hotspots.
 * Budget: ≤200ms wall-clock OR 500 iterations, whichever comes first.
 *
 * Auto-applies plan if improvement > 10% and no manual override is active.
 */
import type { TrafficSignal, Vehicle, RoadNode, SignalPlanEntry, OptimizationResult } from '../types';
import { SIGNAL_TIMING } from '../types';

// ── Delay estimation ──────────────────────────────────────────────────────────

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/**
 * Estimate total vehicle-seconds of delay under a given signal plan.
 * For each vehicle waiting at a red signal, estimate their remaining wait.
 * For congested edges, add queue delay.
 */
function estimateDelay(
  plan: Map<string, SignalPlanEntry>,
  vehicles: Map<string, Vehicle>,
  signals: Map<string, TrafficSignal>,
  nodes: Map<string, RoadNode>,
): number {
  let totalDelay = 0;

  for (const [, v] of vehicles) {
    if (!v.waitingForSignal && v.stuckTime < 2) continue;
    const sig = signals.get(v.targetNodeId);
    if (!sig) continue;

    const entry = plan.get(sig.id);
    if (!entry) {
      // No plan for this signal — use Webster's default wait estimate
      totalDelay += sig.cycleLength * 0.4;
      continue;
    }

    // Current phase determines wait
    const phase = sig.phases[sig.currentPhaseIndex];
    const isNS = phase.direction === 'N' || phase.direction === 'S';
    const greenTime = isNS ? entry.greenNS : entry.greenEW;
    const redTime = entry.cycleLength - greenTime - 3; // subtract yellow

    if (phase.color === 'RED') {
      const remaining = Math.max(0, redTime - sig.timer);
      totalDelay += remaining;
    } else if (phase.color === 'GREEN') {
      // No delay — might pass
    }
  }

  // Add hotspot queue delays using node density
  for (const [, sig] of signals) {
    const entry = plan.get(sig.id);
    if (!entry) continue;
    const node = nodes.get(sig.nodeId);
    if (!node) continue;

    let queueCount = 0;
    for (const [, v] of vehicles) {
      if (haversineMeters(v.lat, v.lng, node.lat, node.lng) < 100) queueCount++;
    }

    if (queueCount > 3) {
      // Webster's delay formula: d = C*(1-g/C)^2 / (2*(1-q/c))
      const C = entry.cycleLength;
      const g = (entry.greenNS + entry.greenEW) / 2;
      const q = Math.min(0.9, queueCount / 20); // flow ratio estimate
      const websterDelay = C * Math.pow(1 - g / C, 2) / (2 * (1 - q));
      totalDelay += websterDelay * queueCount;
    }
  }

  return totalDelay;
}

// ── Plan mutation ─────────────────────────────────────────────────────────────

function mutatePlan(plan: Map<string, SignalPlanEntry>): Map<string, SignalPlanEntry> {
  const keys = Array.from(plan.keys());
  const sigId = keys[Math.floor(Math.random() * keys.length)];
  const entry = { ...plan.get(sigId)! };

  const mutation = Math.random();
  if (mutation < 0.33) {
    // Mutate greenNS ±2s
    entry.greenNS = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, entry.greenNS + (Math.random() > 0.5 ? 2 : -2)));
  } else if (mutation < 0.66) {
    // Mutate greenEW ±2s
    entry.greenEW = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, entry.greenEW + (Math.random() > 0.5 ? 2 : -2)));
  } else {
    // Mutate offset ±1s
    entry.offset = Math.max(0, Math.min(entry.cycleLength - 1, entry.offset + (Math.random() > 0.5 ? 1 : -1)));
  }
  entry.cycleLength = entry.greenNS + entry.greenEW + 6; // 3s yellow per phase

  const newPlan = new Map(plan);
  newPlan.set(sigId, entry);
  return newPlan;
}

/** Green wave coordination constraint: align offsets along corridors */
function applyGreenWaveConstraint(
  plan: Map<string, SignalPlanEntry>,
  signals: Map<string, TrafficSignal>,
  nodes: Map<string, RoadNode>,
): Map<string, SignalPlanEntry> {
  const avgSpeed = 12; // m/s
  const sorted = Array.from(signals.values()).sort((a, b) => {
    const na = nodes.get(a.nodeId); const nb = nodes.get(b.nodeId);
    if (!na || !nb) return 0;
    return na.lng - nb.lng; // East-West corridor
  });

  const updated = new Map(plan);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]; const curr = sorted[i];
    const pn = nodes.get(prev.nodeId); const cn = nodes.get(curr.nodeId);
    if (!pn || !cn) continue;
    const dist = haversineMeters(pn.lat, pn.lng, cn.lat, cn.lng);
    const travelTime = dist / avgSpeed;
    const prevEntry = updated.get(prev.id);
    const currEntry = updated.get(curr.id);
    if (!prevEntry || !currEntry) continue;
    // Align offset along corridor
    const idealOffset = (prevEntry.offset + travelTime) % currEntry.cycleLength;
    updated.set(curr.id, { ...currEntry, offset: Math.round(idealOffset) });
  }
  return updated;
}

// ── Simulated annealing ───────────────────────────────────────────────────────

function buildInitialPlan(signals: Map<string, TrafficSignal>): Map<string, SignalPlanEntry> {
  const plan = new Map<string, SignalPlanEntry>();
  for (const [, sig] of signals) {
    const greenNS = Math.max(SIGNAL_TIMING.minGreen, sig.phases.find(p => p.direction === 'N')?.duration ?? 15);
    const greenEW = Math.max(SIGNAL_TIMING.minGreen, sig.phases.find(p => p.direction === 'E')?.duration ?? 12);
    plan.set(sig.id, {
      signalId: sig.id,
      greenNS,
      greenEW,
      offset: sig.offset,
      cycleLength: greenNS + greenEW + 6,
    });
  }
  return plan;
}

export function runOptimizer(
  signals: Map<string, TrafficSignal>,
  vehicles: Map<string, Vehicle>,
  nodes: Map<string, RoadNode>,
  budgetMs = 150,
): OptimizationResult {
  if (signals.size === 0) {
    return { plan: [], estimatedDelay: 0, baselineDelay: 0, improvement: 0, iterationsRun: 0, elapsedMs: 0 };
  }

  const startTime = performance.now();
  let current = buildInitialPlan(signals);
  const baseline = estimateDelay(current, vehicles, signals, nodes);
  let currentEnergy = baseline;
  let best = current;
  let bestEnergy = currentEnergy;

  // Simulated annealing parameters
  let T = 50.0;       // initial temperature
  const cooling = 0.95;
  const maxIter = 500;
  let iter = 0;

  while (iter < maxIter && (performance.now() - startTime) < budgetMs) {
    const candidate = mutatePlan(current);
    const energy = estimateDelay(candidate, vehicles, signals, nodes);
    const dE = energy - currentEnergy;

    if (dE < 0 || Math.random() < Math.exp(-dE / T)) {
      current = candidate;
      currentEnergy = energy;
      if (energy < bestEnergy) { best = candidate; bestEnergy = energy; }
    }

    T *= cooling;
    iter++;
  }

  // Apply green wave coordination (REQ-C8)
  best = applyGreenWaveConstraint(best, signals, nodes);

  const elapsed = performance.now() - startTime;
  const improvement = baseline > 0 ? (baseline - bestEnergy) / baseline : 0;

  return {
    plan: Array.from(best.values()),
    estimatedDelay: bestEnergy,
    baselineDelay: baseline,
    improvement,
    iterationsRun: iter,
    elapsedMs: Math.round(elapsed),
  };
}

/** Apply an optimization result to live signals */
export function applyOptimizationPlan(
  plan: SignalPlanEntry[],
  signals: Map<string, TrafficSignal>,
): void {
  for (const entry of plan) {
    // Find signal by ID
    for (const [, sig] of signals) {
      if (sig.id !== entry.signalId) continue;
      sig.cycleLength = entry.cycleLength;
      sig.offset = entry.offset;
      // Update phase durations
      for (const phase of sig.phases) {
        const isNS = phase.direction === 'N' || phase.direction === 'S';
        if (phase.color === 'GREEN' || phase.color === 'RED') {
          phase.duration = Math.max(SIGNAL_TIMING.minGreen, isNS ? entry.greenNS : entry.greenEW);
        }
      }
      break;
    }
  }
}
