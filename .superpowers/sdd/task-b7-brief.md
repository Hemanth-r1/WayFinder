# Task B7: Wire ControllerPanel to Firestore overrides (real-time)

**Files:**
- Modify: `src/roles/ControllerPanel.tsx`

## Requirements

ControllerPanel currently receives all data via props from App.tsx (stats, signals, etc.). Add Firestore real-time sync for overrides so multiple controllers see each other's overrides.

1. **In ControllerPanel.tsx:**
   - Import Firestore: `collection`, `query`, `where`, `onSnapshot`, `addDoc`, `serverTimestamp` from `firebase/firestore`
   - Import `db` from `../config/firebase`
   - Import `useAuth` from `../context/useAuth`
   - On mount, subscribe to the `overrides` collection filtered by `active == true` with `onSnapshot`
   - Add a "Firestore Overrides" section showing current overrides from other controllers
   - Keep the existing `onOverrideSignal` prop for calling the TrafficEngine immediately
   - Also write the override to Firestore when a manual override is triggered:
     ```
     addDoc(collection(db, 'overrides'), {
       controllerId: user.uid,
       signalId,
       direction,
       color,
       active: true,
       expiresAt: new Date(Date.now() + 30_000),
       timestamp: serverTimestamp(),
     })
     ```

2. **Don't remove existing props** — ControllerPanel still needs all its current props for engine interaction. Just add the Firestore layer on top.

3. Run `npm run build` — must pass.

## Global Constraints
- `verbatimModuleSyntax: true`
- `noUnusedLocals` / `noUnusedParameters` are errors
