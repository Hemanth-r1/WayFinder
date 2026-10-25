// Smoke test: end-to-end API checks against a local server in demo mode (no Firebase).
// Start the server (cd server && npm run dev), then: npm run smoke
const BASE = process.env.SMOKE_URL || 'http://localhost:8080';
const RL_USER = 'demo-ratelimit-' + Date.now();
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) pass++; else { fail++; failures.push(`${name} ${detail}`); }
}
const H = (user, role = 'user') => user ? { 'X-Demo-User': user, 'X-Demo-Role': role, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
async function call(method, path, user, role, body) {
  const r = await fetch(BASE + path, { method, headers: H(user, role), body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json, headers: r.headers };
}

(async () => {
  const g = await (await fetch(BASE + '/api/graph')).json();
  const near = (lat, lng) => { let b = null, d = 1e9; for (const n of g.nodes) { const x = Math.hypot(n[1] - lat, n[2] - lng); if (x < d) { d = x; b = n[0]; } } return b; };
  const A = near(13.0297, 77.5388), B = near(13.01, 77.57), C = near(12.97, 77.6);
  const junction = 'J5HVHATD';

  // 1. Roles: who may call what
  const matrix = [
    ['POST', '/api/conditions/weather', { mode: 'live' }, { none: 401, user: 403, supporter: 200, controller: 200 }],
    ['POST', '/api/conditions/behaviour', { wrongWay: true }, { none: 401, user: 403, supporter: 200, controller: 200 }],
    ['GET', '/api/junctions', null, { none: 401, user: 403, supporter: 200, controller: 200 }],
    ['POST', `/api/junctions/${junction}/reset`, {}, { none: 401, user: 403, supporter: 403, controller: 200 }],
    ['GET', '/api/jams', null, { none: 401, user: 403, supporter: 200, controller: 200 }],
    ['POST', '/api/jams', { lat: 'x' }, { none: 401, user: 403, supporter: 403, controller: 400 }],
    ['GET', '/api/control/log', null, { none: 401, user: 403, supporter: 200, controller: 200 }],
    ['GET', '/api/counts.csv?hours=1', null, { none: 401, user: 403, supporter: 200, controller: 200 }],
    ['POST', '/api/route', { sourceId: A, destId: B }, { none: 401 }],
    ['GET', '/api/me', null, { none: 401, user: 200 }],
  ];
  for (const [m, p, body, expect] of matrix) {
    for (const [role, code] of Object.entries(expect)) {
      const r = await call(m, p, role === 'none' ? null : `demo-role-${role}`, role === 'none' ? undefined : role, body);
      check(`${m} ${p} as ${role}`, r.status === code, `→ ${r.status}, expected ${code}`);
    }
  }
  // Removed endpoints
  for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/vehicles'], ['GET', '/api/signals'], ['POST', '/api/congestion'], ['POST', '/api/sla'], ['POST', '/api/corridors']]) {
    check(`${m} ${p} removed`, (await call(m, p)).status === 404);
  }

  // 2. Live endpoints
  const common = await call('GET', '/api/live/common');
  check('live/common ok', common.status === 200 && common.json?.signalStates && common.json?.stats, `→ ${common.status}`);
  check('live/common CDN header', /s-maxage=1/.test(common.headers.get('cache-control') ?? ''));
  const traffic = await call('GET', '/api/live/traffic');
  check('live/traffic is a list', traffic.status === 200 && Array.isArray(traffic.json));
  const [cx, cy] = [Math.floor(77.5388 / 0.02), Math.floor(13.0297 / 0.02)];
  const cell = await call('GET', `/api/live/cell/${cx}/${cy}`);
  check('live/cell compact arrays', cell.status === 200 && Array.isArray(cell.json) && (cell.json.length === 0 || (Array.isArray(cell.json[0]) && cell.json[0].length === 7)), JSON.stringify(cell.json?.[0]));
  check('live/cell bad coords → 400', (await call('GET', '/api/live/cell/a/1')).status === 400);
  check('live/cell far outside → empty', JSON.stringify((await call('GET', '/api/live/cell/0/0')).json) === '[]');

  // 2b. Road tiles (the map loads only the roads in view)
  const meta = await call('GET', '/api/roads/meta');
  check('roads/meta has version', meta.status === 200 && typeof meta.json?.version === 'string');
  const roadsV = meta.json?.version;
  const main = await call('GET', `/api/roads/${roadsV}/main`);
  check('roads/main: main roads with one-way flag', main.status === 200 && main.json.edges.length > 1000 && main.json.edges[0].length === 11);
  check('roads/main cached for good', /immutable/.test(main.headers.get('cache-control') ?? ''));
  const rcell = await call('GET', `/api/roads/${roadsV}/cell/${cx}/${cy}`);
  check('roads/cell has roads', rcell.status === 200 && rcell.json.edges.length > 10 && rcell.json.nodes.length > 10);
  check('roads/cell outside city → empty', (await call('GET', `/api/roads/${roadsV}/cell/0/0`)).json?.edges?.length === 0);
  check('roads: old version → 409', (await call('GET', '/api/roads/oldversion/main')).status === 409);
  check('roads/signals', ((await call('GET', `/api/roads/${roadsV}/signals`)).json ?? []).length > 100);

  // 3. Routes
  let route; for (let i = 0; i < 5; i++) { route = await call('POST', '/api/route', 'demo-route', 'user', { sourceId: A, destId: B }); if (route.status !== 503) break; check('route: busy answer says plan on device', route.json?.planOnDevice === true); await new Promise(r => setTimeout(r, 1500)); }
  check('route: options', route.status === 200 && route.json.routes.length >= 1, `→ ${route.status} ${JSON.stringify(route.json)?.slice(0, 120)}`);
  const r0 = route.json?.routes?.[0];
  check('route: connected edges from A to B', r0 && r0.path[0] === A && r0.path[r0.path.length - 1] === B && r0.edgeIds.length === r0.path.length - 1);
  check('route: sorted by ETA', route.json?.routes?.every((r, i, a) => i === 0 || a[i - 1].estimatedTime <= r.estimatedTime));
  check('route: unknown node → 400', (await call('POST', '/api/route', 'demo-route', 'user', { sourceId: 'nope', destId: B })).status === 400);
  check('route: missing fields → 400', (await call('POST', '/api/route', 'demo-route', 'user', {})).status === 400);
  let limited = 0;
  for (let i = 0; i < 22; i++) if ((await call('POST', '/api/route', RL_USER, 'user', { sourceId: A, destId: C })).status === 429) limited++;
  check('route: rate limit after 20', limited === 2, `${limited} of 22 limited`);

  // 4. Navigation lifecycle + privacy
  const u = 'demo-nav-test';
  const start = await call('POST', '/api/user/start', u, 'user', { sourceNodeId: A, destNodeId: B, edgeIds: r0.edgeIds });
  check('nav: start uses chosen route', start.status === 200 && start.json.routeInfo.edgeIds.join() === r0.edgeIds.join(), `→ ${start.status}`);
  check('nav: vehicleId is anonymous', /^nav_[0-9a-f]{12}$/.test(start.json?.vehicleId ?? ''));
  const nav = await call('GET', `/api/user/${u}/navigation`, u, 'user');
  check('nav: update + pace header', nav.status === 200 && nav.headers.get('x-next-ms') === '2000', `→ ${nav.status} ${nav.headers.get('x-next-ms')}`);
  check('nav: other user forbidden', (await call('GET', `/api/user/${u}/navigation`, 'demo-intruder', 'user')).status === 403);
  check('nav: other user cannot stop it', (await call('DELETE', `/api/user/${u}`, 'demo-intruder', 'user')).status === 403);
  const pos = await call('POST', `/api/user/${u}/position`, u, 'user', { lat: 13.0297, lng: 77.5388, speed: 20 });
  check('nav: GPS fix accepted', pos.status === 200 && typeof pos.json.onRoute === 'boolean', `→ ${pos.status} ${JSON.stringify(pos.json)}`);
  check('nav: GPS bad body → 400', (await call('POST', `/api/user/${u}/position`, u, 'user', { lat: 'x' })).status === 400);
  await new Promise(r => setTimeout(r, 1200));
  let feed = ''; for (let x = Math.floor(77.50 / 0.02); x <= Math.floor(77.60 / 0.02); x++) for (let y = Math.floor(12.99 / 0.02); y <= Math.floor(13.05 / 0.02); y++) feed += await (await fetch(`${BASE}/api/live/cell/${x}/${y}`)).text();
  check('privacy: no uid in feed', !feed.includes(u));
  check('privacy: own car in feed by anonymous id', feed.includes(start.json.vehicleId));
  check('nav: stop', (await call('DELETE', `/api/user/${u}`, u, 'user')).status === 200);
  check('nav: gone after stop', (await call('GET', `/api/user/${u}/navigation`, u, 'user')).status === 404);

  // 5. Reports
  const rep = await call('POST', '/api/reports', 'demo-rep1', 'user', { type: 'block', lat: 13.0297, lng: 77.5388 });
  check('report: created', rep.status === 200 && rep.json.report?.status === 'unconfirmed', `→ ${rep.status} ${JSON.stringify(rep.json)?.slice(0, 100)}`);
  const id = rep.json?.report?.id;
  const v = await call('POST', `/api/reports/${id}/vote`, 'demo-rep2', 'user', { vote: 'confirm' });
  check('report: 2nd person confirms', v.status === 200 && v.json.report?.status === 'confirmed', `→ ${v.status} ${JSON.stringify(v.json)?.slice(0, 100)}`);
  check('report: bad type → 400', (await call('POST', '/api/reports', 'demo-rep1', 'user', { type: 'alien', lat: 13, lng: 77.5 })).status === 400);
  check('report: user cannot remove others', [403, 404].includes((await call('DELETE', `/api/reports/${id}`, 'demo-rep3', 'user')).status));
  check('report: operator removes', (await call('DELETE', `/api/reports/${id}`, 'demo-op', 'controller')).status === 200);

  // 6. Signals: plan bounds, hold, reset, timing structure
  const det = await call('GET', `/api/junctions/${junction}`, 'demo-op', 'controller');
  const ph = det.json?.phases ?? [];
  check('signal: has amber and all-red phases', ph.some(p => p.color === 'YELLOW') && ph.some(p => p.group === 'ALL'));
  check('signal: amber 3–4 s, all-red 2–5 s', ph.filter(p => p.color === 'YELLOW').every(p => p.duration >= 3 && p.duration <= 4) && ph.filter(p => p.group === 'ALL' && p.duration <= 6).every(p => p.duration >= 2 && p.duration <= 5));
  check('signal: recommended cycle = greens + lost time', det.json?.recommendation && det.json.recommendation.cycle > 0);
  const plan = await call('POST', `/api/junctions/${junction}/plan`, 'demo-op', 'controller', { greens: { A: 9999, B: 1 } });
  check('signal: plan accepted', plan.status === 200);
  const det2 = await call('GET', `/api/junctions/${junction}`, 'demo-op', 'controller');
  const greens = det2.json?.greens ?? {};
  check('signal: plan clamped to 10–180 s', greens.A === 180 && greens.B === 10, JSON.stringify(greens));
  check('signal: plan with text → 400', (await call('POST', `/api/junctions/${junction}/plan`, 'demo-op', 'controller', { greens: { A: 'x' } })).status === 400);
  const hold = await call('POST', `/api/junctions/${junction}/hold`, 'demo-op', 'controller', { group: 'A', seconds: 30 });
  check('signal: hold', hold.status === 200 && Array.isArray(hold.json.changes), `→ ${hold.status}`);
  check('signal: hold unknown junction → 404', (await call('POST', '/api/junctions/JNOPE/hold', 'demo-op', 'controller', { group: 'A', seconds: 30 })).status === 404);
  check('signal: reset', (await call('POST', `/api/junctions/${junction}/reset`, 'demo-op', 'controller')).status === 200);
  check('signal: control log records it', ((await call('GET', '/api/control/log', 'demo-op', 'controller')).json?.log ?? []).length >= 2);

  // 7. Jams
  const jam = await call('POST', '/api/jams', 'demo-op', 'controller', { lat: 12.9352, lng: 77.6245, severity: 'slow', metres: 200, minutes: 1 });
  check('jam: created', jam.status === 200 && jam.json.jam?.vehicles > 0, `→ ${jam.status} ${JSON.stringify(jam.json)?.slice(0, 120)}`);
  check('jam: in sea → 400', (await call('POST', '/api/jams', 'demo-op', 'controller', { lat: 10, lng: 70 })).status === 400);
  check('jam: removed', (await call('DELETE', `/api/jams/${jam.json?.jam?.id}`, 'demo-op', 'controller')).status === 200);

  // 8. Turn rules: close one turn, read it back, clear
  const tv = await call('GET', `/api/junctions/${junction}/turns`, 'demo-op', 'controller');
  check('turns: movements listed', tv.status === 200 && tv.json.approaches?.length > 0 && tv.json.approaches.every(a => Array.isArray(a.moves) && Array.isArray(a.mapClosed)), `→ ${tv.status}`);
  const a0 = tv.json?.approaches?.[0];
  const closeTurn = a0?.allowed.find(t => t !== 'straight') ?? a0?.allowed[0];
  const rules = (tv.json?.approaches ?? []).map(a => ({ edgeId: a.edgeId, allowed: a.edgeId === a0.edgeId ? a.allowed.filter(t => t !== closeTurn) : a.allowed, freeLeft: false }));
  const put = await call('PUT', `/api/junctions/${junction}/turns`, 'demo-op', 'controller', { approaches: rules, phases: null });
  check('turns: closed turn saved and read back', put.status === 200 && !put.json.view.approaches[0].allowed.includes(closeTurn), `→ ${put.status} ${JSON.stringify(put.json)?.slice(0, 120)}`);
  check('turns: users cannot change them', (await call('PUT', `/api/junctions/${junction}/turns`, 'demo-u9', 'user', { approaches: rules, phases: null })).status === 403);
  check('turns: unknown turn → 400', (await call('PUT', `/api/junctions/${junction}/turns`, 'demo-op', 'controller', { approaches: [{ edgeId: a0?.edgeId, allowed: ['sideways'], freeLeft: false }], phases: null })).status === 400);
  check('turns: cleared', (await call('DELETE', `/api/junctions/${junction}/turns`, 'demo-op', 'controller')).status === 200);

  // 9. Emergency runs
  const em = await call('POST', '/api/emergency', 'demo-op', 'controller', { from: { lat: 13.0405, lng: 77.5185 }, to: { lat: 13.0225, lng: 77.5545 } });
  check('emergency: dispatched with signals on its way', em.status === 200 && em.json.corridor?.signals?.length > 0, `→ ${em.status} ${JSON.stringify(em.json)?.slice(0, 120)}`);
  check('emergency: users cannot dispatch', (await call('POST', '/api/emergency', 'demo-u9', 'user', { from: { lat: 13.04, lng: 77.52 }, to: { lat: 13.02, lng: 77.55 } })).status === 403);
  const emRoute = em.json?.corridor?.route ?? [];
  check('emergency: normal user cannot start an emergency trip', emRoute.length > 1 && (await call('POST', '/api/user/start', 'demo-u9', 'user', { sourceNodeId: emRoute[0].split('-')[0], destNodeId: emRoute[emRoute.length - 1].split('-')[1], emergency: 'ambulance' })).status === 403);
  check('emergency: listed for operators', ((await call('GET', '/api/emergency', 'demo-op', 'controller')).json?.corridors ?? []).some(c => c.id === em.json?.corridor?.id));
  check('emergency: cancelled', (await call('DELETE', `/api/emergency/${em.json?.corridor?.id}`, 'demo-op', 'controller')).status === 200);

  // 10. Trip model
  const ts = await call('GET', '/api/trips/stats', 'demo-op', 'controller');
  check('trips: zones and demand mix', ts.status === 200 && ts.json.zones > 100 && Math.abs(Object.values(ts.json.mix).reduce((t, v) => t + v, 0) - 1) < 0.01, `→ ${ts.status}`);
  check('trips: users cannot read stats', (await call('GET', '/api/trips/stats', 'demo-u9', 'user')).status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
