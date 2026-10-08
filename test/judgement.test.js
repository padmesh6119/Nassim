'use strict';
// Sources in disagreement, calibration, and the adaptive opponent.
//
// These guard the three claims the pitch makes: sources from different domains
// really do contradict each other on purpose; the red cell really does learn a
// person's bias and attack it, across rounds, by name rather than by seat; and
// the calibration figures that "prove they got better" are computed honestly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game } = require('../engine/sim');
const { ProfileStore } = require('../engine/profile');
const { calibrate, weakSpot, weakSpotReason } = require('../engine/calibration');
const { VARIANTS, stanceOf } = require('../engine/sources');

let pass = 0, fail = 0;
const results = [];
let _s = 0;
const lcg = () => { _s = (Math.imul(_s, 1664525) + 1013904223) >>> 0; return _s / 4294967296; };
const hash = (str) => { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function test(name, fn) {
  _s = hash(name); Math.random = lcg;
  try { fn(); results.push(['PASS', name]); pass++; } catch (e) { results.push(['FAIL', name, e.message]); fail++; }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
const gt = (a, b, m) => { if (!(a > b)) throw new Error(`${m || 'not greater'}: ${a} is not > ${b}`); };

const run = (g, sec) => { for (let i = 0; i < Math.round(sec / 0.2); i++) g.tick(0.2); };
function start(scenario = 'BASELINE', cfg = {}, profiles) {
  const g = new Game(scenario, { duration: 900, ...cfg }, { profiles: profiles || new ProfileStore(null) });
  g.admin({ type: 'start' });
  g.pids.forEach((p) => g.admin({ type: 'link', pid: p, mode: 'clear' }));
  return g;
}
const openFor = (g, pid) => g.disputes.find((d) => d.pid === pid && !d.answer && !d.froze && !d.lost);

// Play a disagreement to its end: stage it, let the reports land, answer it.
function playDispute(g, pid, variant, answer, confidence = 80) {
  const r = g.admin({ type: 'contradiction', pid, variant });
  if (r.error) throw new Error('could not stage: ' + r.error);
  run(g, 2);
  const d = openFor(g, pid);
  ok(d, 'the disagreement should be open');
  const a = typeof answer === 'function' ? answer(d) : answer;
  const res = g.action(pid, { type: 'resolve', dispute: d.id, answer: a, confidence });
  ok(res.ok, JSON.stringify(res));
  return d;
}

// ===========================================================================
// The arithmetic
// ===========================================================================
test('calibration: confident and right scores well, confident and wrong scores badly', () => {
  const good = calibrate(Array.from({ length: 10 }, () => ({ confidence: 0.9, correct: true })));
  const bad = calibrate(Array.from({ length: 10 }, () => ({ confidence: 0.9, correct: false })));
  gt(bad.brier, good.brier, 'being sure and wrong must cost more than being sure and right');
  eq(good.n, 10);
  ok(good.enough, 'ten judgements is enough to report');
});

test('calibration: overconfidence is stated confidence minus how often they were right', () => {
  const js = [...Array(5)].map(() => ({ confidence: 1, correct: true })).concat([...Array(5)].map(() => ({ confidence: 1, correct: false })));
  const c = calibrate(js);
  eq(c.accuracy, 0.5);
  eq(c.meanConfidence, 1);
  eq(c.overconfidence, 0.5, 'certain every time, right half the time');
});

test('calibration: too few judgements are flagged, not reported as a finding', () => {
  const c = calibrate([{ confidence: 0.7, correct: true }, { confidence: 0.6, correct: false }]);
  eq(c.n, 2);
  eq(c.enough, false, 'two judgements cannot support a claim about anyone');
});

test('calibration: judgements without a stated confidence do not count', () => {
  const c = calibrate([{ confidence: null, correct: true }, { confidence: 0.8, correct: true }]);
  eq(c.n, 1);
});

test('a signals intercept saying "the drone is compromised" contradicts the drone', () => {
  eq(stanceOf('drone-compromised', 'present'), 'absent');
  eq(stanceOf('traffic-present', 'present'), 'present');
  eq(stanceOf('no-traffic', 'present'), 'absent');
});

test('each kind of disagreement has exactly the liars it claims', () => {
  for (const [id, v] of Object.entries(VARIANTS)) {
    const wrong = Object.entries(v.says).filter(([, says]) => stanceOf(says, v.says.UAV) !== v.truth).map(([s]) => s).sort();
    eq(JSON.stringify(wrong), JSON.stringify([...v.liars].sort()), `${id}: liars`);
  }
});

test('a weakness is a source that misled them, not merely one they trusted', () => {
  const trustedAndRight = weakSpot({ UAV: { trusted: 5, distrusted: 0, fooled: 0 } }, {});
  eq(trustedAndRight.source, 'UAV', 'blind trust is still worth testing');
  ok(trustedAndRight.probe, 'but as a test, not reported as a weakness');
  ok(/not yet seen it wrong/.test(weakSpotReason('Lt Singh', trustedAndRight, 1, true)), 'and the reason says so');
  eq(weakSpot({ UAV: { trusted: 4, distrusted: 3, fooled: 0, saved: 3 } }, {}), null,
    'someone who has caught a source lying and was never fooled by it has no weakness there');
  eq(weakSpot({ UAV: { trusted: 4, distrusted: 3, fooled: 1, saved: 3 } }, {}), null, 'one slip against three catches is not a pattern');
  ok(!weakSpot({ UAV: { trusted: 3, distrusted: 1, fooled: 2, saved: 1 } }, {}).probe, 'misled more often than not is a weakness');
  const misled = weakSpot({ UAV: { trusted: 3, distrusted: 2, fooled: 0 }, SCOUT: { trusted: 3, distrusted: 2, fooled: 2 } }, {});
  eq(misled.source, 'SCOUT', 'the source that has fooled them outranks the one they merely use');
  eq(weakSpot({}, {}), null, 'no data, no weakness');
  eq(weakSpot({}, { issued: 5, froze: 3 }).source, 'FREEZE', 'leaving disagreements unresolved is its own weakness');
});

// ===========================================================================
// Disagreements in the simulation
// ===========================================================================
test('a disagreement puts all three domains in front of the commander', () => {
  const g = start();
  run(g, 45);
  g.admin({ type: 'contradiction', pid: 'BRAVO', variant: 'DRONE_SPOOFED' });
  run(g, 2);
  const v = g.traineeView('BRAVO');
  eq(v.disputes.length, 1, 'one disagreement on screen');
  const sources = v.disputes[0].claims.map((c) => c.source).sort();
  eq(JSON.stringify(sources), JSON.stringify(['SCOUT', 'SIGINT', 'UAV']), 'patrol, drone and intercept all report');
});

test('the commander is never told which source is lying', () => {
  const g = start();
  run(g, 45);
  g.admin({ type: 'contradiction', pid: 'BRAVO', variant: 'SCOUT_STALE' });
  run(g, 2);
  const s = JSON.stringify(g.traineeView('BRAVO').disputes);
  for (const leak of ['"truth"', '"correct"', '"variant"', '"liars"', 'SCOUT_STALE', 'out of date']) {
    ok(!s.includes(leak), `the trainee view must not contain ${leak}`);
  }
});

test('the ground truth is staged honestly: "there" means a real enemy, "clear" means none', () => {
  const g = start();
  run(g, 45);
  g.admin({ type: 'contradiction', pid: 'BRAVO', variant: 'SCOUT_STALE' });
  const present = openFor(g, 'BRAVO');
  eq(present.truth, 'present');
  eq(g.truthAt(present), 'present', 'there must really be an enemy where the drone says');
  run(g, 2);
  g.action('BRAVO', { type: 'resolve', dispute: present.id, answer: 'present', confidence: 70 });
  g.admin({ type: 'contradiction', pid: 'BRAVO', variant: 'DRONE_SPOOFED' });
  const absent = openFor(g, 'BRAVO');
  eq(absent.truth, 'absent');
  eq(g.truthAt(absent), 'absent', 'and none where the drone is lying');
});

test('siding with the source that lied is recorded as being misled by it', () => {
  const g = start();
  run(g, 45);
  const d = playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present', 90);   // believed the drone
  eq(d.correct, false, 'the drone was spoofed, so "enemy there" is wrong');
  eq(g.trust.BRAVO.UAV.fooled, 1, 'misled by the drone once');
  eq(g.trust.BRAVO.SCOUT.missed, 1, 'and dismissed a patrol that was right');
  const j = g.judgements.find((x) => x.subject === d.id);
  eq(j.confidence, 0.9);
  eq(j.correct, false);
});

test('rejecting the lying source is recorded as being saved by judgement', () => {
  const g = start();
  run(g, 45);
  const d = playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'absent', 70);
  eq(d.correct, true);
  eq(g.trust.BRAVO.UAV.saved, 1, 'doubting the spoofed drone saved them');
  eq(g.trust.BRAVO.UAV.fooled || 0, 0);
});

test('calling a phantom clear is rejecting it, not acting on it', () => {
  const g = start();
  run(g, 45);
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'absent', 80);
  const dec = g.decisions.find((d) => d.type === 'RESOLVE');
  eq(dec.onPhantom, false, '"the area is clear" about a spoofed drone must not count as acting on the phantom');
  g.admin({ type: 'end' });
  eq(g.aar.players.BRAVO.judgement.disputes[0].correct, true, 'the debrief scores it as a right call');
  eq(g.aar.costOfFog.deceptionsSucceeded, 0, 'and it must not appear as a deception that worked');
});

