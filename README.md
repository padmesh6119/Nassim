# FOGLINE

**An immersive multi-domain decision-making trainer for degraded communication environments.**

Smart India Hackathon · Problem statement **26248** · Ministry of Defence · Defence Services Staff College.

Existing training formats — TEWTs, command post exercises — quietly assume that every radio call
arrives, on time, and is true. Electronic warfare and cyber disruption break exactly that assumption,
at exactly the moment a junior commander has to decide something.

FOGLINE puts three commanders in a land–air–cyber–EW scenario where the information feeds are
deliberately incomplete, delayed, contradictory or false, and then **measures how well they decided
anyway**. It ends with one number: the **cost of fog**.

---

## Run it

```bash
npm start            # server on :3000, prints a URL per station
npm test             # 98 tests: engine, judgement and adaptation, frontend contract
npm run shots        # with the server running, screenshots all five screens
```

Node 18+. **No dependencies, no build step, no internet.** The server prints a URL per station:

| Station | URL |
|---|---|
| Instructor (project this one) | `/instructor` |
| Commander ALPHA / BRAVO / CHARLIE | `/trainee?pid=ALPHA` … |
| Replay | `/replay` |
| AAR report | `/report` |

Demo setup: one laptop runs the server, the other three open their commander URL over local WiFi.
Nothing leaves the room — which is the point, for a closed defence network.

---

## The idea in one paragraph

Three things run side by side and are never allowed to be the same object:

1. **Ground truth** — where everything actually is. Only the instructor sees it.
2. **Belief** — what each commander's screen says, built *only* from reports that reached them, each
   carrying its age and its source.
3. **The ledger** — for every threat and every commander, the time awareness was *possible* versus the
   time it actually happened.

The trainee acts on (2). The debrief prices the gap between (2) and (3).

---

## The layer other teams will not have

- **Sources disagree on purpose.** A ground patrol, the drone feed and a signals intercept contradict
  each other about the same grid. The trainee decides who to believe — the commander's real problem is
  not missing information but knowing what to trust. Every source can be wrong both ways — a spoofed
  drone shows armour that isn't there, a drone misses armour under cover — so no source's habit can be
  learned in place of the evidence.
- **The opponent learns the person.** It counts which source has misled each trainee, or which answer
  they give whatever the sources say, then builds the next disagreement so that habit gets it wrong —
  and says why, in a sentence. Every attack is one that weighing all three sources gets right, so it
  punishes the habit, never good judgement. Records follow the trainee's name between rounds and
  laptops, and only the last two rounds count: a habit someone has trained out of stops being
  attacked and stops being reported.
- **It tells a weakness from an untested trust.** Siding with a source that has never been wrong in
  front of you is not a weakness. The opponent still tests it, but the console and debrief call it a
  test, not a flaw.
- **Proof of improvement.** Every call carries a confidence (two clicks, 50–100). The debrief shows a
  Brier score per round, with the sample size beside it. Run `TRG-4 · SOURCE DRILL` (two minutes) three
  times with the same names.

## What the trainee faces

- They see enemy forces **directly** only inside their own sensor ring. Everything else arrives by
  radio: HQ's ISR picture, the flanking commanders' spot reports, UAV sweeps they request.
- A degraded link makes those reports **late** (the sent time is shown, so a sharp commander notices),
  **missing**, or **corrupted** — text breaks up and reported positions drift, which is what a
  contradictory report actually feels like.
- They can assess each track **CONFIRMED / SUSPECT / DISMISSED**, request a **UAV sweep** to verify,
  call **fire missions** from a shared and limited allocation, and **authenticate** a suspicious HQ
  order over the net — the doctrinally correct answer to a forged one. If they are jammed, the
  challenge may never get a reply, and they must decide anyway.
- Every order carries a **stated reason**, which is what the debrief examines.

## What the instructor controls

- **EW as geography.** Jammers and GPS spoofers are *placed on the map*. Link quality falls off with
  distance, and **high ground masks it** — so "manoeuvre to restore communications" becomes a real
  tactical decision, and the AAR credits a commander who solves it that way.
- **Per-commander switches** for delay, dropout and garbling, plus one-click JAM.
- **Cyber injects**: a forged HQ order, a false kill report for a live enemy, GPS spoofing that
  falsifies one commander's position to the others (this is how fratricide starts).
