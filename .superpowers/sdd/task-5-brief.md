# Task 5: Layout fix — no panel overlap

**Files:**
- Modify: `src/components/NavigationPanel.tsx`, `src/components/ControlPanel.tsx`, `src/components/MapView.tsx`

## Requirements

Currently both panels have `position: absolute; top: 12; right: 12;` causing overlap.

1. **NavigationPanel.tsx:**
   - Change panel `right: 12` → `left: 12`
   - Change expandBtn `right: 12` → `left: 12`

2. **ControlPanel.tsx:** (already `position: absolute; top: 12; right: 12;`) — ensure it has `maxHeight: 'calc(100vh - 24px)'` — no change needed, just verify.

3. **MapView.tsx:**
   - Move the stats bar from `top: 12, left: 12` to `top: 60, left: 12` to sit below the override banner area

4. Run `npm run build` — must pass.

## Global Constraints
- No CSS modules, no Tailwind — inline styles only
