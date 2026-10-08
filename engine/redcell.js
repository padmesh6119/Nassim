'use strict';
// AI red cell — the automated adversary for the information domain.
//
// It does not fight the units; it attacks what the commanders know, and it picks
// its moments. Every action carries a plain-language reason, so the instructor
// can defend it in the debrief and the AAR can show the adversary's logic.
//
// OFF     — nothing.
// ASSIST  — proposes timed actions; the instructor approves with one click.
// AUTO    — acts on its own, within a budget and with cooldowns.

const T = require('../public/terrain.js');
const { attackLabel } = require('./sources');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const GLOBAL_COOLDOWN = 10;   // real seconds between any two red-cell actions
const PLAYER_COOLDOWN = 18;   // per player
const MAX_JAMMED = 2;         // never black out the whole team at once
const REC_TTL = 22;           // a recommendation goes stale if not approved

class RedCell {
  constructor(sim) {
    this.sim = sim;
    this.reset();
  }

  reset() {
    this.log = [];
    this.recs = [];
    this.seq = 0;
    this.lastAction = -Infinity;
    this.ruleAt = {};
    this.playerAt = {};
    this.spent = 0;
  }

  get mode() { return this.sim.cfg.redcell || 'OFF'; }
  get budget() { return Math.max(0, (this.sim.cfg.redcellBudget || 0) - this.spent); }

  // ---- context helpers -------------------------------------------------
  liveEnemies() { return this.sim.enemies.filter((e) => e.spawned && e.alive); }
  unit(pid) { return this.sim.unit(pid); }
  sev(pid) { return this.sim.linkProfile(pid).severity; }
  jammedCount() { return this.sim.pids.filter((p) => this.sev(p) > 0.4).length; }
  task(pid) { return this.sim.intentTaskFor(pid); }

  // Live enemies in a distance band from a player, closing on them.
  threatsNear(pid, min, max) {
    const u = this.unit(pid);
    if (!u || !u.alive) return [];
    return this.liveEnemies()
      .map((e) => ({ e, d: T.dist(u, e) }))
      .filter((x) => x.d >= min && x.d <= max)
      .sort((a, b) => a.d - b.d);
  }

