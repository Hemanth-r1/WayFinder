# Deploying WayFinder to Firebase

WayFinder deploys to the Firebase project **WayFinder** (`project-7d0d26b8-5887-43f6-804`).

**Another app shares this project's Firestore `(default)` database** (recruitment data:
candidates, jobs, employees, students, tickets…). WayFinder therefore keeps all its data in
its **own named database `wayfinder`** and deploys rules and indexes only there. Never run
`firebase deploy --only firestore` against `(default)`, and never pass `--force`
(it would delete the other app's indexes).

| Piece | Where |
|---|---|
| Web app | Hosting site `project-7d0d26b8-5887-43f6-804` (target `wayfinder` in `.firebaserc`) |
| API | Cloud Run `wayfinder-server` (asia-south1, Mumbai), 1 instance, 2 GiB, CPU always on; Hosting rewrites `/api/**` to it |
| Data | Firestore database `wayfinder` (asia-south1); rules `firestore.rules`, indexes `firestore.indexes.wayfinder.json` |
| Sign-in | Firebase Auth — shared by every app in the project |

Server: `FIRESTORE_DATABASE=wayfinder` (default). Client: `VITE_FIRESTORE_DATABASE=wayfinder` (default).

## Deploy

```bash
# rules + indexes, wayfinder database only (firebase.json targets it)
npx firebase-tools deploy --only firestore --project project-7d0d26b8-5887-43f6-804
```

Server and web app: push to `main` — `.github/workflows/deploy.yml` deploys Cloud Run
first, then Hosting (`target: wayfinder`). GitHub secrets needed:
`FIREBASE_SERVICE_ACCOUNT` (Cloud Run Admin, Service Account User, Firebase Hosting Admin,
Cloud Build Editor, Datastore User), `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_SENDER_ID`,
`VITE_FIREBASE_APP_ID`.

## Roles

Promote an officer in the **`wayfinder`** database: `users/{uid}` → `role: "controller"`
(or `"supporter"`).
