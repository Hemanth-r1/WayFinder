# WayFinder Local Setup Guide

## Prerequisites
- Node.js installed
- Firebase project (optional - for full features)

## Server Setup

The server is now running on port 5000. It started successfully with:
- Firebase initialized (if credentials provided)
- Simulation engine started
- WebSocket initialized
- Using synthetic grid fallback (Overpass API had rate limiting issues)

### Server Configuration
The server is configured to run without Firebase credentials. It will:
- Use a synthetic road network grid
- Run traffic simulation
- Provide API endpoints
- Support WebSocket connections

To enable Firebase caching, create `server/.env` with:
```
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"your-project-id",...}
GOOGLE_CLOUD_PROJECT=your-project-id
PORT=5000
```

## Client Setup

### 1. Create .env file
Copy the example and create your local .env:
```bash
cp .env.example .env
```

### 2. Update .env with server URL
Make sure your `.env` file contains:
```
VITE_SERVER_URL=http://localhost:5000
```

**Note**: Firebase credentials are optional. The app will run in demo mode without them.

### 3. Start the client
```bash
npm install
npm run dev
```

The client will start on http://localhost:5173

## Demo Mode (No Firebase Required)

The application now works without Firebase configuration. In demo mode:
- Authentication accepts any email/password
- User is automatically logged in as "demo-user"
- All features work except Firebase-specific features (persistent data, Firestore sync)

### To Enable Full Firebase Features

Add these to your `.env` file:
```
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
VITE_FIREBASE_APP_ID=your-app-id
```

## Testing the Application

1. **Server**: Running on http://localhost:5000
   - API endpoints available at `/api/*`
   - WebSocket at `ws://localhost:5000`

2. **Client**: Running on http://localhost:5173
   - Will connect to server for data
   - Progressive loading will fetch from server
   - Real-time updates via WebSocket
   - Demo mode login available

## Current Status

✅ Server running on port 5000
✅ Simulation engine started
✅ WebSocket initialized
✅ Using synthetic grid (Overpass API rate limited)
✅ Firebase made optional for client
✅ Demo mode implemented
⏳ Client needs .env configuration

## Next Steps

1. Create `.env` file in the root directory
2. Add `VITE_SERVER_URL=http://localhost:5000`
3. Run `npm run dev` to start the client
4. Use "Quick Demo Login" button on login screen
5. Test the navigation flow
