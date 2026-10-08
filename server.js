'use strict';
// FOGLINE server. Zero dependencies, runs entirely on a closed local network:
// one laptop serves, the rest join over WiFi. Nothing leaves the room.
//
// Who may see what is decided here, at the one boundary every request crosses:
// the instructor holds a token, each commander a four-digit seat code. While an
// exercise is running, nothing that carries the truth leaves without the token.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Game, PIDS, SCENARIOS } = require('./engine/sim');
const { ProfileStore } = require('./engine/profile');
const { buildReport } = require('./engine/aar');

const PORT = +process.env.PORT || 3000;
const TICK_MS = 200;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const PAGES = {
  '/': 'index.html', '/trainee': 'trainee.html', '/instructor': 'instructor.html', '/report': 'report.html',
  '/replay': 'replay.html',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sse = (res, event, data) => {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
};
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const download = (res, name, type, body) => {
  res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.end(body);
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = '', over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > 2e5) { over = true; resolve(null); } });
    req.on('end', () => { if (over) return; try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Constant-time, and safe on secrets of different lengths (timingSafeEqual throws on those).
function sameSecret(given, real) {
  const a = Buffer.from(String(given == null ? '' : given)), b = Buffer.from(String(real == null ? '' : real));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseSeats(spec) {
  if (!spec) return null;
  const out = {};
  for (const part of String(spec).split(',')) {
    const [pid, code] = part.split(':').map((s) => s && s.trim());
    if (PIDS.includes(pid) && /^\d{4}$/.test(code || '')) out[pid] = code;
  }
  return PIDS.every((p) => out[p]) ? out : null;
}

const safeId = (s) => /^[A-Za-z0-9._-]{1,120}$/.test(s) && !s.includes('..');
const lite = (aar, instructor) => {
  const { replay, ...rest } = aar;
  if (!instructor) delete rest.profiles0;       // other people's records: the red cell's targeting data
  return rest;
};

// ---------------------------------------------------------------------------
// CSV export — one row per decision, then the event log
// ---------------------------------------------------------------------------
function aarCsv(aar) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const toMin = (t) => (t == null ? '' : Math.round((t * aar.timeScale / 60) * 10) / 10);
  const rows = [];
  rows.push(['FOGLINE AFTER ACTION REVIEW']);
  rows.push(['Scenario', aar.scenario.name, 'Mission window', `${aar.startClock}-${aar.endClock}`, 'Ended', aar.endReason, 'Seed', aar.seedHex || '']);
  rows.push(['COST OF FOG']);
  rows.push(['Awareness delay vs clear comms (min)', aar.costOfFog.reactionDelayMin]);
  rows.push(['Threats never seen', aar.costOfFog.threatsNeverSeen]);
  rows.push(['Blind casualties (HP)', aar.costOfFog.blindHp, 'of total', aar.costOfFog.totalHp, '%', aar.costOfFog.blindPct]);
  rows.push(['Wasted rounds', aar.costOfFog.wastedRounds, 'Phantom actions', aar.costOfFog.phantomActions]);
  rows.push(['Deceptions succeeded', aar.costOfFog.deceptionsSucceeded, 'rejected', aar.costOfFog.deceptionsRejected]);
  rows.push(['Forged orders obeyed', aar.costOfFog.forgedOrdersObeyed, 'False-BDA ambushes', aar.costOfFog.falseBdaAmbushes]);
  rows.push(['Mission command score (team)', aar.missionCommand.teamScore]);
  rows.push([]);
  rows.push(['PER COMMANDER']);
  rows.push(['callsign', 'unit', 'hp_left', 'decisions', 'mean_reaction_min', 'reaction_clear_min', 'reaction_degraded_min',
    'mean_picture_pct', 'worst_picture_pct', 'fog_delay_min', 'threats_never_seen', 'hp_lost', 'blind_hp_lost',
    'wasted_rounds', 'phantom_actions', 'msgs_sent', 'msgs_lost', 'msgs_garbled', 'mean_delay_min', 'worst_delay_min',
    'jammed_min', 'isolated_min', 'manoeuvred_out', 'coverage_pct', 'breaches', 'drift_orders', 'initiative_pct',
    'forged_obeyed', 'conflicts', 'conflicts_resolved', 'mission_command_score']);
  for (const pid of Object.keys(aar.players)) {
    const P = aar.players[pid], M = P.missionCommand;
    rows.push([pid, P.name, P.hp, P.decisions, P.meanLatencyMin, P.latencyClearMin, P.latencyDegradedMin,
      P.meanAccuracy, P.minAccuracy, P.fogMin, P.threats.filter((t) => t.never).length, P.hpLost, P.blindHpLost,
      P.wastedRounds, P.phantomActions, P.comms.sent, P.comms.dropped, P.comms.garbled, P.comms.meanDelayMin, P.comms.worstDelayMin,
      P.ew.jammedMin, P.ew.isolatedMin, P.ew.manoeuvredOut, M.coveragePct, M.breaches, M.driftOrders, M.initiativePct,
      M.compliedWithForgedOrder, P.conflicts.total, P.conflicts.resolved, M.score]);
  }
  rows.push([]);
  rows.push(['DECISION LOG']);
  rows.push(['mission_time', 'callsign', 'type', 'decision', 'rationale', 'basis_track', 'comms_degraded', 'link_severity', 'picture_accuracy_pct', 'reaction_min', 'on_phantom', 'request_lost']);
  for (const d of aar.decisions) rows.push([d.clock, d.pid, d.type, d.desc, d.rationale, d.ref, d.degraded, d.severity, d.accuracy, toMin(d.latency), d.onPhantom, d.lost]);
  rows.push([]);
  rows.push(['RED CELL ACTIONS']);
  rows.push(['mission_time', 'mode', 'rule', 'target', 'action', 'reasoning']);
  for (const l of aar.redcell.log) rows.push([l.clock, l.mode, l.rule, l.pid, l.label, l.reason]);
  rows.push([]);
  rows.push(['EXERCISE EVENTS']);
  rows.push(['mission_time', 'kind', 'callsign', 'event']);
  for (const e of aar.events) rows.push([e.clock, e.kind, e.pid || '', e.text]);
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

// ---------------------------------------------------------------------------
// The app: one game, its clients, its routes. `node server.js` builds one and
// listens; the tests build one on a spare port and drive it.
// ---------------------------------------------------------------------------
function createApp(opts = {}) {
  const aarDir = opts.aarDir || path.join(__dirname, 'aar');
  const indexFile = path.join(aarDir, 'index.json');
  const profiles = opts.profiles || new ProfileStore(path.join(aarDir, 'profiles.json'));
  const token = opts.token || process.env.INSTRUCTOR_TOKEN || crypto.randomBytes(16).toString('hex');
  const seats = opts.seats || parseSeats(process.env.SEAT_CODES)
    || Object.fromEntries(PIDS.map((p) => [p, String(crypto.randomInt(1000, 10000))]));
  const app = {
    token, seats, profiles, aarDir,
    game: opts.game || new Game(opts.scenario || 'CONTESTED', {}, { profiles }),
    clients: new Set(),
  };
  let clientSeq = 0, wasEnded = false, timer = null;

  const isInstructor = (req, url, body) => sameSecret(
    url.searchParams.get('token') || req.headers['x-fogline-token'] || (body && body.token), token);
  const seatOk = (pid, seat) => PIDS.includes(pid) && sameSecret(seat, seats[pid]);
  const live = () => app.game.status === 'RUNNING' || app.game.status === 'PAUSED';

  function getAar() {
    const g = app.game;
    if (g.aar) return g.aar;
    if (g.status === 'LOBBY') return null;
    return buildReport(g);   // mid-exercise: a provisional report, so the instructor can look early
  }

  function readIndex() {
    try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return []; }
  }
  function writeAtomic(file, text) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
  function saveAar(aar) {
    try {
      fs.mkdirSync(aarDir, { recursive: true });
      const id = `${aar.generatedAt.replace(/[:.]/g, '-')}-${aar.scenario.id}.json`;
      writeAtomic(path.join(aarDir, id), JSON.stringify(aar));
      const idx = readIndex();
      idx.unshift({
        id, generatedAt: aar.generatedAt, scenario: aar.scenario.id, scenarioName: aar.scenario.name,
        seed: aar.seed, seedHex: aar.seedHex, cfg0: aar.cfg0,
        endReason: aar.endReason, durationMin: aar.durationMin,
        fogMin: aar.costOfFog.reactionDelayMin, blindPct: aar.costOfFog.blindPct,
        blindHp: aar.costOfFog.blindHp, wastedRounds: aar.costOfFog.wastedRounds,
        phantomActions: aar.costOfFog.phantomActions, deceptionsSucceeded: aar.costOfFog.deceptionsSucceeded,
        forgedOrdersObeyed: aar.costOfFog.forgedOrdersObeyed,
        mcScore: aar.missionCommand.teamScore, copMeanPct: aar.team.copMeanPct,
        objectiveHeld: aar.outcome.objectiveHeld, enemiesKilled: aar.outcome.enemiesKilled,
        enemiesTotal: aar.outcome.enemiesTotal, friendlyAlive: aar.outcome.friendlyAlive,
        redcell: aar.redcell.mode, names: Object.values(aar.players).map((P) => P.judgement && P.judgement.who),
      });
      writeAtomic(indexFile, JSON.stringify(idx.slice(0, 200), null, 2));
      if (!opts.quiet) console.log('  AAR saved →', path.join(path.basename(aarDir), id));
      return id;
    } catch (e) { console.error('  AAR save failed:', e.message); return null; }
  }
  function loadRun(id) {
    if (!safeId(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(aarDir, id), 'utf8')); } catch { return null; }
  }
  app.loadRun = loadRun;
  app.readIndex = readIndex;

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    const p = url.pathname;
    const game = app.game;

    // ---- event stream ----
    if (p === '/events') {
      const role = url.searchParams.get('role') === 'instructor' ? 'instructor' : 'trainee';
      const pid = url.searchParams.get('pid');
      if (role === 'instructor' && !isInstructor(req, url)) return json(res, 401, { error: 'instructor token required' });
      if (role === 'trainee' && !PIDS.includes(pid)) return json(res, 400, { error: 'unknown callsign' });
      if (role === 'trainee' && !seatOk(pid, url.searchParams.get('seat')) && !isInstructor(req, url)) {
        return json(res, 401, { error: 'seat code required' });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1000\n\n');
      const client = { res, role, pid, id: ++clientSeq };
      app.clients.add(client);
      if (role === 'trainee') sse(res, 'history', game.inbox[pid].slice(-80));
      else sse(res, 'history', { events: game.events.slice(-120), decisions: game.decisions.slice(-120) });
      req.on('close', () => app.clients.delete(client));
      req.on('error', () => app.clients.delete(client));
      return;
    }

    // ---- trainee + instructor actions ----
    if (p === '/api/action' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b) return json(res, 413, { error: 'too large' });
      const { token: _t, seat, ...a } = b;           // credentials stop here: they never reach the log
      if (!seatOk(a.pid, seat) && !isInstructor(req, url, b)) return json(res, 401, { error: 'seat code required' });
      try { return json(res, 200, game.traineeResult(game.action(a.pid, a))); }
      catch (e) { console.error('action error:', e.stack); return json(res, 500, { error: 'internal error' }); }
    }
    if (p === '/api/admin' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b) return json(res, 413, { error: 'too large' });
      if (!isInstructor(req, url, b)) return json(res, 401, { error: 'instructor token required' });
      const { token: _t, seat: _s, ...a } = b;
      if (a.type === 'reset' && live()) return json(res, 400, { error: 'End the exercise before resetting' });
      try { return json(res, 200, game.admin(a)); }
      catch (e) { console.error('admin error:', e.stack); return json(res, 500, { error: 'internal error' }); }
    }

    // ---- exercise data: the truth, so the instructor's alone while it runs ----
    const truthRoute = ['/api/aar', '/api/aar.json', '/api/aar.csv', '/api/replay', '/api/runs', '/api/compare'].includes(p) || p.startsWith('/api/run/');
    const instructor = isInstructor(req, url);
    if (truthRoute && live() && !instructor) return json(res, 401, { error: 'the exercise is running — this opens at ENDEX' });

    if (p === '/api/scenarios') {
      const out = { scenarios: SCENARIOS.map((s) => ({ id: s.id, name: s.name, brief: s.brief })), current: game.scenario.id };
      if (instructor) out.config = game.cfg;
      return json(res, 200, out);
    }
    if (p === '/api/aar') {
      const a = getAar();
      if (!a) return json(res, 404, { error: 'No exercise data yet — run an exercise first.' });
      return json(res, 200, lite(a, instructor));
    }
    if (p === '/api/replay') {
      const id = url.searchParams.get('run');
      if (id) {
        const run = loadRun(id);
        if (!run || !run.replay) return json(res, 404, { error: 'run not found' });
        return json(res, 200, { replay: run.replay, aar: lite(run, instructor) });
      }
      const a = getAar();
      if (!a) return json(res, 404, { error: 'No exercise data yet' });
      return json(res, 200, { replay: a.replay, aar: lite(a, instructor) });
    }
    if (p === '/api/aar.json') {
      const a = getAar();
      if (!a) return json(res, 404, { error: 'No exercise data yet' });
      return download(res, `fogline-aar-${a.scenario.id}.json`, 'application/json', JSON.stringify(lite(a, instructor), null, 2));
    }
    if (p === '/api/aar.csv') {
      const a = getAar();
      if (!a) return json(res, 404, { error: 'No exercise data yet' });
      return download(res, `fogline-aar-${a.scenario.id}.csv`, 'text/csv; charset=utf-8', '﻿' + aarCsv(a));
    }

    // ---- saved runs, and comparing two of them ----
    if (p === '/api/runs') return json(res, 200, { runs: readIndex() });
    if (p.startsWith('/api/run/')) {
      let id;
      try { id = decodeURIComponent(p.slice('/api/run/'.length)); } catch { return json(res, 400, { error: 'bad run id' }); }
      const run = loadRun(id);
      if (!run) return json(res, 404, { error: 'run not found' });
      if (url.searchParams.get('csv')) return download(res, `fogline-${id}.csv`, 'text/csv; charset=utf-8', '﻿' + aarCsv(run));
      return json(res, 200, lite(run, instructor));
    }
    if (p === '/api/compare') {
      const A = url.searchParams.get('a') === 'current' ? getAar() : loadRun(url.searchParams.get('a'));
      const B = url.searchParams.get('b') === 'current' ? getAar() : loadRun(url.searchParams.get('b'));
      if (!A || !B) return json(res, 404, { error: 'need two runs to compare' });
      const pick = (x) => ({
        label: x.scenario.name, id: x.scenario.id, generatedAt: x.generatedAt, durationMin: x.durationMin,
        redcell: x.redcell.mode, costOfFog: x.costOfFog, outcome: x.outcome, seedHex: x.seedHex || null,
        mcScore: x.missionCommand.teamScore, team: { copMeanPct: x.team.copMeanPct, copWorstPct: x.team.copWorstPct, fratricide: x.team.fratricide, mutualSupport: x.team.mutualSupport },
        players: Object.fromEntries(Object.entries(x.players).map(([k, P]) => [k, {
          hp: P.hp, meanAccuracy: P.meanAccuracy, fogMin: P.fogMin, blindHpLost: P.blindHpLost,
          meanLatencyMin: P.meanLatencyMin, mcScore: P.missionCommand.score, jammedMin: P.ew.jammedMin,
        }])),
      });
      return json(res, 200, { a: pick(A), b: pick(B), comparable: A.scenario.id === B.scenario.id });
    }

    if (p === '/api/profiles') {
      if (!instructor) return json(res, 401, { error: 'instructor token required' });
      return json(res, 200, { profiles: profiles.list() });
    }

    if (p === '/api/clients') {
      const online = {};
      for (const c of app.clients) if (c.role === 'trainee') online[c.pid] = (online[c.pid] || 0) + 1;
      return json(res, 200, { online, instructors: [...app.clients].filter((c) => c.role === 'instructor').length });
    }

    // ---- static ----
    const rel = PAGES[p] || p.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  app.server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('request failed:', e && e.stack);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else try { res.end(); } catch { /* gone */ }
    });
  });

  // ---- simulation loop + push ----
  app.tick = function tick() {
    const game = app.game;
    try { game.tick(TICK_MS / 1000); } catch (e) { console.error('tick failed:', e.stack); }

    if (game.status === 'ENDED' && !wasEnded && game.aar) app.lastSaved = saveAar(game.aar);
    wasEnded = game.status === 'ENDED';

    // queued one-off events first
    const out = game.outbox;
    game.outbox = [];
    for (const o of out) {
      for (const c of app.clients) {
        const match = o.to === 'all'
          || (o.to === 'instructor' && c.role === 'instructor')
          || (c.role === 'trainee' && c.pid === o.to);
        if (match) sse(c.res, o.event, o.data);
      }
    }

    // then one state snapshot per distinct viewer
    let iv = null;
    const tv = {};
    const seated = {};
    for (const c of app.clients) if (c.role === 'trainee') seated[c.pid] = (seated[c.pid] || 0) + 1;
    for (const c of app.clients) {
      if (c.role === 'instructor') {
        if (!iv) { iv = game.instructorView(); iv.seats = seated; iv.online = seated; }
        sse(c.res, 'state', iv);
      } else {
        if (!tv[c.pid]) { tv[c.pid] = game.traineeView(c.pid); tv[c.pid].seats = seated; }
        sse(c.res, 'state', tv[c.pid]);
      }
    }
  };
  // a different game in the same seat (restart from a moment): every screen reloads onto it
  app.swap = function swap(g) {
    app.game = g;
    wasEnded = g.status === 'ENDED';
    for (const c of app.clients) sse(c.res, 'reload', { reason: 'restarted' });
  };
  app.start = () => { if (!timer) timer = setInterval(app.tick, TICK_MS); return app; };
  app.stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const c of app.clients) { try { c.res.end(); } catch { /* gone */ } }
    app.clients.clear();
  };
  app.saveAar = saveAar;
  return app;
}

