# Task 6: App.tsx overhaul — speed control, keyboard shortcuts, toasts, RAF optimization

**Files:**
- Modify: `src/App.tsx`

## Requirements

### 1. Speed multiplier
Add state and logic to multiply the deltaTime passed to engine.update.

Add:
```typescript
const [speed, setSpeed] = useState(1);
const speedRef = useRef(1);
```
```typescript
useEffect(() => { speedRef.current = speed; }, [speed]);
```

In the RAF loop, change:
```typescript
const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0;
```
to:
```typescript
const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 * speedRef.current : 0;
```

### 2. Proper RAF pause (cancelAnimationFrame)
Currently the RAF loop runs forever even when paused, just skipping engine.update. Instead, cancel when paused and restart on resume.

Add a pause effect:
```typescript
const [paused, setPaused] = useState(false);
const [simRunning, setSimRunning] = useState(false);

// Track whether loop should be active
const loopActiveRef = useRef(false);
```

After engine.start() in the init effect:
```typescript
setSimRunning(true);
loopActiveRef.current = true;
```

Replace the end of the init effect (the `frameRef.current = requestAnimationFrame(loop)`) with:
```typescript
function startLoop() {
  if (!loopActiveRef.current) return;
  lastTimeRef.current = 0;
  frameRef.current = requestAnimationFrame(loop);
}
startLoop();
```

Add a pause/resume effect:
```typescript
useEffect(() => {
  if (paused) {
    cancelAnimationFrame(frameRef.current);
  } else if (simRunning) {
    lastTimeRef.current = 0;
    frameRef.current = requestAnimationFrame(loop);
  }
  return () => {};
}, [paused, simRunning]);
```

Make sure `loop` function is defined above these effects (move it outside the init effect or use a ref).

### 3. Add keyboard shortcuts for S, H, 1-4

Add to the existing keyboard handler switch:
```typescript
case 's': case 'S':
  engineRef.current?.spawnVehicleFromDirection(
    (['N', 'S', 'E', 'W'] as Direction[])[Math.floor(Math.random() * 4)]
  );
  break;
case 'h': case 'H':
  setShowHeatmap(p => !p);
  break;
case '1': setSpeed(0.5); break;
case '2': setSpeed(1); break;
case '3': setSpeed(2); break;
case '4': setSpeed(4); break;
```

Add state: `const [showHeatmap, setShowHeatmap] = useState(true);`

Update footer keyboard legend:
```jsx
<kbd>Space</kbd> pause ·{' '}
<kbd>S</kbd> spawn ·{' '}
<kbd>E</kbd> emergency ·{' '}
<kbd>H</kbd> heatmap ·{' '}
<kbd>1-4</kbd> speed ·{' '}
<kbd>Esc</kbd> cancel
```

### 4. Wire ToastContainer

Import: `import ToastContainer from './components/Toast';`

Add `<ToastContainer />` inside the root div (before the closing `</div>` of the outermost wrapper).

### 5. Pass showHeatmap and speed to MapView

Add to MapView props:
```typescript
showHeatmap={showHeatmap}
speed={speed}
```

Also add `onSpeedChange` prop:
```typescript
onSpeedChange={setSpeed}
```

Run `npm run build` and `npm run lint` — both must pass. Commit.
