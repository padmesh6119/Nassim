'use strict';
// Front-end contract tests. No browser needed.
//
// Part A runs the real report renderer against a real report inside a minimal DOM
// stub, so a renamed or missing field shows up as "undefined" in the output rather
// than as a blank panel in front of judges.
// Part B pins the exact field paths each screen reads out of the live views.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const T = require('../public/terrain.js');
const { Game } = require('../engine/sim');

// One fixed seed for the exercise these contracts are checked against; fuzz mode draws one.
const FUZZ = process.env.FOGLINE_FUZZ === '1';
const SEED = FUZZ ? require('crypto').randomBytes(4).readUInt32BE(0) : 4242;
if (FUZZ) console.log(`frontend contracts on seed ${SEED}`);

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); results.push(['PASS', name]); pass++; }
  catch (e) { results.push(['FAIL', name, e.message]); fail++; }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
const has = (obj, pathStr, label) => {
  let cur = obj;
  for (const part of pathStr.split('.')) {
    if (cur == null || !(part in cur)) throw new Error(`${label} is missing "${pathStr}" (stopped at "${part}")`);
    cur = cur[part];
  }
  return cur;
};

// ---------------------------------------------------------------------------
// A real exercise to render: jam one commander, deceive another, forge an order.
// ---------------------------------------------------------------------------
function buildExercise() {
  const g = new Game('DECEPTION', { duration: 90, redcell: 'AUTO', redcellBudget: 8 }, { seed: SEED });
  g.admin({ type: 'start' });
  const step = (sec) => { for (let i = 0; i < sec * 5; i++) g.tick(0.2); };
  step(10);
  g.admin({ type: 'link', pid: 'ALPHA', set: { delay: true, drop: true, garble: true } });
  step(6);
  g.admin({ type: 'fake', pid: 'BRAVO', x: 620, y: 360, etype: 'ARMOR' });
  step(3);
  g.action('BRAVO', { type: 'fire', x: 620, y: 360, rationale: 'engaging the reported armour' });
  g.admin({ type: 'forgedOrder', pid: 'CHARLIE', x: 520, y: 630 });
  step(3);
  g.action('CHARLIE', { type: 'auth', rationale: 'this order contradicts the intent' });
  g.action('ALPHA', { type: 'move', x: 300, y: 340, rationale: 'closing the crossing on my own initiative' });
  g.admin({ type: 'spoof', pid: 'BRAVO', seconds: 30 });
  g.admin({ type: 'bookmark', label: 'BRAVO fired on the phantom' });
  step(6);
  g.action('BRAVO', { type: 'uav', x: 620, y: 360, rationale: 'verify that report' });
  g.action('CHARLIE', { type: 'hold', rationale: '<img src=x onerror=alert(1)> holding "as ordered"' });  // typed by a trainee
  const tr = Object.values(g.beliefs.ALPHA.tracks)[0];
  if (tr) g.action('ALPHA', { type: 'mark', track: tr.track, mark: 'SUSPECT', rationale: 'position looks stale' });
  step(70);
  if (g.status !== 'ENDED') g.admin({ type: 'end' });
  return g;
}

const run = (g, seconds, dt = 0.2) => { for (let i = 0; i < Math.round(seconds / dt); i++) g.tick(dt); };
const start = (scenario = 'BASELINE', cfg = {}) => { const g = new Game(scenario, cfg, { seed: SEED }); g.admin({ type: 'start' }); return g; };
const clearAll = (g) => g.pids.forEach((p) => g.admin({ type: 'link', pid: p, mode: 'clear' }));

const game = buildExercise();
const aar = game.aar;

