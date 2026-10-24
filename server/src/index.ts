import express from 'express';
import { createServer } from 'http';
import { initFirebase, getDb } from './firebaseClient.js';
import { getGraph, getClientGraph } from './graphService.js';
import { computeCongestionZones, computeStats } from './congestionService.js';
import { computeSLA } from './slaService.js';
import { detectActiveCorridors } from './corridorService.js';
import { activeNavigatorCount, getGraphIndex, nearestRoadSegment } from './pathfindingService.js';
import {
  getConditions, setWeatherMode, setTrafficLevel, startWeatherPolling,
  type WeatherMode, type TrafficMode,
  setBehaviour,
} from './conditionsService.js';
import { createJam, listJams, removeJam } from './jamService.js';
import { initReports, createReport, vote, withdraw, SEGMENT_TYPES, type ReportType } from './reportsService.js';
import {
  requireUser, optionalUser, requireSelf, requireOperator, requireController, rateLimit, caller, authMode,
} from './auth.js';
import {
  initJunctions, listJunctions, getJunction, holdGreen, applyPlan, resetJunction, controlLog, ControlError,
} from './junctionService.js';
import { recordMovement, startCounts, junctionMovements, countsCsv } from './countsService.js';
import { surgeLive } from './scenarioService.js';
import { initSimulationEngine, getSimulationEngine } from './simulationEngine.js';
import { removeUserVehicle, getUserVehiclePosition, markArrived } from './userVehicleService.js';
import {
  startNavigation, getNavigationUpdate, planRoutes, acceptReroute, updatePosition, NavigationError,
} from './navigationService.js';
import { initializeWebSocket, handleWebSocketUpgrade, buildUpdate, parseBBox } from './websocketService.js';
import type { Firestore } from 'firebase-admin/firestore';

const app = express();
app.use(express.json());

// The web client is served from a different origin (Vite dev server / Firebase Hosting)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Demo-User, X-Demo-Role');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

let db: Firestore | null = null;
try {
  initFirebase();
  db = getDb();
} catch (e) {
  console.warn('[WayFinder Server] Firebase init failed — running without Firestore:', e);
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', auth: authMode() });
});

// Who the server thinks the caller is (role as verified server-side)
app.get('/api/me', requireUser, (_req, res) => {
  res.json({ ...caller(res), auth: authMode() });
});

