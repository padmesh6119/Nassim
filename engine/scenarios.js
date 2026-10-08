'use strict';
// Scenario library: enemy force packages, commander's intent, EW layout, red-cell posture.
// The terrain is shared (public/terrain.js); scenarios decide what happens on it.
const T = require('../public/terrain.js');

const DEFAULT_CONFIG = {
  // Tempo
  duration: 300,        // real seconds of exercise
  timeScale: 10,        // mission seconds per real second
  // Force
  intensity: 5,         // how many enemy groups of the package to use
  enemySpeed: 1,
  sensorRange: 110,     // own-eyes detection radius (units; 1 unit = 10 m)
  // Support
  artilleryRounds: 4,
  isrInterval: 6,       // HQ ISR picture broadcast period (real s)
  // Degradation profile — how bad a fully-jammed link is
  delayMin: 6, delayMax: 18,
  dropRate: 0.4,
  garbleRate: 0.45,
  // Spatial EW
  ewEnabled: true,
  // Red cell
  redcell: 'OFF',       // OFF | ASSIST | AUTO
  redcellBudget: 10,
  // Sources in disagreement: seconds between disagreements per commander (0 = only when injected)
  disputeEvery: 0,
  disputeTTL: 50,       // seconds to decide once a disagreement is in front of a commander
  disputeFeedback: false, // tell the commander the truth after each decision — a drill, not a battle
};

// ---------------------------------------------------------------------------
// Enemy force package. Approaches from the north, crosses at the two bridges,
// converges on RAMPUR. `role` lets the red cell time its injects to the plan.
// ---------------------------------------------------------------------------
const RED_PACKAGE = [
  { id: 'E1', type: 'RECON', axis: 'WEST', role: 'recon', size: 0.6, fp: 0.7, speed: 1.35, spawn: 12, start: [300, -10], path: [[300, 150], [300, 305], [380, 420], [505, 492]] },
  { id: 'E2', type: 'ARMOR', axis: 'EAST', role: 'main', size: 1.4, fp: 1.6, speed: 1.0, spawn: 40, start: [760, -10], path: [[752, 150], [750, 300], [640, 430], [530, 495]] },
  { id: 'E3', type: 'MECH INF', axis: 'WEST', role: 'supporting', size: 1.2, fp: 1.25, speed: 0.95, spawn: 75, start: [150, -10], path: [[190, 160], [300, 305], [420, 430], [510, 498]] },
  { id: 'E4', type: 'INFANTRY', axis: 'EAST FLANK', role: 'flanking', size: 1.0, fp: 1.0, speed: 0.85, spawn: 110, start: [1010, 190], path: [[910, 300], [900, 470], [720, 545], [535, 505]] },
  { id: 'E5', type: 'ARMOR', axis: 'EAST', role: 'echelon2', size: 1.4, fp: 1.6, speed: 1.0, spawn: 160, start: [610, -10], path: [[625, 150], [750, 300], [640, 430], [525, 500]] },
  { id: 'E6', type: 'MECH INF', axis: 'WEST FLANK', role: 'echelon2', size: 1.2, fp: 1.25, speed: 0.95, spawn: 200, start: [40, 200], path: [[160, 330], [170, 480], [380, 520], [510, 505]] },
];

// ---------------------------------------------------------------------------
// Commander's intent — the mission-command yardstick. Tasks are geographic and
// machine-checkable, so the AAR can score whether an isolated commander still
// acted within intent instead of waiting for orders.
// ---------------------------------------------------------------------------
const INTENT = {
  commander: 'CO 12 BN',
  text: 'Battalion denies enemy crossing of the GANGA line and retains RAMPUR. The two bridges are the decisive points. '
      + 'If you lose communication with HQ, act to deny your nearest crossing and support the flank in contact — DO NOT wait for orders.',
  tasks: [
    { id: 'DENY_W', pid: 'ALPHA', type: 'deny', area: { x: 300, y: 330, r: 95 }, text: 'Deny enemy crossing at BR WEST' },
    { id: 'DENY_E', pid: 'BRAVO', type: 'deny', area: { x: 750, y: 322, r: 95 }, text: 'Deny enemy crossing at BR EAST' },
    { id: 'HOLD_OBJ', pid: 'CHARLIE', type: 'hold', area: { x: 520, y: 500, r: 85 }, text: 'Retain RAMPUR; be prepared to reinforce either bridge' },
  ],
};

const EMITTERS = {
  westJammer: { id: 'EW1', name: 'JAMMER NORTH-WEST', type: 'JAMMER', x: 230, y: 120, r: 330, power: 1.0, on: true },
  eastJammer: { id: 'EW2', name: 'JAMMER NORTH-EAST', type: 'JAMMER', x: 800, y: 120, r: 330, power: 1.0, on: true },
  centreSpoof: { id: 'EW3', name: 'GPS SPOOFER', type: 'SPOOFER', x: 520, y: 180, r: 420, power: 0.9, on: true },
};

