'use strict';
// The radio net. Every report in the exercise rides this bus, so this is where
// delay, dropout and garbling happen — and where we record the counterfactual:
// when each report WOULD have landed on a clear net versus when it actually did.
// That difference is what the AAR later prices as the "cost of fog".

const BASE_LATENCY = 0.3; // seconds, even on a perfect net
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const TYPE_CONFUSION = { ARMOR: 'MECH INF', 'MECH INF': 'ARMOR', INFANTRY: 'MECH INF', RECON: 'INFANTRY' };

// A broken radio does not politely corrupt one character at a time: words drop
// out whole, and the operator asks for a repeat.
function garbleText(s, rng) {
  const words = String(s).split(' ').map((w) => {
    const r = rng();
    if (r < 0.12) return '###';
    if (r < 0.45) return w.replace(/[A-Z0-9]/g, (ch) => (rng() < 0.4 ? '#' : ch));
    return w;
  });
  if (rng() < 0.35) words.push('…SAY AGAIN');
  return words.join(' ');
}

// Per-player, per-enemy ledger of when awareness was possible vs when it happened.
class AwarenessLedger {
  constructor() { this.map = new Map(); }
  key(pid, enemyId) { return pid + '|' + enemyId; }
  get(pid, enemyId) {
    const k = this.key(pid, enemyId);
    let v = this.map.get(k);
    if (!v) { v = { pid, enemyId, ideal: null, actual: null, minDist: Infinity, everClose: false }; this.map.set(k, v); }
    return v;
  }
  markIdeal(pid, enemyId, t) { const v = this.get(pid, enemyId); if (v.ideal == null || t < v.ideal) v.ideal = t; }
  markActual(pid, enemyId, t) { const v = this.get(pid, enemyId); if (v.actual == null) v.actual = t; }
  markDist(pid, enemyId, d) { const v = this.get(pid, enemyId); if (d < v.minDist) v.minDist = d; }
  all() { return [...this.map.values()]; }
  forPlayer(pid) { return this.all().filter((v) => v.pid === pid); }
}

class CommsNet {
  // linkProfile(pid) → { sevDelay, sevDrop, sevGarble, severity, sources:[] }
  // rng: the exercise's seeded generator — the net draws every delay, loss and garble from it.
  constructor(cfg, { linkProfile, onDeliver, onDrop, rng }) {
    if (typeof rng !== 'function') throw new Error('CommsNet needs a seeded rng');
    this.cfg = cfg;
    this.rng = rng;
    this.linkProfile = linkProfile;
    this.onDeliver = onDeliver;
    this.onDrop = onDrop || (() => {});
    this.t = 0;
    this.seq = 0;
    this.pending = [];
    this.log = [];
    this.awareness = new AwarenessLedger();
    this.stats = {};
  }

  register(pids) {
    for (const p of pids) this.stats[p] = { sent: 0, delivered: 0, dropped: 0, garbled: 0, delaySum: 0, worstDelay: 0 };
  }

  // Combine the sender's link and the receiver's link. A report crossing two
  // jammed links is worse off than one crossing a single jammed link.
  profileFor(to, fromPid) {
    const list = [this.linkProfile(to)];
    if (fromPid && fromPid !== to) list.push(this.linkProfile(fromPid));
    const out = { sevDelay: 0, sevDrop: 0, sevGarble: 0, severity: 0, sources: new Set() };
    for (const p of list) {
      if (!p) continue;
      out.sevDelay = Math.max(out.sevDelay, p.sevDelay || 0);
      out.sevDrop = 1 - (1 - out.sevDrop) * (1 - (p.sevDrop || 0));
      out.sevGarble = 1 - (1 - out.sevGarble) * (1 - (p.sevGarble || 0));
      out.severity = Math.max(out.severity, p.severity || 0);
      (p.sources || []).forEach((s) => out.sources.add(s));
    }
    out.sources = [...out.sources];
    return out;
  }

  degraded(pid) { const p = this.linkProfile(pid); return !!p && p.severity > 0; }

