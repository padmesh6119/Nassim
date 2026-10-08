'use strict';
// Trainee profiles that persist between rounds, so the adaptive red cell can
// learn a person rather than a seat, and the debrief can show improvement
// across sessions rather than within one.
//
// The store is the only part of the engine that touches the disk, and only
// when given a file. Tests run it in memory.

const fs = require('fs');
const path = require('path');
const { mergeTrustMaps, weakSpot } = require('./calibration');

const RECENT = 2;       // rounds that describe someone as they are now, the one in play included
const KEYS = ['issued', 'answered', 'froze', 'correct', 'saidPresent', 'saidAbsent', 'againstClear', 'againstEnemy'];
const norm = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);

class ProfileStore {
  constructor(file = null) {
    this.file = file;
    this.data = {};
    if (file) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { console.error('profile save failed:', e.message); }
  }

  get(name) {
    const k = norm(name);
    if (!k) return null;
    return this.data[k] || { name: String(name).trim(), rounds: [], trust: {}, disputes: { issued: 0, answered: 0, froze: 0 } };
  }

  // round: { at, scenario, callsign, calibration, trust, disputes }
  record(name, round) {
    const k = norm(name);
    if (!k) return;
    const p = this.get(name);
    p.name = String(name).trim();
    p.rounds.push(round);
    if (p.rounds.length > 50) p.rounds.shift();
    p.trust = mergeTrustMaps(p.trust, round.trust);
    p.disputes = Object.fromEntries(KEYS.map((k) => [k, (p.disputes[k] || 0) + (round.disputes[k] || 0)]));
    this.data[k] = p;
  }

  recent(name, rounds = RECENT) {
    const p = this.get(name);
    const rs = p && rounds > 0 ? p.rounds.slice(-rounds) : [];
    const trust = mergeTrustMaps(...rs.map((r) => r.trust));
    const disputes = Object.fromEntries(KEYS.map((k) => [k, 0]));
    for (const r of rs) for (const k of KEYS) disputes[k] += (r.disputes && r.disputes[k]) || 0;
    return { trust, disputes, rounds: rs.length };
  }

  // Who someone is now: their last RECENT rounds, with the round being played
  // (live, not yet on the record) counting as one of them. A bias they have
  // trained out of should stop being attacked — and stop being reported —
  // rather than haunting them from round one.
  now(name, live = null) {
    const rec = this.recent(name, live ? RECENT - 1 : RECENT);
    const trust = mergeTrustMaps(rec.trust, live ? live.trust : {});
    const disputes = {};
    for (const k of KEYS) disputes[k] = (rec.disputes[k] || 0) + ((live && live.disputes && live.disputes[k]) || 0);
    return { trust, disputes, span: rec.rounds + (live ? 1 : 0), live: !!live };
  }

  weakSpot(name, live = null) {
    const n = this.now(name, live);
    return weakSpot(n.trust, n.disputes);
  }

  roundsFor(name) { const p = this.get(name); return p ? p.rounds.length : 0; }

  list() {
    return Object.values(this.data).map((p) => ({
      name: p.name, rounds: p.rounds.length,
      last: p.rounds.length ? p.rounds[p.rounds.length - 1].at : null,
      weakSpot: this.weakSpot(p.name),
    }));
  }

  progress(names) {
    const out = {};
    for (const n of names) {
      const p = this.get(n);
      if (p && p.rounds.length) out[p.name] = p.rounds.map((r) => ({ at: r.at, scenario: r.scenario, callsign: r.callsign, ...r.calibration, disputes: r.disputes }));
    }
    return out;
  }

  clear() { this.data = {}; this.save(); }
}

module.exports = { ProfileStore, norm };
