# FOGLINE — handoff for review

**Read this first:** the user has rejected the current state. Their words: *"Not up to par, checked
it and i don't feel comfortable, ugly UI, i'll say this is like 20% of my expectations."*

The engine is solid and well tested. **The interface is the problem.** The root cause is specific and
worth stating plainly, because it shapes what you should do next: the previous session **never looked
at the UI**. The Chrome extension was not connected, headless screenshots were attempted and failed,
and the work was declared done on the strength of passing tests alone. Every visual decision in this
codebase is therefore unverified by eye. Treat the whole visual layer as a draft that has never been
reviewed, not as a thing to patch.

---

## 1. What this is

FOGLINE — immersive multi-domain decision-making trainer for degraded communication environments.

> An AR/VR or web-based tool that places small-team and sub-unit commanders in multi-domain scenarios
> (land–air–cyber–EW) where information feeds are deliberately incomplete, delayed or contradictory,
> training decision-making under uncertainty rather than under ideal conditions.

Required outcomes, verbatim from the problem statement:

1. Scenario engine that can inject communication degradation (delay, dropout, conflicting reports) mid-exercise.
2. Multiplayer for team-level coordination under degraded information.
3. Instructor dashboard to configure scenario variables and monitor trainee decisions in real time.
4. Exportable AAR reports capturing individual and team decision timelines and rationale.

All four have a working implementation. See §4.

### The agreed positioning

Settled with the user earlier in the session, and it should survive any redesign:

- This is a **decision-measurement tool, not a war game**. Never call it a game to judges.
- The headline metric is the **cost of fog**: how much later commanders learned what they needed than
  they would have on a clear net, plus the share of casualties taken blind.
- Deliberately out of scope: 3D, VR, more unit types, more weapons. Depth of measurement beats breadth
  of simulation for this audience.
- Strongest demo: run `TRG-1 BASELINE` (clear comms) and `TRG-2 CONTESTED EW` back to back. Identical
  enemy package, so the scorecard difference is purely the degradation.

### Demo constraints (from the team, non-negotiable)

3 laptops + 1 projected instructor screen, local WiFi, **no internet**, 5 minutes in front of judges.
This is why there are zero dependencies and no build step.

---

## 2. How to run it

```bash
cd /path/to/fogline
npm start        # server on :3000, prints a URL per station
npm test         # 48 tests: 35 engine + 13 frontend contract
npm run test:fuzz   # same, with the real RNG instead of the seeded one
```

Node 18+. No dependencies, no build.

| Station | Route |
|---|---|
| Instructor (projected) | `/instructor` |
| Commanders | `/trainee?pid=ALPHA` · `BRAVO` · `CHARLIE` |
| Replay | `/replay` |
| AAR report | `/report` |

Two saved exercises are already in `aar/`, so `/report` and `/replay` have real data immediately.

---

## 3. Architecture

```
server.js              HTTP + SSE, run persistence, CSV/JSON export       306 lines
engine/
  sim.js               ground truth, belief, combat, actions, views      1040
  aar.js               all metrics and report assembly                    326
  redcell.js           AI adversary: rules, cooldowns, written reasons    285
  comms.js             the radio net + the awareness ledger               161
  scenarios.js         force packages, intent, EW layout, presets         120
  recorder.js          frame recorder for replay                           64
  ew.js                EW field: emitters, falloff, terrain masking        62
public/
  terrain.js           shared geography, loaded by server AND browser      79
  map.js               tactical map renderer, shared by 3 screens         420
  report.html/.js      after action review                            106/452
  instructor.html/.js  instructor console                             120/388
  replay.html/.js      scrubbable replay                               74/254
  trainee.html/.js     commander station                               79/251
  style.css            all shared styling                                 118
test/
  engine.test.js       35 tests                                           550
  frontend.test.js     13 tests                                           270
```

~5,800 lines. The engine does no rendering and no I/O, which is why it is testable.

### The central idea

Three things run side by side and are **never** allowed to be the same object:

1. **Ground truth** — where everything actually is. Only the instructor sees it.
2. **Belief** — what each commander's screen says, built *only* from reports that reached them, each
   carrying its age and its source.
3. **The ledger** — for every (commander, threat) pair: the time awareness was *possible* versus the
   time it actually happened.

The trainee acts on (2). The debrief prices the gap between (2) and (3). A test asserts that a trainee
view never leaks ground truth.

---

## 4. What is implemented

### Comms degradation (`engine/comms.js`)
Every report in the exercise rides one bus. A message crossing two degraded links is worse off than
one crossing a single degraded link. Degradation has three independent channels:

- **delay** — arrival pushed out by `delayMin..delayMax` scaled by severity; the sent time is shown to
  the trainee, so a sharp commander notices staleness.
- **dropout** — the report never arrives.
- **garble** — text breaks up (`▒`), reported positions drift 60–150 units, and unit types get confused
  (ARMOR ↔ MECH INF). This is how "contradictory reports" are produced; the sim then detects when two
  reports of one track arrive within 20 s more than 100 units apart, and whether the commander resolved it.

### EW as geography (`engine/ew.js`)
Jammers and GPS spoofers are **placed on the map**. Severity falls off with distance, and **high ground
masks it** (×0.35) — so "manoeuvre to restore comms" is a real tactical decision, and the AAR credits a
commander who solves it that way. Trainees get a direction-finding bearing cut (±spread), never the
emitter's position.

### Cyber injects
- **Forged HQ order** — looks exactly like a real HQ order.
- **False kill report** — tells a commander a live enemy is destroyed, removing it from their picture.
- **GPS spoofing** — falsifies one commander's position in the others' pictures. Leads to real
  fratricide, which the AAR attributes to the spoof.
- **Counter-play:** trainees have an `AUTHENTICATE` action to challenge a suspicious order over the
  net. HQ replies NEGATIVE for a forged one — but the reply rides the degraded link, so a jammed
  commander may never hear back and must decide anyway. This is the doctrinally correct answer and is
  scored.

### AI red cell (`engine/redcell.js`)
Rules-based adversary for the information domain. No model, no network. Seven rules:

| Rule | Fires when |
|---|---|
| `PRECONTACT_JAM` | A commander's net is clear and an enemy is seconds from contact |
| `FLANK_FAKE` | A commander is committed, so a phantom on the far flank pulls them off the decisive point |
| `ISOLATE_RESERVE` | Two or more enemy groups are committing at the crossings |
| `FALSE_BDA` | A live threat they are tracking is closing but not yet visible |
| `FORGED_ORDER` | A commander is cut off and cannot authenticate |
| `SPOOF_POSITION` | Teammates are close enough to plan around a ghost |
| `WINDOW` | After a long blackout, to see whether they exploit restored comms |

Three modes: `OFF`; `ASSIST`, where it **proposes** with a written justification and the instructor
approves with one click; `AUTO`, where it acts alone within a budget. Global cooldown 10 s, per-player
18 s, per-rule 30–80 s, and it never blacks out more than 2 of 3 commanders at once. Every action
records *why*, and that text survives into the report. **This is the "Smart Automation" theme hook.**

### Mission command
Commander's intent is issued to all three at START. Each has a machine-checkable geographic task
(`deny BR WEST`, `deny BR EAST`, `retain RAMPUR`). Scored:

```
score = 50 × (time holding the assigned task area)
      + 30 × (share of isolated periods in which they still issued an order)
      + 20 × (order discipline)
      −  8 × (each uncovered breach of their area)
```

The thing this is really testing: when a commander is cut off, do they keep acting on intent or freeze?

---

## 5. Metric definitions (don't re-derive these)

| Metric | Definition |
|---|---|
| **Cost of fog** | Σ over (commander, threat that came within 2.5 km) of `actual_awareness_time − earliest_possible_awareness_time`, in mission minutes |
| **Blind casualties** | HP lost in the first 15 s of an engagement that began with a *surprise* sighting — i.e. the threat was absent from, dismissed on, or >100 units off on their picture |
| **Picture accuracy** | `1 − (Σ position error normalised to 250u + phantom count) / (live enemies + phantoms)`, sampled 1 Hz |
| **COP divergence** | Mean pairwise disagreement between the three belief sets, sampled 1 Hz |
| **Reaction latency** | Time from a *new* track appearing on a commander's picture to their next order |
| **Phantom action** | An order whose target is within 110 units of an injected fake with no real enemy nearby |

---

## 6. API surface

```
GET  /events?role=trainee&pid=X | role=instructor   SSE: history, msg, state, feed, decision, reset, ended
POST /api/action    { pid, type: move|hold|fire|uav|mark|auth|chat, x, y, rationale, ref }
POST /api/admin     { type: start|pause|end|reset|scenario|config|link|fake|falseBda|forgedOrder
                            |spoof|emitter|message|redcell|bookmark }
GET  /api/aar  /api/aar.csv  /api/aar.json  /api/replay  /api/scenarios  /api/runs
GET  /api/run/:id   /api/compare?a=<id|current>&b=<id|current>   /api/clients
```