const SCENARIOS = [
  {
    id: 'BASELINE',
    name: 'TRG-1 · BASELINE (CLEAR COMMS)',
    brief: 'Control run. Same enemy, working radios. Use this to measure what degradation costs the same team on TRG-2.',
    package: RED_PACKAGE, intent: INTENT, emitters: [],
    config: { intensity: 5, ewEnabled: false, redcell: 'OFF' },
  },
  {
    id: 'CONTESTED',
    name: 'TRG-2 · CONTESTED EW',
    brief: 'Identical enemy to TRG-1, but two jammers cover the crossings. Radios fail where the fight is. High ground masks the jamming — use it.',
    package: RED_PACKAGE, intent: INTENT,
    emitters: [EMITTERS.westJammer, EMITTERS.eastJammer],
    config: { intensity: 5, ewEnabled: true, redcell: 'ASSIST', redcellBudget: 8 },
  },
  {
    id: 'DRILL',
    name: 'TRG-4 · SOURCE DRILL',
    brief: 'A two-minute round built for repetition. Three sources — a ground patrol, the drone feed and a signals intercept — will disagree about the same ground. Decide who to believe and say how sure you are. With the red cell on, it learns which source you lean on and makes that one lie. Run it three times and the debrief shows whether your judgement improved.',
    package: RED_PACKAGE, intent: INTENT, emitters: [],
    config: { intensity: 3, duration: 120, ewEnabled: false, redcell: 'AUTO', redcellBudget: 0, disputeEvery: 15, disputeTTL: 30, disputeFeedback: true, enemySpeed: 1.2 },
  },
  {
    id: 'DECEPTION',
    name: 'TRG-3 · DECEPTION & CYBER',
    brief: 'Full multi-domain: jamming, GPS spoofing of friendly positions, forged HQ orders and false kill reports, all timed by the red cell.',
    package: RED_PACKAGE, intent: INTENT,
    emitters: [EMITTERS.westJammer, EMITTERS.eastJammer, EMITTERS.centreSpoof],
    config: { intensity: 6, ewEnabled: true, redcell: 'AUTO', redcellBudget: 16, dropRate: 0.5, garbleRate: 0.55, delayMax: 22, disputeEvery: 45 },
  },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Instructor-supplied config is untrusted: clamp every field to a sane band.
function sanitizeConfig(cfg = {}) {
  const out = {};
  const num = (k, a, b) => { if (cfg[k] != null && cfg[k] !== '' && !isNaN(+cfg[k])) out[k] = clamp(+cfg[k], a, b); };
  num('duration', 60, 3600); num('timeScale', 1, 60);
  num('intensity', 1, RED_PACKAGE.length); num('enemySpeed', 0.3, 3); num('sensorRange', 40, 250);
  num('artilleryRounds', 0, 12); num('isrInterval', 2, 30);
  num('delayMin', 0, 60); num('delayMax', 0, 90); num('dropRate', 0, 1); num('garbleRate', 0, 1);
  num('redcellBudget', 0, 40); num('disputeEvery', 0, 300); num('disputeTTL', 10, 300);
  if (cfg.ewEnabled != null) out.ewEnabled = !!cfg.ewEnabled && cfg.ewEnabled !== 'false';
  if (cfg.disputeFeedback != null) out.disputeFeedback = !!cfg.disputeFeedback && cfg.disputeFeedback !== 'false';
  if (cfg.redcell != null && ['OFF', 'ASSIST', 'AUTO'].includes(String(cfg.redcell).toUpperCase())) out.redcell = String(cfg.redcell).toUpperCase();
  if (out.delayMax != null && out.delayMin != null && out.delayMax < out.delayMin) out.delayMax = out.delayMin;
  return out;
}

function getScenario(id) { return SCENARIOS.find((s) => s.id === id) || SCENARIOS[1]; }

// A scenario resolved into the exact numbers the sim runs with.
function buildScenario(id, overrides = {}) {
  const s = getScenario(id);
  return {
    id: s.id, name: s.name, brief: s.brief, terrain: T.name, area: T.area,
    intent: s.intent,
    emitters: s.emitters.map((e) => ({ ...e })),
    package: s.package,
    config: { ...DEFAULT_CONFIG, ...s.config, ...sanitizeConfig(overrides) },
  };
}

module.exports = { SCENARIOS, DEFAULT_CONFIG, RED_PACKAGE, INTENT, EMITTERS, sanitizeConfig, getScenario, buildScenario };