// ---------------------------------------------------------------------------
// Part A — run public/report.js for real
// ---------------------------------------------------------------------------
function makeDom() {
  const made = {};
  const mkEl = (id) => {
    const el = {
      id, innerHTML: '', textContent: '', value: '', href: '', className: '',
      style: new Proxy({}, { set: () => true, get: () => '' }),
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, removeEventListener() {}, appendChild() {}, prepend() {}, remove() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 400, right: 1000, bottom: 400 }),
      querySelector: () => mkEl('sub'),
      querySelectorAll: () => [],
      closest: () => null,
      children: [],
      focus() {},
    };
    return el;
  };
  const document = {
    getElementById: (id) => made[id] || (made[id] = mkEl(id)),
    querySelectorAll: () => [],
    querySelector: () => mkEl('q'),
    createElement: (t) => mkEl(t),
    addEventListener() {},
    body: mkEl('body'),
  };
  return { document, made };
}

function runReport(payload, runs) {
  const { document, made } = makeDom();
  const calls = [];
  const fetchStub = (url) => {
    calls.push(url);
    const reply = (body, okFlag = true) => Promise.resolve({ ok: okFlag, json: () => Promise.resolve(body) });
    if (url === '/api/runs') return reply({ runs });
    if (url === '/api/aar') return reply(payload);
    if (url.startsWith('/api/run/')) return reply(payload);
    if (url.startsWith('/api/compare')) {
      const pick = (x) => ({
        label: x.scenario.name, id: x.scenario.id, generatedAt: x.generatedAt, durationMin: x.durationMin,
        redcell: x.redcell.mode, costOfFog: x.costOfFog, outcome: x.outcome, mcScore: x.missionCommand.teamScore,
        team: { copMeanPct: x.team.copMeanPct, copWorstPct: x.team.copWorstPct, fratricide: x.team.fratricide, mutualSupport: x.team.mutualSupport },
        players: {},
      });
      return reply({ a: pick(payload), b: pick(payload) });
    }
    return reply({ error: 'not found' }, false);
  };

  const errors = [];
  const sandbox = {
    document,
    window: { TERRAIN: T, addEventListener() {} },
    TERRAIN: T,
    fetch: fetchStub,
    location: { search: '' },
    URLSearchParams,
    innerWidth: 1400, innerHeight: 900,
    Date, Math, JSON, console, String, Number, Object, Array, isNaN, parseInt, parseFloat,
    setTimeout, encodeURIComponent, decodeURIComponent,
    onUnhandled: (e) => errors.push(e),
  };
  sandbox.globalThis = sandbox;
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'report.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'report.js' });
  return { made, calls, errors };
}

