# Task B5: Wire UserPanel to Firestore routes

**Files:**
- Modify: `src/roles/UserPanel.tsx`
- Modify: `src/App.tsx`

## Requirements

Currently UserPanel receives routes via props (`submittedRoutes`, `onSubmitRoute`) and stores them in App.tsx state. Replace this with Firestore as the source of truth.

1. **In UserPanel.tsx:**
   - Import Firestore: `collection`, `query`, `where`, `orderBy`, `onSnapshot`, `addDoc`, `serverTimestamp` from `firebase/firestore`
   - Import `db` from `../config/firebase`
   - Import `useAuth` from `../context/useAuth`
   - On mount, subscribe to `routes` collection filtered by `userId == user.uid` with `onSnapshot`
   - Replace the submit handler to write to Firestore with `addDoc`
   - Remove `submittedRoutes` and `onSubmitRoute` from the component props (firestore is now the single source of truth)
   - Use `useState` for local routes state

2. **In App.tsx:**
   - Remove `const [userRoutes, setUserRoutes] = useState<UserRoute[]>([]);`
   - Remove `onSubmitRoute={handleSubmitRoute}` from UserPanel's JSX
   - Remove the `handleSubmitRoute` callback
   - Remove `UserRoute` from the import from `../types/roles` if it's no longer used

3. Run `npm run build` — must pass.

## Important

- Read the current UserPanel.tsx fully before editing
- The `user.uid` is the Firestore document ID in the `users` collection
- Route documents in Firestore look like: `{ userId, sourceNodeId, destNodeId, avoidCongestion, preferMainRoads, createdAt }`
- Use `serverTimestamp()` for `createdAt`
- `onSnapshot` returns an unsubscribe function — return it from the useEffect

## Global Constraints
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `noUnusedLocals` / `noUnusedParameters` are errors
