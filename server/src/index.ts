import express from 'express';
import { createServer } from 'http';
import { initFirebase } from './firebaseClient.js';
import { getGraph, getClientGraph, getRoadTiles, type Piece } from './graphService.js';
import { gzipSync } from 'node:zlib';
import { activeNavigatorCount, getGraphIndex, nearestRoadSegment } from './pathfindingService.js';
import {
  getConditions, setWeatherMode, setTrafficLevel, startWeatherPolling,
  type WeatherMode, type TrafficMode,
  setBehaviour,
} from './conditionsService.js';
import { createJam, listJams, removeJam } from './jamService.js';
import { initReports, createReport, vote, withdraw, SEGMENT_TYPES, type ReportType, canAttachPhoto, attachPhoto,
} from './reportsService.js';
import {
  requireUser, requireSelf, pace, requireOperator, requireController, rateLimit, caller, authMode,
} from './auth.js';
import {
  initJunctions, listJunctions, getJunction, holdGreen, applyPlan, resetJunction, controlLog, ControlError, recordControl,
} from './junctionService.js';
import { recordMovement, startCounts, junctionMovements, countsCsv } from './countsService.js';
import { surgeLive } from './scenarioService.js';
import { initSimulationEngine, getSimulationEngine } from './simulationEngine.js';
import { removeUserVehicle, getUserVehiclePosition, markArrived } from './userVehicleService.js';
import {
  startNavigation, getNavigationUpdate, planRoutes, acceptReroute, updatePosition, NavigationError,
} from './navigationService.js';
import { initRouteWorkers, routeQueuePerWorker } from './routeWorkers.js';
import { initTurnRules, loadSavedRules, setRules, turnsView, RuleError } from './turnRules.js';
import { initEmergency, dispatchEmergency, cancelCorridor, listCorridors, EmergencyError } from './emergencyService.js';
import { initTrips, tripStats, loadTripCache } from './tripService.js';
import { saveFile, listFiles, getFileMeta, readFile, deleteFile, FileError, FILE_TYPES, MAX_FILE_BYTES, type FilePurpose } from './fileService.js';
import { planCoordination, applyCoordination } from './coordinationService.js';
import { commonJson, signalsJson, signalOrderJson, phasesJson, trafficJson, trafficDeltaJson, cellJson } from './liveSnapshot.js';

const app = express();
app.use(express.json());

// The web client is served from a different origin (Vite dev server / Firebase Hosting)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Demo-User, X-Demo-Role');
  res.header('Access-Control-Expose-Headers', 'X-Next-Ms');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

try {
  initFirebase();
} catch (e) {
  console.warn('[WayFinder Server] Firebase init failed — running without Firestore:', e);
}
// Without Firebase the server trusts X-Demo-Role headers (anyone could be a controller).
// That's fine on a laptop, never on Cloud Run: refuse to start instead of failing open.
if (authMode() === 'demo' && (process.env.K_SERVICE || process.env.NODE_ENV === 'production') && process.env.ALLOW_DEMO_MODE !== 'true') {
  console.error('[WayFinder Server] Firebase is not configured — refusing to run demo mode in production (set ALLOW_DEMO_MODE=true to override)');
  process.exit(1);
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', auth: authMode() });
});

// Who the server thinks the caller is (role as verified server-side)
app.get('/api/me', requireUser, (_req, res) => {
  res.json({ ...caller(res), auth: authMode() });
});