test('a phantom inside a disagreement is scored once, as a judgement, not again as a deception', () => {
  const g = start();
  run(g, 45);
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present', 80);
  eq(g.decisions.find((d) => d.type === 'RESOLVE').onPhantom, true, 'the decision is still marked as aimed at a phantom');
  g.admin({ type: 'fake', pid: 'BRAVO', x: 620, y: 360, etype: 'ARMOR' });   // a separate deception, outside any disagreement
  g.admin({ type: 'end' });
  eq(g.aar.players.BRAVO.judgement.disputes[0].correct, false, 'the believed phantom is a wrong call');
  eq(g.aar.players.BRAVO.fakes.length, 1, 'only the separate phantom is traced as a deception');
});

test('the drill tells the commander the truth after each decision; a battle does not', () => {
  const drill = start('DRILL', { duration: 900 });
  run(drill, 30);                                     // the drill puts one in front of BRAVO on its own
  const d = openFor(drill, 'BRAVO');
  ok(d && d.readyT != null, 'BRAVO should have a disagreement by now');
  const wrong = d.truth === 'present' ? 'absent' : 'present';
  drill.action('BRAVO', { type: 'resolve', dispute: d.id, answer: wrong, confidence: 90 });
  const told = drill.inbox.BRAVO.find((m) => m.kind === 'TRUTH');
  ok(told, 'the drill should say whether they were right');
  ok(/^Wrong/.test(told.text) && /was wrong|were wrong/.test(told.text), told.text);

  const battle = start('BASELINE');
  run(battle, 45);
  playDispute(battle, 'BRAVO', 'DRONE_SPOOFED', 'present', 90);
  ok(!battle.inbox.BRAVO.some((m) => m.kind === 'TRUTH'), 'in an exercise the truth comes at the debrief, not mid-fight');
});

