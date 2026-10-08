'use strict';
// FOGLINE server. Zero dependencies, runs entirely on a closed local network:
// one laptop serves, the rest join over WiFi. Nothing leaves the room.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Game, PIDS, SCENARIOS } = require('./engine/sim');
const { ProfileStore } = require('./engine/profile');

const PORT = +process.env.PORT || 3000;
const TICK_MS = 200;
const PUBLIC = path.join(__dirname, 'public');
const AAR_DIR = path.join(__dirname, 'aar');
const INDEX_FILE = path.join(AAR_DIR, 'index.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const PAGES = { '/': 'index.html', '/trainee': 'trainee.html', '/instructor': 'instructor.html', '/report': 'report.html', '/replay': 'replay.html' };

const profiles = new ProfileStore(path.join(__dirname, 'aar', 'profiles.json'));
const game = new Game('CONTESTED', {}, { profiles });
const clients = new Set();     // { res, role, pid, id }
let clientSeq = 0;

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
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Report without the replay frames — the report page does not need them.
const lite = (aar) => { const { replay, ...rest } = aar; return rest; };
const { buildReport } = require('./engine/aar');
function getAar() {
  if (game.aar) return game.aar;
  if (game.status === 'LOBBY') return null;
  return buildReport(game);   // mid-exercise: a provisional report, so the instructor can look early
}

// ---------------------------------------------------------------------------
// AAR persistence + run index (for comparing two runs of the same mission)
// ---------------------------------------------------------------------------
const safeId = (s) => /^[A-Za-z0-9._-]{1,120}$/.test(s) && !s.includes('..');

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return []; }
}

function saveAar(aar) {
  try {
    fs.mkdirSync(AAR_DIR, { recursive: true });
    const id = `${aar.generatedAt.replace(/[:.]/g, '-')}-${aar.scenario.id}.json`;
    fs.writeFileSync(path.join(AAR_DIR, id), JSON.stringify(aar));
    const idx = readIndex();
    idx.unshift({
      id, generatedAt: aar.generatedAt, scenario: aar.scenario.id, scenarioName: aar.scenario.name,
      endReason: aar.endReason, durationMin: aar.durationMin,
      fogMin: aar.costOfFog.reactionDelayMin, blindPct: aar.costOfFog.blindPct,
      blindHp: aar.costOfFog.blindHp, wastedRounds: aar.costOfFog.wastedRounds,
      phantomActions: aar.costOfFog.phantomActions, deceptionsSucceeded: aar.costOfFog.deceptionsSucceeded,
      forgedOrdersObeyed: aar.costOfFog.forgedOrdersObeyed,
      mcScore: aar.missionCommand.teamScore, copMeanPct: aar.team.copMeanPct,
      objectiveHeld: aar.outcome.objectiveHeld, enemiesKilled: aar.outcome.enemiesKilled,
      enemiesTotal: aar.outcome.enemiesTotal, friendlyAlive: aar.outcome.friendlyAlive,
      redcell: aar.redcell.mode,
    });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(idx.slice(0, 200), null, 2));
    console.log('  AAR saved →', path.join('aar', id));
  } catch (e) { console.error('  AAR save failed:', e.message); }
}

