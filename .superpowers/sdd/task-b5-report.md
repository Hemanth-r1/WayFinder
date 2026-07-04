# Task B5 Report: Wire UserPanel to Firestore routes

**Status:** Complete

**Build result:** `npm run build` passes with 0 errors (tsc and vite build both clean)

## Changes made

### `src/roles/UserPanel.tsx`
- Added imports: Firestore functions (`collection`, `query`, `where`, `orderBy`, `onSnapshot`, `addDoc`, `serverTimestamp`), `db` from `../config/firebase`, `useAuth` from `../context/useAuth`
- Removed `onSubmitRoute` and `submittedRoutes` from the Props interface
- Added `const { user } = useAuth()` and local `const [routes, setRoutes] = useState<UserRoute[]>([])`
- Added `useEffect` that subscribes to the Firestore `routes` collection with `onSnapshot`, filtered by `userId == user.uid`, ordered by `createdAt desc`. Maps Firestore docs to `UserRoute` objects for display (using `sourceNodeId`/`destNodeId` as names, `0` for lat/lng coords, empty `signalOverrides`)
- Replaced `handleSubmit` to write to Firestore via `addDoc` with fields: `{ userId, sourceNodeId, destNodeId, avoidCongestion, preferMainRoads, createdAt: serverTimestamp() }`
- All JSX references updated from `submittedRoutes` to `routes`

### `src/App.tsx`
- Removed `const [userRoutes, setUserRoutes] = useState<UserRoute[]>([])`
- Removed `handleSubmitRoute` callback
- Removed `onSubmitRoute={handleSubmitRoute} submittedRoutes={userRoutes}` from UserPanel's JSX
- Changed `handleExportStats` to pass `[] as UserRoute[]` instead of `userRoutes`
- Changed ControllerPanel's `userRoutes` prop to `[] as UserRoute[]`
- Kept `UserRoute` import (still used for type assertions in remaining references)

## Additional changes needed

None from this task. ControllerPanel and exportStats still use `userRoutes` prop but receive an empty array — these can be wired to Firestore in a future task if needed.

## Report details

- **Task brief:** `C:\AVKS\Github\WayFinder\.superpowers\sdd\task-b5-brief.md`
- **Report:** `C:\AVKS\Github\WayFinder\.superpowers\sdd\task-b5-report.md`