module.exports = { createApp, aarCsv, sameSecret, parseSeats };

if (require.main === module) {
  const app = createApp().start();
  app.server.listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    const host = ips[0] || 'localhost';
    const line = (l, u) => console.log(`    ${l.padEnd(12)} ${u}`);
    console.log('\n  \x1b[32mFOGLINE\x1b[0m — decision trainer for degraded communications');
    console.log(`  instructor token: \x1b[33m${app.token}\x1b[0m`);
    console.log(`  seat codes:       ${PIDS.map((p) => `${p} \x1b[33m${app.seats[p]}\x1b[0m`).join('   ')}`);
    console.log(`  scenario: ${app.game.scenario.name}\n`);
    line('INSTRUCTOR', `http://${host}:${PORT}/instructor?token=${app.token}`);
    for (const pid of PIDS) line(pid, `http://${host}:${PORT}/trainee?pid=${pid}&seat=${app.seats[pid]}`);
    line('REPLAY', `http://${host}:${PORT}/replay`);
    line('REPORT', `http://${host}:${PORT}/report`);
    if (ips.length > 1) console.log(`\n  other addresses: ${ips.slice(1).join(', ')}`);
    console.log(`\n  localhost: http://localhost:${PORT}\n`);
  });
  process.on('SIGINT', () => { console.log('\n  stopping\n'); process.exit(0); });
}
