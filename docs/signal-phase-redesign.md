# Signal Phase Redesign — Collision Avoidance

## Problem

The original signal phase system had three issues that prevented proper collision avoidance:

1. **No visible yellow phase**: `updateAdaptiveSignals` used `yellowDuration` as a wait timer before transitioning phases, but never actually set the `color` to `'YELLOW'`. The color stayed GREEN for the entire `duration + yellowDuration` period, then abruptly switched.

2. **Phase direction semantics**: `SignalPhase.direction` was typed as `Direction` (`'N' | 'S' | 'E' | 'W'`) but phases actually represent intersection-level states. All 4 directions existed in a single phase array with overlapping colors, making it unclear which vehicles should stop.

3. **Yellow too short**: `SIGNAL_TIMING.yellowDuration` was 3s instead of the mandated 5s.

## Solution

### Phase Structure (4-phase cycle)

Each signal now has exactly 4 phases, cycling through all intersection states:

| Index | Group | Color | Duration | Yellow | Description |
|-------|-------|-------|----------|--------|-------------|
| 0 | NS | GREEN | Adaptive (8-45s) | 5s (fixed) | North-South traffic flows |
| 1 | NS | YELLOW | 5s (fixed) | 0s | NS clearing — vehicles past stop line clear intersection |
| 2 | EW | GREEN | Adaptive (8-45s) | 5s (fixed) | East-West traffic flows |
| 3 | EW | YELLOW | 5s (fixed) | 0s | EW clearing |

### Type Changes

- `SignalPhase.direction: Direction` → `SignalPhase.group: 'NS' | 'EW'`
- `SIGNAL_TIMING.yellowDuration: 3` → `SIGNAL_TIMING.yellowDuration: 5`

### Vehicle Signal Check

Each vehicle determines its travel axis from its `bearing` field:
- Bearing 315°–45° or 135°–225° → `'NS'` (moving north/south)
- Bearing 45°–135° or 225°–315° → `'EW'` (moving east/west)

`checkCanProceed` logic:
| Phase | Vehicle matches group | Vehicle past stop line | Result |
|-------|----------------------|----------------------|--------|
| GREEN | Yes | — | Proceed |
| GREEN | No | ≤0.85 | STOP |
| YELLOW | Yes | ≤0.85 | STOP (must clear on next phase) |
| YELLOW | Yes | >0.85 | Proceed (already in intersection) |
| RED | — | ≤0.85 | STOP |
| RED | — | >0.85 | Proceed (clearing) |

### Adaptive Timing

The GREEN phase durations (indices 0 and 2) are adjusted every cycle based on per-approach vehicle counts using Webster's formula. YELLOW phases (indices 1 and 3) are **always 5s** — the adaptive timing explicitly skips them.

### Affected Files

- `src/types/index.ts` — `SignalPhase.group`, `SIGNAL_TIMING.yellowDuration: 5`
- `src/data/roadNetwork.ts` — `createPhase()` produces 4-phase cycle
- `src/engine/signalControl.ts` — `updateAdaptiveSignals()` skips YELLOW phases, adjusts GREEN only
- `src/engine/vehicleSim.ts` — `checkCanProceed()` uses `bearingToGroup()` for axis matching
- `src/engine/TrafficEngine.ts` — `manualOverrideSignal()` uses `phase.group`
- `src/engine/emergencyPriority.ts` — uses `phase.group`
- `src/engine/optimizer.ts` — uses `phase.group`
- `src/components/MapView.tsx` — signal popup shows `phase.group`
- `src/App.tsx` — `toGroup()` converter for backwards-compatible override calls
