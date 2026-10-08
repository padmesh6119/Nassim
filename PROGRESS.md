# FOGLINE — what we have, and where it stands

*Status as of 8 October 2026. Written for someone opening this folder for the first time.*

---

## 1. In one minute

**FOGLINE** is an immersive multi-domain decision-making trainer for degraded communication environments.

Three junior commanders each sit at a laptop and fight the same battle on a map. Their radios lie to
them: reports arrive late, go missing, get garbled, or are planted by an adversary. An instructor
projects a fourth screen that shows the real battle beside what each commander *believes* is
happening. At the end, the system produces a debrief that measures **how well each person decided**
— not how well they shot.

The pitch, in one line:

> Other trainers break your radio. Ours learns exactly how you get fooled, then proves — with a
> number — that you got better.

It is a **decision-measurement tool, not a war game**. Deliberately out of scope: 3D, VR, more unit
types, more weapons.

---

## 2. The problem statement, and how each required outcome is met

| The problem statement asks for | What we built | Where it lives |
|---|---|---|
| A scenario engine that injects comms degradation (delay, dropout, conflicting reports) mid-exercise | A radio net that delays, drops and garbles each message per commander; jammers placed on the map whose effect falls off with distance and is blocked by hills; a contradiction engine that makes three sources disagree on purpose | `engine/comms.js`, `engine/ew.js`, `engine/sources.js`, `engine/sim.js` |
| Multiplayer, team-level coordination | Three commander stations (ALPHA, BRAVO, CHARLIE) on one shared battle, a team radio net that is itself degraded, spot reports passed between commanders | `public/trainee.*`, `engine/sim.js` |
| An instructor dashboard to configure and monitor in real time | Instructor console: truth map beside any commander's belief map, one-click injects per commander, settings, an AI red cell, live scores | `public/instructor.*`, `engine/redcell.js` |
| Exportable after-action reports with individual and team decision timelines and rationale | A debrief page with timelines, every order and its stated reason, judgement and calibration per person; exports to JSON, CSV (spreadsheet) and print/PDF; every exercise saved to disk | `engine/aar.js`, `public/report.*`, `server.js` |

All four are built and covered by tests.

---

## 3. Status at a glance

| Area | State |
|---|---|
| Core simulation (truth, belief, combat, orders) | Done, tested |
| Comms degradation and electronic warfare | Done, tested |
| Instructor console | Done, checked by screenshot at 1920×1080 and 1366×768 |
| Commander station | Done, checked by screenshot |
| Debrief, exports, saved runs, run comparison | Done, tested |
| Replay (scrub back through any saved exercise) | Done, checked by screenshot |
| AI red cell (rules-based adversary that explains itself) | Done, tested |
| **Differentiator 1:** sources that disagree on purpose | Done, tested, played over the network |
| **Differentiator 2:** an opponent that learns each trainee's bias | Done, tested, played over three rounds |
| **Differentiator 3:** confidence scoring and improvement across rounds | Done, tested, played over three rounds |
| Visual design | Done — custom design system, self-hosted fonts, works offline |
| **Run on the real setup (3 laptops + projector over local WiFi)** | **Not done** |
| **Played by real people** | **Not done** — only by scripted bot players |
| **5-minute demo rehearsed** | **Not done** — a timed script exists in `README.md` |
| Version control | **Not set up** — the folder is not a git repository |
| Pitch deck / slides | Not started |

**Rough estimate:** the software is about **85%** of the way there. Demo readiness is closer to
**70%** — the remaining gap is field testing that has to happen on real hardware with real people.

---

## 4. How to run it

You need **Node.js 18 or newer**. Nothing else: no `npm install`, no build step, no internet.

```bash
npm start             # starts the server on port 3000 and prints a URL per station
npm test              # runs all three test suites (98 tests)
npm run test:fuzz     # the same, with random seeds, to shake out rare cases
npm run shots         # with the server running: screenshots of all five screens into /tmp/shots
```

`PORT=3123 npm start` runs it on another port.