// Static once loaded: sent pre-compressed. The ETag is a hash of the content, so a restart
// with the same roads changes nothing for phones; the CDN keeps it for an hour
app.get('/api/graph', async (req, res) => {
  try {
    const { json, gzip, version } = await getClientGraph();
    const etag = `"graph-${version}"`;
    res.set('Cache-Control', 'public, max-age=0, s-maxage=3600');
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

// Road tiles: the map loads only the roads around what's on screen (see getRoadTiles).
// /api/roads/meta says the current version; the other URLs include it and never change.
function sendPiece(req: express.Request, res: express.Response, p: Piece | undefined, cache: string) {
  if (!p) return res.status(404).json({ error: 'No roads there' });
  res.set('Cache-Control', cache).set('Vary', 'Accept-Encoding').type('application/json');
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) res.set('Content-Encoding', 'gzip').send(p.gzip);
  else res.send(p.json);
}
const FOREVER = 'public, max-age=31536000, immutable';
app.get('/api/roads/meta', async (req, res) => {
  try { sendPiece(req, res, (await getRoadTiles()).meta, 'public, max-age=0, s-maxage=300'); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.get('/api/roads/:version/:part', async (req, res) => {
  try {
    const t = await getRoadTiles();
    if (req.params.version !== t.version) return res.status(409).json({ error: 'Road network updated — reload', version: t.version });
    const part = req.params.part === 'signals' ? t.signals : req.params.part === 'main' ? t.main : undefined;
    sendPiece(req, res, part, FOREVER);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.get('/api/roads/:version/cell/:x/:y', async (req, res) => {
  try {
    const t = await getRoadTiles();
    if (req.params.version !== t.version) return res.status(409).json({ error: 'Road network updated — reload', version: t.version });
    const x = Number(req.params.x), y = Number(req.params.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ error: 'cell x and y must be integers' });
    // An empty cell is cached too (an empty list), so the map doesn't keep asking
    const p = t.cells.get(`${x}_${y}`) ?? EMPTY_CELL;
    sendPiece(req, res, p, FOREVER);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
const EMPTY_CELL: Piece = { json: '{"format":2,"nodes":[],"edges":[]}', gzip: gzipSync('{"format":2,"nodes":[],"edges":[]}') };

// Live map for many viewers: the same for everyone, so Firebase Hosting's CDN serves it
// (s-maxage) and the server builds each piece once per second however many people watch
function sendLive(res: express.Response, json: string | null, cdnSeconds: number) {
  if (!json) return res.status(503).json({ error: 'Simulation engine not running' });
  res.set('Cache-Control', `public, max-age=0, s-maxage=${cdnSeconds}`).type('json').send(json);
}
/** Stats and the versions of the slower parts (signal order, conditions, phases, traffic) */
app.get('/api/live/common', (_req, res) => sendLive(res, commonJson(), 1));
/** [phase index, tenths of a second] per signal, in signal-order/<sv> order */
app.get('/api/live/signals', (_req, res) => sendLive(res, signalsJson(), 2));
/** Signal ids for a signal-state version: fixed for that version, cached for a day */
app.get('/api/live/signal-order/:sv', (req, res) => {
  const json = signalOrderJson(String(req.params.sv));
  if (!json) return res.status(404).json({ error: 'Unknown signal list version' });
  res.set('Cache-Control', 'public, max-age=86400, immutable').type('json').send(json);
});
/** Signals whose phases differ from the cached road data */
app.get('/api/live/phases', (_req, res) => sendLive(res, phasesJson(), 2));
/** Road traffic levels [[edgeId, level], …], and the change since the previous snapshot */
app.get('/api/live/traffic', (_req, res) => sendLive(res, trafficJson(), 3));
app.get('/api/live/traffic-delta', (_req, res) => sendLive(res, trafficDeltaJson(), 3));
/** Vehicles in one ~2 km cell (x = floor(lng / 0.02), y = floor(lat / 0.02)) */
app.get('/api/live/cell/:x/:y', (req, res) => {
  const x = Number(req.params.x), y = Number(req.params.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ error: 'cell x and y must be integers' });
  sendLive(res, cellJson(x, y), 1);
});

// ── Road conditions ──────────────────────────────────────────────────────────

const WEATHER_MODES: WeatherMode[] = ['live', 'clear', 'rain', 'heavy_rain'];
const TRAFFIC_LEVELS: TrafficMode[] = ['auto', 'light', 'normal', 'heavy'];
const REPORT_TYPES: ReportType[] = ['block', 'tree', 'waterlogging', 'rain'];

function sendError(res: express.Response, err: any) {
  res.status(err instanceof NavigationError ? err.status : 500).json({ error: err.message });
}

app.get('/api/conditions', (_req, res) => {
  // Fetched by devices only when the live feed's conditions version changes; the CDN shares it
  res.set('Cache-Control', 'public, max-age=0, s-maxage=2').json(getConditions());
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

app.post('/api/user/start', requireUser, rateLimit('navigation starts', 20, 10 * 60 * 1000), async (req, res) => {
  try {
    const { sourceNodeId, destNodeId, edgeIds, mode, emergency } = req.body;
    const userId = caller(res).uid;
    if (emergency !== undefined && emergency !== null) {
      if (!['ambulance', 'fire', 'police'].includes(emergency)) return res.status(400).json({ error: 'emergency must be ambulance, fire or police' });
      if (caller(res).role !== 'responder' && caller(res).role !== 'controller') return res.status(403).json({ error: 'Only responders can start an emergency run' });
    }
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
    const navigation = await startNavigation(
      { userId, sourceNodeId, destNodeId, edgeIds, mode: mode === 'gps' ? 'gps' : 'simulated', emergency: emergency || undefined }, graph, signals,
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

/** Calls per second one server takes for each of these before asking phones to slow down */
const PACE_BUDGET = Number(process.env.PACE_BUDGET_PER_SEC) || 1500;

app.get('/api/user/:userId/navigation', requireUser, requireSelf, pace(2000, PACE_BUDGET), async (req, res) => {
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
// Phones send at most one fix per 2 s (300 per 10 min)
app.post('/api/user/:userId/position', requireUser, requireSelf, rateLimit('GPS updates', 400, 10 * 60 * 1000), pace(2000, PACE_BUDGET), async (req, res) => {
  try {
    const { lat, lng, speed } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng are required numbers' });
    }
    const { graph, signals } = await getGraph();
    res.json(await updatePosition(String(req.params.userId), lat, lng, typeof speed === 'number' ? speed : undefined, graph, signals));
  } catch (err: any) {
    sendError(res, err);
  }
});

// Accept the reroute offered in the latest navigation update
app.post('/api/user/:userId/reroute', requireUser, requireSelf, async (req, res) => {
  try {
    const { graph, signals } = await getGraph();
    res.json({ routeInfo: await acceptReroute(String(req.params.userId), graph, signals) });
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

// Route options on the server's own graph. `route` (the first option) is kept for older clients.
// ── Junctions: police view and signal control ────────────────────────────────

function sendControlError(res: express.Response, err: any) {
  res.status(err instanceof ControlError || err instanceof RuleError ? err.status : 500).json({ error: err.message });
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
    const id = String(req.params.id);
    // Coordinated: the flow plan (green waves out, spillback guards, feeding greens); otherwise this junction only
    if (coordinate !== false) {
      const { plan, changes } = applyCoordination(id, group, seconds, caller(res).uid);
      return res.json({ changes, plan });
    }
    res.json({ changes: holdGreen(id, group, seconds, caller(res).uid) });
  } catch (err) { sendControlError(res, err); }
});

/** What a coordinated hold would do, without changing anything: { group, seconds } (operators). */
app.post('/api/junctions/:id/coordination', requireUser, requireOperator, (req, res) => {
  try {
    const { group, seconds } = req.body ?? {};
    if (typeof group !== 'string' || typeof seconds !== 'number') {
      return res.status(400).json({ error: 'group (string) and seconds (number) required' });
    }
    res.json(planCoordination(String(req.params.id), group, seconds));
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

// ── Users' files: report photos, profile pictures, documents ────────────────

/** Upload: raw body (image/jpeg, png, webp or PDF, ≤ 5 MB), ?purpose=report-photo|profile|document&name=…&reportId=… */
app.post('/api/files', requireUser, rateLimit('uploads', 30, 10 * 60 * 1000),
  express.raw({ type: Object.keys(FILE_TYPES), limit: MAX_FILE_BYTES }), async (req, res) => {
    const { uid, trusted } = caller(res);
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    const purpose = String(req.query.purpose ?? 'document') as FilePurpose;
    const reportId = req.query.reportId ? String(req.query.reportId) : undefined;
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: `Send the file as the request body (${Object.keys(FILE_TYPES).join(', ')})` });
    if (purpose === 'report-photo' && (!reportId || !canAttachPhoto(reportId, uid, trusted))) {
      return res.status(403).json({ error: 'Only the reporter or an operator can add a photo to that report' });
    }
    try {
      const file = await saveFile(uid, { name: String(req.query.name ?? 'file'), type, purpose, reportId, data: req.body });
      if (purpose === 'report-photo' && reportId) attachPhoto(reportId, file.id);
      res.json({ file });
    } catch (err: any) {
      res.status(err instanceof FileError ? err.status : 500).json({ error: err.message });
    }
  });

/** The caller's files and storage used. */
app.get('/api/files', requireUser, async (_req, res) => {
  try {
    const files = await listFiles(caller(res).uid);
    res.json({ files, usedBytes: files.reduce((t, f) => t + f.size, 0) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/** A file: its owner, or operators for report photos. Never changes, so devices keep it for a year. */
app.get('/api/files/:id', requireUser, async (req, res) => {
  const { uid, trusted } = caller(res);
  try {
    const meta = await getFileMeta(String(req.params.id));
    if (!meta || !(meta.owner === uid || (meta.purpose === 'report-photo' && trusted))) return res.status(404).json({ error: 'No such file' });
    res.set('Cache-Control', 'private, max-age=31536000, immutable').type(meta.type).send(await readFile(meta));
  } catch (err: any) {
    res.status(err instanceof FileError ? err.status : 500).json({ error: err.message });
  }
});

app.delete('/api/files/:id', requireUser, async (req, res) => {
  const { uid, role } = caller(res);
  try {
    const meta = await getFileMeta(String(req.params.id));
    if (!meta || !(meta.owner === uid || role === 'controller')) return res.status(404).json({ error: 'No such file' });
    await deleteFile(meta);
    if (meta.reportId) attachPhoto(meta.reportId, undefined);
    res.json({ deleted: meta.id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/** Operators: the trip model (zones, cached routes, trips started / arrived, demand mix). */
app.get('/api/trips/stats', requireUser, requireOperator, (_req, res) => {
  res.json(tripStats());
});

/** Emergency corridors (operators and responders see them on the map). */
app.get('/api/emergency', requireUser, (req, res) => {
  const { role } = caller(res);
  if (role === 'user') return res.status(403).json({ error: 'Operators and responders only' });
  res.json({ corridors: listCorridors() });
});

/** Controllers: dispatch a simulated ambulance / fire engine / police vehicle. */
app.post('/api/emergency', requireUser, requireController, async (req, res) => {
  const { from, to, kind = 'ambulance' } = req.body ?? {};
  const ok = (p: any) => p && typeof p.lat === 'number' && typeof p.lng === 'number';
  if (!ok(from) || !ok(to)) return res.status(400).json({ error: 'from and to need lat and lng' });
  if (!['ambulance', 'fire', 'police'].includes(kind)) return res.status(400).json({ error: 'kind must be ambulance, fire or police' });
  try {
    res.json({ corridor: await dispatchEmergency(from, to, kind, caller(res).uid) });
  } catch (err: any) {
    res.status(err instanceof EmergencyError ? err.status : 500).json({ error: err.message });
  }
});

app.delete('/api/emergency/:id', requireUser, requireController, (req, res) => {
  if (!cancelCorridor(String(req.params.id), caller(res).uid)) return res.status(404).json({ error: 'No active corridor with that id' });
  res.json({ corridors: listCorridors() });
});

/** Turn rules and turn-based phases: what each approach may do and which movements each phase lets go. */
app.get('/api/junctions/:id/turns', requireUser, requireOperator, (req, res) => {
  const view = turnsView(String(req.params.id));
  if (!view) return res.status(404).json({ error: 'Unknown junction' });
  res.json(view);
});

/** Controllers: set turn rules (and optionally turn-based phases); null phases keep the road-based ones. */
app.put('/api/junctions/:id/turns', requireUser, requireController, (req, res) => {
  const id = String(req.params.id);
  const { approaches, phases } = req.body ?? {};
  if (!Array.isArray(approaches)) return res.status(400).json({ error: 'approaches must be a list' });
  if (phases !== null && phases !== undefined && !Array.isArray(phases)) return res.status(400).json({ error: 'phases must be a list or null' });
  try {
    const { warnings } = setRules(id, { approaches, phases: phases ?? null }, caller(res).uid);
    const v = turnsView(id)!;
    const closed = v.approaches.flatMap(a => a.moves.filter(m => !a.allowed.includes(m.turn)).map(m => `${a.road} from the ${a.from}: no ${m.turn}`));
    recordControl(caller(res).uid, id, 'turn rules', [closed.join(', ') || 'all turns open', phases ? `${phases.length} turn phases` : 'road phases'].join(' · '));
    res.json({ view: v, warnings });
  } catch (err) { sendControlError(res, err); }
});

/** Controllers: back to the default (all turns, road-based phases). */
app.delete('/api/junctions/:id/turns', requireUser, requireController, (req, res) => {
  const id = String(req.params.id);
  if (!turnsView(id)) return res.status(404).json({ error: 'Unknown junction' });
  setRules(id, null, caller(res).uid);
  recordControl(caller(res).uid, id, 'turn rules', 'cleared: all turns open, road phases');
  res.json({ view: turnsView(id), warnings: [] });
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

// Load shedding: when the route workers fall behind, phones plan routes themselves (the app
// has the road network and live traffic colours), so routing capacity grows with the users.
// (Main-thread lag is the simulation's own work; routes don't run there.)
const ROUTE_QUEUE_LIMIT = 4;

app.post('/api/route', requireUser, rateLimit('route requests', 20, 10 * 60 * 1000), async (req, res) => {
  if (routeQueuePerWorker() > ROUTE_QUEUE_LIMIT) {
    return res.status(503).set('Retry-After', '5').json({ error: 'Server busy — planning on your phone', planOnDevice: true });
  }
  try {
    const { sourceId, destId } = req.body;
    // The caller's own route doesn't count as load on itself
    const userId = caller(res).uid;
    if (!sourceId || !destId) {
      return res.status(400).json({ error: 'Missing sourceId or destId' });
    }
    const { graph, signals } = await getGraph();
    const routes = await planRoutes(userId, sourceId, destId, graph, signals);
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
    initTurnRules(getGraphIndex(graph, signals), signals);
    getRoadTiles().catch(() => {}); // serialise once (road tiles + full graph), now that signals carry their directions
    const engine = initSimulationEngine(graph, signals);
    initRouteWorkers(graph, signals); // route searches on the other CPU cores
    initEmergency(graph, signals);
    initTrips(graph, signals, (await getGraph()).places); // every simulated vehicle drives a real trip
    nearestRoadSegment(getGraphIndex(graph, signals), 12.97, 77.59, 1); // build the nearest-road grid now
    engine.setArrivalHandler(markArrived);
    engine.setMovementHandler(recordMovement);
    startCounts();
    await loadSavedRules(); // controllers' turn rules and phases
    loadTripCache().catch(() => {}); // planned trip routes from the last run (no cold start)
    engine.start();
    startWeatherPolling();
    console.log('[WayFinder Server] Simulation engine started');
  } catch (err) {
    console.error('[WayFinder Server] Failed to initialize simulation interface:', err);
  }
}

const server = createServer(app);


server.listen(PORT, () => {
  console.log(`[WayFinder Server] Listening on ${PORT}`);
  initializeServer();

  process.on('SIGTERM', () => process.exit(0));
});