test('the map follows the decision', () => {
  const g = start();
  run(g, 45);
  const d = playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'absent', 70);
  eq(g.beliefs.BRAVO.tracks[d.track].mark, 'DISMISSED', 'calling it clear dismisses the drone’s phantom');
});

test('confirming or rejecting a report with a confidence is a judgement; doubting is not', () => {
  const g = start();
  run(g, 25);
  const tr = Object.values(g.beliefs.CHARLIE.tracks).find((t) => t.source === 'UAV');
  ok(tr, 'CHARLIE needs a drone-feed track');
  g.action('CHARLIE', { type: 'mark', track: tr.track, mark: 'SUSPECT', confidence: 60 });
  eq(g.judgements.filter((j) => j.pid === 'CHARLIE').length, 0, 'doubt is not a commitment');
  g.action('CHARLIE', { type: 'mark', track: tr.track, mark: 'CONFIRMED', confidence: 80 });
  const j = g.judgements.find((x) => x.pid === 'CHARLIE');
  ok(j, 'confirming is');
  eq(j.source, 'UAV');
  eq(j.confidence, 0.8);
});

test('leaving a disagreement unanswered is recorded as freezing', () => {
  const g = start();
  run(g, 45);
  g.admin({ type: 'contradiction', pid: 'ALPHA', variant: 'DRONE_SPOOFED' });
  run(g, 60);
  eq(g.disputeStats.ALPHA.froze, 1);
  eq(g.traineeView('ALPHA').disputes.length, 0, 'and it leaves the screen');
});

