import type { TrafficSignal, Vehicle, RoadNode, Direction, RoadGraph } from '../types';
import { SIGNAL_TIMING } from '../types';
import { haversineMeters } from '../utils/geo';

/**
 * Count vehicles approaching a signal, grouped by compass direction (N/S/E/W).
 * Uses the bearing of each vehicle to determine which direction it approaches from.
 * Detection radius: 200m from the signal node.
 */
function getDirectionalDensity(
  vehicles: Map<string, Vehicle>,
  lat: number,
  lng: number,
  signalNodeId: string,
  graph: RoadGraph,
): Record<Direction, number> {
  const counts: Record<Direction, number> = { N: 0, S: 0, E: 0, W: 0 };

  const signalEdges = graph.adjacency.get(signalNodeId) || [];
  // Build a map of edge ID → bearing for edges heading TOWARD signalNodeId
  const edgeToBearing = new Map<string, number>();

  // Collect incoming edge bearings: edges from neighbors TO signalNodeId
  for (const edge of signalEdges) {
    // reverse edge goes neighbor → signalNodeId
    const reverseId = `${edge.to}-${signalNodeId}`;
    const reverseEdge = graph.edges.get(reverseId);
    if (reverseEdge) {
      edgeToBearing.set(reverseId, reverseEdge.bearing);
    }
  }

  // Also handle edges where signalNodeId is the 'to' node
  for (const [, edge] of graph.edges) {
    if (edge.to === signalNodeId && !edgeToBearing.has(edge.id)) {
      edgeToBearing.set(edge.id, edge.bearing);
    }
  }

  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, lat, lng);
    if (dist >= 200) continue;

    // Determine approach direction
    // If vehicle is on an incoming edge, use that edge's bearing
    let bearing: number | null = null;
    if (edgeToBearing.has(v.currentEdgeId)) {
      bearing = edgeToBearing.get(v.currentEdgeId)!;
    } else {
      // Use relative position from signal node
      const dlat = v.lat - lat;
      const dlng = v.lng - lng;
      bearing = ((Math.atan2(dlng, dlat) * 180 / Math.PI) + 360) % 360;
    }

    if (bearing === null) continue;
    // Convert bearing to approach direction
    // Vehicle is heading toward the signal, so its travel direction = bearing
    // The approach direction is the OPPOSITE of the travel bearing
    const approachDir = (bearing + 180) % 360;

    if (approachDir > 315 || approachDir <= 45) counts.N++;
    else if (approachDir > 135 && approachDir <= 225) counts.S++;
    else if (approachDir > 45 && approachDir <= 135) counts.E++;
    else counts.W++;
  }

  return counts;
}

function webstersOptimalCycle(totalLostTime: number, criticalFlowRatio: number): number {
  if (criticalFlowRatio <= 0 || criticalFlowRatio >= 1) return SIGNAL_TIMING.minGreen * 2 + totalLostTime;
  return Math.max(
    SIGNAL_TIMING.minGreen * 2 + totalLostTime,
    Math.min(
      SIGNAL_TIMING.maxGreen * 2 + totalLostTime,
      ((1.5 * totalLostTime) + 5) / (1 - criticalFlowRatio),
    ),
  );
}

function computeGreenSplit(
  cycleLength: number,
  lostTime: number,
  flowRatios: Record<Direction, number>,
): Record<Direction, number> {
  const eg = cycleLength - lostTime;
  const total = Object.values(flowRatios).reduce((s, v) => s + v, 0);
  if (total === 0) return { N: eg / 4, S: eg / 4, E: eg / 4, W: eg / 4 };

  // Group NS vs EW
  const ns = flowRatios.N + flowRatios.S;
  const ew = flowRatios.E + flowRatios.W;
  const nsG = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, (ns / Math.max(total, 1)) * eg));
  const ewG = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, (ew / Math.max(total, 1)) * eg));

  // Allocate within each group proportionally
  const nG = ns > 0 ? (flowRatios.N / ns) * nsG : nsG / 2;
  const sG = ns > 0 ? (flowRatios.S / ns) * nsG : nsG / 2;
  const eG = ew > 0 ? (flowRatios.E / ew) * ewG : ewG / 2;
  const wG = ew > 0 ? (flowRatios.W / ew) * ewG : ewG / 2;

  return { N: Math.max(SIGNAL_TIMING.minGreen / 2, nG), S: Math.max(SIGNAL_TIMING.minGreen / 2, sG), E: Math.max(SIGNAL_TIMING.minGreen / 2, eG), W: Math.max(SIGNAL_TIMING.minGreen / 2, wG) };
}

