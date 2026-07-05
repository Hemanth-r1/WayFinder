# Task 5: Server Firestore Command Listener

**Status:** ✅ Complete

**Commit SHA:** `7f725d0`

**Verification:** `npx tsc --noEmit` passed with zero errors.

**Changes:**
- Created `server/src/firebaseClient.ts` — Firebase Admin SDK init + Firestore accessor
- Modified `server/src/index.ts` — added Firebase init, `onSnapshot` listener on `commands` collection, SIGTERM cleanup

**Concerns:** None.
