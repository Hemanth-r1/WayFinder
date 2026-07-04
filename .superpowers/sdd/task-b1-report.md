# Task B1 Report: Create Firebase config

**Status:** ✅ Complete

## Changes

1. **Created** `src/config/firebase.ts` — Firebase initialization using `VITE_FIREBASE_*` env vars, exports `auth`, `db`, and default `app`.

2. **Edited** `src/config/index.ts` — Removed `ENABLE_FIREBASE: false` from `FEATURE_FLAGS` (no longer needed since Firebase is now always configured at import).

## Build

`npm run build` — passed (tsc + vite both clean, 0 errors).
