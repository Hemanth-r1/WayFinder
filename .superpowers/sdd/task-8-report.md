# Task 8: Speed control UI + heatmap toggle button

**Status:** ✅ Complete

## Changes

- **`src/App.tsx`** — Added speed slider (0.5×–4×) in the sidebar footer above the pause button. Replaced the single pause button with a two-button row: pause/resume and heatmap toggle (🔥 Heatmap). Both `speed`/`setSpeed` and `showHeatmap`/`setShowHeatmap` states existed from Task 6.

## Verification

| Command   | Result          |
|-----------|----------------|
| `npm run build` | ✅ TypeScript + Vite build pass |
| `npm run lint`  | ✅ 0 errors, 2 pre-existing warnings |

## Commit

```
c806302 task-8: add speed slider and heatmap toggle button to sidebar footer
```
