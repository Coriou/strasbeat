# 29 — Performance lane: measured journeys, ratchets, and what moved

Status: **shipped on branch `perf`** (November 2026; not yet merged to
`main`). The measuring rig and its ratchets stay in use: how to run them is
in `docs/architecture.md` ("Performance rig and ratchets"). What the lane
left open is in [`OPEN.md`](OPEN.md), rows `PL-1` to `PL-9` and the
"Installed app and performance" checklist.

The numbers below come from GitHub-hosted runners: headless Chromium 159,
four virtual cores, no GPU, no audio device. Nobody has watched or listened
to any of it. Counts are exact and comparable between runs; timings are
only comparable within one run, base against head, and are quoted that way.

Contents: [Method](#1-method) · [Journeys](#2-journeys) ·
[Which metrics held up](#3-which-metrics-held-up) ·
[Before and after](#4-before-and-after) ·
[What changed](#5-what-changed) · [Ratchets](#6-ratchets) ·
[Service worker](#7-service-worker) · [Flags](#8-flags) ·
[The stray Vercel preview](#9-the-stray-vercel-preview) ·
[Looked at and not done](#10-looked-at-and-not-done) ·
[Run log](#11-run-log)

## 1. Method

Taken from the write-up of how claude.ai was made faster, minus what only
applies to a product with field telemetry:

1. Name the journeys, each with an exact start and end.
2. Measure them in the lab with **counts** — numbers that come out the same
   on any machine — because wall-clock on a shared runner cannot gate
   anything.
3. Before trusting a count, show that it moves with wall-clock time. Drop
   the ones that do not.
4. Give each count that held up a checked-in ceiling that CI enforces and
   that only goes down.
5. Then loop: profile, find the largest cost, fix it, measure, lower the
   ceiling.

Everything was measured on runners; nothing was run in a browser on the
maintainer's machine. Changes a user could notice went behind a switch
where a wrong result would be hard to see from here (§8).

## 2. Journeys

| Journey | From → to |
|---|---|
| Cold launch | navigation start, empty caches → the editor is in the document; a key press is handled; boot reports "Ready to play" |
| Repeat launch | the same, second and third launch of one browser profile |
| Tab | the app at rest; a click on a library item or a tab → three frames later |
| Evaluate | the app at rest; Ctrl+Enter goes down → the first audio source is scheduled |
| Keystroke | the app at rest; a key goes down at the end of a 180-line pattern → two frames later |
| Playing | steady playback → 600 frames at exactly 120 Hz (roll visible, roll collapsed, scope, beat grid; Hydra and shader at 30 Hz) |
| Idle | boot is over, nothing playing → ten seconds later |
| Long session | 120 evaluate/stop cycles, then 60 tab switches |

## 3. Which metrics held up

Three probe runs came first, to find out what a runner can measure at all.

- **Frame stepping works.** A page created with DevTools begin-frame
  control renders only when told to; with no frames issued,
  `requestAnimationFrame` fired 0 times, and 600 issued frames were 600
  frames. Under the smoke test's software GL about one frame in twenty
  stalled the GPU process for 0.5–1.5 s with the roll visible
  (`RasterDecoderImpl::DoEndRasterCHROMIUM`); with `--disable-gpu` the same
  600 frames took 4,995 ms against a nominal 5,000.
- **Call counts are deterministic.** V8 precise coverage, 600 frames of
  the same pattern, two page loads: 9,366 and 9,366 calls per frame with
  the roll visible, 6,247 and 6,247 collapsed. Typing 103 keys: 5,235,270
  and 5,235,191 calls. Before playback reaches a steady state (the roll's
  four-cycle window has to fill) the count drifts by 9 %, so the rig waits.
- **Wall-clock is not.** The same two page loads: 101.7 and 126.6 ms of
  script per second of playback (+24 %) for identical code.

Then each count was set against time, and the first verdict was wrong
twice over.

The first full run, taken when both builds still ran the same loop, gave
r = 0.96 for calls per frame against script time over 16 points, and that
looked like the end of it. Then the frame loop landed: calls per frame
fell by 81–89 % and script time by 35–58 %. The calls that went were
cheap ones, so the count overstates the gain, and the old loop's points
and the new one's do not lie on one line. **First correction: r is
computed within each build.**

Within a build, across the seven variants stepped at 120 Hz, r was still
0.94–0.97 for the old loop and 0.85–0.88 for the new one, in four runs on
three CPU models. That was one point. Without the eight-layer roll — which
a slow runner dropped, because it could not be stepped at 120 Hz there —
the new build's r is 0.44–0.57. The variants are different views, and
views differ in work the count cannot see: with the roll collapsed the
new build makes 1,158 calls per frame for 18.7 ms of script per second;
with one layer and the roll visible, 503 calls for 28.1 ms. Drawing on a
canvas is native work, not function calls. **Second correction: a view is
only compared with itself, at other pattern sizes**, and the bar follows
the number of points — r has to clear 0.8 and the 5 % significance level,
which is 0.95 at four points. (Four points reach 0.8 by chance one time
in five.)

Held to that:

| View and sizes | `main`: calls per frame · script ms/s | r, each sweep | `perf`: calls per frame · script ms/s | r, each sweep |
|---|---|---:|---|---:|
| roll visible, 1, 2, 4, 8 layers | 3,757–17,512 · 43.7–138.0 | 0.999, 0.997 | 507–2,540 · 25.4–87.7 | 0.996, 0.998 |
| roll collapsed, 1, 2, 4, 8 layers | 3,062–11,288 · 27.5–48.5 | 0.983, 0.999 | 466–2,216 · 13.3–17.5 | 0.996, 0.993 |
| scope, 1, 2, 4, 8 layers | 3,067–11,272 · 32.4–55.2 | 0.992, 0.995 | 466–2,240 · 16.6–24.0 | 0.999, 0.997 |
| beat grid, 1, 2, 3, 6 drum lines | 1,556–3,405 · 19.6–26.5 | 0.987, 0.983 | 119–413 · 8.8–11.7 | 0.961, 0.966 |

Two sweeps of `main` against `perf`, runs 43966755268 (Xeon 6975P-C) and
43970602936 (EPYC 7763); the ranges are the first sweep's. Sixteen groups
of four points, sixteen above 0.95. The beat grid in the new build is the
closest call (0.961 and 0.966): its script time moves by 3 ms per second
over the whole range, not much more than a runner's noise. The roll also
carried its sizes in six full runs: 0.97–1.00 in both builds each time.

The slope is not one to one. With the roll collapsed, the new build goes
from 466 to 2,216 calls per frame while its script time goes from 13.3 to
17.5 ms per second: most of a frame's script cost does not depend on the
pattern. A ceiling with a 3 % tolerance therefore trips long before the
time has moved much. That is the safe side, and the reason a tripped
ceiling is a prompt to read the timings, not a verdict.

| Count | Evidence | Verdict |
|---|---|---|
| playing: calls per frame, in each of the four 120 Hz views | four pattern sizes per view, r within each build 0.96–1.00, twice | **proven**, view by view: the four proxy ceilings |
| playing: calls per frame, across views | 0.85–0.97 over seven variants; 0.44–0.57 without the heaviest | **thrown out as evidence**: views are not comparable |
| typing: calls per key | three document sizes: r = −0.28 and −0.58; 59,088 calls per key in a 37-line document against 50,310 in a 184-line one, for less time | **thrown out** |
| typing: layouts, DOM mutations, transactions per key | three document sizes prove nothing either way (r from −0.83 to 0.83). Across four points they reached 0.87–0.98, all of it one contrast: typing while a pattern plays against typing while stopped | **not proven**; kept as structural ceilings |
| tabs: calls per operation | r = 0.70 and 0.77 | **thrown out** |
| launch: calls to ready | three points per build; pooled −0.01 to 0.20 | **thrown out** |
| playing: canvas calls, rAF callbacks, transactions | not candidates for a proxy: they hardly vary between sizes or are the work itself | structural ceilings |

The launch count failed in the most useful way. A CPU profile of boot
showed 125 ms of its 446 ms in one function — the sound map being copied
once per registered sound — and removing it changed the call count by
0.4 %. A count cannot see a cost that lives inside one call. The launch
scenario therefore always takes a CPU profile.

That leaves two kinds of ceiling. Four are **proxies**, counts standing in
for time: calls per frame while playing, one per view, each proven against
its own view. The rest are **structural**: counts that are the cost itself,
or work nobody should add without saying so — requests before ready, bytes
of initial JS, asset requests on a repeat launch, DOM size at ready, rAF
callbacks, timers, DOM mutations and calls at rest, layouts and DOM
mutations per keystroke, and, while playing with nothing typed, CodeMirror
transactions per second, rAF callbacks per frame and canvas calls per
frame. A structural ceiling makes no claim about time. Two sets of ceilings
were set up during the lane and withdrawn when the evidence went against
them: calls per tab operation, and calls per keystroke. `raises` is empty
all the same, because `main` never had them.

**Timings need the app at rest.** With the counts settled, two timings
still read slower in the new build while their call counts were identical:
script time for typing while stopped (+2.5 to +11.6 % in eight comparisons
of nine) and the first evaluate under a ×4 CPU throttle (76–99 ms in the
old build, 103–140 ms in the new, in all five runs). The request logs explained both. The
typing, evaluate and tab journeys began the instant boot reported ready, on
top of what the app still does at idle — loading its five lazy panels and,
in the new build, registering the service worker, whose first install makes
some forty requests. The new build is ready sooner, so more of that tail
fell inside its windows: the worker's install landed in the middle of the
typing, and the panel loading in the middle of the throttled evaluate.
Those journeys now wait until the worker controls the page and the last
panel has loaded. In the two runs since, typing while stopped differs by
−6.5 to +2.4 % with either sign, the throttled evaluate by −9 and +14 %,
and the first tab opened costs 30,367–30,371 calls in both builds, where it
had been about 30,380 or about 33,760 depending on whether the tail fell
inside. A timing that differs between two builds whose counts are identical
is a question about the rig first.

**The runner is not one machine.** Runs landed on five CPU models. On the
slowest (a 2.8 GHz Xeon 8370C) the eight-layer variants could not be
stepped at 120 Hz, and because a window that cannot hold its pace was an
error, the whole workflow failed on a variant that carries no ceiling.
Such a window now simply has no number: the summary names it first, and a
ceiling that depends on one fails the check.

Since the frame loop the playback counts are no longer exact to the call:
the measured five seconds are two and a half cycles of the pattern, and
21 to 23 highlight updates fall inside them depending on where they
start, which moves calls per frame by up to 1 %. The ceilings' tolerance
is 3 %.

Heap growth per cycle is reported, not ratcheted: it is still settling
after 120 cycles (§4).

## 4. Before and after

One run, both builds on the same runner (AMD EPYC 9V74 80-Core Processor, 4
cores, Chromium 159.0.8154.6): `main` at `713cb78` against `perf` at
`4b33dae`, perf workflow run 43966669858. Counts first in each table
(exact, comparable with any other run), then timings (this run only;
identical code differs by 10–25 % between page loads, so read a timing
change of that size as noise).

**Frame cost while playing**

A four-layer synth pattern at 0.5 cycles per second, 600 frames stepped at
exactly 120 Hz (Hydra and shader: 300 frames at 30 Hz).

| | Before (`main`) | After (`perf`) | Change |
|---|---:|---:|---:|
| roll visible: function calls per frame | 9,359 | 1,313 | −86 % |
| roll collapsed: function calls per frame | 6,247 | 1,160 | −81 % |
| scope: function calls per frame | 6,253 | 1,163 | −81 % |
| beat grid: function calls per frame | 2,333 | 250 | −89 % |
| Hydra: function calls per frame | 4,019 | 1,548 | −61 % |
| shader: function calls per frame | 6,383 | 2,726 | −57 % |
| roll visible: CodeMirror transactions per second | 120.0 | 4.6 | −96 % |
| roll collapsed: CodeMirror transactions per second | 120.0 | 4.4 | −96 % |
| roll visible: canvas calls per frame | 693 | 692 | −0.1 % |
| roll visible: script ms per second of playback | 104.7 | 68.2 | −35 % |
| roll collapsed: script ms per second of playback | 44.5 | 18.8 | −58 % |
| scope: script ms per second of playback | 53.2 | 25.2 | −53 % |
| beat grid: script ms per second of playback | 27.1 | 11.5 | −58 % |
| Hydra: script ms per second of playback | 18.9 | 11.0 | −42 % |
| shader: script ms per second of playback | 20.8 | 11.8 | −43 % |
| roll visible: main-thread frame, median / ms | 2.3 | 2.0 | −13 % |
| roll visible: main-thread frame, p95 / ms | 3.1 | 2.7 | −13 % |
| eight layers, roll visible: main-thread frame, median / ms | 3.4 | 2.9 | −15 % |
| eight layers, roll visible: main-thread frame, p95 / ms | 4.4 | 3.9 | −11 % |

**Launch**

Milliseconds from navigation start. "Key press handled" is the end of the
task that mounted the editor.

| | Before (`main`) | After (`perf`) | Change |
|---|---:|---:|---:|
| cold: editor in the document | 252 | 244 | −3.1 % |
| cold: key press handled | 276 | 263 | −4.6 % |
| cold: ready to play | 504 | 312 | −38 % |
| cold: main-thread task time to ready | 403 | 211 | −48 % |
| cold, CPU ×4: editor in the document | 698 | 705 | +0.9 % |
| cold, CPU ×4: key press handled | 789 | 788 | −0.2 % |
| cold, CPU ×4: ready to play | 1,708 | 955 | −44 % |
| cold, CPU ×4: main-thread task time to ready | 1,657 | 883 | −47 % |
| cold, +150 ms per response: ready to play | 1,005 | 891 | −11 % |
| second launch: first contentful paint | 80 | 56 | −30 % |
| second launch: editor in the document | 238 | 194 | −19 % |
| second launch: key press handled | 262 | 248 | −5.5 % |
| second launch: ready to play | 461 | 289 | −37 % |
| second launch: asset requests reaching the server | 8 | 0 | −100 % |
| second launch: all requests reaching the server | 15 | 7 | −53 % |
| third launch: first contentful paint | 56 | 40 | −29 % |
| third launch: editor in the document | 236 | 151 | −36 % |
| third launch: key press handled | 259 | 172 | −34 % |
| third launch: ready to play | 462 | 212 | −54 % |
| third launch: asset requests reaching the server | 7 | 0 | −100 % |
| third launch: all requests reaching the server | 14 | 7 | −50 % |
| script requests before ready, cold | 3 | 3 | = |
| initial JS, raw bytes | 1,943,316 | 1,954,775 | +0.6 % |
| initial JS, gzip bytes | 595,796 | 598,782 | +0.5 % |

**Keystroke, tab, evaluate**

The app at rest before each: lazy panels loaded, the service worker in control.

| | Before (`main`) | After (`perf`) | Change |
|---|---:|---:|---:|
| keystroke, stopped: function calls | 50,310 | 50,310 | = |
| keystroke, stopped: layouts | 2.51 | 2.50 | −0.4 % |
| keystroke, stopped: DOM mutation records | 9.76 | 9.75 | −0.1 % |
| keystroke while playing: function calls | 69,136 | 52,237 | −24 % |
| keystroke while playing: CodeMirror transactions | 3.00 | 1.06 | −65 % |
| 103 keys, stopped: script ms | 222 | 227 | +2.4 % |
| 103 keys while playing: script ms | 398 | 350 | −12 % |
| keystroke, stopped: main-thread frame p95 / ms | 2.3 | 2.5 | +8.7 % |
| keystroke while playing: main-thread frame p95 / ms | 4.7 | 4.3 | −8.6 % |
| keystroke, CPU ×4: main-thread frame p95 / ms | 11.6 | 11.7 | +0.4 % |
| tab switch: function calls | 17,857 | 17,856 | < 0.1 % |
| tab switch: task ms | 13.9 | 14.0 | +1.1 % |
| Ctrl+Enter → first scheduled sound, first play / ms | 42 | 32 | −24 % |
| Ctrl+Enter → first scheduled sound, later plays / ms | 7 | 8 | +14 % |
| Ctrl+Enter → first scheduled sound, first play at CPU ×4 / ms | 87 | 99 | +14 % |

Typing while stopped and switching tabs run the same code in both builds,
call for call; what differs between their timings is noise. The first
evaluate is quicker in the new build in both runs made from a settled app
(46 → 36 ms in run 43960892683); under a ×4 throttle the two builds cannot
be told apart (126 → 115 ms in that run).

**Idle and a long session**

| | Before (`main`) | After (`perf`) | Change |
|---|---:|---:|---:|
| idle, 10 s: function calls | 90 | 90 | = |
| idle, 10 s: rAF callbacks | 0 | 0 | = |
| idle, 10 s: timers fired | 11 | 11 | = |
| heap after GC at idle / bytes | 10,836,764 | 10,888,636 | +0.5 % |
| heap growth per evaluate/stop cycle, cycles 40–120 / kB | 3.6 | 4.3 | +17 % |
| DOM node growth over those cycles | 0 | 0 |  |
| listener growth over those cycles | 2 | 1 |  |

The heap slope reads 0.4–0.7 kB per cycle higher in the new build in every
run. A heap census (run 43946835569) puts the difference in compiled code —
117 optimised functions gained over those 80 cycles against 90 — while
objects, strings and numbers grow alike in both builds. No detached DOM;
listener and node counts wander by a few between samples and do not grow.
Neither build's heap is flat after 120 cycles (2.3–4.0 kB per cycle over
the last twenty).

## 5. What changed

Roughly in the order of `git log main..perf`:

1. **`perf(boot)` — sounds registered without copying the sound map.**
   superdough registers each sound with `soundMap.setKey`; the nanostores
   map behind it rebuilt the whole object per key, quadratic over the
   ≈1,850 sounds boot registers. `src/sound-map-batch.js` writes in place.
2. **`feat(pwa)` — the service worker.** §7.
3. **`ci(perf)` — the rig, the ratchets, `scripts/ci-run.mjs`.**
4. **`perf(playback)` — strasbeat's own frame loop.** Strudel's `Drawer`
   re-read every visible note's timing through `Fraction`-building getters
   on every frame, queried the pattern for a few milliseconds' slice every
   frame, and the editor dispatched a CodeMirror transaction every frame to
   re-highlight notes that had not changed. `src/hap-window.js` keeps the
   notes with numeric times and queries a sixth of a second at a time;
   `src/frame-loop.js` highlights only when the set of sounding source
   locations changes. The window is tested frame by frame against the real
   upstream `Drawer`.
5. **`perf(editor)` — Prettier in a worker.** Formatting blocked the main
   thread for 258 ms the first time and 62 ms afterwards on the
   maintainer's machine. The page now posts the text to a worker and
   applies the answer; the output is byte-identical.
6. **`fix(playback)` — a zero tempo.** `setcps(0)` made the new loop's
   window ask for a slice of no length and throw on every frame; found in
   review, fixed, tested.
7. **`ci(perf)`, four times — what measuring taught about measuring.**
   Correlation judged within each build; interaction journeys started
   from a settled app; a view judged only against itself, with the sweep
   that does it; a slow runner no longer failing the run. §3 is the
   account. The last of them lowers the ceilings to the settled numbers.
8. **`ci` / `docs`** — the `perf` branch kept off Vercel; this record and
   the documentation.

## 6. Ratchets

`.github/perf/ratchets.json`, checked by the perf workflow, and by
ordinary CI for the `bundle.*` keys. The current ceilings:

| Ceiling | Max | Tolerance | Unit | Kind |
|---|---:|---:|---|---|
| `bundle.default.initialCssGzip` | 25,623 | 1 % | bytes | structural |
| `bundle.default.initialCssRaw` | 191,691 | 1 % | bytes | structural |
| `bundle.default.initialJsGzip` | 597,188 | 1 % | bytes | structural |
| `bundle.default.initialJsRaw` | 1,949,220 | 1 % | bytes | structural |
| `idle.default.calls` | 90 | 10 % | calls per 10 s | structural |
| `idle.default.mutations` | 0 | exact | mutation records per 10 s | structural |
| `idle.default.raf` | 0 | exact | rAF callbacks per 10 s | structural |
| `idle.default.timers` | 11 | 10 % | timers per 10 s | structural |
| `launch-cold.default.ready.network.Document.requests` | 1 | exact | requests | structural |
| `launch-cold.default.ready.network.Fetch.requests` | 8 | exact | requests | structural |
| `launch-cold.default.ready.network.Script.requests` | 3 | exact | requests | structural |
| `launch-cold.default.ready.nodes` | 1,880 | 2 % | DOM nodes | structural |
| `launch-warm.third.serverByClass.assets` | 0 | exact | requests | structural |
| `playing.beats.callsPerFrame` | 248.43 | 3 % | calls per frame | proxy (proven) |
| `playing.collapsed.callsPerFrame` | 1,154.7 | 3 % | calls per frame | proxy (proven) |
| `playing.roll.callsPerFrame` | 1,312.9 | 3 % | calls per frame | proxy (proven) |
| `playing.roll.canvasPerFrame` | 691.89 | 1 % | canvas calls per frame | structural |
| `playing.roll.rafPerFrame` | 2.04 | 2 % | rAF callbacks per frame | structural |
| `playing.roll.transactionsPerSecond` | 4.6 | 15 % | transactions per second | structural |
| `playing.scope.callsPerFrame` | 1,159.73 | 3 % | calls per frame | proxy (proven) |
| `typing.default.perKey.layouts` | 2.51 | 1 % | layouts per key | structural |
| `typing.default.perKey.mutations` | 9.75 | 1 % | mutation records per key | structural |
| `typing.default.perKey.transactions` | 1 | exact | transactions per key | structural |

To update after a win: run `node scripts/ci-run.mjs perf`, take the
`results.json` of the artifact it downloads, run
`node .github/perf/ratchet.mjs lower results.json`, and commit the file
with the change. A ceiling can only be raised by listing its key in
`raises` with a reason; the workflow's `guard` step fails otherwise. A new
proxy ceiling needs its count called proven first, in its own view:
`node scripts/ci-run.mjs perf --scenarios sweep`.

The initial JS of the final build is 1,954,775 bytes raw and 598,782
gzipped, 0.3 % over its two ceilings and inside their 1 % tolerance: the
ceilings were set before the frame loop and the format client were added,
and a ceiling is not raised to follow the code. About 14 kB of headroom is
left before ordinary CI fails and somebody has to decide.

## 7. Service worker

What it does, and the rules a change must keep, are in
`docs/architecture.md` ("Service worker, updates and offline"). In short:
the app shell and every hashed file except the csound and xen chunks are
precached (3.6 MB raw, 30 files); the eight default sample manifests are
served stale-while-revalidate, so boot no longer waits on the network;
default sample audio is cached on first use, 256 files at most.

Verified end to end on a runner by `.github/smoke/sw.mjs`, with a static
server whose "deploy" can be swapped under a running page:

| Phase | What was asserted |
|---|---|
| First visit | a worker installs and takes control; the precache holds the shell and the entry script, nothing opaque, the two opt-in chunks absent |
| Second launch | no request for `/`, `index.html` or any asset reaches the server |
| Offline launch | server down: the editor mounts, boot reaches "Ready to play" from cached manifests, a synth pattern starts, a lazy panel opens; only the browser's own `sw.js` update check reaches for the network |
| Update | a new deploy is detected and waits; the notice appears; the running page keeps loading the old build's chunks; "Reload to update" reloads once into the new build; a second window on the old build is not reloaded and keeps its chunks |
| No pinning | with a newer deploy waiting and nothing clicked, closing the app and opening it again shows the new build |
| Deployable kill switch | a `STRASBEAT_SW=off` build: the worker unregisters, every `strasbeat-` cache is gone, the page reloads from the network |
| Per-browser switch | `/?sb-sw=off` unregisters and is remembered; `/?sb-sw=on` restores |

**Emergency procedure.** Set `STRASBEAT_SW=off` in Vercel's production
environment and redeploy, or commit that line in `.env.production`. Leave
it deployed long enough for installed apps to launch once. Never delete
`/sw.js`: a stale installation has to be able to fetch its replacement.

## 8. Flags

`src/flags.js`: `?sb-<name>=off` turns a thing off for one browser and
remembers it; `?sb-<name>=on` forgets.

| Flag | Kind | State at the end of the lane |
|---|---|---|
| `sw` | safety switch | permanent |
| `frameloop` | ramp | **still in.** Off selects the upstream `Drawer` path (`src/legacy-drawer.js`). To be removed, with that file, once the two have been compared on a real display (`PL-1`) |

## 9. The stray Vercel preview

A Preview deployment existed for commit `6f2ade0`, a `wip:` commit pushed
to a `ci/smoke-*` branch, although `vercel.json` disables deployments for
`ci/**`. Cause: `6f2ade0` sits on `03ba08c`, whose `vercel.json` has no
`git.deploymentEnabled` block — the guard only exists from `15c8bf9` on —
and Vercel reads that file from the commit that is pushed. Every other
`ci/*` push of that session carried the guard and deployed nothing.

A setting at project level would be the complete fix, but the Vercel
account available on the maintainer's machine cannot see the project, so
the fix is in the repository: `scripts/ci-run.mjs` refuses to push a commit
without the guard and checks afterwards that no deployment appeared, and an
old commit is measured by passing it as `--base` (checked out on the
runner, never pushed). Verified: the lane pushed commits to `ci/*` branches
more than twenty-five times and pushed `perf` itself, and `gh api
repos/Coriou/strasbeat/deployments` still ends with deployment 7832806844
(Production, `713cb78`), made before the lane's first push;
`…/deployments?sha=<commit>` is empty for every commit on `perf`. The stray
preview is in the same list (7829739104, Preview, `6f2ade0`), so the list
does show such a deployment when one exists.

`vercel.json` also carries `"perf": false`, so that pushing the lane's own
branch creates no preview either. It has no purpose once the branch is
merged and deleted (`PL-9`).

Optional hardening, for the maintainer, in the Vercel dashboard: Project →
Settings → Git → Ignored Build Step, with a command that exits 0 (skip)
when `$VERCEL_GIT_COMMIT_REF` starts with `ci/`. It applies whatever the
pushed commit contains.

## 10. Looked at and not done

Each with the number that decided it; the open ones are in `OPEN.md`.

- **A static copy of the editor before the bundle** (`PL-5`). The gap it
  would hide is about 140 ms cold and 110 ms warm on a runner.
- **Yielding after the editor mounts** (`PL-4`): about 50 ms on a runner.
- **The frame loop taking its notes from the audio scheduler** (`PL-2`):
  an estimated 250–400 of the remaining ≈1,150 calls per frame.
- **Batching the piano roll's canvas calls** (`PL-3`): ≈690 calls per frame.
- **WAV encoding in a worker** (`MX-18`), **vendor chunks** (`BD-8`):
  unchanged, with the lane's reasoning added to their rows.
- **Autocomplete scoring, MIDI parsing, transpilation off the main
  thread:** not worth a worker. Completions cost 38 calls of a keystroke's
  50,300; MIDI parsing only runs on import; Ctrl+Enter to the first
  scheduled sound is already 32–36 ms on first play and 7–10 ms
  afterwards.
- **Typing** (`PL-6`): 95 % of a keystroke is CodeMirror and Lezer.
- **Tab switches:** 17,856 calls, of which strasbeat's own code is ≈600;
  the rest is CodeMirror drawing the other document.
- **Memory:** no leak found. Over 120 evaluate/stop cycles the heap's
  growth decays from about 11 kB per cycle to 2.3–4.0; a heap census of
  the last 80 cycles is mostly V8's compiled code (`InstructionStream`
  and friends), with no detached DOM and no listener growth. The new
  build gains more of that code (it has more of it that is hot) and the
  same amount of everything else. The 15 kB per cycle the audit measured
  over 30 cycles (PF-3) was the start of that curve.
- **Desktop shell readiness:** the one platform-specific thing this lane
  added, updates and offline, is one module (`src/app-update.js`) that a
  shell would replace. File I/O, storage, MIDI and deep links were not
  touched and have no new seams.

## 11. Run log

All on GitHub-hosted runners (`ubuntu-24.04`, Playwright 1.65.1, Chromium
159). Throwaway `ci/*` branches were deleted after each run; a cancelled
run is noted as such.

| Run | What | Result |
|---|---|---|
| 43932228561 | probe 1 (throwaway): begin-frame control under Playwright; count determinism | works; 3,733,498 vs 3,731,887 calls per 600 frames; software GL stalls seen (cancelled once read) |
| 43933639694 | probe 2: what the stalls are; `--disable-gpu`; in-page frame time | GPU-process raster under SwiftShader; without a GPU the pace holds exactly |
| 43934772030 | probe 3: census of boot, playback and typing on `main`, through source maps | sound registration 125 ms of 446 ms boot CPU; 9,300 calls per frame, 4,554 of them `fraction.js` |
| 43936744067, 43936744013 | CI and smoke on the boot fix | green, 71/71 |
| 43938724987 | smoke on the service worker, first pass | lifecycle phases 1–2 pass; an assertion counted the browser's own `sw.js` update check as traffic (test fixed) |
| 43939670060 | second pass | every lifecycle phase passes; five 404s from a page of another "deploy" the test had left open (test fixed) |
| 43940671291, 43940670945 | CI and smoke on the service-worker commit `c7b4e15` | green, 71/71 and all lifecycle phases |
| 43940986863 | rig, first run | every navigation was a download: the rig's server sent `/` as `application/octet-stream` (fixed) |
| 43941395639 | rig, first full run: `main` against the tree with the boot fix and the service worker | 84 of 92 measurements; the two WebGL modes cannot hold 120 Hz in software (now stepped at 30 Hz) |
| 43943719402, 43943719319 | CI and smoke with the frame loop | green, 77/77 |
| 43945472121, 43945472276 | CI and smoke with formatting in a worker | green, 88/88 |
| 43946835569 | memory soak with a heap census | growth is V8 compiled code and the rig's own frame records (the latter switched off) |
| 43946265819 | full run with everything | 89 of 92; the 16-layer variant cannot hold 120 Hz in the count pass on a slower runner (dropped) |
| 43950824723 | CI on `b78fd4e` (rig), through `scripts/ci-run.mjs` | green |
| 43950841863 | CI on `d6520bb` (frame loop) | green |
| 43950861833, 43950861710 | CI and smoke on `d768613` (format worker) | green, 88/88 and all lifecycle phases |
| 43950870304, 43950870139 | CI and the perf workflow on `d768613` | green; all 27 ceilings held |
| 43954877971, 43954878018 | CI and smoke on `51b556b` (correlation within each build) | green, 88/88 and all lifecycle phases |
| 43954869413, 43954869536 | CI and perf on `51b556b` | green; calls per keystroke and per tab operation not proven |
| 43955270324, 43955270261 | CI and smoke on `a5187c2` (zero tempo) | green, 88/88 and all lifecycle phases |
| 43955248457, 43955248590 | CI and perf on `a5187c2` | green; typing and the throttled evaluate slower in the new build with identical counts, which led to the settle step |
| 43960892384, 43960892683 | CI and perf on `99b0bd0` (journeys from a settled app) | all 23 ceilings held; the workflow failed because four evidence windows could not hold their frame pace on a 2.8 GHz runner |
| 43966669877, 43966669858 | CI and perf on `4b33dae` (a view judged against itself; slow runners) | green; all 23 ceilings held; the source of §4 |
| 43966671205, 43966755268 | CI and the sweep on `4b33dae` | green; calls per frame proven in each of the four views |
| 43970533932, 43970602936 | CI and the sweep again | green; the same verdicts on another CPU model |

The commit that added this record changed the ceilings file and
documentation only. The workflows were run on it once more before the
branch was pushed; those run IDs are in the hand-over, since a record
cannot hold the IDs of runs made on the commit that contains it.
