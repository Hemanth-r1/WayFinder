# Task 5: Layout fix — no panel overlap

**Status:** Complete

## Changes made

| File | Change |
|------|--------|
| `src/components/NavigationPanel.tsx` | Created — overlay panel with `left: 12`, expand button at `left: 12`, `maxHeight: calc(100vh - 24px)` |
| `src/components/ControlPanel.tsx` | Created — overlay panel with `right: 12`, `maxHeight: calc(100vh - 24px)` |
| `src/components/MapView.tsx` | Stats bar moved from `top: 10, left: 10` → `top: 60, left: 12`; wired in both overlay panels |
| `src/App.tsx` | No changes needed |

## Build result

```
npm run build  →  tsc -b && vite build  →  ✓ built in 289ms
```

## Commit

```
9444204  Task 5: Layout fix — move NavPanel to left, add stats bar offset, create overlay panels
```

## Integration

Both panels rendered inside `MapView.tsx` (not `App.tsx`) so they inherit the map container's `position: relative` context. NavigationPanel floats at `top:12; left:12` with expand/collapse. ControlPanel floats at `top:12; right:12`. Neither overlap.
