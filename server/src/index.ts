import express from 'express';
import { initFirebase, getDb } from './firebaseClient.js';
import { getGraph } from './graphService.js';
import { computeCongestionZones, computeStats } from './congestionService.js';
import { computeSLA } from './slaService.js';
import { detectActiveCorridors } from './corridorService.js';
import { findRoute } from './pathfindingService.js';
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

app.get('/api/graph', async (_req, res) => {
  try {
    const result = await getGraph();
    res.json(result);
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

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`[WayFinder Server] Listening on ${PORT}`);

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