### The stations

| Who | Opens |
|---|---|
| Instructor — project this one | `http://<server-ip>:3000/instructor` |
| Commander ALPHA | `http://<server-ip>:3000/trainee?pid=ALPHA` |
| Commander BRAVO | `http://<server-ip>:3000/trainee?pid=BRAVO` |
| Commander CHARLIE | `http://<server-ip>:3000/trainee?pid=CHARLIE` |
| Replay | `/replay` |
| Debrief | `/report` |
| Landing page with links to all of the above | `/` |

**The demo setup:** one laptop runs `npm start`. The server listens on every network interface and
prints its own WiFi address, so the other laptops just type that address into a browser. Nothing
leaves the room — which suits a closed defence network.

Each commander types their name once in the lobby. The name is remembered in that browser, and their
record (what the opponent has learned about them, their scores per round) follows the **name**, not
the laptop.

---

## 5. How it works — the big picture

```
   Commander laptops (3)                Instructor laptop / projector
   /trainee?pid=ALPHA ...               /instructor, /replay, /report
          │   ▲                                   │   ▲
   POST   │   │  live updates 5×/s         POST   │   │  live updates 5×/s
  orders  │   │  (Server-Sent Events)     injects │   │
          ▼   │                                   ▼   │
   ┌──────────────────────────── server.js ────────────────────────────┐
   │  HTTP + Server-Sent Events, no dependencies. Ticks the game 5×/s. │
   │  Saves every finished exercise to aar/.                           │
   └───────────────────────────────┬───────────────────────────────────┘
                                   │
   ┌──────────────────────────── engine/ ──────────────────────────────┐
   │  sim.js        the game: ground truth, each commander's belief,   │
   │                orders, combat, the views each screen receives     │
   │  comms.js      the radio net (delay, loss, garble) + the ledger   │
   │  ew.js         jammers and spoofers as geography                  │
   │  sources.js    the contradiction engine                           │
   │  calibration.js / profile.js   scoring and memory of each trainee │
   │  redcell.js    the AI adversary                                   │
   │  aar.js        every metric in the debrief                        │
   └───────────────────────────────────────────────────────────────────┘
```

### The one idea everything rests on

Three things are tracked side by side and are **never allowed to be the same object**:

1. **Ground truth** — where everything actually is. Only the instructor sees it.
2. **Belief** — what each commander's screen shows, built *only* from reports that actually reached
   them, each stamped with its age and its source.
3. **The ledger** — for every threat and every commander, the moment they *could* have known about it
   on a clear radio, against the moment they *actually* did.

Commanders act on (2). The debrief measures the gap between (2) and (3). That gap, summed across the
team, is the headline number: **the cost of fog**, in minutes.

A test checks that a commander's screen never receives ground truth.

---

## 6. The directory map

```
fogline/
├── server.js            the server
├── package.json         scripts only — there are no dependencies
├── README.md            the product description and the 5-minute demo script
├── HANDOFF.md           a deeper technical brief for whoever works on it next
├── PROGRESS.md          this file
├── engine/              the simulation — no screens, no network, fully testable
├── public/              everything the browsers load
├── test/                three test suites
├── tools/               the screenshot tool
└── aar/                 created on first run: saved exercises and trainee records
```

### `server.js`

The only file that touches the network. It serves the pages, streams live state to each browser five
times a second, accepts orders and instructor actions, and writes each finished exercise to `aar/`.

| Route | What it does |
|---|---|
| `/events?role=trainee&pid=ALPHA` / `?role=instructor` | Live stream of game state (Server-Sent Events) |
| `POST /api/action` | A commander's order (move, fire, UAV sweep, hold, authenticate, mark a contact, answer a disagreement, team chat) |
| `POST /api/admin` | An instructor action (start, pause, end, reset, change scenario or settings, inject jamming / phantoms / forged orders / false kills / GPS spoofing / disagreements, red-cell control, clear trainee records) |
| `/api/aar`, `/api/aar.json`, `/api/aar.csv` | The current debrief, as data, download, or spreadsheet |
| `/api/replay` | Recorded frames for the replay |
| `/api/runs`, `/api/run/<id>` | List and load saved exercises |
| `/api/compare?a=…&b=…` | Two exercises side by side |
| `/api/scenarios`, `/api/profiles`, `/api/clients` | Scenario list, trainee records, who is connected |

