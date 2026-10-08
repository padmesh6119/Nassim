'use strict';
// Server tests: who may see and do what, at the boundary every request crosses.
// Boots the real app on a spare port with a scratch aar/ folder; ticks by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../server');
const { Game } = require('../engine/sim');
const { ProfileStore } = require('../engine/profile');

let pass = 0, fail = 0;
const results = [];
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); pass++; } catch (e) { results.push(['FAIL', name, e.message]); fail++; }
}

const TOKEN = 'a'.repeat(32);
const SEATS = { ALPHA: '1111', BRAVO: '2222', CHARLIE: '3333' };

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fogline-srv-'));
  const profiles = new ProfileStore(null);
  const app = createApp({ aarDir: dir, token: TOKEN, seats: SEATS, quiet: true, profiles,
    game: new Game('CONTESTED', { duration: 60 }, { profiles, seed: 99 }) });
  return new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => resolve({ app, port: app.server.address().port, dir })));
}

function req(port, method, p, { body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw != null ? raw : body != null ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      if ((res.headers['content-type'] || '').includes('event-stream')) { res.destroy(); return resolve({ status: res.statusCode, text: '', json: null }); }
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, text: b, json: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const H = { 'x-fogline-token': TOKEN };
const admin = (port, a, headers = H) => req(port, 'POST', '/api/admin', { body: a, headers });
const action = (port, a) => req(port, 'POST', '/api/action', { body: a });

(async () => {
  const { app, port, dir } = await boot();
  const tick = (sec) => { for (let i = 0; i < Math.round(sec / 0.2); i++) app.tick(); };

  await test('instructor actions need the token; a wrong one, even of the wrong length, is refused cleanly', async () => {
    eq((await admin(port, { type: 'pause' }, {})).status, 401);
    eq((await admin(port, { type: 'pause' }, { 'x-fogline-token': 'short' })).status, 401);
    eq((await admin(port, { type: 'pause' }, { 'x-fogline-token': 'b'.repeat(32) })).status, 401);
    eq((await req(port, 'POST', '/api/admin?token=' + TOKEN, { body: { type: 'bookmark', label: 'x' } })).status, 200, 'the token in the query also works');
    eq((await req(port, 'GET', '/api/clients')).status, 200, 'and the server is still up');
  });

  await test('the profiles are the red cell’s targeting data: token only, in every state', async () => {
    eq((await req(port, 'GET', '/api/profiles')).status, 401, 'in the lobby');
    eq((await req(port, 'GET', '/api/profiles', { headers: H })).status, 200);
  });

  await test('settings are the instructor’s; the scenario list is not', async () => {
    const open = await req(port, 'GET', '/api/scenarios');
    ok(open.json.scenarios.length >= 4 && !('config' in open.json), 'no config without the token');
    ok('config' in (await req(port, 'GET', '/api/scenarios', { headers: H })).json);
  });

  await test('a seat code is needed to act as a commander', async () => {
    eq((await action(port, { pid: 'ALPHA', type: 'identify', name: 'Lt Singh' })).status, 401, 'no code');
    eq((await action(port, { pid: 'ALPHA', seat: '2222', type: 'identify', name: 'Lt Singh' })).status, 401, 'BRAVO’s code does not open ALPHA');
    eq((await action(port, { pid: 'ALPHA', seat: '1111', type: 'identify', name: 'Lt Singh' })).status, 200, 'the right code');
    eq((await req(port, 'POST', '/api/action', { body: { pid: 'BRAVO', type: 'identify', name: 'Capt Rao' }, headers: H })).status, 200, 'the instructor can drive any seat');
    eq((await req(port, 'GET', '/events?role=trainee&pid=ALPHA&seat=9999')).status, 401, 'and the stream wants it too');
    eq((await req(port, 'GET', '/events?role=trainee&pid=ALPHA&seat=1111')).status, 200);
    eq((await req(port, 'GET', '/events?role=instructor')).status, 401, 'the instructor stream wants the token');
    eq((await req(port, 'GET', '/events?role=instructor&token=' + TOKEN)).status, 200);
  });

  await test('while the exercise runs, every route that carries the truth wants the token', async () => {
    eq((await admin(port, { type: 'start' })).status, 200);
    tick(15);
    for (const p of ['/api/replay', '/api/aar', '/api/aar.json', '/api/aar.csv', '/api/runs', '/api/compare?a=current&b=current', '/api/run/x.json']) {
      eq((await req(port, 'GET', p)).status, 401, p + ' without the token');
    }
    eq((await req(port, 'GET', '/api/replay', { headers: H })).status, 200, 'with it');
    eq((await req(port, 'GET', '/api/aar?token=' + TOKEN)).status, 200, 'or in the query');
    eq((await admin(port, { type: 'reset' })).status, 400, 'and a reset mid-exercise is refused');
  });

  await test('a commander’s reply never says whether they were fooled', async () => {
    const g = app.game;
    g.admin({ type: 'fake', pid: 'BRAVO', x: 620, y: 360, etype: 'ARMOR' });
    tick(2);
    const fake = Object.values(g.beliefs.BRAVO.tracks).find((t) => t.fake);
    const r = await action(port, { pid: 'BRAVO', seat: '2222', type: 'fire', x: 620, y: 360, ref: fake && fake.track, rationale: 'engage' });
    eq(r.status, 200);
    ok(r.json.ok && r.json.decision && r.json.decision.desc, 'the order is acknowledged');
    for (const k of ['onPhantom', 'accuracy', 'outcome', 'latency', 'severity']) ok(!(k in r.json.decision), `the reply must not carry ${k}`);
    ok(g.decisions[g.decisions.length - 1].onPhantom, 'while the record does');
  });

  await test('bad requests are refused, and never take the server down', async () => {
    eq((await req(port, 'GET', '/api/run/%E0%A4%A', { headers: H })).status, 400, 'a malformed escape');
    eq((await req(port, 'POST', '/api/action', { raw: 'x'.repeat(250000) })).status, 413, 'an oversized body');
    eq((await req(port, 'POST', '/api/action', { raw: '{not json' })).status, 401, 'garbage is just an unknown seat');
    eq((await req(port, 'GET', '/../server.js')).status !== 200, true, 'no path out of public/');
    eq((await req(port, 'GET', '/api/clients')).status, 200, 'still up');
  });

  await test('after Endex the debrief belongs to the room — without credentials or anyone’s file', async () => {
    eq((await admin(port, { type: 'end' })).status, 200);
    tick(0.4);
    const a = await req(port, 'GET', '/api/aar');
    eq(a.status, 200, 'trainees can open the debrief on their own laptops');
    ok(!('profiles0' in a.json), 'other people’s records are not in it');
    ok(Array.isArray(a.json.inputs) && a.json.inputs.length > 3, 'the input record is');
    eq((await req(port, 'GET', '/api/replay')).status, 200);
    eq((await req(port, 'GET', '/api/profiles')).status, 401, 'the profiles stay closed');
    ok(app.lastSaved, 'the run was saved');
    const saved = fs.readFileSync(path.join(dir, app.lastSaved), 'utf8');
    for (const secret of [TOKEN, ...Object.values(SEATS).map((s) => `"${s}"`)]) {
      ok(!saved.includes(secret) && !a.text.includes(secret), 'a credential reached the record: ' + secret.slice(0, 6));
    }
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    eq(idx[0].seed, 99, 'the run index carries the seed, so the same exercise can be run again');
  });

  app.stop();
  app.server.close();
  for (const [status, name, msg] of results) {
    const tag = status === 'PASS' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`${tag} ${name}` + (msg ? `\n    \x1b[31m${msg}\x1b[0m` : ''));
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness failed:', e.stack); process.exit(1); });