  // ---- rules -----------------------------------------------------------
  rules() {
    return [
      {
        id: 'PRECONTACT_JAM', name: 'Jam before contact', auto: false, cooldown: 30,
        test: (pid) => {
          if (this.sev(pid) > 0.25 || this.jammedCount() >= MAX_JAMMED) return null;
          const near = this.threatsNear(pid, 110, 215)[0];
          if (!near) return null;
          const eta = Math.round((near.d - 80) / (9 * near.e.speed * this.sim.cfg.enemySpeed));
          return {
            action: { type: 'link', pid, set: { delay: true, drop: true, garble: true }, by: 'REDCELL' },
            label: `JAM ${pid}`,
            reason: `${near.e.type} ${near.e.track || near.e.id} is ~${eta}s from contact with ${pid} and their net is clear. Jamming now denies ${pid} any warning at the decisive moment.`,
            urgency: 3,
          };
        },
      },
      {
        id: 'FLANK_FAKE', name: 'Deception on the quiet flank', auto: false, cooldown: 45,
        test: (pid) => {
          const u = this.unit(pid);
          const task = this.task(pid);
          if (!u || !u.alive || !task) return null;
          const real = this.threatsNear(pid, 0, 300)[0];
          if (!real) return null;
          // Put the phantom on the far side of the commander, so believing it
          // means abandoning the decisive point.
          const vx = u.x - real.e.x, vy = u.y - real.e.y, L = Math.hypot(vx, vy) || 1;
          const x = clamp(u.x + (vx / L) * 215, 40, T.W - 40);
          const y = clamp(u.y + (vy / L) * 215, 40, T.H - 40);
          if (this.liveEnemies().some((e) => T.dist(e, { x, y }) < 120)) return null; // would accidentally be true
          return {
            action: { type: 'fake', pid, x: Math.round(x), y: Math.round(y), etype: 'ARMOR', source: 'BN HQ', by: 'REDCELL' },
            label: `FAKE ARMOR → ${pid}`,
            reason: `${pid} is committed against ${real.e.type} ${real.e.track || real.e.id}. A phantom armour report at ${T.gridRef(x, y)} on their opposite flank invites them to split off the decisive point — ${task.text}.`,
            urgency: 2,
          };
        },
      },
      {
        id: 'ISOLATE_RESERVE', name: 'Isolate the reserve', auto: true, cooldown: 70,
        test: (pid) => {
          const task = this.task(pid);
          if (!task || task.type !== 'hold') return null;     // only the reserve
          if (this.sev(pid) > 0.25 || this.jammedCount() >= MAX_JAMMED) return null;
          const committed = T.bridges.filter((b) => this.liveEnemies().filter((e) => T.dist(e, b) < 260).length >= 1);
          if (committed.length < 1) return null;
          const n = this.liveEnemies().filter((e) => T.bridges.some((b) => T.dist(e, b) < 260)).length;
          if (n < 2) return null;
          return {
            action: { type: 'link', pid, set: { delay: true, drop: true, garble: true }, by: 'REDCELL' },
            label: `ISOLATE ${pid} (reserve)`,
            reason: `${n} enemy groups are committing at the crossings. Cutting ${pid}, the reserve, means no one can call them forward — the flank that breaks first stays unreinforced.`,
            urgency: 3,
          };
        },
      },
      {
        id: 'FALSE_BDA', name: 'False kill report', auto: true, cooldown: 55,
        test: (pid) => {
          const u = this.unit(pid);
          if (!u || !u.alive) return null;
          const held = Object.values(this.sim.beliefs[pid].tracks)
            .filter((tr) => tr.enemyId && !tr.fake && tr.mark !== 'DISMISSED');
          for (const tr of held) {
            const e = this.sim.enemies.find((x) => x.id === tr.enemyId);
            if (!e || !e.alive) continue;
            const d = T.dist(u, e);
            if (d > 330 || d < 90) continue;   // close enough to matter, not yet in sight
            return {
              action: { type: 'falseBda', pid, track: tr.track, by: 'REDCELL' },
              label: `FALSE BDA ${tr.track} → ${pid}`,
              reason: `${pid} is tracking ${tr.track} (${e.type}) at ${Math.round(d * T.UNIT_M)} m and closing. A false "DESTROYED" report removes it from their picture — they will stop watching a live threat.`,
              urgency: 3,
            };
          }
          return null;
        },
      },
      {
        id: 'FORGED_ORDER', name: 'Forged HQ order', auto: true, cooldown: 80,
        test: (pid) => {
          const u = this.unit(pid), task = this.task(pid);
          if (!u || !u.alive || !task) return null;
          if (this.sev(pid) < 0.4) return null;               // only works while they cannot verify
          if (!this.threatsNear(pid, 0, 320).length) return null;
          // Send them backwards, away from the task area.
          const vx = u.x - task.area.x, vy = u.y - task.area.y, L = Math.hypot(vx, vy) || 1;
          const x = clamp(task.area.x + (vx / L) * 330, 40, T.W - 40);
          const y = clamp(task.area.y + (vy / L) * 330 + 120, 40, T.H - 40);
          return {
            action: { type: 'forgedOrder', pid, x: Math.round(x), y: Math.round(y), by: 'REDCELL' },
            label: `FORGED ORDER → ${pid}`,
            reason: `${pid} is cut off from HQ and cannot authenticate. A forged withdrawal order to ${T.gridRef(x, y)} tests whether they comply with a plausible order that contradicts the commander's intent — ${task.text}.`,
            urgency: 3,
          };
        },
      },
      {
        id: 'SPOOF_POSITION', name: 'Spoof friendly position', auto: true, cooldown: 60,
        test: (pid) => {
          const u = this.unit(pid);
          if (!u || !u.alive || this.sim.spoofed[pid] > this.sim.t) return null;
          if (!this.sim.ew.emitters.some((e) => e.type === 'SPOOFER' && e.on) && this.mode !== 'AUTO') return null;
          const others = this.sim.pids.filter((p) => p !== pid && this.unit(p).alive);
          if (!others.length) return null;
          return {
            action: { type: 'spoof', pid, seconds: 30, by: 'REDCELL' },
            label: `SPOOF ${pid} POSITION`,
            reason: `Falsifying ${pid}'s position reports for 30s. ${others.join(' and ')} will plan mutual support and fire missions around a friendly who is not there — this is how fratricide starts.`,
            urgency: 2,
          };
        },
      },
      {
        // The adaptive play: once a commander has shown which source they lean
        // on, stage a disagreement in which that source is the one that lies.
        id: 'TARGETED_CONTRADICTION', name: 'Exploit a learned bias', auto: false, cooldown: 45,
        test: (pid) => {
          if ((this.sim.cfg.disputeEvery || 0) > 0) return null;        // the drill already targets every disagreement
          const u = this.unit(pid);
          if (!u || !u.alive) return null;
          if (this.sim.disputes.some((d) => d.pid === pid && !d.answer && !d.froze && !d.lost)) return null;
          const w = this.sim.weakSpotFor(pid);
          if (!w) return null;
          return {
            action: { type: 'contradiction', pid, by: 'REDCELL' },
            label: attackLabel(this.sim.chooseVariant(pid).variant, pid),
            reason: this.sim.reasonFor(pid, w),
            urgency: 3,
          };
        },
      },
      {
        id: 'WINDOW', name: 'Open a brief window', auto: false, cooldown: 50,
        test: (pid) => {
          const since = this.sim.jamSince[pid];
          if (since == null || this.sim.t - since < 55) return null;
          if (this.sev(pid) < 0.4) return null;
          return {
            action: { type: 'link', pid, set: { delay: false, drop: false, garble: false }, by: 'REDCELL' },
            label: `RESTORE ${pid} (window)`,
            reason: `${pid} has been blacked out for ${Math.round(this.sim.t - since)}s. Opening a short window shows whether they exploit restored comms to re-sync the picture, or keep acting on stale information.`,
            urgency: 1,
          };
        },
      },
    ];
  }

