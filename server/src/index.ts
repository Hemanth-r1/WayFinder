import express from 'express';
import { getGraph } from './graphService.js';
import { computeCongestionZones, computeStats } from './congestionService.js';
import { computeSLA } from './slaService.js';
import { detectActiveCorridors } from './corridorService.js';
import { findRoute } from './pathfindingService.js';

const app = express();
app.use(express.json());

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
});
