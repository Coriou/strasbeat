# 28 — Quality-upgrade session: audit record, baseline and triage

Status: **Session complete on branch `upgrade` (not merged): all four
batches landed — 27 commits of bug fixes, then 15 for performance, Strudel
support, and UX and accessibility.** Audit baseline is commit `03ba08c`
(`pnpm test` 692/692 green, `pnpm build` clean); the suite is now 1,260
tests.

| | Fixed | Partly fixed | Deferred | Open | Total |
|---|---:|---:|---:|---:|---:|
| Audit and measurement findings (§4.1–§4.9, aliases not counted) | 139 | 19 | 12 | 2 | 172 |
| Bundle and boot items (§4.10) | 7 | 0 | 3 | 0 | 10 |
| **All** | **146** | **19** | **15** | **2** | **182** |

Every finding carries a `Status:` line: `fixed (<commit>)`,
`partly fixed (<commit>) — <what remains>`, `deferred — <reason>` or
`open`. The two still open are listed at the end of §4. What a "partly
fixed" leaves behind is in its status line and, where it needs a decision
or a design, in §6 and §7.

How far this is verified: every commit passed `pnpm test` and `pnpm build`
on a GitHub runner and was reviewed from the code before it was committed;
the final tree passed a 49-check headless-Chromium smoke run on a runner
(§3.10). No person has yet walked through the app in a real browser, and
playing-frame cost, leak slopes and typing under CPU throttle were not
re-measured — see §8.

## 1. Purpose

This is the single record for a quality pass over the whole app, run in this
order: **bugs → performance and memory → UX and accessibility →
Strudel-support gaps.** No new features; the goal is that what exists is
correct, fast and usable.

The bar:

- 60 fps while playing, with the roll, scope, beat grid or visuals showing.
- Zero known bugs — every finding here is fixed or explicitly deferred.
- Low idle CPU: no animation loops or timers doing work while stopped.
- Fast load: the editor is interactive quickly, even on a slow CPU.
- Accessible: keyboard-operable, announced, readable contrast.
- Excellent Strudel support: a snippet pasted from strudel.cc behaves the
  same here, or fails with an actionable message.

How to read this document:

- §2 says how the findings were produced and what could not be checked.
- §3 is the measured baseline. Each table has an **After** column; the
  note at the top of §3 says which are filled and why the rest are `—`.
  §3.10 is the runner comparison of the baseline and the final tree.
- §4 lists every finding, one section per area. Entry format:
  `ID · severity · file:line — failure scenario, root cause, fix.`
  followed by a `Status:` line. Line numbers are as of `03ba08c`.
- §5 is the execution plan (four batches). §6 lists deferrals, §7 the
  decisions that need the maintainer, §8 what a person still has to
  verify, §9 the commit log.

Severity: **P0** data loss, crash, security, or a broken core flow ·
**P1** real user-visible bug or significant perf/leak/a11y failure ·
**P2** minor bug or moderate inefficiency · **P3** nit or polish.

Confidence wording used in entries: *reproduced* = the failure was run (in
node against the real modules, or in headless Chromium); unmarked = it
follows directly from the cited code; *plausible* = the code path is
verified but the user-visible effect depends on timing or engine behaviour
that was not observed.

The audit used eight ID prefixes. Where two audits found the same defect it
is listed once under one ID and the other ID is kept as an alias (a pointer
line in its own section), so every ID that appears in commit messages or
notes can be found here.

| Prefix | Area | Raw | After merge |
|---|---|---:|---:|
| ED | Editor and CodeMirror extensions | 21 | 18 |
| TR | Orchestration, transport, evaluate/stop, boot, `strudel-ext` | 22 | 18 |
| PN | Right-rail panels, modals, palette | 26 | 26 |
| RD | Canvases, animation loops, Hydra/shader | 25 | 25 |
| PS | Persistence, autosave, tabs, folders, library I/O, share links | 17 | 16 |
| MX | MIDI in/out, capture, MIDI import, WAV export, OSC | 22 | 20 |
| SC | Strudel coverage | 20 | 18 |
| UX | UX and accessibility | 31 | 28 |
| | **Total** | **184** | **169** |

Distinct findings by severity after merging (a merged finding takes the
higher of its two severities): **P0 5 · P1 38 · P2 89 · P3 37.**

§4.9 adds three measurement-only findings (PF-*) and §4.10 ten bundle/boot
opportunities (BD-*); those are not counted in the table above.

## 2. Method

Two independent passes over commit `03ba08c`:

1. **Code-reading audits by area** (the eight prefixes above). Each read
   its modules end to end plus the installed upstream sources it depends
   on (`@strudel/core` 1.2.6, `@strudel/codemirror`/`webaudio`/`midi` 1.3.0,
   `@strudel/osc` 1.3.2, `superdough` 1.3.0). Where a defect could be
   exercised without a browser it was reproduced with a one-off node script
   against the real modules (real `repl()`, real `installEvalFeedback()`,
   real `arrange()`/`progression()`, real CodeMirror states). Nothing in
   the repo was modified by the audits.
2. **Measurements in headless Chromium** (Playwright; Chromium 141 headless
   shell, SwiftShader software GL, 1440×900 @1x) against `pnpm preview` of a
   production build: build/chunk sizes, cold load (and with 4× CPU
   throttle), idle, typing latency, playing in each bottom-panel mode,
   leak slopes over repeated cycles, and a Hydra/shader correctness and
   teardown pass using pixel diffs and a WebGL-context census. The UX audit
   also ran in headless Chromium (dev server) with axe-core 4.x, a full Tab
   pass, and viewports from 390×844 to 1440×900.

Not measurable or not covered:

- **Audio by ear** and real output latency. Headless Chromium has a null
  audio sink; we only assert `AudioContext.state` and that the scheduler
  runs.
- **Real-GPU frame cost.** Canvas 2D and WebGL are software-rasterised, so
  absolute fps while playing (≈30) and with visuals (3–12) is pessimistic.
  Use fps only for before/after comparison; **script ms/s per call site is
  the comparable absolute number.**
- **MIDI hardware.** The MIDI bar was exercised with a stubbed
  `requestMIDIAccess`; capture was not exercised.
- Compositor/vsync input latency (typing numbers are main-thread only).
- Safari, Firefox, touch devices, screen readers, a light theme (none
  exists), real browser zoom (approximated by a 720×450 viewport).
- Not exercised in the UX pass: MIDI import dialog, arrange bar,
  drag-and-drop reorder, numeric scrubber, vim/emacs/helix profiles.

In-app verification by a person is still required for anything marked
*plausible*, for all audio-quality claims, and for the visuals stacking
fixes.

> **Change of method from commit `15c8bf9` onwards.** The baseline in §3
> was measured locally, in headless Chromium on the development machine.
> That machine then became overloaded, so local headless-browser and
> performance runs were stopped. From the CI commit on, verification of
> each change is `pnpm test` + `pnpm build` on GitHub-hosted runners
> (through temporary `ci/**` branches) plus code review. Consequently the
> **After** numbers that need a browser — typing latency, playing frame
> times, leak slopes, visuals teardown — are **not re-measured in this
> session** and stay `—`. A later performance lane builds the measurement
> rig on runners. The few numbers that were measured while fixing, before
> the stop, are in §3.9.
>
> **Added at the end of the session:** one headless-Chromium smoke run of
> the production build on a GitHub runner, executed against both the
> baseline commit and the final tree with the same script. It checks
> behaviour (49 assertions) and records a handful of load numbers; those
> are in §3.10. It is not a re-run of the §3 scenarios.

## 3. Baseline metrics

Measured 2026-11-16 on `03ba08c`. Medians of three runs unless noted.

> **Read the After columns with this in mind.** Every number in §3.1–§3.8
> is a local headless-Chromium measurement of the baseline. Local browser
> and performance runs stopped at commit `15c8bf9` (see §2), so the After
> columns for anything that needs a browser are intentionally still `—`
> at the end of the session; they are not "unchanged". What is filled in:
>
> - §3.1 — the entry chunk and the new lazy chunks, from a local
>   `pnpm build` (no browser needed).
> - §3.3, §3.7, §3.8 — the rows the runner smoke run observed directly.
>   These are pass/fail observations, marked "runner".
> - §3.9 — what was measured while the Batch 1 fixes were written.
> - §3.10 — the like-for-like runner comparison (baseline commit vs final
>   tree, same script, same runner image).
>
> Still `—` and why: §3.2 load timings and long tasks, §3.4 typing and
> format, §3.5 playing frame cost, §3.6 leak slopes, and the rest of §3.1
> (total / lazy JS, CSS, sourcemap attribution). They need the local
> harness that produced the baseline (same machine, CPU throttle, forced
> GC, sourcemap attribution), which was not run again. The runner numbers
> in §3.10 are from different hardware and must not be read against the
> baseline columns here.

### 3.1 Build

After values are bytes ÷ 1000 from the local `pnpm build` output. Measured
the same way, the tree just before the bundle work (after Batch 1) had an
entry chunk of 2,893.7 kB raw / 769.2 kB gzip — slightly above the audit
baseline in this table, which was taken at `03ba08c` with a different
tool.

| Metric | Baseline | After |
|---|---:|---|
| Total JS, raw / gzip | 8354.6 kB / 3048.2 kB | — |
| Initial (entry graph) JS, raw / gzip / brotli | 2800.4 / 745.1 / 645.4 kB | 1871.8 / 573.0 kB / — |
| Lazy JS, raw | 5554.2 kB | — |
| CSS, raw / gzip | 170.7 / 22.7 kB | — |
| Fonts | 6 files, 112.7 kB | — (the two latin files are now preloaded, BD-10) |
| `modulepreload` links | none | — |

| Chunk | Raw kB | Gzip kB | Loaded | Contents | After |
|---|---:|---:|---|---|---|
| `index` (entry) | 2800.4 | 745.1 | initial, the only script | everything not listed below | 1871.8 raw / 573.0 gzip |
| `strudel-docs` | – | – | — | was in the entry | new: 207.9 raw / 44.6 gzip, fetched right after the editor mounts |
| `vim` | – | – | — | was in the entry | new: 121.0 raw / 38.5 gzip, fetched when the Vim profile is used |
| `emacs` | – | – | — | was in the entry | new: 11.0 raw / 4.6 gzip, fetched when the Emacs profile is used |
| panels: `learn`, `reference`, `settings`, `sounds`, `export` | – | – | — | were in the entry | new: 27.4, 17.3, 18.9, ≈13.0, 11.1 raw; each fetched on first open, warmed at idle |
| `index.css` | 170.7 | 22.7 | initial, render-blocking | all stylesheets + 6 `@font-face` | — |
| `csound` | 3542.5 | 1748 | lazy (opt-in) | `@csound/browser`, inlined wasm | — |
| `index` (xen) | 1139.4 | 304.3 | lazy (opt-in) | `@strudel/xen` scale tables | — |
| `babel` + `estree` + `standalone` | 309.3 + 199.7 + 85.2 | 81.6 + 57.5 + 28.8 | lazy (first format) | prettier | — |
| `hydra-synth` | 182.2 | 59.3 | lazy (first `initHydra()`) | regl 117, hydra-synth 43, meyda 16 | — |
| `index` (midi) | 88.8 | 20 | lazy (opt-in) | webmidi 79 + `@strudel/midi` | — |
| csound / osc / serial wrappers | 4.4 / 1.3 / 1.3 | – | lazy (opt-in) | thin wrappers | — |

Entry chunk by group (sourcemap attribution, 2800 kB raw):

| Group | Raw kB | % | Notes | After |
|---|---:|---:|---|---|
| `@strudel/codemirror` prebuilt dist | 614 | 22 | ≈539 kB is upstream `doc.json` inlined as a `JSON.parse` literal | built from source; `doc.json` is an empty stub (BD-1); size not re-attributed |
| CodeMirror + Lezer | 538 | 19 | view 212, lezer-javascript 77, state 52, autocomplete 41 | — |
| strasbeat app code | 488 | 17 | `src/ui/` 244, `src/*.js` 120, `src/editor/` 72, `strudel-ext/` 22, patterns 31 | — |
| Audio engine | 290 | 10 | superdough 115, @kabelsalat/web 67, soundfont2 37, @strudel/soundfonts 33 | — |
| Strudel language | 240 | 9 | core 93, mini 40, tonal 22, draw 15, @tonaljs ≈55 | — |
| Transpiler | 236 | 8 | acorn 123, escodegen 34, source-map 30, esutils 30 | — |
| JSON data | 192 | 7 | `strudel-docs.json` ≈175 (205 raw on disk / 38.5 gz), learn index ≈17 | docs index is its own chunk (BD-2); the learn index left with the Learn panel (BD-3) |
| vim / emacs / vscode keymaps | 143 | 5 | statically imported by upstream `keybindings.mjs` | vim and emacs are lazy chunks (BD-5); the vscode keymap stays in the entry |
| `@tonejs/midi` + `midi-file` | 35 | 1 | only needed for MIDI import | dependency removed in Batch 1 (`deaad2d`) |
| lucide (tree-shaken), misc | ≈25 | 1 | | — |

Two documentation corpora ship side by side (upstream `doc.json` and
`strudel-docs.json`): ≈715 kB raw / ≈110 kB gz, a quarter of the entry
chunk and its largest single parse cost, on the critical path before the
editor mounts.

### 3.2 Load (cold cache)

| Metric | Cold | Cold + 4× CPU | After |
|---|---:|---:|---|
| FCP ms | 296 | 2208 | — |
| LCP ms (element: first `.cm-line`) | 1932 | 2208 | — |
| DOMContentLoaded ms | 1846 | 9890 | — |
| load ms | 1932 | 12100 | — |
| Editor interactive ms | 1685 | 9588 | — |
| Boot (prebake) complete ms | 3115 | 17698 | — |
| Requests / kB transferred before interactive | 5 / 834 | 5 / 834 | — |
| Requests / kB transferred before boot | 8 / 966.7 | 8 / 966.7 | — |
| Long tasks → interactive: count / total / max ms | 2 / 1607 / 1331 | 3 / 9167 / 8505 | — |
| Long tasks → boot: count / total / max ms | 5 / 2508 / 1331 | 11 / 17418 / 8505 | — |
| Main-thread script ms to boot | 793 | 4785 | — |
| Main-thread task ms to boot | 3410 | 21088 | — |

Per-run boot-ready: cold 6778 / 3115 / 2855 ms; 4× 17698 / 19467 / 14612 ms.
The spread is network: boot awaits three sample manifests
(`raw.githubusercontent.com` dirt-samples and uzu-drumkit, and
`/strudel-cc/tidal-drum-machines.json`), each taking 0.3–3.7 s, and the
first Play awaits boot. Between FCP and the editor there is one 1.33 s long
task (8.5 s at 4×): compile + evaluate of the 2.8 MB module and synchronous
construction of the whole UI.

### 3.3 Idle (10 s after boot, stopped)

| Metric | Baseline | After |
|---|---:|---|
| Heap after GC | 11.14 MB | — |
| DOM nodes / listeners | 1813 / 474 | — |
| rAF callbacks | 0 /s | 0 /s at idle and after stop (runner) |
| Timers fired | 4.4 /s (`transport.js:146` 4/s; `boot.js:73` 0.4/s) | — (not re-measured; by code the transport poll is now 1 /s and stops while the tab is hidden) |
| Main-thread task time | 27 ms / 10 s (script 2 ms) | — |
| Long tasks | 0 | — |

Idle is clean for a plain pattern. It is **not** clean when the buffer
contains `arrange()` (RD-8) or a shader/Hydra pattern is the last-open tab
(RD-2); those cases were found by reading, not by this measurement.

### 3.4 Typing and format

300 characters at ~15 cps into a 184-line document.

| Metric | p50 | p95 | max | After |
|---|---:|---:|---:|---|
| keydown → next frame start (ms) | 7.4 | 18.7 | 119 | — |
| keydown → frame done (ms) | 16.2 | 44.8 | 324.1 | — |

| Metric | Baseline | After |
|---|---:|---|
| Keystrokes > 16.7 ms / > 50 ms (of 300) | 137 / 10 | — |
| Long tasks while typing | 5 (max 318 ms) | — |
| Main thread over 22.6 s: task / script | 6875 / 2519 ms | — |
| Layout / style recalcs | 527 ms ×1065 / 315 ms ×1170 | — |
| Format (185 lines) cold / warm median | 258.1 / 62.3 ms | — |

Worst keys: `a` 324.1 ms, `Enter` 146.4 ms, `.` 132.7 ms, `(` 102.6 ms,
`d` 91.7 ms. See ED-12 and RD-12 for the per-keystroke work behind this.

### 3.5 Playing (pattern `captainmo`)

fps is software-raster-pessimistic; **script ms/s is the comparable
number.**

| Mode | avg fps | p95 frame ms | % >20 ms | long tasks | task ms/s | script ms/s | `@strudel/draw` rAF ms/s | After |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| roll | 29.7 | 100 | 37 | 42 (3683 ms) | 921 | 338.6 | 265.2 | — |
| scope | 26.3 | 116.6 | 45.1 | 50 (4416 ms) | 901.1 | 307.2 | 184.8 | — |
| roll collapsed | 39.6 | 83.3 | 16.3 | 21 (2039 ms) | 642.2 | 312.5 | 219.8 | — |
| beats | 44.1 | 50 | 12.2 | 23 (2110 ms) | 630.8 | 216.8 | 148.2 | — |

Other call sites while playing: `transport.js:176` rAF ≈5 ms/s (29.9 ms/s
with the roll collapsed); `beat-grid.js:682` rAF 14.2 ms/s in beats mode;
`@strudel/core` scheduler timer 8–9 /s, 32–79 ms/s. The Strudel `Drawer`
rAF is the dominant cost and keeps running when nothing is drawn: with the
roll collapsed it still costs 220 ms/s (RD-9), and in beats mode, where
`onDraw` returns immediately, 148 ms/s — roughly 3–4 ms per frame is the
Drawer's own hap query (PF-2). After stop everything returns to idle
levels (rAF 0 /s, timers ≈4 /s).

### 3.6 Leak slopes

Per cycle over the late window, heap after forced GC.

| Scenario | Heap MB | kB/cycle | DOM nodes | Listeners | After |
|---|---|---:|---|---|---|
| 30× evaluate→stop | 12.7 → 13.2 | 15.2 | 1752 flat | 482 flat | — |
| 30× tab switch (3 tabs) | 13.5 → 13.6 | 5.3 | 1758 → 1826 | 490 → 491 | — |
| 20× open/close Learn | 13.6 flat | 0.1 | 1826 flat | 491 flat | — |
| 20× open/close Sounds | 13.9 → 14 | −1.5 | **7798** flat | **4812** flat | — |
| 20× open/close Reference | 14 flat | 0.3 | 6976 flat | 4841 flat | — |
| 20× open/close Console / Export / Settings | 14–14.1 flat | 0.3 / 0.8 / 0.3 | 7909 / 7941 / 8569 | 4848 / 4856 / 4925 | — |
| 10× Hydra play→stop (play button) | 14.3 → 14.43 | 14.2 | flat | **501 → 511** | — |
| 10× shader play→stop (play button) | 12.54 → 12.5 | −3.8 | flat | 489 flat | — |

No scenario tripped the monotonic-growth flag. Notes: live AudioNodes stay
at 14 (4620 created over the evaluate/stop run); the first open of the
Sounds panel adds ≈6,000 DOM nodes and ≈4,300 listeners that are never
released (PN-15); each Hydra stop→play adds one `window` resize listener
and one retained context-lost canvas (RD-19: GL contexts created 13 / lost
13 / garbage-collected 0; the shader path collects all 13). No "too many
active WebGL contexts" warning in 20+ cycles.

### 3.7 Visuals verdict

Correctness evidence (pixel diffs, GL read-back); timings are software GL
and not representative.

| Check | Baseline result | Finding | After |
|---|---|---|---|
| Hydra in the Visuals bottom-panel mode | **Works**: 1280×800 backing store, clipped to the roll pane, 99.5% of panel pixels change between shots | — | **Works** (runner): changing pixels in the Visuals panel, nothing painted over the left rail |
| Hydra full-window mode | **Broken**: editor region changes 0% while the GL buffer changes 100%; the canvas covers the left-rail list instead (91.7% of its pixels) | RD-4 | — (not in the runner run; local Batch 1 evidence in §3.9) |
| Full-window ON, then stop → play | **Broken**: new canvas is `display:none` while `hydra.js` ticks at 54 /s | PF-1 | — (not in the runner run; local Batch 1 evidence in §3.9) |
| Shader canvas placement | **Misplaced**: hidden behind the editor (0.3% change) and painted over the left-rail list (91.7%); no Visuals mode offered; backing store 1440×900 uncapped | RD-3 | **Fixed** (runner): renders changing pixels in the Visuals panel, nothing painted over the left rail |
| Teardown on play-button stop | Canvas removed, GL context released, rAF 0 /s | — | — (local Batch 1 evidence in §3.9) |
| Teardown on `editor.stop()` (Ctrl+., palette, API) | **Not torn down**: canvas and live GL context remain; shader rAF keeps running at 9.5 /s while idle | RD-1 | **Torn down** (runner, Hydra and shader): canvas gone, rAF 0 /s |
| Switch tab and evaluate a non-visual pattern | Previous pattern's canvas and context stay up | RD-7 | **Gone** (runner) for a non-visual pattern evaluated after a visual one; the tab-switch variant was not scripted |

The runner uses software GL like the baseline did, so these are
correctness observations only. A GL-context census was not repeated.

### 3.8 Console noise

| Message | Count in the run | Finding | After |
|---|---:|---|---|
| `[strasbeat/icons] unknown icon "timer"` (every boot) | ×11 | UX-17 | 0 (runner: no boot console warnings) |
| `[midi] permission denied: NotAllowedError…` (every boot) | ×11 | MX-17 | 0 (runner: no boot console warnings) |
| `[strasbeat] shader WebGL context lost` (every normal shader stop) | ×15 | RD-21 | 0 (runner: the run stops a shader and fails on any unexpected `console.error`) |
| GL driver "GPU stall due to ReadPixels" | ×4 | harness artefact | — |

No failed requests in any run. The runner smoke run also fails on any
failed request or page error, and passed.

### 3.9 Measured during fixes (Batch 1)

Taken while the fixes were being written, before local browser runs
stopped. These are the only after-numbers this session has; they are not
re-runs of the §3 scenarios.

| What | Before | After | Finding | How measured |
|---|---:|---:|---|---|
| Listeners added by opening the Sounds panel (1,109 sounds) | +4,509 | +13 | PN-15 | headless Chromium, listener census |
| Five re-activations of the Sounds panel | 579 ms | 3 ms | PN-15 | headless Chromium |
| DOM nodes with the Sounds panel open | ≈6,500 | ≈6,500 | PN-15 | rows are rendered in chunks, not windowed, so the count is unchanged |
| Haps dropped by stale pooled nodes, first / second WAV render of the same pattern (48 haps) | 3 / 28 | 0 / 0 | MX-6 | render with per-hap failure counting |
| Autocomplete popup opens while typing 300 characters | 58 | 38 | ED-4 | headless Chromium |
| `node:test` tests | 692 | 1062 | — | `pnpm test` on a GitHub runner; 15 new test files, 13 extended |

Typing-latency profile taken for ED-12 (not an after-number): of ≈18 ms of
main-thread time per key, strasbeat code is ≈1.3 ms; the rest is
CodeMirror and rendering. The per-key offenders outside the editor are
`beat-grid.js` (0.58 ms rebuild, runs while hidden and forces a style
recalc), `track-bar.js` (0.37 ms) and `arrange-bar.js` (0.19 ms) — all
Batch 2.

Visuals evidence gathered before the stop (headless, software GL), Hydra
demo only: stopping by the play button, `editor.stop()` and Ctrl+. each
left no canvas, 0 rAF callbacks and 0 live GL contexts; in full-window
mode 88–92 % of editor pixels changed between shots while the top bar and
right rail changed 0 %; collapse, expand, divider drag, and stop → play
with full-window on all passed. The shader path and the cases listed in
§8 were not run.

### 3.10 Runner comparison (like-for-like)

The same headless-Chromium smoke script, run against a production build of
the baseline commit `03ba08c` and of the final tree, on the same GitHub
runner image (ubuntu-24.04, Playwright 1.65.1, software GL). The run fails
on any unexpected `console.error`, page error or failed request. The
script and its workflow lived on a throwaway `ci/smoke-*` branch and are
not part of `upgrade` (§7 item 21).

| | Baseline `03ba08c` | Final tree |
|---|---|---|
| Smoke checks passing | 28 / 41 — 13 fail: no tree / tablist landmarks, `tr909_bd` and `piano` missing, evaluate has no outcome, unknown sound not surfaced, signature hint absent in a call, palette not closable after Tab, the Hydra / shader / painter steps could not run, editor 0 px wide at 390 px and 172 px at 768 px | 49 / 49 |
| Editor present | 420 ms | 283 ms |
| "Ready to play" | 4.6 s | 2.9 s (network-dependent) |
| Initial JS transferred / decoded | 765 kB / 2,868 kB (one chunk) | 594 kB / 1,932 kB (+ 49 kB docs chunk after mount) |
| Long tasks during load | 209 + 133 + 61 ms | 140 + 125 ms |
| Registered sounds | 1,060 | 1,853 |
| Idle rAF callbacks /s | 0 | 0 |
| Typing, keydown → second frame, p50 / p95 / max (103 keys) | 18.3 / 31.1 / 34.7 ms | 17.3 / 32.2 / 34.1 ms (no measurable difference on the fast runner) |
| Boot console warnings | unknown icon "timer"; MIDI permission denied | none |
| Editor width at 390 / 768 px | 0 / 172 px | 354 / 696 px |

The baseline run counts 41 checks rather than 49: the Hydra, shader and
painter steps could not run there, so their later checks were never
reached.

Also recorded on the final tree only: FCP 168 ms; editor width 428 px at a
1024 px viewport; no horizontal scroll and Play visible at 390, 768 and
1024 px.