### `engine/` — the simulation

| File | Size | What it is |
|---|---|---|
| `sim.js` | 1,430 lines | **The game.** Units, enemy movement, combat, every order and inject, the three-layer model above, and the exact view each screen is allowed to see. Start here. |
| `comms.js` | 160 | The radio net. Each message is delayed, dropped or garbled according to that commander's link quality. Also keeps the awareness ledger. |
| `ew.js` | 60 | Electronic warfare as geography: jammers and GPS spoofers placed on the map, strength falling off with distance, hills masking them. |
| `sources.js` | 180 | **The contradiction engine.** The report sources (own eyes, ground patrol, drone, signals intercept, HQ), the seven kinds of disagreement, and where on the map to stage one. |
| `calibration.js` | 130 | The arithmetic of judgement: Brier score, over/under-confidence, and the rules for what counts as a weakness. Pure functions. |
| `profile.js` | 100 | Trainee records that persist between rounds, keyed by name, saved to `aar/profiles.json`. |
| `redcell.js` | 305 | The AI adversary. Rules that watch the battle for an opening, act (or propose), and write down why. |
| `aar.js` | 455 | Every metric in the debrief, computed from what was recorded. |
| `recorder.js` | 65 | Snapshots of the battle for the replay, plus bookmarks at key moments. |
| `scenarios.js` | 130 | The four training scenarios, the enemy force, the commander's intent, jammer positions, default settings and their safe limits. |

### `public/` — what the browsers load

| File | What it is |
|---|---|
| `index.html` | Landing page: links to every station and a summary of what is measured |
| `trainee.html` / `trainee.js` | **The commander station.** Their map (only what they know), contacts list, incoming radio log, disagreement cards with the confidence picker, orders with stated reasons, team chat |
| `instructor.html` / `instructor.js` | **The instructor console.** Truth map beside a chosen commander's belief, one desk per commander with live scores and injects, the red-cell panel, the event feed, settings |
| `report.html` / `report.js` | **The debrief.** Charts, timelines, judgement per person, improvement across rounds, the key moment drawn on the map, exports |
| `replay.html` / `replay.js` | Scrub back through any saved exercise, truth beside belief; opens at the key moment |
| `map.js` | The map renderer, shared by every screen that draws a map |
| `frame.js` | Draws one recorded moment, shared by the replay and the debrief so both look identical |
| `terrain.js` | The shared geography (river, bridges, hills, woods, roads, the grid). Loaded by both the server and the browser |
| `radio.js` | Small sound cues for incoming, garbled and failed messages, with a mute button |
| `style.css` | Colours, type and shared components |
| `fonts/` | Five self-hosted font files (about 60 KB), because the demo has no internet |

### `test/`

| Suite | Tests | Guards |
|---|---|---|
| `engine.test.js` | 35 | The simulation: no truth leaks to commanders, degradation really degrades, every inject has a measurable effect, cost of fog is zero on a clear net and positive on a jammed one, bad input is rejected |
| `judgement.test.js` | 42 | The three differentiators: every disagreement has exactly the liars it claims, every attack on a habit is one that careful reasoning passes, no source always says the same thing, records follow the name, a habit trained out of stops being held against you, scores improve when play improves |
| `frontend.test.js` | 21 | Runs the real debrief renderer and fails on any `undefined`/`NaN` on the page, broken tooltips, or a trainee's typed text being treated as markup; checks every field each screen reads actually exists |

### `tools/shoot.js`

Screenshots any page through Chrome. A normal headless screenshot hangs on these pages because they
keep a live connection open; this drives Chrome directly instead. It can also click something before
the capture (to open a menu or picker). `npm run shots` uses it.

