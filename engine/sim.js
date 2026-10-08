'use strict';
// FOGLINE simulation core.
//
// Three things run side by side and are never allowed to be the same object:
//   1. GROUND TRUTH  — where everything actually is.
//   2. BELIEF        — what each commander's screen says, built only from what
//                      reached them over the radio, with its age and its source.
//   3. THE LEDGER    — when each commander COULD have known something versus
//                      when they did. The gap between 2 and 3 is the cost of fog.
//
// Everything a trainee sees comes from (2). Everything the AAR prices comes
// from (3). The instructor is the only one who sees (1).

const T = require('../public/terrain.js');
const { buildScenario, sanitizeConfig, SCENARIOS } = require('./scenarios');
const { CommsNet } = require('./comms');
const { EwField } = require('./ew');
const { RedCell } = require('./redcell');
const { Recorder } = require('./recorder');
const { buildReport } = require('./aar');
const { SOURCES, DISPUTABLE, VARIANTS, VARIANT_FOR, WEAKNESS_LABEL, BALANCED, attackLabel, stanceOf, majorityOf, claimText, placeFor } = require('./sources');
const { calibrate, emptyTrust, weakSpotReason } = require('./calibration');
const { ProfileStore } = require('./profile');

const DISPUTE_TTL = 50;       // real seconds a commander has to resolve a disagreement once it is in front of them
const DISPUTE_LOST = 70;      // a disagreement whose reports never arrived is withdrawn, not counted as a freeze

const PIDS = T.friendly.map((f) => f.pid);
const WEAPON_RANGE = 80;
const SURPRISE_WINDOW = 20;   // a sighting the picture did not anticipate counts as surprise for this long
const BLIND_WINDOW = 15;      // damage taken this soon after a surprise sighting is "blind" damage
const ISOLATED = 0.4;         // link severity at or above which a commander is treated as cut off
const RECOVERED = 0.2;

const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

class Game {
  constructor(scenarioId = 'CONTESTED', overrides = {}, opts = {}) {
    this.pids = PIDS;
    this.profiles = opts.profiles || new ProfileStore(null);
    this.who = {};                 // callsign → trainee name; outlives a reset, so it follows the person
    this.reset(scenarioId, overrides);
  }

  whoOf(pid) { return this.who[pid] || pid; }

  // =========================================================================
  // Lifecycle
  // =========================================================================
  reset(scenarioId = this.scenario ? this.scenario.id : 'CONTESTED', overrides = {}) {
    this.scenario = buildScenario(scenarioId, overrides);
    this.cfg = this.scenario.config;
    this.status = 'LOBBY';
    this.t = 0;
    this.seq = 0;
    this.trackSeq = 0;
    this.outbox = [];
    this.endReason = null;
    this.aar = null;
    this.startedAt = null;

    this.units = T.friendly.map((f) => ({
      pid: f.pid, name: f.name, x: f.x, y: f.y, x0: f.x, y0: f.y,
      tx: null, ty: null, hp: 100, posture: 'HOLD', alive: true,
    }));

    this.enemies = this.scenario.package.slice(0, clamp(this.cfg.intensity, 1, this.scenario.package.length)).map((e) => ({
      id: e.id, type: e.type, axis: e.axis, role: e.role, size: e.size, fp: e.fp, speed: e.speed,
      spawn: e.spawn, path: e.path, x: e.start[0], y: e.start[1],
      hp: 100 * e.size, maxHp: 100 * e.size, wp: 0, spawned: false, alive: true, track: null, atObj: false,
    }));

    this.ew = new EwField(this.scenario.emitters, this.cfg.ewEnabled);
    this.manual = Object.fromEntries(PIDS.map((p) => [p, { delay: false, drop: false, garble: false }]));
    this.jamSince = Object.fromEntries(PIDS.map((p) => [p, null]));
    this.spoofed = Object.fromEntries(PIDS.map((p) => [p, 0]));
    this.spoofVec = Object.fromEntries(PIDS.map((p) => [p, null]));

    this.comms = new CommsNet(this.cfg, {
      linkProfile: (pid) => this.linkProfile(pid),
      onDeliver: (d) => this.deliver(d),
      onDrop: () => {},
    });
    this.comms.register(PIDS);

    this.beliefs = Object.fromEntries(PIDS.map((p) => [p, { tracks: {}, friends: {}, cleared: [], killed: {} }]));
    this.inbox = Object.fromEntries(PIDS.map((p) => [p, []]));

    this.events = [];
    this.decisions = [];
    this.interventions = [];
    this.series = [];
    this.triggers = [];       // new information → the order that answered it
    this.engagements = {};
    this.sighted = {};
    this.surprise = {};
    this.relayAt = {};
    this.lastReport = Object.fromEntries(PIDS.map((p) => [p, {}]));

    // Measurement buckets the AAR reads.
    this.stats = Object.fromEntries(PIDS.map((p) => [p, {
      hpLost: 0, blindHpLost: 0, wastedRounds: 0, phantomActions: 0, kills: 0,
      jammedSec: 0, maskedSec: 0, isolatedSec: 0, coveredSec: 0, aliveSec: 0, manoeuvredOut: 0,
    }]));
    this.conflicts = Object.fromEntries(PIDS.map((p) => [p, []]));
    this.forgedOrders = Object.fromEntries(PIDS.map((p) => [p, []]));
    this.falseBdas = Object.fromEntries(PIDS.map((p) => [p, []]));
    this.isolationSpans = Object.fromEntries(PIDS.map((p) => [p, []]));
    this.driftOrders = Object.fromEntries(PIDS.map((p) => [p, []]));
    this.breaches = [];
    this.mutualSupport = [];
    this.nearMiss = [];
    this.fakes = [];
    this.disputes = [];
    this.judgements = [];
    this.trust = Object.fromEntries(PIDS.map((p) => [p, {}]));
    this.disputeStats = Object.fromEntries(PIDS.map((p) => [p, { issued: 0, answered: 0, froze: 0, correct: 0, saidPresent: 0, saidAbsent: 0, againstClear: 0, againstEnemy: 0, answerSecs: [] }]));
    this.nextDispute = Object.fromEntries(PIDS.map((p, i) => [p, 14 + i * 7]));
    this.actedOn = new Set();
    this.recorded = new Set();      // seats whose round is already on their record
    this.engaged = new Set();
    this.fires = [];
    this.uavReqs = [];
    this.authReqs = [];
    this.effects = [];
    this.cop = [];
    this.accuracy = Object.fromEntries(PIDS.map((p) => [p, { acc: 1, missing: 0, phantom: 0, err: 0 }]));
    this.rounds = this.cfg.artilleryRounds;
    this.uav = { x: T.hq.x, y: T.hq.y, state: 'IDLE', target: null, requester: null, until: 0, queue: null };

    this.recorder = new Recorder(1);
    this.redcell = new RedCell(this);

    this.lastIsr = -99; this.lastBft = -99; this.lastSample = -99;
    this.emit('all', 'reset', { scenario: this.scenarioBrief() });
  }

  scenarioBrief() {
    return {
      id: this.scenario.id, name: this.scenario.name, brief: this.scenario.brief,
      area: this.scenario.area, intent: this.scenario.intent,
      list: SCENARIOS.map((s) => ({ id: s.id, name: s.name })),
    };
  }

