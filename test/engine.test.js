'use strict';
// Engine tests. Run with `npm test`. No dependencies, no framework.
//
// These guard the properties the whole trainer rests on: a trainee can only ever
// see what reached them, degradation really degrades, every inject has a
// measurable consequence, and the AAR's cost-of-fog arithmetic holds up.

const T = require('../public/terrain.js');
const { EwField } = require('../engine/ew');
const { CommsNet } = require('../engine/comms');
const { Game } = require('../engine/sim');

let pass = 0, fail = 0;
const results = [];

// The simulation is stochastic by design (dropout, garbling, ISR sampling), so the
// suite pins Math.random to a seeded generator and re-seeds per test from the test's
// own name. Every test is then independently reproducible and test order cannot
// matter. Run `FOGLINE_FUZZ=1 npm test` to exercise the real generator instead.
const FUZZ = process.env.FOGLINE_FUZZ === '1';
const REAL_RANDOM = Math.random;
let _s = 0x2f6e2b1 >>> 0;
const lcg = () => { _s = (Math.imul(_s, 1664525) + 1013904223) >>> 0; return _s / 4294967296; };
const hash = (str) => { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

function test(name, fn) {
  if (FUZZ) Math.random = REAL_RANDOM;
  else { _s = hash(name); Math.random = lcg; }
  try { fn(); results.push(['PASS', name]); pass++; }
  catch (e) { results.push(['FAIL', name, e.message]); fail++; }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function gt(a, b, msg) { if (!(a > b)) throw new Error(`${msg || 'not greater'}: ${a} is not > ${b}`); }
function gte(a, b, msg) { if (!(a >= b)) throw new Error(`${msg || 'not >='}: ${a} is not >= ${b}`); }
function lt(a, b, msg) { if (!(a < b)) throw new Error(`${msg || 'not less'}: ${a} is not < ${b}`); }

// Pin a specific seed for a block that asserts on a particular random outcome.
function withSeed(seed, fn) {
  const prev = _s, prevRandom = Math.random;
  _s = seed >>> 0;
  Math.random = lcg;
  try { return fn(); } finally { _s = prev; Math.random = prevRandom; }
}

const run = (g, seconds, dt = 0.2) => { for (let i = 0; i < Math.round(seconds / dt); i++) g.tick(dt); };
const start = (scenario = 'BASELINE', cfg = {}) => {
  const g = new Game(scenario, cfg);
  g.admin({ type: 'start' });
  return g;
};
const clearAll = (g) => g.pids.forEach((p) => g.admin({ type: 'link', pid: p, mode: 'clear' }));

// ===========================================================================
// Terrain
// ===========================================================================
test('grid references stay inside the sheet', () => {
  eq(T.gridRef(0, 0).slice(0, 2), 'A1');
  eq(T.gridRef(T.W, T.H).slice(0, 3), 'T13');
  ok(/^[A-T]\d{1,2}-\d\d$/.test(T.gridRef(523, 318)), 'unexpected format: ' + T.gridRef(523, 318));
});

test('high ground masks a line of sight', () => {
  const h = T.hills[0];
  const a = { x: h.x, y: h.y - h.r - 120 }, b = { x: h.x, y: h.y + h.r + 120 };
  ok(T.masked(a, b), 'a line straight through a hill should be masked');
  ok(!T.masked({ x: 10, y: 620 }, { x: 60, y: 630 }), 'open ground should not be masked');
});

test('bearings read as compass points', () => {
  eq(T.bearingName(T.bearing({ x: 500, y: 500 }, { x: 500, y: 100 })), 'N');
  eq(T.bearingName(T.bearing({ x: 500, y: 500 }, { x: 900, y: 500 })), 'E');
});

// ===========================================================================
// EW field
// ===========================================================================
test('jamming is strongest at the emitter and absent outside its radius', () => {
  const ew = new EwField([{ id: 'X', type: 'JAMMER', x: 500, y: 300, r: 300, power: 1, on: true }]);
  gt(ew.jamAt({ x: 500, y: 300 }).severity, 0.9, 'at the emitter');
  eq(ew.jamAt({ x: 500, y: 640 }).severity, 0, 'well outside the radius');
  gt(ew.jamAt({ x: 500, y: 300 }).severity, ew.jamAt({ x: 500, y: 450 }).severity, 'should fall off with distance');
});

test('an emitter that is switched off, or a disabled field, does nothing', () => {
  const ew = new EwField([{ id: 'X', type: 'JAMMER', x: 500, y: 300, r: 300, power: 1, on: false }]);
  eq(ew.jamAt({ x: 500, y: 300 }).severity, 0);
  ew.toggle('X');
  gt(ew.jamAt({ x: 500, y: 300 }).severity, 0);
  ew.enabled = false;
  eq(ew.jamAt({ x: 500, y: 300 }).severity, 0);
});

test('putting a hill between you and the jammer reduces it', () => {
  const h = T.hills[0];
  const ew = new EwField([{ id: 'X', type: 'JAMMER', x: h.x, y: h.y - h.r - 100, r: 500, power: 1, on: true }]);
  const exposed = ew.jamAt({ x: h.x + h.r + 150, y: h.y });
  const behind = ew.jamAt({ x: h.x, y: h.y + h.r + 100 });
  ok(behind.masked, 'the point behind the hill should be masked');
  lt(behind.severity, exposed.severity, 'masking must help');
});

test('spoofers and jammers do not affect each other', () => {
  const ew = new EwField([{ id: 'S', type: 'SPOOFER', x: 500, y: 300, r: 300, power: 1, on: true }]);
  eq(ew.jamAt({ x: 500, y: 300 }).severity, 0, 'a spoofer must not jam');
  gt(ew.spoofAt({ x: 500, y: 300 }).severity, 0.9, 'but it must spoof');
});

// ===========================================================================
// Comms net
// ===========================================================================
test('a clear net delivers everything, quickly', () => {
  const cfg = { delayMin: 6, delayMax: 18, dropRate: 0.4, garbleRate: 0.45 };
  const got = [];
  const net = new CommsNet(cfg, { linkProfile: () => ({ sevDelay: 0, sevDrop: 0, sevGarble: 0, severity: 0, sources: [] }), onDeliver: (d) => got.push(d) });
  net.register(['ALPHA']);
  for (let i = 0; i < 50; i++) net.send('ALPHA', { kind: 'ISR', from: 'HQ', text: 'x' });
  net.tick(1);
  eq(got.length, 50, 'all messages should arrive');
  eq(net.stats.ALPHA.dropped, 0);
  eq(net.stats.ALPHA.garbled, 0);
});

test('a jammed net loses, garbles and delays traffic', () => withSeed(7, () => {
  const cfg = { delayMin: 6, delayMax: 18, dropRate: 0.4, garbleRate: 0.45 };
  const got = [];
  const net = new CommsNet(cfg, { linkProfile: () => ({ sevDelay: 1, sevDrop: 1, sevGarble: 1, severity: 1, sources: ['MANUAL'] }), onDeliver: (d) => got.push(d) });
  net.register(['ALPHA']);
  for (let i = 0; i < 200; i++) net.send('ALPHA', { kind: 'ISR', from: 'HQ', text: 'ENEMY ARMOR GRID G7', contacts: [{ track: 'T-01', type: 'ARMOR', x: 300, y: 300, enemyId: 'E1' }] });
  eq(got.length, 0, 'nothing should arrive instantly on a jammed net');
  net.tick(1);
  eq(got.length, 0, 'still nothing after 1s');
  net.tick(40);
  gt(net.stats.ALPHA.dropped, 20, 'some traffic must be lost');
  gt(net.stats.ALPHA.garbled, 20, 'some traffic must be garbled');
  gt(got.length, 50, 'but most of the rest should land eventually');
  const garbled = got.find((d) => d.garbled);
  ok(garbled, 'expected at least one garbled message');
  ok(/#/.test(garbled.text), 'garbled text should show interference');
  const moved = got.find((d) => d.garbled && d.contacts[0].x !== 300);
  ok(moved, 'garbling should displace reported positions — that is what a contradictory report is');
}));

test('the ledger records when a report could have arrived, not when it did', () => {
  const cfg = { delayMin: 20, delayMax: 20, dropRate: 0, garbleRate: 0 };
  const net = new CommsNet(cfg, { linkProfile: () => ({ sevDelay: 1, sevDrop: 0, sevGarble: 0, severity: 1, sources: [] }), onDeliver: () => {} });
  net.register(['ALPHA']);
  net.send('ALPHA', { kind: 'ISR', from: 'HQ', text: 'x', contacts: [{ track: 'T-01', type: 'ARMOR', x: 1, y: 1, enemyId: 'E9' }] });
  const aw = net.awareness.get('ALPHA', 'E9');
  lt(aw.ideal, 1, 'the clear-comms arrival should be well under a second');
  eq(aw.actual, null, 'nothing has actually been believed yet');
});

// ===========================================================================
// Simulation: what a trainee can see
// ===========================================================================
test('the exercise starts in the lobby and issues the commander\'s intent', () => {
  const g = new Game('BASELINE');
  eq(g.status, 'LOBBY');
  g.admin({ type: 'start' });
  eq(g.status, 'RUNNING');
  run(g, 1);
  for (const p of g.pids) {
    const intent = g.inbox[p].find((m) => m.kind === 'INTENT');
    ok(intent, `${p} should receive the intent`);
    ok(/YOUR TASK/.test(intent.text), 'and their own task within it');
  }
});

test('a trainee view never leaks ground truth', () => {
  const g = start('BASELINE');
  run(g, 20);
  const v = g.traineeView('CHARLIE');
  ok(!('enemies' in v), 'there must be no truth array in a trainee view');
  ok(!('units' in v), 'and no truth list of friendly units');
  const believed = new Set(v.tracks.map((t) => t.track));
  for (const t of v.tracks) ok(g.beliefs.CHARLIE.tracks[t.track], 'every track shown must come from belief');
  // An enemy nobody has seen must not appear anywhere in the payload.
  const unseen = g.enemies.find((e) => e.spawned && e.alive && (!e.track || !believed.has(e.track)));
  if (unseen) {
    const s = JSON.stringify(v);
    ok(!s.includes(`"${unseen.id}"`), 'an undetected enemy id must not appear');
  }
  JSON.parse(JSON.stringify(v));
});

test('own eyes produce a visual contact, and it is relayed to the team', () => {
  const g = start('BASELINE');
  clearAll(g);
  run(g, 45);  // E1 recon closes on BR WEST, where ALPHA sits
  const alpha = Object.values(g.beliefs.ALPHA.tracks);
  const visual = alpha.find((t) => t.src === 'VISUAL');
  ok(visual, 'ALPHA should have eyes on something by now');
  run(g, 8);
  const relayed = Object.values(g.beliefs.CHARLIE.tracks).find((t) => t.track === visual.track);
  ok(relayed, 'the contact should have been relayed to CHARLIE');
  eq(relayed.src, 'ALPHA', 'and be attributed to ALPHA');
  gt(relayed.infoT, 0);
});

test('a jammed commander falls behind a clear one on the same report', () => withSeed(11, () => {
  const g = start('BASELINE');
  clearAll(g);
  g.admin({ type: 'link', pid: 'BRAVO', set: { delay: true, drop: true, garble: true } });
  run(g, 60);
  const a = g.comms.stats.ALPHA, b = g.comms.stats.BRAVO;
  gt(b.dropped, a.dropped, 'the jammed commander should lose more traffic');
  gt(b.garbled, a.garbled, 'and receive more corrupted traffic');
  gt(b.delaySum / Math.max(1, b.delivered), a.delaySum / Math.max(1, a.delivered), 'and run later');
}));

test('walking out of a jammer restores the net', () => {
  const g = start('BASELINE');
  g.admin({ type: 'emitter', op: 'add', etype: 'JAMMER', x: 300, y: 405, r: 180, power: 1 });
  gt(g.linkProfile('ALPHA').severity, 0.8, 'ALPHA is sitting on top of it');
  eq(g.linkProfile('BRAVO').severity, 0, 'BRAVO is out of range');
  g.action('ALPHA', { type: 'move', x: 300, y: 630, rationale: 'break out of jamming' });
  run(g, 25);
  eq(g.linkProfile('ALPHA').severity, 0, 'after manoeuvring clear, the net should be back');
  gt(g.stats.ALPHA.manoeuvredOut + 1, 1, 'and the AAR should credit the manoeuvre');
});

// ===========================================================================
// Injects
// ===========================================================================
test('a phantom contact lands on the picture and acting on it is recorded', () => {
  const g = start('BASELINE');
  clearAll(g);
  run(g, 2);
  g.admin({ type: 'fake', pid: 'BRAVO', x: 620, y: 360, etype: 'ARMOR' });
  run(g, 2);
  const fake = Object.values(g.beliefs.BRAVO.tracks).find((t) => t.fake);
  ok(fake, 'BRAVO should now hold a phantom track');
  const r = g.action('BRAVO', { type: 'fire', x: 620, y: 360, rationale: 'engaging reported armour', ref: fake.track });
  ok(r.decision.onPhantom, 'a fire mission onto the phantom must be flagged');
  run(g, 12);
  eq(g.stats.BRAVO.wastedRounds, 1, 'the round hit nothing');
  eq(g.stats.BRAVO.phantomActions, 1, 'and it was spent on the phantom');
});

test('a false kill report removes a live enemy from the picture', () => {
  const g = start('BASELINE');
  clearAll(g);
  run(g, 24.4);                  // just past an HQ ISR broadcast, nobody has eyes on E1
  const held = Object.values(g.beliefs.CHARLIE.tracks).find((t) => t.enemyId && t.src !== 'VISUAL');
  ok(held, 'CHARLIE needs to hold a reported track first');
  const res = g.admin({ type: 'falseBda', pid: 'CHARLIE', track: held.track });
  ok(res.ok, JSON.stringify(res));
  run(g, 0.6);
  ok(!g.beliefs.CHARLIE.tracks[held.track], 'the track should be gone from belief');
  ok(g.beliefs.CHARLIE.killed[held.track] != null, 'and recorded as a confirmed kill they now believe in');
  ok(g.enemies.find((e) => e.id === held.enemyId).alive, 'while the enemy is still very much alive');
});

test('a forged order is obeyed when it is not authenticated', () => {
  const g = start('BASELINE');
  clearAll(g);
  run(g, 2);
  g.admin({ type: 'forgedOrder', pid: 'CHARLIE', x: 520, y: 630 });
  run(g, 2);
  const fo = g.forgedOrders.CHARLIE[0];
  ok(fo.received, 'the order should have arrived');
  g.action('CHARLIE', { type: 'move', x: 520, y: 630, rationale: 'HQ ordered reposition' });
  ok(fo.complied, 'moving to the ordered grid counts as compliance');
  g.admin({ type: 'end' });
  const P = g.aar.players.CHARLIE;
  eq(P.forged[0].outcome, 'OBEYED WITHOUT AUTHENTICATING');
  eq(g.aar.costOfFog.forgedOrdersObeyed, 1);
});

test('challenging a forged order over the net exposes it', () => {
  const g = start('BASELINE');
  clearAll(g);
  run(g, 2);
  g.admin({ type: 'forgedOrder', pid: 'CHARLIE', x: 520, y: 630 });
  run(g, 2);
  g.action('CHARLIE', { type: 'auth', rationale: 'order contradicts the intent' });
  run(g, 3);
  const reply = g.inbox.CHARLIE.find((m) => m.kind === 'AUTH');
  ok(reply, 'HQ should answer the challenge');
  ok(/NEGATIVE/.test(reply.text), 'and deny issuing it');
  g.admin({ type: 'end' });
  eq(g.aar.players.CHARLIE.forged[0].outcome, 'AUTHENTICATED AND REJECTED');
  eq(g.aar.costOfFog.forgedOrdersObeyed, 0);
});

test('a challenge that cannot get through leaves the commander on their own', () => withSeed(3, () => {
  const g = start('BASELINE', { dropRate: 1 });
  clearAll(g);
  run(g, 2);
  g.admin({ type: 'forgedOrder', pid: 'CHARLIE', x: 520, y: 630 });
  run(g, 2);
  g.admin({ type: 'link', pid: 'CHARLIE', set: { delay: true, drop: true, garble: true } });
  const r = g.action('CHARLIE', { type: 'auth' });
  ok(r.decision.lost, 'the challenge should never leave the net');
  run(g, 5);
  ok(!g.inbox.CHARLIE.some((m) => m.kind === 'AUTH'), 'and no reply should arrive');
}));

test('spoofing a position makes teammates plan around a ghost', () => {
  const g = start('BASELINE');
  clearAll(g);
  g.admin({ type: 'spoof', pid: 'ALPHA', seconds: 60 });
  run(g, 8);
  const believed = g.beliefs.BRAVO.friends.ALPHA;
  ok(believed, 'BRAVO should have a position for ALPHA');
  const truth = g.unit('ALPHA');
  gt(Math.hypot(believed.x - truth.x, believed.y - truth.y), 80, 'the believed position should be well off');
  ok(believed.spoofed, 'and be flagged as spoofed in the record');
});

test('contradictory reports about one track are detected', () => withSeed(23, () => {
  const g = start('BASELINE');
  clearAll(g);
  g.admin({ type: 'link', pid: 'CHARLIE', set: { delay: false, drop: false, garble: true } });
  run(g, 120);
  gt(g.conflicts.CHARLIE.length, 0, 'garbled positions should produce conflicting reports');
  const c = g.conflicts.CHARLIE[0];
  gt(c.gapM, 500, 'and the gap between them should be meaningful, in metres');
}));

// ===========================================================================
// Mission command
// ===========================================================================
test('leaving your task area while the enemy closes on it is recorded', () => {
  const g = start('BASELINE');
  clearAll(g);
  run(g, 25);                    // let E1 get close to BR WEST
  g.action('ALPHA', { type: 'move', x: 90, y: 610, rationale: 'repositioning' });
  run(g, 45);
  gt(g.driftOrders.ALPHA.length, 0, 'the move away should be flagged as drift');
  const breach = g.breaches.find((b) => b.taskId === 'DENY_W');
  ok(breach, 'the enemy should have entered the area ALPHA was told to deny');
  eq(breach.covered, false, 'with ALPHA out of position');
});

test('acting while cut off scores initiative; silence does not', () => {
  const g = start('BASELINE');
  clearAll(g);
  g.admin({ type: 'link', pid: 'ALPHA', set: { delay: true, drop: true, garble: true } });
  g.admin({ type: 'link', pid: 'BRAVO', set: { delay: true, drop: true, garble: true } });
  run(g, 20);
  g.action('ALPHA', { type: 'hold', rationale: 'holding the crossing on my own initiative' });
  run(g, 10);
  g.admin({ type: 'link', pid: 'ALPHA', mode: 'clear' });
  g.admin({ type: 'link', pid: 'BRAVO', mode: 'clear' });
  run(g, 5);
  g.admin({ type: 'end' });
  const A = g.aar.players.ALPHA.missionCommand, B = g.aar.players.BRAVO.missionCommand;
  eq(A.isolationSpans.length, 1, 'ALPHA had one isolated period');
  eq(A.spansActed, 1, 'and acted during it');
  eq(A.initiativePct, 100);
  eq(B.spansActed, 0, 'BRAVO froze');
  eq(B.initiativePct, 0);
  gt(A.score, B.score, 'so ALPHA should score higher on mission command');
});

// ===========================================================================
// AAR
// ===========================================================================
test('the cost of fog is zero on a clear net and positive on a jammed one', () => {
  const clear = withSeed(5, () => {
    const g = start('BASELINE', { duration: 120 });
    clearAll(g);
    run(g, 125);
    return g.aar;
  });
  eq(clear.costOfFog.reactionDelayMin, 0, 'nobody can be late when nothing is delayed');

  const jammed = withSeed(5, () => {
    const g = start('BASELINE', { duration: 120 });
    g.pids.forEach((p) => g.admin({ type: 'link', pid: p, set: { delay: true, drop: true, garble: true } }));
    run(g, 125);
    return g.aar;
  });
  gt(jammed.costOfFog.reactionDelayMin, 0, 'the same mission on a broken net must cost awareness time');
  gt(jammed.players.ALPHA.comms.dropped, 0);
});

test('the report is complete, self-consistent and serializable', () => {
  const g = start('CONTESTED', { duration: 90 });
  run(g, 30);
  g.admin({ type: 'fake', pid: 'ALPHA', x: 250, y: 200, etype: 'ARMOR' });
  g.action('ALPHA', { type: 'uav', x: 250, y: 200, rationale: 'verify before committing' });
  run(g, 70);
  const a = g.aar;
  ok(a, 'the report should exist after ENDEX');
  for (const k of ['scenario', 'intent', 'outcome', 'costOfFog', 'missionCommand', 'team', 'players', 'redcell', 'decisions', 'events', 'series', 'replay']) {
    ok(k in a, 'missing section: ' + k);
  }
  eq(Object.keys(a.players).length, 3);
  for (const p of g.pids) {
    const P = a.players[p];
    for (const k of ['threats', 'fakes', 'forged', 'falseBda', 'conflicts', 'missionCommand', 'comms', 'ew']) ok(k in P, `${p} missing ${k}`);
    gte(P.missionCommand.score, 0); gte(100, P.missionCommand.score);
    gte(P.meanAccuracy, 0); gte(100, P.meanAccuracy);
    eq(P.blindHpLost <= P.hpLost, true, 'blind damage cannot exceed total damage');
  }
  eq(a.costOfFog.blindHp <= a.costOfFog.totalHp, true);
  const json = JSON.stringify(a);
  ok(json.length > 5000, 'the report should have real content');
  JSON.parse(json);
});

test('the replay captures the whole exercise with its teaching moments', () => {
  const g = start('CONTESTED', { duration: 60 });
  run(g, 20);
  g.admin({ type: 'bookmark', label: 'watch this' });
  run(g, 45);
  const rp = g.aar.replay;
  gte(rp.frames.length, 50, 'roughly one frame a second');
  const f = rp.frames[rp.frames.length - 1];
  for (const p of g.pids) {
    ok(f.b[p], 'each frame holds every commander\'s picture');
    ok(f.l[p], 'and their link state');
  }
  ok(f.u.length === 3, 'and the truth for all three sub-units');
  ok(rp.bookmarks.some((b) => b.label === 'watch this'), 'the instructor mark should be in the replay');
  ok(rp.frames.every((fr, i, arr) => i === 0 || fr.t >= arr[i - 1].t), 'frames must be in order');
});

// ===========================================================================
// Red cell
// ===========================================================================
test('the red cell proposes in ASSIST and only acts when approved', () => withSeed(31, () => {
  const g = start('CONTESTED', { redcell: 'ASSIST', duration: 200 });
  run(g, 40);
  gt(g.redcell.recs.length, 0, 'it should have live proposals');
  eq(g.redcell.log.filter((l) => l.mode === 'AUTO' || l.mode === 'APPROVED').length, 0, 'but nothing should have been executed on its own');
  const rec = g.redcell.recs[0];
  ok(rec, 'expected a live recommendation');
  ok(rec.reason.length > 40, 'every proposal must explain itself');
  const r = g.admin({ type: 'redcell', op: 'approve', id: rec.id });
  ok(r.ok, JSON.stringify(r));
  eq(g.redcell.log.filter((l) => l.mode === 'APPROVED').length, 1, 'approval should execute it');
}));

test('the red cell acts on its own in AUTO, within budget, and explains itself', () => withSeed(47, () => {
  const g = start('DECEPTION', { redcell: 'AUTO', redcellBudget: 4, duration: 300 });
  run(g, 305);   // 1500 steps of 0.2 can land a hair under 300, so run past the end
  const acted = g.redcell.log.filter((l) => l.mode === 'AUTO');
  gt(acted.length, 0, 'it should have acted');
  gte(4, g.redcell.spent, 'and never exceeded its budget');
  for (const l of acted) {
    ok(l.reason && l.reason.length > 40, 'each action needs a reason: ' + JSON.stringify(l));
    ok(g.pids.includes(l.pid), 'aimed at a real callsign');
  }
  ok(g.aar.redcell.log.length > 0, 'and the reasoning must survive into the AAR');
}));

test('the red cell never blacks out the whole team at once', () => withSeed(59, () => {
  const g = start('DECEPTION', { redcell: 'AUTO', redcellBudget: 40, duration: 300, ewEnabled: false });
  let worst = 0;
  for (let i = 0; i < 1500; i++) {
    g.tick(0.2);
    worst = Math.max(worst, g.pids.filter((p) => g.linkProfile(p).severity > 0.4).length);
  }
  lt(worst, 3, 'at least one commander must always be able to hear something');
}));

// ===========================================================================
// Full run
// ===========================================================================
test('a full scripted exercise runs end to end without faulting', () => withSeed(101, () => {
  const g = start('DECEPTION', { duration: 300, redcell: 'AUTO', redcellBudget: 20 });
  const grids = [[300, 340], [740, 330], [520, 480], [420, 430], [640, 430]];
  for (let i = 0; i < 1530; i++) {
    g.tick(0.2);
    const t = i * 0.2;
    if (i % 85 === 0) {
      const pid = g.pids[(i / 85) % 3];
      const gr = grids[(i / 85) % grids.length];
      g.action(pid, { type: 'move', x: gr[0], y: gr[1], rationale: 'adjusting to the picture' });
    }
    if (i % 140 === 0) g.action(g.pids[i % 3], { type: 'uav', x: 300 + ((i * 7) % 400), y: 200 + ((i * 3) % 200), rationale: 'verifying a report' });
    if (i % 190 === 0) g.action(g.pids[i % 3], { type: 'chat', text: 'confirm you hold grid?' });
    if (i % 230 === 0) {
      const tr = Object.values(g.beliefs[g.pids[i % 3]].tracks)[0];
      if (tr) g.action(g.pids[i % 3], { type: 'mark', track: tr.track, mark: 'SUSPECT' });
    }
    if (i === 400) g.action('ALPHA', { type: 'fire', x: 300, y: 300, rationale: 'suppress the crossing' });
    if (i === 700) g.action('CHARLIE', { type: 'auth' });
  }
  eq(g.status, 'ENDED');
  const a = g.aar;
  gt(a.decisions.length, 10, 'decisions should be logged');
  gt(a.events.length, 10, 'as should events');
  gte(a.costOfFog.reactionDelayMin, 0);
  gte(a.team.copMeanPct, 0); gte(100, a.team.copMeanPct);
  gte(a.missionCommand.teamScore, 0); gte(100, a.missionCommand.teamScore);
  ok(a.costOfFog.summary.length > 0, 'the debrief must have findings');
  for (const d of a.decisions) ok(typeof d.accuracy === 'number' && d.accuracy >= 0 && d.accuracy <= 100, 'every decision carries the picture accuracy at the time');
  JSON.parse(JSON.stringify(a));
}));

test('views stay serializable and cheap throughout', () => {
  const g = start('CONTESTED', { duration: 80 });
  run(g, 40);
  const iv = JSON.stringify(g.instructorView());
  const tv = JSON.stringify(g.traineeView('ALPHA'));
  JSON.parse(iv); JSON.parse(tv);
  lt(tv.length, 60000, 'a trainee snapshot should stay small enough to push 5x a second');
  lt(iv.length, 200000, 'and so should the instructor snapshot');
});

test('resetting returns everything to the lobby', () => {
  const g = start('CONTESTED');
  run(g, 30);
  g.admin({ type: 'fake', pid: 'ALPHA', x: 200, y: 200 });
  g.admin({ type: 'reset' });
  eq(g.status, 'LOBBY');
  eq(g.t, 0);
  eq(g.fakes.length, 0);
  eq(g.decisions.length, 0);
  eq(Object.keys(g.beliefs.ALPHA.tracks).length, 0);
  eq(g.comms.pending.length, 0);
  eq(g.redcell.log.length, 0);
  eq(g.recorder.frames.length, 0);
});

test('scenarios differ in the way they are meant to', () => {
  const base = new Game('BASELINE'), dec = new Game('DECEPTION');
  eq(base.ew.emitters.length, 0, 'the baseline has no EW');
  gt(dec.ew.emitters.length, 1, 'the deception scenario has several emitters');
  eq(base.cfg.redcell, 'OFF');
  eq(dec.cfg.redcell, 'AUTO');
  ok(dec.ew.emitters.some((e) => e.type === 'SPOOFER'), 'including a GPS spoofer');
  eq(base.scenario.package, dec.scenario.package, 'but the enemy package is shared, so runs are comparable');
});

test('instructor settings are clamped, not trusted', () => {
  const g = new Game('CONTESTED');
  g.admin({ type: 'config', config: { duration: 99999, intensity: 99, dropRate: 5, delayMin: 50, delayMax: 2, timeScale: -4 } });
  lt(g.cfg.duration, 3601);
  lt(g.cfg.intensity, 7);
  eq(g.cfg.dropRate, 1);
  gte(g.cfg.delayMax, g.cfg.delayMin);
  gt(g.cfg.timeScale, 0);
  ok(g.admin({ type: 'link', pid: 'NOBODY', mode: 'jam' }).error, 'an unknown callsign must be refused');
  ok(g.action('NOBODY', { type: 'move', x: 1, y: 1 }).error, 'and so must an unknown trainee');
  ok(g.admin({ type: 'nonsense' }).error, 'as must an unknown instruction');
});

// ===========================================================================
for (const [status, name, msg] of results) {
  const tag = status === 'PASS' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${tag} ${name}` + (msg ? `\n    \x1b[31m${msg}\x1b[0m` : ''));
}
console.log(`\n${pass} passed, ${fail} failed${FUZZ ? ' (fuzz mode — unseeded)' : ''}\n`);
process.exit(fail ? 1 : 0);