### `aar/` (created when the server runs)

Every finished exercise as a JSON file, an `index.json` list of them, and `profiles.json` with each
trainee's record. Delete the folder to start clean; the instructor's settings also has a *Clear
trainee records* button. It does not exist yet: the test records made by bot players were deleted,
so the first real run starts clean.

---

## 7. The five screens

**Commander station** (`/trainee?pid=…`). A topographic map sheet. The commander sees enemies
directly only inside their own sensor ring; everything else is a report, with its source and age.
Beyond the ring the map is shaded. When sources disagree, a card appears with the three reports, two
buttons (*The enemy is there* / *The area is clear*) and a confidence picker (50–100%, keys 5–0). The
disputed grid is marked on the map. Orders: move (M), fire mission (F), UAV sweep (U), hold (H),
authenticate an order (A), each with an optional reason that goes into the debrief.

**Instructor console** (`/instructor`). Truth on the left, a chosen commander's belief on the right,
with red lines from where they think an enemy is to where it really is, and rings on threats they
cannot see. Below, one desk per commander: live scores, what the opponent has learned about them, and
buttons to jam, inject a phantom, start a disagreement, forge an order, spoof GPS. The red-cell panel
shows what the AI adversary did and why. The top bar shows the live cost of fog and how many
disagreements the team has called right.

**Debrief** (`/report`). Leads with the headline: cost of fog for a full exercise, or "calls right"
for the source drill. Then: who each person believed and whether their confidence was earned;
improvement across rounds; the moment it went wrong, drawn on the map; reaction times; a decision
timeline; how far the three pictures drifted apart; mission command; the red cell's reasoning; full
logs; a comparison between two exercises. Exports: JSON, spreadsheet, print.

**Replay** (`/replay`). A timeline you can scrub, truth beside belief, opening at the key moment.

**Landing page** (`/`). Links and a one-page explanation.

### Design

The look is taken from the materials of staff work rather than a dark "tactical" screen: **ground
truth is a printed topographic sheet, and a commander's belief is chinagraph pencil on clear
plastic laid over it.** Buff paper, printed ink, blue for friendly, red for hostile, ochre for
caution, violet for the adversary's hand. Fonts are Archivo Narrow, Archivo and IBM Plex Mono, stored
locally.

---

## 8. The scenarios

| Scenario | Length | What it tests |
|---|---|---|
| **TRG-1 · BASELINE** | 5 min | Control run: working radios. The measuring stick |
| **TRG-2 · CONTESTED EW** | 5 min | Identical enemy, two jammers covering the bridges. Hills mask them |
| **TRG-3 · DECEPTION & CYBER** | 5 min | Jamming, GPS spoofing, forged orders, false kill reports and source disagreements, timed by the red cell |
| **TRG-4 · SOURCE DRILL** | 2 min | Built to be repeated. Sources disagree every 15 seconds, the opponent targets each trainee's habit, and the commander is told the truth after each call |

Every setting (enemy strength and speed, sensor range, duration, time scale, jamming severity,
red-cell budget, disagreement frequency…) can be changed from the instructor's settings panel and is
checked for safe limits on the server.

---

## 9. The three differentiators in detail

### 9.1 Sources that disagree on purpose

A ground patrol, the drone feed and a signals intercept report on the same grid square and
contradict each other. The commander decides who to believe. Each disagreement fixes the truth first,
then decides who lies:

| Kind | The truth | Who is wrong |
|---|---|---|
| Drone feed spoofed | Nothing there | Drone shows armour |
| Enemy under cover, missed by the drone | Enemy there | Drone sees nothing |
| Patrol report out of date | Enemy there | Patrol says clear |
| Patrol mistook what it saw | Nothing there | Patrol reports vehicles |
| Intercept planted to discredit the drone | Enemy there | Signals says the drone is compromised |
| Dummy radio net, nobody there | Nothing there | Signals reports armoured traffic |
| Two sources wrong, one right | Nothing there | Patrol and drone both |