test('only one disagreement at a time per commander', () => {
  const g = start();
  run(g, 45);
  ok(g.admin({ type: 'contradiction', pid: 'ALPHA', variant: 'DRONE_SPOOFED' }).ok);
  ok(g.admin({ type: 'contradiction', pid: 'ALPHA', variant: 'DRONE_SPOOFED' }).error, 'a second must wait');
});

test('a destroyed sub-unit is not handed disagreements', () => {
  const g = start();
  run(g, 10);
  g.unit('ALPHA').alive = false;
  ok(g.admin({ type: 'contradiction', pid: 'ALPHA' }).error);
});

test('the drill keeps disagreements coming to a commander who answers them', () => {
  const g = start('DRILL', { duration: 900 });
  for (let i = 0; i < 100 * 5; i++) {
    g.tick(0.2);
    for (const p of g.pids) {
      const d = openFor(g, p);
      if (d && d.readyT != null) g.action(p, { type: 'resolve', dispute: d.id, answer: 'present', confidence: 70 });
    }
  }
  for (const p of g.pids) gt(g.disputeStats[p].issued, 3, `${p} should have been given several`);
});

test('the drill presses a hesitant commander harder than a full exercise', () => {
  const drill = new Game('DRILL'), full = new Game('DECEPTION');
  gt(full.cfg.disputeTTL, drill.cfg.disputeTTL, 'less time to decide in the drill');
});

// ===========================================================================
// The adaptive opponent
// ===========================================================================
test('the red cell learns that a commander over-trusts the drone, and makes the drone lie', () => {
  const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 });
  run(g, 45);
  // two rounds' worth of believing the drone when it was spoofed
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present');
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present');
  eq(g.weakSpotFor('BRAVO').source, 'UAV', 'the weakness is the drone feed');
  const r = g.admin({ type: 'contradiction', pid: 'BRAVO' });
  ok(r.ok, JSON.stringify(r));
  eq(r.variant, 'DRONE_SPOOFED', 'so the next disagreement is the drone lying');
  const target = g.redcell.log.find((l) => l.ruleId === 'ADAPTIVE');
  ok(target, 'and the red cell records that it chose this on purpose');
  ok(/drone feed/.test(target.reason) && /misled/.test(target.reason), 'with its reason in words: ' + target.reason);
});

test('it learns a different bias for a different person', () => {
  const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 });
  run(g, 45);
  playDispute(g, 'CHARLIE', 'SCOUT_STALE', 'absent');      // believed the patrol's "all clear"
  playDispute(g, 'CHARLIE', 'SCOUT_STALE', 'absent');
  eq(g.weakSpotFor('CHARLIE').source, 'SCOUT');
  eq(g.chooseVariant('CHARLIE').variant, 'SCOUT_STALE');
});

test('with the red cell off, nothing is targeted and every source is tested evenly', () => {
  const g = start('BASELINE', { redcell: 'OFF' });
  run(g, 45);
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present');
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present');
  const picks = new Set();
  for (let i = 0; i < 3; i++) { picks.add(g.chooseVariant('BRAVO').variant); g.disputeStats.BRAVO.issued++; }
  eq(picks.size, 3, 'all three kinds, in rotation');
  ok(!g.chooseVariant('BRAVO').targeted);
});

test('a commander who will not decide is pressed with the hardest kind', () => {
  const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 });
  run(g, 45);
  for (let i = 0; i < 3; i++) {
    g.admin({ type: 'contradiction', pid: 'ALPHA', variant: 'DRONE_SPOOFED' });
    run(g, 60);
  }
  eq(g.weakSpotFor('ALPHA').source, 'FREEZE');
  eq(g.chooseVariant('ALPHA').variant, 'TWO_LIE');
});

test('always giving the same answer is named as what it is, not pinned on a source', () => {
  const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 });
  run(g, 45);
  // calls everything clear, including where the enemy really is
  for (const v of ['SCOUT_STALE', 'SIGINT_FOOLED', 'DRONE_SPOOFED', 'SCOUT_STALE', 'SIGINT_FOOLED']) playDispute(g, 'CHARLIE', v, 'absent');
  const w = g.weakSpotFor('CHARLIE');
  eq(w.source, 'SAYS_CLEAR', 'the weakness is the answer, not whichever source happened to agree with it');
  const next = g.chooseVariant('CHARLIE').variant;
  eq(VARIANTS[next].truth, 'present', 'so the next one has the enemy really there: ' + next);
  ok(VARIANTS[next].liars.length === 1, 'with only one source saying clear');
  ok(/against most of the sources/.test(g.judgementView('CHARLIE').reason), g.judgementView('CHARLIE').reason);
});