- **Deception**: phantom contacts, placed by clicking, spoofed to look as though they came from HQ or
  from a flanking commander.
- **Truth beside belief**, side by side, with a line drawn from each believed position to the real one
  and a pulsing ring on every threat the commander cannot see.
- **⚑ Mark moment** to bookmark a teaching point for the replay.

## The AI red cell

An automated adversary for the information domain. It does not fight the units — it attacks what the
commanders know, and it picks its moment:

| Rule | When it fires |
|---|---|
| Jam before contact | A commander's net is clear and an enemy is seconds from contact |
| Deception on the quiet flank | A commander is committed, so a phantom on the far flank invites them off the decisive point |
| Isolate the reserve | Two or more enemy groups are committing at the crossings |
| False kill report | A live threat the commander is tracking is closing but not yet visible |
| Forged HQ order | A commander is cut off and cannot authenticate |
| Spoof a position | Teammates are close enough to plan around a ghost |
| Open a window | After a long blackout, to see whether they exploit restored comms |
| Exploit a learned bias | A commander has a habit on record — a source that misleads them, or an answer they give regardless — so the next disagreement is built to catch it |

**Three modes.** `OFF`, `ASSIST` — it *proposes* a timed action with a written justification and the
instructor approves with one click, and `AUTO` — it acts alone, within a budget, with cooldowns, and
never blacks out the whole team at once. Every action records **why**, and that reasoning survives into
the report. This is the Smart Automation element, and it is deterministic rules — no model, no network.

---

## What the report measures

**Cost of fog (the headline).** Summed across the team: how much later commanders learned about the
threats that actually reached them than they would have on a clear net — plus how many they never saw
at all.

| Measure | Why it matters |
|---|---|
| **Blind casualties** | Losses taken from enemies that were not on the commander's map when contact began, separated from losses taken with eyes open |
| **Reaction penalty** | Mean time from a new report to the next order, clear net versus degraded, per commander |
| **Picture accuracy** | Second-by-second, how close each commander's map was to the truth — missing threats, phantom contacts, mean position error |
| **Deception handling** | Every phantom, forged order and false kill traced from injection to outcome: believed, verified, or refused. A phantom staged as one side of a disagreement is scored once, as a judgement |
| **Mission command** | Whether a cut-off commander kept acting on the commander's intent. `50 ×` time holding the assigned task area `+ 30 ×` share of isolated periods in which they still acted `+ 20 ×` order discipline, less `8` per uncovered breach |
| **Shared picture** | Pairwise disagreement between the three maps over time |
| **Coordination** | Moves to support a flank in contact, fratricide and danger-close incidents, contradictory reports resolved |

Exports to **JSON**, **CSV** and **print/PDF**. Every finished exercise is saved to `aar/`, and the
report can **compare two runs** — the cleanest demonstration is `TRG-1 BASELINE` (clear comms) against
`TRG-2 CONTESTED EW`, which use an **identical enemy package**.

---

## Scenarios

| | |
|---|---|
| **TRG-1 · BASELINE** | Control run. Same enemy, working radios. The measuring stick. |
| **TRG-2 · CONTESTED EW** | Identical enemy, two jammers covering the crossings. High ground masks them. |
| **TRG-3 · DECEPTION & CYBER** | Jamming, GPS spoofing, forged orders and false kill reports, timed by the red cell. |
| **TRG-4 · SOURCE DRILL** | Two minutes, built to be repeated. Sources disagree every 15 s; the red cell learns each trainee and targets their bias; the debrief tracks calibration across rounds. |

Everything in the instructor's settings panel — enemy groups, speed, sensor range, duration, time
scale, ISR period, artillery, jamming severity, red-cell budget — is adjustable and clamped server-side.

---

## Layout

