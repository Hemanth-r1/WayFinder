# Task B6: Wire SupporterPanel to Firestore signals (real-time)

**Files:**
- Modify: `src/roles/SupporterPanel.tsx`
- Modify: `src/App.tsx`

## Requirements

Currently SupporterPanel receives signals via props (`addedSignals`, `onAddSignal`) from App.tsx state. Replace with Firestore real-time listener.

1. **In SupporterPanel.tsx:**
   - Import Firestore: `collection`, `onSnapshot`, `addDoc`, `serverTimestamp` from `firebase/firestore`
   - Import `db` from `../config/firebase`
   - Import `useAuth` from `../context/useAuth`
   - On mount, subscribe to the `signals` collection with `onSnapshot`
   - Replace the add-signal handler to write to Firestore with `addDoc`
   - Remove `addedSignals` and `onAddSignal` from the component props
   - Use `useState` for local signals state

2. **In App.tsx:**
   - Remove `const [addedSignals, setAddedSignals] = useState<SupporterSignal[]>([]);`
   - Remove `onAddSignal={handleAddSignal}` from SupporterPanel's JSX
   - Remove the `handleAddSignal` callback
   - Remove `SupporterSignal` from the import if no longer used

3. Run `npm run build` — must pass.

## Important
- Read the current SupporterPanel.tsx fully before editing
- Signal documents: `{ supporterId, nodeId, lat, lng, roadName, signalType, timestamp }`
- `onSnapshot` on the full `signals` collection (no filter — all signals are shared)
- Return the unsubscribe function from useEffect

## Global Constraints
- `verbatimModuleSyntax: true`
- `noUnusedLocals` / `noUnusedParameters` are errors