test('going with the majority is not mistaken for a bias, even when the majority lies', () => {
  const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 });
  run(g, 45);
  // two coordinated liars every time: the careful answer is "enemy there", and it is wrong
  for (let i = 0; i < 5; i++) playDispute(g, 'ALPHA', 'TWO_LIE', 'present');
  const w = g.weakSpotFor('ALPHA');
  ok(!w || w.source !== 'SAYS_PRESENT', 'agreeing with what most sources said is not "whatever the sources say": ' + JSON.stringify(w));
});

test('every attack on a learned bias is one that good judgement passes', () => {
  const { VARIANT_FOR, majorityOf } = require('../engine/sources');
  for (const [bias, variants] of Object.entries(VARIANT_FOR)) {
    if (bias === 'FREEZE') continue;                       // pressure, not a test of reasoning
    for (const variant of variants) {
      const v = VARIANTS[variant];
      const claims = Object.entries(v.says).map(([s, says]) => ({ delivered: true, stance: stanceOf(says, v.says.UAV) }));
      eq(majorityOf(claims), v.truth, `${bias} → ${variant}: weighing all three sources must give the right answer`);
      if (VARIANTS[variant].exploits === bias) ok(v.liars.includes(bias), `${variant} makes the ${bias} the one that lies`);
    }
  }
});

test('no source always says the same thing, so its habit cannot be learned instead of the evidence', () => {
  const { BALANCED, VARIANT_FOR } = require('../engine/sources');
  for (const src of ['SCOUT', 'UAV', 'SIGINT']) {
    const stances = new Set(BALANCED.map((k) => stanceOf(VARIANTS[k].says[src], VARIANTS[k].says.UAV)));
    eq(stances.size, 2, `${src} reports both enemy and nothing across a round`);
    const ways = new Set(VARIANT_FOR[src].map((k) => stanceOf(VARIANTS[k].says[src], VARIANTS[k].says.UAV)));
    eq(ways.size, 2, `and is attacked lying both ways`);
  }
  const truths = BALANCED.map((k) => VARIANTS[k].truth);
  eq(truths.filter((t) => t === 'present').length, truths.length / 2, 'and the enemy is really there half the time');
});

test('trusting the drone and always saying "enemy" are told apart', () => {
  const g = start('BASELINE', { redcell: 'OFF' });
  run(g, 45);
  const drone = (d) => d.claims.find((c) => c.source === 'UAV').stance;
  for (const k of ['DRONE_SPOOFED', 'DRONE_MISSED', 'SCOUT_FALSE', 'SIGINT_DUMMY', 'DRONE_SPOOFED', 'DRONE_MISSED']) {
    playDispute(g, 'BRAVO', k, (d) => drone(g.disputes.find((x) => x.id === d.id)));
  }
  eq(g.weakSpotFor('BRAVO').source, 'UAV', 'believes the drone, whichever way it points');
  for (const k of ['DRONE_SPOOFED', 'SCOUT_FALSE', 'SIGINT_DUMMY', 'DRONE_MISSED', 'SCOUT_STALE', 'DRONE_SPOOFED']) {
    playDispute(g, 'CHARLIE', k, 'present');
  }
  eq(g.weakSpotFor('CHARLIE').source, 'SAYS_PRESENT', 'says enemy whatever the sources say');
});

test('always giving the same answer is not a weakness when it keeps being right', () => {
  const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 });
  run(g, 45);
  for (let i = 0; i < 5; i++) playDispute(g, 'CHARLIE', 'DRONE_SPOOFED', 'absent');
  ok(!g.weakSpotFor('CHARLIE') || g.weakSpotFor('CHARLIE').source !== 'SAYS_CLEAR', 'right every time is not a bias worth attacking');
});

