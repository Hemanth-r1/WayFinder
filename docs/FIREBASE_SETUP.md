# Deploying WayFinder to the shared Firebase project

WayFinder lives in a Firebase project that also hosts other apps. It is set up so it
cannot touch them:

| Piece | What WayFinder uses | Shared with other apps? |
|---|---|---|
| Firestore | Its own **named database `wayfinder`** (`firebase.json` → `firestore[].database`; server `FIRESTORE_DATABASE`, client `VITE_FIRESTORE_DATABASE`) | No — other apps keep `(default)`; WayFinder's rules deploy only to `wayfinder` |
| Hosting | Its own **site**, reached through the hosting target `wayfinder` | No — deploys use `--only hosting:wayfinder` / the action's `target: wayfinder` |
| API | Cloud Run service `wayfinder-server` (us-central1), 1 instance, 2 GiB | No |
| Storage | Not used (no storage rules are deployed) | — |
| Authentication | Firebase Auth of the project | **Yes** — accounts are per project; WayFinder roles live in its own database |

## One-time setup

```bash
npx firebase-tools login
npx firebase-tools projects:list                       # find the WayFinder project id
npx firebase-tools use <project-id>
npx firebase-tools hosting:sites:list                  # see which sites other apps use
npx firebase-tools hosting:sites:create <wayfinder-site-id>
npx firebase-tools target:apply hosting wayfinder <wayfinder-site-id>
npx firebase-tools firestore:databases:create wayfinder --location=asia-south1
npx firebase-tools deploy --only firestore:wayfinder   # rules + indexes, wayfinder database only
```

Then build and deploy the web app to WayFinder's site only:

```bash
npm run build
npx firebase-tools deploy --only hosting:wayfinder
```

The server (Cloud Run) is deployed by `.github/workflows/deploy.yml` on pushes to `main`
(needs the `FIREBASE_SERVICE_ACCOUNT` secret with Cloud Run and Firebase Hosting rights,
plus the `VITE_FIREBASE_*` secrets). The workflow sets `FIRESTORE_DATABASE=wayfinder`
and deploys hosting with `target: wayfinder`.

## Roles

Promote an officer by editing **the `wayfinder` database** (not `(default)`):
`users/{uid}` → `role: "controller"` (or `"supporter"`).
