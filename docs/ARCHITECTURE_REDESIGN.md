# WayFinder Architecture Redesign

## New Architecture Overview

### Core Principles
1. **Storage-First Data Loading**: Always load from storage first, API only as fallback
2. **Server-Side Computation**: All heavy processing (simulation, routing, analytics) on server
3. **Progressive Loading**: Map → Roads → Signals → Vehicles
4. **User-as-Vehicle**: Users are tracked as vehicles in the simulation
5. **Thin Client**: Client only renders server-computed state

## Data Flow

### Loading Sequence
1. **Map Base Layer** (instant) - OpenStreetMap tiles
2. **Road Network** (from storage) - Cached graph from Firebase Storage/IndexedDB
3. **Signal Positions** (from storage) - Signal markers from cache
4. **Real-time State** (from server) - Vehicle positions, signal states, congestion

### Storage Hierarchy (Priority Order)
1. **IndexedDB** (fastest, local) - Browser cache
2. **Firebase Storage** (remote, fast) - CDN-backed blob storage
3. **Server API** (computed) - Fresh data from server
4. **Overpass API** (fallback) - Direct OSM fetch when all caches miss

### Server Responsibilities
- Traffic simulation (IDM physics, signal control)
- Vehicle tracking (including user vehicles)
- Route computation (A* with real-time conditions)
- Congestion analysis
- Signal coordination (green wave, adaptive timing)
- OSM data fetching and caching
- Real-time state broadcasting

### Client Responsibilities
- Render map (Leaflet)
- Display roads (polylines from server)
- Show signals (markers from server)
- Render vehicles (markers from server)
- Handle user input (navigation requests)
- Display navigation UI (direction, ETA, signals ahead)

## API Endpoints

### Data Loading
- `GET /api/graph` - Road network (nodes, edges, signals)
- `GET /api/vehicles` - All vehicle positions and states
- `GET /api/signals` - Current signal states
- `GET /api/congestion` - Congestion zones

### User Navigation
- `POST /api/user/start` - Start user as vehicle (userId, source, dest)
- `GET /api/user/:userId/position` - Current user vehicle position
- `GET /api/user/:userId/route` - User's route with signal info
- `GET /api/user/:userId/ahead` - Signals/traffic ahead on route
- `DELETE /api/user/:userId` - Remove user vehicle

### Real-time Updates
- `WebSocket /ws` - Real-time state updates (vehicles, signals, congestion)

## Data Models

### User Vehicle
```typescript
{
  userId: string
  vehicleId: string
  position: { lat, lng, bearing }
  route: string[]  // node IDs
  routeIndex: number
  speed: number
  eta: number
  signalsAhead: Array<{
    signalId: string
    distance: number
    currentState: 'RED' | 'YELLOW' | 'GREEN'
    estimatedWait: number
  }>
}
```

### Navigation Response
```typescript
{
  path: Array<{ lat, lng }>
  distance: number
  duration: number
  signals: Array<{
    id: string
    position: { lat, lng }
    currentState: string
    estimatedArrival: number
  }>
  trafficConditions: {
    congestionLevel: number
    avgSpeed: number
  }
}
```

## Implementation Plan

1. Server-side graph management with caching
2. Server traffic simulation engine
3. User vehicle tracking system
4. Navigation API with real-time conditions
5. WebSocket for real-time updates
6. Client refactoring to consume server state
7. Progressive loading implementation
8. Storage-first data fetching
