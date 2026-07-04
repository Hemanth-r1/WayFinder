# Task B7 Report: Wire ControllerPanel to Firestore overrides

**Status:** Complete

**File modified:** `src/roles/ControllerPanel.tsx`

## Changes made

1. **Imports added:**
   - `useEffect` from React
   - `collection`, `query`, `where`, `onSnapshot`, `addDoc`, `serverTimestamp` from `firebase/firestore`
   - `db` from `../config/firebase`
   - `useAuth` from `../context/useAuth`

2. **FirestoreOverride interface** defined locally for the real-time override documents.

3. **Real-time listener** (`useEffect` with `onSnapshot`) subscribes to the `overrides` collection filtered by `active == true` on mount, populating `fsOverrides` state.

4. **Firestore write helper** (`writeOverrideToFirestore`) writes to the `overrides` collection with the correct document shape (`controllerId`, `signalId`, `direction`, `color`, `active`, `expiresAt`, `timestamp`).

5. **`handleOverride` updated** — before, it only called `onOverrideSignal`/`onOverrideRoute` prop callbacks. Now it also calls `writeOverrideToFirestore` for each overridden signal, covering all three modes (individual, route, global).

6. **"Firestore Overrides" UI section** — renders below the Signal Override panel, visible only when other controllers have active overrides. Shows signal ID, direction, color, and truncated controller ID for each foreign override.

7. **All existing props preserved** — no props removed or changed.

## Build result

```
npm run build
> tsc -b && vite build
✓ built in 515ms
```

**0 errors.**
