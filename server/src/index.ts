import express from 'express';
import { createServer } from 'http';
import { initFirebase, getDb } from './firebaseClient.js';
import { getGraph } from './graphService.js';
import { computeCongestionZones, computeStats } from './congestionService.js';
import { computeSLA } from './slaService.js';
import { detectActiveCorridors } from './corridorService.js';
import { findRoute } from './pathfindingService.js';
import { initSimulationEngine, getSimulationEngine } from './simulationEngine.js';
import { addUserVehicle, removeUserVehicle, getUserVehiclePosition } from './userVehicleService.js';
import { startNavigation, getNavigationUpdate } from './navigationService.js';
import { initializeWebSocket, handleWebSocketUpgrade } from './websocketService.js';
import type { Firestore } from 'firebase-admin/firestore';

const app = express();
app.use(express.json());

let db: Firestore | null = null;
try {
  initFirebase();
  db = getDb();
} catch (e) {
  console.warn('[WayFinder Server] Firebase init failed — running without Firestore:', e);
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/graph', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const result = await getGraph(forceRefresh);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vehicles', async (_req, res) => {
  try {
    const engine = getSimulationEngine();
    if (!engine) {
      return res.status(503).json({ error: 'Simulation engine not running' });
    }
    const vehicles = engine.getVehicles();
    res.json({ vehicles });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signals', async (_req, res) => {
  try {
    const engine = getSimulationEngine();
    if (!engine) {
      return res.status(503).json({ error: 'Simulation engine not running' });
    }
    const signals = engine.getSignals();
    res.json({ signals });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const engine = getSimulationEngine();
    if (!engine) {
      return res.status(503).json({ error: 'Simulation engine not running' });
    }
    const stats = engine.getStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/start', async (req, res) => {
  try {
    const { userId, sourceNodeId, destNodeId } = req.body;
    if (!userId || !sourceNodeId || !destNodeId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const engine = getSimulationEngine();
    if (!engine) {
      return res.status(503).json({ error: 'Simulation engine not running' });
    }

    const { graph, signals } = await getGraph();
    const navigation = await startNavigation({ userId, sourceNodeId, destNodeId }, graph, signals);
    res.json(navigation);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/:userId/position', async (req, res) => {
  try {
    const { userId } = req.params;
    const position = getUserVehiclePosition(userId);
    if (!position) {
      return res.status(404).json({ error: 'User vehicle not found' });
    }
    res.json(position);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/:userId/navigation', async (req, res) => {
  try {
    const { userId } = req.params;
    const { graph, signals } = await getGraph();
    const navigation = await getNavigationUpdate(userId, graph, signals);
    if (!navigation) {
      return res.status(404).json({ error: 'User navigation not found' });
    }
    res.json(navigation);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    removeUserVehicle(userId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/congestion', (req, res) => {
  const { vehicles, nodes } = req.body;
  const zones = computeCongestionZones(vehicles, nodes || []);
  const stats = computeStats(vehicles, zones);
  res.json({ zones, stats });
});

app.post('/api/sla', (req, res) => {
  const { vehicles } = req.body;
  res.json(computeSLA(vehicles || []));
});

app.post('/api/corridors', (req, res) => {
  const { vehicles } = req.body;
  res.json({ activeCorridors: detectActiveCorridors(vehicles || []) });
});

app.post('/api/route', (req, res) => {
  const { graph, signals, sourceId, destId } = req.body;
  const route = findRoute(graph, sourceId, destId, signals || []);
  res.json({ route });
});

const PORT = parseInt(process.env.PORT || '5000', 10);

// Initialize simulation engine on startup
async function initializeServer() {
  try {
    const { graph, signals } = await getGraph();
    const engine = initSimulationEngine(graph, signals);
    engine.start();
    console.log('[WayFinder Server] Simulation engine started');
    initializeWebSocket();
    console.log('[WayFinder Server] WebSocket initialized');
  } catch (err) {
    console.error('[WayFinder Server] Failed to initialize simulation interface:', err);
  }
}

const server = createServer(app);

server.on('upgrade', (request, socket, head) => {
  handleWebSocketUpgrade(request, socket, head);
});

server.listen(PORT, () => {
  console.log(`[WayFinder Server] Listening on ${PORT}`);
  initializeServer();

  // Firestore command listener — deferred so server boots even if Firebase is down
  if (!db) {
    console.warn('[WayFinder Server] Skipping command listener — Firestore unavailable');
    return;
  }
  const unsubCommands = db.collection('commands')
    .where('processed', '==', false)
    .onSnapshot(
      async (snapshot) => {
        for (const doc of snapshot.docs) {
          try {
            const cmd = doc.data();
            console.log('[WayFinder Server] Processing command:', cmd.type, doc.id);
            await db!.collection('commands').doc(doc.id).update({ processed: true, processedAt: new Date() });
          } catch (err) {
            console.error('Command processing error:', err);
          }
        }
      },
      (err) => {
        console.error('[WayFinder Server] Firestore listener error:', err.message);
      },
    );

  process.on('SIGTERM', () => { unsubCommands(); process.exit(0); });
});
