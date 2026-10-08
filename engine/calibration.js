'use strict';
// Calibration and trust — the arithmetic behind "learns how you get fooled"
// and "proves you got better". Pure functions, no simulation state.
//
// A JUDGEMENT is a commander committing to a claim about one report — "that
// enemy is real" or "that area is clear" — with a stated confidence.
// Calibration asks whether stated confidence matches how often they are right:
// someone who says "90%" should be right about nine times in ten.

const { DISPUTABLE, SOURCES } = require('./sources');

const r2 = (v) => Math.round(v * 100) / 100;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Fewer judgements than this and a calibration figure is noise, and is shown as such.
const MIN_N = 5;

// judgements: [{ confidence: 0.5..1, correct: bool }]
function calibrate(judgements) {
  const js = judgements.filter((j) => j.confidence != null && j.correct != null);
  const n = js.length;
  if (!n) return { n: 0, enough: false, brier: null, accuracy: null, meanConfidence: null, overconfidence: null, buckets: [] };
  const brier = mean(js.map((j) => (j.confidence - (j.correct ? 1 : 0)) ** 2));
  const accuracy = mean(js.map((j) => (j.correct ? 1 : 0)));
  const meanConfidence = mean(js.map((j) => j.confidence));
  const edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const inB = js.filter((j) => j.confidence >= edges[i] && j.confidence < edges[i + 1]);
    buckets.push({
      lo: edges[i], hi: Math.min(1, edges[i + 1]), n: inB.length,
      said: inB.length ? r2(mean(inB.map((j) => j.confidence))) : null,
      right: inB.length ? r2(mean(inB.map((j) => (j.correct ? 1 : 0)))) : null,
    });
  }
  return {
    n, enough: n >= MIN_N,
    brier: r2(brier), accuracy: r2(accuracy), meanConfidence: r2(meanConfidence),
    overconfidence: r2(meanConfidence - accuracy),
    buckets,
  };
}

// In plain words, for the debrief.
function describeCalibration(c) {
  if (!c.n) return 'No confidence was stated on any report.';
  const pct = (v) => `${Math.round(v * 100)}%`;
  const base = `Said ${pct(c.meanConfidence)} sure on average and was right ${pct(c.accuracy)} of the time`;
  if (!c.enough) return `${base} — only ${c.n} judgement${c.n === 1 ? '' : 's'}, too few to call.`;
  if (c.overconfidence > 0.1) return `${base}: overconfident.`;
  if (c.overconfidence < -0.1) return `${base}: underconfident — right more often than they believed.`;
  return `${base}: well calibrated.`;
}

const emptyTrust = () => ({ trusted: 0, distrusted: 0, fooled: 0, saved: 0, missed: 0, actedOn: 0 });

function addTrust(a = emptyTrust(), b = emptyTrust()) {
  const out = emptyTrust();
  for (const k of Object.keys(out)) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

function mergeTrustMaps(...maps) {
  const out = {};
  for (const m of maps) for (const [s, v] of Object.entries(m || {})) out[s] = addTrust(out[s], v);
  return out;
}

// The weakness worth attacking. Being fooled counts double — trusting a
// source that has been right is not a weakness. A commander who will not
// commit when sources disagree is a weakness of a different kind.
function weakSpot(trust = {}, disputes = {}) {
  // A commander who gives the same answer whatever the sources say has an
  // answer bias, not a source bias — "always calls it clear" — and should be
  // described that way. Only a weakness if it has cost them.
  // Giving one answer because the sources agree on it is not a bias; giving
  // it while most of them say the opposite is.
  const sp = disputes.saidPresent || 0, sa = disputes.saidAbsent || 0, said = sp + sa;
  const wrong = said - (disputes.correct || 0);
  if (said >= 5 && wrong >= 2) {
    if (sa / said >= 0.85 && (disputes.againstClear || 0) >= 2) return { source: 'SAYS_CLEAR', share: r2(sa / said), said, wrong, against: disputes.againstClear };
    if (sp / said >= 0.85 && (disputes.againstEnemy || 0) >= 2) return { source: 'SAYS_PRESENT', share: r2(sp / said), said, wrong, against: disputes.againstEnemy };
  }
  // A source is a weakness when it has misled them more than once, and at
  // least as often as they caught it lying. One slip is not a pattern. Trusting a source that has only ever been right in front
  // of them is not — that is what good judgement looks like too — but it is
  // untested, and the obvious thing to test next. Kept apart as a probe so the
  // debrief never calls it a weakness.
  let misled = null, untested = null;
  for (const s of DISPUTABLE) {
    const v = trust[s];
    if (!v || v.trusted < 2) continue;
    const judged = v.trusted + v.distrusted;
    const rate = judged ? v.trusted / judged : 0;
    const c = { source: s, trustRate: r2(rate), fooled: v.fooled || 0, saved: v.saved || 0, trusted: v.trusted, judged, score: (v.fooled || 0) * 2 + rate };
    if (c.fooled >= 2 && c.fooled >= c.saved) { if (!misled || c.score > misled.score) misled = c; }
    else if (!c.fooled && !c.saved && rate >= 0.8) { if (!untested || c.trusted > untested.trusted) untested = c; }
  }
  const issued = disputes.issued || 0, froze = disputes.froze || 0;
  if (issued >= 3 && froze / issued >= 0.4 && (!misled || misled.fooled < 2)) {
    return { source: 'FREEZE', freezeRate: r2(froze / issued), issued, froze };
  }
  if (misled) return misled;
  if (untested) return { ...untested, probe: true };
  return null;
}

// Why the adaptive red cell chose its target, said the way an instructor would.
// span: how many rounds the evidence covers; live: whether one is this round.
function weakSpotReason(who, w, span, live = false) {
  const over = span > 1 ? ` across ${span} rounds` : span === 1 ? (live ? ' this round' : ' last round') : ' so far';
  if (!w) return `${who} shows no consistent bias yet${over}.`;
  if (w.source === 'SAYS_CLEAR' || w.source === 'SAYS_PRESENT') {
    const what = w.source === 'SAYS_CLEAR' ? '"the area is clear"' : '"the enemy is there"';
    return `${who} answered ${what} in ${Math.round(w.share * 100)}% of ${w.said} disagreements${over} — ${w.against} times against most of the sources — and was wrong ${w.wrong} times. This one has most sources telling the truth and that answer wrong.`;
  }
  if (w.source === 'FREEZE') {
    return `${who} left ${w.froze} of ${w.issued} disagreements unresolved${over}. This one has two sources wrong and one right, to force a decision under pressure.`;
  }
  const label = SOURCES[w.source].label;
  const trusts = `${who} sided with the ${label} in ${w.trusted} of ${w.judged} judgement${w.judged === 1 ? '' : 's'}${over}`;
  if (w.probe) return `${trusts} and has not yet seen it wrong. This disagreement makes the ${label} the source that is wrong, to find out whether that trust is judgement or habit.`;
  const fooled = w.fooled ? `, and was misled by it ${w.fooled} time${w.fooled === 1 ? '' : 's'}` : '';
  return `${trusts}${fooled}. This disagreement makes the ${label} the source that is wrong.`;
}

module.exports = { calibrate, describeCalibration, emptyTrust, addTrust, mergeTrustMaps, weakSpot, weakSpotReason, MIN_N };
