### Task 8: Firebase App Hosting Deployment Config

**Files:**
- Create: `firebase.apphosting.yaml`
- Modify: `server/Dockerfile` — multi-stage build

**Step 1: Create `firebase.apphosting.yaml`**

Project ID: `project-7d0d26b8-5887-43f6-804` (from .env.example)

```yaml
runConfig:
  minInstances: 0
  maxInstances: 1
  concurrency: 80
  cpu: 1
  memoryMiB: 512

env:
  - variable: GOOGLE_CLOUD_PROJECT
    value: project-7d0d26b8-5887-43f6-804
  - variable: SERVER_URL
    value: https://api-wayfinder-abc123.web.app
```

Note: The `SERVER_URL` value is a placeholder — the actual URL will be known after the first deployment.

**Step 2: Update `server/Dockerfile`**

Read the existing Dockerfile first, then replace with multi-stage build:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist/ ./dist/
COPY package*.json ./
RUN npm ci --omit=dev
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

**Step 3: Commit**

```bash
git add firebase.apphosting.yaml server/Dockerfile
git commit -m "deploy: Firebase App Hosting config for server container"
```
