# Task 2: Fix TrafficEngine bugs

**Files:**
- Modify: `src/engine/TrafficEngine.ts`

## Requirements

1. **Fix `spawnVehicleFromDirection`** — currently ignores the `_direction` param (has underscore prefix). Replace the body to pick a start edge matching the bearing of the given direction:

   ```typescript
   spawnVehicleFromDirection(direction: Direction, type?: VehicleType): void {
     const edgeNodes = Array.from(this.graph.nodes.entries()).filter(([id, _node]) => {
       const adj = this.graph.adjacency.get(id) || [];
       return adj.some(e => {
         const bearing = e.bearing;
         if (direction === 'N') return bearing > 315 || bearing <= 45;
         if (direction === 'S') return bearing > 135 && bearing <= 225;
         if (direction === 'E') return bearing > 45 && bearing <= 135;
         if (direction === 'W') return bearing > 225 && bearing <= 315;
         return false;
       });
     });
     if (edgeNodes.length === 0) return;
     const startId = edgeNodes[Math.floor(Math.random() * edgeNodes.length)][0];
     const vType = type || (['sedan', 'sedan', 'suv', 'hatchback', 'bike', 'auto'] as VehicleType[])[Math.floor(Math.random() * 6)];
     const v = spawnVehicleAt(this.graph, startId, vType);
     if (v) this.vehicles.set(v.id, v);
   }
   ```

   Remove the underscore from the first param name: `_direction` → `direction`.

2. **Fix manual override scope** — currently disables `adaptiveTiming` on ALL signals. Should only disable it on the target signal. Replace the method body:

   ```typescript
   manualOverrideSignal(signalId: string, direction: Direction, color: SignalColor): void {
     const signal = this.signals.get(signalId);
     if (!signal) return;
     this.manualOverrideActive = true;
     this.manualOverrideTimer = 0;
     signal.adaptiveTiming = false;

     for (const phase of signal.phases) {
       if (phase.direction === direction) {
         phase.color = color;
         phase.duration = color === 'GREEN' ? 30 : 5;
       } else {
         phase.color = color === 'GREEN' ? 'RED' : 'GREEN';
         phase.duration = color === 'GREEN' ? 5 : 25;
       }
     }
   }
   ```

3. Run `npm run build` and `npm run lint` — both must pass.

## Global Constraints
- `verbatimModuleSyntax: true`
- `erasableSyntaxOnly: true`
- `noUnusedLocals` / `noUnusedParameters` are errors
