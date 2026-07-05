### Task 1: Server Scaffold

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`
- Create: `server/Dockerfile`
- Create: `server/.dockerignore`
- Modify: `package.json` (root) — add `"build:server"` script

**Interfaces:**
- Produces: Express app listening on `process.env.PORT || 8080`
- Produces: `GET /api/health` -> `{ status: 'ok' }`

**Step 1: Create `server/package.json`**

```json
{
  "name": "wayfinder-server",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "express": "^4.21.0",
    "firebase-admin": "^12.6.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "tsx": "^4.19.0",
    "typescript": "~5.7.0"
  }
}
```

**Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

**Step 3: Create `server/src/index.ts`**

```typescript
import express from 'express';

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`[WayFinder Server] Listening on ${PORT}`);
});
```

**Step 4: Create `server/Dockerfile`**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

**Step 5: Create `server/.dockerignore`**

```
node_modules
src
tsconfig.json
```

**Step 6: Add build script to root `package.json`**

```json
"build:server": "cd server && tsc"
```

**Step 7: Verify server compiles**

```bash
cd server && npm install && npx tsc --noEmit
```

**Step 8: Commit**

```bash
git add server/ package.json
git commit -m "feat(server): scaffold Express app with health endpoint"
```