  // =========================================================================
  // Small helpers
  // =========================================================================
  emit(to, event, data) { this.outbox.push({ to, event, data }); }
  unit(pid) { return this.units.find((u) => u.pid === pid); }
  mm(realSec) { return (realSec * this.cfg.timeScale) / 60; }      // real seconds → mission minutes
  missionClock(t = this.t) {
    const s = Math.floor(t * this.cfg.timeScale) + 6 * 3600;
    return String(Math.floor(s / 3600) % 24).padStart(2, '0') + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  nextTrack() { return 'T-' + String(++this.trackSeq).padStart(2, '0'); }
  ensureTrack(e) { if (!e.track) e.track = this.nextTrack(); return e.track; }
  intentTaskFor(pid) { return this.scenario.intent.tasks.find((k) => k.pid === pid) || null; }
  degraded(pid) { return this.linkProfile(pid).severity > 0; }

  logEvent(kind, text, extra = {}) {
    const ev = { t: r1(this.t), clock: this.missionClock(), kind, text, ...extra };
    this.events.push(ev);
    this.emit('instructor', 'feed', ev);
    if (extra.severity === 'high') this.recorder.bookmark(this.t, kind, text, extra.pid || null, ev.clock);
    return ev;
  }

  // A commander's link quality: the instructor's switches OR'd with the EW field
  // at wherever that commander currently is. Walking out of a jammer works.
  linkProfile(pid) {
    const u = this.unit(pid);
    const m = this.manual[pid];
    const manual = m.delay || m.drop || m.garble;
    const field = u && u.alive ? this.ew.jamAt(u) : { severity: 0, masked: false, emitter: null };
    const sources = [];
    if (manual) sources.push('MANUAL');
    if (field.severity > 0) sources.push('EW');
    return {
      sevDelay: Math.max(m.delay ? 1 : 0, field.severity),
      sevDrop: Math.max(m.drop ? 1 : 0, field.severity),
      sevGarble: Math.max(m.garble ? 1 : 0, field.severity),
      severity: Math.max(manual ? 1 : 0, field.severity),
      masked: field.masked, emitter: field.emitter ? field.emitter.id : null, sources,
    };
  }

  // =========================================================================
  // Belief — the only thing a trainee ever sees
  // =========================================================================
  deliver(d) {
    const pid = d.to, b = this.beliefs[pid];

    if (d.kind === 'BFT') {
      const cur = b.friends[d.from];
      if (!cur || cur.infoT < d.sentT) b.friends[d.from] = { x: d.pos.x, y: d.pos.y, infoT: d.sentT, garbled: !!d.posGarbled, spoofed: !!d.spoofed };
      return;
    }
    if (d.kill) {
      delete b.tracks[d.kill];
      b.killed[d.kill] = d.sentT;
      if (d.falseBda) {
        const rec = this.falseBdas[pid].find((f) => f.track === d.kill && !f.received);
        if (rec) { rec.received = true; rec.receivedT = this.t; }
      }
    }
    if (d.contacts) for (const k of d.contacts) this.updateBelief(pid, k, d.sentT, d.from, d.garbled && k.garbled, d.source);
    if (d.claim) {
      const dp = this.disputes.find((x) => x.id === d.claim.id);
      const c = dp && dp.claims.find((x) => x.source === d.claim.source);
      if (c && !c.delivered) {
        c.delivered = true;
        if (dp.readyT == null && dp.claims.filter((x) => x.delivered).length >= 2) dp.readyT = this.t;
      }
    }
    if (d.clearArea) b.cleared.push({ ...d.clearArea, t: this.t });
    if (d.order) {
      const rec = this.forgedOrders[pid].find((f) => f.id === d.order.id);
      if (rec) { rec.received = true; rec.receivedT = this.t; rec.receivedClock = this.missionClock(); }
    }

    const m = {
      id: d.id, kind: d.kind, from: d.from, text: d.text,
      sentClock: this.missionClock(d.sentT), rcvdClock: this.missionClock(),
      lag: r1(this.mm(this.t - d.sentT)), garbled: d.garbled, source: d.source || null,
      authenticated: d.kind === 'ORDER' ? false : undefined,
    };
    this.inbox[pid].push(m);
    if (this.inbox[pid].length > 120) this.inbox[pid].shift();
    this.emit(pid, 'msg', m);
  }

  updateBelief(pid, k, infoT, src, garbled, source = null) {
    const b = this.beliefs[pid];
    const cur = b.tracks[k.track];
    if (cur && cur.infoT > infoT) return;                       // older news than we already hold
    if (!cur && b.killed[k.track] != null && b.killed[k.track] > infoT) return; // stale report of a confirmed kill

    // Two reports of the same track, close in time, far apart in space: this is
    // what "contradictory information" actually looks like to a commander.
    if (src !== 'VISUAL') {
      const prev = this.lastReport[pid][k.track];
      if (prev && this.t - prev.t < 20 && Math.hypot(prev.x - k.x, prev.y - k.y) > 100) {
        this.conflicts[pid].push({
          track: k.track, t: r1(this.t), clock: this.missionClock(),
          gapM: Math.round(Math.hypot(prev.x - k.x, prev.y - k.y) * T.UNIT_M),
          a: { x: Math.round(prev.x), y: Math.round(prev.y), src: prev.src },
          b: { x: Math.round(k.x), y: Math.round(k.y), src },
          resolvedT: null, resolvedBy: null,
        });
      }
      this.lastReport[pid][k.track] = { x: k.x, y: k.y, t: this.t, src };
    }

    if (!cur) {
      this.triggers.push({ pid, t: this.t, track: k.track, fake: !!k.fake, degraded: this.degraded(pid), reactedAt: null });
      if (k.enemyId) this.comms.awareness.markActual(pid, k.enemyId, this.t);
    }

    b.tracks[k.track] = {
      track: k.track, type: k.type, x: k.x, y: k.y, infoT, src,
      garbled: !!garbled, fake: !!k.fake, enemyId: k.enemyId || null,
      mark: cur ? cur.mark : 'UNK', firstT: cur ? cur.firstT : this.t,
      source: source || (cur ? cur.source : null),
      notObserved: src === 'VISUAL' ? null : (cur ? cur.notObserved : null),
    };
  }

  resolveConflicts(pid, by, near) {
    for (const c of this.conflicts[pid]) {
      if (c.resolvedT != null) continue;
      if (this.t - c.t > 60) continue;
      if (near && dist(near, c.a) > 170 && dist(near, c.b) > 170) continue;
      c.resolvedT = r1(this.t); c.resolvedBy = by;
    }
  }

  // =========================================================================
  // Tick
  // =========================================================================
  tick(dt) {
    if (this.status !== 'RUNNING') return;
    this.t += dt;
    const c = this.cfg;

    this.comms.tick(this.t);
    this.moveEnemies(dt);
    this.moveFriendlies(dt);
    this.visualSweep();
    this.combat(dt);
    this.processFires();
    this.processUav(dt);
    this.processAuth();

    if (this.t - this.lastIsr >= c.isrInterval) { this.lastIsr = this.t; this.isrBroadcast(); }
    if (this.t - this.lastBft >= 3) { this.lastBft = this.t; this.bftBroadcast(); }

    this.redcell.tick(this.t);
    this.tickDisputes();

    if (this.t - this.lastSample >= 1) { this.lastSample = this.t; this.sample(dt); }
    if (this.recorder.due(this.t)) this.recorder.capture(this.t, this);
    this.effects = this.effects.filter((f) => this.t - f.t < 3);

    if (this.t >= c.duration) this.end('Exercise time expired');
    else if (this.units.every((u) => !u.alive)) this.end('All friendly sub-units combat ineffective');
    else if (this.enemies.every((e) => e.spawned && !e.alive)) this.end('Enemy force destroyed');
  }

  moveEnemies(dt) {
    for (const e of this.enemies) {
      if (!e.spawned) {
        if (this.t >= e.spawn) {
          e.spawned = true;
          this.logEvent('truth', `Enemy ${e.type} (${e.id}) enters AO on ${e.axis} axis`);
        }
        continue;
      }
      if (!e.alive) continue;
      if (this.units.some((u) => u.alive && dist(u, e) <= WEAPON_RANGE)) continue;   // fixed by fire
      if (e.wp >= e.path.length) continue;
      const [wx, wy] = e.path[e.wp];
      const dx = wx - e.x, dy = wy - e.y, dd = Math.hypot(dx, dy) || 1;
      const sp = 9 * e.speed * this.cfg.enemySpeed * (T.inForest(e.x, e.y) ? 0.6 : 1) * dt;
      if (dd <= sp) { e.x = wx; e.y = wy; e.wp++; } else { e.x += (dx / dd) * sp; e.y += (dy / dd) * sp; }

      // Did it get through an area somebody was told to deny?
      for (const task of this.scenario.intent.tasks) {
        const inside = dist(e, task.area) < task.area.r;
        const key = task.id + '|' + e.id;
        if (inside && !this.breaches.some((b) => b.key === key)) {
          const u = this.unit(task.pid);
          const covered = u.alive && dist(u, task.area) < task.area.r * 1.5;
          this.breaches.push({ key, taskId: task.id, pid: task.pid, enemy: e.id, type: e.type, t: r1(this.t), clock: this.missionClock(), covered });
          if (!covered) this.logEvent('intent', `INTENT BREACH — ${e.type} ${e.track || e.id} entered ${task.text.replace(/^Deny |^Retain /, '')} with ${task.pid} out of position`, { pid: task.pid, severity: 'high' });
        }
      }
      if (e.wp >= e.path.length && !e.atObj) {
        e.atObj = true;
        this.logEvent('combat', `OBJECTIVE THREATENED — enemy ${e.type} reached ${T.town.name}`, { severity: 'high' });
      }
    }
  }

  moveFriendlies(dt) {
    for (const u of this.units) {
      if (!u.alive || u.tx == null) continue;
      const dx = u.tx - u.x, dy = u.ty - u.y, dd = Math.hypot(dx, dy) || 1;
      const sp = 15 * (T.inForest(u.x, u.y) ? 0.6 : 1) * dt;
      if (dd <= sp) { u.x = u.tx; u.y = u.ty; u.tx = u.ty = null; u.posture = 'HOLD'; }
      else { u.x += (dx / dd) * sp; u.y += (dy / dd) * sp; }
    }
  }

  visualSweep() {
    const c = this.cfg;
    for (const u of this.units) {
      if (!u.alive) continue;
      const b = this.beliefs[u.pid];
      for (const e of this.enemies) {
        if (!e.spawned || !e.alive) continue;
        const d = dist(u, e);
        this.comms.awareness.markDist(u.pid, e.id, d);
        const range = c.sensorRange * (T.inForest(e.x, e.y) ? 0.5 : 1);
        const sk = u.pid + '|' + e.id;
        if (d > range) { this.sighted[sk] = false; continue; }

        const track = this.ensureTrack(e);
        const isNew = !b.tracks[track];
        if (!this.sighted[sk]) {
          this.sighted[sk] = true;
          const prior = b.tracks[track];
          // Did their picture anticipate this, roughly in the right place?
          if (!prior || prior.mark === 'DISMISSED' || dist(prior, e) > 100) this.surprise[sk] = this.t;
        }
        this.comms.awareness.markIdeal(u.pid, e.id, this.t);
        this.updateBelief(u.pid, { track, type: e.type, x: e.x, y: e.y, enemyId: e.id }, this.t, 'VISUAL', false, 'EYES');
        if (isNew) {
          const m = { id: ++this.seq, kind: 'CONTACT', from: 'OWN OBS', text: `CONTACT! ${track} ${e.type} at ${T.gridRef(e.x, e.y)} — eyes on`, sentClock: this.missionClock(), rcvdClock: this.missionClock(), lag: 0 };
          this.inbox[u.pid].push(m);
          this.emit(u.pid, 'msg', m);
        }
        // Standard reporting: pass own-eyes contacts to the rest of the team.
        const rk = u.pid + '|' + e.id;
        if (!this.relayAt[rk] || this.t - this.relayAt[rk] >= 6) {
          this.relayAt[rk] = this.t;
          const text = `SPOTREP ${track}: ${e.type} grid ${T.gridRef(e.x, e.y)} (eyes on)`;
          for (const p of PIDS) {
            if (p === u.pid) continue;
            this.comms.send(p, { kind: 'SPOTREP', from: u.pid, source: 'SCOUT', text, contacts: [{ track, type: e.type, x: e.x, y: e.y, enemyId: e.id }] }, u.pid);
          }
        }
      }
      // Something was reported here and we can see it is not there.
      for (const tr of Object.values(b.tracks)) {
        if (tr.src === 'VISUAL' && this.t - tr.infoT < 0.5) continue;
        if (dist(u, tr) < c.sensorRange * 0.85 && !this.enemies.some((e) => e.alive && e.spawned && dist(e, tr) < 60)) {
          if (!tr.notObserved) tr.notObserved = this.t;
        }
      }
    }
  }

  combat(dt) {
    for (const e of this.enemies) {
      if (!e.spawned || !e.alive) continue;
      for (const u of this.units) {
        if (!u.alive || !e.alive || dist(u, e) > WEAPON_RANGE) continue;
        const key = u.pid + '|' + e.id;
        let eng = this.engagements[key];
        if (!eng) {
          const sp = this.surprise[key];
          const surprised = sp != null && this.t - sp < SURPRISE_WINDOW;
          eng = this.engagements[key] = { start: this.t, surprised };
          this.logEvent('combat', `${u.pid} in contact with ${e.type} ${e.track || e.id}${surprised ? ' — SURPRISED, threat was not on their picture' : ''}`, { pid: u.pid, severity: surprised ? 'high' : 'med' });
        }
        const blind = eng.surprised && this.t - eng.start < BLIND_WINDOW;
        const hold = u.posture === 'HOLD';
        const toUnit = 2.2 * e.fp * dt * (hold ? 0.7 : 1) * (blind ? 1.6 : 1);
        const toEnemy = 3.2 * dt * (hold ? 1.3 : 1) * (blind ? 0.6 : 1);
        u.hp -= toUnit; e.hp -= toEnemy;
        this.stats[u.pid].hpLost += toUnit;
        if (blind) this.stats[u.pid].blindHpLost += toUnit;
        if (e.hp <= 0) this.killEnemy(e, u.pid, '');
        if (u.hp <= 0 && u.alive) {
          u.alive = false; u.hp = 0; u.tx = u.ty = null; u.diedT = this.t;
          this.logEvent('combat', `${u.pid} combat ineffective`, { pid: u.pid, severity: 'high' });
        }
      }
    }
  }

  // Kill confirmation travels by radio like everything else — a jammed
  // commander keeps a dead enemy on their map.
  killEnemy(e, byPid, how) {
    if (!e.alive) return;
    e.alive = false;
    this.stats[byPid].kills++;
    const track = this.ensureTrack(e);
    this.logEvent('combat', `${e.type} ${track} destroyed by ${how}${byPid}`, { pid: byPid });
    delete this.beliefs[byPid].tracks[track];
    this.beliefs[byPid].killed[track] = this.t;
    for (const p of PIDS) {
      if (p === byPid) continue;
      this.comms.send(p, { kind: 'BDA', from: 'BN HQ', text: `BDA: ${track} ${e.type} DESTROYED by ${byPid}`, kill: track });
    }
  }

  isrBroadcast() {
    const contacts = [];
    for (const e of this.enemies) {
      if (!e.spawned || !e.alive || Math.random() > 0.85) continue;
      const track = this.ensureTrack(e);
      contacts.push({ track, type: e.type, x: clamp(e.x + rand(-12, 12), 0, T.W), y: clamp(e.y + rand(-12, 12), 0, T.H), enemyId: e.id });
    }
    if (!contacts.length) return;
    const text = 'DRONE FEED: ' + contacts.map((k) => `${k.track} ${k.type} ${T.gridRef(k.x, k.y)}`).join(' | ');
    for (const p of PIDS) this.comms.send(p, { kind: 'ISR', from: 'DRONE FEED', source: 'UAV', text, contacts });
  }

  bftBroadcast() {
    for (const u of this.units) {
      if (!u.alive) continue;
      // GPS spoofing (emitter field or a red-cell action) falsifies the position
      // this unit reports about itself — teammates plan around a ghost.
      const spoof = this.ew.spoofAt(u);
      const active = this.spoofed[u.pid] > this.t || spoof.severity > 0.3;
      let pos = { x: u.x, y: u.y };
      if (active) {
        if (!this.spoofVec[u.pid]) {
          const a = rand(0, Math.PI * 2), r = rand(95, 165);
          this.spoofVec[u.pid] = { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
        }
        const v = this.spoofVec[u.pid];
        pos = { x: clamp(u.x + v.dx, 5, T.W - 5), y: clamp(u.y + v.dy, 5, T.H - 5) };
      } else this.spoofVec[u.pid] = null;

      for (const p of PIDS) {
        if (p === u.pid) continue;
        this.comms.send(p, { kind: 'BFT', from: u.pid, text: '', pos, spoofed: active }, u.pid);
      }
    }
  }

  // HQ answers authentication challenges. A forged order fails the check — but
  // only if the reply gets through.
  processAuth() {
    for (const r of this.authReqs) {
      if (r.done || this.t < r.arriveAt) continue;
      r.done = true;
      const forged = this.forgedOrders[r.pid].filter((f) => f.received && (!r.orderId || f.id === r.orderId));
      const target = forged[forged.length - 1];
      if (target) {
        target.authAnsweredAt = this.t;
        this.comms.send(r.pid, { kind: 'AUTH', from: 'BN HQ', text: `AUTHENTICATION: NEGATIVE — this HQ issued NO order to reposition to ${target.grid}. Disregard. Suspect hostile injection on your net.`, authReply: 'NEGATIVE' });
        this.logEvent('intent', `${r.pid} challenged the forged order — HQ replied NEGATIVE`, { pid: r.pid, severity: 'low' });
      } else {
        this.comms.send(r.pid, { kind: 'AUTH', from: 'BN HQ', text: 'AUTHENTICATION: AFFIRMATIVE — last order from this HQ is valid.', authReply: 'AFFIRMATIVE' });
      }
    }
    this.authReqs = this.authReqs.filter((r) => !r.done);
  }

  processFires() {
    for (const f of this.fires) {
      if (!f.shotSent && this.t >= f.arriveAt) {
        f.shotSent = true;
        if (this.rounds <= 0) {
          f.done = true;
          this.comms.send(f.pid, { kind: 'FIRES', from: 'FIRES', text: 'FIRES: NO ROUNDS AVAILABLE — request denied' });
          continue;
        }
        this.rounds--;
        f.impactAt = this.t + 4;
        this.comms.send(f.pid, { kind: 'FIRES', from: 'FIRES', text: `FIRES: SHOT grid ${T.gridRef(f.x, f.y)}, splash 30 sec. Rounds remaining ${this.rounds}` });
      }
      if (f.impactAt && !f.done && this.t >= f.impactAt) {
        f.done = true;
        this.effects.push({ x: f.x, y: f.y, t: this.t, kind: 'arty' });
        let hit = 0;
        for (const e of this.enemies) {
          if (!e.spawned || !e.alive || dist(e, f) >= 60) continue;
          e.hp -= 50; hit++;
          if (e.hp <= 0) this.killEnemy(e, f.pid, 'artillery ');
        }
        for (const u of this.units) {
          if (!u.alive) continue;
          const d = dist(u, f);
          if (d < 60) {
            u.hp -= 30; this.stats[u.pid].hpLost += 30;
            const believed = this.beliefs[f.pid].friends[u.pid];
            const spoofFactor = believed && dist(believed, u) > 80;
            this.logEvent('combat', `FRATRICIDE — ${u.pid} hit by ${f.pid}'s artillery${spoofFactor ? ' (their position report was falsified)' : ''}`, { pid: u.pid, severity: 'high' });
            this.nearMiss.push({ t: r1(this.t), clock: this.missionClock(), by: f.pid, on: u.pid, m: Math.round(d * T.UNIT_M), hit: true, spoofed: !!spoofFactor });
            if (u.hp <= 0 && u.alive) {
            u.alive = false; u.hp = 0; u.tx = u.ty = null; u.diedT = this.t;
            this.logEvent('combat', `${u.pid} combat ineffective, by own artillery`, { pid: u.pid, severity: 'high' });
          }
          } else if (d < 130 && u.pid !== f.pid) {
            this.nearMiss.push({ t: r1(this.t), clock: this.missionClock(), by: f.pid, on: u.pid, m: Math.round(d * T.UNIT_M), hit: false, spoofed: false });
            this.logEvent('fires', `DANGER CLOSE — ${f.pid}'s artillery landed ${Math.round(d * T.UNIT_M)} m from ${u.pid}`, { pid: f.pid, severity: 'med' });
          }
        }
        const phantom = this.fakes.find((fk) => fk.to === f.pid && dist(fk, f) < 120);
        if (!hit) {
          this.stats[f.pid].wastedRounds++;
          if (phantom) this.stats[f.pid].phantomActions++;
        }
        this.logEvent('fires', `Artillery impact ${T.gridRef(f.x, f.y)} (${f.pid}) — ${hit ? `${hit} enemy ${hit === 1 ? 'group' : 'groups'} hit` : phantom ? `round wasted on phantom ${phantom.track}` : 'no effect, empty ground'}`, { pid: f.pid, severity: hit ? 'low' : 'med' });
      }
    }
    this.fires = this.fires.filter((f) => !f.done);
  }

  processUav(dt) {
    const v = this.uav;
    for (const r of this.uavReqs) {
      if (r.done || this.t < r.arriveAt) continue;
      r.done = true;
      if (v.state !== 'IDLE' || v.queue) this.comms.send(r.pid, { kind: 'UAVREP', from: 'UAV', text: `UAV BUSY (${v.state}) — request ${T.gridRef(r.x, r.y)} not actioned, resubmit` });
      else {
        v.queue = { target: { x: r.x, y: r.y }, requester: r.pid };
        this.comms.send(r.pid, { kind: 'UAVREP', from: 'UAV', text: `UAV TASKED to ${T.gridRef(r.x, r.y)}, on station shortly` });
      }
    }
    this.uavReqs = this.uavReqs.filter((r) => !r.done);

    if (v.state === 'IDLE' && v.queue) { v.target = v.queue.target; v.requester = v.queue.requester; v.queue = null; v.state = 'ENROUTE'; }
    if (v.state === 'ENROUTE') {
      const dx = v.target.x - v.x, dy = v.target.y - v.y, dd = Math.hypot(dx, dy) || 1, sp = 70 * dt;
      if (dd <= sp) { v.x = v.target.x; v.y = v.target.y; v.state = 'SCAN'; v.until = this.t + 3; }
      else { v.x += (dx / dd) * sp; v.y += (dy / dd) * sp; }
    } else if (v.state === 'SCAN' && this.t >= v.until) {
      const R = 130;
      const found = this.enemies.filter((e) => e.spawned && e.alive && dist(e, v.target) < R);
      const contacts = found.map((e) => ({ track: this.ensureTrack(e), type: e.type, x: e.x, y: e.y, enemyId: e.id }));
      const g = T.gridRef(v.target.x, v.target.y);
      const text = contacts.length
        ? `UAVREP ${g}: ${contacts.map((k) => `${k.track} ${k.type} ${T.gridRef(k.x, k.y)}`).join(' | ')}`
        : `UAVREP ${g}: NO CONTACT within 1.3 km — area clear`;
      this.comms.send(v.requester, { kind: 'UAVREP', from: 'UAV', source: 'UAV', text, contacts, clearArea: contacts.length ? null : { x: v.target.x, y: v.target.y, r: R } });
      this.logEvent('isr', `UAV sweep ${g} for ${v.requester}: ${contacts.length ? `${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'}` : 'no contact'}`, { pid: v.requester });
      v.state = 'RTB'; v.target = { x: T.hq.x, y: T.hq.y };
    } else if (v.state === 'RTB') {
      const dx = v.target.x - v.x, dy = v.target.y - v.y, dd = Math.hypot(dx, dy) || 1, sp = 90 * dt;
      if (dd <= sp) { v.x = v.target.x; v.y = v.target.y; v.state = 'IDLE'; }
      else { v.x += (dx / dd) * sp; v.y += (dy / dd) * sp; }
    }
  }

  // =========================================================================
  // Measurement
  // =========================================================================
  computeAccuracy(pid) {
    const b = this.beliefs[pid];
    const live = this.enemies.filter((e) => e.spawned && e.alive);
    let errSum = 0, missing = 0, phantom = 0, posErr = 0, matched = 0;
    for (const e of live) {
      const tr = e.track && b.tracks[e.track];
      if (!tr || tr.mark === 'DISMISSED') { missing++; errSum += 1; continue; }
      const d = dist(tr, e);
      posErr += d; matched++;
      errSum += Math.min(d / 250, 1);
    }
    for (const tr of Object.values(b.tracks)) {
      if (tr.mark === 'DISMISSED') continue;
      const e = tr.enemyId && this.enemies.find((x) => x.id === tr.enemyId);
      if (tr.fake || (e && !e.alive)) phantom++;
    }
    const n = live.length + phantom;
    return { acc: n ? clamp(1 - (errSum + phantom) / n, 0, 1) : 1, missing, phantom, err: matched ? (posErr / matched) * T.UNIT_M : 0 };
  }

  // Running cost of fog, so the instructor can watch it climb. Same arithmetic
  // the AAR uses: for every threat that has come close, how much later the
  // commander learned of it than they could have on a clear net.
  liveFog() {
    const per = {}; let team = 0, never = 0;
    for (const pid of PIDS) {
      let sec = 0, miss = 0;
      for (const e of this.enemies) {
        const aw = this.comms.awareness.get(pid, e.id);
        if (aw.ideal == null || aw.minDist > 250) continue;
        if (aw.actual == null) { sec += this.t - aw.ideal; miss++; }
        else sec += Math.max(0, aw.actual - aw.ideal);
      }
      per[pid] = { min: r1(this.mm(sec)), unseen: miss };
      team += sec; never += miss;
    }
    return { teamMin: r1(this.mm(team)), never, per };
  }

  // What a commander's picture is wrong about, right now, in plain words — so
  // the gap between the two sheets can be read rather than inferred.
  gapNotes(pid) {
    const b = this.beliefs[pid], notes = [];
    const self = this.unit(pid);
    if (!self.alive) {
      return [{ kind: 'bad', text: `${pid} is combat ineffective${self.diedT != null ? ` since ${this.missionClock(self.diedT)}` : ''} — this is the last picture they had` }];
    }
    const live = this.enemies.filter((e) => e.spawned && e.alive);
    const u = this.unit(pid);
    const unseen = live.filter((e) => {
      const tr = e.track && b.tracks[e.track];
      return !tr || tr.mark === 'DISMISSED';
    });
    const near = unseen.filter((e) => dist(u, e) < 260);
    if (unseen.length) {
      notes.push({ kind: 'bad', text: `${unseen.length} live ${unseen.length === 1 ? 'enemy is' : 'enemies are'} not on their map${near.length ? `, ${near.length} within 2.6 km of them` : ''}` });
    }
    let worst = null;
    for (const e of live) {
      const tr = e.track && b.tracks[e.track];
      if (!tr || tr.mark === 'DISMISSED') continue;
      const d = dist(tr, e);
      if (!worst || d > worst.d) worst = { d, track: tr.track };
    }
    if (worst && worst.d > 40) notes.push({ kind: 'bad', text: `they have ${worst.track} ${Math.round(worst.d * T.UNIT_M)} m from where it actually is` });
    const phantoms = Object.values(b.tracks).filter((tr) => tr.fake && tr.mark !== 'DISMISSED');
    if (phantoms.length) notes.push({ kind: 'adv', text: `${phantoms.length} contact${phantoms.length === 1 ? '' : 's'} on their map ${phantoms.length === 1 ? 'does' : 'do'} not exist` });
    const ghosts = Object.values(b.tracks).filter((tr) => {
      const e = tr.enemyId && this.enemies.find((x) => x.id === tr.enemyId);
      return e && !e.alive && tr.mark !== 'DISMISSED';
    });
    if (ghosts.length) notes.push({ kind: 'adv', text: `${ghosts.length} enemy they are still watching ${ghosts.length === 1 ? 'is' : 'are'} already destroyed` });
    const stale = Object.values(b.tracks).filter((tr) => this.mm(this.t - tr.infoT) > 3 && tr.mark !== 'DISMISSED');
    if (stale.length) notes.push({ kind: 'warn', text: `${stale.length} track${stale.length === 1 ? ' is' : 's are'} over 3 minutes old` });
    if (!notes.length) notes.push({ kind: 'ok', text: 'their picture matches the ground' });
    return notes;
  }

  // =========================================================================
  // Sources in disagreement, and the commander's judgement of them
  // =========================================================================

  // 50–100 from the commander's confidence chips, as a probability; null if not given.
  confidenceOf(v) {
    if (v == null || v === '' || !Number.isFinite(+v)) return null;
    return clamp(+v, 50, 100) / 100;
  }

  // Is there really enemy where this report says? A report placing armour 1.5 km
  // from where it actually is was not true, so position counts, not just existence.
  truthAt(pos) {
    return this.enemies.some((e) => e.spawned && e.alive && dist(e, pos) < 150) ? 'present' : 'absent';
  }

  addTrust(pid, source, agreed, sourceWasRight) {
    if (!DISPUTABLE.includes(source)) return;
    const t = this.trust[pid][source] || (this.trust[pid][source] = emptyTrust());
    if (agreed) { t.trusted++; if (!sourceWasRight) t.fooled++; }
    else { t.distrusted++; if (sourceWasRight) t.missed++; else t.saved++; }
  }

  // What this commander has shown lately: their last rounds under this name,
  // with this one counted live until it is on the record.
  liveFor(pid) { return this.recorded.has(pid) ? null : { trust: this.trust[pid], disputes: this.disputeStats[pid] }; }
  nowFor(pid) { return this.profiles.now(this.whoOf(pid), this.liveFor(pid)); }
  weakSpotFor(pid) { return this.profiles.weakSpot(this.whoOf(pid), this.liveFor(pid)); }
  reasonFor(pid, w) { const n = this.nowFor(pid); return weakSpotReason(this.whoOf(pid), w, n.span, n.live); }

  // The adaptive opponent: when the red cell is on and the commander has a
  // pattern, the disagreement is built so the source they over-trust is the
  // one that lies. Otherwise the three kinds rotate, so a first round measures
  // every source evenly rather than teaching a pattern by accident.
  chooseVariant(pid) {
    if (this.cfg.redcell !== 'OFF') {
      const w = this.weakSpotFor(pid);
      if (w) {
        const ways = VARIANT_FOR[w.source];
        return { variant: ways[this.disputeStats[pid].issued % ways.length], targeted: { source: w.source, probe: !!w.probe, reason: this.reasonFor(pid, w) } };
      }
    }
    const i = this.disputeStats[pid].issued + PIDS.indexOf(pid) * 2;
    return { variant: BALANCED[i % BALANCED.length], targeted: null };
  }

  contradiction(pid, opts = {}) {
    if (!PIDS.includes(pid)) return { error: 'unknown callsign' };
    if (!this.unit(pid).alive) return { error: `${pid} is combat ineffective` };
    if (this.status !== 'RUNNING') return { error: 'Exercise is not running' };
    if (this.disputes.some((d) => d.pid === pid && !d.answer && !d.froze && !d.lost)) {
      return { error: `${pid} already has a disagreement in front of them` };
    }

    let pick = opts.variant && VARIANTS[opts.variant] ? { variant: opts.variant, targeted: null } : this.chooseVariant(pid);
    let place = placeFor(this, pid, VARIANTS[pick.variant].truth);
    let note = null;
    if (!place) {
      // Nothing on the ground can carry a "the enemy really is there" case yet:
      // the same habit attacked the other way if it can be, otherwise untargeted.
      const empty = (list) => list.find((k) => VARIANTS[k].truth === 'absent');
      const aimed = pick.targeted ? empty(VARIANT_FOR[pick.targeted.source] || []) : null;
      const fallback = aimed || empty([pick.variant]) || empty(BALANCED.slice(this.disputeStats[pid].issued % BALANCED.length).concat(BALANCED));
      place = placeFor(this, pid, VARIANTS[fallback].truth);
      if (!place) return { error: 'No ground to stage a disagreement on yet' };
      if (pick.targeted && !aimed) {
        note = `No enemy is placed where ${WEAKNESS_LABEL[pick.targeted.source]} would get it wrong, so this one is not targeted.`;
        pick = { variant: fallback, targeted: null };
      } else pick = { ...pick, variant: fallback };
    }

    const v = VARIANTS[pick.variant];
    const id = 'D' + (this.disputes.length + 1);
    const x = r1(place.x), y = r1(place.y);
    const grid = T.gridRef(x, y);
    const sector = grid.match(/^[A-Z]+/)[0];
    const etype = place.enemy ? place.enemy.type : 'ARMOR';
    const claimsPresent = Object.values(v.says).includes('present');
    let track = null;
    const fake = v.truth === 'absent';
    if (claimsPresent) {
      if (place.enemy) track = this.ensureTrack(place.enemy);
      else {
        track = this.nextTrack();
        const claimant = { UAV: 'DRONE FEED', SCOUT: 'RECCE PATROL' }[DISPUTABLE.find((s) => v.says[s] === 'present')];
        this.fakes.push({ track, to: pid, x, y, type: etype, t: r1(this.t), clock: this.missionClock(), source: claimant, by: pick.targeted ? 'REDCELL' : (opts.by || 'DRILL'), dispute: id });
      }
    }

    const claims = DISPUTABLE.map((src) => {
      const says = v.says[src];
      const stance = stanceOf(says, v.says.UAV);
      return { source: src, says, stance, correct: stance === v.truth, delivered: false, text: claimText(src, says, grid, sector, etype) };
    });
    const rec = {
      id, pid, who: this.whoOf(pid), x, y, grid, truth: v.truth, variant: pick.variant, variantName: v.name,
      claims, track, fake, t: r1(this.t), clock: this.missionClock(),
      answer: null, answeredT: null, confidence: null, correct: null, froze: false, lost: false, readyT: null,
      targeted: pick.targeted, by: opts.by || 'DRILL',
    };
    this.disputes.push(rec);
    this.disputeStats[pid].issued++;

    const FROM = { SCOUT: 'RECCE PATROL', UAV: 'DRONE FEED', SIGINT: 'SIGINT' };
    const KIND = { SCOUT: 'PATROL', UAV: 'DRONE', SIGINT: 'SIGINT' };
    for (const c of claims) {
      const msg = { kind: KIND[c.source], from: FROM[c.source], source: c.source, text: c.text, claim: { id, source: c.source } };
      if (c.says === 'present') msg.contacts = [{ track, type: etype, x, y, fake, enemyId: place.enemy ? place.enemy.id : null }];
      if (c.says === 'absent' && c.source === 'SCOUT') msg.clearArea = { x, y, r: 95 };
      this.comms.send(pid, msg);
    }

    const what = `Disagreement at ${grid} for ${pid}: ${v.name} (the enemy is ${v.truth === 'present' ? 'there' : 'not there'})`;
    if (pick.targeted && !opts.quiet) {
      // One entry, not two: what was staged and why it was aimed at this commander.
      const label = attackLabel(pick.variant, pid);
      this.redcell.log.push({ t: r1(this.t), clock: this.missionClock(), rule: 'Adaptive targeting', ruleId: 'ADAPTIVE', pid, label, reason: pick.targeted.reason, mode: 'AUTO' });
      this.logEvent('redcell', `Red cell aimed a disagreement at ${pid}, ${grid}: ${v.name} (the enemy is ${v.truth === 'present' ? 'there' : 'not there'}). ${pick.targeted.reason}`, { pid, severity: 'high' });
    } else {
      this.logEvent('inject', what, { pid, severity: 'med' });
    }
    return { ok: true, id, variant: pick.variant, targeted: !!pick.targeted, note };
  }

  tickDisputes() {
    const every = this.cfg.disputeEvery || 0;
    for (const d of this.disputes) {
      if (d.answer || d.froze || d.lost) continue;
      if (d.readyT == null && this.t - d.t > DISPUTE_LOST) { d.lost = true; this.disputeStats[d.pid].issued--; continue; }
      if (d.readyT != null && this.t - d.readyT > (this.cfg.disputeTTL || DISPUTE_TTL)) {
        d.froze = true;
        this.disputeStats[d.pid].froze++;
        this.logEvent('intent', `${d.pid} left the disagreement at ${d.grid} unresolved`, { pid: d.pid, severity: 'med' });
      }
    }
    if (every <= 0) return;
    for (const p of PIDS) {
      if (!this.unit(p).alive || this.t < this.nextDispute[p]) continue;
      const r = this.contradiction(p, { by: 'DRILL' });
      this.nextDispute[p] = this.t + (r.ok ? every : 4);
    }
  }

  judgementView(pid) {
    const who = this.whoOf(pid);
    const trust = this.nowFor(pid).trust;
    const w = this.weakSpotFor(pid);
    const cal = calibrate(this.judgements.filter((j) => j.pid === pid));
    const st = this.disputeStats[pid];
    return {
      who, rounds: this.profiles.roundsFor(who),
      weakSpot: w ? { source: w.source, label: WEAKNESS_LABEL[w.source], probe: !!w.probe } : null,
      reason: w ? this.reasonFor(pid, w) : null,
      trust: Object.fromEntries(DISPUTABLE.map((s) => {
        const v = trust[s] || emptyTrust();
        const judged = v.trusted + v.distrusted;
        return [s, { label: SOURCES[s].label, trusted: v.trusted, judged, rate: judged ? Math.round((v.trusted / judged) * 100) : null, fooled: v.fooled }];
      })),
      calibration: { n: cal.n, brier: cal.brier, accuracy: cal.accuracy, meanConfidence: cal.meanConfidence, overconfidence: cal.overconfidence },
      disputes: { issued: st.issued, answered: st.answered, froze: st.froze, correct: st.correct },
      open: this.disputes.filter((d) => d.pid === pid && !d.answer && !d.froze && !d.lost).length,
    };
  }

  // Pairwise disagreement between commanders' pictures: the team's common
  // operational picture is only as good as its worst divergence.
  copDivergence() {
    const pairs = [];
    for (let i = 0; i < PIDS.length; i++) {
      for (let j = i + 1; j < PIDS.length; j++) {
        const A = this.beliefs[PIDS[i]].tracks, B = this.beliefs[PIDS[j]].tracks;
        const live = this.enemies.filter((e) => e.spawned && e.alive && e.track);
        const held = (M, tr) => M[tr] && M[tr].mark !== 'DISMISSED' ? M[tr] : null;
        let sum = 0, n = 0;
        for (const e of live) {
          const a = held(A, e.track), b = held(B, e.track);
          if (!a && !b) continue;
          n++;
          sum += a && b ? Math.min(dist(a, b) / 250, 1) : 1;
        }
        const fakesA = Object.values(A).filter((t) => t.fake && t.mark !== 'DISMISSED').length;
        const fakesB = Object.values(B).filter((t) => t.fake && t.mark !== 'DISMISSED').length;
        n += fakesA + fakesB; sum += fakesA + fakesB;
        pairs.push(n ? sum / n : 0);
      }
    }
    return mean(pairs) || 0;
  }

  sample(dt) {
    const s = { t: r1(this.t), acc: {}, hp: {}, sev: {}, deg: {}, cov: {} };
    for (const p of PIDS) {
      const u = this.unit(p), st = this.stats[p], prof = this.linkProfile(p);
      this.accuracy[p] = this.computeAccuracy(p);
      s.acc[p] = Math.round(this.accuracy[p].acc * 100);
      s.hp[p] = Math.max(0, Math.round(u.hp));
      s.sev[p] = r1(prof.severity);
      s.deg[p] = prof.severity > 0;

      if (u.alive) {
        st.aliveSec += 1;
        if (prof.severity > 0) st.jammedSec += 1;
        if (prof.masked) st.maskedSec += 1;
        const task = this.intentTaskFor(p);
        const covered = task ? dist(u, task.area) < task.area.r * 1.5 : true;
        if (covered) st.coveredSec += 1;
        s.cov[p] = covered;
      }

      // Isolation spans: was the commander cut off, and did they still act?
      const spans = this.isolationSpans[p];
      const open = spans.find((x) => x.end == null);
      if (prof.severity >= ISOLATED) {
        if (this.jamSince[p] == null) this.jamSince[p] = this.t;
        if (!open) spans.push({ start: r1(this.t), startClock: this.missionClock(), end: null, acted: 0, x0: u.x, y0: u.y });
        else this.stats[p].isolatedSec += 1;
      } else if (prof.severity < RECOVERED) {
        this.jamSince[p] = null;
        if (open) {
          open.end = r1(this.t);
          open.endClock = this.missionClock();
          open.moved = Math.round(Math.hypot(u.x - open.x0, u.y - open.y0) * T.UNIT_M);
          // Credit for solving a comms problem by manoeuvre rather than waiting.
          if (open.moved > 700) { this.stats[p].manoeuvredOut++; open.brokeOutByMovement = true; }
        }
      }
    }
    const div = this.copDivergence();
    s.cop = Math.round(div * 100);
    this.cop.push({ t: r1(this.t), div: s.cop });
    this.series.push(s);
  }

  // =========================================================================
  // Trainee actions
  // =========================================================================
  // An order leaving a jammed commander is itself at risk — this is the delay
  // on the request going out, or null if it never reaches the supporting arm.
  outboundDelay(pid) {
    const prof = this.linkProfile(pid);
    if (Math.random() < prof.sevDrop * this.cfg.dropRate) return null;
    return 0.3 + (prof.sevDelay > 0 ? rand(this.cfg.delayMin, this.cfg.delayMax) * prof.sevDelay : 0);
  }

  action(pid, a) {
    if (!PIDS.includes(pid)) return { error: 'unknown callsign' };
    if (a.type === 'identify') {
      // works in the lobby too: the name is what carries a person's record between rounds
      const name = String(a.name || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
      // A page announcing itself on connect with no saved name — a second
      // screen, a judge's phone — must not wipe the name of whoever is playing.
      if (name) this.who[pid] = name;
      else if (!a.auto) delete this.who[pid];
      this.engaged.add(pid);
      return { ok: true, who: this.whoOf(pid) };
    }
    if (this.status !== 'RUNNING') return { error: 'Exercise is not running' };
    this.engaged.add(pid);
    const u = this.unit(pid);
    if (!u.alive) return { error: 'Sub-unit combat ineffective' };
    if (['move', 'fire', 'uav'].includes(a.type)) {
      // `+null` is 0, so a missing coordinate would otherwise land at grid A1
      const num = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(+v);
      if (!num(a.x) || !num(a.y)) return { error: 'That is not a point on the map' };
    }
    const x = clamp(+a.x || 0, 0, T.W), y = clamp(+a.y || 0, 0, T.H);
    const rationale = String(a.rationale || '').slice(0, 220);
    let ref = a.ref || null;
    let desc, lost = false, feedback = null, outcome = null;

    switch (a.type) {
      case 'move': {
        u.tx = x; u.ty = y; u.posture = 'MOVE';
        desc = `MOVE to ${T.gridRef(x, y)}`;
        const task = this.intentTaskFor(pid);
        if (task) {
          const before = dist(u, task.area), after = dist({ x, y }, task.area);
          const threatNear = this.enemies.some((e) => e.spawned && e.alive && dist(e, task.area) < 300);
          if (after - before > 60 && after > task.area.r * 1.5 && threatNear) {
            this.driftOrders[pid].push({ t: r1(this.t), clock: this.missionClock(), to: T.gridRef(x, y), awayM: Math.round((after - before) * T.UNIT_M), task: task.id });
            this.logEvent('intent', `${pid} moved away from their assigned task (${task.text}) with enemy within 3 km of it`, { pid, severity: 'med' });
          }
        }
        // Moving to support a teammate who is in contact is the coordination we want to see.
        for (const p of PIDS) {
          if (p === pid) continue;
          const other = this.unit(p);
          if (!other.alive) continue;
          const inContact = Object.keys(this.engagements).some((k) => k.startsWith(p + '|') && this.t - this.engagements[k].start < 25);
          if (inContact && dist({ x, y }, other) < 200) {
            this.mutualSupport.push({ t: r1(this.t), clock: this.missionClock(), pid, toward: p, rationale });
            this.logEvent('coord', `${pid} moved to support ${p} in contact`, { pid, severity: 'low' });
            break;
          }
        }
        break;
      }
      case 'hold':
        u.tx = u.ty = null; u.posture = 'HOLD';
        desc = 'HOLD / DEFEND in place';
        break;
      case 'fire': {
        const delay = this.outboundDelay(pid);
        if (delay == null) lost = true;
        else this.fires.push({ pid, x, y, arriveAt: this.t + delay, issuedT: this.t });
        desc = `FIRE MISSION ${T.gridRef(x, y)}`;
        this.resolveConflicts(pid, 'FIRE', { x, y });
        break;
      }
      case 'uav': {
        const delay = this.outboundDelay(pid);
        if (delay == null) lost = true;
        else this.uavReqs.push({ pid, x, y, arriveAt: this.t + delay, issuedT: this.t });
        desc = `UAV SWEEP request ${T.gridRef(x, y)}`;
        this.resolveConflicts(pid, 'UAV', { x, y });
        break;
      }
      case 'mark': {
        const tr = this.beliefs[pid].tracks[a.track];
        if (!tr || !['CONFIRMED', 'SUSPECT', 'DISMISSED', 'UNK'].includes(a.mark)) return { error: 'unknown track' };
        // a track that is the subject of an open disagreement is decided there
        const open = this.disputes.find((d) => d.pid === pid && d.track === a.track && !d.answer && !d.froze && !d.lost);
        if (open && (a.mark === 'CONFIRMED' || a.mark === 'DISMISSED')) {
          return this.action(pid, { type: 'resolve', dispute: open.id, answer: a.mark === 'CONFIRMED' ? 'present' : 'absent', confidence: a.confidence, rationale });
        }
        tr.mark = a.mark;
        ref = a.track;
        const conf = this.confidenceOf(a.confidence);
        desc = `ASSESS ${a.track} as ${a.mark}${conf != null ? `, ${Math.round(conf * 100)}% sure` : ''}`;
        this.resolveConflicts(pid, 'MARK', tr);
        if ((a.mark === 'CONFIRMED' || a.mark === 'DISMISSED') && DISPUTABLE.includes(tr.source)) {
          const claim = a.mark === 'CONFIRMED' ? 'present' : 'absent';
          const truth = this.truthAt(tr);
          this.addTrust(pid, tr.source, claim === 'present', truth === 'present');
          this.judgements.push({ pid, who: this.whoOf(pid), t: r1(this.t), clock: this.missionClock(), kind: 'assess', subject: tr.track, source: tr.source, claim, confidence: conf, correct: claim === truth });
        }
        break;
      }
      case 'resolve': {
        const d = this.disputes.find((x) => x.id === a.dispute && x.pid === pid);
        if (!d || d.answer || d.froze || d.lost) return { error: 'That disagreement is already closed' };
        const answer = a.answer === 'present' || a.answer === 'absent' ? a.answer : null;
        if (!answer) return { error: 'Say whether the enemy is there or not' };
        const conf = this.confidenceOf(a.confidence);
        d.answer = answer; d.answeredT = r1(this.t); d.confidence = conf; d.correct = answer === d.truth;
        const st = this.disputeStats[pid];
        st.answered++;
        if (d.correct) st.correct++;
        if (answer === 'present') st.saidPresent++; else st.saidAbsent++;
        // answering against most of what they heard is what "whatever the sources say" means
        const most = majorityOf(d.claims);
        if (most && most !== answer) { if (answer === 'absent') st.againstClear++; else st.againstEnemy++; }
        if (d.readyT != null) st.answerSecs.push(this.t - d.readyT);
        // every source the commander actually heard from is trusted or not by this answer
        for (const c of d.claims) if (c.delivered) this.addTrust(pid, c.source, c.stance === answer, c.correct);
        this.judgements.push({ pid, who: this.whoOf(pid), t: r1(this.t), clock: this.missionClock(), kind: 'dispute', subject: d.id, source: null, claim: answer, confidence: conf, correct: d.correct, variant: d.variant });
        if (d.track && this.beliefs[pid].tracks[d.track]) this.beliefs[pid].tracks[d.track].mark = answer === 'present' ? 'CONFIRMED' : 'DISMISSED';
        ref = d.track;
        desc = `DECIDE ${d.grid}: ${answer === 'present' ? 'enemy is there' : 'area is clear'}${conf != null ? `, ${Math.round(conf * 100)}% sure` : ''}`;
        const liars = d.claims.filter((c) => !c.correct).map((c) => SOURCES[c.source].label).join(' and ');
        // In a drill the commander learns the truth at once: calibration only improves with feedback.
        if (this.cfg.disputeFeedback) {
          feedback = `${d.correct ? 'Right' : 'Wrong'} — ${d.grid} ${d.truth === 'present' ? 'had enemy on it' : 'was clear'}. The ${liars} ${d.claims.filter((c) => !c.correct).length === 1 ? 'was' : 'were'} wrong${conf != null ? `; you were ${Math.round(conf * 100)}% sure` : ''}.`;
          const m = { id: ++this.seq, kind: 'TRUTH', from: 'EXERCISE CONTROL', text: feedback, sentClock: this.missionClock(), rcvdClock: this.missionClock(), lag: 0, source: null, correct: d.correct };
          this.inbox[pid].push(m);
          this.emit(pid, 'msg', m);
        }
        outcome = d.correct ? 'right' : `wrong, misled by the ${liars}`;
        // kept for the record; the console shows the outcome on the decision itself
        this.logEvent('intent', `${pid} decided ${d.grid} — ${answer === 'present' ? 'enemy there' : 'clear'}${conf != null ? `, ${Math.round(conf * 100)}% sure` : ''}: ${outcome}`, { pid, severity: d.correct ? 'low' : 'med', onDecision: true });
        break;
      }
      case 'auth': {
        // Challenge an order over the net. The reply has to travel back, so a
        // jammed commander may have to decide without ever hearing from HQ.
        const delay = this.outboundDelay(pid);
        if (delay == null) lost = true;
        else this.authReqs.push({ pid, orderId: a.orderId || null, arriveAt: this.t + delay, issuedT: this.t });
        for (const fo of this.forgedOrders[pid]) {
          if (fo.received && (!a.orderId || fo.id === a.orderId) && !fo.challenged) {
            fo.challenged = true; fo.challengedT = r1(this.t);
          }
        }
        desc = `AUTHENTICATE last HQ order${a.orderId ? ' ' + a.orderId : ''}`;
        break;
      }
      case 'chat': {
        const text = String(a.text || '').slice(0, 180);
        if (!text) return { error: 'empty message' };
        for (const p of PIDS) {
          if (p === pid) continue;
          this.comms.send(p, { kind: 'CHAT', from: pid, text: `${pid}: ${text}` }, pid);
        }
        this.logEvent('chat', `${pid} → team: "${text}"`, { pid });
        this.chatCount = (this.chatCount || 0) + 1;
        return { ok: true };
      }
      default: return { error: 'unknown action' };
    }

    // Acting on a report is trusting the source that made it; acting on a false
    // one is being misled by it. Counted once per report.
    if (['move', 'fire'].includes(a.type) && ref) {
      const tr = this.beliefs[pid].tracks[ref];
      const key = pid + '|' + ref;
      if (tr && DISPUTABLE.includes(tr.source) && !this.actedOn.has(key)) {
        this.actedOn.add(key);
        const t = this.trust[pid][tr.source] || (this.trust[pid][tr.source] = emptyTrust());
        t.actedOn++;
        if (this.truthAt(tr) === 'absent') t.fooled++;
      }
    }

    // An order aimed at something that is not there.
    const fakeRef = ref && this.fakes.find((f) => f.track === ref && f.to === pid);
    const nearFake = ['move', 'fire'].includes(a.type) && this.fakes.find((f) => f.to === pid && dist(f, { x, y }) < 110
      && !this.enemies.some((e) => e.alive && e.spawned && dist(e, { x, y }) < 110));
    const onPhantom = a.type === 'resolve'
      ? a.answer === 'present' && !!fakeRef
      : a.type !== 'uav' && a.type !== 'mark' && a.type !== 'auth' && !!(fakeRef || nearFake);
    if (onPhantom && a.type === 'move') this.stats[pid].phantomActions++;

    // How did they handle a forged order? Record the facts; the AAR judges them.
    for (const fo of this.forgedOrders[pid]) {
      if (!fo.received) continue;
      if (a.type === 'move' && !fo.complied && dist({ x, y }, fo) < 150) {
        fo.complied = true; fo.compliedT = r1(this.t); fo.compliedClock = this.missionClock();
        this.logEvent('intent', `${pid} COMPLIED with the forged order — moved to ${T.gridRef(x, y)}${fo.challenged ? ' after challenging it' : ' without authenticating it'}`, { pid, severity: 'high' });
      } else if (a.type === 'uav' && !fo.queried && dist({ x, y }, fo) < 200) {
        fo.queried = true;
        this.logEvent('intent', `${pid} sent the UAV to check the ground named in the forged order before acting`, { pid, severity: 'low' });
      }
    }

    const pending = this.triggers.filter((tg) => tg.pid === pid && tg.reactedAt == null);
    pending.forEach((tg) => (tg.reactedAt = this.t));
    for (const sp of this.isolationSpans[pid]) if (sp.end == null) sp.acted++;

    const dec = {
      id: ++this.seq, t: r1(this.t), clock: this.missionClock(), pid, type: a.type.toUpperCase(), desc,
      x: ['mark', 'hold'].includes(a.type) ? null : x, y: ['mark', 'hold'].includes(a.type) ? null : y,
      rationale, ref, degraded: this.degraded(pid), severity: r1(this.linkProfile(pid).severity),
      accuracy: Math.round(this.computeAccuracy(pid).acc * 100), onPhantom, lost,
      answer: a.type === 'resolve' ? a.answer : a.type === 'mark' ? ({ CONFIRMED: 'present', DISMISSED: 'absent' }[a.mark] || null) : null,
      confidence: this.confidenceOf(a.confidence),
      latency: pending.length ? r1(this.t - Math.min(...pending.map((p) => p.t))) : null,
      outcome,
    };
    this.decisions.push(dec);
    this.emit('instructor', 'decision', dec);
    if (onPhantom) this.recorder.bookmark(this.t, 'phantom', `${pid} acted on phantom ${ref || T.gridRef(x, y)}`, pid, dec.clock);
    return { ok: true, decision: dec, feedback };
  }

  // =========================================================================
  // Instructor / red cell actions
  // =========================================================================
  admin(a, byRedCell = false) {
    switch (a.type) {
      case 'start':
        if (this.status === 'LOBBY' || this.status === 'PAUSED') {
          const first = this.status === 'LOBBY';
          this.status = 'RUNNING';
          if (first) this.startedAt = new Date().toISOString();
          this.logEvent('control', first ? `Exercise started — ${this.scenario.name}` : 'Exercise resumed');
          if (first) {
            for (const p of PIDS) {
              const task = this.intentTaskFor(p);
              this.comms.send(p, { kind: 'INTENT', from: this.scenario.intent.commander, text: `COMMANDER'S INTENT: ${this.scenario.intent.text}${task ? ` YOUR TASK: ${task.text}.` : ''}` });
            }
          }
        }
        break;
      case 'pause':
        if (this.status === 'RUNNING') { this.status = 'PAUSED'; this.logEvent('control', 'Exercise paused'); }
        break;
      case 'end':
        if (this.status !== 'ENDED') this.end('Ended by instructor');
        break;
      case 'reset':
        this.reset(a.scenario || this.scenario.id, a.config || {});
        break;
      case 'scenario':
        // Allowed from the lobby, and after ENDEX so the next exercise can be set
        // up straight away; refused mid-exercise, which would destroy the run.
        if (this.status === 'RUNNING' || this.status === 'PAUSED') return { error: 'End the exercise before changing the scenario' };
        this.reset(a.id || this.scenario.id, a.config || {});
        break;
      case 'config':
        if (this.status === 'RUNNING' || this.status === 'PAUSED') return { error: 'End the exercise before changing the settings' };
        this.reset(this.scenario.id, sanitizeConfig(a.config));
        break;

      case 'link': {
        const L = this.manual[a.pid];
        if (!L) return { error: 'unknown callsign' };
        if (a.set) Object.assign(L, { delay: !!a.set.delay, drop: !!a.set.drop, garble: !!a.set.garble });
        else if (a.mode === 'jam') { const on = !(L.delay && L.drop && L.garble); L.delay = L.drop = L.garble = on; }
        else if (a.mode === 'clear') { L.delay = L.drop = L.garble = false; }
        else if (['delay', 'drop', 'garble'].includes(a.mode)) L[a.mode] = !L[a.mode];
        else return { error: 'unknown link mode' };
        const flags = ['delay', 'drop', 'garble'].filter((k) => L[k]);
        this.interventions.push({ t: r1(this.t), clock: this.missionClock(), pid: a.pid, kind: 'link', flags, by: byRedCell ? 'REDCELL' : 'INSTRUCTOR' });
        this.logEvent('inject', `EW: ${a.pid} net → ${flags.length ? flags.join('+').toUpperCase() : 'CLEAR'}`, { pid: a.pid, severity: flags.length ? 'high' : 'low' });
        break;
      }

      case 'fake': {
        if (!PIDS.includes(a.pid)) return { error: 'unknown callsign' };
        const x = clamp(+a.x, 0, T.W), y = clamp(+a.y, 0, T.H);
        const etype = ['ARMOR', 'MECH INF', 'INFANTRY', 'RECON'].includes(a.etype) ? a.etype : 'ARMOR';
        const track = this.nextTrack();
        // a phantom comes through the drone feed unless it is passed off as a flank commander's sighting
        const viaScout = PIDS.includes(a.source) && a.source !== a.pid;
        const source = viaScout ? a.source : 'DRONE FEED';
        this.fakes.push({ track, to: a.pid, x, y, type: etype, t: r1(this.t), clock: this.missionClock(), source, by: byRedCell ? 'REDCELL' : 'INSTRUCTOR' });
        this.comms.send(a.pid, {
          kind: viaScout ? 'SPOTREP' : 'ISR', from: source, source: viaScout ? 'SCOUT' : 'UAV', forged: true, trueFrom: 'RED CELL',
          text: viaScout
            ? `SPOTREP ${track}: ENEMY ${etype} x4 grid ${T.gridRef(x, y)}, moving S. Request you engage.`
            : `DRONE FEED ${track}: ENEMY ${etype} x4 grid ${T.gridRef(x, y)}, moving S.`,
          contacts: [{ track, type: etype, x, y, fake: true }],
        }, viaScout ? source : null);
        this.interventions.push({ t: r1(this.t), clock: this.missionClock(), pid: a.pid, kind: 'fake', track, x, y, by: byRedCell ? 'REDCELL' : 'INSTRUCTOR' });
        this.logEvent('inject', `DECEPTION: phantom ${etype} ${track} injected to ${a.pid} at ${T.gridRef(x, y)}, spoofed as coming from ${source}`, { pid: a.pid, severity: 'high' });
        break;
      }

      case 'falseBda': {
        if (!PIDS.includes(a.pid)) return { error: 'unknown callsign' };
        const tr = this.beliefs[a.pid].tracks[a.track];
        if (!tr) return { error: 'that commander does not hold this track' };
        const e = tr.enemyId && this.enemies.find((x) => x.id === tr.enemyId);
        this.falseBdas[a.pid].push({ track: a.track, enemyId: tr.enemyId, type: tr.type, t: r1(this.t), clock: this.missionClock(), received: false, outcome: null, by: byRedCell ? 'REDCELL' : 'INSTRUCTOR' });
        this.comms.send(a.pid, { kind: 'BDA', from: 'BN HQ', forged: true, text: `BDA: ${a.track} ${tr.type} DESTROYED — no further threat from this track.`, kill: a.track, falseBda: true });
        this.interventions.push({ t: r1(this.t), clock: this.missionClock(), pid: a.pid, kind: 'falseBda', track: a.track, by: byRedCell ? 'REDCELL' : 'INSTRUCTOR' });
        this.logEvent('inject', `CYBER: false kill report for ${a.track} (${tr.type}${e && e.alive ? ', still live' : ''}) sent to ${a.pid}`, { pid: a.pid, severity: 'high' });
        break;
      }

      case 'forgedOrder': {
        if (!PIDS.includes(a.pid)) return { error: 'unknown callsign' };
        const x = clamp(+a.x, 0, T.W), y = clamp(+a.y, 0, T.H);
        const id = 'FO' + (++this.seq);
        const text = String(a.text || `BN HQ ORDER: ${a.pid} break contact and reposition to grid ${T.gridRef(x, y)} immediately. Acknowledge.`).slice(0, 200);
        this.forgedOrders[a.pid].push({ id, x, y, grid: T.gridRef(x, y), t: r1(this.t), clock: this.missionClock(), text, received: false, outcome: null, by: byRedCell ? 'REDCELL' : 'INSTRUCTOR' });
        this.comms.send(a.pid, { kind: 'ORDER', from: 'BN HQ', forged: true, trueFrom: 'RED CELL', text, order: { id, x, y } });
        this.interventions.push({ t: r1(this.t), clock: this.missionClock(), pid: a.pid, kind: 'forgedOrder', x, y, by: byRedCell ? 'REDCELL' : 'INSTRUCTOR' });
        this.logEvent('inject', `CYBER: forged HQ order sent to ${a.pid} — reposition to ${T.gridRef(x, y)}`, { pid: a.pid, severity: 'high' });
        break;
      }

      case 'spoof': {
        if (!PIDS.includes(a.pid)) return { error: 'unknown callsign' };
        const secs = clamp(+a.seconds || 30, 5, 180);
        this.spoofed[a.pid] = this.t + secs;
        this.spoofVec[a.pid] = null;
        this.interventions.push({ t: r1(this.t), clock: this.missionClock(), pid: a.pid, kind: 'spoof', seconds: secs, by: byRedCell ? 'REDCELL' : 'INSTRUCTOR' });
        this.logEvent('inject', `CYBER: GPS spoofing of ${a.pid}'s position reports for ${secs}s — teammates will see them in the wrong place`, { pid: a.pid, severity: 'high' });
        break;
      }

      case 'emitter': {
        if (a.op === 'add') {
          if (!this.ew.enabled) { this.ew.enabled = true; this.cfg.ewEnabled = true; }
          const e = this.ew.add({ type: a.etype, x: clamp(+a.x, 0, T.W), y: clamp(+a.y, 0, T.H), r: clamp(+a.r || 330, 80, 700), power: clamp(+a.power || 1, 0.2, 1) });
          this.logEvent('inject', `EW: ${e.name} emplaced at ${T.gridRef(e.x, e.y)}, radius ${Math.round(e.r * T.UNIT_M / 100) / 10} km`, { severity: 'high' });
        } else if (a.op === 'remove') {
          const e = this.ew.get(a.id);
          this.ew.remove(a.id);
          if (e) this.logEvent('inject', `EW: ${e.name} removed`, {});
        } else if (a.op === 'toggle') {
          const e = this.ew.toggle(a.id);
          if (e) this.logEvent('inject', `EW: ${e.name} ${e.on ? 'ACTIVE' : 'off air'}`, { severity: e.on ? 'high' : 'low' });
        } else if (a.op === 'enable') {
          this.ew.enabled = !this.ew.enabled;
          this.cfg.ewEnabled = this.ew.enabled;
          this.logEvent('inject', `EW field ${this.ew.enabled ? 'ENABLED' : 'disabled'}`, {});
        } else return { error: 'unknown emitter op' };
        break;
      }

      case 'message': {
        const text = String(a.text || '').slice(0, 220);
        if (!text) return { error: 'empty message' };
        const targets = a.pid === 'ALL' ? PIDS : [a.pid];
        if (!targets.every((p) => PIDS.includes(p))) return { error: 'unknown callsign' };
        for (const p of targets) this.comms.send(p, { kind: 'HQ', from: 'BN HQ', text: 'BN HQ: ' + text });
        this.logEvent('inject', `HQ message to ${a.pid}: "${text}"`);
        break;
      }

      case 'redcell': {
        if (a.op === 'mode') {
          const m = String(a.mode || '').toUpperCase();
          if (!['OFF', 'ASSIST', 'AUTO'].includes(m)) return { error: 'unknown red cell mode' };
          this.cfg.redcell = m;
          this.logEvent('control', `Red cell → ${m}`);
        } else if (a.op === 'approve') return this.redcell.approve(a.id);
        else if (a.op === 'dismiss') return this.redcell.dismiss(a.id);
        else return { error: 'unknown red cell op' };
        break;
      }

      case 'contradiction': {
        const r = this.contradiction(a.pid, { by: byRedCell ? 'REDCELL' : 'INSTRUCTOR', variant: a.variant, quiet: byRedCell });
        if (r.error) return r;
        return { ok: true, note: r.note || null, variant: r.variant };
      }

      case 'profiles': {
        if (a.op !== 'clear') return { error: 'unknown profiles op' };
        if (this.status === 'RUNNING' || this.status === 'PAUSED') return { error: 'End the exercise before clearing trainee records' };
        this.profiles.clear();
        this.logEvent('control', 'Trainee records cleared');
        break;
      }

      case 'bookmark': {
        const label = String(a.label || 'Instructor mark').slice(0, 80);
        this.recorder.bookmark(this.t, 'instructor', label, a.pid || null, this.missionClock());
        this.logEvent('control', `Teaching moment marked: "${label}"`, { pid: a.pid || null });
        break;
      }

      default: return { error: 'unknown instruction' };
    }
    return { ok: true };
  }

  end(reason) {
    if (this.status === 'ENDED') return;
    this.status = 'ENDED';
    this.endReason = reason;
    this.sample(1);
    this.recorder.capture(this.t, this);
    this.logEvent('control', 'ENDEX — ' + reason);
    this.aar = buildReport(this);
    const names = [];
    for (const p of PIDS) {
      const round = this.aar.players[p].judgement.round;
      if (!round) continue;
      this.profiles.record(this.whoOf(p), round);
      this.recorded.add(p);
      names.push(this.whoOf(p));
    }
    this.profiles.save();
    this.aar.progress = this.profiles.progress(names);
    this.emit('all', 'ended', { reason });
  }

  // =========================================================================
  // Views
  // =========================================================================
  traineeView(pid) {
    const u = this.unit(pid), b = this.beliefs[pid];
    const prof = this.linkProfile(pid);
    const spoof = this.ew.spoofAt(u);
    const gpsDegraded = this.spoofed[pid] > this.t || spoof.severity > 0.3;
    const sig = prof.severity > 0 ? clamp(1 - prof.severity, 0.04, 0.55) * rand(0.8, 1.2) : rand(0.85, 1);
    const df = prof.severity > 0 ? this.ew.dfCut(u) : null;
    const task = this.intentTaskFor(pid);
    return {
      status: this.status, t: r1(this.t), clock: this.missionClock(),
      remaining: Math.max(0, Math.round(this.cfg.duration - this.t)),
      scenario: { name: this.scenario.name, brief: this.scenario.brief, area: this.scenario.area },
      intent: { text: this.scenario.intent.text, commander: this.scenario.intent.commander, task: task ? { text: task.text, area: task.area, type: task.type } : null },
      me: { pid, name: u.name, x: r1(u.x), y: r1(u.y), tx: u.tx, ty: u.ty, hp: Math.max(0, Math.round(u.hp)), alive: u.alive, posture: u.posture,
        diedClock: u.diedT != null ? this.missionClock(u.diedT) : null },
      // A commander always knows when they are being shot at — this is not a leak of ground truth.
      underFire: u.alive && this.enemies.some((e) => e.spawned && e.alive && dist(u, e) <= WEAPON_RANGE),
      tracks: Object.values(b.tracks).map((tr) => ({
        track: tr.track, type: tr.type, x: r1(tr.x), y: r1(tr.y), age: r1(this.mm(this.t - tr.infoT)),
        src: tr.src, source: tr.source, sourceTag: tr.source && SOURCES[tr.source] ? SOURCES[tr.source].tag : null,
        garbled: tr.garbled, mark: tr.mark, notObserved: !!tr.notObserved,
        visual: tr.src === 'VISUAL' && this.t - tr.infoT < 0.5,
      })),
      friends: Object.entries(b.friends).map(([p, f]) => ({ pid: p, x: r1(f.x), y: r1(f.y), age: r1(this.mm(this.t - f.infoT)) })),
      cleared: b.cleared.filter((k) => this.t - k.t < 25).map((k) => ({ x: k.x, y: k.y, r: k.r })),
      // only about tracks still on their picture: a warning about one that has
      // since been reported destroyed or cleared points at nothing
      conflicts: Object.values(this.conflicts[pid]
        .filter((k) => this.t - k.t < 45 && k.resolvedT == null && b.tracks[k.track] && b.tracks[k.track].mark !== 'DISMISSED')
        .reduce((acc, k) => { acc[k.track] = k; return acc; }, {}))
        .map((k) => ({ track: k.track, gapM: k.gapM, a: k.a, b: k.b })),
      who: this.whoOf(pid),
      disputes: this.disputes
        .filter((d) => d.pid === pid && !d.answer && !d.froze && !d.lost && d.readyT != null)
        .map((d) => ({
          id: d.id, grid: d.grid, x: d.x, y: d.y, track: d.track,
          claims: d.claims.filter((c) => c.delivered).map((c) => ({ source: c.source, tag: SOURCES[c.source].tag, label: SOURCES[c.source].label, text: c.text, stance: c.stance })),
          waiting: d.claims.filter((c) => !c.delivered).length,
          secondsLeft: Math.max(0, Math.round((this.cfg.disputeTTL || DISPUTE_TTL) - (this.t - d.readyT))),
        })),
      pending: [
        ...this.fires.filter((f) => f.pid === pid && !f.shotSent).map((f) => ({ kind: 'Fire mission', x: r1(f.x), y: r1(f.y), waiting: r1(this.mm(this.t - f.issuedT)) })),
        ...this.uavReqs.filter((q) => q.pid === pid && !q.done).map((q) => ({ kind: 'UAV sweep', x: r1(q.x), y: r1(q.y), waiting: r1(this.mm(this.t - q.issuedT)) })),
        ...this.authReqs.filter((q) => q.pid === pid && !q.done).map((q) => ({ kind: 'Authentication', x: null, y: null, waiting: r1(this.mm(this.t - q.issuedT)) })),
      ],
      signal: r1(sig), severity: r1(prof.severity), df, gpsDegraded,
      sensorRange: this.cfg.sensorRange, rounds: this.rounds,
      effects: this.effects.filter((f) => dist(f, u) < this.cfg.sensorRange * 2.5).map((f) => ({ x: f.x, y: f.y, t: f.t })),
    };
  }

  instructorView() {
    return {
      status: this.status, t: r1(this.t), clock: this.missionClock(),
      remaining: Math.max(0, Math.round(this.cfg.duration - this.t)),
      cfg: this.cfg, scenario: this.scenarioBrief(),
      units: this.units.map((u) => ({ pid: u.pid, name: u.name, x: r1(u.x), y: r1(u.y), tx: u.tx, ty: u.ty, hp: Math.max(0, Math.round(u.hp)), alive: u.alive, posture: u.posture,
        diedClock: u.diedT != null ? this.missionClock(u.diedT) : null })),
      enemies: this.enemies.filter((e) => e.spawned).map((e) => ({ id: e.id, type: e.type, track: e.track, axis: e.axis, x: r1(e.x), y: r1(e.y), hp: Math.round((Math.max(0, e.hp) / e.maxHp) * 100), alive: e.alive })),
      fakes: this.fakes,
      links: Object.fromEntries(PIDS.map((p) => {
        const prof = this.linkProfile(p);
        return [p, { ...this.manual[p], severity: r1(prof.severity), masked: prof.masked, sources: prof.sources, emitter: prof.emitter, spoofed: this.spoofed[p] > this.t }];
      })),
      emitters: this.ew.view(), ewEnabled: this.ew.enabled,
      inflight: Object.fromEntries(PIDS.map((p) => [p, this.comms.inflight(p)])),
      beliefs: Object.fromEntries(PIDS.map((p) => [p, {
        tracks: Object.values(this.beliefs[p].tracks).map((tr) => ({ track: tr.track, type: tr.type, x: r1(tr.x), y: r1(tr.y), age: r1(this.mm(this.t - tr.infoT)), fake: tr.fake, enemyId: tr.enemyId, mark: tr.mark, garbled: tr.garbled, src: tr.src })),
        friends: Object.entries(this.beliefs[p].friends).map(([q, f]) => ({ pid: q, x: r1(f.x), y: r1(f.y), age: r1(this.mm(this.t - f.infoT)), spoofed: !!f.spoofed })),
      }])),
      accuracy: Object.fromEntries(PIDS.map((p) => [p, { acc: r1(this.accuracy[p].acc * 100) / 100, missing: this.accuracy[p].missing, phantom: this.accuracy[p].phantom, err: Math.round(this.accuracy[p].err) }])),
      stats: Object.fromEntries(PIDS.map((p) => {
        const st = this.stats[p], cs = this.comms.stats[p];
        return [p, {
          hpLost: Math.round(st.hpLost), blindHpLost: Math.round(st.blindHpLost), kills: st.kills,
          wastedRounds: st.wastedRounds, phantomActions: st.phantomActions,
          dropped: cs.dropped, garbled: cs.garbled, sent: cs.sent,
          conflicts: this.conflicts[p].length,
          unresolved: this.conflicts[p].filter((k) => k.resolvedT == null).length,
          decisions: this.decisions.filter((d) => d.pid === p).length,
        }];
      })),
      cop: this.series.length ? this.series[this.series.length - 1].cop : 0,
      fog: this.liveFog(),
      judgement: Object.fromEntries(PIDS.map((p) => [p, this.judgementView(p)])),
      who: Object.fromEntries(PIDS.map((p) => [p, this.whoOf(p)])),
      gaps: Object.fromEntries(PIDS.map((p) => [p, this.gapNotes(p)])),
      intent: this.scenario.intent,
      breaches: this.breaches.length,
      uav: { x: r1(this.uav.x), y: r1(this.uav.y), state: this.uav.state },
      rounds: this.rounds, effects: this.effects,
      redcell: this.redcell.view(),
      bookmarks: this.recorder.bookmarks.length,
      hasReport: !!this.aar,
    };
  }
}

module.exports = { Game, PIDS, SCENARIOS };
