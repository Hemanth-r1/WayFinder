# Task B6 Report: Wire SupporterPanel to Firestore signals (real-time)

**Status:** ✅ Complete

## Build result

`npm run build` — **pass** (0 errors, 1 warning for chunk size, unrelated)

## Changes made

### `src/roles/SupporterPanel.tsx`
- Added imports: `useEffect` (React), `collection`, `onSnapshot`, `addDoc`, `serverTimestamp` (Firestore), `db` (config), `useAuth` (context)
- Removed `onAddSignal` and `addedSignals` from `Props`
- Added local `useState<SupporterSignal[]>([])` (`firebaseSignals`)
- Added `useEffect` with `onSnapshot` on `signals` collection for real-time listener; returns `unsub` for cleanup
- Mapped Firestore `Timestamp` to `SupporterSignal.timestamp` via `toMillis()`
- Replaced `handlePlace` to call `addDoc(collection(db, 'signals'), {...})` with `serverTimestamp()`
- "Your Signals" section now renders from `firebaseSignals` local state

### `src/App.tsx`
- Removed `const [addedSignals, setAddedSignals]` state
- Removed `SupporterSignal` from the import from `./types/roles`
- Simplified `handleAddSignal` (removed `setAddedSignals` call; kept `addSignalAtNode` for MapView)
- Removed `onAddSignal` and `addedSignals` props from `SupporterPanel` JSX

## Signal document schema

```typescript
{
  supporterId: string;   // user.uid
  nodeId: string;        // road name or 'unknown'
  lat: number;
  lng: number;
  roadName: string;
  signalType: string;    // 'smart'
  timestamp: Timestamp;  // serverTimestamp()
}
```