```
server.js              HTTP + SSE, run persistence, CSV/JSON export   (no dependencies)
engine/
  sim.js               ground truth, belief, combat, actions, views
  comms.js             the radio net: delay, dropout, garbling, the awareness ledger
  ew.js                EW field — emitters, falloff, terrain masking
  sources.js           the contradiction engine: sources, the seven kinds of disagreement
  calibration.js       Brier score, trust per source, what counts as a weakness
  profile.js           trainee records by name, kept between rounds
  redcell.js           the AI adversary: rules, cooldowns, written reasoning
  recorder.js          frame recorder for the replay
  aar.js               all metrics and the report
  scenarios.js         force packages, commander's intent, EW layout, presets
public/
  terrain.js           shared geography (loaded by both server and browser)
  map.js               the map renderer, shared by all three map screens
  frame.js             draws one recorded moment, shared by replay and debrief
  radio.js             sound cues for incoming, garbled and failed messages
  trainee.html/.js     commander station
  instructor.html/.js  instructor console
  replay.html/.js      scrubbable replay, truth beside belief
  report.html/.js      after action review
  style.css            design tokens and shared styling
  fonts/               five self-hosted woff2 subsets, ~60 KB in all
tools/shoot.js         screenshot harness, drives Chrome over the DevTools Protocol
test/
  engine.test.js       35 tests
  judgement.test.js    42 tests — disagreement, the learning opponent, calibration
  frontend.test.js     21 tests
aar/                   saved reports and trainee records, written on ENDEX
```

The engine is a plain simulation with no rendering and no I/O, which is why it is testable: `npm test`
asserts that a trainee view never leaks ground truth, that degradation really degrades, that every
inject has a measurable consequence, and that the cost-of-fog arithmetic is zero on a clear net and
positive on a jammed one. The frontend suite runs the real report renderer in a DOM stub and fails
on any `undefined` reaching the page.

---

## Design

The interface uses the materials of staff work rather than the usual dark tactical screen:
**ground truth is a printed topographic sheet, and a commander's belief is chinagraph pencil on
talc laid over it.** Information going stale fades and smudges — the product's thesis, made visible
in the material itself.

Paper `#e8e1d0`, printed ink `#211e18`, contour brown, chinagraph blue `#1b4f9c` for friendly and
red `#b8232b` for hostile, violet `#6b3fa0` reserved for the adversary. Archivo Narrow for map
lettering and headings, Archivo for prose, IBM Plex Mono for grid references and time stamps — all
five self-hosted in `public/fonts/`, since the demo has no internet.

Three colours carry meaning and nothing else does. Hierarchy comes from scale and weight, not
colour. `HANDOFF.md` has the full token set and the rules worth keeping.

These pages hold an SSE connection open, so Chrome's `--screenshot` flag never fires on them.
`tools/shoot.js` drives Chrome over the DevTools Protocol instead — run `npm run shots` with the
server up and it writes all five screens to `/tmp/shots`.

---

## Demo sequence (5 minutes)

**Before the judges arrive (15 minutes).** Press *Clear trainee records* in the instructor's settings to
drop rehearsal data. Each commander types their own name and plays `TRG-4 · SOURCE DRILL` twice. These
records are real play — they are what the opponent has learned and what the improvement chart will
show. Then play one `TRG-2 · CONTESTED EW` round so a cost-of-fog debrief is saved and ready.

| Time | On the projector | What to say |
|---|---|---|
| 0:00 | The instructor console | "Other trainers break your radio. Ours learns exactly how you get fooled, then proves — with a number — that you got better." |
| 0:15 | Start drill round 3. Each commander's desk already shows what the opponent learned: *misled by the drone feed*, *calling it clear whatever the sources say* | "It remembers them by name. This is round three." |
| 0:35 | A disagreement lands on a laptop: the patrol says clear, the drone shows armour, signals says the drone is spoofed. They pick an answer and how sure they are | Point at the red-cell feed: it names the attack it chose and the habit it aimed at, in one sentence. |
| 1:20 | **Jam** one commander, **Phantom contact** on another. Truth beside belief: red lines from where they think the enemy is to where it is, rings on threats not on their map | "The gap between these two maps is what we measure." |
| 2:15 | The round ends on its own. Open **Debrief**: *Who did they believe?* and *Getting better across rounds* | One trainee's score fell round on round and the opponent dropped the habit it had on them; another's did not. Every figure carries its sample size. |
| 3:15 | Pick the saved CONTESTED run in the debrief: cost of fog in minutes, casualties taken blind. Open the replay at the key moment | Read the headline figure aloud: "on a clear net they would have known this N minutes sooner." |
| 4:15 | Back to the console | Repeat the line. Questions. |

Two minutes of drill lands six to eight disagreements on each commander. If a laptop drops
off the network, the round carries on and the seat rejoins where it left off.