// ===========================================================================
// Across rounds, by person
// ===========================================================================
test('the record follows the person, not the seat', () => {
  const store = new ProfileStore(null);
  const r1 = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 }, store);
  r1.action('BRAVO', { type: 'identify', name: 'Capt Rao' });
  run(r1, 45);
  playDispute(r1, 'BRAVO', 'DRONE_SPOOFED', 'present');
  playDispute(r1, 'BRAVO', 'DRONE_SPOOFED', 'present');
  r1.admin({ type: 'end' });
  eq(store.roundsFor('Capt Rao'), 1, 'round one is on the record');

  // next round, same person, different laptop
  const r2 = new Game('BASELINE', { duration: 900, redcell: 'AUTO', redcellBudget: 0 }, { profiles: store });
  r2.action('CHARLIE', { type: 'identify', name: 'capt rao' });
  r2.admin({ type: 'start' });
  eq(r2.weakSpotFor('CHARLIE').source, 'UAV', 'the bias learned last round is known before they make a move');
  eq(r2.weakSpotFor('BRAVO'), null, 'and whoever sits at BRAVO now starts clean');
});

test('a bias someone has trained out of stops being attacked', () => {
  const store = new ProfileStore(null);
  const play = (answerFn) => {
    const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 }, store);
    g.action('BRAVO', { type: 'identify', name: 'Capt Rao' });
    run(g, 45);
    for (let i = 0; i < 4; i++) playDispute(g, 'BRAVO', 'DRONE_SPOOFED', answerFn);
    g.admin({ type: 'end' });
    return g;
  };
  play('present');                       // round 1: believes the spoofed drone every time
  eq(store.weakSpot('Capt Rao').source, 'UAV', 'after round one the drone is his weakness');
  play('absent');                        // rounds 2 and 3: has learned
  play('absent');
  const w = store.weakSpot('Capt Rao');
  ok(!w || w.source !== 'UAV', 'two clean rounds later, the drone is no longer held against him: ' + JSON.stringify(w));
  eq(store.roundsFor('Capt Rao'), 3, 'while the full history is kept for the progress chart');
});

test('the round being played is one of the recent rounds, so a habit trained out of in round two is gone in round three', () => {
  const store = new ProfileStore(null);
  const play = (answer, end = true) => {
    const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 }, store);
    g.action('BRAVO', { type: 'identify', name: 'Capt Rao' });
    run(g, 45);
    for (let i = 0; i < 4; i++) playDispute(g, 'BRAVO', 'DRONE_SPOOFED', answer);
    if (end) g.admin({ type: 'end' });
    return g;
  };
  play('present');                                   // round 1: fooled by the drone four times
  const r2 = play('absent');                         // round 2: catches it four times
  eq(r2.aar.players.BRAVO.judgement.weakSpot && r2.aar.players.BRAVO.judgement.weakSpot.source, 'UAV',
    'at the end of round two, round one still counts: fooled as often as he caught it');
  const r3 = play('absent', false);                  // round 3, in play
  const w = r3.weakSpotFor('BRAVO');
  ok(!w || w.source !== 'UAV', 'in round three the drone is no longer held against him: ' + JSON.stringify(w));
  r3.admin({ type: 'end' });
  const J = r3.aar.players.BRAVO.judgement;
  ok(!J.weakSpot || J.weakSpot.source !== 'UAV', 'nor in that round’s debrief');
  ok(!J.weakSpot || !/across 3 rounds/.test(J.weakSpot.reason), 'and the reason never reaches back further than two rounds');
});

test('once a round is on the record it is not counted twice', () => {
  const store = new ProfileStore(null);
  const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 }, store);
  g.action('BRAVO', { type: 'identify', name: 'Capt Rao' });
  run(g, 45);
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present');
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present');
  const before = g.nowFor('BRAVO');
  g.admin({ type: 'end' });
  const after = g.nowFor('BRAVO');
  eq(after.trust.UAV.fooled, before.trust.UAV.fooled, 'the console after ENDEX reads the same evidence as during play');
  eq(after.span, 1, 'one round of evidence, not two');
  ok(/last round/.test(g.judgementView('BRAVO').reason), 'and it is described as last round: ' + g.judgementView('BRAVO').reason);
});

test('an unattended seat is not put on anyone’s record', () => {
  const store = new ProfileStore(null);
  const g = start('DRILL', { duration: 60 }, store);
  run(g, 65);
  eq(store.list().length, 0, 'nobody played, so nobody is recorded as freezing');
});

