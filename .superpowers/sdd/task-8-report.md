# Task 8: Firebase App Hosting Deployment Config — Report

**Status:** ✅ Complete

**Commit SHA:** `af9c727aa6e181612c27805f8b844569459b060c`

**Verification:** `npx tsc --noEmit` in `server/` — passed (no errors)

**Changes:**
- Created `firebase.apphosting.yaml` — runConfig (0-1 instances, 80 concurrency, 1 CPU, 512 MiB) + env vars for `GOOGLE_CLOUD_PROJECT` and `SERVER_URL`
- Updated `server/Dockerfile` — multi-stage build (`builder` → `runner`), builds from `src/` in builder stage, copies only `dist/` and production deps to runner stage

**Concerns:** `SERVER_URL` value (`https://api-wayfinder-abc123.web.app`) is a placeholder — needs update after first deployment. `GOOGLE_CLOUD_PROJECT` value (`project-7d0d26b8-5887-43f6-804`) sourced from brief; not present in `.env.example`.