Every source can be wrong **in both directions**, so no source's habit can be memorised in place of
weighing the evidence. In the first six, two of the three sources tell the truth: someone who weighs
all three gets it right. The last one beats careful people too and is used only to force a decision
on someone who keeps hesitating.

### 9.2 An opponent that learns the person

Every call updates, per source, how often the commander sided with it, was misled by it, and caught
it lying. The opponent reads only the **last two rounds** (counting the one being played), so a habit
someone has trained out of stops being attacked. It recognises:

| Habit | When it is called a weakness | What the opponent does next |
|---|---|---|
| Misled by one source | Misled by it at least twice, and at least as often as they caught it lying | Makes that source the liar, in both directions in turn |
| "Calls it clear whatever the sources say" | 5+ answers, 85% the same, at least twice against most of the sources, and wrong at least twice | Stages cases where the enemy is there and most sources say so |
| "Calls it enemy whatever the sources say" | The mirror image | Stages cases where nothing is there |
| Hesitation | Left 40% or more of 3+ disagreements unanswered | The two-liars case, to force a decision |
| *Untested trust* (not a weakness) | Sided with a source 80%+ of the time, but it has never been wrong in front of them | Tests it once — and the screens call it a test, not a flaw |

**Every attack is one that careful reasoning passes**, so it punishes the habit, never good judgement.
The red cell writes down why it chose each attack, in a sentence, and that reasoning appears on the
console and in the debrief. It is deliberate counting and rules, not machine learning — an instructor
can see exactly why it did what it did.

### 9.3 Proof of improvement

Every call carries a confidence (50–100%). Each round gets a **Brier score**: the average squared gap
between how sure someone said they were and whether they were right. Lower is better; always saying
50% scores 0.25. The debrief draws one small chart per person across rounds of the same scenario,
shows the sample size beside every figure, labels anything under five judgements as "too few to
call", and says when a round was harder because the opponent was attacking a known habit.

---

## 10. What the debrief measures

| Measure | Meaning |
|---|---|
| **Cost of fog** | Minutes later than on a clear radio that commanders learned about threats that reached them, plus threats they never saw |
| **Casualties taken blind** | Losses to enemies that were not on the commander's map when contact began |
| **Calls right** | Disagreements judged correctly, and calibration of the confidence given |
| **Who they believed** | Per source: sided with, misled by, saved by doubting |
| **Reaction time** | From a new report to the next order, clear radio against degraded |
| **Picture accuracy** | Second by second, how close each commander's map was to the truth |
| **Deception handling** | Every phantom, forged order and false kill traced to its outcome |
| **Mission command** | When cut off, did they keep acting on the commander's intent or wait for orders? |
| **Shared picture** | How far the three commanders' maps disagreed over time |

---

## 11. The AI red cell

A rules-based adversary that attacks what the commanders *know*, not the units. It watches for
openings — jam a commander seconds before contact; plant a phantom on the quiet flank; isolate the
reserve; send a false kill report for a live enemy; forge an HQ order to a cut-off commander; spoof a
position so teammates plan around a ghost; aim a disagreement at a learned habit; briefly restore a
link to see if it is used. Three modes: **Off**, **Propose** (the instructor approves each action
with one click) and **Automatic** (acts alone within a budget and cooldowns). Every action records
its reason.

---

## 12. What has been verified, and how

- **98 automated tests** across three suites, all passing, plus a randomised (fuzz) pass.
- **Every screen checked by screenshot**, including the console at projector resolutions
  (1920×1080 and 1366×768).
- **Three full two-minute drill rounds played over the network by bot players** with known habits.
  The opponent's conclusions matched the habits:

