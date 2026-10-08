'use strict';
// Sources, and deliberate disagreement between them.
//
// A jammed radio only delays the truth. The harder problem — and the one the
// problem statement names, "land–air–cyber–EW … contradictory" — is three
// sources from three domains telling a commander three different things about
// the same ground. The commander's job is to decide who to believe.
//
// Each contradiction fixes the ground truth first, then decides which sources
// lie about it. Who lies is what the adaptive red cell chooses.

const T = require('../public/terrain.js');

const SOURCES = {
  EYES:   { id: 'EYES',   label: 'own eyes',          tag: 'EYES' },
  SCOUT:  { id: 'SCOUT',  label: 'ground report',     tag: 'GROUND' },   // a patrol, or a flank commander's eyes passed on
  UAV:    { id: 'UAV',    label: 'drone feed',        tag: 'DRONE' },
  SIGINT: { id: 'SIGINT', label: 'signals intercept', tag: 'SIGINT' },
  HQ:     { id: 'HQ',     label: 'battalion HQ',      tag: 'HQ' },
};

// Sources whose reports a commander can be asked to weigh. Own eyes are never
// in dispute, and HQ passes orders rather than sightings.
const DISPUTABLE = ['SCOUT', 'UAV', 'SIGINT'];

// stance: what the source effectively says about whether enemy is at the spot.
// SIGINT speaks indirectly: "the drone is compromised" is a claim that the
// drone's sighting is false.
//
// Every source can be wrong in both directions — reporting an enemy that is
// not there, and missing one that is. If a source only ever lied one way, a
// trainee could learn its habit instead of weighing the evidence, and trusting
// the drone would be indistinguishable from always saying "enemy".
const VARIANTS = {
  DRONE_SPOOFED: {
    truth: 'absent', liars: ['UAV'], exploits: 'UAV',
    name: 'drone feed spoofed',
    says: { SCOUT: 'absent', UAV: 'present', SIGINT: 'drone-compromised' },
  },
  DRONE_MISSED: {
    truth: 'present', liars: ['UAV'], exploits: 'UAV',
    name: 'enemy under cover, missed by the drone',
    says: { SCOUT: 'present', UAV: 'absent', SIGINT: 'traffic-present' },
  },
  SCOUT_STALE: {
    truth: 'present', liars: ['SCOUT'], exploits: 'SCOUT',
    name: 'patrol report out of date',
    says: { SCOUT: 'absent', UAV: 'present', SIGINT: 'traffic-present' },
  },
  SCOUT_FALSE: {
    truth: 'absent', liars: ['SCOUT'], exploits: 'SCOUT',
    name: 'patrol mistook what it saw',
    says: { SCOUT: 'present', UAV: 'absent', SIGINT: 'no-traffic' },
  },
  SIGINT_FOOLED: {
    truth: 'present', liars: ['SIGINT'], exploits: 'SIGINT',
    name: 'intercept planted to discredit the drone',
    says: { SCOUT: 'present', UAV: 'present', SIGINT: 'drone-compromised' },
  },
  SIGINT_DUMMY: {
    truth: 'absent', liars: ['SIGINT'], exploits: 'SIGINT',
    name: 'dummy radio net, nobody there',
    says: { SCOUT: 'absent', UAV: 'absent', SIGINT: 'traffic-present' },
  },
  TWO_LIE: {
    truth: 'absent', liars: ['SCOUT', 'UAV'], exploits: 'FREEZE',
    name: 'two sources wrong, one right',
    says: { SCOUT: 'present', UAV: 'present', SIGINT: 'no-traffic' },
  },
};

// The weakness each variant is built to exploit.
// Every exploit must be a case that good judgement gets RIGHT. Then failing it
// shows the bias is still there, and passing it shows it is gone — which is
// what lets the record prove improvement. DRONE_SPOOFED, SCOUT_STALE and
// SIGINT_FOOLED and their mirror images each have the majority of sources
// telling the truth, so someone weighing all three passes while someone
// leaning on the liar fails. TWO_LIE has the majority wrong; it beats careful
// people too, so it is kept for pressing a commander who will not decide.
// A source is attacked both ways in turn, so the habit being tested is
// "believes the drone", not "says enemy whenever the drone does".
const VARIANT_FOR = {
  UAV: ['DRONE_SPOOFED', 'DRONE_MISSED'],
  SCOUT: ['SCOUT_STALE', 'SCOUT_FALSE'],
  SIGINT: ['SIGINT_FOOLED', 'SIGINT_DUMMY'],
  FREEZE: ['TWO_LIE'],
  SAYS_CLEAR: ['SCOUT_STALE', 'DRONE_MISSED', 'SIGINT_FOOLED'],     // the enemy is there; most sources say so
  SAYS_PRESENT: ['DRONE_SPOOFED', 'SCOUT_FALSE', 'SIGINT_DUMMY'],   // nothing is there; most sources say so
};
// How to say each weakness to an instructor.
const WEAKNESS_LABEL = {
  UAV: 'drone feed', SCOUT: 'ground report', SIGINT: 'signals intercept',
  FREEZE: 'hesitation when sources disagree',
  SAYS_CLEAR: 'calling it clear whatever the sources say',
  SAYS_PRESENT: 'calling it enemy whatever the sources say',
};
// Untargeted rotation: each source lies once each way, enemy-there and
// nothing-there alternating, so a first round measures without teaching.
const BALANCED = ['DRONE_SPOOFED', 'SCOUT_STALE', 'SIGINT_DUMMY', 'DRONE_MISSED', 'SCOUT_FALSE', 'SIGINT_FOOLED'];