function loadRun(id) {
  if (!safeId(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(AAR_DIR, id), 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// CSV export — one row per decision, then the event log
// ---------------------------------------------------------------------------
function aarCsv(aar) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const toMin = (t) => (t == null ? '' : Math.round((t * aar.timeScale / 60) * 10) / 10);
  const rows = [];
  rows.push(['FOGLINE AFTER ACTION REVIEW']);
  rows.push(['Scenario', aar.scenario.name, 'Mission window', `${aar.startClock}-${aar.endClock}`, 'Ended', aar.endReason]);
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
// request handling
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  const p = url.pathname;

  // ---- event stream ----
  if (p === '/events') {
    const role = url.searchParams.get('role') === 'instructor' ? 'instructor' : 'trainee';
    const pid = url.searchParams.get('pid');
    if (role === 'trainee' && !PIDS.includes(pid)) return json(res, 400, { error: 'unknown callsign' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1000\n\n');
    const client = { res, role, pid, id: ++clientSeq };
    clients.add(client);
    if (role === 'trainee') sse(res, 'history', game.inbox[pid].slice(-80));
    else sse(res, 'history', { events: game.events.slice(-120), decisions: game.decisions.slice(-120) });
    req.on('close', () => clients.delete(client));
    req.on('error', () => clients.delete(client));
    return;
  }

  // ---- trainee + instructor actions ----
  if (p === '/api/action' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, game.action(b.pid, b));
  }
  if (p === '/api/admin' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, game.admin(b));
  }

  // ---- current exercise data ----
  if (p === '/api/scenarios') {
    return json(res, 200, { scenarios: SCENARIOS.map((s) => ({ id: s.id, name: s.name, brief: s.brief })), current: game.scenario.id, config: game.cfg });
  }
  if (p === '/api/aar') {
    const a = getAar();
    if (!a) return json(res, 404, { error: 'No exercise data yet — run an exercise first.' });
    return json(res, 200, lite(a));
  }
  if (p === '/api/replay') {
    const id = url.searchParams.get('run');
    if (id) {
      const run = loadRun(id);
      if (!run || !run.replay) return json(res, 404, { error: 'run not found' });
      return json(res, 200, { replay: run.replay, aar: lite(run) });
    }
    const a = getAar();
    if (!a) return json(res, 404, { error: 'No exercise data yet' });
    return json(res, 200, { replay: a.replay, aar: lite(a) });
  }
  if (p === '/api/aar.json') {
    const a = getAar();
    if (!a) return json(res, 404, { error: 'No exercise data yet' });
    return download(res, `fogline-aar-${a.scenario.id}.json`, 'application/json', JSON.stringify(a, null, 2));
  }
  if (p === '/api/aar.csv') {
    const a = getAar();
    if (!a) return json(res, 404, { error: 'No exercise data yet' });
    return download(res, `fogline-aar-${a.scenario.id}.csv`, 'text/csv; charset=utf-8', '﻿' + aarCsv(a));
  }

  // ---- saved runs, and comparing two of them ----
  if (p === '/api/runs') return json(res, 200, { runs: readIndex() });
  if (p.startsWith('/api/run/')) {
    const id = decodeURIComponent(p.slice('/api/run/'.length));
    const run = loadRun(id);
    if (!run) return json(res, 404, { error: 'run not found' });
    if (url.searchParams.get('csv')) return download(res, `fogline-${id}.csv`, 'text/csv; charset=utf-8', '﻿' + aarCsv(run));
    return json(res, 200, lite(run));
  }
  if (p === '/api/compare') {
    const A = url.searchParams.get('a') === 'current' ? getAar() : loadRun(url.searchParams.get('a'));
    const B = url.searchParams.get('b') === 'current' ? getAar() : loadRun(url.searchParams.get('b'));
    if (!A || !B) return json(res, 404, { error: 'need two runs to compare' });
    const pick = (x) => ({
      label: x.scenario.name, id: x.scenario.id, generatedAt: x.generatedAt, durationMin: x.durationMin,
      redcell: x.redcell.mode, costOfFog: x.costOfFog, outcome: x.outcome,
      mcScore: x.missionCommand.teamScore, team: { copMeanPct: x.team.copMeanPct, copWorstPct: x.team.copWorstPct, fratricide: x.team.fratricide, mutualSupport: x.team.mutualSupport },
      players: Object.fromEntries(Object.entries(x.players).map(([k, P]) => [k, {
        hp: P.hp, meanAccuracy: P.meanAccuracy, fogMin: P.fogMin, blindHpLost: P.blindHpLost,
        meanLatencyMin: P.meanLatencyMin, mcScore: P.missionCommand.score, jammedMin: P.ew.jammedMin,
      }])),
    });
    return json(res, 200, { a: pick(A), b: pick(B), comparable: A.scenario.id === B.scenario.id || true });
  }

  if (p === '/api/profiles') return json(res, 200, { profiles: profiles.list() });

  if (p === '/api/clients') {
    const online = {};
    for (const c of clients) if (c.role === 'trainee') online[c.pid] = (online[c.pid] || 0) + 1;
    return json(res, 200, { online, instructors: [...clients].filter((c) => c.role === 'instructor').length });
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
});

// ---------------------------------------------------------------------------
// simulation loop + push
// ---------------------------------------------------------------------------
let wasEnded = false;
setInterval(() => {
  try { game.tick(TICK_MS / 1000); } catch (e) { console.error('tick failed:', e.stack); }

  if (game.status === 'ENDED' && !wasEnded && game.aar) saveAar(game.aar);
  wasEnded = game.status === 'ENDED';

  // queued one-off events first
  const out = game.outbox;
  game.outbox = [];
  for (const o of out) {
    for (const c of clients) {
      const match = o.to === 'all'
        || (o.to === 'instructor' && c.role === 'instructor')
        || (c.role === 'trainee' && c.pid === o.to);
      if (match) sse(c.res, o.event, o.data);
    }
  }

  // then one state snapshot per distinct viewer
  let iv = null;
  const tv = {};
  const seats = {};
  for (const c of clients) if (c.role === 'trainee') seats[c.pid] = (seats[c.pid] || 0) + 1;
  for (const c of clients) {
    if (c.role === 'instructor') {
      if (!iv) { iv = game.instructorView(); iv.seats = seats; iv.online = seats; }
      sse(c.res, 'state', iv);
    } else {
      if (!tv[c.pid]) { tv[c.pid] = game.traineeView(c.pid); tv[c.pid].seats = seats; }
      sse(c.res, 'state', tv[c.pid]);
    }
  }
}, TICK_MS);

// ---------------------------------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  const host = ips[0] || 'localhost';
  const line = (l, u) => console.log(`    ${l.padEnd(12)} ${u}`);
  console.log('\n  \x1b[32mFOGLINE\x1b[0m — decision trainer for degraded communications');
  console.log(`  scenario: ${game.scenario.name}\n`);
  line('INSTRUCTOR', `http://${host}:${PORT}/instructor`);
  for (const pid of PIDS) line(pid, `http://${host}:${PORT}/trainee?pid=${pid}`);
  line('REPLAY', `http://${host}:${PORT}/replay`);
  line('REPORT', `http://${host}:${PORT}/report`);
  if (ips.length > 1) console.log(`\n  other addresses: ${ips.slice(1).join(', ')}`);
  console.log(`\n  localhost: http://localhost:${PORT}\n`);
});

process.on('SIGINT', () => { console.log('\n  stopping\n'); process.exit(0); });