export function updateAdaptiveSignals(
  signals: Map<string, TrafficSignal>,
  vehicles: Map<string, Vehicle>,
  nodes: Map<string, RoadNode>,
  graph: RoadGraph,
  deltaTime: number,
): void {
  for (const [, signal] of signals) {
    const node = nodes.get(signal.nodeId);
    if (!node) continue;

    signal.timer += deltaTime;

    // Per-approach vehicle counting
    const density = getDirectionalDensity(vehicles, node.lat, node.lng, signal.nodeId, graph);
    const total = density.N + density.S + density.E + density.W;
    signal.congestionLevel = Math.min(1, total / 30);

    // Compute flow ratios as fraction of total traffic
    const flowRatios: Record<Direction, number> = {
      N: total > 0 ? density.N / total : 0.25,
      S: total > 0 ? density.S / total : 0.25,
      E: total > 0 ? density.E / total : 0.25,
      W: total > 0 ? density.W / total : 0.25,
    };

    const totalLost = signal.phases.length * SIGNAL_TIMING.lostTimePerPhase;
    const critical = Math.max(density.N + density.S, density.E + density.W);
    const criticalRatio = total > 0 ? critical / Math.max(total, 1) : 0.5;
    const optimalCycle = webstersOptimalCycle(totalLost, criticalRatio);
    const greenSplit = computeGreenSplit(optimalCycle, totalLost, flowRatios);

    const currentPhase = signal.phases[signal.currentPhaseIndex];

    // Fixed yellow: if current phase is YELLOW, duration is fixed (not adaptive)
    if (currentPhase.color === 'YELLOW') {
      // Yellow phase — duration is fixed, no adjustment needed
      // Duration set at creation time (SIGNAL_TIMING.yellowDuration)
      // The yellow timer counts currentPhase.duration seconds, then transitions
      if (signal.timer >= currentPhase.duration) {
        signal.timer = 0;
        signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
      }
      continue;
    }

    // Adaptive green: adjust green duration based on traffic volume
    const isNS = currentPhase.group === 'NS';
    const adjustedGreen = Math.max(
      SIGNAL_TIMING.minGreen,
      Math.min(SIGNAL_TIMING.maxGreen, isNS ? greenSplit.N + greenSplit.S : greenSplit.E + greenSplit.W),
    );

    // Apply new green duration only to GREEN phases
    currentPhase.duration = adjustedGreen;

    // Transition when green + yellow time elapses
    if (signal.timer >= currentPhase.duration + currentPhase.yellowDuration) {
      signal.timer = 0;
      signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
    }
  }
}

/**
 * Multi-directional green wave coordination.
 * For each signal, computes ideal offsets from ALL upstream signals in ALL directions,
 * weighted by vehicle volume. Sets phase timings to minimize total delay.
 */
export function coordinateGreenWave(
  signals: Map<string, TrafficSignal>,
  nodes: Map<string, RoadNode>,
  graph: RoadGraph,
  vehicles: Map<string, Vehicle>,
): void {
  const signalList = Array.from(signals.values());
  if (signalList.length < 2) return;

  const avgSpeed = 12; // m/s (~43 km/h) average city speed

  // 1. Compute per-direction vehicle counts for each signal
  const signalFlow = new Map<string, Record<Direction, number>>();
  for (const sig of signals.values()) {
    const node = nodes.get(sig.nodeId);
    if (!node) { signalFlow.set(sig.nodeId, { N: 0, S: 0, E: 0, W: 0 }); continue; }
    const flow = getDirectionalDensity(vehicles, node.lat, node.lng, sig.nodeId, graph);
    signalFlow.set(sig.nodeId, flow);
  }

  // 2. For each signal, compute best offset per direction from upstream signals
  for (const sig of signalList) {
    const node = nodes.get(sig.nodeId);
    if (!node) continue;

    const flow = signalFlow.get(sig.nodeId)!;
    const totalFlow = flow.N + flow.S + flow.E + flow.W;
    if (totalFlow === 0) continue;

    // 3. Find which direction has the most traffic
    const directions: Direction[] = ['N', 'S', 'E', 'W'];
    const sortedDirs = directions.sort((a, b) => flow[b] - flow[a]);

    // Coordinate the top 2 directions (usually NS and EW)
    for (let di = 0; di < Math.min(2, sortedDirs.length); di++) {
      const dir = sortedDirs[di];
      const dirFlow = flow[dir];
      if (dirFlow < 1) continue;

      // Find upstream signals in this direction
      const upstreamSignals: Array<{ offset: number; weight: number }> = [];

      for (const otherSig of signalList) {
        if (otherSig.nodeId === sig.nodeId) continue;
        const otherNode = nodes.get(otherSig.nodeId);
        if (!otherNode) continue;

        // Check if otherSig is upstream of sig in direction `dir`
        let isUpstream = false;
        if (dir === 'N' && otherNode.lat > node.lat) isUpstream = true;
        else if (dir === 'S' && otherNode.lat < node.lat) isUpstream = true;
        else if (dir === 'E' && otherNode.lng > node.lng) isUpstream = true;
        else if (dir === 'W' && otherNode.lng < node.lng) isUpstream = true;

        if (!isUpstream) continue;

        // Limit distance to 2km
        const dist = haversineMeters(otherNode.lat, otherNode.lng, node.lat, node.lng);
        if (dist > 2000) continue;

        // Travel time from upstream signal to this signal
        const travelTime = dist / avgSpeed;

        // Weight by flow at the upstream signal in the same direction
        const otherFlow = signalFlow.get(otherSig.nodeId);
        const upstreamWeight = otherFlow ? otherFlow[dir] : 0;
        if (upstreamWeight === 0) continue;

        // The upstream signal's current offset + travel time = when vehicles depart upstream and arrive here
        const arrivalTime = (otherSig.offset + travelTime) % sig.cycleLength;

        upstreamSignals.push({ offset: arrivalTime, weight: upstreamWeight });
      }

      if (upstreamSignals.length === 0) continue;

      // 4. Weighted average of arrival times to find best green start
      let weightedSum = 0;
      let totalWeight = 0;
      for (const us of upstreamSignals) {
        weightedSum += us.offset * us.weight;
        totalWeight += us.weight;
      }
      const bestOffset = totalWeight > 0 ? (weightedSum / totalWeight) % sig.cycleLength : sig.offset;

      // 5. Check if current cycle length allows this offset
      // The offset should be within [0, cycleLength)
      sig.offset = Math.max(0, Math.min(sig.cycleLength - 1, bestOffset));

      // 6. Mark this signal as green-wave-coordinated in the flow direction
      sig.greenWaveDirection = dir;
    }

  }
}
