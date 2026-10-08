'use strict';
// Frame recorder. The scorecard tells you what the fog cost; the replay lets the
// instructor rewind to the exact moment it happened and show truth beside belief.
// Frames are deliberately small and rounded so a whole exercise ships as JSON.

const r0 = (v) => Math.round(v);

class Recorder {
  constructor(interval = 1) {
    this.interval = interval;
    this.frames = [];
    this.bookmarks = [];
    this.last = -Infinity;
  }

  reset() { this.frames = []; this.bookmarks = []; this.last = -Infinity; }

  due(t) { return t - this.last >= this.interval; }

  capture(t, sim) {
    this.last = t;
    const frame = {
      t: +t.toFixed(1),
      clock: sim.missionClock(t),
      u: sim.units.map((u) => ({ p: u.pid, x: r0(u.x), y: r0(u.y), hp: Math.max(0, r0(u.hp)), a: u.alive ? 1 : 0, ps: u.posture[0], tx: u.tx == null ? null : r0(u.tx), ty: u.ty == null ? null : r0(u.ty) })),
      e: sim.enemies.filter((e) => e.spawned).map((e) => ({ id: e.id, tr: e.track || null, ty: e.type, x: r0(e.x), y: r0(e.y), hp: Math.max(0, r0((e.hp / e.maxHp) * 100)), a: e.alive ? 1 : 0 })),
      b: {},
      l: {},
      fx: sim.effects.filter((f) => t - f.t < 1.2).map((f) => ({ x: r0(f.x), y: r0(f.y) })),
      uav: sim.uav.state === 'IDLE' ? null : { x: r0(sim.uav.x), y: r0(sim.uav.y), s: sim.uav.state },
    };
    for (const pid of sim.pids) {
      const b = sim.beliefs[pid];
      frame.b[pid] = {
        tr: Object.values(b.tracks).map((tr) => ({ id: tr.track, ty: tr.type, x: r0(tr.x), y: r0(tr.y), age: +sim.mm(t - tr.infoT).toFixed(1), f: tr.fake ? 1 : 0, g: tr.garbled ? 1 : 0, m: tr.mark, e: tr.enemyId || null })),
        fr: Object.entries(b.friends).map(([p, f]) => ({ p, x: r0(f.x), y: r0(f.y), age: +sim.mm(t - f.infoT).toFixed(1) })),
      };
      const prof = sim.linkProfile(pid);
      frame.l[pid] = { s: +prof.severity.toFixed(2), src: prof.sources.join('+'), acc: Math.round((sim.accuracy[pid] ? sim.accuracy[pid].acc : 1) * 100) };
    }
    this.frames.push(frame);
    if (this.frames.length > 5000) this.frames.splice(0, 500);
  }

  // A teaching moment the instructor can jump straight to in the replay.
  bookmark(t, kind, label, pid = null, clock = null) {
    this.bookmarks.push({ t: +t.toFixed(1), kind, label, pid, clock });
  }

  payload(sim) {
    return {
      interval: this.interval,
      frames: this.frames,
      bookmarks: this.bookmarks,
      emitters: sim.ew.view(),
      intent: sim.scenario.intent,
      pids: sim.pids,
      timeScale: sim.cfg.timeScale,
      duration: sim.cfg.duration,
    };
  }
}

module.exports = { Recorder };