What the 49 checks cover on the final tree: boot to "Ready to play" with
no load warnings; `tr909_bd`, `piano` and `gm_piano` registered; 0 rAF
callbacks per second at idle and after stop; play / stop;
`editor.evaluate()` outcomes (`ok`, `error`); the unknown-sound warning in
the status line; all six panels render (five of them lazily); function
completion and the signature hint; command palette open / Tab / Escape;
the Hydra and shader demos render changing pixels in the Visuals panel, do
not paint over the left rail, are torn down by `editor.stop()` and stay
gone for a following non-visual pattern; `.punchcard()` draws in Custom
mode; a stored Vim profile is active after boot and types; editor width
and Play visibility at the three viewport widths.

**Caveat.** These are single runs on a shared runner, and the timings are
noisy: a second run of the same final build measured editor present at
388 ms (first run 283 ms), "Ready to play" at 3.9 s (2.9 s) and load long
tasks of 202 + 137 + 51 + 67 ms (140 + 125 ms) — as far from the first run
as the first run is from the baseline. So the timing rows do **not**
demonstrate a load-time improvement; only the byte counts (initial JS
765 kB → 594 kB transferred, 2,868 kB → 1,932 kB decoded), the sound count,
the layout widths and the pass/fail checks are solid. The runs are comparable with each other
and **not** with the local baseline in §3.1–§3.8 (different hardware; the
local baseline's worst typing frame was 324 ms). Playing-frame cost, leak
slopes and typing under CPU throttle were not re-measured; that needs the
later performance lane.

## 4. Findings

Each entry's nested `Status:` line is the only thing that changes after
this document is written. The findings still `open` are listed at the end
of this section.

### 4.1 Editor and CodeMirror extensions (ED)

Scope: `src/editor/**`, `src/editor-setup.js`, `src/editor-actions.js`,
`src/transpiler-patch.js`, editor wiring in `src/main.js` / `src/tabs.js`.

- **ED-1 · P1 · `src/editor/format.js:259-276`** — Format is async (first use also awaits the ~700 kB Prettier chunk; later runs 46–77 ms) and dispatches `{from: 0, to: code.length}` into whatever document is live when it resolves. Press Cmd+Shift+F in tab A and switch to B: B's head is replaced by A's formatted text and autosave persists it; typing one character mid-format leaves trailing garbage and loses the edit. Fix: bail when `view.state.doc !== oldDoc`.
  - Status: fixed (0cfdac9)
- **ED-2** — alias of **TR-6** (scrubber evaluates through `repl.evaluate`, bypassing the evaluate pipeline).
  - Status: fixed (78ece10) (see TR-6)
- **ED-3** — alias of **PS-9** (cached tab states restore stale compartments).
  - Status: fixed (3c1f547) (see PS-9)
- **ED-4 · P1 · `src/editor/completions/providers/functions.js:59-62`, `completions/install.js:54-71`** — The function provider matches `/\w*/` with no syntax-context check and is the fallback everywhere, fuzzy over ~1,000 names. Typing `// the bass line` opens a popup and Enter replaces `line` with `linger`; the same happens inside unrelated strings (reproduced). Fix: return null when `syntaxTree(state).resolveInner(pos, -1)` is inside a comment, string, template or regexp.
  - Status: fixed (3a41d17)
- **ED-5 · P1 · `src/editor/signature-hint.js:122-151`, `:30`, `:197-202`** — The signature pill goes stale: the cache key ignores position so it stays on line 3 after clicking the same call on line 40; it does not follow scroll; it shows with the cursor after the closing `)` (reproduced); it stays visible after blur; and `hide()`/`destroy()` do not clear `_pendingCtx`, so a queued measure can re-show it. Fix: include line and ArgList `from` in the key (or always re-measure), reposition on geometry change or move to a `showTooltip` field, require the cursor inside the arg list, hide when unfocused, null `_pendingCtx`.
  - Status: fixed (dc1d639)
- **ED-6 · P2 · `src/editor/completions/providers/chord.js:16`, `:55-57`** — The major-chord row has `label: "major", apply: ""`; CodeMirror uses `apply || label`, so accepting the first row after `chord("C` inserts `Cmajor`, which `.voicing()` rejects (zero haps; reproduced). The row also appears twice. Fix: an `apply` function that inserts `""`, drop the manual `""` entry, dedupe.
  - Status: fixed (3a41d17)
- **ED-7 · P2 · `src/editor/format.js:271-275`, `src/editor/keymap.js:56-60`, `src/ui/track-bar.js:145-149`** — Format and mute/solo replace the whole document, which collapses Strudel's mapped `miniLocations` marks and inline `slider()` widgets and makes one undo step replace everything. Formatting while playing kills highlighting and sliders until the next evaluate. Fix: mute/solo dispatches only the label range (the parser has `rawStart`/`rawEnd`); format dispatches a minimal diff.
  - Status: fixed (0cfdac9, 2cd0a41) — format and the mute/solo keys in the first, the track bar in the second
- **ED-8 · P2 · `src/main.js:1192-1204`; upstream `codemirror.mjs:176-180`, `highlight.mjs:56-75`, `slider.mjs:84-109`** *(= SC-20)* — On tab switch the Drawer keeps dispatching the playing tab's highlights into the focused state; marks are keyed by `from:to`, so a non-playing tab evaluated earlier lights up wherever ranges coincide (plausible). Slider and widget decorations live on ViewPlugin instances, so after A → B → A the inline sliders in A are gone while A keeps playing. Fix: store `{miniLocations, widgets}` per tab; clear mini-locations unless the incoming tab is the playing one, and re-dispatch them for the playing tab when its doc is unchanged since eval.
  - Status: deferred — slider widgets and highlight bleed on tab switch need per-tab `{miniLocations, widgets}` storage; not attempted in Batch 1
- **ED-9 · P2 · `src/editor/numeric-scrubber.js:401-404`, `:450-461`, `:94-117`; `src/styles/scrubber.css:105`** — A scrub drag triggers a full evaluate per frame without awaiting the previous one (transpile alone measured in node: ~10 ms at 30 lines, 25–60 ms at 106–184 lines, 100–140 ms at 450 lines), so above ~100 lines the drag cannot hold 60 fps. `ChipWidget` has no `updateDOM`, so the value chip is recreated and replays its 120 ms entry animation every frame; `HandleWidget.eq` includes `from`/`to`, so every keystroke recreates every handle after the cursor. Fix: latest-wins throttle (~60–80 ms trailing), add `updateDOM`, resolve the range at pointerdown.
  - Status: fixed (78ece10)
- **ED-10 · P2 · `src/editor/format.js:102-105`, `:177-181`, `:277-283`** — Format silently refuses valid patterns: quoted object keys (`{ 'gain': 0.5 }`) throw "string-literal count changed" because Prettier unquotes them, and any template literal with `${…}` throws; the only feedback is a `console.warn` (reproduced). Fix: `quoteProps: "preserve"`, brace-depth skipping for `${}`, and report failures through the transport status or console panel.
  - Status: fixed (0cfdac9)
- **ED-11 · P2 · `src/editor/hover-docs.js:157`, `src/editor/signature-hint.js:75`, `completions/providers/functions.js:18-28`, `:44-54`, `src/editor/strudel-docs.json`** — Docs-index quality (reproduced): plain-object lookup makes `constructor`/`toString` hover as empty bubbles; six arrange internals not exported from the barrel appear in autocomplete and hover; 158 of 564 entries have no params so the pill shows `note()`; `name.length < 2` excludes `s` and `n` so their snippets are dead; 395 of 885 lowercase live exports are undocumented plumbing but still listed. Fix: `Object.hasOwn` or a `Map`, mark internals `@noAutocomplete`, hide the pill when params are empty, allowlist one-letter names, rank undocumented exports last. See also SC-8.
  - Status: fixed (3a41d17, c729580) — own-key docs lookups and reachable `s`/`n` snippets in the first; the regenerated index in the second drops the arrange internals and cuts entries without parameters from 158 to 80
- **ED-12 · P2 · `src/editor/doc-sync.js:56-58` → `src/ui/track-bar.js:30-31`, `src/ui/arrange-bar.js:59-87`, `src/ui/beat-grid.js:421-422`, `src/ui/piano-roll.js:204-205`** — Every edit triggers 6–8 ms of redundant full-document scanning in the next frame: each subscriber calls `doc.toString()` and runs its own scanner, `parseLabels` runs two or three times, and all run even when their bar is hidden (671-line doc, node timings). Fix: `docSync` computes one memoised `{code, labels}` per `state.doc` identity and hidden subscribers skip parsing.
  - Status: fixed (16563a9, 5f344cf, 1f34df6) — the three parsers are memoised per buffer in the first; the track bar and arrange bar keep unchanged rows in the second; the beat grid builds nothing while hidden and diffs lanes in the third
- **ED-13 · P2 · `src/main.js:1437-1452`** — The capture-phase Cmd/Ctrl+B handler accepts either modifier, so Ctrl+B (cursor-left in Emacs and macOS-native bindings, page-up in Vim) also toggles the right rail on every press. Fix: platform modifier only, and skip for emacs/vim/helix profiles when the target is inside `.cm-editor`.
  - Status: fixed (78ece10)
- **ED-14 · P2 · `src/editor-actions.js:79-92`** — "Insert sound" from the browser, with the cursor anywhere inside `s("bd*2 sd hh*4")`, replaces the whole string with the one sound. The docstring says this is intended; it destroys the pattern in one click. Fix: replace only the token under the cursor (`tokenAtOffset` exists) or insert at the cursor. Product call — see §6.
  - Status: deferred — product call: replacing the whole string is the documented intent; see §7
- **ED-15 · P3 · `src/editor/mini-notation-tokens.js:34`, `completions/providers/mini-notation.js:158`** — The tokeniser treats `(` and `)` as part of a token, so `hh(3,8)` yields `hh(3` and gets no completions and no reveal-in-browser (reproduced); `.` and `-` are also missing. Fix: one shared separator class including them.
  - Status: fixed (3a41d17)
- **ED-16 · P3 · `src/editor/drum-parse.js:99-107`, `:307`** — `parseDrumLanes` returns `$: s("…")` lines inside block comments or template literals as editable lanes (the grid then edits dead code) and rejects digit-leading samples such as `808bd` (reproduced). Fix: reuse `parseLabels`' line-start detection; allow `[A-Za-z0-9_$]` as the first character.
  - Status: partly fixed (16563a9) — lanes inside block comments and template literals are skipped; digit-leading sample names (`808bd`) still rejected
- **ED-17 · P3 · `src/editor/error-marks.js:310`, `:322-323`** — The "foo is not a function" locator appends a non-word lookahead after the needle `foo(`, so only `foo("…")` and `foo()` are found; `foo(1)` and `foo(x)` get no line (reproduced). Fix: apply the lookahead only when the needle ends in a word character.
  - Status: deferred — not attempted in Batch 1
- **ED-18** — alias of **TR-19** (mute/solo starts playback when stopped).
  - Status: partly fixed (0cfdac9, 2cd0a41, 3962448) — mute/solo from the keymap, the track bar and the palette no longer start playback when stopped; the arrange bar's solo (`src/ui/arrange-bar.js` `handleSoloClick`) still evaluates with autostart (see TR-19)
- **ED-19 · P3 · `src/editor-actions.js:33`** — Sound preview checks `getSound(name)` with the bare suffix even when a `bank` is passed, so in-bank auditions whose suffix is not a standalone sound do nothing but warn (plausible; affected set not enumerated). Fix: check `` `${bank}_${name}` ``.
  - Status: fixed (8b01c29)
- **ED-20 · P3 · `src/editor/numeric-scrubber.js:304`, `src/editor/error-marks.js:58`, `src/editor/hover-docs.js:115`, `completions/info.js:111`, `src/editor/signature-hint.js:181-182`, `src/styles/autocomplete.css:368`, `scrubber.css:37,105`** — Editor a11y gaps: the scrubber is pointer-only with a 4 px hit zone; error dismiss, hover "→ Reference" and audition buttons respond to `mousedown` only; the pill is `aria-live` and re-announces every argument change; two entry animations ignore reduced motion. Fix: Alt+Up/Down nudge at the cursor, `click` handlers, drop `aria-live`, add a reduced-motion override.
  - Status: partly fixed (3a41d17, dc1d639, 2cd0a41, 78ece10) — buttons act on click, the pill is no longer `aria-live`, reduced-motion overrides added; keyboard scrubbing deferred as a new feature
- **ED-21 · P3 · `src/main.js:1088-1103`, `src/editor/numeric-scrubber.js:328`, `:333-337`, `completions/install.js:96`, `completions/context.js:248-253`, `completions/providers/sounds.js:104-118`** — Small stale-state items: the bank chip is not refreshed on tab switch; scrubber handles are not rebuilt when the background parse advances (plausible); scrubber `destroy()` leaves the body cursor/class if swapped mid-drag (plausible); an open completion popup is restored with the tab snapshot (plausible); `extractFromState` stringifies the doc only to read its length; under `.bank("X")` out-of-bank sounds are offered and accepting one yields a non-existent `X_<fullname>`.
  - Status: partly fixed (3a41d17, 78ece10) — the bank chip is still stale after a tab switch

Checked and sound: every `appendConfig` lands before the clean base state
is captured (`main.js:1172`); fresh-tab undo isolation; the
quote-restoration walker; `transpiler-patch.js` costs one extra acorn parse
(1–2 ms); no unbounded module-level caches in `src/editor/`.

### 4.2 Transport, evaluate/stop lifecycle, error feedback, boot (TR)

Scope: `src/main.js`, `src/boot.js`, `src/eval-feedback.js`,
`src/ui/transport.js`, `src/strudel-logger.js`, `src/user-setup.js`,
`src/debug.js`, `src/command-palette-actions.js`, `src/ui/track-bar.js`,
`src/ui/arrange-bar.js`, `src/strudel-ext/{arrange,progression,roman,styles}.js`.

- **TR-1 · P1 · `src/eval-feedback.js:332`, `:345`, `:443-456`** — Cancelling during an in-flight evaluate does not cancel: with a slow top-level await (`await initHydra()` first load, `await samples(...)`), clicking "Cancel playback start" shows "play canceled", then the repl finishes and `setPattern(..., true)` starts the scheduler anyway (reproduced). Fix: remember that the superseding request was a stop and call the original stop when a superseded evaluate finds the scheduler started; more robust, gate in the repl's `beforeStart` option.
  - Status: fixed (2cd0a41)
- **TR-2 · P1 · `src/eval-feedback.js:469`, `:90-113`; `src/main.js:153` → `src/strudel-logger.js:12-17`** — Runtime errors during playback never raise the transport badge: upstream `errorLogger` logs `[cyclist|getTrigger|query] error: …` with no type, and only `type === "error"` is treated as an error (reproduced). Separately, the custom superdough logger is console-only and replaces the bridge into `strudel.log`, so sampler load failures never reach the in-app console. Fix: classify by `/^\[(cyclist|getTrigger|query|superdough|sampler)\]\s*error/i` as well, and forward the filtered superdough logger to core's `logger` (same in `export.js:477`, `:615`).
  - Status: fixed (2cd0a41)
- **TR-3 · P1 · `src/eval-feedback.js:349-362`, `src/export.js:485-490`, `src/debug.js:71-75`** *(= MX-4)* — A failed evaluate resolves normally and upstream leaves `state.pattern` untouched, so exporting a buffer with a syntax error renders and downloads the previous good pattern (possibly another tab's) and reports success (reproduced). Fix: after the evaluate in `runExport`/`probeRender`, throw when `editor.repl.state.evalError` is set; better, have the patched evaluate resolve to `{ ok }`.
  - Status: fixed (e3066de)
- **TR-4 · P1 · `src/main.js:1460-1469`; upstream `codemirror.mjs:261-285`** — `repl-evaluate`, `repl-stop` and `repl-toggle-comment` are handled twice, because the installed StrudelMirror already registers its own listeners. In Vim, `gc` toggles the comment twice (a no-op) and `:w` evaluates twice (two dividers, two analytics events, duplicate arrange registry entries). Fix: delete the evaluate and toggle-comment listeners; reduce the stop listener to visuals teardown or fold that into the stop patch (RD-1).
  - Status: fixed (2cd0a41)
- **TR-5 · P2 · `src/strudel-ext/progression.js:241-254`; docs `STRUDEL.md:165-166`, `:175-178`** — `progression()` weights do the opposite of the docs (reproduced): `'Am F C G@2'` squeezes the whole progression into one cycle via `timeCat` (about 5× faster), and `'G*2'` gives G two full cycles — what `@2` promises. The unit tests enshrine the current behaviour (`progression.test.js:565-580`, `:640-655`). Fix: `timeCat(...).slow(totalWeight)` for weights; `*N` keeps one slot holding `fastcat` of N copies; update both test groups.
  - Status: fixed (b26e91d)
- **TR-6 · P1 · `src/eval-feedback.js:319-343`, `src/editor-setup.js:139-141`, `src/editor/numeric-scrubber.js:450-461`, `src/strudel-ext/arrange.js:219`, `:272-285`; upstream `codemirror.mjs:297`** *(= ED-2)* — Arrange priming/reset and tab ownership exist only on the patched-evaluate path; the numeric scrubber (`editor.repl.evaluate` per frame) and the boot first-frame bypass it. Scrubbing grows the arrange registry by one entry per `arrange()` per frame (31 after 30 frames, reproduced) and silently drops a soloed section to the full arrangement while the SOLO pill stays; scrubbing in a non-playing tab replaces the playing tab's audio; a fresh load shows "edited since last play" on an untouched pattern. Fix: move prime/reset/begin/end into StrudelMirror's `beforeEval`/`afterEval` hooks, route the scrubber through a light patched path with `autostart=false`, and skip scrub evaluation when the focused tab is not the playing tab or the scheduler is stopped.
  - Status: fixed (78ece10)
- **TR-7 · P2 · `src/eval-feedback.js:261-345`** — Overlapping evaluates are not serialised: `_lastEvalHadError`, `_evalInProgress`, the arrange registry and the repl's pattern table are shared. Two evaluates in one tick register each `arrange()` twice (reproduced); a slow older evaluate can install older code after a newer one, and a failing one can push a succeeding one down the error branch (both plausible). Fix: chain evaluates on a promise, drop superseded queued requests, keep `hadError` per call.
  - Status: fixed (2cd0a41)
- **TR-8 · P2 · `src/main.js:1427-1435`, `:1013-1016`** — "Now playing" tab ownership is assigned after every autostart evaluate even when nothing started: after a syntax error while idle, or a cancel, the tab shows the playing marker and the "Playing X — click to jump" chip with the engine stopped; during a slow first play it goes to whichever tab is focused when the await resolves. Fix: capture the owner before the await and set it only when the scheduler started and the call was not superseded.
  - Status: fixed (2cd0a41)
- **TR-9** — alias of **RD-1** (only the play button and `repl-stop` tear down visuals).
  - Status: fixed (7e42564) (see RD-1)
- **TR-10 · P2 · `src/eval-feedback.js:432-438`; upstream `repl.mjs:223-225`** — Play on an empty buffer throws `no code to evaluate` outside upstream's try; no caller catches it, so the transport flashes "Starting", the console gets only a divider, and devtools shows an unhandled rejection (reproduced). Fix: early return in the patched evaluate with status "nothing to play — the editor is empty".
  - Status: fixed (2cd0a41)
- **TR-11 · P2 · `src/main.js:1600-1603`, `src/export.js:172-185`** — The export mutex only guards the play button; Cmd/Ctrl+Enter, the palette, track-bar clicks and `repl-evaluate` all reach `editor.evaluate()` while the offline context is installed, starting the live scheduler against it (missing guard confirmed; audible damage plausible). Fix: refuse autostart in the patched evaluate while `isExportRunning()`. Related: MX-7.
  - Status: fixed (2cd0a41, 8414591) — evaluate-side guard in the first; bridge, metronome and preview guards in the second
- **TR-12 · P2 · `src/eval-feedback.js:393-418`, `:450-454`** — The status text goes stale: only the first play writes "playing …", so after stop → play it reads "Stopped" for the rest of the session (same after "play canceled", export messages). Fix: write "playing" after every successful autostart evaluate. Related: UX-20.
  - Status: fixed (2cd0a41)
- **TR-13 · P2 · `src/strudel-ext/arrange.js:141`, `:187-195`; `src/main.js:1224-1230`** — Arrange solo is module-global, not per tab: solo section 2 in tab A, play tab B and B plays (and exports) only its section 2. Fix: `clearSolo()` in the tab install hook, or key solo by tab.
  - Status: fixed (2cd0a41)
- **TR-14** — alias of **RD-8** (arrange-bar rAF never stops).
  - Status: fixed (5f344cf) (see RD-8)
- **TR-15** — alias of **RD-9** (roll/scope rendered while collapsed).
  - Status: fixed (0ae6dd7) (see RD-9)
- **TR-16 · P2 · `src/eval-feedback.js:375-386`, `:415`; `src/export.js:60-120`** — Per-evaluate overhead: the pattern is queried twice (`0–1` then `0–4`) and `prewarmSounds` builds a real voice per unique sound on every evaluate, including the constant re-evaluates from grid edits, mute and solo. The comment claiming the first play awaits prewarm "before cycle 1" is untrue — the scheduler has already started. Fix: one `queryArc(0, 4)`, a `Set` of already-warmed keys, and either really gate the first start or correct the comment.
  - Status: fixed (2cd0a41)
- **TR-17** — alias of **SC-2** (drum-machine bank aliases never loaded).
  - Status: fixed (5daf860) (see SC-2)
- **TR-18 · P2 · `src/boot.js:56-60`, `:117-122`, `:27`, `:111`** — Boot load failures surface only as a transient "Ready with N load warnings" that the next status overwrites; there is no retry and nothing in the in-app console. A timed-out `dirt-samples` leaves every `s("bd")` silent for the session with no indication. Fix: expose `getBootFailures()`/`retry(label)`, warn in the console panel with the bank name, keep a persistent transport badge, optionally retry once in the background.
  - Status: fixed (2cd0a41)
- **TR-19 · P2 · `src/ui/track-bar.js:152`, `src/editor/keymap.js:61`, `src/command-palette-actions.js:43-56`, `src/ui/arrange-bar.js:340`** *(= ED-18)* — Track mute/solo and arrange solo call `editor.evaluate()` with autostart, so clicking a track chip (or Cmd+M) while stopped starts audio and takes tab ownership; the beat grid deliberately does not. Fix: gate on `editor.repl.scheduler.started`. Whether this is unintended is a product call; the beat-grid comment suggests yes.
  - Status: partly fixed (0cfdac9, 2cd0a41, 3962448) — mute/solo from the keymap, the track bar and the palette no longer start playback when stopped; the arrange bar's solo (`src/ui/arrange-bar.js` `handleSoloClick`) still evaluates with autostart
- **TR-20 · P1 · `src/eval-feedback.js:192-235`, `:385`, `:410`** *(= UX-4)* — Unknown-sound and silent-pattern warnings go only to the console panel: `s("bd*4, not_a_sound*2")` shows no inline mark, no badge, no dot on the Console tab, while the editor highlight flashes on the bad name and the roll draws a lane for it (reproduced). `progression("…")`'s single-quote warning reaches only devtools. The silence warning misfires on visuals-only or setup-only buffers, validation covers only cycles 0–4 so later `arrange` sections are never checked, and the console repeats the same error once per second ungrouped. Fix: reuse the error-mark pipeline at warning severity (underline the token, "Did you mean…" widget), a warning pill that opens the console, route `progression()`'s warning through `consolePanel.warn`, collapse repeats to ×N, unread dot on the Console tab, skip the silence warning for `initHydra(`/`shader(`, validate arrangements up to ~64 cycles. Related: SC-16, PN-17.
  - Status: fixed (2cd0a41)
- **TR-21 · P3 · `src/strudel-ext/progression.js:44`, `:123`, `:189`, `:215-220`, `:286-287`** — `progression()` option edge cases (reproduced): double-quoted `bass`/`rhythm`/`style` values arrive as Patterns and are silently ignored or warn `"[object Object]"` with no single-quote hint; valid single-token rhythms (`'0*4'`) are rejected; `in` matches prototype keys so `rhythm: 'constructor'` throws a mini parse error; `comp` on a 3-note dictionary plays one note twice at once (about +6 dB). Fix: one Pattern-input guard loop over all string options, `Object.hasOwn`, relax the raw-mini test.
  - Status: partly fixed (b26e91d) — done: Pattern-input warning for `rhythm`/`style`/`key`/`bass`, own-key lookups; deferred: single-token raw rhythms such as `'0*4'`, `comp` doubling a note on triads
- **TR-22 · P3 · `src/ui/transport.js:299-300`, `src/ui/track-bar.js:29-160`, `src/ui/arrange-bar.js:58-132`, `src/boot.js:67-79`** — Small inefficiencies: two dataset writes per transport tick outside the change guard (see RD-24); track bar and arrange bar rebuild their whole DOM on every doc-change frame even when the parsed result is unchanged (diff on a cheap signature first); four 15 s boot timeout timers are never cleared. Also `CLAUDE.md` is stale here: `evalScope` is called at `src/boot.js:51`, and `renderPatternToBuffer` lives in `src/export.js`.
  - Status: partly fixed (98402b1, 5f344cf) — transport attribute writes happen only on change and both bars keep unchanged rows; the four 15 s boot timeout timers are still never cleared

Checked and sound: `evaluate`/`stop`/`setDrawTime` are patched exactly once
and no listeners are added per evaluate; queued play during boot is
superseded correctly; the transport re-derives state from
`scheduler.started` within one poll; boot always resolves and never blocks
first paint; the unknown-sound check matches superdough's lookup; `roman.js`
tables are correct.

### 4.3 Right-rail panels, modals, command palette (PN)

Scope: `src/panels.js`, `src/ui/{right-rail,sound-browser,reference-panel,console-panel,export-panel,settings-panel,learn-panel,setup-panel,command-palette,modal,settings-drawer,keymap-chip,fuzzy,icons}.js`
and their CSS. No XSS vector was found: every dynamic string goes through
`textContent`.

- **PN-1 · P1 · `src/ui/right-rail.js:167-169`, `:309`; `src/panels.js:96-275`** — The persisted active tab is never restored: Learn registers first, the stored id (say `console`) is not registered yet, so the stale-id fallback activates Learn and saves it over the stored value (reproduced with a stub DOM). Fix: keep the stored id pending and activate only when the matching panel registers; resolve a never-registered id lazily on expand.
  - Status: fixed (371797d)
- **PN-2 · P1 · `src/ui/settings-panel.js:599-601`, `:912`, `:144`; `src/ui/modal.js:538-544`, `:190-191`** — Sample-deletion confirmations pass a string to a `confirm` that destructures an options object, so the dialog for an irreversible IndexedDB wipe has no title, no message, `aria-label="undefined"`, and OK focused. Fix: pass `{title, message, confirmLabel: "Delete", destructive: true}`; make `buildConfirm` throw on a non-object or missing title; drop the `window.confirm` default.
  - Status: fixed (8b01c29, 3b24ced)
- **PN-3 · P1 · `src/ui/modal.js:252-270`; `src/patterns.js:326-359`, `:420-453`** — Chained modals: modal A restores focus in an 80 ms timeout after modal B has opened ("New pattern" → "New folder…"), so focus jumps back to the editor and the folder name is typed into the pattern behind the overlay, or to the "+" button where Enter re-triggers the flow. Fix: restore focus synchronously in `closeActive` before resolving (or only when no newer modal is active) and let a successor inherit `prevFocus`.
  - Status: fixed (3b24ced)
- **PN-4 · P1 · `src/editor-actions.js:117-138`; `src/patterns.js:167-181`; `src/ui/reference-panel.js:1063-1066`; `src/ui/learn-panel.js:245-251`; `src/ui/modal.js:190-191`** — "Try" does `editor.setCode` on the active pattern and autosave writes the example over it one second later. The confirm says "Unsaved changes will be lost", which reads as harmless in an autosaving app; an unmodified demo gets no confirm; in the Reference list Enter → Enter → Enter destroys a pattern from the keyboard. Fix: open the example in a scratch tab; minimum, reword to name the pattern, confirm for every non-scratch pattern, and focus Cancel when `destructive`. See §7.
  - Status: fixed (8b01c29)
- **PN-5 · P2 · `src/ui/right-rail.js:128-133`; `sound-browser.js:613-620`, `reference-panel.js:994-1001`, `console-panel.js:481-490`, `learn-panel.js:194-201`** — "First Escape clears the search, second returns to the editor" is one step in all four panels, because the panel handlers do not stop propagation and the rail handler always focuses the editor. Fix: `stopPropagation()` in the clear branch.
  - Status: fixed (371797d)
- **PN-6 · P2 · `src/ui/sound-browser.js:249-250`; `src/styles/sound-browser.css:119-120`** — The "Wavetable" and "User" pills set `hidden` but `.sound-browser__pill { display: inline-flex }` wins, so both always render and lead to an empty list. Fix: a global `[hidden] { display: none !important; }` in `base.css` removes the whole class of bug.
  - Status: fixed (58a6fb1)
- **PN-7 · P1 · `src/ui/command-palette.js:21-22`, `:79-82`, `:100-105`, `:199-224`, `:241-256`** *(= UX-2)* — The palette does not trap focus despite its header comment: Tab moves focus to the page under the overlay, after which Escape and Enter never reach the palette and it stays up, intercepting all pointer events, until the scrim is clicked (reproduced in Chromium). No `aria-modal`, no accessible name on the input, no `aria-activedescendant` or option ids. Fix: handle keys on the overlay, `preventDefault` on Tab, add the missing ARIA, make the `<ul>` non-focusable.
  - Status: fixed (3962448)
- **PN-8 · P2 · `src/ui/command-palette.js:241-274`** — Reopening the palette within 200 ms of closing lets the stale exit timer remove the overlay while `isOpen` is true; it then takes two more shortcut presses to get it back. Fix: cancel the timer and listener in `open()` and remove the exiting class, or guard `onEnd` with `isOpen`.
  - Status: fixed (3962448)
- **PN-9 · P2 · `src/ui/export-panel.js:299-302`, `:348`, `:469-470`, `:677`; `src/main.js:1686-1689`** *(= MX-14)* — The export filename refreshes only in `idle` mode and nothing returns to idle after the first export, so export A, switch to B, click the toolbar WAV button and B's audio downloads as `A.wav`. Enter is also dead after the first export. Fix: track whether the user edited the name; otherwise refresh from the pattern name on activate and at the top of `startExport` whenever not running; allow Enter in `done`/`error`.
  - Status: fixed (8b01c29)
- **PN-10 · P2 · `src/ui/settings-panel.js:209`, `:218`, `:892-925`** — `create()` and `activate()` both call the async `refreshBanks()` back to back; both clear before either resolves and both append, so first open shows the bank list (or its empty message) twice. Fix: drop the call in `create()` or use a request token.
  - Status: fixed (8b01c29)
- **PN-11 · P2 · `src/ui/settings-panel.js:298-314`, `:995-1001`** — Every settings row is a `<label>`; in the Accent row the first labelable descendant is the Reset button, so clicking "Accent", the swatch or "Live preview" discards the stored custom accent (from HTML label semantics; not observed in a browser). Fix: build that row as a `<div>`.
  - Status: fixed (8b01c29)
- **PN-12 · P2 · `src/ui/settings-panel.js:910`; `src/ui/icons.js`** — `makeIcon("trash-2")` is not registered, so each bank row ends in an empty, unlabelled delete button plus a console warning. Fix: register `Trash2`, add `aria-label`, and add a test that every literal `makeIcon("…")` name exists.
  - Status: fixed (8b01c29)
- **PN-13 · P2 · `src/ui/settings-panel.js:572-583`; `src/user-setup.js:261`, `:303`, `:328`; `src/ui/sound-browser.js:711-719`, `:926-930`** — User-sample import: the bank is named after the manifest file, so a `strudel.json` with keys `bd`, `sd` matches nothing under the "User" filter; a second `strudel.json` import silently overwrites the first; imports take effect only on next boot with no reload banner; the Import button has no busy state and failure uses native `alert()`. Fix: match on the stored key list, derive the name from more of the URL and confirm overwrite, show the reload banner or register live, report errors inline. Related: SC-9.
  - Status: fixed (8b01c29)
- **PN-14 · P2 · `src/command-palette-actions.js:95`; `src/ui/command-palette.js:472-477`; `src/ui/sound-browser.js:293-294`; `src/panels.js:93`** — The Setup panel is dead: nothing calls `createSetupPanel` (`src/ui/setup-panel.js` and `src/styles/setup.css` are unreferenced), so "Open Setup Panel" is a silent no-op and the sound browser's empty state points at a tab that does not exist. Also `referencePanel?.focusEntry?.()` does not exist (the method is `scrollTo`) and the Learn panel never calls `onOpenReference`. Fix: either remove the command, files and copy, or register the panel — see §7.
  - Status: partly fixed (3962448, 58a6fb1) — the palette command and the copy pointing at a Setup tab are gone; `src/ui/setup-panel.js` and `src/styles/setup.css` are still in the tree, unused, pending §7
- **PN-15 · P2 · `src/ui/sound-browser.js:210-214`, `:228-239`, `:262-266`, `:380-384`, `:399-453`, `:553-555`** — The sound browser rebuilds its entire unvirtualised list on every activation (rows for collapsed groups too, five listeners per row), resetting scroll and keyboard selection; measured ≈6,000 DOM nodes and ≈4,300 listeners retained after first open (§3.6). Fix: refresh only when the soundMap key count changed, delegate row events to the list, skip collapsed groups, track the previous active element.
  - Status: fixed (58a6fb1)
- **PN-16 · P2 · `src/ui/reference-panel.js:454-457`, `:585-636`, `:859-868`; `src/eval-feedback.js:370`** — Once opened, the reference panel fully re-renders (up to 574 entries) on every successful evaluate even while hidden, and each expand re-renders the list; when visible, running Try from the keyboard destroys the focused entry and arrow navigation dies. Fix: diff the in-use set and toggle chips in place, skip while hidden with a dirty flag, patch only the affected entries on expand.
  - Status: fixed (8b01c29)
- **PN-17 · P2 · `src/ui/console-panel.js:251`, `:262-273`, `:336-349`** — Every log line forces a read-layout → append → write and an O(n) recount; a per-hap warning burst also evicts the whole 500-entry history because identical lines are not coalesced. Fix: flush once per animation frame, keep a running counter, collapse consecutive identical messages into one row with a ×N badge.
  - Status: fixed (58a6fb1)
- **PN-18 · P2 · `src/ui/learn-panel.js:470-492`; `src/panels.js:60-89`** — The Learn panel calls its async `onTry`/`onCopyToNewPattern` without `await`: "Loaded ✓" flashes and the entry is marked tried while the confirm is still open (and after "Keep editing"); "Copied ✓" flashes before the form is answered and on cancel. Fix: have the callbacks return a boolean, await them, flash only on success. Related: PS-8.
  - Status: fixed (8b01c29)
- **PN-19 · P2 · `src/ui/sound-browser.js:696`, `:746-755`, `:771`** — Any prefix with three or more members counts as a kit, so `gm_*` and `wt_*` become kits and the Kits pill lists every GM instrument with stripped names. Fix: exclude those prefixes (or soundfont/wavetable/synth types).
  - Status: fixed (58a6fb1)
- **PN-20 · P2 · `src/ui/right-rail.js:170-171`, `:207-219`, `:306`; `src/styles/right-rail.css:56-59`** — Collapsing the rail with focus inside it hides the focused element and drops focus to `<body>`; on reload with the rail expanded the panel's search input takes focus at boot (plausible; observed in the UX pass, see UX-12). Fix: call `onFocusEditor()` on collapse when focus is inside; pass a "restoring, don't focus" flag for registration-time activation.
  - Status: fixed (371797d)
- **PN-21 · P2 · `src/ui/export-panel.js:349-350`, `:357`** — The panel keeps the last render's `AudioBuffer` and WAV bytes alive until the next export — hundreds of MB for a long render — although the buffer is only needed once to draw the waveform. Fix: drop the buffer after drawing; keep a single `Blob`. Part of MX-18.
  - Status: fixed (8b01c29)
- **PN-22 · P2 · `src/ui/fuzzy.js:12-15`, `:96-113`** — The greedy matcher prefers a later word-boundary occurrence and never backtracks, so valid subsequences return no match (`score("abs", "ambient-pads-b")` → `null`, reproduced); highlight indices shift on decomposed (NFD) names. The consumer is the left-rail search. Fix: retry with nearest-occurrence picks on failure; build an index map while folding.
  - Status: fixed (cda6f50)
- **PN-23 · P2 · `src/styles/tokens.css:12`, `:19`; `sound-browser.js:152`, `:178`, `:197`; `reference-panel.js:403`, `:412`, `:426`; `learn-panel.js:128`, `:141`, `:164`, `:346-352`; `command-palette.js:79-105`; `right-rail.js:240-243`; `console-panel.js:170`, `:361`; `export-panel.js:221-229`, `:276-279`** — Panel a11y: `--text-dim` on `--surface-1` is about 2.4:1 and carries real content (see UX-3); category pills are `role="tab"` with no tabpanel or arrow keys though they behave as filters; `role="listbox"` containers hold buttons with no `aria-selected`; the rail tabs have no arrow keys and the resize handle has no keyboard path; console entries are `listitem` inside `log`; export progress has no `progressbar` role and the error no `alert`; several panel stylesheets have no reduced-motion rule. Fix: raise the token for text, pills become `aria-pressed` buttons, add the missing roles, one global reduced-motion block (UX-24).
  - Status: fixed (371797d, 58a6fb1, 8b01c29, 9d5751a) — roles and ARIA in the first three; the `--text-dim` / `--text-mut` contrast tokens and the global reduced-motion block in the last (see UX-3, UX-24)
- **PN-24 · P3 · `src/ui/command-palette.js:120-123`** — Palette items execute on `pointerdown` of any button or pointer type, so starting a touch scroll runs the command under the finger and right/middle click execute too. Fix: execute on `click`; keep `pointerdown` only to hold input focus.
  - Status: fixed (3962448)
- **PN-25 · P3 · `src/ui/reference-panel.js:879-890`** — Reference "Try" appends `.s("piano")` textually to examples lacking a sound: of 37 such first-examples, 11 break (suffix swallowed by a trailing comment, or a syntax error after `;` — `offset`, `drawLine`, `add`, `sub`, `gap`, `silence`, `useRNG`, `clearScope`; measured). 103 of 564 entries have no example, so no Try button. Fix: skip the append when the last line has `//` or ends with `;`; hide Try for non-pattern entries. Note `s("piano")` itself is silent until SC-1 lands.
  - Status: fixed (8b01c29)
- **PN-26 · P3 · various** — Confirmed nits: `cancelLabel: ""` still renders an empty focusable cancel button (`panels.js:205`, `:215`; `modal.js:572-576`); export `parseInt` accepts `4.7` and `1e2` (`export-panel.js:755-760`); a result arriving while the tab is hidden leaves the waveform blank forever (`:600-620`, see UX-14); the download object URL is revoked synchronously after `click()` (`:582`, plausible abort); the documented export Cancel state does not exist (`:77`); `focusSound` (Cmd+Shift+B) does nothing when the current filter hides the sound (`sound-browser.js:535-549`); "Hold to preview" describes a one-shot and a double-click insert auditions twice (`:144`, `:441-448`); a `console.warn` on every pre-boot refresh (`:733-741`); Enter in the Learn search does not flush its debounce (`learn-panel.js:214-222`); the palette has no "no matching commands" row and hard-codes the accent on selected-hover; `.modal { min-width: 360px }` overflows below ~392 px; rail width is clamped 240–480 px regardless of window width (`right-rail.js:50`, `:342-345`); the OSC test never closes its socket on timeout (`settings-panel.js:698-726`); redundant Space/Enter handlers on native buttons (`:465-472`, `:524-531`); "Clear" wipes the setup script with no confirm (`:645-648`); the `settings-drawer.js` popover code is dead (`:48-144`, `:176-281`); the keymap popover does not handle Tab (`keymap-chip.js:343-361`).
  - Status: partly fixed (3b24ced, 3962448, 58a6fb1, 8b01c29, 528b280, a31117b) — most nits done, including the right-rail width cap against the window (528b280) and Tab in the keymap popover (a31117b); deferred: dead popover code in `settings-drawer.js`, export cancel

Checked and sound: the console ring buffer and DOM are capped at 500; all
four list searches are debounced at 150 ms; modal and popover document
listeners are removed on close; panels are created lazily on first
activation; rail width and expanded state persist correctly.

### 4.4 Rendering, animation loops, Hydra/shader visuals (RD)

Scope: every canvas, rAF/timer loop and draw hook. Nothing in this section
was observed in a real browser by the reading audit; RD-1, RD-3, RD-4,
RD-7, RD-19 and RD-21 were then confirmed by the headless measurements
(§3.7, §3.8).

#### Render-loop table

| # | Loop | Where | Starts | Stops | Runs when stopped? | Runs when hidden/collapsed? |
|---|---|---|---|---|---|---|
| L1 | Strudel `Drawer` rAF → `onDraw` (roll / scope / custom / shader-uniform feed) | `@strudel/draw/draw.mjs`; wired `src/main.js:335-366` | `repl.onToggle(true)` | `onToggle(false)` | No; one extra frame at boot via `drawFirstFrame` | **Yes** — `renderRoll` runs every frame when collapsed (RD-9) |
| L2 | Transport readouts rAF | `src/ui/transport.js:161-180`, `:237-240` | `kick()` or the 4 Hz poll seeing `started` | first tick where `!started` | No | n/a |
| L3 | Transport safety poll, 250 ms interval | `src/ui/transport.js:146-155` | mount | only `dispose()` (never called) | **Yes, forever** (4 Hz, DOM writes guarded) | Yes |
| L4 | Beat-grid playhead rAF | `src/ui/beat-grid.js:664-707` | `isPlaying && !root.hidden` | stop, `hide()`, mode switch | No | No — correctly gated |
| L5 | Arrange-bar playhead rAF | `src/ui/arrange-bar.js:351-426` | end of every `rebuild()` with ≥1 row | only when rows become 0 | **Yes, forever** while the buffer has `arrange()` (RD-8) | Yes |
| L6 | Hydra render rAF | `src/strudel-ext/hydra.js:223-279` | `initHydra()` / `setHydraRenderEnabled(true)` | `clearHydra()`, gate off, tick throw | **Yes** on every stop path except the play button and `repl-stop` (RD-1); also started at boot (RD-2) | Gated by Visuals mode / full-window, but the gate reads stale geometry (RD-6) |
| L7 | Shader render rAF | `src/strudel-ext/shader.js:174-195`, `:221-229` | `shader()` → `n.start()` | `clearShader()` only | **Yes** (RD-1, RD-2, RD-7) | **Yes — no visibility gate**, full viewport × full DPR (RD-3) |
| L8 | Token-cache expiry timeout, 2 s | `src/ui/piano-roll.js:186`, `src/ui/scope.js:70` | each `readTokens` miss | self-expiring | No | fine |
| L9 | Canvas resize debounce, 50 ms | `src/main.js:164-168` | ResizeObserver / toggle | one-shot | — | fine |
| L10 | Visuals clip resize debounce, 200 ms | `src/main.js:262-266` | window `resize` | one-shot | — | fine |
| L11 | Hydra resize re-clamp, 250 ms | `src/strudel-ext/hydra.js:138-160` | window `resize` while Hydra live | one-shot; listener removed in `clearHydra` | — | fine |
| L12 | `getDrawContext` resize timeout, 200 ms | `@strudel/draw/draw.mjs:21-27` | window `resize` | **listener never removed** — one per Hydra init (RD-19) | — | — |
| L13 | Beat-grid auto-replay timeout, 120 ms | `src/ui/beat-grid.js:1187-1200` | grid edit while `started` | one-shot; not cancelled on stop (RD-14) | can fire after stop | — |
| L14 | Scope-controls save rAF | `src/ui/scope-controls.js:140-146` | slider input | one-shot | — | fine |
| L15 | Track-bar / arrange-bar rebuild rAF | `src/ui/track-bar.js:171`, `src/ui/arrange-bar.js:434` | doc change | one-shot (coalesced) | — | fine |
| L16 | Beat-grid rebuild microtask | `src/ui/beat-grid.js:639-646` | every doc change | one-shot | — | **runs while hidden** (RD-12) |
| L17 | MIDI-bar key fade rAF | `src/ui/midi-bar.js:627-650` | note-off | when `fadingNotes` empties | — | fine |
| L18 | Metronome interval | `src/midi-bridge.js:693` | capture + metronome | `_stopMetronome` | — | fine |
| L19 | Export progress poll, 100 ms | `src/export.js:363-384` | offline render | `finally` | — | fine |
| L20 | CSS `bottom-panel-pulse` (infinite `box-shadow`) | `src/styles/bottom-panel.css:83-96` | `data-state="playing"` | state change | No | paints every frame while playing (RD-24) |

#### Findings

- **RD-1 · P1 · `src/main.js:1461-1465`, `:1604-1608`; `src/eval-feedback.js:443-456`; `src/command-palette-actions.js:34`; `src/export.js:486`, `:623`; `src/debug.js:72`; upstream `codemirror.mjs:115-121`** *(= TR-9)* — `clearHydra()`/`clearShader()` run only from the play button and the `repl-stop` event. Stop with Ctrl+. (the shortcut the transport tooltip advertises), the palette, or the API and audio stops while the canvas, GL context and render loop keep running indefinitely (measured: shader rAF 9.5 /s with the transport idle). Fix: one choke point — the patched stop or the transport's `onPlaybackStateChange("idle")`, which already observes every path — and delete the two inline copies.
  - Status: fixed (7e42564)
- **RD-2 · P1 · `src/main.js:332`; `src/strudel-ext/shader.js:351-353`; `src/strudel-ext/hydra.js:510`; `src/export.js:485-486`; upstream `codemirror.mjs:181`, `:293-305`** — `autodraw: true` evaluates the whole pattern at boot, including `await initHydra()` and `await shader(...)`, whose loops start regardless of playback; export does the same. Reload with a shader pattern last open and, with no click, a WebGL context renders at 60 fps full-res forever; a WAV export of a visuals pattern leaves the loop running. Fix: make the visual side effects playback-aware (register intent; start/stop from the playback-state callback), or at minimum tear down after `drawFirstFrame` and in export's `finally`.
  - Status: fixed (7e42564)
- **RD-3 · P1 · `src/strudel-ext/shader.js:49-61`, `:177-181`; `src/styles/visuals.css:8-12`, `:22-35`** — The shader canvas has no CSS: `position:fixed`, `z-index:auto`, prepended to `<body>`, sized to `innerWidth × devicePixelRatio` uncapped, never clipped or gated, and no Visuals mode is offered. By paint order it covers the non-positioned chrome (top bar, left rail, transport) and is itself covered by the editor, right rail and roll pane — visible only where it should not be (measured: 91.7% of left-rail list pixels replaced, editor region 0.3%). Fix: give it the Hydra treatment — hidden by default, the same clip/full-window classes, `setVisualsAvailable(true)`, a render gate, and the Hydra resolution cap.
  - Status: fixed (7e42564)
- **RD-4 · P1 · `src/main.js:401-404`, `:409`; `src/styles/visuals.css:38-41`; `src/styles/tab-strip.css:254-256`; `src/styles/shell.css:173-176`** — Full-window Hydra is hidden behind the editor: only `#editor` is made transparent, but `.editor-pane` is positioned (since the pattern-tabs work) with an opaque background, so nothing shows behind the code and the canvas covers the static chrome instead (measured: editor region 0% change, left-rail list 91.7%). Fix: under `.shell--visuals-fullwindow` make `.editor-pane` transparent and give the canvas an explicit negative-layer placement so its position no longer depends on which panes are positioned.
  - Status: fixed (7e42564)
- **RD-5 · P1 · `src/strudel-ext/uniforms.js:38`, `:110-129`; `src/main.js:183`, `:344`, `:447-454`** — Shader auto-uniforms treat "new in the visible-haps list" as an onset, but the list spans ±2 cycles, so `uKick` fires two cycles before the sound (reproduced: a hap at cycle 2 fed at time 0 returns `uKick: 1`). The demo only looks right because `bd*4` in a one-cycle loop is phase-aligned; anything else flashes four seconds early at 120 bpm. `dt` is also in cycles while the decay constant is documented in seconds, so decay scales with tempo. Fix: consider only haps with `whole.begin <= time < end`, detect "became active since last frame", convert `dt` to seconds.
  - Status: fixed (b5b4e21)
- **RD-6 · P1 (Visuals mode) / P2 (drag feel) · `src/styles/shell.css:59`; `src/piano-roll-resize.js:35-46`, `:69-79`; `src/main.js:218`, `:237`** — Roll collapse, expand and divider drag fight the 200 ms grid transition: `syncVisualsClip()` reads the rect synchronously at the transition's t=0 and nothing re-syncs. Expanding in Visuals mode reads ~0 px, removes the clip and pauses the loop (no visuals until the next mode switch); collapsing keeps the clip so the canvas paints over the bottom of the editor; dragging retargets a 200 ms ease on every pointermove, so the divider trails the pointer. Fix: a `shell--roll-resizing { transition: none }` class during drag, drive the clip from a ResizeObserver on `#roll-pane`, one write per frame.
  - Status: fixed (bb9efe9)
- **RD-7 · P2 · `src/strudel-ext/hydra.js:381`; `src/strudel-ext/shader.js:29`, `:268-271`** — There is no teardown on the evaluate path: delete the `await shader(...)` block and re-evaluate, or switch tab and evaluate another pattern, and the old program keeps rendering while "Visuals" stays available for code no longer playing (measured). Fix: per-eval "visuals requested" flags set by `initHydra()`/`shader()`; in `afterEval` clear whichever was not requested.
  - Status: fixed (7e42564)
- **RD-8 · P2 · `src/ui/arrange-bar.js:131`, `:351-399`** *(= TR-14)* — The arrange-bar rAF re-arms unconditionally whenever there is at least one row, including while stopped and for parser-preview rows that never move. Open any pattern containing `arrange(` and a 60 Hz loop runs for the life of the tab. Fix: gate like the beat grid — when not started, reset the rows once and stop; every play already restarts it through `rebuild()`.
  - Status: fixed (5f344cf)
- **RD-9 · P2 · `src/main.js:335-366`, `:174`; `src/piano-roll-resize.js:35-36`; `src/styles/roll.css:50-52`** *(= TR-15)* — `onDraw` checks only the mode, so with the bottom pane collapsed the roll (or scope) is fully redrawn into an invisible canvas every frame (measured: 220 ms/s of Drawer script collapsed vs 265 ms/s visible). Fix: expose `isCollapsed()` from the resize module and return early after the shader-uniform feed.
  - Status: fixed (0ae6dd7)
- **RD-10 · P2 · `src/main.js:175-178`, `:353`, `:364`, `:1193-1213`** — There is no idle repaint. While stopped, resizing the divider/window or opening the right rail clears the roll until the next Play (the stale hit map stays clickable); switching tab leaves the previous pattern's frame; hover ring and error flash never draw. Fix: keep the last `{haps, time}` and expose `repaintRoll()`, called after resize, on mode change and on idle mouse move; on tab swap while stopped, clear or re-query the first frame. Related: UX-11.
  - Status: partly fixed (0ae6dd7) — the roll keeps its last frame and repaints on resize, mode switch and tab swap while stopped; remaining: stopping while a different tab is focused leaves that last frame on screen (a click on it is now a no-op)
- **RD-11 · P2 · `src/ui/piano-roll.js:145-158`, `:200-224`, `:419-429`, `:594-611`; `src/main.js:364`** — Click-to-locate and label colours apply the playing pattern's source offsets to whatever document is focused: with tab A playing and B focused, clicking a pill selects A's range inside B's text (or throws a caught `RangeError`) and pill colours come from B's labels; an unevaluated edit above the pattern shifts every click by a line. Fix: snapshot `{docVersion, labels, tabName}` at evaluate time, focus the playing tab on click, and map offsets through the changes since eval or disable the click when the doc changed.
  - Status: fixed (0ae6dd7)
- **RD-12 · P2 · `src/ui/beat-grid.js:476-504`, `:602-609`, `:656-659`, `:2148-2188`** — The beat grid tears down and rebuilds its whole DOM on every keystroke even while hidden: a full parse, every cell button with five listeners, one ResizeObserver per lane, and a forced style recalculation per lane. With 8 lanes × 16 steps that is ~130 buttons and ~650 listeners per keystroke for an invisible panel. Fix: when hidden, only parse and set a dirty flag; when visible, append all lanes then measure once, use one ResizeObserver, delegate cell events to the root.
  - Status: fixed (1f34df6)
- **RD-13 · P2 · `src/ui/beat-grid.js:724-730`, `:792-808`, `:929-932`** — The grid's root keydown handler exempts only inputs: Enter/Space on any other button inside the grid (M, S, bank chip, "+ Add drum", …) is cancelled and toggles the last focused cell instead — an unintended source edit, and an auto-replay while playing. Fix: return early unless the event target is a cell (same for `v`).
  - Status: fixed (1f34df6)
- **RD-14 · P2 · `src/ui/beat-grid.js:1187-1200`; `src/main.js:1426-1434`, `:1561`; `src/ui/track-bar.js:152`; `src/ui/arrange-bar.js:333-349`** — Auto-replay hazards: a grid edit or mute in a non-playing tab evaluates the focused buffer and steals playback from the playing tab; and the 120 ms replay timer is not cancelled on stop, so toggling a cell then pressing Stop restarts playback. Fix: an `isFocusedTabPlaying()` predicate for the three bars; re-check `started` inside the timer and clear it on idle. The first half is partly a product decision.
  - Status: fixed (1f34df6) — the beat grid's replay is tab-aware and cancelled on stop; the track bar's `isPlaying` does not use the same tab-aware predicate yet (§7 item 5)
- **RD-15 · P2 · `src/main.js:162-163`, `:181`, `:352-353`; `src/ui/piano-roll.js:239-245`** — A device-pixel-ratio change alone is not detected (the ResizeObserver uses the content box), and the renderers divide the old backing store by the new DPR: drag the window from a 2× to a 1× display and the roll draws at half size in one quarter with a broken hit map (from the spec; not browser-verified). Fix: observe `device-pixel-content-box` with a `matchMedia` fallback; store the DPR used at resize time.
  - Status: fixed (0ae6dd7) — not checked on a real display change (§8)
- **RD-16 · P2 · `src/strudel-ext/uniforms.js:55-61`, `:114-129`; `src/strudel-ext/shader.js:184`, `:190`, `:352`** — Per-frame cost in the shader path: `hapId` stringifies a Fraction twice per hap for every hap in the ±2-cycle window, plus fresh `Set`/`Object.keys`/spread allocations; `getAttribLocation` and `Object.entries` run every frame; every evaluate recompiles and relinks even when the source is unchanged (cost not measured). Fix: after RD-5 only active haps matter; cache the attribute location; skip `setFragment` when the source is unchanged.
  - Status: fixed (b5b4e21)
- **RD-17 · P2 · `src/ui/transport.js:200-201`; `src/ui/arrange-bar.js:377-378`; `src/styles/transport.css:337-339`** — The transport and arrange playheads animate `width`/`left` up to 60×/s (layout + paint each frame), and the transport fill has an 80 ms `width` transition retargeted every frame, so it lags the dot and sweeps backwards at each cycle wrap. Fix: `transform: scaleX()` / `translateX()` with `will-change`, as the beat-grid playhead already does; drop the transition.
  - Status: fixed (98402b1, 5f344cf) — transport fill and dot in the first, arrange playhead in the second
- **RD-18 · P2 · `src/strudel-ext/hydra.js:381`, `:426`, `:476`** — `initHydra()` is not re-entrant across its `await import("hydra-synth")`: two overlapping evaluates on the first slow load both construct a Hydra on the same canvas (one resize handler and one regl instance leak); a stop during the import is a no-op and Hydra then starts while idle (plausible; timing-dependent). Fix: memoise the in-flight init promise and bail after the await if a generation counter bumped by `clearHydra()` changed.
  - Status: fixed (7e42564)
- **RD-19 · P3 · upstream `@strudel/draw/draw.mjs:21-27`; `src/strudel-ext/hydra.js:556`, `:570`** — Each Hydra init adds an anonymous window `resize` listener (via `getDrawContext`) that retains a dead canvas (measured: listeners 501 → 511 over 10 cycles, 13 contexts never collected). Separately `globalThis.s0?.clear?.()` runs after `regl.destroy()` outside any try/catch; if it throws, canvas removal and the availability callback are skipped (plausible). Fix: create the canvas locally; delete or guard that line.
  - Status: fixed (7e42564)
- **RD-20 · P3 · `src/strudel-ext/hydra.js:598-601`; `hydra-synth/src/eval-sandbox.js:16-18`** — Hydra writes its synth functions to `window`, overwriting Strudel's `time`, `noise`, `src` and `hush` as well as `speed` and `shape`; `clearHydra()` restores only the last two, so after any Hydra pattern a later bare `hush()` or `noise(...)` gets Hydra's version against a destroyed regl until reload. Fix: snapshot the colliding names before `new Hydra` and restore them all.
  - Status: fixed (7e42564)
- **RD-21 · P3 · `src/strudel-ext/shader.js:197-201`, `:241`** — `destroy()` calls `loseContext()` with the `webglcontextlost` listener still attached, so every normal shader stop logs a spurious "shader WebGL context lost" error (measured ×15 in one run). Fix: set a `destroyed` flag or remove the listeners first, as the Hydra path does.
  - Status: fixed (7e42564)
- **RD-22 · P3 · `src/strudel-ext/hydra.js:602`; `src/ui/bottom-panel-modes.js:112-119`** — Every stop makes Visuals unavailable, which switches the bottom panel back to Roll; on the next play the mode is available again but not reselected. Fix: remember "was in visuals when it became unavailable" and reselect.
  - Status: fixed (c4e4400)
- **RD-23 · P3 · `src/ui/piano-roll.js:192-198`, `:221`, `:319`, `:331-340`, `:363-371`, `:378`, `:395`, `:411`, `:419`, `:479`, `:504`** — Piano-roll per-frame allocations (a mapped array plus object per hap, a sort with `localeCompare`, new `Map`/`Set`, a gradient, two font strings) and a `colorForKey` map that gains a key per distinct source offset and is never pruned, so unlabelled layers also change colour when text is inserted above them (cost not measured; likely within budget at normal densities). Fix: recompute rows only when the key set changes, cache per-location label index and the gradient, clear the colour map on evaluate.
  - Status: fixed (0ae6dd7)
- **RD-24 · P3 · `src/ui/transport.js:146-155`, `:298-300`; `src/styles/bottom-panel.css:83-96`** — Idle and per-frame leftovers: the 250 ms poll never stops; `applyPlaybackState` writes two dataset attributes on every tick outside the change guard (120 attribute sets per second while playing); the status-dot pulse animates `box-shadow` forever while playing. Fix: move the writes inside the guard, replace the poll with the repl's `onToggle`, animate opacity/transform on a pseudo-element.
  - Status: fixed (98402b1) — the readout loop follows the playback state; a 1 Hz idle poll remains (stopped while the tab is hidden), so a scheduler started from the devtools console is noticed within 1 s instead of 250 ms
- **RD-25 · P3 · `src/strudel-ext/hydra.js`, `shader.js`, `src/ui/piano-roll.js`, `scope.js`** — No canvas or WebGL loop honours `prefers-reduced-motion`; a reduced-motion user opening the shader demo gets full-viewport flashing on every kick. Fix: at minimum gate the auto-uniform pulses and full-window mode behind the media query (render a static frame; log once how to opt in).
  - Status: fixed (7e42564) — visuals; the chrome's CSS animations follow the setting since 9d5751a, the JS-driven playheads (transport, arrange bar, beat grid) still move (§7)

Checked and sound: the beat-grid playhead (transform-based, gated); scope
buffers; the Hydra resolution cap and teardown order; the shader compile
path; token caches; hap source offsets match the document; the canvas
backing store is resized only on change.

### 4.5 Persistence, autosave, tabs, folders, library I/O, share links (PS)

Scope: `src/patterns.js`, `src/store.js`, `src/tabs.js`, `src/share.js`,
`src/library-io.js`, `src/ui/left-rail.js`, `src/ui/tab-strip.js`,
`vite.config.js`, and the wiring in `src/main.js` / `src/panels.js`.

- **PS-1 · P0 · `src/ui/left-rail.js:497-510`, `:825`; `src/main.js:965-976`** — Cmd/Ctrl+Backspace on a focused rail row deletes a user pattern with no confirm, no undo and no trash. Clicking a row leaves DOM focus on the row, so a user who believes the editor is focused and presses the macOS "delete to line start" chord loses the pattern. The context-menu and bulk paths do confirm. Fix: route the single case through the same confirm, and move focus to the editor after selecting a pattern.
  - Status: fixed (3c1f547)
- **PS-2 · P0 · `src/patterns.js:178-182`, `:35-41`** — The autosave flush rebuilds the record as `{code, modified, isUserPattern}` and drops `folder`, so every foldered pattern falls to Unfiled after one keystroke or tab switch, and drag-to-folder is undone by the next flush (reproduced). Fix: merge with the previous record instead of replacing it.
  - Status: fixed (3c1f547)
- **PS-3 · P0 · `src/main.js:270-277`, `:1242`; `src/share.js:29-43`, `:79`; `src/patterns.js:176-182`** — The `#code=` hash always wins boot and is never cleared. A recipient who edits a shared pattern for an hour and reloads boots on the original snapshot under the same `shared-<name>`, and the first flush overwrites the edits; a second link with the same name overwrites the first; the `shared-*` record is never added to the index so it is unreachable once its tab closes; the sharer's own URL keeps the hash, so their next reload opens a stale clone. Fix: adopt the arrival as a real user pattern with a unique name (unless byte-identical to an existing record), strip the hash with `history.replaceState`, and stop rewriting the sharer's URL.
  - Status: fixed (3c1f547)
- **PS-4 · P1 · `src/patterns.js:167-182`, `:73-82`, `:45-51`; `src/tabs.js:145-146`; `src/main.js:1258`** — `flushToStore` writes unconditionally, with no dirty check, on every tab switch and `beforeunload`. Consequences: merely viewing a demo pins a working copy that shadows later shipped changes and shows a "Modified" dot (reproduced), which also breaks the dev loop "edit the file in an IDE → HMR reload"; a second window's stale buffer clobbers another window's edits; `modified` churns and reorders the rail; a pattern deleted elsewhere is resurrected as an unindexed record. Fix: a `pending` flag set by `scheduleAutosave()` and required by the flush; delete the record when a shipped pattern's code equals its original; compare `modified` before writing and surface a conflict.
  - Status: fixed (3c1f547)
- **PS-5 · P1 · `src/tabs.js:173-198`, `:145`** — Closing the active tab never flushes: type or paste, then click × within the 1 s debounce, and the edits are gone on reopen (reproduced: zero flushes during close). Fix: flush in `close()` when the tab was active, with a `{ flush }` option that the three delete callers (`main.js:716`, `:833`, `:973`) pass as `false`.
  - Status: fixed (3c1f547)
- **PS-6** — alias of **MX-1** (capture preview "Play" writes the phrase into the active pattern).
  - Status: fixed (7399af5) (see MX-1)
- **PS-7 · P1 · `src/panels.js:260-265`; `src/tabs.js:150`** — Library import with "Overwrite existing" only refreshes the rail; a pattern open in a tab keeps its cached state and the next unconditional flush writes the old buffer over the imported record, with success already reported. Fix: `applyImport` returns the names it wrote and the handler calls `tabs.refresh(name)` for each open one, after cancelling the pending autosave.
  - Status: fixed (8b01c29)
- **PS-8 · P1 · `src/panels.js:14`, `:67-89`; `src/patterns.js:326`; `src/ui/learn-panel.js:522-531`** — Learn panel "Copy to new pattern" calls `handleNewPatternClick` without `formModal`, which throws `formModal is not a function` as an unhandled rejection while the button flashes "Copied ✓". Even when fixed, the follow-up `saveBtn?.click()` opens the disk prompt in dev and does nothing in prod. Fix: hoist one `openNewPatternDialog({ seedCode })` out of `main.js:886-907` and pass it to the panels; accept seed code; await before flashing; throw loudly on a missing `formModal`.
  - Status: fixed (8b01c29)
- **PS-9 · P1 · `src/tabs.js:150-155`; `src/main.js:1173-1213`; `src/editor/build-editor-state.js:29-39`; `src/editor-setup.js:151-153`** *(= ED-3)* — Cached tab states are restored verbatim with whatever compartment values were live when they were snapshotted. Change the theme, wrapping, font size or keymap profile in tab A, switch to B, and B has the old values while the keymap chip and settings panel show the new ones; each tab drifts until closed (underlying semantics reproduced). Fix: in `installTabState`, read `liveCompartmentValues` from the outgoing state and apply matching `reconfigure` effects to the incoming one with `addToHistory.of(false)`.
  - Status: fixed (3c1f547)
- **PS-10 · P2 · `src/tabs.js:49-75`, `:127-139`; `src/main.js:292-296`** — The persisted open set is never reconciled with what exists: a renamed/removed demo or a pattern deleted in another window returns as a ghost tab (reproduced). If it had a working copy, the edits become unreachable once the tab closes; if not, clicking it shows an empty editor and the next flush creates an empty unindexed record. Fix: in `hydrate()` drop names with neither a shipped original nor a record, and promote orphaned records to user patterns (same sweep once at boot).
  - Status: fixed (3c1f547)
- **PS-11 · P2 · `src/library-io.js:46-72`, `:106-166`; `src/patterns.js:5`, `:36`, `:176`; `src/ui/left-rail.js:229`, `:240`** — Library import edge cases (all reproduced): a folder declared with different case (`jazz` vs local `Jazz`) lands its patterns in Unfiled; a quota error mid-import leaves written records with no index entry, invisible and still consuming quota; a user pattern named like a shipped demo, or `constructor`, is previewed as new, then rewritten as non-user and disappears. Fix: map folders to the canonical spelling, commit the index in a `finally` and report "N of M", build `patterns` with a null prototype and treat shipped-name collisions as conflicts.
  - Status: fixed (3c1f547)
- **PS-12 · P2 · `src/main.js:393`, `:1239`, `:1242`; `src/ui/left-rail.js:292`; `src/panels.js:284-285`; `src/tabs.js:123-125`, `:159-220`; `src/store.js:38-42`, `:80`; `src/patterns.js:184-188`** — Unguarded storage access: three raw `localStorage.getItem` calls on the boot path throw `SecurityError` when site data is blocked, aborting the top-level-await module so nothing is wired; `tabs.persist()` rethrows quota errors at boot (plausible; needs near-exact fullness) and mid-`focus()`, leaving the strip stale; with storage blocked autosave silently never saves; the quota message is a transient status. Fix: a `safeStorage` helper, `persist()` that catches and reports, and a persistent "not saving" transport indicator.
  - Status: fixed (3c1f547)
- **PS-13 · P2 · `src/main.js:1258-1260`** — `beforeunload` is the only flush hook. Mobile tab discard loses edits inside the debounce; with no `storage` listener one window never reflects another's creates/deletes/renames (see PS-4); with no `hashchange`, pasting a share link into an open strasbeat tab does nothing. Fix: flush on `pagehide` and on `visibilitychange` to hidden; a `storage` listener that refreshes the rail and flags changed open tabs; run the share-arrival path on `hashchange`.
  - Status: fixed (3c1f547)
- **PS-14 · P2 · `vite.config.js:35-95`; `src/main.js:1615-1653`; `src/ui/command-palette.js:497`; `src/command-palette-actions.js:35`** — `/api/save` (dev only) accepts any POST with no `Origin` or content-type check, so any page open in the same browser can overwrite `patterns/<name>.js` via a simple no-preflight request (checks confirmed absent; exploit not run; no path traversal). The Save button overwrites a different existing file with no prompt, desyncs `currentName` from the tab controller, and does not catch a failed `fetch`. In production the palette still lists "Save Pattern ⌘S", which does nothing, and ⌘S is bound nowhere. Fix: require `application/json` and a matching `Origin`; confirm cross-file overwrite; `tabs.reKey`; catch failures; omit or repurpose the command in prod.
  - Status: fixed (b358d55)
- **PS-15 · P2 · `src/ui/tab-strip.js:79-149`; `src/ui/left-rail.js:115-159`, `:448`, `:610`, `:823-831`, `:880`, `:1252-1387`; `index.html:164`** — Tab strip and rail keyboard/a11y: Enter/Space on a tab's × bubbles to the tab handler and focuses the tab, so the close button cannot be keyboard-activated; every render replaces all children so the focused tab loses focus on any play/stop/dirty change; every tab is `tabindex="0"` with no arrow keys; no middle-click close. The rail `listbox` contains buttons, rows are reachable only by ArrowDown from search, the context menu has no menu roles or focus management, and inline rename traps focus on an invalid name. Fix: target guard on the tab handler, roving tabindex with arrow keys, preserve focus across renders, tree semantics for the rail (UX-5), menu roles. Related: UX-13.
  - Status: fixed (589bfa8, d3fc79b) — the tab strip in the first, the patterns tree and its menu in the second
- **PS-16 · P3 · `src/share.js:13`, `:21-27`, `:66`, `:100-105`; `src/main.js:270`** — The share size cap is enforced only on encode; decode inflates anything (50 MB of text fits in a 68 kB hash, reproduced), so a crafted link can hang the tab at the top-level await on every load. Fix: reject over-long input before decoding and read the stream with a byte budget (~512 kB).
  - Status: fixed (3c1f547)
- **PS-17 · P3 · `src/patterns.js:45-51`, `:57`; `src/main.js:697-705`, `:803-809`, `:1057-1059`, `:1249`; `src/ui/left-rail.js:53`, `:58`, `:1459-1466`** — Minor: the rail sort comparator does a storage read and full `JSON.parse` per comparison, and `computeDirtySet` re-parses every shipped record on each tab-strip render; folder names `__unfiled__`/`__demos__`/`__new__` collide with sentinel keys; context-menu bulk delete confirms twice; the "restored your edits" boot status shows whenever a record exists (always, given PS-4); the folder-delete "unfile" branch does not catch quota errors.
  - Status: partly fixed (3c1f547) — done: single-read rail sort, reserved sentinel folder names, one bulk-delete confirm, null-prototype patterns map; not done: dirty-set caching, quota handling in the folder-delete "unfile" branch

Checked and sound: corrupted JSON in the index or a record does not break
boot; autosave writes one record per flush; fresh tabs get isolated undo
history and per-tab selection/scroll survive switches; delete paths do not
flush the deleted buffer back; rename re-keys everything and preserves
`folder`; no XSS vector for pattern, folder or share names.

### 4.6 MIDI in/out, capture, MIDI import, WAV export, OSC (MX)

Scope: `src/midi-bridge.js`, `src/midi-to-strudel.js`, `src/midi-gm.js`,
`src/capture.js`, `src/export.js`, `src/ui/{midi-bar,midi-import-dialog,export-panel,setup-panel}.js`.
No browser or MIDI hardware was available to this audit.

- **MX-1 · P0 · `src/capture.js:168`, `:179-190`, `:195-230`, `:250-261`; `src/main.js:1074-1078`, `:1258-1260`** *(= PS-6)* — The capture preview's Play does `editor.setCode(previewCode)` on the live buffer, and neither save path restores the original. In the natural flow (capture → Play → Save) autosave writes the captured phrase into the open pattern's record; for a user pattern with no shipped original the only copy is gone after reload. Discard also leaves the preview playing. Fix: never route the preview through the real buffer — evaluate it directly with `editor.repl.evaluate(previewCode)`, or suspend autosave for the modal's lifetime and restore on every exit path (without an undo step) before opening the new tab; stop preview playback on discard.
  - Status: fixed (7399af5)
- **MX-2 · P1 · `src/midi-bridge.js:547`, `:893-899`** — `_modWheel` initialises to 0 with the comment "default fully open", but the mapping sends 0 to a 200 Hz low-pass. A mod wheel rests at 0 and keyboards send no CC1 until it moves, so every melodic live note plays through a 200 Hz filter; keyboards without a wheel can never open it. Fix: apply the filter only after a CC1 has been received (`null` until then); reset on disconnect.
  - Status: fixed (8414591) — wheel direction changed: rest is unfiltered, pushing it up closes the filter
- **MX-3 · P1 · `src/midi-to-strudel.js:27-33`, `:59-62`; `src/midi-gm.js:220-258`; `src/ui/midi-import-dialog.js:354-373`** — The drum-track heuristic is true whenever every pitch is a GM drum key (35–57 and 59–66), ignoring program and channel, and the dialog offers no override. A finger-bass line E2–D3 imports as `s(cat("sd lt mt mt", …))`; a flute melody C4–F4 likewise (reproduced). Fix: require no contrary evidence (program 0, channel 0) plus a positive signal (name match, or kick+snare+hat present), and add a per-track drums/melodic toggle.
  - Status: fixed (1b28215, aa4ad7b) — heuristic in the first, per-track override in the dialog in the second
- **MX-4** — alias of **TR-3** (export after an eval error renders the previous pattern).
  - Status: fixed (e3066de) (see TR-3)
- **MX-5 · P1 · `src/ui/midi-bar.js:438-457`; `src/user-setup.js:43-55`; upstream `midi/midi.mjs:75-96`** *(= SC-7)* — The MIDI output device selector only reads and writes localStorage; nothing consumes the value. With IAC and a hardware synth connected, selecting the synth changes nothing — `.midi()` keeps using the first IAC port — while the dropdown and green dot report a routing that does not exist. Fix: wrap `Pattern.prototype.midi` after the package loads so a call with no port uses the stored device; until then relabel the control as informational.
  - Status: fixed (c61db47)
- **MX-6 · P1 · `src/export.js:94-114`, `:323-335`, `:345-351`, `:619-622`; upstream `superdough/nodePools.mjs`, `helpers.mjs:243`** — superdough's node pools are module-level, keyed by type and not by `AudioContext`, and are not drained when export swaps live ↔ offline. After playing a pattern with `.lpf()`, an export can pop a filter belonging to the closed live context; `connect()` throws and the hap is dropped with only a `console.warn` — the first filtered notes of the file go missing; the reverse happens to the first live haps after export (plausible; depends on GC and event timing). This matches the "silent WAV" symptom `CLAUDE.md` attributes to eager controller construction; the lazy-controller workaround does not touch the pools. Fix: drain the pools after each context swap (import from `superdough/nodePools.mjs`; add `superdough` as a direct dependency); report upstream.
  - Status: fixed (e3066de) — known gap: wavetable pools are probed only with sounds the rendered pattern uses
- **MX-7 · P2 · `src/main.js:1460`, `:1600`; `src/midi-bridge.js:669-687`, `:818-827`, `:905`; `src/ui/midi-bar.js:754-768`; `src/editor-actions.js:54`** — `isExportRunning()` is consulted in exactly one place. During an export, live MIDI notes, the metronome and sound previews all call `getAudioContext()`, get the offline context, and are baked into the WAV at arbitrary positions while being inaudible live (guards confirmed missing; effect plausible). Fix: bail in the bridge's note-on, the metronome tick and the preview helpers while exporting; evaluate guard as in TR-11.
  - Status: fixed (2cd0a41, 8414591) — evaluate-side guard in the first; bridge, metronome and preview guards in the second
- **MX-8 · P2 · `src/export.js:338-351`, `:497`, `:544-552`; upstream `superdough.mjs:571`, `core/repl.mjs:301`** — Export under-reports failures: per-hap exceptions (missing sound, cross-context connect) are only `console.warn`ed and never reach the "errors during render" count, and `scheduled` is never compared with the onset count, so a mistyped sound exports "successfully" with the layer missing. Also `.midi()`/`.osc()` layers, silent in the app, are rendered as the default synth. Fix: collect failures, show `failed/total`, treat `scheduled < onsets` as a warning state; skip haps with a dominant trigger.
  - Status: fixed (e3066de)
- **MX-9 · P2 · `src/export.js:323-325`, `:485-504`, `:619-622`; `src/debug.js:98-101`** — Early export failures (eval throws, no pattern, "no onset haps") happen before the context swap, but the `finally` unconditionally discards and rebuilds the live `AudioContext` without closing it; each failed attempt orphans a running context. `probeRender` has no `try/finally`, so a throw leaves the offline context installed. Fix: a `contextSwapped` flag gating the rebuild; add the `finally` to `probeRender`.
  - Status: fixed (e3066de)
- **MX-10 · P2 · `src/export.js:66-74`, `:323-325`, `:513`; upstream `superdough/sampler.mjs:86-105`** — Closing the live context before rendering rejects in-flight `decodeAudioData` calls, and superdough caches the rejected promise per URL forever; export right after pressing play on a slow connection and the still-loading variants are silent in the export and in all later playback until reload (plausible). Fix: `suspend()` the live context instead and close or restore it after the render.
  - Status: deferred — closing the live context racing in-flight decodes was not reproduced
- **MX-11 · P2 · `src/ui/midi-import-dialog.js:29`, `:229-237`, `:298`, `:515`; `src/midi-to-strudel.js:273-274`, `:400-401`** — MIDI import parses on the main thread, twice, with roughly quadratic cost per track (measured in node, single track: 5 k notes 0.7 s, 10 k 2.6 s, 20 k 7.9 s, 30 k 13 s — paid on open and again on Import); the 5 MB cap does not bound it and no "parsing…" state shows. An exception in analysis (e.g. spread `Math.min` on a huge track) leaves an empty dialog; a 70-byte file with one long delta yields 10,417 bars of rests. Fix: parse and analyse in a Worker, keep the parsed input instead of re-parsing, cap notes per track and total bars, wrap analysis in try/catch, replace spread min/max with a loop.
  - Status: fixed (1b28215)
- **MX-12 · P2 · `src/midi-to-strudel.js:69-75`, `:106-107`, `:202-207`** — Notes are quantised from wall-clock seconds against the first tempo only, so a file with a tempo change is rhythmically wrong from that point on (16 quarter notes with a 120 → 90 BPM change become 5 bars on a triplet grid, reproduced); the same applies to time-signature changes. Fix: quantise in ticks (`bar = floor(ticks / (ppq × beatsPerBar))`) and carry `ticks`/`durationTicks` through the parser.
  - Status: fixed (1b28215)
- **MX-13 · P2 · `src/midi-to-strudel.js:367-381`, `:608`, `:625`, `:685`, `:702`, `:1044-1068`** — Track names become JS identifiers with only a character-class and uniqueness check: a track named "Default" emits `const default = note(` (SyntaxError, reproduced) and "Note"/"S"/"Cat" emit `const note = note(` (ReferenceError at eval). Fix: a deny-list of reserved words and Strudel globals, suffixing `Track` on collision.
  - Status: fixed (1b28215)
- **MX-14** — alias of **PN-9** (export filename goes stale after the first export).
  - Status: fixed (8b01c29) (see PN-9)
- **MX-15 · P2 · `src/midi-bridge.js:180-198`, `:967`; `src/midi-to-strudel.js:558-566`** — Capturing with the Drums preset saves `note(cat("c2 f#2 d2 …")).s("sawtooth")` (reproduced): the preset has no `s` and the capture adapter hard-codes `isDrum: false`. Per-preset FX and envelope are also dropped for every preset. Fix: pass `isDrum: !!preset.drumMap` and generate from the preset's own map (it disagrees with the GM map on a few keys).
  - Status: fixed (8414591)
- **MX-16 · P2 · `src/midi-bridge.js:833-834`, `:905`, `:909-917`; `src/boot.js:49`; `src/export.js:622`** — There is no voice limit on live MIDI: each note-on is an independent voice held up to 8 s (tripled with the pedal down), re-striking a key does not choke the earlier voice, and superdough's voice stealing is disabled at boot because `initAudioOnFirstClick()` is called with no options, making max polyphony `NaN`. Organ preset, pedal down, fast playing → hundreds of sustained voices, clipping and audio-thread glitches. Fix: pass an explicit `maxPolyphony` at boot (upstream default 128); cap concurrent live voices and cut the duration of a re-struck key.
  - Status: partly fixed (e3066de, 8414591) — live `initAudio()` now passes an explicit cap of 128 (it was NaN); superdough returns no voice handle, so the bridge cannot steal the oldest voice — instead holds taper as voices pile up (from 24 the pedal stops extending; past 48 the hold shrinks in proportion). See §7
- **MX-17 · P1 · `src/main.js:1729`; `src/midi-bridge.js:715-735`; `src/ui/transport.js:247-254`; `src/user-setup.js:220`, `:235-237`; `src/ui/midi-bar.js:425-433`** *(= UX-8)* — `midi.start()` runs unconditionally at module load and calls `requestMIDIAccess()`: every first-time visitor gets a browser permission prompt before pressing play, and declining leaves a permanent red "MIDI blocked" pill with no way to retry (the request and the pill were observed on every headless load). When MIDI output is enabled, a failed sysex request only warns and the output select shows "Loading…" forever. Fix: query `navigator.permissions` first and auto-start only when granted; otherwise a neutral clickable "MIDI" pill that requests on click, in `--text-mut` rather than `--rec`; record and render the output failure state with a retry.
  - Status: fixed (8414591)
- **MX-18 · P2 · `src/ui/export-panel.js:51`, `:349-350`, `:417-420`; `src/export.js:241-247`, `:252`, `:338-352`, `:394-411`, `:534-541`** — Export memory and main-thread cost scale with duration and are retained: length is bounded only by 128 cycles (256 s at `setcpm(30)`, 96 kHz ≈ 197 MB AudioBuffer + 98 MB WAV + 98 MB Blob, ~300 MB retained until reload); encoding, stats and waveform are three per-sample passes on the main thread; scheduling awaits per hap with no yield, so progress sits at 0%. Fix: drop the buffer after drawing and keep one Blob (PN-21), show estimated duration/size and warn above a threshold, yield every N haps; move encoding to a Worker (deferred, §6).
  - Status: deferred — Worker-based WAV encode; see §6
- **MX-19 · P3 · `src/export.js:243`, `:258-260`, `:326-330`, `:485-486`; `src/ui/export-panel.js:77`, `:377-382`, `:529-533`, `:580-582`** — Export quality and lifecycle nits: length is exactly `cycles / cps`, so reverb/delay/release tails are cut; samples are hard-clamped and a peak above 0 dBFS shows as a positive number with no warning (see UX-14); the object URL is revoked synchronously after `click()` (plausible lost download in Safari); visuals are left running (RD-2); no cancel; 16-bit only with no dither. Fix: a "+ tail seconds" option, a clip warning and optional normalise, revoke on a timeout.
  - Status: partly fixed (e3066de) — done: clipping flagged, the download URL is revoked after the click lands, visuals no longer run during export (7e42564); not done: tail seconds, cancel, dither/normalise
- **MX-20 · P3 · `src/midi-bridge.js:753-762`, `:819-825`, `:845-868`, `:905-907`; `src/ui/midi-bar.js:605-616`** — Bridge state goes stale: "MIDI needs audio" and "MIDI preset unavailable" are never cleared; the warn-once guard is inverted so the first note with a missing sound returns but every later one falls through to a throwing `superdough` call; pedal and mod-wheel state survive a disconnect (a pedal held during unplug leaves 3× durations on); when the selected input disappears the bridge silently falls back to "all devices". Fix: split the guard so a missing sound always returns; reset state on disconnect; re-announce the pill.
  - Status: fixed (8414591)
- **MX-21 · P3 · `src/capture.js:93-121`, `:154-156`, `:215-222`, `:250`; `src/midi-bridge.js:665-693`, `:929`** — Capture modal and metronome rough edges: Escape or a backdrop click discards the take with no confirmation; no focus trap or focus restore; save errors other than quota return silently and a rejected dev `fetch` is unhandled; the metronome is a `setInterval` scheduling at "now + 10 ms" (jitter, background throttling) yet its BPM is the quantisation grid, and it silently never starts if the context is not running; the capture buffer is unbounded. Fix: schedule clicks ahead on the audio clock, surface save errors, reuse the modal's focus handling.
  - Status: partly fixed (7399af5) — done: two-press Escape, backdrop click no longer discards, save failures reported, playback stopped on every exit; not done: metronome still a `setInterval` (not scheduled on the audio clock), capture buffer still unbounded
- **MX-22 · P3 · `src/ui/midi-import-dialog.js:233`, `:314`, `:504-511`; `src/midi-to-strudel.js:755-758`; `src/ui/setup-panel.js:129`, `:201-202`, `:246-272`; `src/ui/midi-bar.js:168`** — Import dialog and setup details: track rows look up analysis by name, so two same-named tracks show the first one's sound and the second can pick up a wrong override; empty or garbage files show `Invalid MIDI file: undefined`; chords are truncated to six notes without warning; the OSC test leaves its socket open on timeout and keeps saying "Connected"; the OSC section and output selector appear only after a reload; sample-import failure uses `alert()`. Fix: match on `originalIndex`; `err?.message ?? "not a Standard MIDI File"`.
  - Status: fixed (aa4ad7b)

Not applicable or clean: there is no on-screen or computer-keyboard piano
(the mini keyboard is display-only), so stuck-note classes do not exist;
`statechange` re-wiring does not duplicate listeners; no device polling;
unsupported/denied states produce a clear pill message; export
restore-after-throw is sound once the context swap has happened.

### 4.7 Strudel coverage (SC)

Baseline facts: all installed `@strudel/*` packages are the latest on npm
(published 2026-01), one instance of each. Upstream `main` carries about
ten months of unreleased work (`@strudel/edo`, `onSchedule`, `cycleStruct`,
`flux`/`juxFlip`, `stackCenter`, …) that cannot be supported locally.
strasbeat's `evalScope` (`src/boot.js:51`) loads controls, core, draw,
mini, tonal, webaudio, the slider module and `strudel-ext`; xen, midi, osc,
csound, serial, VCSL and wavetables are opt-in. The upstream REPL loads all
of those plus hydra, soundfonts, gamepad, motion, mqtt and mondo by
default. The `/strudel-cc` proxy matches between dev and production and is
now redundant (the upstream hosts send `access-control-allow-origin: *`).

- **SC-1 · P1 · `src/boot.js:92-101`; upstream `website/src/repl/prebake.mjs:25`, `piano.mjs`** — `s("piano")` (Salamander samples) and `.piano()` are missing: boot loads only dirt-samples, tidal-drum-machines and uzu-drumkit. One of the most common sounds in strudel.cc material is silent with "Sound not found", `.piano()` throws, and ten examples in the app's own docs index (so "Try example") are silent. Fix: add `samples('https://strudel.b-cdn.net/piano.json', 'https://strudel.b-cdn.net/piano/')` to boot phase 3 and define `.piano()` in `src/strudel-ext/`.
  - Status: fixed (5daf860)
- **SC-2 · P1 · `src/boot.js:92-101`; upstream `prebake.mjs:152-158`, `superdough.mjs:86-132`** *(= TR-17)* — `aliasBank` is never called, so `.bank("tr909")`, `"tr808"`, `"linn"`, `"dmx"` and the other short names are silent; only long names (`RolandTR909`) resolve. The upstream REPL's own default pattern is silent here, as are 15 entries in the docs index. Fix: after the drum-machine map loads (the alias pass walks the existing map), call `aliasBank` on the 1.7 kB `tidal-drum-machines-alias.json` with a timeout; teach `completions/bank-detect.js` the aliases.
  - Status: fixed (5daf860)
- **SC-3 · P1 · `src/main.js:335`; upstream `packages/draw/draw.mjs`, `codemirror.mjs`** — The custom `onDraw` replaces `StrudelMirror.draw` and ignores its third `painters` argument, so `.punchcard()`, `.spiral()`, `.pitchwheel()`, `.wordfall()`, their inline `._x()` forms and user `.onPaint(fn)` draw nothing, silently; `bottomModes.setCustomDraw`, meant for this, is never called. `.pianoroll()`, `.scope()` and `.spectrum()` are unaffected. Fix: accept `painters` in `onDraw` and call each with `getDrawContext()` (or the roll canvas), as upstream does.
  - Status: fixed (0ae6dd7) — `.punchcard()`, `.spiral()`, `.wordfall()` and `.onPaint()` draw into the bottom panel under a "Custom" mode, inline widgets run every frame; `.pitchwheel()` still draws on Strudel's full-page canvas (SC-12)
- **SC-4 · P2 · `src/` (no call sites); upstream `useReplContext.jsx` `resetEditor()`** — No global state reset when switching patterns: a pasted snippet with no `setcpm` assumes 0.5 cps but inherits the tempo, custom voicings and default control values of whatever was evaluated before. Fix: on opening or switching to a different pattern (not on re-eval), call `editor.repl.setCps(0.5)`, `resetDefaults()` and `resetVoicings()`.
  - Status: deferred — implemented, then withdrawn after review (it ran before the new tab's code and could rewind a newer tab's tempo); see §6 for the design a correct version needs
- **SC-5 · P2 · `src/user-setup.js:112-122`, `:169-178`; upstream `prebake.mjs:26-41`** — Wavetables (`wt_*`) and VCSL are opt-in and off by default, and mridangam is absent, so `s("wt_digital")`, `kalimba`, `gong`, `mridangam_*` are silent on paste with a generic warning. The VCSL toggle is labelled "~60MB download", but `samples()` fetches only the manifest (184 kB; wavetables 1 kB; mridangam 5 kB) and audio loads lazily. Fix: load all three manifests at boot like upstream (~190 kB JSON) and drop the two toggles, or keep them and make the warning name the toggle.
  - Status: fixed (5daf860)
- **SC-6 · P2 · `src/editor/error-marks.js:317-326`; `src/eval-feedback.js` (`handleEvalError`)** — With default settings `.midi()`, `.osc()`, `.csound()`, `loadOrc`, `midin`, `midikeys`, `tune`, `xen`, `edo`, `.serial()` are undefined and fail as a raw `x is not a function`, with no hint that a package must be enabled. Fix: map the known names to a hint naming the package and where to enable it; consider loading xen by default.
  - Status: fixed (2cd0a41)
- **SC-7** — alias of **MX-5** (MIDI output device selector does nothing).
  - Status: fixed (c61db47) (see MX-5)
- **SC-8 · P2 · `scripts/build-strudel-docs.mjs:18`, `:22`, `:37`; `src/editor/strudel-docs.json`; `completions/providers/functions.js:54`** — The docs/autocomplete index is stale and lossy. (a) The generator reads the upstream `main` clone rather than installed packages, so the JSON (564 entries) already contains 11 names not callable in 1.2.6 (`i fme datt bb pwr pws delays distortion clearScope setDefaultJoin readInputs`) and a malformed key; regenerating from the freshly pulled clone would add 19 more unreleased names. (b) Seven arrange internals leak into autocomplete (ED-11). (c) The JSDoc regex drops 43 documented names, including `seq`, `fastcat`, `stepcat`, `ply`, `pick*`, `slider`, `midi`, `osc`. (d) The scan omits codemirror, midi, osc, csound, xen and soundfonts. Fix: scan `node_modules/@strudel/*` and `superdough` (ran: 541 entries with the current script, 568 with a tolerant regex), fix the regex, add the opt-in packages, mark internals `@noAutocomplete`, filter against live exports and `Pattern.prototype`. Do not regenerate from the upstream clone as-is. See §7.
  - Status: fixed (c729580)
- **SC-9 · P2 · `src/ui/setup-panel.js:99-125`; `src/user-setup.js:261`** — User-sample import accepts only a manifest URL via plain `fetch` (so `github:user/repo` fails) and re-registers with `samples(bank.sampleMap)` with no base URL, so a manifest with relative paths and no `_base` 404s against strasbeat's origin; nothing registers until reload; there is no local-folder import. Fix: call `samples(url)` directly and persist `{url}`; add a folder picker storing blobs in IndexedDB as upstream does. Deferred — see §6; related PN-13.
  - Status: deferred — folder sample import is a feature; see §6
- **SC-10 · P2 · `src/boot.js:49`; `src/eval-feedback.js:279-292`; upstream `superdough.mjs:310`** — Audio init ordering differs from upstream: `initAudioOnFirstClick()` is called with no options and its promise discarded, and the listener is `mousedown`-only. If the first gesture is Cmd/Ctrl+Enter, `initAudio()` (worklet loading) never ran; if it is a click on Play, eval races worklet loading, so worklet-backed sounds may error on first play (plausible). Fix: keep the promise and await an idempotent `initAudio()` in the patched evaluate. Related: MX-16.
  - Status: fixed (2cd0a41)
- **SC-11 · P2 · `src/ui/settings-panel.js`; `src/main.js:326`; `src/export.js:185`** — No audio settings: output device, multi-channel orbits, max polyphony and a SuperDirt engine target are all missing, so there is no way to route to an audio interface or use more than two channels. Fix: an Audio section using `getAudioDevices()` and `initAudio` options. Deferred — see §6.
  - Status: deferred — an Audio settings section is a feature; see §6
- **SC-12 · P2 · upstream `packages/draw/draw.mjs` `getDrawContext()`; `src/strudel-ext/hydra.js:514`** — Full-page draws (`.pianoroll()`, `.scope()`, `.tscope()`, `.fscope()`, `.spectrum()`) render into an unmanaged `#test-canvas` prepended to `<body>` at `position:fixed`, with no clip or mode treatment, so they smear across the app chrome (plausible; layering reasoned from CSS). Fix: create and manage that canvas like `#hydra-canvas`, or default `ctx` to a bottom-panel canvas. Deferred — see §6.
  - Status: deferred — `.pianoroll()`, `.scope()` and `.pitchwheel()` still draw on Strudel's unmanaged full-page canvas; see §6
- **SC-13 · P3 · `src/boot.js:9`** — `slider()` is imported from the package's source file while `StrudelMirror` comes from the dist bundle, which has its own copy: two value stores and two message listeners, so every slider drag logs `slider with id "slider_N" is not registered`. Fix: import `sliderWithID` and `slider` from `@strudel/codemirror` (the dist entry exports both). See BD-1 hazard.
  - Status: fixed (5daf860)
- **SC-14 · P3 · `src/user-setup.js` (`OPT_IN_PACKAGES`); upstream `util.mjs:77-109`** — Packages not wired at all: gamepad, motion (48 signal names), mqtt, mondo, and the soundfonts module's globals (`loadSoundfont`, `setSoundfontUrl`, `soundfontList`); `` tidal`…` `` is rewritten to a call that does not exist. `loadSoundfont('…sf2')` is the most likely paste to hit this. Fix: add soundfonts to `evalScope` now; add the other four as opt-in rows; skip tidal/edo/dough until released. Deferred in part — see §6.
  - Status: partly fixed (5daf860) — the soundfont globals (`loadSoundfont`, `setSoundfontUrl`, `soundfontList`) are in scope; gamepad, motion, mqtt and mondo are not wired (new dependencies, see §6)
- **SC-15 · P3 · `src/ui/transport.js:22`, `:184`** — The BPM readout is `cps × 60 × 4`: right for `setcpm(bpm/4)`, wrong for `setcpm(90)`-style or 3/4 and 6/8 patterns (`setcpm(90)` shows 360 bpm). Fix: show cpm alongside, or parse the `setcpm(x/y)` denominator.
  - Status: deferred — the readout still assumes 4 beats per cycle; recommended: show cpm beside bpm (§6)
- **SC-16 · P3 · `src/eval-feedback.js:157-236`** — Remaining validation false positives: `s("superpiano").osc()` / `.midi()` patterns whose names target SuperDirt or a MIDI map get "Sound not found"; the "no sound events in the first 4 cycles" warning fires for visuals-only buffers, sample-loading-only buffers and intros longer than 4 cycles. Fix: skip the unknown-sound check for haps with a dominant `.osc()`/`.midi()` trigger, exempt `initHydra`/`shader(`, widen the window. Overlaps TR-20.
  - Status: fixed (2cd0a41)
- **SC-17 · P3 · `src/` (no call sites); upstream `util.mjs` `setVersionDefaultsFrom`** — `// @version` metadata is ignored, so old shared patterns relying on legacy defaults sound slightly different. Fix: parse `@version` in the patched evaluate and call `setVersionDefaults`.
  - Status: deferred — shared the tab-switch reset path with SC-4 and was withdrawn with it; see §6
- **SC-18 · P3 · `src/ui/piano-roll.js`; `src/strudel-ext/hydra.js:511-523`** — The piano roll colours per layer and never reads `hap.value.color`, so `.color("cyan magenta")` has no effect there; Hydra's `feedStrudel` is accepted but documented as not producing useful output. Fix: honour `value.color` when present; finish `feedStrudel` together with SC-12.
  - Status: partly fixed (0ae6dd7) — the piano roll honours `hap.value.color`; Hydra's `feedStrudel` is not done (with SC-12)
- **SC-19 · P3 · `STRUDEL.md:453-466`** — MIDI-in, csound, xen, serial, `slider()` and the inline widgets are undocumented (only `.midi()` and `.osc()` are covered) and have no docs-index entries (SC-8d). Fix: a short "Inputs, outputs and inline widgets" section once SC-6 and SC-8 land.
  - Status: fixed (28f2bda)
- **SC-20** — alias of **ED-8** (mini-location highlights bleed into a non-playing tab).
  - Status: deferred — slider widgets and highlight bleed on tab switch need per-tab `{miniLocations, widgets}` storage; not attempted in Batch 1 (see ED-8)

Pastes from strudel.cc that fail today (regression checklist):

| # | Snippet | What happens | Finding | After |
|---|---|---|---|---|
| 1 | `$: s("[bd <hh oh>]*2").bank("tr909").dec(.4)` | Silent; `Sound "tr909_bd" not found` | SC-2 | Plays: `tr909_bd` is registered (runner) — 5daf860 |
| 2 | `note("c e g b").s("piano")` | Silent; sound not found | SC-1 | `piano` is registered (runner) — 5daf860; not heard |
| 3 | `note("<c2 a1>").piano()` | `TypeError: .piano is not a function` | SC-1 | `.piano()` is defined (5daf860); not run in a browser |
| 4 | `s("bd*2, hh*4").punchcard()` | Plays, nothing drawn | SC-3 | Draws in the bottom panel's Custom mode (runner) — 0ae6dd7 |
| 5 | `note("c a f e").spiral()` / `._punchcard()` / `.pitchwheel()` | Plays, empty canvas | SC-3 | `.spiral()` and `._punchcard()` draw (0ae6dd7; not run in a browser); `.pitchwheel()` still draws on Strudel's full-page canvas (SC-12) |
| 6 | `s("bd sd").onPaint((ctx, time, haps) => …)` | Painter never called | SC-3 | Painter is called and draws in Custom mode (0ae6dd7; unit-tested, not run in a browser) |
| 7 | `note("c e g").s("wt_digital")` | Silent unless Wavetables enabled + reload | SC-5 | Registered by default (5daf860); not run in a browser |
| 8 | `s("kalimba")`, `s("gong")`, `s("mridangam_gumki")` | Silent | SC-5 | Registered by default (5daf860); not run in a browser |
| 9 | `note("c a f e").midi()` | `midi is not a function` unless enabled + reload | SC-6 | Unchanged, but the error now names the package to enable (2cd0a41) |
| 10 | `const cc = await midin('IAC'); …` | `midin is not defined` | SC-6 | Unchanged, but the error now names the package to enable (2cd0a41) |
| 11 | `s("superpiano").note("c e g").osc()` | not a function; with OSC on, spurious "Sound not found" | SC-6, SC-16 | Hint as above; no spurious "Sound not found" (2cd0a41) |
| 12 | `await loadOrc('github:…'); note("c e").csound('FM1')` | `loadOrc is not defined` | SC-6 | Unchanged, but the error now names the package to enable (2cd0a41) |
| 13 | `note("0 2 4").tune("hexany15")` | not a function unless xen enabled | SC-6 | Unchanged, but the error now names the package to enable (2cd0a41) |
| 14 | `loadSoundfont('https://…/x.sf2')` | `loadSoundfont is not defined` | SC-14 | `loadSoundfont` is in scope (5daf860); not run in a browser |
| 15 | `` mondo`s [bd sd]` `` / `` tidal`s "bd sd"` `` | not defined | SC-14 | Unchanged (SC-14 rest, deferred) |
| 16 | `s("bd sd")` after a demo with `setcps(70/60/4)` | Plays at the previous tempo | SC-4 | Unchanged (SC-4 deferred); documented in `STRUDEL.md` as a known difference |
| 17 | `s("sawtooth").note("c2").pianoroll()` / `.scope()` | Draws on an unmanaged full-viewport canvas | SC-12 | Unchanged (SC-12 deferred) |
| 18 | `setcpm(90); s("bd sd")` | Plays correctly; transport shows 360 bpm | SC-15 | Unchanged (SC-15 deferred) |
| 19 | `await initHydra(); osc(10).out()` | Works, but warns "produced no sound events" | SC-16 | No warning for a visuals-only buffer (2cd0a41) |
| 20 | Unreleased API (`.cycleStruct()`, `.flux()`, `edoScale()`, …) | not a function | upstream release lag; keep out of docs (SC-8) | Unchanged by design; the docs index no longer lists them (c729580) |

Already working (verified by reading): `$:` blocks, `_`/`S` mute and solo,
`all()`, `each()`, `hush()`, `setcpm`/`setcps`; in-pattern `samples(...)`
including `github:`, `shabda:`, `bubo:`, `local:`; mini-notation
highlighting, flash, `.markcss()`, `.color()` on highlights; `slider()` and
the `.draw()`-based inline widgets; synths, soundfonts, full dirt-samples,
tidal-drum-machines long names, uzu-drumkit; all 39 upstream themes and the
editor settings.

### 4.8 UX and accessibility (UX)

Run against the dev server in headless Chromium with axe-core; dark theme
only (no light theme exists); refinement, not redesign. Entries marked
*code* come from reading rather than observation.

Measured contrast (rendered tokens, sRGB):

| Pair | Ratio on surface-0 / 1 / 2 / 3 | AA (4.5 text, 3.0 non-text) | After |
|---|---|---|---|
| `--text` #f2f2f2 | 17.4 / 16.2 / 14.7 / 13.0 | pass | — |
| `--text-mut` #8f8f8f | 6.0 / 5.6 / 5.1 / 4.5 | pass (borderline on surface-3) | 8.42 / 7.85 / 7.13 / 6.33 (9d5751a, lightness only) |
| **`--text-dim` #555555** | **2.61 / 2.43 / 2.21 / 1.95** | **fail** | 5.33 / 4.97 / 4.52 / 4.01 (9d5751a, lightness only) — passes 4.5 on surface-0 to 2, 4.01 on surface-3 |
| `--accent` #dd4a89 | 5.0 / 4.7 / 4.25 / 3.75 | text fails on surface-2/3 | — |
| `--accent-hi` #fa5d9e | 6.6 / 6.1 / 5.6 / 4.9 | pass | — |
| `--rec` #f94144 | 5.4 / 5.1 / 4.6 / 4.1 | fails on surface-3 | — |
| `--border` #2e2e2e | 1.43 / 1.33 / 1.21 / – | fails 3:1 where it is an input's only boundary | — |
| Editor parentheses #525154 on #1d1d1d | 2.14 | fail | — |
| Editor line numbers #555 on #0d0d0d | 2.61 | fail | — |
| `.export-panel__input` placeholder | 2.21 | fail | — |

The After values for the two text tokens are computed from the new token
values and guarded by a test; the other pairs were not changed or not
re-measured. axe-core was not re-run, so the After column of the next
table is empty: the tree, tablist and grid roles behind several rows were
rewritten (UX-5, UX-13, UX-10) and the landmark and heading rows addressed
(UX-25), but that is by code and the runner's landmark checks, not by axe.

axe-core violations, deduplicated across states:

| Rule | Impact | Where | After |
|---|---|---|---|
| `aria-required-children` | critical | `.left-rail__list`, `.sound-browser__list`, `.beat-grid` and every lane (17 nodes) | — |
| `aria-required-parent` | critical | 96 beat-grid cells; `.console-panel__entry` | — |
| `aria-hidden-focus` | serious | 19 × `.left-rail__item-meta` wrapping a focusable button | — |
| `nested-interactive` | serious | 20 × `.left-rail__item`; 19 × `.reference-panel__entry` | — |
| `aria-input-field-name` | serious | `.left-rail__list`, `.learn-panel__list`, `.cm-content` | — |
| `color-contrast` | serious | 22–25 nodes per state, all `--text-dim` | — |
| `scrollable-region-focusable` | serious | `.cm-scroller` | — |
| `target-size` | serious | `.tab-strip__close` 18×18; beat-grid Mute/Solo 20×20 | — |
| `landmark-unique` | moderate | `#left-rail` and `#right-rail` are both unlabelled `<aside>` | — |
| `region` | moderate | `#roll`, `.track-bar`, `.bottom-panel__modes`, `#test-canvas` | — |
| `page-has-heading-one` | moderate | no `<h1>` | — |

- **UX-1 · P0 · `src/styles/shell.css:28-60`; `src/styles/transport.css:673-717`** — The shell grid has no width breakpoint for the rails. At 390×844 the columns compute to `240px 0px 356px`: the editor has zero width, the top bar and transport are 596 px wide, and a shared link opened on a phone shows the Learn panel and no code. At 768×1024 the editor is 172 px wide; at 720×450 (≈200% zoom) 124×170 px, failing WCAG 1.4.10 and 1.4.4; at ≤720 px the status line is hidden, so all feedback disappears. Fix: below ~900 px default both rails to collapsed and make an expanded rail an overlay with a scrim; clamp the grid tracks with `min()`/`minmax()`; icon-only top bar and ellipsised pattern name at ≤600 px; cap `--roll-h` at `min(180px, 30dvh)`; keep a one-line status.
  - Status: fixed (528b280)
- **UX-2** — alias of **PN-7** (command palette does not trap focus).
  - Status: fixed (3962448) (see PN-7)
- **UX-3 · P1 · `src/styles/tokens.css:19`; 148 `var(--text-dim)` uses, notably `transport.css:380`, `:482`, `left-rail.css:30`, `bottom-panel.css:136`, `tab-strip.css:171`** — `--text-dim` is 2.0–2.6:1 everywhere and carries real information: the transport status line (the app's only feedback channel) is 11 px at 2.43:1, and mode labels, BPM/position labels and section headers are 9–10 px at ~2.2:1. Fix: raise the token to about `oklch(0.60 0 0)` (≈4.6:1 on surface-1) or keep it for decorative glyphs and move text to `--text-mut`; the status line becomes `--text-mut` either way; raise the editor bracket colour to ≥4.5:1; fix the export placeholder.
  - Status: fixed (9d5751a) — `--text-dim` and `--text-mut` raised (lightness only), guarded by a test; the editor bracket colour comes from the Strudel theme and is unchanged (§6)
- **UX-4** — alias of **TR-20** (unknown sound, silent pattern and `progression("…")` misuse give no visible feedback).
  - Status: fixed (2cd0a41) (see TR-20)
- **UX-5 · P1 · `src/ui/left-rail.js:448`, `:610-611`, `:824-825`, `:867`** — The patterns library is an unnamed `listbox` containing `role=button` folder headers; rows are `option tabindex=-1` (reachable only by ArrowDown from search) while each row's `aria-hidden` meta wrapper contains a focusable "Pattern options" button — nineteen consecutive identical Tab stops that do not say which pattern. The dirty dot is title-only; the context menu has no menu roles and does not take focus. Fix: `role=tree` with one roving tab stop, labelled "Patterns"; un-hide the meta wrapper; the more-button gets `tabindex=-1`, `aria-label="Options for <name>"` and Shift+F10; `role=menu` with focus in and out; ", modified" in the accessible name.
  - Status: fixed (d3fc79b)
- **UX-6 · P1 · `src/styles/left-rail.css:378-382`** — The collapsed left rail hides its search and list with `opacity: 0; pointer-events: none`, leaving ~21 invisible controls in the tab order and accessibility tree (WCAG 2.4.7, 2.4.3). Fix: add `visibility: hidden` (transitioned with a delay so the fade still plays) or set `inert`.
  - Status: fixed (d3fc79b)
- **UX-7 · P1 · `index.html:234-241`; `src/editor/error-marks.js`; `src/eval-feedback.js` (`handleEvalError`)** — Errors are not announced: during syntax and runtime errors the polite `#status` region does not change, no `role=alert` exists, and the error pill is not a live region; the inline widget's ✕ sits inside the CodeMirror content and cannot be reached by keyboard; Play/Stop has no `aria-pressed`. Fix: set the status to `Error on line N: <message>` on failure and `Updated` on success; bind Escape to dismiss the widget; make the pill a button that jumps to the error line.
  - Status: fixed (2cd0a41)
- **UX-8** — alias of **MX-17** (MIDI permission requested on first load, then a red "MIDI blocked" pill).
  - Status: fixed (8414591) (see MX-17)
- **UX-9 · P1 · `src/main.js:1145-1150`; `index.html:173-179`** — Closing the last tab shows "Nothing open." but the buffer is not cleared: clicking Play plays the pattern that was just closed, while the top bar says `untitled`. Focus drops to `<body>` and the visible overlay stays `aria-hidden="true"`. Fix: in the empty state disable Play, Share and WAV, stop playback if nothing else is playing, flip `aria-hidden`, and move focus to the library search.
  - Status: fixed (2cd0a41)
- **UX-10 · P2 · `src/ui/beat-grid.js`; `src/styles/beat-grid.css`** — The beat grid's ARIA is invalid (`row` lanes containing a `rowgroup`, `gridcell` buttons, no `grid` ancestor) and no cell has `tabindex=0` at render (0 of 96), so Tab reaches only the lane controls; Mute/Solo are 20×20. Fix: `role=grid` on the container, lanes as rows of `rowheader` + `gridcell`, drop `rowgroup`, give the first or last-focused cell `tabindex=0`, add `aria-pressed`.
  - Status: fixed (1f34df6)
- **UX-11 · P2 · `index.html:309-316`; `src/ui/piano-roll.js:499-504`; `src/ui/bottom-panel-modes.js`** — Roll and scope show stale content: switching tabs while stopped leaves the previous pattern's notes (the track bar has already updated), and selecting Scope while stopped keeps the roll's last frame. Click-to-locate has no keyboard path; gutter labels are drawn at 8 px and long names are clipped on the left; the mode switcher and state pill float over notes. Fix: redraw the static preview on tab activate (RD-10), clear on mode change with a "Press play to see the scope" empty state, reserve a 28 px header row, right-align and ellipsise labels with a 10 px floor.
  - Status: partly fixed (0ae6dd7) — the stale-roll part, to the extent of RD-10; the scope's stopped empty state was not added, and the label / header layout items were not re-checked
- **UX-12 · P2 · `src/ui/learn-panel.js:175-178`; `src/ui/right-rail.js:128-134`; `src/main.js:1436-1450`** — Focus management: initial focus after load is the Learn search field, so the Tab order starts mid-page and reaches the editor at stop 48; Cmd+B with focus in the rail drops focus to `<body>` (PN-20); a collapsed rail keeps one tab `aria-selected="true"`; the gear toggles Settings with no `aria-expanded`; the tabpanel has no `aria-labelledby`; the three tablists have no arrow keys; nothing documents "Esc then Tab" to leave the editor and there is no skip link. Fix: focus the editor at boot and a panel's search only on user activation; return focus on collapse; correct the ARIA; roving tabindex; a visually hidden "Skip to editor" link.
  - Status: fixed (371797d, 8b01c29, afd8452) — the skip link in the last
- **UX-13 · P2 · `src/ui/tab-strip.js:142-146`; `src/styles/tab-strip.css:160-168`** — Pattern tabs: each `div role=tab tabindex=0` contains a real `<button>` (nested interactive; 12 tabs = 24 Tab stops), no `aria-controls`, the dirty dot is title-only, the close target is 18×18, an overflowing strip cuts the first tab mid-word with no scroll affordance, and truncated names have no tooltip. Fix: roving tabindex with Left/Right/Home/End, take × out of the tab order (Delete already closes), "modified" in the accessible name, a 24×24 hit area, a `title` with the full path. Related: PS-15.
  - Status: fixed (589bfa8)
- **UX-14 · P2 · `src/ui/export-panel.js:372-381`, `:596-605`; `src/styles/export.css:345-352`** — After a successful export the waveform canvas backing store is 1×64 (measured while the result section is still hidden), so the preview is an empty rectangle. The stock Hello pattern reports `Peak: 6.0 dB` — above full scale, so the WAV is clipped — with no warning. The progress bar has no `progressbar` role and the result is not a live region. Fix: un-hide before measuring or size from a ResizeObserver; show `Peak: +6.0 dB — clipped` in `--rec` with a hint; add the roles.
  - Status: fixed (8b01c29)
- **UX-15 · P2 · `src/styles/base.css:39`; `command-palette.css:117`; `midi-bar.css:333-336`; `midi-import.css:277`; `index.html:66`** *(code)* — Drift against `design/SYSTEM.md`: `::selection` and the selected palette row hard-code the default accent, so a custom accent hue leaves them rose; 36 raw font sizes below the 11 px floor (10 px ×23, 9 px ×13); rendered weights 550 and 650; the editor renders 18 px / 500 against the spec's 15 px / 400; stray radii; six native `<select>`s and native range inputs against "no native dropdowns"; `theme-color` #1c1c1c vs the rendered #161616. Fix: `color-mix(in oklch, var(--accent) 35%, transparent)` for the two literals; either add a `--text-2xs` step or lift everything to 11 px; settle the editor default in the spec; reuse the keymap-chip popover as the select replacement.
  - Status: partly fixed (9d5751a) — the shell's stylesheets (accent literals, sub-11 px labels); remaining: font sizes in the panel stylesheets, native selects and range inputs, `theme-color`
- **UX-16 · P2 · `src/ui/learn-panel.js`; `src/styles/learn.css`; `src/styles/base.css`** — Learn-panel code samples render in Courier: the `<pre>` has `--font-mono` but the inner `<code>` falls to the browser's `monospace`. Fix: `code, kbd, samp, pre { font-family: var(--font-mono); }` and `button, input, select, textarea { font: inherit; }` in `base.css`.
  - Status: fixed (8b01c29)
- **UX-17 · P2 · `src/ui/midi-bar.js:344`; `src/ui/icons.js`** — The metronome button uses the unregistered icon `timer`: it renders as an empty 24×24 box and logs a warning on every load. Fix: register Lucide `timer` (or `metronome`).
  - Status: fixed (8b01c29)
- **UX-18 · P2 · `src/ui/midi-bar.js:158-350`** — MIDI bar semantics (observed with a stubbed device): the velocity-curve buttons have no `aria-pressed` or radiogroup; sustain and mod indicators are bare `div`s with a title; the preset popover is a `listbox` that also contains a text input, headers and three sliders; the volume slider's hit box is 64×4 px; the popover overlaps the status pill. Fix: `radiogroup` + `aria-checked`; `role=dialog` on the popover with the listbox scoped to the preset list; ≥24 px slider hit height.
  - Status: fixed (8414591)
- **UX-19 · P2 · `src/ui/command-palette.js`; `src/ui/keymap-chip.js`** — Shortcut discoverability and conflicts: the palette's own shortcut (⌘⇧P) appears nowhere in the UI; 19 of 35 commands have no shortcut (tab navigation, Open Console, Copy Share Link, …); macOS mixes `⌘↵` with `Ctrl+.`; keymap popover descriptions are hard-coded per platform. Known browser behaviour, not observed: ⌘M is macOS Minimise and cannot be intercepted, ⌘⇧P and ⌘⇧K are taken in Firefox. Fix: render `⌃.` on macOS, generate descriptions through `keymap-chip-format.js`, rebind mute (`⌥M`), add `F1` for the palette and a small kbd hint in the top bar, bind tab navigation.
  - Status: partly fixed (afd8452) — the palette shortcut is shown in the keymap chip's tooltip and popover; the palette and the Stop tooltip still say `Ctrl+.` on macOS, and no shortcuts were rebound or added
- **UX-20 · P2 · `src/eval-feedback.js:410`; `src/styles/transport.css:372-380`** — After the first play the status reads `playing · 7 instruments ready` for the rest of the session — through re-evals to a one-instrument pattern, syntax errors and the empty state; it is capped at `28ch` with no `title`. Fix: revert to a short transient `playing` after warm-up, recompute or drop the count on re-eval, set `title`, and use the line for the error summary (UX-7). Related: TR-12.
  - Status: fixed (2cd0a41)
- **UX-21 · P2 · `src/styles/transport.css:730-742`** — Small pointer targets: tab close 18×18, rail more-button 20×20, MIDI octave buttons 20×20, velocity buttons 18 px tall, mode buttons 20 px tall, track entries and keymap chip 22 px, beat-grid M/S 20×20; the coarse-pointer rule enlarges only Play and the roll toggle. Fix: a 24 px minimum box everywhere via padding; extend the coarse-pointer hit-area rule to icon buttons, track entries, mode buttons, rail tabs and list rows (40–44 px).
  - Status: fixed (528b280)
- **UX-22 · P2 · `src/styles/transport.css:510-514`; 31 `outline: none` declarations in `src/styles/`** — Focus indicators are inconsistent: most controls get a clear 2 px accent outline, but the keymap chip uses a 12%-alpha ring (effectively invisible), search inputs change only a 1 px border (~2.3:1, estimated), the Learn list falls back to the browser outline, and the editor container has none. Fix: one shared `:focus-visible` rule and delete the per-component overrides unless an equivalent ≥3:1 ring replaces them.
  - Status: fixed (9d5751a) — one `--focus-ring` outline; the accent picker's lightness slider can still weaken it (§6)
- **UX-23 · P2 · `src/ui/reference-panel.js`** — The reference panel shows raw Markdown/JSDoc: `lpf` reads "`**l**ow-**p**ass **f**ilter`" with literal asterisks in both the preview and the expanded doc; previews are JS-truncated with `...` and no tooltip. Fix: strip or render inline Markdown (`**`, backticks, `{@link}`) at build or render time; truncate with CSS.
  - Status: fixed (8b01c29)
- **UX-24 · P2 · `src/styles/shell.css:82`, `:92-103`; `learn.css:448`; `beat-grid.css:344`** — No `prefers-contrast` or `forced-colors` handling (colour-only state will flatten in Windows High Contrast), and reduced-motion is partial: under `reducedMotion: reduce` the shell still transitions and several keyframe animations have no guard. Fix: one global reduced-motion block in `base.css`; `forced-colors` rules giving active/pressed states a `2px solid Highlight` border; a `prefers-contrast: more` override mapping `--text-dim → --text-mut` and a stronger border.
  - Status: fixed (9d5751a)
- **UX-25 · P2 · `index.html`; `src/ui/*-panel.js`** — Document structure: no headings outside Settings (seven `<h3>`, no `h1`/`h2`); two unlabelled asides; the roll section, track bar, MIDI bar and arrange bar are outside any landmark; `.cm-content` is an unnamed textbox; panel headers are inconsistent. Fix: a visually hidden `<h1>`; `aria-label` on the asides, roll section and transport; `aria-label="Pattern code editor"` via `EditorView.contentAttributes`; one shared panel header with an `<h2>` used as the tabpanel label.
  - Status: fixed (afd8452)
- **UX-26 · P3 · `src/ui/keymap-chip.js:208-241`** — The only first-run onboarding is a tooltip, "Click to change your editor keymap", which covers the MIDI pill and a Learn row and teaches the wrong first action. Fix: drop or defer it; if a hint is kept, anchor it to Play ("Press play — or ⌘↵ in the editor"). Note in Try's tooltip that it replaces the buffer.
  - Status: fixed (afd8452)
- **UX-27 · P3 · `src/editor/signature-hint.js`** — The signature pill covers code: with the cursor inside an unclosed `s(` on line 5 it sits on top of line 4's text. Fix: place it above the line containing the call's opening paren and never over text between the call and the cursor. Do together with ED-5.
  - Status: fixed (dc1d639)
- **UX-28 · P3 · `src/editor/error-marks.js`** — An unclosed `s("bd*4"` on line 3 reports `Unexpected token (5:0)` and highlights empty line 5. Fix: when the parser reports an unexpected token/EOF with non-zero bracket depth, append "— probably a missing `)` opened on line 3" using bracket matching.
  - Status: open — not attempted
- **UX-29 · P3 · `src/main.js` (`#pattern-menu`)** — The top-bar pattern button shows the file slug (`01-hello`) while tabs and library show the title ("Hello"), and its chevron implies a menu but clicking only focuses the library search. Fix: show the display title; swap the chevron for a search icon or open a quick-switcher.
  - Status: fixed (afd8452)
- **UX-30 · P3 · `src/styles/shell.css:49-59`, `:82`; `export.css:299`; `sound-browser.css:89`; `learn.css:448`; `midi-bar.css:546`** — Motion inconsistencies: the right rail snaps by design while the roll animates `grid-template-rows` (resizing the canvas for 200 ms); the left rail's width snaps while its content fades, briefly showing squeezed remnants (seen once, not reproduced); several off-token durations. Fix: hide rail content instantly on collapse (also solves UX-6), animate transform/opacity on the panel rather than the grid track or snap all three consistently, move stray durations onto the tokens. Related: RD-6.
  - Status: partly fixed (528b280) — the left rail no longer shows squeezed content while collapsing; the roll still animates its grid row and the off-token durations were not moved
- **UX-31 · P3 · `src/ui/beat-grid.js`; `src/styles/beat-grid.css`** — The beat grid is cramped in the default 180 px pane: 2.5 of 8 lanes visible and ~45 px reserved for the floating mode switcher. Fix: on switching to Beat grid, grow `--roll-h` to `min(lanes × 46 + header, --roll-max-h)` and restore on leaving.
  - Status: open — not attempted

Working well (keep): syntax and runtime errors are located, inline,
dismissible and cleared on edit; `modal.js` has a correct focus trap, focus
restore and inline validation; all icon-only buttons have accessible names;
library search keyboard flow; OS-aware shortcut labels on Play and the
palette; CSS is almost entirely token-driven with no z-index collisions;
Share gives immediate status feedback; the Learn panel's numbered workshops
with a `Try` button are a real play → hear → learn path.

### 4.9 Measurement-only findings (PF)

Found by the headless run and not covered by an audit ID. The source did
not assign severities.

- **PF-1 · unrated · `src/main.js` (`applyVisualsFullWindow`, `syncVisualsClip`)** — With full-window visuals ON, stop then play creates a fresh `#hydra-canvas` that never receives `.is-visuals-fullwindow` (the class is applied only at boot and on toggle; the clip sync handles only the clipped class), so the canvas is `display:none` while the Hydra loop ticks at 54 /s. Fix: re-apply the full-window state whenever the canvas is (re)created. Do with RD-4.
  - Status: fixed (7e42564)
- **PF-2 · unrated · `src/main.js:335` / upstream `@strudel/draw`** — The Strudel `Drawer` rAF costs 3–4 ms per frame for its own hap query even when nothing is drawn (148 ms/s in beats mode, where `onDraw` returns immediately). After RD-9 this is the floor for playing-state script cost; reducing it means narrowing `drawTime` or pausing the Drawer when no consumer needs haps (roll collapsed, beats mode, no shader uniforms).
  - Status: fixed (0ae6dd7) — the Drawer's window shrinks to the present moment when neither the roll nor a painter needs haps
- **PF-3 · unrated · evaluate → stop cycle** — Heap grows slowly but monotonically over 30 evaluate→stop cycles (12.66 → 13.25 MB, ≈15 kB/cycle) with DOM nodes, listeners and live AudioNodes flat. Below the flag threshold; needs a longer soak (300+ cycles) before calling it a leak.
  - Status: deferred — needs a 300+ cycle soak on the runner measurement rig (later performance lane)

### 4.10 Bundle and boot opportunities (BD)

IDs assigned here; reductions are entry-chunk raw / gzip kB from sourcemap
attribution. Items BD-1…4 together take the entry from ≈2800 / 747 to
≈1890 / ≈590 kB and remove ≈745 kB of `JSON.parse` and module evaluation
from the 1.3 s (8.5 s at 4×) pre-interactive long task.

| ID | Change | Entry raw | Entry gz | Risk | Status |
|---|---|---:|---:|---|---|
| BD-1 | Remove upstream `doc.json` from `@strudel/codemirror`: alias the package to its un-bundled sources and map `../../doc.json` to a virtual stub (or `pnpm patch`) | −539 | −72 | medium | fixed (a31117b) |
| BD-2 | Lazy-load `src/editor/strudel-docs.json` behind a `getDocs()` store; hover, signature and completions read it at call time | −205 | −38 | low–medium | fixed (d5b9794) |
| BD-3 | Create right-rail panels on demand (keep the console eager — it is the error sink; load Learn at idle since the rail boots on it) | −100 | −27 | medium | fixed (d5b9794) |
| BD-4 | Lazy MIDI import (`@tonejs/midi`, `midi-file`, `midi-to-strudel`, dialog); keep `getMidiFile` static | −70 | −20 | low | deferred — only ≈10 kB left now that the MIDI library is gone |
| BD-5 | Lazy vim/emacs keymaps (needs BD-1; must replay `Vim.defineEx` for `:w`/`:q` and await for a stored vim profile) | −143 | −40 | medium–high | fixed (a31117b) |
| BD-6 | Stub `source-map` in escodegen (safe while nobody passes `sourceMap` to `escodegen.generate`) | −30 | −8 | low–medium | fixed (a31117b) |
| BD-7 | `/assets/*` → `Cache-Control: public, max-age=31536000, immutable` in `vercel.json` (today hashed assets get `max-age=0, must-revalidate`); `s-maxage=86400, stale-while-revalidate=604800` for `/strudel-cc/(.*)` | 0 | 0 | none | fixed (a66759d) — `/assets/*` only; the `/strudel-cc` header is deferred (it could cache an upstream error for a day) |
| BD-8 | `manualChunks` vendor split (codemirror / strudel / audio) + `modulepreload`: parallel compile and cache stability | 0 | 0 | medium | deferred — a vendor chunk would evaluate before `storage-guard.js` and cycle with the top-level-await entry |
| BD-9 | Cache the three sample manifests (stale-while-revalidate) and do not block the first Play on them; boot-ready −1…4 s | 0 | 0 | medium | deferred — `samples()` fetches internally; see §6 for the design |
| BD-10 | Preload the two latin woff2 files via `transformIndexHtml` (removes the font swap and the editor re-flow) | 0 | 0 | none | fixed (afd8452) |

Hazards recorded for whoever implements these:

- **BD-1:** upstream autocomplete and tooltip are forced on by
  `editor-setup.js` (`STRASBEAT_REQUIRED_ON`) alongside strasbeat's own;
  first confirm whether the upstream ones still do anything (a latent
  double tooltip). Every import of the package must go through the same
  alias, or there will be two copies of module state — today `boot.js:9`
  already imports the slider module from source while everything else uses
  the dist (SC-13); the alias collapses that to one. Add the aliased entry
  to `optimizeDeps.include`. Upstream `Pattern.prototype` registrations
  must still run exactly once.
- **BD-3:** `registerPanels()` returns handles that `eval-feedback.js`,
  `debug.js`, hover-docs deep links, Cmd+J / Cmd+Shift+B and the WAV button
  call synchronously; wrap the non-console ones in async facades.
- **BD-8:** use the object form or an explicit allow-list — a function
  returning `"vendor"` for every `node_modules` id drags the lazy-only
  packages (csound 3.5 MB, xen 1.1 MB, prettier, hydra) into the initial
  graph. Strudel packages must stay singletons (a second `Pattern` class
  breaks `instanceof`/`register` silently). `main.js:270` has a top-level
  await; chunks that import from the entry wait on it and circular imports
  plus TLA can deadlock — move shared code into leaf chunks.
- **BD-9:** the first play of a sample-based pattern before its bank lands
  must be surfaced, not silent (the existing validation reports unknown
  sounds; see TR-18).
- Deferring the whole transpiler stack (−236 kB raw) was considered and
  rejected for now: it is passed to the `StrudelMirror` constructor and
  `canTranspilePattern()` runs synchronously at boot and on tab open.
- Already good: prettier, hydra-synth, csound, xen, midi, osc and serial
  are lazy; lucide is tree-shaken; the module script is deferred so the
  static shell paints at FCP ≈ 0.3 s; `registerSoundfonts()` and
  `registerSynthSounds()` make no network requests; the share-link
  top-level await is sub-millisecond.

### 4.11 Still open

Findings whose status is `open` at the end of the session — nothing else
is. Neither was attempted.

- **UX-28** (P3) — an unclosed paren is reported at the parser's position
  (a later, empty line) with no pointer to the line where it was opened.
- **UX-31** (P3) — the beat grid is cramped in the default 180 px pane.

Everything "partly fixed" names what remains in its status line; the
remainders that need a decision or a design are in §6 and §7.

## 5. Triage and execution plan

This is the plan as written after the audit, kept for the record. What
landed, and in which commits, is in §9; what did not is in §6.

Four batches, in order. Within Batch 1 the six work streams touch mostly
disjoint files and run in parallel; later batches run after Batch 1 is
merged because they build on its fixes.

Verification that applies to every batch:

- A regression test in `node:test` for every finding marked feasible by the
  audit (most are: the audits' node repro scripts are the tests). Where a
  fix needs a browser, extract the decision into a pure function and test
  that.
- `pnpm test` and `pnpm build` green before each commit.
- A re-run of the headless measurement harness (the scenarios in §3) after
  each batch, filling the **After** columns.
- An independent review of each diff before commit — by someone who did
  not write it, reading the code rather than the summary.
- In-app verification by a person for audio, MIDI hardware and visuals
  stacking; these cannot be signed off headlessly.
- One finding per commit where practical, with the ID in the commit
  subject, so `Status:` lines can cite a commit.

### Batch 1 — bugs (parallel)

| Stream | Findings | Main files | Extra verification |
|---|---|---|---|
| **1a. Data safety and persistence** | PS-1…5, PS-9 (= ED-3), PS-10…14, PS-16, PS-17, MX-1 (= PS-6), UX-9 | `src/patterns.js`, `src/tabs.js`, `src/store.js`, `src/share.js`, `src/library-io.js`, `src/capture.js`, `src/ui/left-rail.js`, `src/main.js` (boot, tab install, share arrival, save), `vite.config.js` | Extend `patterns.test.js`, `tabs.test.js`, `library-io.test.js`, `share.test.js`, `build-editor-state.test.js`; the P0s (PS-1, PS-2, PS-3, MX-1) each get a failing test first |
| **1b. Evaluate/stop lifecycle, error feedback, export correctness** | TR-1…8, TR-10…13, TR-16, TR-18…21, TR-3 (= MX-4), TR-20 (= UX-4), MX-6…10, MX-18 (non-Worker part), MX-19, UX-7, UX-20, SC-6, SC-10, SC-16 | `src/eval-feedback.js`, `src/strudel-logger.js`, `src/boot.js`, `src/export.js`, `src/debug.js`, `src/main.js` (evaluate/stop wrappers, repl event listeners), `src/strudel-ext/{arrange,progression}.js`, `src/editor/error-marks.js`, `src/ui/transport.js`, `src/ui/track-bar.js`, `src/ui/arrange-bar.js` | Turn the lifecycle repro scenarios (cancel during eval, empty buffer, double evaluate, scrub registry growth, runtime-error badge, failed `evaluate(false)`, non-audio warning) into tests; `progression.test.js` groups rewritten for TR-5 |
| **1c. Hydra/shader visuals** | RD-1 (= TR-9), RD-2…7, RD-16, RD-18…22, RD-25, PF-1 | `src/strudel-ext/{hydra,shader,uniforms}.js`, `src/styles/visuals.css`, `src/main.js` (visuals clip, full-window, `onDraw` uniform feed), `src/piano-roll-resize.js`, `src/ui/bottom-panel-modes.js` | Hydra test harness for loop cancellation, re-entrancy and listener counts; `uniforms.test.js` for RD-5; re-run the §3.7 pixel-diff and GL-census pass; person checks stacking in a real browser |
| **1d. Editor, autocomplete, typing latency** | ED-1, ED-4…13, ED-15…17, ED-19…21, ED-8 (= SC-20), TR-6 (= ED-2, scrubber side) | `src/editor/**`, `src/editor-setup.js`, `src/editor-actions.js`, `src/main.js` (tab install, Cmd+B handler) | Node tests on `CompletionContext`, `findCallContext`, tokeniser, drum parser, error locator, `docSync` call counts; `scripts/test-format.mjs` cases for ED-10; re-run §3.4 |
| **1e. Panels, modals, palette** | PN-1…22, PN-24…26, PN-7 (= UX-2), PN-9 (= MX-14), PS-7, PS-8, UX-12, UX-14, UX-16, UX-17, UX-23 | `src/panels.js`, `src/ui/{right-rail,sound-browser,reference-panel,console-panel,export-panel,settings-panel,learn-panel,command-palette,modal,fuzzy,icons}.js`, `src/styles/base.css` and the panel stylesheets | Stub-DOM tests for rail restore, `buildConfirm` guard, modal focus chain, palette timers, fuzzy cases, icon-name coverage; re-run the panel leak scenarios in §3.6 |
| **1f. MIDI bridge, import, output** | MX-2, MX-3, MX-5 (= SC-7), MX-11…13, MX-15, MX-16, MX-17 (= UX-8), MX-20, MX-21, MX-22, UX-18 | `src/midi-bridge.js`, `src/midi-to-strudel.js`, `src/midi-gm.js`, `src/user-setup.js`, `src/ui/{midi-bar,midi-import-dialog,transport}.js`, `src/boot.js` (`maxPolyphony`), `src/main.js` (`midi.start()`) | `midi-to-strudel.test.js` for heuristic, ticks, identifiers, drum capture and a perf budget on a generated 10 k-note track; person checks with a real keyboard |

Coordination notes:

- **`src/main.js` and `src/eval-feedback.js` are shared** by 1a–1d. Keep
  edits to the cited line ranges and rebase often.
- **Stop/teardown choke point (RD-1 / TR-4 / TR-9):** stream 1c owns the
  single teardown hook; stream 1b removes the duplicate `repl-*` listeners
  and must leave the `repl-stop` teardown to 1c's hook.
- **Evaluate hooks (TR-6 / ED-2 / RD-7):** stream 1b moves arrange
  bookkeeping into `beforeEval`/`afterEval`; 1d routes the scrubber through
  it; 1c adds its per-eval "visuals requested" clearing to the same
  `afterEval`.
- **Export guard (TR-11 / MX-7):** the evaluate-side guard is 1b; the
  bridge, metronome and preview guards are 1f.
- **PS-7 and PS-8** are persistence findings but live in `src/panels.js`,
  so they are done in 1e; 1a supplies `applyImport`'s written-names return
  value and the hoisted new-pattern dialog.
- **PS-4 before PS-7 and PS-10:** the dirty flag changes what the other
  two need to do.
- **MX-21** was not in the initial split; it is assigned to 1f.
- ED-14 and the default-on question in PN-4 wait on §7.

### Batch 2 — performance and memory

| Stream | Findings | Main files | Verification |
|---|---|---|---|
| **2a. Render loops** | RD-8 (= TR-14), RD-9 (= TR-15), RD-10…15, RD-17, RD-23, RD-24, TR-22, PF-2, PF-3 | `src/main.js` (`onDraw`, resize), `src/ui/{piano-roll,scope,beat-grid,arrange-bar,track-bar,transport}.js`, `src/piano-roll-resize.js`, `src/styles/{transport,bottom-panel}.css` | Fake-rAF tests for loop start/stop; jsdom-free counting tests for hidden rebuilds; re-run §3.3 (with an `arrange()` pattern open), §3.5 and §3.6 |
| **2b. Bundle and boot** | BD-1…10 (order: BD-7, BD-10, BD-4, BD-2, BD-1, BD-3, BD-9, BD-6, BD-8; BD-5 last or deferred) | `vite.config.js`, `vercel.json`, `index.html`, `src/boot.js`, `src/panels.js`, `src/editor/{hover-docs,signature-hint}.js`, `src/editor/completions/**`, `src/main.js` | Rebuild and re-run §3.1 and §3.2 after each item; check for a single `Pattern` class (`instanceof` across lazy chunks) and that opt-in packages still register; `pnpm preview` smoke test of every lazy path |

Targets for the After columns: editor interactive and the pre-interactive
long task down in proportion to the bytes removed; idle rAF 0 /s with any
pattern open; playing script ms/s for roll-collapsed and beats near the
PF-2 floor; typing p95 frame-done under one frame.

### Batch 3 — Strudel support

| Findings | Main files | Verification |
|---|---|---|
| SC-1, SC-2 (= TR-17), SC-3, SC-4, SC-5, SC-8, SC-13, SC-15, SC-17, SC-18, SC-19; SC-14 (soundfonts in `evalScope` only) | `src/boot.js`, `src/user-setup.js`, `src/main.js` (`onDraw` painters, pattern-switch reset), `src/strudel-ext/` (`.piano()`), `scripts/build-strudel-docs.mjs`, `src/editor/strudel-docs.json`, `src/editor/completions/bank-detect.js`, `src/ui/transport.js`, `STRUDEL.md`, `README.md` | The paste table in §4.7 is the checklist — fill its After column; a boot-order unit test with a stubbed `aliasBank`; a docs-index test that every listed name is callable in the installed packages and no arrange internal leaks; `pnpm gen:docs` committed with the code |

Suggested order: SC-1, SC-2, SC-3, SC-4, SC-5 first (five small fixes that
remove most "pasted and it is silent or blank" cases), then SC-13, then
SC-8 (medium, high leverage), then the P3 remainder. SC-8 interacts with
BD-1/BD-2 (one docs corpus, loaded lazily) — land the generator fix after
the lazy-load plumbing.

### Batch 4 — UX and accessibility refinement

| Findings | Main files | Verification |
|---|---|---|
| UX-1, UX-3, UX-5, UX-6, UX-10, UX-11, UX-13, UX-15, UX-19, UX-21, UX-22, UX-24…31, PS-15, PN-23 | `src/styles/**` (tokens, base, shell, left-rail, tab-strip, transport, beat-grid, bottom-panel), `index.html`, `src/ui/{left-rail,tab-strip,beat-grid,piano-roll,keymap-chip,command-palette}.js`, `src/editor/signature-hint.js`, `src/editor/error-marks.js`, `design/SYSTEM.md` | Re-run axe-core per state and the contrast script — fill the After columns in §4.8; a token contrast test; repeat the Tab pass and the 390 / 768 / 720×450 viewport screenshots; visual choices go through the design-polish pass rather than being decided in the fix |

UX-1 (P0) is the first item of this batch and may be pulled forward if
shared links on phones matter before Batch 4 starts.

## 6. Deferred

Items the audits flagged as large or product-level, plus what the four
batches left behind on purpose. Rows that named a later batch and were
then fixed in it have been removed; the status lines in §4 are the record.

| ID | Why deferred | Recommendation |
|---|---|---|
| SC-9 | Folder sample import is a feature (folder picker, blobs in IndexedDB, live registration), not a fix; medium effort | Fix the cheap part now under PN-13 (name matching, overwrite confirm, reload banner, `samples(url)` so `github:` and base URLs work); spec the folder picker separately |
| SC-11 | Audio-device, multichannel and polyphony settings are a new Settings section; matters to live performers, not beginners | Set an explicit `maxPolyphony` now (MX-16); spec an Audio section later; SuperDirt target is optional |
| SC-12 | `.pianoroll()`, `.scope()`, `.tscope()`, `.fscope()`, `.spectrum()` and `.pitchwheel()` still draw on Strudel's unmanaged full-page canvas; a managed home for them needs a decision on where those visuals live | The Hydra/shader host (`src/strudel-ext/visuals-host.js`) and the bottom canvas's "Custom" mode now exist: route the full-page context through one of them so all canvases share a clip / full-window mechanism; finish `feedStrudel` (SC-18 rest) with it |
| SC-14 (rest) | gamepad, motion, mqtt and mondo are new dependencies and niche; tidal, edo and dough are unreleased. The soundfont globals are in scope (5daf860) | Add the four published packages as opt-in rows in Settings when asked for — a maintainer call, since each is a new dependency |
| MX-18 | Worker-based WAV encode changes the export pipeline and needs transferables plus a byte-for-byte equivalence test | Do the retention and yield fixes in Batch 1; move encoding to a Worker when long renders become a real workflow |
| ED-14 | Whether "Insert sound" should replace the whole string is a product call (the docstring says intended) | Decide in §7; the token-level replacement is small once decided |
| ED-8 (= SC-20) | Inline sliders lost and highlight bleed on tab switch need per-tab storage of mini-locations and widgets; not attempted in Batch 1 and not picked up with the render-loop work | Its own change: store `{miniLocations, widgets}` per tab, clear mini-locations unless the incoming tab is the playing one |
| ED-17 | "x is not a function" locator misses `foo(1)` / `foo(x)`; not attempted | Small; do with the next error-message change (UX-28 is in the same file) |
| ED-20 (rest) | Keyboard scrubbing (Alt+Up/Down nudge) is a new feature, not a fix | Spec separately |
| ED-16 (rest) | Digit-leading sample names (`808bd`) are still rejected by the drum-lane parser; not picked up | Small |
| ED-21 (rest) | Bank chip not refreshed on tab switch; not picked up | Small; refresh it from the tab install hook |
| TR-22 (rest) | The four 15 s boot timeout timers are never cleared (`src/boot.js` `withTimeout`); harmless, they fire once into a settled race | Clear the timer when its phase settles |
| TR-19 (rest) | Arrange-bar solo still starts playback when stopped; the keymap, track bar and palette paths are fixed | Gate `handleSoloClick`'s evaluate on the scheduler running, once §7 item 5 is confirmed |
| TR-21 (rest) | Single-token raw rhythms such as `'0*4'` are rejected; `comp` doubles a note on three-note voicings | Small; do with the next `progression()` change |
| MX-10 | Closing the live context while decodes are in flight could cache a rejected promise; not reproduced | Leave until it is seen; the fix is to await or re-issue pending decodes before the swap |
| MX-16 (rest) | True steal-oldest for live MIDI is impossible from the bridge: superdough returns no voice handle | Tapering is in place; decide in §7 |
| MX-19 (rest) | Tail seconds, cancel, dither/normalise for export | Feature-sized; spec with MX-18 |
| MX-21 (rest) | Metronome is still a `setInterval`; capture buffer unbounded | Schedule clicks on the audio clock when capture is next touched |
| MX-6 (gap) | The node-pool flush probes wavetable pools only with the sounds the rendered pattern uses, so a wavetable voice pooled by a different pattern is not flushed | Acceptable; revisit if dropped first notes reappear after a wavetable pattern |
| PS-17 (rest) | Dirty-set caching; quota handling in the folder-delete "unfile" branch; not picked up | Small; the caching is a per-render cost of the tab strip |
| PS (residual) | Two windows editing the same pattern inside the 1 s autosave debounce: the last writer wins (a status message is shown). A Revert of non-transpiling demo code in one window is undone if another window has that pattern active | Accept; a merge UI is out of scope |
| PN-26 (rest) | Dead popover code in `settings-drawer.js`, export cancel | Delete the dead code with the Setup files (§7 item 1); export cancel with MX-18 |
| SC-4, SC-17 | Resetting tempo, voicings and default controls when a different tab is first played (and honouring `// @version`) was implemented and then withdrawn after review. It ran before the new tab's code, so a slow first evaluate left the still-playing tab at 0.5 cps; a late failure of a cancelled evaluate could rewind a newer tab's tempo; and it wiped defaults set by the user's setup script. Until it is redone, "tempo carries over between tabs" is documented in `STRUDEL.md` as a known difference from strudel.cc | A correct version must: decide "owner changed" before evaluating but apply nothing until the new pattern is installed; default the tempo to the boot-time baseline (after the setup script), not a literal 0.5, and only when the code set none; treat voicings and default controls the same way; and key everything to one evaluate token so a cancelled or late-failing evaluate cannot touch a newer one. `// @version` goes through the same path |
| SC-15 | The BPM readout assumes 4 beats per cycle (`setcpm(90)` shows 360 bpm) | Show cpm beside bpm; parsing the `setcpm(x/y)` denominator is the fragile alternative |
| SC-18 (rest) | Hydra's `feedStrudel` is accepted but does nothing useful; the piano-roll half (`hap.value.color`) is done | With SC-12 |
| RD-10, UX-11 (rest) | Stopping while a different tab is focused leaves the playing tab's last frame on the roll (a click on it is a no-op). The scope has no stopped empty state | Clear the roll (or re-query the focused tab's first frame) when the frame's owner is not the focused tab; add a "Press play to see the scope" state |
| BD-4 | Lazy-loading the MIDI import path: only ≈10 kB is left to move now that `@tonejs/midi` is gone | Not worth a lazy boundary on its own; fold into BD-8 if that happens |
| BD-7 (rest) | A cache header for the `/strudel-cc` proxy could cache an upstream error for a day | Leave; BD-9 is the right place to cache manifests |
| BD-8 | A vendor `manualChunks` split would evaluate before `storage-guard.js` (which must run first) and forms a cycle with the top-level-await entry | Only with an explicit allow-list of leaf packages, after moving the entry's top-level await and the storage guard into a chunk the vendors do not depend on; measure parallel-compile gain on the runner first |
| BD-9 | Caching the sample manifests: `samples(url)` fetches internally, so there is nothing to hook | Fetch the manifests through Cache Storage with stale-while-revalidate, then register with `samples(json, base)` (boot already does `fetchJson` → `samples(json)` for the maps in `src/default-samples.js`); the first play before a bank lands must still be reported |
| UX-3 (rest) | The editor's bracket colour (2.14:1) comes from the Strudel theme, not from strasbeat's tokens | Override it in the theme extension or pick it per theme; a design-polish call |
| UX-15 (rest) | Sub-11 px font sizes in the panel stylesheets, native `<select>` and range inputs, `theme-color` (#1c1c1c vs the rendered background) | Panel sizes with the next panel pass; the select replacement is a component, spec it |
| UX-19 (rest) | The palette and the Stop tooltip still say `Ctrl+.` on macOS; no shortcuts were rebound or added (mute on `⌘M`, tab navigation, `F1`) | Render through `src/ui/shortcut-format.js`; rebinding is a maintainer call |
| UX-22 (rest) | The accent picker's lightness slider can still produce a focus ring below 3:1 | Clamp `--focus-ring` lightness independently of the accent |
| UX-30 (rest) | The roll still animates its grid row; several off-token durations remain | Polish pass |
| Light theme | Dark-only; no `prefers-color-scheme` rules | §7 item 4 |
| PF-3, and the un-re-measured §3 rows | A slow heap rise over 30 evaluate→stop cycles needs a 300+ cycle soak; playing-frame cost, leak slopes and typing under CPU throttle were not re-measured after the fixes | The performance lane: build the measurement rig on runners, re-run the §3 scenarios against `03ba08c` and the final tree |

## 7. Decisions for the maintainer

Taste and strategy calls the audits and the four batches raised. Each
states the behaviour on `upgrade` today and a recommendation; the answer
goes on the `Decision:` line. Items 1–13 date from Batch 1 (updated where
later work changed them); 14–21 are new.

1. **Delete the unused Setup panel files (PN-14).** Setup is not a
   right-rail panel: its package and sample controls live in Settings. The
   palette command and the copy that pointed at a Setup tab were removed in
   Batch 1; `src/ui/setup-panel.js` and `src/styles/setup.css` are still in
   the tree with no importer. Recommended: delete both, along with the dead
   popover code in `src/ui/settings-drawer.js`.
   - Decision: deleted (`src/ui/setup-panel.js`, `src/styles/setup.css`);
     the two messages that still pointed at a "Setup panel" now say
     Settings. The dead popover code in `settings-drawer.js` is left.
2. **"Try" opens examples in a scratch pattern (PN-4, PN-18, UX-26) —
   confirm.** Implemented as the audit recommended: Try in Learn and
   Reference puts the example in a user pattern named `try-example`,
   brings it to the front and plays it; the pattern that was open is not
   touched. The scratch pattern is reused, and Try asks before replacing it
   only if it was edited since the last example. Alternative not taken:
   keep replacing the open pattern behind a confirm.
   - Decision: —
3. **Unreleased upstream API stays out of the docs index (SC-8) —
   confirm.** Implemented as recommended: `pnpm gen:docs` takes the
   callable names from the installed packages' runtime scope, so hover
   docs, signature hints, autocomplete and the Reference panel offer only
   what runs. Functions that exist on upstream `main` but are not
   published (`cycleStruct`, `flux`, `juxFlip`, `edoScale`, `stackCenter`,
   `onSchedule`, …) are absent until a release ships them; a test fails
   if the committed index names something that cannot be called. The
   alternative not taken: list them, marked "unreleased". Recommended:
   keep. Six callable names have no upstream JSDoc to scrape and so have
   no entry: `setcps`, `onPaint`, `_pianoroll`, `loadSoundfont`, `csound`,
   `xen` — hand-written entries would be a small follow-up.
   - Decision: —
4. **Light theme (UX audit scope note).** The app is dark-only
   (`color-scheme: dark`, no `prefers-color-scheme` rules). Is a light
   theme in scope, or is dark-only a deliberate constraint to record in
   `design/SYSTEM.md`? Not touched in Batch 1.
   - Decision: —
5. **Starting playback from non-play controls (TR-19, RD-14).** Today:
   mute/solo from the keymap, the track bar and the palette edit the code
   and do not start audio when stopped, matching the beat grid; scrubbing a
   number while stopped no longer evaluates either. The arrange bar's solo
   still starts playback when stopped. A beat-grid edit in a non-playing
   tab no longer takes over playback (RD-14, 1f34df6); the track bar's
   `isPlaying` does not use that tab-aware predicate yet, so a mute or
   solo there while another tab plays still re-evaluates the focused
   buffer. Recommended: confirm "only Play starts audio", gate the arrange
   solo the same way, and give the track bar the beat grid's predicate.
   - Decision: —
6. **"Insert sound" (ED-14).** Today it replaces the whole mini-notation
   string under the cursor, as its docstring says. The audit recommends
   replacing only the token under the cursor (`tokenAtOffset` exists).
   Unchanged in Batch 1.
   - Decision: —
7. **Ending a capture preview stops playback (MX-1).** The preview now
   plays the take through the repl without touching the buffer, and stops
   playback on every exit path — including the user's own pattern if it was
   playing when the capture started. Alternative: resume what was playing.
   Recommended: keep (simple and predictable) unless it is annoying in
   practice.
   - Decision: —
8. **Reduced motion and visuals (RD-25).** With `prefers-reduced-motion`
   set, Hydra and shader layers render one still frame instead of
   animating. `localStorage['strasbeat:visuals-motion'] = 'full'` opts
   out; there is no UI for it. Decide whether the opt-out deserves a
   Settings toggle.
   - Decision: —
9. **Double-quoted `rhythm:` in two shipped patterns (TR-21).**
   `patterns/ben-tag.js` and `patterns/mellow.js` pass a double-quoted
   `rhythm:` value, which the transpiler turns into a Pattern, so the
   option has never applied. They sound as before but now raise the
   warning badge. Switching them to single quotes silences the warning and
   **changes how they sound**, because the rhythm starts applying. The
   alternative is to delete the option from both.
   - Decision: —
10. **Warning badge colour (TR-20).** Unknown-sound, silent-pattern and
    helper-misuse warnings raise the transport badge, which reuses the red
    error style. An amber variant would read better; that is a design-token
    choice for the polish pass.
    - Decision: —
11. **Arrange solo across tabs (TR-13).** Solo is cleared on every tab
    switch, so it no longer leaks into another tab — and is lost when you
    return to the tab that had it. Alternative: key solo by tab.
    - Decision: —
12. **Live MIDI voice budget (MX-16).** superdough hands back no voice
    handle, so the bridge cannot steal the oldest voice. Instead holds
    taper: from 24 sounding voices the sustain pedal stops extending
    notes, and past 48 each new note's hold shrinks in proportion.
    Accept tapering, or pursue real stealing (which means patching or
    bypassing superdough)?
    - Decision: —
13. **Mod wheel direction (MX-2).** At rest the wheel now leaves the sound
    unfiltered and pushing it up closes the low-pass — the reverse of the
    old mapping, where rest meant a 200 Hz filter on every note. Confirm by
    feel on a real keyboard.
    - Decision: —
14. **Which kit owns `bd`, `sd`, `hh`… (SC-1/SC-5 follow-on).** Several
    default sample maps define the same names. Today dirt-samples wins
    every name it shares with another map — `bd sd hh cp cb cr ht lt mt`
    (also in uzu-drumkit) and `sax` (also in VCSL) — whatever order the
    manifests arrive in; before, the drum names were a network race that
    dirt-samples usually won. strudel.cc itself never loads the full
    dirt-samples, so `bd` there is uzu-drumkit: a pasted pattern plays a
    different kick here. Pinning to dirt-samples keeps existing strasbeat
    patterns sounding the same, including ones that index its larger
    folders (`bd:7`). Recommended: keep dirt-samples. Flipping it is a
    one-line move of the `claim` in `src/boot.js`.
    - Decision: —
15. **Piano, VCSL, wavetables and mridangam load by default (SC-1,
    SC-5).** Boot now fetches those four manifests (a few kB to ≈180 kB of
    JSON; audio still loads on first use), as strudel.cc does, and the two
    opt-in rows in Settings — with their wrong "~60MB" label — are gone.
    Registered sounds went from 1,060 to 1,853. The cost is four more
    requests during boot, each with its own timeout and a named warning if
    it fails. Recommended: keep; pasted patterns resolving matters more
    than ≈190 kB of JSON.
    - Decision: —
16. **Reduced motion and the playheads (RD-25, UX-24).** With
    `prefers-reduced-motion` set, the chrome's CSS animations and
    transitions are off and visuals render one still frame (item 8). The
    JS-driven playheads — transport fill and dot, arrange bar, beat grid —
    still move, as does the piano roll: they show position, not
    decoration. Recommended: keep them moving; if that is wrong, step them
    once per cycle or per beat instead of every frame.
    - Decision: —
17. **Brighter secondary text (UX-3).** `--text-dim` went from 2.0–2.6:1
    to 4.0–5.3:1 and `--text-mut` from 4.5–6.0:1 to 6.3–8.4:1 across the
    four surfaces (lightness only; `design/SYSTEM.md` has the values).
    Because the tokens are used everywhere, all secondary text is
    brighter and the gap between primary and secondary text is narrower;
    transport micro-labels also grew from 9–10 px to 11 px. `--text-dim`
    on surface-3 is 4.01:1, still under 4.5. Recommended: accept for
    readability and review the hierarchy by eye in the polish pass.
    - Decision: —
18. **Keymap chip hidden below 600 px (UX-1).** On a phone-width window
    the transport has no room for it, so the chip is hidden; the keymap
    can still be changed in Settings. Recommended: keep — modal keymaps
    on a touch keyboard are rare.
    - Decision: —
19. **48 px bars on touch devices (UX-21).** Under `pointer: coarse` the
    top bar and the transport are 48 px tall and icon buttons, tabs and
    list rows get larger hit areas, at the cost of two rows of code on a
    phone. Separately, the roll is capped at 30dvh on windows 640 px tall
    or less. Recommended: keep; check on a real tablet.
    - Decision: —
20. **"Custom" mode selects itself for painter patterns (SC-3).** When an
    evaluated pattern registers a draw function that uses the canvas it
    is handed (`.punchcard()`, `.spiral()`, `.wordfall()`, `.onPaint()`),
    the bottom panel offers a "Custom" mode and switches to it once.
    Switching back to Roll is respected until the painters go away and
    come back. The alternative is to offer the mode and never switch.
    Recommended: keep the automatic switch — otherwise a pasted
    `.punchcard()` appears to do nothing.
    - Decision: —
21. **Keep the headless smoke workflow?** The 49-check Playwright run
    behind §3.10 lives on a throwaway branch outside `upgrade`; nothing
    in the repository runs a browser. Recommended: commit it as an opt-in
    workflow that runs only on `ci/smoke-*` branches (so ordinary CI stays
    fast), when the performance lane lands and can share its runner
    setup.
    - Decision: committed now as an opt-in workflow
      (`.github/workflows/smoke.yml`, `.github/smoke/smoke.mjs`): `ci/smoke-*`
      pushes and manual runs only. `CLAUDE.md` § CI says how to run it.

## 8. Needs human verification

Nothing below could be signed off by tests or review. Tick each on a real
machine; anything that fails becomes a new finding.

**Already verified in headless Chromium on a runner** (the smoke run in
§3.10, final tree, production build) and therefore removed from the lists
below: boot to "Ready to play" with no load warnings or console errors;
`tr909_bd`, `piano` and `gm_piano` are registered; no animation frames at
idle or after stop; play and stop; the outcome of `editor.evaluate()`; the
unknown-sound warning in the status line; all six panels render; function
completion and the signature hint; the command palette keeps Tab inside
and closes on Escape; the Hydra and shader demos render in the Visuals
panel without painting over the left rail, are removed by `editor.stop()`
and stay gone when a non-visual pattern is evaluated next; `.punchcard()`
draws in Custom mode; a stored Vim profile is active after boot; the
editor is usable, Play is visible and nothing scrolls sideways at 390, 768
and 1024 px.

That run is Chromium with software GL and no audio device. What remains
for a person: audio by ear, MIDI hardware, how visuals look on a real GPU,
screen readers, Safari and Firefox, touch devices, and everything listed
here.

**Audio, by ear**

- [ ] Export a pattern with filters twice in a row: the first notes of
      each WAV are present, and live playback straight after the export
      has no dropped notes (MX-6).
- [ ] Export a visual (Hydra or shader) pattern: the WAV is correct and no
      visuals start during the render (RD-2).
- [ ] Break the code, press WAV: the export refuses with the error instead
      of rendering the previous pattern (TR-3).
- [ ] First play from the keyboard (Cmd/Ctrl+Enter, no click on Play):
      worklet-based sounds work on that first play (SC-10).
- [ ] Press stop during a slow start (`await samples(...)`, first
      `await initHydra()`): it stays stopped (TR-1).
- [ ] `progression()` with `@2` and `*2`, with block and arpeggiated
      rhythms: held cycles play the full figure, repeats fit in one cycle
      (TR-5).
- [ ] `patterns/ben-tag.js` and `patterns/mellow.js` sound as before
      (they will show the warning badge; §7 item 9).
- [ ] Capture a phrase, preview it, save or discard: the open pattern is
      untouched; note that playback stops when the preview ends (§7
      item 7).
- [ ] The new default sounds are audible, not just registered:
      `s("bd*4").bank("tr909")`, `note("c e g").s("piano")`,
      `note("c3 e3 g3").piano()` (pans by pitch), `s("kalimba")`,
      `note("c e g").s("wt_digital")`, `s("mridangam_gumki")`.
- [ ] `bd`, `sd`, `hh` and `sax` sound as they did before, and `bd:7`
      still indexes dirt-samples (§7 item 14). Reload a few times: the
      kick does not change between loads.
- [ ] A slider drag (`slider(0.5, 0, 1)`) changes the sound and logs no
      "not registered" warning.

**MIDI hardware**

- [ ] Fresh browser profile: no permission prompt on load; the pill reads
      "Connect MIDI"; clicking it prompts and connects. Returning visit:
      connects with no click. Chrome and Firefox.
- [ ] Deny the prompt, then allow it in site settings: connects without a
      reload.
- [ ] Mod wheel feel: unfiltered at rest, closes as it goes up (§7
      item 13).
- [ ] Voice budget: organ preset with the pedal down and many notes — the
      tapering is acceptable and nothing runs away (§7 item 12).
- [ ] Output selector with two real devices: a bare `.midi()` follows the
      selection; `.midi('name')` still wins; unplugging the selected device
      warns once and falls back.
- [ ] Play the keyboard, the metronome and a sound preview while a WAV
      export renders: nothing lands in the file, and all three work again
      afterwards.
- [ ] Drums preset capture is saved as drums.
- [ ] Import a real multi-track MIDI file with a tempo change and a
      channel-10 drum track; try the per-track drums override.

**Visuals, on a real GPU**

- [ ] The shader demo looks right and its uniforms pulse on the beat
      rather than two cycles early (placement and teardown were verified
      on the runner; timing against the sound was not).
- [ ] Switch tab and evaluate a non-visual pattern while a visual one
      plays: the old canvas is gone.
- [ ] Reload with a visual pattern as the last-open tab: no render loop
      until Play.
- [ ] First play of a visual pattern after load: the layer survives the
      gap between evaluate and scheduler start (the hold added after
      review).
- [ ] 10× play/stop: no accumulating canvases or "too many WebGL contexts"
      warning.
- [ ] Full-window mode: renders behind the editor, does not cover the left
      rail; stop → play keeps it visible.
- [ ] Collapse, expand and drag the roll divider while visuals play: the
      clip follows without lag.
- [ ] With the OS "reduce motion" setting on: one still frame (§7 item 8).

**Multi-window and storage**

- [ ] Two windows on the same pattern: save in one, the other follows if
      it has no edits of its own and keeps its buffer if it has.
- [ ] Both windows editing the same pattern within a second: last writer
      wins and a status message says so.
- [ ] Fill localStorage (or use a tiny quota): the "Not saving" notice
      appears, stays, and clears once a write succeeds again.
- [ ] Safari with site data blocked (and a private window): the app boots
      and shows the notice.
- [ ] Open a share link: it arrives as `shared-<name>`, the hash is
      cleared, and a reload shows your edits, not the original. Open the
      same link twice.
- [ ] Type, then close the tab's × within a second; reopen: the edit is
      there. Same for backgrounding the tab on a phone.
- [ ] Put a pattern in a folder, edit it, reload: still in the folder.
- [ ] Dev server: ⤓ save over an existing pattern name asks first.

**Panels**

- [ ] Export panel: filename follows a pattern switch; the waveform draws
      when the render finishes while the panel is hidden; a peak over 0 dB
      reads as clipped; the download works a second time.
- [ ] Import samples from a real manifest URL: they appear under "User",
      and deleting a bank shows a readable confirm.
- [ ] Sounds panel with the full sound set: scrolling, search and the
      audition buttons feel right after the chunked rendering.
- [ ] Right rail: the last-used tab is restored on reload; Escape clears a
      search first and returns to the editor second; Cmd/Ctrl+B does not
      strand focus.
- [ ] Command palette: a right click or a touch scroll does not run a
      command.
- [ ] Offline (or with the network throttled hard), open a panel for the
      first time: the slot says it could not load and offers Retry; click
      WAV while offline, go back online, open Export — no render starts
      by itself.
- [ ] On a slow connection, hover docs and function completions start
      working by themselves once the docs index arrives.
- [ ] Try in Learn and Reference opens `try-example` and leaves the open
      pattern alone (§7 item 2); "Copy to new pattern" works.
- [ ] Import a library over open tabs: the tabs show the imported code.

**Bottom panel**

- [ ] `.spiral()`, `.wordfall()`, a hand-written `.onPaint()` and the
      inline `._punchcard()` widget draw; the panel switches to Custom
      once, and choosing Roll again is respected (§7 item 20).
- [ ] `.color("cyan magenta")` colours the notes in the roll.
- [ ] Click a note in the roll after editing above it: the cursor lands
      on the right text. With another tab playing, the click brings that
      tab forward (or does nothing if the frame is stale).
- [ ] While stopped: resize the window, drag the divider, open the right
      rail — the roll keeps its last frame. Collapse the pane while
      playing, expand it: the roll comes back full, with no doubled
      notes.
- [ ] Drag the window between a 2× and a 1× display: the roll stays sharp
      and clicks still hit (RD-15; never run in a browser).
- [ ] Transport fill and dot, the arrange playhead and the status pulse
      move smoothly on a real GPU; the readouts follow play and stop at
      once.
- [ ] Beat grid: typing in the editor while the grid is hidden, then
      showing it — it is current. Enter / Space on Mute, Solo, the bank
      chip and "+ Add drum" act on that button, not on a cell. Toggle a
      cell and press Stop straight away: playback stays stopped.
- [ ] Track and arrange bars follow edits and tab switches; a pattern
      with `arrange()` open and stopped costs nothing at idle.

**Phones, tablets and zoom**

- [ ] A real phone and a real tablet: the editor is usable, an opened
      rail floats over it behind a scrim, tapping the scrim or pressing
      Escape closes it, the top bar's pattern button opens the library.
- [ ] A rail left open on a desktop does not cover the editor when the
      same profile opens on a phone-width window, and closing a rail
      there does not close it on the desktop.
- [ ] 48 px bars and the larger touch targets feel right; the keymap chip
      is absent below 600 px (§7 items 18, 19).
- [ ] 200% browser zoom on a laptop (real zoom, not a small viewport).
- [ ] The first-run hint sits above the transport, points at Play and
      covers nothing at 390 px.

**Keyboard and screen readers**

- [ ] Patterns library with VoiceOver and NVDA: announced as a tree, one
      Tab stop, arrows / Home / End / type-to-find, Enter opens, F2
      renames, Shift+F10 opens a menu that is itself keyboard-operable;
      "modified" is announced.
- [ ] Tab strip: arrows move between tabs, Delete closes the focused one,
      the name carries modified and playing state, focus survives a
      play / stop re-render, and a mouse click on a tab leaves focus in
      the editor.
- [ ] Beat grid announced as a grid with row headers; Tab reaches a cell.
- [ ] Landmarks, the heading outline and the "Skip to editor" link.
- [ ] Focus ring visible on every control, including with a custom
      accent at low lightness (§6, UX-22 rest).
- [ ] Windows High Contrast (forced colours) and "increase contrast":
      active and pressed states are still distinguishable.
- [ ] OS "reduce motion": chrome animations are off; the playheads still
      move (§7 item 16).
- [ ] The new text contrast reads well and the hierarchy still holds
      (§7 item 17).

**Editor keymaps**

- [ ] Vim: `:w` evaluates once, `:q` stops, `gc` toggles a comment; the
      chip shows the mode only once the keymap is really active.
- [ ] Emacs profile loads and works (the runner checked Vim only).
- [ ] Select Vim while offline: the chip shows RETRY, typing still
      works in the default keymap, and retrying online applies it.
- [ ] Ctrl+hover over a function shows nothing odd (upstream's tooltip no
      longer has data; strasbeat's hover docs are the replacement).

**Other browsers**

- [ ] Safari and Firefox: boot, play, the lazy panels, the three layouts
      and the visuals. Everything automated this session ran in Chromium.

**Not measured**

- [ ] Playing-frame cost in each bottom-panel mode, leak slopes over
      repeated cycles, and typing latency under CPU throttle were not
      re-measured after the fixes (§3). The runner comparison in §3.10
      shows no typing regression on fast hardware and nothing else.

## 9. Session log

Commits land here, oldest first: `<short sha> <subject>`.

### CI setup

- `15c8bf9` ci: run tests and build on GitHub runners; keep ci/** branches off Vercel
  — `.github/workflows/ci.yml` runs `pnpm test` and `pnpm build` on pull
  requests, on `main` and on `ci/**` branches; `vercel.json` stops `ci/**`
  branches from creating preview deployments. This is the point where
  local browser and performance runs stopped (§2).

### Batch 1 — bugs (27 commits)

Persistence, capture, dev save

- `3c1f547` fix(persistence): stop autosave, tab close, share links and a second window from losing work
- `7399af5` fix(capture): preview a take without writing it into the open pattern
- `b358d55` fix(dev): make /api/save refuse cross-origin posts and silent overwrites

Visuals

- `7e42564` fix(visuals): tie hydra/shader lifecycle to the repl and share one host
- `b5b4e21` fix(visuals): pulse shader uniforms on the playhead, decay in seconds
- `bb9efe9` fix(roll): keep the visuals clip in step with pane collapse and divider drags
- `c4e4400` fix(bottom-panel): return to visuals mode after stop and play

`progression()`

- `b26e91d` fix(progression): make @N hold and *N repeat as documented

Editor

- `0cfdac9` fix(format): drop stale results, apply minimal diffs, accept quoted keys and interpolation
- `16563a9` perf(editor): memoise the buffer parsers, skip drum lanes in comments
- `dc1d639` fix(signature-hint): let codemirror position the pill
- `3a41d17` fix(completions): no popups in comments, strings or numbers; valid chord symbols
- `78ece10` fix(scrubber): coalesce live evaluates and keep arrange state intact

Transport and export

- `e8e2d35` refactor(transport): pure helpers for sequencing evaluates and classifying engine logs
- `e3066de` fix(export): refuse to render a stale pattern, clear foreign nodes from superdough's pools
- `2cd0a41` fix(transport): make stop cancel a pending evaluate and serialise overlapping ones

Panels, modal, palette

- `371797d` fix(right-rail): restore the persisted tab, stop stealing focus, two-step escape
- `3b24ced` fix(modal): restore focus synchronously so chained dialogs keep it, reject malformed options
- `3962448` fix(palette): trap focus, run commands on click, drop dead and dev-only entries
- `58a6fb1` perf(panels): delegate and chunk the sound browser, batch and coalesce the console
- `8b01c29` fix(panels): open examples in a scratch pattern, repair copy-to-new-pattern and library import refresh
- `cda6f50` fix(fuzzy): exact subsequence alignment and original-string match indices

MIDI

- `1b28215` perf(midi-import): linear midi file reader, tick-based quantisation, single parse
- `aa4ad7b` fix(midi-import): per-track drums override, index-based track lookup, readable errors
- `c61db47` fix(midi-out): route bare .midi() to the selected output device
- `8414591` fix(midi): ask for access on a gesture, unfiltered mod wheel at rest, voice budget
- `deaad2d` chore(deps): drop @tonejs/midi, replaced by the built-in file reader

Outcome: of the 128 findings Batch 1 touched, 105 are fixed, 14 partly
fixed and 9 deferred; 44 audit findings and the ten BD items remain open
for Batches 2–4. The commits do not carry finding IDs in their subjects;
the `Status:` lines in §4 are the mapping.

Tests: 692 → 1062 (`node:test`), 15 new test files and 13 extended.

Verification:

- Every commit was checked on GitHub-hosted runners (`pnpm test` +
  `pnpm build`) through temporary `ci/step-NN` branches before the next
  one was stacked on it.
- Every change set was reviewed independently, from the code, before it
  was committed. The reviews found four blockers, all fixed before the
  commits above:
  - following another window's save could wipe an edit in progress in
    this window — the follow rule is now "only while this window's buffer
    still equals the previously stored code";
  - under the new start sequence (the repl is never asked to autostart)
    the first play tore the visuals down in the gap between evaluate and
    scheduler start — the patched evaluate now takes a start hold on the
    visuals host;
  - `@N` holds in `progression()` were wrong with arpeggiated rhythms — a
    held chord is now unrolled into one-cycle slots so each held cycle
    plays the full figure;
  - the new MIDI file reader mis-skipped SysEx events and dropped
    zero-length notes.
- No browser run backs these commits beyond the evidence in §3.9. §8 is
  the list a person has to walk through.

Side effects worth knowing:

- New modules: `src/eval-state.js`, `src/storage-guard.js`,
  `src/ui/storage-notice.js`, `src/strudel-ext/visuals-host.js`,
  `src/midi-smf.js`, `src/editor/text-diff.js`,
  `src/editor/latest-wins.js`.
- `editor.evaluate()` resolves to `{ status, started, owner }` (status:
  `ok`, `error`, `empty`, `blocked`, `superseded`, `cancelled`).
- `setVisualsAvailabilityCallback` is no longer a pattern global, and the
  `VISUALS_REV` boot banner is gone.
- `@tonejs/midi` is no longer a dependency, so BD-4 shrinks to lazy-loading
  `midi-smf.js`, `midi-to-strudel.js` and the import dialog. The MIDI test
  fixture now reads as three tracks: the old fourth was an artefact of the
  library splitting one staff at a program change; all 1453 notes match
  the old parser's.
- Destructive confirms focus Cancel app-wide; GM sounds are grouped under
  "Soundfonts" in the sound browser.

### Batches 2–4 — performance, Strudel support, UX and accessibility (15 commits)

Grouped by area; within a group, oldest first.

Strudel support

- `5daf860` fix(boot): load strudel.cc's default sample maps and drum-machine bank aliases
- `c729580` fix(docs-index): document only what the installed packages can run
- `28f2bda` docs(strudel): inputs and outputs, inline widgets, pasting from strudel.cc, progression modifiers

Render loops and the bottom bars

- `98402b1` perf(transport): event-driven readout loop, transform playheads, compositor pulse
- `0ae6dd7` perf(roll): paint the bottom canvas only when it can be seen, cache per-hap work
- `5f344cf` perf(bars): keep unchanged track and arrange rows, stop the idle arrange loop
- `1f34df6` fix(beat-grid): defer hidden rebuilds, diff lanes, valid grid roles, guarded keys and replay

Bundle and boot

- `a66759d` perf(build): cache hashed assets forever
- `d5b9794` perf(load): fetch the docs index and the right-rail panels on demand
- `a31117b` perf(editor): build @strudel/codemirror from source, fetch vim and emacs on first use

UX and accessibility

- `9d5751a` fix(a11y): readable text tokens, one focus ring, contrast and motion preferences
- `528b280` fix(shell): keep the editor usable on phones, tablets and at 200% zoom
- `589bfa8` fix(tabs): valid tab semantics, roving focus, focus kept across renders
- `d3fc79b` fix(left-rail): patterns tree with one tab stop, keyboard menu, inert when collapsed
- `afd8452` fix(onboarding): first-run hint points at play; landmarks, headings, skip link

Outcome: after these commits the 172 audit and measurement findings stand
at 139 fixed, 19 partly fixed, 12 deferred and 2 open; the ten BD items at
7 fixed and 3 deferred. The entry chunk went from 2,893,696 to 1,871,838
bytes raw and from 769,234 to 573,010 bytes gzip (local `pnpm build`). As
before, the commits do not carry finding IDs in their subjects; the
`Status:` lines in §4 are the mapping.

Tests: 1,062 → 1,260 (`node:test`), 12 new test files and 5 extended.

Verification:

- Every commit was checked on GitHub-hosted runners (`pnpm test` +
  `pnpm build`) through temporary `ci/step-NN` branches, deleted
  afterwards.
- Every change set was reviewed independently, from the code, before it
  was committed. What the reviews found, all fixed before the commits
  above (or, in one case, removed):
  - roll pills were duplicated after the Drawer's window widened;
  - a painter that only sometimes touches its context was classified
    once and stayed out of the panel;
  - the keymap chip named a mode before the keymap chunk had loaded;
  - a one-shot call queued on a panel survived a failed load — a WAV
    click while offline would have started a render much later;
  - the tab strip took focus after mouse clicks;
  - the right-rail resize had a dead zone under the new width cap;
  - a floating rail could not be closed with Escape;
  - the first-run hint covered Play at 390 px (seen in a runner
    screenshot);
  - `sax` changed sound once VCSL loaded by default, and aliased kits
    appeared twice in the sound browser;
  - the tab-switch reset of tempo, voicings and defaults was unsafe and
    was withdrawn (SC-4, SC-17; design notes in §6).
- A headless-Chromium smoke run of the production build on a GitHub
  runner passed 49 of 49 checks on the final tree; the same script on the
  baseline commit `03ba08c` passes 28 of 41. Details and the caveat are in
  §3.10. The workflow lived on a throwaway `ci/smoke-*` branch and is not
  part of `upgrade` (§7 item 21).
- No person has walked through the app in a real browser; §8 is that
  list.

Side effects worth knowing:

- New modules: `src/default-samples.js`, `src/strudel-ext/piano.js`,
  `src/lazy-import.js`, `src/editor/docs-store.js`,
  `src/editor/lazy-keymaps.js`, `src/ui/lazy-panel.js`,
  `src/ui/bottom-canvas.js`, `src/ui/responsive.js`, `src/ui/roving.js`,
  `src/ui/shortcut-format.js`, `scripts/strudel-scope.mjs`.
- Boot registers 1,853 sounds (was 1,060): piano, VCSL, wavetables and
  mridangam load by default and the short drum-machine bank names
  resolve. dirt-samples keeps every name it shares with another map (§7
  item 14). The two opt-in rows for VCSL and wavetables are gone from
  Settings; stale stored ids are ignored.
- The docs index is generated from the installed packages' runtime scope:
  564 → 607 entries, 11 unreleased names and the arrange internals out,
  43 wrongly dropped names back, opt-in entries carry a `requires` hint.
  `pnpm gen:docs` exits 1 with a message when `strudel-source/` is
  missing.
- `@strudel/codemirror` is built from its source modules with its
  `doc.json` import stubbed to an empty list, so upstream's Ctrl+hover
  tooltip shows nothing (strasbeat's hover docs replace it). Vim and
  Emacs load on first use; the keymap chip shows LOADING / RETRY until
  the keymap is applied.
- Five of the six panels load on first open (the console stays in the
  entry) and are warmed at idle. On-demand imports go through
  `lazyImport`, which reports failures in the status line and console and
  caches nothing on failure.
- The sound browser lists an aliased kit once (`rolandtr909 · tr909`, the
  alias stays searchable) and groups sample maps by tag, so VCSL and
  mridangam families no longer appear as drum kits.
- A scheduler started from the devtools console is reflected in the
  transport within 1 s rather than 250 ms.
- `/assets/*` is served `immutable` in production.
- "Tempo carries over between tabs" is documented in `STRUDEL.md` as a
  known difference from strudel.cc.

### Independent review (16 commits)

A final read of the whole change set (`origin/main..upgrade`) by reviewers
who had not written it, area by area, with every finding traced or run
before it was fixed. Each commit passed `pnpm test` and `pnpm build` on a
runner. What it changed:

- **Data loss, fixed (19ddf4e).** Auto-heal deleted a shipped pattern's
  stored working copy whenever it failed to transpile — which is what
  autosave leaves behind when an edit session ends mid-expression. The copy
  is now kept as `<name>-recovered`. This came in with 6f2a4ab on `main`,
  not with the upgrade branch.
- **Library import (006afb9, 8c4d9e2).** Importing replaced local edits to
  a shipped pattern regardless of the conflict choice; `__proto__` was left
  out of exports; a refused write reported "created"; the new-folder
  prompts wrote back a stale index.
- **Doubled layers (cd11451).** Stop-then-play, or play during boot, on a
  pattern with a top-level `await` ahead of its `$:` lines (the shipped
  Hydra and shader demos) evaluated beside the evaluate still in the repl
  and stacked every layer twice. A request now waits, bounded, for an
  abandoned or first-frame evaluate. Still open: the scrubber's live
  evaluate and the capture preview call the repl directly and are not
  sequenced against a patched evaluate that starts while they are awaiting.
- **Export (3cd8600, ed0849b).** Sound previews, beat-grid cell previews
  and the capture audition were not held back while an export renders.
- **MIDI import (ed0849b, 478a43b).** Tracks of different lengths looped
  out of step; `ride`, `tamb` and `hq` were not registered sounds;
  implausible tempo and meter events are ignored; an unbuildable take is
  reported.
- **Dev server (7edd2a5).** `/api/save` passed a DNS-rebinding page.
- **Build guard (5e69b41).** A production build fails, and a test fails,
  when a new `@strudel/codemirror` no longer matches the redirects.
- **Smaller:** drum-machine aliases after a slow manifest (72da274); the
  `+` chord symbol (3455ed8); completions inside comments (cb4ec32);
  keyboard focus on last-tab close, rail collapse at a breakpoint,
  beat-grid menus, IME keys, palette over a dialog (fe60624, f70a50e);
  beat-grid lane edits across an open bracket, and `_` as a hit (560fe67,
  aa1c36d).

Found and left, none of them introduced by the upgrade branch unless noted:

| Where | What |
|---|---|
| `src/editor-setup.js`, `src/capture.js` | The scrubber's evaluate and the capture preview are outside the evaluate sequencer (see above) |
| `src/strudel-ext/visuals-host.js` | A failed evaluate that created a visual layer before throwing leaves it up until stop or the next good evaluate |
| `src/midi-to-strudel.js` | Grid candidates do not divide 5- or 7-beat bars; two same-pitch notes in one slot are written as a chord of duplicates; format-2 files are overlaid without a warning |
| `src/user-setup.js` | Before MIDI output is enabled, a stored output device that is unplugged is passed upstream as is (logged per hap, no fallback until the next evaluate); a failing setup script is only reported in devtools |
| `src/editor/format.js` | A regex literal containing `//` hides the rest of the line from the quote-restoring scan, so a single-quoted string after it can come back double-quoted |
| `src/editor/drum-parse.js` | A lane's block takes the comment lines that follow it (they usually belong to the next lane); `sound*N` expansion caps at 32 without saying so; a non-literal `.bank(kit)` gets a second `.bank()` |
| `src/ui/bottom-canvas.js`, `piano-roll.js` | Painters of the previous tab stay registered after a stopped tab switch; an accent change while stopped does not repaint; a throwing painter warns every frame |
| `src/ui/left-rail.js` | A rail re-render during an inline rename (autosave's dirty-set update) discards the input |
| `src/ui/arrange-bar.js` | Sections are `button role=listitem` with buttons nested inside |
| `src/panels.js` | "Copy to new pattern" judges success by the current name having changed, which another window deleting the active pattern can also cause |
| `src/editor/lazy-keymaps.js` | Each use of a keymap whose fetch failed retries and reports again |
| `src/boot.js` | dirt-samples' audio base now comes from the manifest's `_base`; if that field were dropped the kit would be silent with no boot warning |
| share links | Shared code is evaluated once at boot for the first frame, without sound and without a gesture, as on strudel.cc |