// What a targeted attack does, in the red cell's own terse register
// ("JAM ALPHA", "FAKE ARMOR → BRAVO"). The reason carries the why.
const ATTACK = {
  DRONE_SPOOFED: 'SPOOF DRONE', DRONE_MISSED: 'HIDE FROM DRONE',
  SCOUT_STALE: 'STALE PATROL', SCOUT_FALSE: 'MISLEAD PATROL',
  SIGINT_FOOLED: 'FOOL SIGINT', SIGINT_DUMMY: 'DUMMY NET',
  TWO_LIE: 'TWO SOURCES LIE',
};
const attackLabel = (variant, pid) => `${ATTACK[variant] || 'DISAGREEMENT'} → ${pid}`;

// What most of the sources a commander actually heard were saying.
function majorityOf(claims) {
  const heard = claims.filter((c) => c.delivered);
  const present = heard.filter((c) => c.stance === 'present').length;
  if (present * 2 === heard.length) return null;
  return present * 2 > heard.length ? 'present' : 'absent';
}

function stanceOf(says, uavSays) {
  if (says === 'present' || says === 'absent') return says;
  if (says === 'traffic-present') return 'present';
  if (says === 'no-traffic') return 'absent';
  if (says === 'drone-compromised') return uavSays === 'present' ? 'absent' : 'present';
  return 'absent';
}

// Message text for one source's claim about one spot.
function claimText(source, says, grid, sector, type = 'ARMOR') {
  const what = { ARMOR: 'armour, four vehicles', 'MECH INF': 'mechanised infantry in carriers', INFANTRY: 'infantry, platoon strength', RECON: 'a recce group, two vehicles' }[type] || 'enemy vehicles';
  switch (source) {
    case 'SCOUT':
      return says === 'present'
        ? `PATROL ${grid}: vehicles and dismounts seen moving south. Strength unknown.`
        : `PATROL ${grid}: area checked on foot. No enemy seen.`;
    case 'UAV':
      return says === 'present'
        ? `DRONE FEED ${grid}: ${what}, in the open.`
        : `DRONE FEED ${grid}: no contact.`;
    case 'SIGINT':
      if (says === 'drone-compromised') return `SIGINT: hostile interference on the drone downlink over sector ${sector}. Treat drone imagery from that sector as suspect.`;
      if (says === 'traffic-present') return `SIGINT: armoured net traffic fixed near ${grid}.`;
      return `SIGINT: no hostile net traffic from around ${grid}.`;
    default:
      return '';
  }
}

// Where to stage a contradiction. A "present" truth needs a real enemy the
// commander cannot already see; an "absent" truth needs empty ground on the
// enemy's side of them. Returns null when the ground cannot support it.
function placeFor(sim, pid, truth, rand) {
  const u = sim.unit(pid);
  if (!u || !u.alive) return null;
  const range = sim.cfg.sensorRange;
  if (truth === 'present') {
    const cands = sim.enemies
      .filter((e) => e.spawned && e.alive)
      .map((e) => ({ e, d: T.dist(u, e) }))
      .filter((c) => c.d > range * 1.15 && c.d < 480)
      .sort((a, b) => a.d - b.d);
    if (!cands.length) return null;
    const { e } = cands[0];
    return { x: e.x, y: e.y, enemy: e };
  }
  for (let i = 0; i < 40; i++) {
    const ang = -Math.PI / 2 + (rand() - 0.5) * Math.PI * 1.1;   // mostly towards the enemy's side
    const r = range * 1.4 + rand() * 150;
    const x = Math.max(40, Math.min(T.W - 40, u.x + Math.cos(ang) * r));
    const y = Math.max(40, Math.min(T.H - 40, u.y + Math.sin(ang) * r));
    const near = sim.enemies.some((e) => e.spawned && e.alive && T.dist(e, { x, y }) < 170);
    if (!near && T.dist(u, { x, y }) > range * 1.15) return { x, y, enemy: null };
  }
  return null;
}

module.exports = { SOURCES, DISPUTABLE, VARIANTS, VARIANT_FOR, WEAKNESS_LABEL, BALANCED, attackLabel, stanceOf, majorityOf, claimText, placeFor };
