'use strict';
// Electronic warfare field. Emitters sit on the map, so degradation is a place,
// not a switch: a commander can manoeuvre out of a jammer or put a hill between
// themselves and it. That makes "restore your comms" a tactical decision.
const T = require('../public/terrain.js');

const DEADBAND = 0.12; // below this, treat the link as clear rather than faintly broken

class EwField {
  constructor(emitters = [], enabled = true) {
    this.emitters = emitters.map((e) => ({ ...e }));
    this.enabled = enabled;
  }

  add(e) {
    const id = e.id || 'EW' + (this.emitters.length + 1);
    const em = { id, name: e.name || (e.type === 'SPOOFER' ? 'GPS SPOOFER' : 'JAMMER') + ' ' + id, type: e.type === 'SPOOFER' ? 'SPOOFER' : 'JAMMER', x: e.x, y: e.y, r: e.r || 330, power: e.power || 1, on: e.on !== false };
    this.emitters.push(em);
    return em;
  }
  remove(id) { this.emitters = this.emitters.filter((e) => e.id !== id); }
  toggle(id) { const e = this.emitters.find((x) => x.id === id); if (e) e.on = !e.on; return e; }
  get(id) { return this.emitters.find((e) => e.id === id); }

  // Strongest effect on a point, and which emitter caused it.
  // Returns { severity 0..1, emitter, masked, bearing } — masked means high
  // ground sits between the point and the emitter, cutting the effect.
  sample(pos, type = 'JAMMER') {
    let best = { severity: 0, emitter: null, masked: false, bearing: null };
    if (!this.enabled) return best;
    for (const e of this.emitters) {
      if (!e.on || e.type !== type) continue;
      const d = T.dist(pos, e);
      if (d >= e.r) continue;
      const masked = T.masked(pos, e);
      // Smooth falloff: full power at the emitter, nothing at the edge.
      let s = e.power * Math.pow(1 - d / e.r, 0.65);
      if (masked) s *= 0.35;
      if (s > best.severity) best = { severity: Math.min(1, s), emitter: e, masked, bearing: T.bearing(pos, e) };
    }
    if (best.severity < DEADBAND) return { severity: 0, emitter: null, masked: false, bearing: null };
    return best;
  }

  jamAt(pos) { return this.sample(pos, 'JAMMER'); }
  spoofAt(pos) { return this.sample(pos, 'SPOOFER'); }

  // What a trainee is allowed to know: a coarse direction-finding cut, not the
  // emitter's exact location. u01 is a [0,1) draw from the caller — view noise,
  // never the exercise's own stream.
  dfCut(pos, u01) {
    const s = this.jamAt(pos);
    if (!s.emitter || s.severity < 0.25) return null;
    const spread = 30 - 18 * s.severity; // stronger signal → tighter bearing
    const jitter = (u01 - 0.5) * spread;
    const bearing = (s.bearing + jitter + 360) % 360;
    return { bearing: Math.round(bearing), spread: Math.round(spread), name: T.bearingName(bearing), severity: s.severity, masked: s.masked };
  }

  view() { return this.emitters.map((e) => ({ ...e })); }
}

module.exports = { EwField, DEADBAND };
