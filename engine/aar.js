'use strict';
// After Action Review builder.
//
// The one number this file exists to produce is the COST OF FOG: how much later
// each commander learned what they needed than they would have on a clear net,
// and what that lateness actually cost in casualties, rounds and ground.
// Everything else here is evidence for that number.

const T = require('../public/terrain.js');
const { calibrate, describeCalibration, emptyTrust } = require('./calibration');
const { SOURCES, DISPUTABLE, WEAKNESS_LABEL } = require('./sources');
const { seedHex } = require('./rng');

const r1 = (v) => Math.round(v * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// "1 threat was", "3 threats were" — the debrief is read by officers.
const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const was = (n) => (n === 1 ? 'was' : 'were');

// Threats that never came within this distance are not held against the
// commander — being unaware of something 3 km away and leaving never mattered.
const RELEVANT_DIST = 250;

function playerReport(sim, pid) {
  const mm = (s) => sim.mm(s);
  const u = sim.unit(pid);
  const st = sim.stats[pid];
  const cs = sim.comms.stats[pid];
  const task = sim.intentTaskFor(pid);
  const decs = sim.decisions.filter((d) => d.pid === pid);
  const end = sim.t;

  // ---- reaction time: new information → next order -----------------------
  const trig = sim.triggers.filter((tg) => tg.pid === pid);
  const answered = trig.filter((tg) => tg.reactedAt != null);
  const latClear = answered.filter((tg) => !tg.degraded).map((tg) => tg.reactedAt - tg.t);
  const latDeg = answered.filter((tg) => tg.degraded).map((tg) => tg.reactedAt - tg.t);
  const latAll = answered.map((tg) => tg.reactedAt - tg.t);

  // ---- the counterfactual: when could they have known? -------------------
  const threats = [];
  let fogSec = 0;
  for (const e of sim.enemies) {
    const aw = sim.comms.awareness.get(pid, e.id);
    if (aw.ideal == null || aw.minDist > RELEVANT_DIST) continue;
    const never = aw.actual == null;
    const actual = never ? end : aw.actual;
    const lag = Math.max(0, actual - aw.ideal);
    fogSec += lag;
    threats.push({
      enemy: e.id, type: e.type, track: e.track, axis: e.axis,
      closestM: Math.round(aw.minDist * T.UNIT_M),
      idealClock: sim.missionClock(aw.ideal),
      actualClock: never ? 'never' : sim.missionClock(aw.actual),
      lagMin: r1(mm(lag)), never,
    });
  }
  threats.sort((a, b) => b.lagMin - a.lagMin);

  // ---- picture accuracy over time ---------------------------------------
  const accs = sim.series.map((s) => s.acc[pid]).filter((v) => v != null);

  // ---- deception: what did they do with the phantom? ---------------------
  // A phantom staged as one side of a disagreement is scored there, as a
  // judgement — counting it here as well would count one call twice.
  const fakes = sim.fakes.filter((f) => f.to === pid && !f.dispute).map((f) => fakeOutcome(sim, pid, f));

  // ---- cyber: forged orders and false kill reports -----------------------
  const forged = sim.forgedOrders[pid].map((f) => {
    let outcome = 'IGNORED';
    if (!f.received) outcome = 'NOT RECEIVED';
    else if (f.complied) outcome = f.challenged ? 'CHALLENGED, THEN OBEYED ANYWAY' : 'OBEYED WITHOUT AUTHENTICATING';
    else if (f.challenged) outcome = f.authAnsweredAt != null ? 'AUTHENTICATED AND REJECTED' : 'CHALLENGED — no reply reached them, not obeyed';
    else if (f.queried) outcome = 'CHECKED WITH UAV, NOT OBEYED';
    return {
      grid: f.grid, injectedClock: f.clock, text: f.text,
      received: !!f.received, receivedClock: f.receivedClock || null,
      challenged: !!f.challenged, complied: !!f.complied, queried: !!f.queried,
      outcome, outcomeClock: f.compliedClock || null,
    };
  });
  const falseBda = sim.falseBdas[pid].map((f) => {
    let outcome = 'NOT RECEIVED';
    if (f.received) {
      const eng = sim.engagements[pid + '|' + f.enemyId];
      const reacquired = Object.values(sim.beliefs[pid].tracks).some((tr) => tr.enemyId === f.enemyId);
      if (eng && eng.start > (f.receivedT || 0) && eng.surprised) outcome = 'FELL FOR IT — ambushed by the "destroyed" enemy';
      else if (reacquired) outcome = 'RE-ACQUIRED the track';
      else outcome = 'DROPPED from picture, no consequence yet';
    }
    return { track: f.track, type: f.type, injectedClock: f.clock, outcome };
  });

  // ---- contradictory reports --------------------------------------------
  const conf = sim.conflicts[pid];
  const resolved = conf.filter((k) => k.resolvedT != null);
  const conflicts = {
    total: conf.length, resolved: resolved.length,
    resolvedPct: pct(resolved.length, conf.length),
    meanResolveMin: resolved.length ? r1(mm(mean(resolved.map((k) => k.resolvedT - k.t)))) : null,
    worstGapM: conf.length ? Math.max(...conf.map((k) => k.gapM)) : 0,
    list: conf.slice(0, 12).map((k) => ({ track: k.track, clock: k.clock, gapM: k.gapM, resolvedBy: k.resolvedBy, resolveMin: k.resolvedT != null ? r1(mm(k.resolvedT - k.t)) : null })),
  };

  // ---- mission command --------------------------------------------------
  const coverage = st.aliveSec > 0 ? st.coveredSec / st.aliveSec : 0;
  const spans = sim.isolationSpans[pid].map((s) => ({
    startClock: s.startClock, endClock: s.endClock || 'to ENDEX',
    lengthMin: r1(mm((s.end == null ? end : s.end) - s.start)),
    orders: s.acted, movedM: s.moved != null ? s.moved : null, brokeOut: !!s.brokeOutByMovement,
  }));
  const spansActed = spans.filter((s) => s.orders > 0).length;
  const initiative = spans.length ? spansActed / spans.length : 1;
  const myBreaches = sim.breaches.filter((b) => b.pid === pid && !b.covered);
  const drift = sim.driftOrders[pid];
  const compliedForged = forged.filter((f) => f.complied).length;
  const discipline = clamp(1 - 0.34 * drift.length - 0.5 * compliedForged, 0, 1);
  const intentScore = clamp(Math.round(50 * coverage + 30 * initiative + 20 * discipline - 8 * myBreaches.length), 0, 100);

  // ---- judgement: who they believed, and whether their confidence was earned
  const who = sim.whoOf(pid);
  const js = sim.judgements.filter((j) => j.pid === pid);
  const cal = calibrate(js);
  const ds = sim.disputes.filter((d) => d.pid === pid && !d.lost);
  const dst = sim.disputeStats[pid];
  const ws = sim.weakSpotFor(pid);
  const judgement = {
    who,
    calibration: cal,
    summary: describeCalibration(cal),
    trust: Object.fromEntries(DISPUTABLE.map((s) => {
      const v = sim.trust[pid][s] || emptyTrust();
      const judged = v.trusted + v.distrusted;
      return [s, { label: SOURCES[s].label, ...v, judged, rate: judged ? Math.round((v.trusted / judged) * 100) : null }];
    })),
    weakSpot: ws ? {
      source: ws.source,
      label: WEAKNESS_LABEL[ws.source],
      probe: !!ws.probe,
      reason: sim.reasonFor(pid, ws),
    } : null,
    disputes: ds.map((d) => ({
      id: d.id, grid: d.grid, clock: d.clock, variant: d.variant, name: d.variantName, truth: d.truth,
      answer: d.answer, confidence: d.confidence, correct: d.correct, froze: d.froze,
      targeted: d.targeted ? d.targeted.source : null,
      probe: !!(d.targeted && d.targeted.probe),
      liars: d.claims.filter((c) => !c.correct).map((c) => SOURCES[c.source].label),
      heard: d.claims.filter((c) => c.delivered).map((c) => c.source),
      answerMin: d.answeredT != null && d.readyT != null ? r1(mm(d.answeredT - d.readyT)) : null,
    })),
    disputeSummary: {
      issued: ds.length, answered: dst.answered, froze: dst.froze, correct: dst.correct,
      meanAnswerMin: dst.answerSecs.length ? r1(mm(mean(dst.answerSecs))) : null,
      targeted: ds.filter((d) => d.targeted && !d.targeted.probe).length,
      fooledWhenTargeted: ds.filter((d) => d.targeted && !d.targeted.probe && d.answer && !d.correct).length,
      tested: ds.filter((d) => d.targeted && d.targeted.probe).length,
    },
    round: null,
  };
  // Only a round someone actually played goes on their record — an unattended
  // seat would otherwise teach the red cell that its occupant freezes.
  if (sim.engaged.has(pid) && (js.length || ds.length)) {
    judgement.round = {
      at: new Date().toISOString(), scenario: sim.scenario.id, callsign: pid,
      calibration: cal, trust: sim.trust[pid],
      disputes: { issued: ds.length, answered: dst.answered, froze: dst.froze, correct: dst.correct, saidPresent: dst.saidPresent, saidAbsent: dst.saidAbsent, againstClear: dst.againstClear, againstEnemy: dst.againstEnemy,
        // how many were built to catch a habit already on record: a harder
        // round, which the progress chart has to say rather than hide
        aimed: ds.filter((d) => d.targeted && !d.targeted.probe).length,
        aimedWorked: ds.filter((d) => d.targeted && !d.targeted.probe && d.answer && !d.correct).length },
    };
  }

  return {
    pid, name: u.name, hp: Math.max(0, Math.round(u.hp)), alive: u.alive, judgement,
    task: task ? { id: task.id, text: task.text, area: task.area } : null,

    decisions: decs.length, kills: st.kills,
    orderMix: ['MOVE', 'FIRE', 'UAV', 'HOLD', 'MARK'].reduce((o, k) => { o[k] = decs.filter((d) => d.type === k).length; return o; }, {}),
    withRationale: decs.filter((d) => d.rationale).length,

    meanLatencyMin: latAll.length ? r1(mm(mean(latAll))) : null,
    latencyClearMin: latClear.length ? r1(mm(mean(latClear))) : null,
    latencyDegradedMin: latDeg.length ? r1(mm(mean(latDeg))) : null,
    unanswered: trig.filter((tg) => tg.reactedAt == null).length,

    meanAccuracy: accs.length ? Math.round(mean(accs)) : 100,
    minAccuracy: accs.length ? Math.min(...accs) : 100,

    hpLost: Math.round(st.hpLost), blindHpLost: Math.round(st.blindHpLost),
    blindPct: pct(st.blindHpLost, st.hpLost),
    wastedRounds: st.wastedRounds, phantomActions: st.phantomActions,

    comms: {
      sent: cs.sent, delivered: cs.delivered, dropped: cs.dropped, garbled: cs.garbled,
      lostPct: pct(cs.dropped, cs.sent), garbledPct: pct(cs.garbled, cs.sent),
      meanDelayMin: cs.delivered ? r1(mm(cs.delaySum / cs.delivered)) : 0,
      worstDelayMin: r1(mm(cs.worstDelay)),
    },

    ew: {
      jammedMin: r1(mm(st.jammedSec)), jammedPct: pct(st.jammedSec, st.aliveSec),
      maskedMin: r1(mm(st.maskedSec)), isolatedMin: r1(mm(st.isolatedSec)),
      manoeuvredOut: st.manoeuvredOut,
    },

    threats, fogMin: r1(mm(fogSec)),
    fakes, forged, falseBda, conflicts,

    missionCommand: {
      coveragePct: Math.round(coverage * 100),
      breaches: myBreaches.length,
      breachList: myBreaches.map((b) => ({ clock: b.clock, type: b.type, enemy: b.enemy })),
      driftOrders: drift.length, driftList: drift,
      isolationSpans: spans, spansActed, initiativePct: Math.round(initiative * 100),
      compliedWithForgedOrder: compliedForged,
      score: intentScore,
    },
  };
}

// Trace a single deception from injection to how the commander resolved it.
function fakeOutcome(sim, pid, f) {
  const mm = (s) => sim.mm(s);
  const out = { track: f.track, type: f.type, injectedClock: f.clock, grid: T.gridRef(f.x, f.y), source: f.source, by: f.by, outcome: 'IGNORED', steps: [] };
  const tr = sim.beliefs[pid].tracks[f.track];
  const firstT = tr ? tr.firstT : null;
  if (firstT == null && !sim.beliefs[pid].killed[f.track]) {
    out.outcome = 'NEVER RECEIVED';
    out.steps.push('Report was lost in the jammed net — the deception never landed');
    return out;
  }
  out.steps.push(`Received ${sim.missionClock(firstT)}`);
  const decs = sim.decisions.filter((d) => d.pid === pid && d.t >= f.t);
  const verify = decs.find((d) => d.type === 'UAV' && d.x != null && Math.hypot(d.x - f.x, d.y - f.y) < 170);
  const acted = decs.filter((d) => d.onPhantom && (d.ref === f.track || (d.x != null && Math.hypot(d.x - f.x, d.y - f.y) < 130)));
  // a phantom is accepted or rejected either by assessing its track or by deciding the disagreement it was part of
  const about = (d) => (d.type === 'MARK' || d.type === 'RESOLVE') && d.ref === f.track;
  const dismiss = decs.find((d) => about(d) && d.answer === 'absent');
  const suspect = decs.find((d) => d.type === 'MARK' && d.ref === f.track && /SUSPECT/.test(d.desc));
  const confirm = decs.find((d) => about(d) && d.answer === 'present');

  if (verify) out.steps.push(`Tasked the UAV to check it at ${verify.clock}`);
  if (suspect) out.steps.push(`Flagged SUSPECT at ${suspect.clock}`);
  acted.forEach((d) => out.steps.push(`Acted on it — ${d.desc} at ${d.clock}`));
  if (confirm) out.steps.push(`Marked CONFIRMED at ${confirm.clock}`);
  if (dismiss) out.steps.push(`Rejected it at ${dismiss.clock}${firstT != null ? ` (${r1(mm(dismiss.t - firstT))} min after receipt)` : ''}`);

  if (acted.length || confirm) out.outcome = dismiss ? 'DECEIVED, LATER REJECTED' : 'DECEIVED';
  else if (dismiss) out.outcome = verify ? 'VERIFIED AND REJECTED' : 'REJECTED ON JUDGEMENT';
  else if (verify || suspect) out.outcome = 'TREATED WITH SUSPICION';
  else out.outcome = 'UNRESOLVED — left on the picture';
  return out;
}

// The single moment that best shows what the fog did. A wrong picture of an
// empty battlefield teaches little, so the error is weighted by how much was
// actually out there: the most enemy a commander was wrong about, while still
// fighting. Ties go to the more degraded net, since that is the cause on trial.
function keyMoment(sim) {
  let best = null;
  for (const f of sim.recorder.frames) {
    const live = f.e.filter((e) => e.a).length;
    if (live < 2) continue;
    for (const pid of sim.pids) {
      const u = f.u.find((x) => x.p === pid);
      const L = f.l[pid];
      if (!u || !u.a || !L) continue;
      const score = (100 - L.acc) * live;
      if (!best || score > best.score || (score === best.score && L.s > best.sev)) {
        best = { pid, acc: L.acc, sev: L.s, frame: f, score };
      }
    }
  }
  if (!best || best.acc >= 85) return null;
  const f = best.frame;
  const b = f.b[best.pid] || { tr: [] };
  const held = new Set(b.tr.filter((t) => t.m !== 'DISMISSED' && t.e).map((t) => t.e));
  const unseen = f.e.filter((e) => e.a && !held.has(e.id)).length;
  const phantoms = b.tr.filter((t) => t.f && t.m !== 'DISMISSED').length;
  let worst = 0;
  for (const t of b.tr) {
    const e = t.e && f.e.find((x) => x.id === t.e && x.a);
    if (e && t.m !== 'DISMISSED') worst = Math.max(worst, Math.hypot(e.x - t.x, e.y - t.y));
  }
  return {
    pid: best.pid, accuracy: best.acc, clock: f.clock, t: f.t,
    degraded: best.sev > 0, severity: best.sev,
    unseen, phantoms, worstErrorM: Math.round(worst * T.UNIT_M),
    frame: f,
  };
}

function teamReport(sim, players) {
  const mm = (s) => sim.mm(s);
  const cop = sim.cop.map((c) => c.div);
  const hits = sim.nearMiss.filter((n) => n.hit);
  const near = sim.nearMiss.filter((n) => !n.hit);
  const confAll = sim.pids.flatMap((p) => sim.conflicts[p]);
  const confRes = confAll.filter((k) => k.resolvedT != null);
  return {
    copMeanPct: cop.length ? Math.round(mean(cop)) : 0,
    copWorstPct: cop.length ? Math.max(...cop) : 0,
    copSeries: sim.cop,
    mutualSupport: sim.mutualSupport.length,
    mutualSupportList: sim.mutualSupport,
    teamMessages: sim.chatCount || 0,
    fratricide: hits.length,
    fratricideSpoofed: hits.filter((n) => n.spoofed).length,
    dangerClose: near.length,
    nearMissList: sim.nearMiss,
    conflicts: confAll.length,
    conflictsResolved: confRes.length,
    conflictsResolvedPct: pct(confRes.length, confAll.length),
    unanswered: sim.pids.reduce((a, p) => a + players[p].unanswered, 0),
  };
}

function buildReport(sim) {
  const mm = (s) => sim.mm(s);
  const end = sim.t;
  const players = {};
  for (const p of sim.pids) players[p] = playerReport(sim, p);

  const team = teamReport(sim, players);
  const sum = (f) => sim.pids.reduce((a, p) => a + f(players[p]), 0);

  const fogMin = r1(sum((P) => P.fogMin));
  const blindHp = sum((P) => P.blindHpLost);
  const totalHp = sum((P) => P.hpLost);
  const wasted = sum((P) => P.wastedRounds);
  const phantom = sum((P) => P.phantomActions);
  const neverKnew = sim.pids.reduce((a, p) => a + players[p].threats.filter((t) => t.never).length, 0);
  const deceived = sim.pids.reduce((a, p) => a + players[p].fakes.filter((f) => f.outcome.startsWith('DECEIVED')).length, 0);
  const rejected = sim.pids.reduce((a, p) => a + players[p].fakes.filter((f) => f.outcome.includes('REJECTED') || f.outcome === 'TREATED WITH SUSPICION').length, 0);
  const forgedComplied = sum((P) => P.missionCommand.compliedWithForgedOrder);
  const bdaFell = sim.pids.reduce((a, p) => a + players[p].falseBda.filter((f) => f.outcome.startsWith('FELL')).length, 0);

  const latClear = [], latDeg = [];
  for (const p of sim.pids) {
    if (players[p].latencyClearMin != null) latClear.push(players[p].latencyClearMin);
    if (players[p].latencyDegradedMin != null) latDeg.push(players[p].latencyDegradedMin);
  }
  const lc = latClear.length ? r1(mean(latClear)) : null;
  const ld = latDeg.length ? r1(mean(latDeg)) : null;

  const enemiesSpawned = sim.enemies.filter((e) => e.spawned);
  const breached = sim.enemies.some((e) => e.alive && e.atObj);

  // Plain-language findings — what the instructor reads out in the debrief.
  const lines = [];
  if (fogMin > 0) lines.push(`Across the team, commanders learned about the threats that actually reached them ${fogMin} min later than they would have on a clear net.`);
  if (neverKnew) lines.push(`${count(neverKnew, 'closing threat')} never appeared on a commander's picture at all.`);
  if (blindHp > 0) lines.push(`${blindHp} of the ${totalHp} strength lost (${pct(blindHp, totalHp)}%) went to enemies that were not on the commander's picture when contact began.`);
  if (ld != null && lc != null && ld > lc) lines.push(`Orders took ${r1(ld - lc)} min longer to follow new information while the net was degraded (${ld} min vs ${lc} min clear).`);
  if (wasted) lines.push(`${count(wasted, 'artillery round')} hit nothing${phantom ? `, and ${count(phantom, 'order')} ${was(phantom)} aimed at contacts that did not exist` : ''}.`);
  else if (phantom) lines.push(`${count(phantom, 'order')} ${was(phantom)} aimed at contacts that did not exist.`);
  if (deceived) lines.push(`${count(deceived, 'deception')} worked${rejected ? `; ${rejected} ${was(rejected)} rejected or treated with suspicion` : ''}.`);
  const challengedForged = sim.pids.reduce((a, p) => a + players[p].forged.filter((f) => f.challenged && !f.complied).length, 0);
  if (forgedComplied) lines.push(`${count(forgedComplied, 'forged order')} ${was(forgedComplied)} obeyed — a cyber injection changed what the force actually did.`);
  if (challengedForged) lines.push(`${count(challengedForged, 'forged order')} ${was(challengedForged)} challenged over the net and refused — correct procedure under a compromised net.`);
  if (bdaFell) lines.push(`${count(bdaFell, 'commander')} ${was(bdaFell)} ambushed by an enemy that a false kill report had called destroyed.`);
  if (team.fratricide) lines.push(`${count(team.fratricide, 'fratricide incident')}${team.fratricideSpoofed ? `, ${team.fratricideSpoofed} of them after a friendly position report was falsified` : ''}.`);
  if (team.copWorstPct > 40) lines.push(`At worst, the three pictures disagreed by ${team.copWorstPct}% — the team was fighting from three different versions of the battle.`);


  const mcScore = Math.round(mean(sim.pids.map((p) => players[p].missionCommand.score)));

  const allDisputes = sim.pids.flatMap((p) => players[p].judgement.disputes);
  const answered = allDisputes.filter((d) => d.answer);
  const adaptive = sim.redcell.log.filter((l) => l.ruleId === 'ADAPTIVE' || l.ruleId === 'TARGETED_CONTRADICTION');
  const targetedAnswered = allDisputes.filter((d) => d.targeted && d.answer);
  if (allDisputes.length) {
    const froze = allDisputes.filter((d) => d.froze).length;
    lines.push(`Sources disagreed ${count(allDisputes.length, 'time')}; the team called ${answered.filter((d) => d.correct).length} of ${answered.length} right${froze ? `, and left ${froze} unresolved` : ''}.`);
  }
  const aimed = targetedAnswered.filter((d) => !d.probe), tests = targetedAnswered.filter((d) => d.probe);
  if (aimed.length) {
    lines.push(`The red cell aimed ${count(aimed.length, 'disagreement')} at a weakness it had learned; ${aimed.filter((d) => !d.correct).length} of them worked.`);
  }
  if (tests.length) {
    lines.push(`It also tested ${count(tests.length, 'trust')} nobody had yet seen fail; ${tests.filter((d) => !d.correct).length} of those tests caught someone out.`);
  }
  const teamCal = calibrate(sim.judgements);
  if (!lines.length) lines.push('Communications degradation did not measurably cost this team on this run.');

  return {
    generatedAt: new Date().toISOString(),
    startedAt: sim.startedAt,
    // Seed + starting state + inputs = the whole exercise, re-runnable.
    seed: sim.seed, seedHex: seedHex(sim.seed),
    endT: sim.t,
    cfg0: sim.cfg0, who0: sim.who0, profiles0: sim.profiles0 || {},
    inputs: sim.inputs,
    scenario: { id: sim.scenario.id, name: sim.scenario.name, brief: sim.scenario.brief, area: sim.scenario.area, terrain: T.name },
    intent: sim.scenario.intent,
    endReason: sim.endReason,
    durationMin: r1(mm(end)),
    startClock: sim.missionClock(0),
    endClock: sim.missionClock(end),
    config: sim.cfg,
    timeScale: sim.cfg.timeScale,

    outcome: {
      enemiesKilled: enemiesSpawned.filter((e) => !e.alive).length,
      enemiesTotal: enemiesSpawned.length,
      objectiveHeld: !breached,
      friendlyAlive: sim.units.filter((u) => u.alive).length,
      friendlyTotal: sim.units.length,
      intentBreaches: sim.breaches.filter((b) => !b.covered).length,
    },

    costOfFog: {
      reactionDelayMin: fogMin,
      threatsNeverSeen: neverKnew,
      blindHp, totalHp, blindPct: pct(blindHp, totalHp),
      wastedRounds: wasted, phantomActions: phantom,
      latencyClearMin: lc, latencyDegradedMin: ld,
      latencyPenaltyMin: lc != null && ld != null ? r1(ld - lc) : null,
      deceptionsSucceeded: deceived, deceptionsRejected: rejected,
      forgedOrdersObeyed: forgedComplied, falseBdaAmbushes: bdaFell,
      summary: lines,
    },

    missionCommand: {
      intent: sim.scenario.intent,
      teamScore: mcScore,
      method: 'Score = 50 × time covering the assigned task area + 30 × share of isolated periods in which the commander still acted + 20 × order discipline, less 8 per uncovered breach.',
      tasks: sim.scenario.intent.tasks.map((k) => ({
        ...k,
        coveragePct: players[k.pid].missionCommand.coveragePct,
        breaches: players[k.pid].missionCommand.breaches,
        score: players[k.pid].missionCommand.score,
      })),
    },

    team,
    players,
    redcell: { mode: sim.cfg.redcell, spent: sim.redcell.spent, log: sim.redcell.log },
    judgement: {
      calibration: teamCal,
      summary: describeCalibration(teamCal),
      disputes: allDisputes.length, answered: answered.length,
      correct: answered.filter((d) => d.correct).length,
      froze: allDisputes.filter((d) => d.froze).length,
      targeted: adaptive.length,
    },
    progress: {},
    keyMoment: keyMoment(sim),
    decisions: sim.decisions,
    events: sim.events,
    interventions: sim.interventions,
    emitters: sim.ew.view(),
    series: sim.series,
    bookmarks: sim.recorder.bookmarks,
    replay: sim.recorder.payload(sim),
  };
}

module.exports = { buildReport, playerReport, fakeOutcome };