// report.js renders asynchronously, so everything is asserted after a turn of the loop.
async function assertRendered() {
  const runs = [
    { id: 'a.json', generatedAt: new Date().toISOString(), scenario: 'BASELINE', scenarioName: 'TRG-1 BASELINE', fogMin: 0 },
    { id: 'b.json', generatedAt: new Date().toISOString(), scenario: 'DECEPTION', scenarioName: 'TRG-3 DECEPTION', fogMin: 4.7 },
  ];
  const { made, errors } = runReport(aar, runs);
  await new Promise((r) => setTimeout(r, 60));
  const html = made.root.innerHTML;

  test('report: no exceptions escaped the renderer', () => {
    eq(errors.length, 0, 'errors: ' + errors.join('; '));
  });

  test('report: the page actually filled with content', () => {
    ok(html.length > 6000, `only ${html.length} characters rendered`);
    ok(made.meta.textContent.includes(aar.scenario.name), 'the header should name the scenario');
  });

  test('report: no undefined or NaN leaked into the page', () => {
    // also lazy plurals: an officer reading "1 threat(s) were" stops trusting the rest
    const bad = ['undefined', 'NaN', '[object Object]', 'null%', '+null', '(s)'];
    for (const b of bad) {
      const i = html.indexOf(b);
      if (i !== -1) throw new Error(`found "${b}" at ${i}: …${html.slice(Math.max(0, i - 110), i + 70).replace(/\s+/g, ' ')}…`);
    }
  });

  test('report: the judgement layer is in the debrief when sources disagreed', () => {
    const anyDispute = Object.values(aar.players).some((P) => P.judgement.disputes.length);
    if (!anyDispute) return;
    ok(html.includes('Who did they believe?'), 'the trust section should render');
    ok(html.includes('with the truth now shown'), 'and reveal the truth of each disagreement');
  });

  test('report: every section the debrief needs is present', () => {
    for (const marker of ['The cost of fog', 'Decision timeline', 'Mission command', 'Commanders',
      'Decision log', 'Exercise log', 'Compare two exercises', 'How long an order took']) {
      ok(html.includes(marker), 'missing section: ' + marker);
    }
    for (const p of Object.keys(aar.players)) ok(html.includes(`>${p} <small>`), `missing the ${p} card`);
  });

  test('report: the headline numbers match the report data', () => {
    ok(html.includes(`${aar.costOfFog.reactionDelayMin} min`), 'the cost-of-fog figure should appear');
    ok(html.includes(`>${aar.costOfFog.blindHp}<`), 'the blind-casualty figure should appear');
    ok(html.includes(`>${aar.missionCommand.teamScore}<`), 'the mission-command score should appear');
  });

  test('report: tooltips stay inside their attribute, and typed text never becomes markup', () => {
    const tips = [...html.matchAll(/data-tip="([^"]*)"(.)/g)];
    ok(tips.length > 3, 'there should be tooltips to check');
    for (const [, , after] of tips) ok(after === '/' || after === '>', 'a quote inside a tooltip ended its attribute early');
    ok(!/<img src=x/i.test(html), 'a trainee\u2019s typed reason was rendered as markup');
    ok(!/"\/>aimed at a contact/.test(html), 'the phantom note leaked out of its tooltip');
  });

  test('report: charts rendered with real geometry', () => {
    const svgs = html.match(/<svg/g) || [];
    ok(svgs.length >= 2, `expected at least 2 charts, found ${svgs.length}`);
    ok(!/NaN|Infinity/.test(html), 'chart coordinates must be finite');
    ok((html.match(/data-tip=/g) || []).length > 3, 'chart marks should carry tooltips');
  });

  test('report: the deception and cyber injects are each traced to an outcome', () => {
    const anyFake = Object.values(aar.players).some((P) => P.fakes.length);
    const anyForged = Object.values(aar.players).some((P) => P.forged.length);
    if (anyFake) ok(/Phantom T-\d\d/.test(html), 'a phantom should be shown with its outcome');
    if (anyForged) ok(html.includes('Forged order from HQ'), 'the forged order should be shown with its outcome');
  });

  test('report: the red cell reasoning is shown, not just its actions', () => {
    if (!aar.redcell.log.length) return;
    ok(html.includes('AI red cell'), 'the red-cell section should be present');
    const withReason = aar.redcell.log.find((l) => l.reason);
    if (withReason) ok(html.includes(withReason.reason.slice(0, 40).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))), 'the reasoning text should appear verbatim');
  });

  test('report: comparison table built from two runs', () => {
    ok(made.cmpOut.innerHTML.includes('Cost of fog'), 'the comparison should list the cost of fog');
    ok(/#1b4f9c|#8f6310/.test(made.cmpOut.innerHTML), 'the comparison should use the validated chart hues');
  });

  // The across-rounds section only renders with a history, so give it one:
  // one trainee who improved, one whose habit was hunted down.
  const round = (brier, accuracy, n, issued, aimed, aimedWorked) => ({ at: 'x', scenario: aar.scenario.id, callsign: 'ALPHA', n, enough: n >= 5,
    brier, accuracy, meanConfidence: 0.8, overconfidence: 0.8 - accuracy, buckets: [], disputes: { issued, aimed, aimedWorked } });
  const withHistory = { ...aar, progress: {
    'Capt Rao': [round(0.47, 0.43, 7, 7, 0, 0), round(0.06, 1, 7, 7, 4, 0), round(0.06, 1, 3, 7, 0, 0)],
    'Maj Iyer': [round(0.34, 0.5, 6, 7, 0, 0), round(0.64, 0, 6, 7, 6, 6), round(0.64, 0, 6, 7, 6, 6)],
    'Old drill': [{ ...round(0.2, 0.7, 6, 7, 0), scenario: 'SOMETHING_ELSE' }, round(0.1, 0.9, 6, 7, 0)],
  } };
  const second = runReport(withHistory, runs);
  await new Promise((r) => setTimeout(r, 60));
  const html2 = second.made.root.innerHTML;

  test('report: improvement across rounds is drawn, and a hunted habit is explained, not hidden', () => {
    eq(second.errors.length, 0, 'errors: ' + second.errors.join('; '));
    ok(html2.includes('Getting better across rounds'), 'the section should render with a history');
    ok(/Capt Rao[\s\S]*Improving — on small samples/.test(html2), 'a falling score on a thin last round is called improving, carefully');
    ok(/Maj Iyer[\s\S]*Worse, under targeting/.test(html2), 'a rising score under attack says so');
    ok(html2.includes('6 of 7 in round 2, 6 worked; 6 of 7 in round 3, 6 worked'), 'and names the rounds the red cell aimed at the habit');
    ok(html2.includes('4 of 7 in round 2, 0 worked') && html2.includes('By round 3 it had no habit left to aim at'),
      'while someone who beat the attacks is told so, not told what the habit cost');
    for (const b of ['undefined', 'NaN', '(s)']) ok(!html2.includes(b), `found "${b}" in the across-rounds section`);
    ok(!html2.includes('Old drill'), 'one round of this scenario plus one of another is not a trend, so no chart');
  });

  // -------------------------------------------------------------------------
  // Part B — the exact fields each live screen reads
  // -------------------------------------------------------------------------
  test('a destroyed sub-unit cannot keep fighting', () => {
  const g = start('BASELINE');
  run(g, 3);
  const u = g.unit('ALPHA');
  u.hp = 0; u.alive = false;
  for (const type of ['move', 'hold', 'fire', 'uav', 'auth', 'chat', 'mark']) {
    const r = g.action('ALPHA', { type, x: 400, y: 400, text: 'x', track: 'T-01', mark: 'CONFIRMED' });
    ok(r.error, `a combat-ineffective sub-unit should not be able to ${type}`);
  }
});

test('an order needs a real point on the map', () => {
  const g = start('BASELINE');
  run(g, 3);
  for (const bad of [NaN, undefined, 'abc', Infinity, null]) {
    ok(g.action('BRAVO', { type: 'move', x: bad, y: bad }).error, `${bad} is not a grid reference`);
  }
  ok(g.action('BRAVO', { type: 'move', x: 400, y: 400 }).ok, 'a real point still works');
});

test('an order still in the air is shown to the commander who sent it', () => {
  const g = start('BASELINE', { delayMin: 12, delayMax: 18, dropRate: 0 });
  clearAll(g);
  run(g, 2);
  g.admin({ type: 'link', pid: 'BRAVO', set: { delay: true, drop: false, garble: false } });
  g.action('BRAVO', { type: 'fire', x: 500, y: 400, rationale: 'suppress the crossing' });
  run(g, 3);
  const pending = g.traineeView('BRAVO').pending;
  eq(pending.length, 1, 'the fire mission has not reached the guns yet');
  eq(pending[0].kind, 'Fire mission');
  run(g, 25);
  eq(g.traineeView('BRAVO').pending.length, 0, 'and clears once it arrives');
});

test('one disputed track raises one warning, however many reports conflict', () => {
  const g = start('BASELINE');
  clearAll(g);
  g.admin({ type: 'link', pid: 'CHARLIE', set: { delay: false, drop: false, garble: true } });
  run(g, 120);
  const warned = g.traineeView('CHARLIE').conflicts.map((c) => c.track);
  eq(warned.length, new Set(warned).size, 'a track must not be warned about twice at once');
});

test('a conflict warning points only at a track still on the commander\u2019s map', () => {
  const g = start('BASELINE');
  run(g, 5);
  g.updateBelief('ALPHA', { track: 'T-90', type: 'ARMOR', x: 300, y: 200 }, g.t, 'DRONE FEED');
  run(g, 1);
  g.updateBelief('ALPHA', { track: 'T-90', type: 'ARMOR', x: 700, y: 200 }, g.t, 'RECCE PATROL');
  eq(g.traineeView('ALPHA').conflicts.length, 1, 'two far-apart reports of one track raise a warning');
  delete g.beliefs.ALPHA.tracks['T-90'];                    // reported destroyed, or cleared by a patrol
  eq(g.traineeView('ALPHA').conflicts.length, 0, 'and once the track is gone the warning goes with it');
});

test('trainee view exposes every field the commander screen reads', () => {
    const v = game.traineeView('ALPHA');
    for (const p of ['status', 't', 'clock', 'remaining', 'scenario.name', 'scenario.brief', 'scenario.area',
      'intent.text', 'intent.commander', 'me.pid', 'me.name', 'me.x', 'me.y', 'me.hp', 'me.alive', 'me.posture',
      'tracks', 'friends', 'cleared', 'conflicts', 'pending', 'signal', 'severity', 'gpsDegraded',
      'sensorRange', 'rounds', 'effects', 'who', 'disputes', 'underFire']) has(v, p, 'traineeView');
    ok('task' in v.intent, 'traineeView.intent is missing "task"');
    ok('df' in v, 'traineeView is missing "df"');
  });

  test('instructor view exposes every field the console reads', () => {
    const v = game.instructorView();
    for (const p of ['status', 'clock', 'remaining', 'cfg.timeScale', 'cfg.sensorRange',
      'scenario.id', 'scenario.name', 'scenario.list', 'units', 'enemies', 'fakes', 'links',
      'emitters', 'ewEnabled', 'inflight', 'beliefs', 'accuracy', 'stats', 'cop', 'intent.tasks',
      'breaches', 'uav.state', 'rounds', 'effects', 'redcell.mode', 'redcell.budget', 'redcell.recs',
      'redcell.log', 'bookmarks', 'hasReport', 'fog.teamMin', 'gaps', 'judgement', 'who']) has(v, p, 'instructorView');
    for (const pid of game.pids) {
      for (const p of ['who', 'rounds', 'trust.UAV.rate', 'trust.SCOUT.rate', 'trust.SIGINT.rate', 'calibration.n', 'disputes.issued', 'open']) {
        has(v.judgement[pid], p, `instructorView.judgement.${pid}`);
      }
    }
    for (const pid of game.pids) {
      for (const p of ['severity', 'masked', 'sources', 'spoofed', 'delay', 'drop', 'garble']) {
        has(v.links[pid], p, `instructorView.links.${pid}`);
      }
      for (const p of ['hpLost', 'blindHpLost', 'dropped', 'garbled', 'decisions', 'unresolved']) {
        has(v.stats[pid], p, `instructorView.stats.${pid}`);
      }
    }
  });

  test('replay frames expose every field the replay screen reads', () => {
    const rp = aar.replay;
    for (const p of ['interval', 'frames', 'bookmarks', 'emitters', 'intent.tasks', 'pids', 'timeScale']) has(rp, p, 'replay');
    const f = rp.frames[Math.floor(rp.frames.length / 2)];
    for (const p of ['t', 'clock', 'u', 'e', 'b', 'l', 'fx']) has(f, p, 'replay frame');
    ok('uav' in f, 'replay frame is missing "uav"');
    for (const u of f.u) for (const p of ['p', 'x', 'y', 'hp', 'a']) has(u, p, 'replay frame unit');
    for (const pid of rp.pids) {
      has(f.b[pid], 'tr', `replay frame belief ${pid}`);
      has(f.b[pid], 'fr', `replay frame belief ${pid}`);
      has(f.l[pid], 's', `replay frame link ${pid}`);
      has(f.l[pid], 'acc', `replay frame link ${pid}`);
    }
    ok(rp.bookmarks.some((b) => b.label === 'BRAVO fired on the phantom'), 'the instructor mark should be in the replay');
  });

  test('every page and its assets exist on disk', () => {
    const pub = path.join(__dirname, '..', 'public');
    for (const page of ['index.html', 'trainee.html', 'instructor.html', 'report.html', 'replay.html']) {
      const html = fs.readFileSync(path.join(pub, page), 'utf8');
      for (const m of html.matchAll(/(?:src|href)="\/([^"?#]+)"/g)) {
        const ref = m[1];
        if (ref.startsWith('api/')) continue;        // API endpoints, not static files
        if (!/\.[a-z0-9]+$/i.test(ref)) continue;   // server routes like /instructor, not files
        ok(fs.existsSync(path.join(pub, ref)), `${page} references missing file /${ref}`);
      }
    }
  });

  // --- the screens are read from the back of a room, off a washed-out projector ---
  const styleFiles = () => {
    const pub = path.join(__dirname, '..', 'public');
    return ['style.css', 'index.html', 'trainee.html', 'instructor.html', 'report.html', 'replay.html']
      .map((f) => [f, fs.readFileSync(path.join(pub, f), 'utf8')]);
  };

  test('nothing on any screen is set smaller than the 13px floor', () => {
    const bad = [];
    for (const [name, src] of styleFiles()) {
      for (const m of src.matchAll(/font-size: *([0-9.]+)px/g)) {
        if (parseFloat(m[1]) < 13) bad.push(`${name}: ${m[0]}`);
      }
    }
    eq(bad.length, 0, 'below the floor — ' + bad.join(', '));
  });

  test('no rounded corners anywhere: this is staff paper, not a web app', () => {
    const bad = [];
    for (const [name, src] of styleFiles()) {
      for (const m of src.matchAll(/border-radius: *([^;}]+)/g)) {
        // a 50% circle is a map symbol, a dot; any other radius is a rounded box
        const v = m[1].trim();
        if (!/^0(px|%)?$/.test(v) && v !== '50%') bad.push(`${name}: ${m[0].trim()}`);
      }
    }
    eq(bad.length, 0, 'rounded corner — ' + bad.join(', '));
  });

  test('every ink on every paper clears the contrast a projector needs', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    const tok = (n) => {
      const m = css.match(new RegExp(`--${n}: *(#[0-9a-f]{6})`, 'i'));
      ok(m, `--${n} is not defined`);
      return m[1];
    };
    const lum = (h) => {
      const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const papers = ['paper', 'paper-2', 'collar'].map(tok);
    for (const ink of ['ink', 'ink-2', 'ink-3', 'blue', 'red', 'ochre', 'green', 'violet']) {
      for (const paper of papers) {
        const r = ratio(tok(ink), paper);
        ok(r >= 4.5, `--${ink} on ${paper} is ${r.toFixed(2)}:1, under 4.5:1`);
      }
    }
    // the rail, the desks and the curtain are dark: the paper inks vanish there
    for (const ink of ['on-board', 'on-board-2', 'on-board-hi']) {
      for (const board of ['board', 'board-2'].map(tok)) {
        const r = ratio(tok(ink), board);
        ok(r >= 4.5, `--${ink} on ${board} is ${r.toFixed(2)}:1, under 4.5:1`);
      }
    }
  });

  test('a paper ink is never used on a dark surface', () => {
    const DARK = /^\s*(\.rail\b|\.state\b|\.curtain\b|\.seats\b|\.whoami\b|\.desk\b|\.nums\b|\.ewstrip\b|\.fogread\b|\.viewtabs\b|\.btn\b|#settings\b)/;
    const bad = [];
    for (const [name, src] of styleFiles()) {
      for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!DARK.test(m[1])) continue;
        const ink = m[2].match(/(?:^|[;{\s])color: *var\(--(ink|ink-2|ink-3|red|green|ochre|blue|violet)\)/);
        if (ink) bad.push(`${name}: ${m[1].trim()} uses --${ink[1]}`);
      }
    }
    eq(bad.length, 0, 'unreadable on the board — ' + bad.join(', '));
  });

  // -------------------------------------------------------------------------
  for (const [status, name, msg] of results) {
    const tag = status === 'PASS' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`${tag} ${name}` + (msg ? `\n    \x1b[31m${msg}\x1b[0m` : ''));
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

assertRendered().catch((e) => { console.error('harness failed:', e.stack); process.exit(1); });