// Static once loaded: sent pre-compressed; browsers revalidate by version (ETag) so a
// server with a new road network is picked up at once, and an unchanged one costs a 304
app.get('/api/graph', async (req, res) => {
  try {
    const { json, gzip } = await getClientGraph();
    const etag = `"graph-${(await getGraph()).version}"`;
    res.set('Cache-Control', 'no-cache');
    res.set('ETag', etag);
    res.set('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type('application/json');
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      res.set('Content-Encoding', 'gzip');
      res.send(gzip);
    } else {
      res.send(json);
    }
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

// Same payload as a WebSocket 'update' message, for clients that can't hold a socket open.
// ?bbox=w,s,e,n&zoom=z limits vehicles to the viewer's map; &traffic=1 adds road traffic levels.
app.get('/api/state', (req, res) => {
  const data = buildUpdate(
    { bbox: parseBBox(req.query.bbox), zoom: Number(req.query.zoom) || 0 },
    req.query.traffic === '1',
  );
  if (!data) return res.status(503).json({ error: 'Simulation engine not running' });
  res.json(data);
});

// ── Road conditions ──────────────────────────────────────────────────────────

const WEATHER_MODES: WeatherMode[] = ['live', 'clear', 'rain', 'heavy_rain'];
const TRAFFIC_LEVELS: TrafficMode[] = ['auto', 'light', 'normal', 'heavy'];
const REPORT_TYPES: ReportType[] = ['block', 'tree', 'waterlogging', 'rain'];

function sendError(res: express.Response, err: any) {
  res.status(err instanceof NavigationError ? err.status : 500).json({ error: err.message });
}

app.get('/api/conditions', (_req, res) => {
  res.json(getConditions());
});

// City-wide weather override and simulated traffic level: operators only
app.post('/api/conditions/weather', requireUser, requireOperator, (req, res) => {
  const { mode } = req.body;
  if (!WEATHER_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${WEATHER_MODES.join(', ')}` });
  }
  setWeatherMode(mode);
  res.json(getConditions());
});

app.post('/api/conditions/traffic', requireUser, requireOperator, (req, res) => {
  const { level } = req.body;
  if (!TRAFFIC_LEVELS.includes(level)) {
    return res.status(400).json({ error: `level must be one of ${TRAFFIC_LEVELS.join(', ')}` });
  }
  setTrafficLevel(level);
  res.json(getConditions());
});

/** Driver behaviour switches: { redJumping?, laneWeaving?, wrongWay? } (booleans). */
app.post('/api/conditions/behaviour', requireUser, requireOperator, (req, res) => {
  setBehaviour(req.body ?? {});
  res.json(getConditions());
});

// ── Intentional jams (design / training) ─────────────────────────────────────

app.get('/api/jams', requireUser, requireOperator, (_req, res) => {
  res.json({ jams: listJams() });
});

/** { lat, lng, metres?, minutes?, severity?: 'stopped' | 'slow' } — jams the nearest road. */
app.post('/api/jams', requireUser, requireController, async (req, res) => {
  const { lat, lng, metres, minutes, severity } = req.body ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat and lng are required' });
  try {
    const jam = await createJam({ lat, lng, metres: Number(metres) || undefined, minutes: Number(minutes) || undefined, severity, createdBy: caller(res).uid });
    res.json({ jam, jams: listJams() });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/jams/:id', requireUser, requireController, (req, res) => {
  removeJam(String(req.params.id));
  res.json({ jams: listJams() });
});

// ── Crowd reports: road blocks, waterlogging, local rain ───────────────────────

/** Point halfway along a polyline (by vertex-to-vertex distance). */
function segmentMidpoint(geom: { lat: number; lng: number }[]): { lat: number; lng: number } {
  const lens = geom.slice(1).map((p, i) => Math.hypot(p.lat - geom[i].lat, p.lng - geom[i].lng));
  let remaining = lens.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (remaining <= lens[i]) {
      const t = lens[i] > 0 ? remaining / lens[i] : 0;
      return { lat: geom[i].lat + t * (geom[i + 1].lat - geom[i].lat), lng: geom[i].lng + t * (geom[i + 1].lng - geom[i].lng) };
    }
    remaining -= lens[i];
  }
  return geom[0];
}

// { type, lat, lng, radius? } — radius is the tap tolerance in metres (follows map zoom)
app.post('/api/reports', requireUser, rateLimit('reports', 6, 10 * 60 * 1000), async (req, res) => {
  try {
    const { type, lat, lng, radius } = req.body;
    if (!REPORT_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of ${REPORT_TYPES.join(', ')}` });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng are required numbers' });
    }
    const { graph, signals } = await getGraph();
    const index = getGraphIndex(graph, signals);
    const tolerance = typeof radius === 'number' ? Math.min(250, Math.max(20, radius)) : 60;
    const nearest = nearestRoadSegment(index, lat, lng, tolerance);
    if (!nearest) return res.status(404).json({ error: 'No road near that point — zoom in and tap on a road' });
    const roadName = nearest.edge.name || 'Unnamed road';
    const mid = segmentMidpoint(nearest.edge.geometry);
    const { uid, trusted } = caller(res);
    const result = createReport({
      type, lat, lng, uid, trusted, roadName,
      segment: SEGMENT_TYPES.has(type) ? { edgeIds: nearest.edgeIds, roadName, lat: mid.lat, lng: mid.lng } : undefined,
    });
    res.json(result);
  } catch (err: any) {
    sendError(res, err);
  }
});