  // msg: { kind, from, text, contacts?, pos?, clearArea?, kill?, order?, meta? }
  send(to, msg, fromPid = null) {
    const c = this.cfg;
    const rng = this.rng;
    const rand = (a, b) => a + rng() * (b - a);
    const prof = this.profileFor(to, fromPid);
    const delayAdd = prof.sevDelay > 0 ? (c.delayMin + (c.delayMax - c.delayMin) * prof.sevDelay) * rand(0.7, 1.15) : 0;
    const dropped = rng() < prof.sevDrop * c.dropRate;
    const garbled = !dropped && rng() < prof.sevGarble * c.garbleRate;

    const d = {
      id: ++this.seq, to, from: msg.from, kind: msg.kind,
      sentT: this.t, idealAt: this.t + BASE_LATENCY, dueAt: this.t + BASE_LATENCY + delayAdd,
      dropped, garbled, degraded: prof.severity > 0, severity: prof.severity, sources: prof.sources,
      text: msg.text, forged: !!msg.forged, trueFrom: msg.trueFrom || msg.from,
      contacts: msg.contacts ? msg.contacts.map((k) => ({ ...k })) : null,
      pos: msg.pos || null, clearArea: msg.clearArea || null, kill: msg.kill || null, order: msg.order || null,
      falseBda: !!msg.falseBda, spoofed: !!msg.spoofed, authReply: msg.authReply || null,
      source: msg.source || null, claim: msg.claim || null,
      meta: msg.meta || null,
    };

    if (garbled) {
      d.text = garbleText(d.text, rng);
      if (d.contacts) for (const k of d.contacts) {
        if (rng() < 0.7) { // position drifts — this is what "conflicting reports" feels like
          const a = rand(0, Math.PI * 2), r = rand(60, 150);
          k.x = clamp(k.x + Math.cos(a) * r, 5, 995);
          k.y = clamp(k.y + Math.sin(a) * r, 5, 635);
          k.garbled = true;
        }
        if (rng() < 0.25 && TYPE_CONFUSION[k.type]) { k.type = TYPE_CONFUSION[k.type]; k.garbled = true; }
      }
      if (d.pos && rng() < 0.6) { // a garbled position report puts a friendly in the wrong place
        d.pos = { x: clamp(d.pos.x + rand(-90, 90), 5, 995), y: clamp(d.pos.y + rand(-90, 90), 5, 635) };
        d.posGarbled = true;
      }
    }

    // The clear-comms counterfactual: this is when the receiver could have known.
    if (d.contacts) for (const k of d.contacts) {
      if (k.enemyId) this.awareness.markIdeal(to, k.enemyId, d.idealAt);
    }

    const st = this.stats[to];
    if (st) { st.sent++; if (dropped) st.dropped++; if (garbled) st.garbled++; }

    this.log.push({ id: d.id, to, from: d.from, kind: d.kind, sentT: +d.sentT.toFixed(1), dueAt: +d.dueAt.toFixed(1), dropped, garbled, severity: +prof.severity.toFixed(2) });
    if (this.log.length > 4000) this.log.splice(0, 1000);

    if (dropped) this.onDrop(d); else this.pending.push(d);
    return d;
  }

  tick(t) {
    this.t = t;
    if (!this.pending.length) return;
    const due = [];
    const keep = [];
    for (const d of this.pending) (d.dueAt <= t ? due : keep).push(d);
    if (!due.length) return;
    this.pending = keep;
    due.sort((a, b) => a.dueAt - b.dueAt);
    for (const d of due) {
      const st = this.stats[d.to];
      if (st) {
        st.delivered++;
        const lag = t - d.sentT;
        st.delaySum += lag;
        if (lag > st.worstDelay) st.worstDelay = lag;
      }
      this.onDeliver(d);
    }
  }

  inflight(pid, excludeKinds = ['BFT']) {
    return this.pending.filter((d) => d.to === pid && !excludeKinds.includes(d.kind)).length;
  }

  reset() { this.pending = []; this.log = []; this.seq = 0; this.awareness = new AwarenessLedger(); }
}

module.exports = { CommsNet, AwarenessLedger, BASE_LATENCY, garbleText };
