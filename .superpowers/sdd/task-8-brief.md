# Task 8: Speed control UI + heatmap toggle button

**Files:**
- Modify: `src/App.tsx`

## Requirements

### 1. Speed control in sidebar footer
In `src/App.tsx`, above the keyboard legend in the sidebar footer, add a speed control row:

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
  <span style={{ fontSize: 10, color: '#888', minWidth: 40 }}>Speed</span>
  <input
    type="range" min="0.5" max="4" step="0.5"
    value={speed}
    onChange={(e) => setSpeed(parseFloat(e.target.value))}
    style={{ flex: 1, accentColor: '#FF6D00', height: 4 }}
  />
  <span style={{ color: '#fff', fontWeight: 'bold', fontSize: 12, minWidth: 28, textAlign: 'right' }}>
    {speed}×
  </span>
</div>
```

### 2. Heatmap toggle button next to pause button
In the footer, next to the pause button, add a heatmap toggle:

Currently the pause button is `width: '100%'` — change it and add a row of two buttons:

Replace:
```tsx
<button onClick={handleTogglePause} style={{ width: '100%', ... }}>
  {paused ? '▶ Resume' : '⏸ Pause'}
</button>
```

With:
```tsx
<div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
  <button onClick={handleTogglePause} style={{ flex: 1, padding: '9px', background: paused ? '#4CAF50' : '#FF6D00', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
    {paused ? '▶ Resume' : '⏸ Pause'}
  </button>
  <button onClick={() => setShowHeatmap(p => !p)} style={{ flex: 1, padding: '9px', background: showHeatmap ? 'rgba(68,136,255,0.25)' : '#222', color: '#fff', border: `1px solid ${showHeatmap ? '#4488FF' : '#444'}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
    🔥 Heatmap
  </button>
</div>
```

Run `npm run build` and `npm run lint` — both must pass. Commit.
