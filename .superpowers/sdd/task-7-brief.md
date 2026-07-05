### Task 7: Trim TrafficEngine — Strip Heavy Computation

**Files:**
- Modify: `src/engine/TrafficEngine.ts`
- Modify: `src/App.tsx` — add server polling

**Step 1: Edit `src/engine/TrafficEngine.ts`**

Make these EXACT changes:

**a) Line 2 — remove SLAStats and CorridorInfo from type import:**
```typescript
// Before:
import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats, Direction, SignalColor, VehicleType, SLAStats, CorridorInfo } from '../types';
// After:
import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats, Direction, SignalColor, VehicleType } from '../types';
```

**b) Remove lines 6-7 (slaMonitor, corridorDetector imports):**
```typescript
// Remove:
import { computeSLAStats } from './slaMonitor';
import { detectCorridors } from './corridorDetector';
```

**c) Remove line 11 (congestion import):**
```typescript
// Remove:
import { detectCongestionZones, computeStats } from './congestion';
```

**d) Line 12 — remove SIGNAL_CONFIG from import:**
```typescript
// Before:
import { SIMULATION_CONFIG, SIGNAL_CONFIG } from '../config';
// After:
import { SIMULATION_CONFIG } from '../config';
```

**e) Lines 51-56 — remove private properties (slaStats, corridors, corridorTimer):**
```typescript
// Remove these lines:
  private slaStats: SLAStats = {
    fleetAvgSpeedKmh: 0, slaCompliant: false, vehicleCount: 0,
    emergencyAvgSpeedKmh: 0, emergencyCompliant: false,
  };
  private corridors: CorridorInfo[] = [];
  private corridorTimer = 0;
```

**f) In `update(dt)` method — remove lines 114-131, replace with single comment:**

Replace this entire block (lines 114-131):
```typescript
    this.slaStats = computeSLAStats(this.vehicles);
    this.stats.slaSpeed = this.slaStats.fleetAvgSpeedKmh;
    this.stats.slaCompliant = this.slaStats.slaCompliant;
    this.stats.emergencySlaSpeed = this.slaStats.emergencyAvgSpeedKmh;

    this.corridorTimer += dt;
    if (this.corridorTimer >= SIGNAL_CONFIG.CORRIDOR.DETECT_INTERVAL) {
      this.corridorTimer = 0;
      this.corridors = detectCorridors(this.vehicles, this.graph, this.signals);
    }
    this.stats.activeCorridors = this.corridors.length;

    this.congestionZones = detectCongestionZones(this.vehicles, this.graph.nodes);
    this.stats = computeStats(this.vehicles, this.congestionZones);
    this.stats.slaSpeed = this.slaStats.fleetAvgSpeedKmh;
    this.stats.slaCompliant = this.slaStats.slaCompliant;
    this.stats.emergencySlaSpeed = this.slaStats.emergencyAvgSpeedKmh;
    this.stats.activeCorridors = this.corridors.length;
```

With just:
```typescript
    // Heavy computation removed — client only simulates vehicle movement
    // Congestion, SLA, corridors computed server-side via serverSync
```

Keep lines 133-136 (greenWaveActive, signalCoordinationScore stats) — those stay.

**Step 2: Edit `src/App.tsx`**

**a) Add import after line 15 (the RouteInfo import line):**
```typescript
import { fetchCongestion } from './engine/serverSync';
```

**b) Add server polling useEffect BEFORE the handlers section (before `// ── Handlers` line). Insert after line 178 (closing of keyboard shortcut useEffect):**

```typescript
  // ── Server polling ────────────────────────────────────────────────────
  useEffect(() => {
    const ival = setInterval(async () => {
      const e = engineRef.current;
      if (!e || !e.loaded) return;
      try {
        const { zones, stats } = await fetchCongestion(e.vehicles, e.graph.nodes);
        e.congestionZones = zones;
        e.stats = { ...e.stats, ...stats };
      } catch { /* server offline — use local defaults */ }
    }, 5000);
    return () => clearInterval(ival);
  }, []);
```

**Step 3: Verify build**

```bash
npm run build
```
Expected: tsc + vite build succeed.

**Step 4: Commit**

```bash
git add src/engine/TrafficEngine.ts src/App.tsx
git commit -m "refactor(client): strip heavy computation, add server polling"
```
