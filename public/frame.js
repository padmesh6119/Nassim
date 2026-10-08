// Drawing one recorded moment: the ground truth, and one commander's belief laid
// beside it. Shared by the replay and the debrief so a moment always looks the
// same wherever it is shown.
(function () {
  const T = window.TERRAIN;
  const C = window.MAPCOL;

  // Ground truth at frame f. `focus` is the commander being examined.
  function drawTruth(map, f, ctx) {
    const { emitters = [], intent, focus, now = 0, live = true } = ctx;
    map.begin();
    for (const m of emitters) map.emitter(m, live ? now : 0);
    if (intent) {
      for (const task of intent.tasks) {
        const u = f.u.find((x) => x.p === task.pid);
        const covered = u && u.a && Math.hypot(u.x - task.area.x, u.y - task.area.y) < task.area.r * 1.5;
        map.intentArea(task, { covered, text: `${task.pid} — ${task.type}` });
      }
    }
    for (const u of f.u) {
      if (u.a) map.link({ x: u.x, y: u.y }, { severity: f.l[u.p] ? f.l[u.p].s : 0 }, now);
    }
    map.hqMarker();
    for (const e of f.e) {
      map.enemy({ x: e.x, y: e.y, type: e.ty }, { alpha: e.a ? 1 : 0.25, cross: !e.a, text: `${e.tr || 'untracked'}${e.a ? '' : ' destroyed'}` });
    }
    for (const u of f.u) {
      if (u.a && u.tx != null) map.line({ x: u.x, y: u.y }, { x: u.tx, y: u.ty }, 'rgba(27,79,156,0.5)', [5, 4]);
      map.friendly({ pid: u.p, x: u.x, y: u.y, hp: u.hp, alive: !!u.a }, { text: u.p, labelColor: u.p === focus ? C.ink : C.blue });
    }
    if (f.uav) map.uav({ x: f.uav.x, y: f.uav.y, state: f.uav.s });
    for (const fx of f.fx || []) map.blast({ x: fx.x, y: fx.y, t: 0 }, 0.4);
  }

  // What `pid` believed at frame f, with the truth ghosted underneath so the gap
  // reads at a glance: a line from each believed position to the real one, a ring
  // on every threat that is not on their map, violet for things that are not there.
  function drawBelief(map, f, pid, ctx = {}) {
    const { now = 0, showAccuracy = true } = ctx;
    const b = f.b[pid] || { tr: [], fr: [] };
    const me = f.u.find((u) => u.p === pid);
    const L = f.l[pid] || { s: 0, acc: 100 };
    map.begin();
    for (const e of f.e) if (e.a) map.enemy({ x: e.x, y: e.y, type: e.ty }, { alpha: 0.15, hollow: true });

    const seen = new Set();
    for (const t of b.tr) {
      const shown = { x: t.x, y: t.y, type: t.ty };
      if (t.m === 'DISMISSED') { map.enemy(shown, { color: '#8a8378', cross: true, alpha: 0.5, text: `${t.id} rejected` }); continue; }
      if (t.f) { map.enemy(shown, { color: C.violet, text: `phantom ${t.id}` }); continue; }
      const e = f.e.find((x) => x.id === t.e);
      if (e && !e.a) { map.enemy(shown, { color: C.violet, alpha: 0.7, dashed: true, text: `${t.id} already destroyed` }); continue; }
      const off = e ? Math.hypot(e.x - t.x, e.y - t.y) : 0;
      if (e) seen.add(e.id);
      if (off > 25) map.line(shown, e, 'rgba(184,35,43,0.85)', [5, 3], 2);
      map.enemy(shown, { color: t.g ? C.ochre : C.red, dashed: t.age > 0.3, text: `${t.id} ${t.age.toFixed(1)}m old` });
      if (off > 25) map.label(`${Math.round(off * T.UNIT_M)} m out`, (t.x + e.x) / 2, (t.y + e.y) / 2, C.red);
    }
    for (const e of f.e) {
      if (!e.a || seen.has(e.id)) continue;
      map.ring(e, 20 / map.s, C.red, [], 2.4);
      map.label('not on their map', e.x, e.y - 25 / map.s, C.red);
    }
    for (const fr of b.fr) {
      const real = f.u.find((u) => u.p === fr.p);
      if (real && Math.hypot(real.x - fr.x, real.y - fr.y) > 25) map.line(fr, real, 'rgba(27,79,156,0.55)', [3, 3]);
      map.friendly({ pid: fr.p, x: fr.x, y: fr.y, hp: null, alive: true }, { dashed: true, alpha: 0.75, text: `${fr.p} ${fr.age.toFixed(1)}m` });
    }
    if (me && me.a) map.friendly({ pid, x: me.x, y: me.y, hp: me.hp, alive: true }, { me: true, text: pid });
    map.hqMarker();
    if (showAccuracy) {
      map.label(`picture ${L.acc}%`, T.W - 115, 32, L.acc > 75 ? C.green : L.acc > 45 ? C.ochre : C.red, 'left');
    }
    map.static_(L.s * 0.6, now);
  }

  window.FrameDraw = { drawTruth, drawBelief };
})();