test('improvement is measured round by round from real play', () => {
  const store = new ProfileStore(null);
  const answers = [
    (d) => (d.truth === 'present' ? 'absent' : 'present'),   // round 1: wrong every time, very sure
    (d) => d.truth,                                          // round 2: right every time
  ];
  for (const answer of answers) {
    const g = start('BASELINE', { redcell: 'OFF' }, store);
    g.action('ALPHA', { type: 'identify', name: 'Lt Singh' });
    run(g, 45);
    for (const v of ['DRONE_SPOOFED', 'DRONE_SPOOFED', 'SCOUT_STALE', 'DRONE_SPOOFED', 'SIGINT_FOOLED']) {
      if (g.admin({ type: 'contradiction', pid: 'ALPHA', variant: v }).error) continue;
      run(g, 2);
      const d = openFor(g, 'ALPHA');
      g.action('ALPHA', { type: 'resolve', dispute: d.id, answer: answer(d), confidence: 90 });
    }
    g.admin({ type: 'end' });
  }
  const hist = store.progress(['Lt Singh'])['Lt Singh'];
  eq(hist.length, 2, 'two rounds on record');
  gt(hist[0].brier, hist[1].brier, 'the Brier score should fall when they get better');
  gt(hist[0].n, 2, 'and each round should carry its own sample size');
});

test('records survive a restart of the server', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fogline-')), 'profiles.json');
  const a = new ProfileStore(file);
  a.record('Maj Iyer', { at: 'x', scenario: 'DRILL', callsign: 'ALPHA', calibration: { n: 3, brier: 0.2 }, trust: { UAV: { trusted: 3, distrusted: 0, fooled: 2, saved: 0, missed: 0, actedOn: 0 } }, disputes: { issued: 3, answered: 3, froze: 0 } });
  a.save();
  const b = new ProfileStore(file);
  eq(b.roundsFor('maj iyer'), 1, 'read back from disk, case-insensitive');
  eq(b.weakSpot('Maj Iyer').source, 'UAV');
});

test('a second screen on a seat cannot wipe the name of whoever is playing it', () => {
  const g = new Game('BASELINE');
  g.action('BRAVO', { type: 'identify', name: 'Capt Rao' });
  g.action('BRAVO', { type: 'identify', name: '', auto: true });      // a judge opens /trainee?pid=BRAVO on a phone
  eq(g.whoOf('BRAVO'), 'Capt Rao', 'the round must still go on Capt Rao\u2019s record');
  g.action('BRAVO', { type: 'identify', name: '' });                  // the player clears it deliberately
  eq(g.whoOf('BRAVO'), 'BRAVO');
});

test('a name is cleaned before it is used as a key', () => {
  const g = new Game('BASELINE');
  g.action('ALPHA', { type: 'identify', name: '  <script>Capt  Rao</script>  ' });
  ok(!/[<>]/.test(g.whoOf('ALPHA')), 'no markup in a name: ' + g.whoOf('ALPHA'));
  g.action('ALPHA', { type: 'identify', name: '' });
  eq(g.whoOf('ALPHA'), 'ALPHA', 'clearing the name deliberately falls back to the callsign');
});

test('the debrief carries calibration, trust and the opponent’s targeting', () => {
  const g = start('BASELINE', { redcell: 'AUTO', redcellBudget: 0 });
  g.action('BRAVO', { type: 'identify', name: 'Capt Rao' });
  run(g, 45);
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present');
  playDispute(g, 'BRAVO', 'DRONE_SPOOFED', 'present');
  g.admin({ type: 'contradiction', pid: 'BRAVO' });
  run(g, 2);
  const d = openFor(g, 'BRAVO');
  g.action('BRAVO', { type: 'resolve', dispute: d.id, answer: 'present', confidence: 95 });
  g.admin({ type: 'end' });
  const J = g.aar.players.BRAVO.judgement;
  eq(J.who, 'Capt Rao');
  eq(J.calibration.n, 3);
  eq(J.weakSpot.source, 'UAV');
  eq(J.disputeSummary.targeted, 1, 'one disagreement was aimed at the learned bias');
  eq(J.disputeSummary.fooledWhenTargeted, 1, 'and it worked');
  ok(g.aar.costOfFog.summary.some((l) => /learned/.test(l)), 'the findings say the red cell exploited a learned weakness');
  ok(g.aar.progress['Capt Rao'], 'and the round is in their progress record');
  JSON.parse(JSON.stringify(g.aar));
});

// ===========================================================================
for (const [status, name, msg] of results) {
  const tag = status === 'PASS' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${tag} ${name}` + (msg ? `\n    \x1b[31m${msg}\x1b[0m` : ''));
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