// { vote: 'confirm' | 'clear' }
app.post('/api/reports/:id/vote', requireUser, rateLimit('votes', 30, 10 * 60 * 1000), (req, res) => {
  const v = req.body.vote;
  if (v !== 'confirm' && v !== 'clear') return res.status(400).json({ error: "vote must be 'confirm' or 'clear'" });
  try {
    const { uid, trusted } = caller(res);
    const report = vote(String(req.params.id), uid, v, trusted);
    res.json({ report, cleared: report === null });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/reports/:id', requireUser, (req, res) => {
  try {
    const { uid, trusted } = caller(res);
    if (!withdraw(String(req.params.id), uid, trusted)) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const engine = getSimulationEngine();
    if (!engine) {
      return res.status(503).json({ error: 'Simulation engine not running' });
    }
    const stats = engine.getStats();
    res.json({ ...stats, activeNavigators: activeNavigatorCount() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/start', requireUser, async (req, res) => {
  try {
    const { sourceNodeId, destNodeId, edgeIds, mode } = req.body;
    const userId = caller(res).uid;
    if (req.body.userId && req.body.userId !== userId) {
      return res.status(403).json({ error: 'You can only start your own navigation' });
    }
    if (!sourceNodeId || !destNodeId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (edgeIds !== undefined && !(Array.isArray(edgeIds) && edgeIds.every((id: unknown) => typeof id === 'string'))) {
      return res.status(400).json({ error: 'edgeIds must be an array of strings' });
    }

    const { graph, signals } = await getGraph();
    const navigation = startNavigation(
      { userId, sourceNodeId, destNodeId, edgeIds, mode: mode === 'gps' ? 'gps' : 'simulated' }, graph, signals,
    );
    res.json(navigation);
  } catch (err: any) {
    res.status(err instanceof NavigationError ? err.status : 500).json({ error: err.message });
  }
});

app.get('/api/user/:userId/position', requireUser, requireSelf, async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const position = getUserVehiclePosition(userId);
    if (!position) {
      return res.status(404).json({ error: 'User vehicle not found' });
    }
    res.json(position);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/:userId/navigation', requireUser, requireSelf, async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const { graph, signals } = await getGraph();
    const navigation = getNavigationUpdate(userId, graph, signals);
    if (!navigation) {
      return res.status(404).json({ error: 'User navigation not found' });
    }
    res.json(navigation);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GPS fix from a navigating phone: { lat, lng, speed? (km/h) }
app.post('/api/user/:userId/position', requireUser, requireSelf, async (req, res) => {
  try {
    const { lat, lng, speed } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng are required numbers' });
    }
    const { graph, signals } = await getGraph();
    res.json(updatePosition(String(req.params.userId), lat, lng, typeof speed === 'number' ? speed : undefined, graph, signals));
  } catch (err: any) {
    sendError(res, err);
  }
});

// Accept the reroute offered in the latest navigation update
app.post('/api/user/:userId/reroute', requireUser, requireSelf, async (req, res) => {
  try {
    const { graph, signals } = await getGraph();
    res.json({ routeInfo: acceptReroute(String(req.params.userId), graph, signals) });
  } catch (err: any) {
    sendError(res, err);
  }
});

app.delete('/api/user/:userId', requireUser, requireSelf, async (req, res) => {
  try {
    const userId = String(req.params.userId);
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

// Route options on the server's own graph. `route` (the first option) is kept for older clients.
// ── Junctions: police view and signal control ────────────────────────────────

function sendControlError(res: express.Response, err: any) {
  res.status(err instanceof ControlError ? err.status : 500).json({ error: err.message });
}

/** Every signalised junction with live status, worst first (operators). */
app.get('/api/junctions', requireUser, requireOperator, (_req, res) => {
  res.json({ junctions: listJunctions() });
});

/** One junction: approaches, queues, recommendation, neighbours, active control. */
app.get('/api/junctions/:id', requireUser, requireOperator, (req, res) => {
  const j = getJunction(String(req.params.id));
  if (!j) return res.status(404).json({ error: 'Unknown junction' });
  res.json(j);
});

/** Controller: hold a group green (seconds), optionally coordinating neighbours. */
app.post('/api/junctions/:id/hold', requireUser, requireController, (req, res) => {
  try {
    const { group, seconds, coordinate } = req.body ?? {};
    if (typeof group !== 'string' || typeof seconds !== 'number') {
      return res.status(400).json({ error: 'group (string) and seconds (number) required' });
    }
    res.json({ changes: holdGreen(String(req.params.id), group, seconds, coordinate !== false, caller(res).uid) });
  } catch (err) { sendControlError(res, err); }
});

/** Controller: new green times { greens: { A: 60, B: 40 } } or { recommended: true }. */
app.post('/api/junctions/:id/plan', requireUser, requireController, (req, res) => {
  try {
    const { greens, recommended } = req.body ?? {};
    const plan = recommended ? 'recommended' as const : greens;
    if (plan !== 'recommended' && (typeof plan !== 'object' || !plan || !Object.values(plan).every(v => typeof v === 'number'))) {
      return res.status(400).json({ error: 'greens { group: seconds } or recommended: true required' });
    }
    res.json({ changes: applyPlan(String(req.params.id), plan, caller(res).uid) });
  } catch (err) { sendControlError(res, err); }
});

app.post('/api/junctions/:id/reset', requireUser, requireController, (req, res) => {
  try {
    res.json({ changes: resetJunction(String(req.params.id), caller(res).uid) });
  } catch (err) { sendControlError(res, err); }
});

/** Turning movements at a junction over the last ?hours=1 (estimated vehicles and people per hour). */
app.get('/api/junctions/:id/movements', requireUser, requireOperator, (req, res) => {
  const hours = Math.min(24, Math.max(0.25, Number(req.query.hours) || 1));
  res.json(junctionMovements(String(req.params.id), hours));
});

/** 15-minute movement counts as CSV, for traffic studies and urban planning (?hours=24&junction=ID). */
app.get('/api/counts.csv', requireUser, requireOperator, (req, res) => {
  const hours = Math.min(24, Math.max(0.25, Number(req.query.hours) || 24));
  const junction = typeof req.query.junction === 'string' ? req.query.junction : undefined;
  res.type('text/csv');
  res.set('Content-Disposition', `attachment; filename="wayfinder-junction-counts-${junction ?? 'all'}.csv"`);
  res.send(countsCsv(hours, junction));
});

/** Controllers (demo/training): fill a junction's approaches bumper-to-bumper in the live simulation. */
app.post('/api/junctions/:id/surge', requireUser, requireController, async (req, res) => {
  try {
    const metres = Math.min(1000, Math.max(100, Number(req.body?.metres) || 600));
    const id = String(req.params.id);
    // A big cross often has more than one signal (e.g. Gorguntepalaya: the cross itself and
    // Outer Ring Road × Tumkur Road 330 m away): fill every signal within 400 m together
    const all = listJunctions();
    const me = all.find(j => j.id === id);
    const ids = me ? all.filter(j => Math.hypot((j.lat - me.lat) * 111320, (j.lng - me.lng) * 111320 * Math.cos(me.lat * Math.PI / 180)) <= 400).map(j => j.id) : [id];
    const { placed, arms } = await surgeLive(ids, metres);
    const names = new Map(all.map(j => [j.id, j.name]));
    res.json({
      placed, arms,
      changes: [
        `Filled ${arms.length} approaches at ${ids.map(j => names.get(j) ?? j).join(' + ')} for ${metres} m (${placed} vehicles)`,
        ...arms.map(a => `${a.road} → ${names.get(a.junctionId) ?? a.junctionId}: ${a.vehicles} vehicles`),
      ],
    });
  } catch (err) { sendControlError(res, err); }
});

/** Who changed which signal, newest first. */
app.get('/api/control/log', requireUser, requireOperator, (_req, res) => {
  res.json({ log: controlLog() });
});

app.post('/api/route', optionalUser, async (req, res) => {
  try {
    const { sourceId, destId } = req.body;
    // Anonymous previews work; signed-in users don't count their own route as load
    const userId = res.locals.caller?.uid as string | undefined;
    if (!sourceId || !destId) {
      return res.status(400).json({ error: 'Missing sourceId or destId' });
    }
    const { graph, signals } = await getGraph();
    const routes = planRoutes(userId, sourceId, destId, graph, signals);
    res.json({ routes, route: routes[0] ?? null });
  } catch (err: any) {
    res.status(err instanceof NavigationError ? err.status : 500).json({ error: err.message });
  }
});

const PORT = parseInt(process.env.PORT || '8080', 10);

// Initialize simulation engine on startup
async function initializeServer() {
  try {
    const { graph, signals } = await getGraph();
    initReports(getGraphIndex(graph, signals));
    initJunctions(getGraphIndex(graph, signals), signals, (await getGraph()).places);
    getClientGraph().catch(() => {}); // serialise once, now that signals carry their directions
    const engine = initSimulationEngine(graph, signals);
    engine.setArrivalHandler(markArrived);
    engine.setMovementHandler(recordMovement);
    startCounts();
    engine.start();
    startWeatherPolling();
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
