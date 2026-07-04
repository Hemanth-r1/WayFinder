# Task B8: Final integration + Firestore rules + docs

**Files:**
- Create: `firestore.rules`
- Modify: `AGENTS.md`

## Requirements

### 1. Create `firestore.rules` at project root

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /routes/{routeId} {
      allow read, update, delete: if request.auth != null && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.userId;
    }
    match /signals/{signalId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && 
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['supporter', 'controller'];
    }
    match /overrides/{overrideId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && 
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'controller';
    }
  }
}
```

### 2. Update AGENTS.md Firebase section

Replace the old Firebase section with actual setup instructions:

```
## Firebase

Real authentication and data persistence via Firebase Auth + Firestore.

### Setup

1. Create a Firebase project at https://console.firebase.google.com
2. Enable **Authentication → Sign-in method → Email/Password**
3. Create a **Firestore Database** (start in test mode, then apply rules)
4. Copy `.env.example` → `.env` and fill in your Firebase project config values
5. Deploy Firestore security rules from `firestore.rules`:
   - Via Firebase Console → Firestore → Rules tab, or
   - Via Firebase CLI: `firebase deploy --only firestore:rules`

### Roles

- Users start with `role: "user"` on first sign-up
- To promote a user, update their Firestore document:
  `users/{uid}` → set `role: "supporter"` or `role: "controller"`
- Role changes take effect on next page load

### Firestore Collections

| Collection | Access | Description |
|-----------|--------|-------------|
| `users/{uid}` | Own user only | Profile and role |
| `routes/{routeId}` | Own user only | Submitted navigation routes (persistent) |
| `signals/{signalId}` | All authenticated users read, supporters+ write | Community-added traffic signals (real-time) |
| `overrides/{overrideId}` | All authenticated users read, controllers write | Active signal overrides (real-time) |
```

### 3. Run `npm run build` — final check.

## Global Constraints
- No code changes to source files — only `firestore.rules` and `AGENTS.md`