| Bot trainee (habit) | Brier score round 1 → 2 → 3 | What the opponent concluded |
|---|---|---|
| Lt Singh (weighs all three sources) | 0.09 → 0.04 → 0.04 | No weakness |
| Capt Rao (trusts the drone in round 1, weighs all three after) | 0.47 → 0.06 → 0.06 | Targeted his drone habit 5 times in round 2; he passed all 5. By round 3, no weakness |
| Maj Iyer (always says "clear") | 0.34 → 0.64 → 0.64 | "Calls it clear whatever the sources say"; every round-3 disagreement aimed at it |

### Problems found and fixed in the latest pass

- The drone only ever reported "enemy", so trusting the drone looked the same as always saying
  "enemy". Every source now lies in both directions.
- A habit trained out of in round 2 was still reported in round 3. The memory window now counts the
  current round as one of the two.
- Trusting a source that had never been wrong was reported as a weakness. Now it is an "untested
  trust".
- The debrief's decision timeline broke whenever an order was aimed at a fake enemy, and a trainee's
  typed reason could inject markup into the debrief. Fixed, with tests that fail if the fix is
  removed.
- Drill disagreements were counted twice (also as "deceptions"); the improvement chart mixed scenarios
  and showed "Worse" without context.
- On screen: a drawing glitch left a diagonal stripe across the commander map; map labels printed on
  top of each other; warnings pointed at enemies already destroyed; red-cell messages were long and
  shouted; each decision appeared twice in the feed.

---

## 13. Known limits and risks

- **Never run on the real setup.** Three laptops and a projector over local WiFi is untested: laptop
  firewalls, the router, and browsers other than Chrome.
- **Never played by people.** Bots answered in 2–4 seconds. Real people may need more than the
  drill's 15-second rhythm (each disagreement stays open 30 seconds). Both are one setting each.
- **Small samples.** A two-minute round gives 6–7 judgements per person. Three rounds show a
  direction, not a statistically proven skill gain — and the debrief says so.
- **Projector legibility** of the smaller console text is unconfirmed.
- **No version control.** A bad edit cannot be undone.

---

## 14. What is left, most important first

1. **One session on the real hardware** — three laptops, the projector, the WiFi you will have on
   the day. About 30 minutes. Only the team can do this.
2. **Let real people play the drill**, then adjust the disagreement rhythm if it is too fast.
3. **Rehearse the 5-minute demo twice, timed** (script in `README.md`, "Demo sequence"). It needs two
   drill rounds played under the presenters' real names before the judges arrive, and one saved
   contested-radio exercise for the cost-of-fog section.
4. **Put the folder under git** and commit, before several people start editing.
5. **Check the console on the actual projector** from the back of the room.
6. **Slides**, if the round needs them.

Adding more features now is not on the list: it adds risk without moving the score.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **AAR** | After-action review — the debrief |
| **Belief** | What one commander's screen shows, built only from reports they received |
| **Brier score** | Average of (stated confidence − outcome)², where outcome is 1 if right and 0 if wrong. 0 is perfect; 0.25 is always saying 50% |
| **Calibration** | Whether someone who says "80% sure" is right about 80% of the time |
| **Cost of fog** | The headline number: how much later commanders knew than they could have on a clear radio |
| **Disagreement / dispute** | One staged contradiction between the patrol, drone and signals reports |
| **ENDEX** | End of exercise |
| **EW** | Electronic warfare — here, jamming and GPS spoofing |
| **ISR** | Intelligence, surveillance and reconnaissance — the periodic picture from HQ |
| **Phantom** | A fake enemy contact injected to deceive |
| **Probe / untested trust** | A source someone always believes but has never seen wrong — tested, not counted as a weakness |
| **Red cell** | The adversary role, here played by rules-based automation |
| **SIGINT** | Signals intelligence — the intercept source |
| **SSE** | Server-Sent Events: how the server pushes live updates to every browser |
| **Truth** | Where everything actually is; only the instructor sees it |

---

## 16. Other documents in this folder

- **`README.md`** — the product description for judges and teammates, and the **timed 5-minute demo
  script**.
- **`HANDOFF.md`** — a deeper technical brief: design decisions, metric definitions, the agreed
  positioning, honest limits. Read it before changing the engine.