State is pushed at 5 Hz. Trainee snapshot ~15 KB, instructor ~40 KB.

---

## 7. What is verified, and what is not

**Verified.** 48 tests pass, deterministic (seeded RNG, re-seeded per test from the test name) and also
green in fuzz mode. All routes return 200. SSE streams confirmed for both roles. Two full exercises ran
end to end through the live server. The report renderer was executed against a real report inside a DOM
stub, asserting no `undefined`/`NaN` reaches the page, and contract tests pin every field each screen
reads out of the live views.

The A/B result, same enemy package, information conditions the only difference:

| | A: clear comms | B: jammed + deception |
|---|---|---|
| Cost of fog | 0 min | **+4.7 min** |
| Blind casualties | 0 | **26 HP (81% of all losses)** |
| Orders on phantoms | 0 | 1 |
| COP divergence | 1% | **61%** |
| Mission command | 100 | 90 |

**Not verified — this is the gap.** Nobody has looked at any page. No screenshot exists. Layout,
spacing, type, colour, density, hierarchy, responsiveness, and whether any of it reads well on a
projector at the back of a room are all unknown.

**A practical note if you try to screenshot it:** headless Chrome hangs on these pages. The SSE
connection means the page never reaches load-complete, so `--virtual-time-budget` never settles and
`--screenshot` never fires. Use CDP with an explicit capture after a fixed delay, or Playwright with
`waitUntil: 'domcontentloaded'` plus a timed wait, or just connect the Chrome extension and look.

---

## 8. Honest assessment of the visual layer

What is there now, so you can judge it without reading all the CSS:

- One dark palette (`#070a08` page, `#0f1612` panels, `#22312a` borders) with status colours
  (green/amber/red/blue/magenta/cyan) on top.
- `ui-monospace` for essentially every piece of text, on the reasoning that it reads as a military
  terminal.
- Everything is a bordered rounded rectangle. Same 6–7px radius on every panel regardless of hierarchy.
- The instructor console is a 3-column CSS grid with a row of 3 player cards beneath; dense, with a lot
  of small controls competing for attention.
- The report uses a validated chart palette (checked with the dataviz validator for lightness band,
  chroma, CVD separation and contrast against `#0f1612`) — the *charts* are probably the most defensible
  part visually; the page they sit on is not.

Against the design guidance in the `frontend-design` skill, this lands squarely in two known generic
clusters: **"near-black background with bright accents"** and **"the SaaS-card kit — identical rounded
cards, one border-radius on everything, the same treatment regardless of hierarchy"**, plus the
monospace-for-all-data-labels tell. It is a default, not a choice. That is very likely what the user is
reacting to.

What a redesign should probably keep:
- The truth-beside-belief split. That is the product's one genuinely distinctive visual idea.
- The chart palette and the validated colour work in the report.
- Information density on the instructor console — it is a control surface, not a landing page.

What it should probably reconsider from scratch:
- Typography. One monospace family for everything is a shortcut, not a decision. Military map and
  operations-order typography has real, specific conventions worth mining.
- The uniform card grid. Hierarchy is currently carried almost entirely by colour, barely at all by
  scale, weight, or spatial grouping.
- The trainee screen. It is the thing three people stare at for the whole exercise and it got the least
  design attention.
- Whether the instructor console survives projection. Nobody has checked it at distance.

---

## 9. Open questions for the user

The previous session did not ask these, and should have:

1. Is "20% of expectations" **only** the visual design, or is the product shape wrong too (scope, flow,
   what the screens even are)?
2. Is there a reference — a product, a game, a dashboard, an aesthetic — that looks like what they had
   in mind? One screenshot would be worth more than any amount of further guessing.
3. Who is the real audience for the look: staff officers who want it to feel like real military software,
   or hackathon judges who want it to look impressive in 5 minutes? These pull in different directions.
4. Is AR/VR expected? The problem statement says "AR/VR **or** web-based". The current build is web, and
   the user has not objected, but it has not been confirmed either.

---

## 10. Suggested order of work

1. **Look at it first.** Get screenshots of all four screens before changing a line.
2. **Ask question 2 above.** A reference image collapses most of the uncertainty.
3. Redesign the trainee station first — highest dwell time, least attention so far.
4. Then the instructor console, tested at projector distance.
5. The report is closest to acceptable; leave it until last.
6. Do not touch `engine/` or `test/`. The simulation and its metrics are not the problem, and the tests
   are the safety net that lets the UI be rebuilt freely. `npm test` must stay green — the 13 frontend
   contract tests will catch a rename that breaks a screen.