  // ---- loop ------------------------------------------------------------
  tick(t) {
    if (this.mode === 'OFF') return;
    // A proposal the instructor never answered is itself a teaching point.
    for (const r of this.recs) {
      if (t >= r.expiresT) {
        this.log.push({ t: +t.toFixed(1), clock: this.sim.missionClock(t), rule: r.rule, ruleId: r.ruleId, pid: r.pid, label: r.label, reason: r.reason, mode: 'EXPIRED' });
      }
    }
    this.recs = this.recs.filter((r) => t < r.expiresT);
    if (t - this.lastAction < GLOBAL_COOLDOWN) return;
    if (this.budget <= 0) return;

    const candidates = [];
    for (const rule of this.rules()) {
      if (this.mode === 'ASSIST' && rule.auto) continue;      // the nastier plays need AUTO
      const last = this.ruleAt[rule.id];
      if (last != null && t - last < rule.cooldown) continue;
      for (const pid of this.sim.pids) {
        const pl = this.playerAt[pid];
        if (pl != null && t - pl < PLAYER_COOLDOWN) continue;
        if (this.recs.some((r) => r.ruleId === rule.id && r.pid === pid)) continue;
        let out = null;
        try { out = rule.test(pid); } catch (e) {
          if (!this.ruleErrors) this.ruleErrors = {};
          if (!this.ruleErrors[rule.id]) {
            this.ruleErrors[rule.id] = e.message;
            console.error(`[redcell] rule ${rule.id} failed: ${e.message}`);
          }
        }
        if (out) candidates.push({ rule, pid, ...out });
      }
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => b.urgency - a.urgency);
    const pick = candidates[0];

    if (this.mode === 'AUTO') this.execute(pick);
    else this.propose(pick, t);
  }

  propose(pick, t) {
    const rec = {
      id: 'R' + ++this.seq, ruleId: pick.rule.id, rule: pick.rule.name, pid: pick.pid,
      label: pick.label, reason: pick.reason, action: pick.action,
      createdT: +t.toFixed(1), clock: this.sim.missionClock(t), expiresT: t + REC_TTL,
    };
    this.recs.push(rec);
    this.ruleAt[pick.rule.id] = t;                            // don't re-propose immediately
    this.sim.logEvent('redcell', `Red cell proposes: ${rec.label}`, { pid: rec.pid, severity: 'med' });
    return rec;
  }

  execute(pick, approvedBy = null) {
    const t = this.sim.t;
    this.lastAction = t;
    this.ruleAt[pick.rule ? pick.rule.id : pick.ruleId] = t;
    this.playerAt[pick.pid] = t;
    this.spent++;
    const entry = {
      t: +t.toFixed(1), clock: this.sim.missionClock(t), rule: pick.rule ? pick.rule.name : pick.rule,
      ruleId: pick.rule ? pick.rule.id : pick.ruleId, pid: pick.pid, label: pick.label, reason: pick.reason,
      mode: approvedBy ? 'APPROVED' : 'AUTO',
    };
    this.log.push(entry);
    this.sim.logEvent('redcell', `Red cell${approvedBy ? ', approved' : ''}: ${pick.label}`, { pid: pick.pid, severity: 'high' });
    this.sim.recorder.bookmark(t, 'redcell', `Red cell: ${pick.label}`, pick.pid, this.sim.missionClock(t));
    this.sim.admin(pick.action, true);
    return entry;
  }

  approve(id) {
    const rec = this.recs.find((r) => r.id === id);
    if (!rec) return { error: 'recommendation expired' };
    this.recs = this.recs.filter((r) => r.id !== id);
    this.execute(rec, true);
    return { ok: true };
  }

  dismiss(id) {
    const rec = this.recs.find((r) => r.id === id);
    if (!rec) return { error: 'recommendation expired' };
    this.recs = this.recs.filter((r) => r.id !== id);
    this.log.push({ t: +this.sim.t.toFixed(1), clock: this.sim.missionClock(), rule: rec.rule, ruleId: rec.ruleId, pid: rec.pid, label: rec.label, reason: rec.reason, mode: 'DISMISSED' });
    this.sim.logEvent('redcell', `Instructor dismissed red-cell proposal: ${rec.label}`, { pid: rec.pid });
    return { ok: true };
  }

  view() {
    return {
      mode: this.mode, budget: this.budget, spent: this.spent,
      recs: this.recs.map((r) => ({ id: r.id, pid: r.pid, label: r.label, reason: r.reason, rule: r.rule, clock: r.clock, expiresIn: Math.max(0, Math.round(r.expiresT - this.sim.t)) })),
      log: this.log.slice(-12),
    };
  }
}

module.exports = { RedCell };
