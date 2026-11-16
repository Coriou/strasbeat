# strasbeat architecture and subsystem invariants

The rules below were mostly learned from bugs that produced no error. Read
the section for the subsystem you are about to touch; `AGENTS.md` has the
table that says which one. Everyday rules (commands, commits, verification)
are in `AGENTS.md`, not here.

Sections: [Overview](#overview) · [Pattern file contract](#pattern-file-contract) ·
[Boot and sound names](#boot-and-sound-names) ·
[Bundle and lazy loading](#bundle-and-lazy-loading) ·
[Service worker, updates and offline](#service-worker-updates-and-offline) ·
[Flags](#flags) ·
[Strudel extensions and the docs index](#strudel-extensions-and-the-docs-index) ·
[Bottom canvas and docSync](#bottom-canvas-and-docsync) ·
[Responsive layout and keyboard models](#responsive-layout-and-keyboard-models) ·
[WAV export](#wav-export) · [Visuals lifecycle](#visuals-lifecycle) ·
[Persistence](#persistence) · [The single-quote rule](#the-single-quote-rule) ·
[MIDI](#midi) · [Tempo](#tempo) · [Dev server](#dev-server) ·
[CI and the smoke test](#ci-and-the-smoke-test) ·
[Performance rig and ratchets](#performance-rig-and-ratchets) · [Console helpers](#console-helpers)

## Overview

`index.html` → `src/main.js` boots a `StrudelMirror` (from
`@strudel/codemirror`) into `#editor`, auto-discovers `patterns/*.js` via
`import.meta.glob`, and wires every panel and toolbar button together. The
heavy lifting is split into focused modules: `boot.js` runs the prebake
state machine (evalScope, soundfonts, the default sample maps listed in
`default-samples.js`), `eval-feedback.js`
monkey-patches `editor.evaluate`/`editor.stop` with request sequencing,
error tracking, sound validation, and silence detection (the pure rules
live in `eval-state.js`), `panels.js` registers the six right-rail panels
(Learn, Sounds, Reference, Console, Export, Settings — package and sample
setup lives inside Settings; only the console is in the entry chunk, the
other five load on first open through `ui/lazy-panel.js`), `capture.js`
owns the
MIDI capture preview modal, `export.js` handles WAV rendering, `share.js`
the URL codec and share-link arrival, and `command-palette-actions.js`
maps keyboard shortcuts to commands. `storage-guard.js` is imported first
by `main.js` so a browser with unusable localStorage still boots.

`editor.evaluate()` resolves to `{ status, started, owner }` — `status` is
`ok`, `error`, `empty`, `blocked` (a WAV export owns the audio context),
`superseded` or `cancelled` — because the repl swallows eval errors and
callers must be able to tell "evaluated" from "kept the previous pattern".
The repl is always called with autostart off; the patched evaluate starts
the scheduler itself, and only for the request that is still the latest.
Evaluates run one at a time (two inside the repl at once corrupt its `$:`
table and the arrange registry — every `$:` layer plays twice), the latest
wins, and `editor.stop()` cancels whatever is waiting. An evaluate a stop
abandoned is still inside the repl, so the next request waits for it, for
at most `ABANDON_WAIT_MS` (`eval-state.js`). The editor is built with
`autodraw: false`; `main.js` calls `drawFirstFrame()` itself and hands the
promise to the sequencer, so a play pressed during boot waits for that
evaluate too. New code that evaluates should call
`editor.evaluate()`, not `editor.repl.evaluate()`; the two deliberate
exceptions are the scrubber's live evaluate (`editor-setup.js`, which
brackets the arrange state itself and only runs while this tab is
playing) and the capture preview (`capture.js`, which plays a take without
touching the buffer).

The shell is a design-system layout (top bar with brand + pattern menu +
share/settings, left rail patterns library, tab strip + editor canvas,
transport bar with cps/bpm + cycle + playhead + MIDI pill, and a
collapsible bottom panel whose modes are Roll, Scope, Beat grid, Visuals
and Custom). It has three layouts by viewport width — see "Responsive
layout and keyboard models" below. The editor is extended with a Prettier-based formatter, a
VSCode-style keymap, a Figma-style numeric drag-to-scrub, an autocomplete
chain (sounds / banks / chords / scales / modes / functions /
mini-notation), hover docs, and a signature hint pill — all CodeMirror 6
extensions layered on top of `StrudelMirror`. Browser prompts are
replaced by an in-app `modal.js`, and a settings popover
(`settings-drawer.js`) hosts an OKLCH accent picker persisted to
localStorage.

`src/midi-bridge.js` listens on Web MIDI directly, routes noteons through
`superdough()` (the same one-shot audio entry point Strudel's pattern engine
uses), and supports a "capture phrase → save as pattern file" workflow.
MIDI files are read by `src/midi-smf.js` (not a library) and translated by
`src/midi-to-strudel.js`.

`src/strudel-ext/` is the home for runtime helpers strasbeat layers on
top of Strudel's pattern language. See the dedicated section below.

`patterns/*.js` are the user's compositions — see "Pattern file contract".

## Pattern file contract

```js
// patterns/05-dub.js
export default `setcps(70/60/4)

stack(
  s("bd ~ ~ ~"),
  s("~ ~ sd ~").room(0.8).delay(0.5),
)
`;
```

The whole tune is a string (not an expression) because Strudel's transpiler
rewrites things like `"bd sd"` into mini-notation calls before evaluation —
the source text is the input to the transpiler. Wrapping it in
`export default \`…\`` keeps the file a normal JS module so
`import.meta.glob` can discover it. Adding a new file → it shows up in the
dropdown automatically (Vite HMR triggers a page reload).

## Boot and sound names

### Sound names are not 1:1 with General MIDI

Strudel's soundfont names have been shortened from the official GM-128 list.
It's `gm_piano`, *not* `gm_acoustic_grand_piano`. It's `gm_pad_warm`, *not*
`gm_pad_2_warm`. Always verify a name resolves before pasting it into a
pattern:

```js
strasbeat.findSounds('piano')   // names containing "piano"
strasbeat.hasSound('gm_piano')  // true / false
strasbeat.countSounds()         // total registered sounds (~1,850)
```

If you write `sound("not_a_real_name")`, the pattern produces **no audible
events with no error**. The MIDI bridge surfaces unknown preset sounds as a
console warning (`[midi] preset "X" uses sound "Y" which is not in the
loaded soundMap`) — copy the same defensive style if you add new
synthesis/sample features.

### What boot loads, and who owns a sound name

Boot registers what strudel.cc's own REPL registers by default: synths,
ZZFX, the GM soundfonts, dirt-samples, tidal-drum-machines (plus its
alias table, so `.bank("tr909")` works as well as `.bank("RolandTR909")`),
uzu-drumkit, and the piano, VCSL, wavetable (`wt_*`) and mridangam maps.
Only manifests are fetched; audio loads on first use. The maps are data
in `src/default-samples.js`, including the drum-machine URL and base used
by `boot.js`; each has its own 15 s timeout and a sentence saying
what goes silent if it fails (`getBootFailures()`). The soundfont helpers (`loadSoundfont`, …) are in
pattern scope. Nothing here is opt-in any more — the opt-in packages in
Settings are xen, midi, osc, csound and serial.

**Registering a sound must stay O(1).** superdough registers each sound
with `soundMap.setKey`, and the nanostores map behind it copies the whole
map for every key — quadratic over the ~1,850 sounds boot registers.
`src/sound-map-batch.js` replaces `setKey` (installed by `createBoot`,
before the first registration) with one that writes in place and gives
listeners one fresh object per burst. `soundMap.get()` readers are
unaffected. Its test runs against the installed store, so a superdough or
nanostores upgrade that changes the store's shape fails there.

**Name precedence:** several maps define the same names — `bd sd hh cp cb
cr ht lt mt` (dirt-samples and uzu-drumkit) and `sax` (dirt-samples and
VCSL). dirt-samples wins every name it shares, whatever order the
manifests arrive in (`createNamePrecedence`: the owner `claim`s its
names, every other map registers through `yieldTo`). That differs from
strudel.cc, where `bd` is uzu-drumkit, and it is deliberate: existing
patterns index dirt-samples' larger folders (`bd:7`). A new default map
must register through `names.yieldTo(...)`; the alias table must be
applied after the drum-machine map is in (`aliasBank` walks the sounds
registered so far).

**Default drum kit:** dirt-samples owning the nine drum names is the
default, not the only option. `src/drum-kit.js` holds the choice
(`localStorage["strasbeat:drum-kit"]`: `classic` | `strudel`): once every
default map is registered, a stored `strudel` re-registers just the shared
names from uzu-drumkit's manifest (`applyStored`, before the user setup so
user samples still win), and `setKit` does the same at any time — a
registration only records URLs, so the switch is immediate and the WAV
export, which renders through the same sound map, follows. The control is
Settings → Samples; `strasbeat.drumKit()` shows what is in force. The
first time a pattern that is actually playing uses one of those names
without a `.bank(...)`, a one-time card (`src/ui/drum-kit-nudge.js`) says
which kit it is and offers the switch: `eval-feedback.js` reports the
onsets of every started play through `onPlayed`, and the controller's
`notePlayed` decides. It never shows at boot, for a silent evaluate, to
someone who has already chosen, or when the other kit failed to load.

`slider()` / `sliderWithID` are imported from the `@strudel/codemirror`
entry, the same module instance the editor uses — a second copy has its
own value store and never hears the widgets.

## Bundle and lazy loading

The entry chunk holds what is needed to paint the editor and take a
keystroke. Loaded on demand, each as its own chunk:

- **the docs index** (`strudel-docs.json`, ≈200 kB) — right after the
  editor mounts. Read it through `getDocs()` in `src/editor/docs-store.js`
  at the moment of use (it is `{}` until the chunk lands), or subscribe
  with `onDocsLoaded` if you derive something from it once. Never import
  the JSON directly;
- **five panels** (Learn, Sounds, Reference, Export, Settings) — on first
  open, warmed at idle after boot. `createLazyPanel` hands out a handle
  at once; calls made before the module loads are remembered (latest per
  method) and replayed, and one-shot requests are dropped if the load
  fails. The console stays eager: it is where errors are shown;
- **the Vim and Emacs keymaps** — when that profile is selected or is the
  stored one. Until the chunk is in, the editor is on its base keymap and
  the keymap chip says LOADING or RETRY rather than naming a mode;
- **Prettier** — only inside the dedicated formatting worker, started on
  the first format command (never during launch) and reused for the session.
  Its static imports and quote-restoration pipeline live in
  `src/editor/format-core.js`, shared with Node tests;
- as before: hydra-synth and the opt-in packages.

Rules:

- **Formatting never falls back to the main thread.** `format.js` only
  posts text and applies replies. The client ignores superseded replies;
  `runFormat` still checks document identity before applying a result.
  Worker creation, runtime/message errors and a 15-second timeout fail
  loudly in the console and status line with a reload instruction. The
  worker is discarded so the next command retries; parse errors retain
  Prettier's message and do not discard the worker. `workerOnlyPrettierPlugin`
  checks all page chunks, including lazy ones, for modules from the
  `node_modules/prettier/` package and fails the build if any leak in.
- **The formatting worker must be one self-contained classic/IIFE file.**
  Keep Vite's default worker format and static imports, with no runtime
  chunk fetches. Retired service-worker assets are leased to the old window,
  so the window can request its worker file after an update; imports made
  from inside the worker would not share that lease. The worker asset is
  precached once by the existing `/assets/*` rule. Dev alone uses a module
  worker because Vite serves unbundled source there and unregisters the
  service worker; production always constructs a classic worker.
- **Every new on-demand `import()` goes through `lazyImport`**
  (`src/lazy-import.js`), with the `import()` literal at the call site. A
  chunk fetch fails when the network is gone or a deploy has replaced the
  hashed file; `lazyImport` reports that in the status line and console
  and rethrows, and caches nothing, so calling again retries. Wrap with
  `once()` to share one in-flight load.
- **`@strudel/codemirror` is built from its source modules**, not its
  prebuilt bundle (`resolve.alias` in `vite.config.js`). The prebuilt
  file inlines upstream's ≈540 kB `doc.json` and statically imports Vim
  and Emacs; from source, `doc.json` resolves to an empty list (safe
  because strasbeat replaces upstream's autocomplete; upstream's
  Ctrl+hover tooltip consequently shows nothing) and the two keymap
  packages resolve to `src/editor/lazy-keymaps.js`. Always import the bare
  `@strudel/codemirror` specifier so every import lands on the one copy.
- **An upgrade of `@strudel/codemirror` is checked twice.** The redirects
  match upstream's import specifiers by name, so a release that moves them
  would otherwise build fine with everything back in the entry chunk. The
  plugin fails a production build when a redirect never fired or when a
  keymap package or `doc.json` is in a chunk loaded up front, and
  `src/strudel-codemirror-shape.test.js` reads the installed sources for
  what the build cannot see (what is read from the docs stand-in, how `Vim`
  is called, dependencies missing from `optimizeDeps.include`). When either
  fails after an upgrade, update the plugin and `lazy-keymaps.js` together.
- **The `optimizeDeps.include` list is required, not a warm-up.** The
  package is excluded from pre-bundling so the plugin redirects apply in
  dev too; the dependencies only it imports must then be listed, or dev
  serves them raw and loads a second copy of `@lezer/*`. When upstream's
  source gains a dependency strasbeat's own code does not import, add it.
- **Strudel packages must stay singletons.** A second `Pattern` class
  breaks `instanceof` and `register` silently. Do not add a
  `manualChunks` function that sweeps `node_modules` into a vendor chunk:
  it would also pull the lazy-only packages into the initial graph,
  evaluate before `storage-guard.js`, and cycle with the entry's
  top-level await.
- **`storage-guard.js` stays the first import of `main.js`.**
- escodegen's `source-map` dependency is stubbed in the production build
  (Strudel's transpiler never asks for a source map; the stub throws if
  that changes). `/assets/*` is served `immutable` (`vercel.json`).

## Service worker, updates and offline

`src/app-update.js` is the web adapter a desktop shell would replace.
Production registers `/sw.js` at scope `/`, with `updateViaCache: "none"`,
after `bootPromise` and an idle callback (5 s timeout; a 1 s timer when
idle callbacks are unavailable). Dev unregisters it. A registration or
install failure is warned in the console and the status line; a failed
check for updates only in the console, because launching offline is a
supported state. None of them rejects boot or stops playback. Unsupported
browsers keep using the network normally.

**The build identifier** (`window.strasbeat.buildId`, Settings → About) is
a hash of the names of the build's hashed files, written into `index.html`
as `<meta name="strasbeat-build">`. It is deliberately not the commit and
not inside a hashed script: a commit that changes no shipped byte must
build a byte-identical site, or every documentation push would give each
installed app a new worker, a new entry chunk to download and an "update
ready" notice. `STRASBEAT_BUILD_ID` overrides it and is also compiled into
the entry chunk; it exists for the lifecycle test, which needs two builds
of one source to differ. Leave it unset for real deploys.

The Vite plugin in `src/sw/plugin.js` emits a self-contained classic script
from `src/sw/worker.js`, using Vite's public `build()` API. It injects the
precache list, revisions, all asset URLs, and a hash of the sorted precache
list. Hashed asset names are their own revisions; HTML and public icons
are content-hashed. It precaches `/index.html`, the manifest, six icons,
and all `/assets/*` except files over 512 KiB used **only** by the opt-in
csound/xen graphs (including their dynamic dependencies). Currently this
excludes the roughly 3.5 MB csound engine and 1.1 MB xen chunk. Shared code
and the entry remain required. Missing HTML, entry or icons, a missing
expected opt-in exclusion, a required asset above 3 MiB, or a total above
5 MiB (it is 3.5 MiB in 32 files today) fails the build. The build
logs the actual count, raw bytes and excluded files; review that output
when changing dependencies. Source maps (`vite build --sourcemap`, as the
performance rig builds) are never precached. Installing takes a hashed
file from any cache that already holds it, or from the HTTP cache, so an
update downloads what changed rather than every chunk again; the unhashed
shell files are always fetched from the network.

Caching rules (GET only, never Range requests):

- Root and `/index.html` navigations, including shortcut/share queries,
  use the cached HTML. Other navigations pass through. Precached URLs are
  cache-first; a missing entry falls back to network.
- Other `/assets/*` are cache-first in a runtime cache. All ordinary lazy
  panels are already precached, so an open page keeps its own chunks across
  a deploy while the replacement waits. Excluded opt-in chunks are available
  offline only after use; an unfetched old opt-in chunk can disappear at a
  deploy and still produces the existing lazy-import error.
- The **eight** default JSON URLs (seven maps plus the drum alias table)
  come only from `DEFAULT_MANIFESTS` in `default-samples.js`. They use
  stale-while-revalidate. Install warms them too, because initial boot ran
  before registration; a failed warm-up warns without blocking shell
  installation. Offline readiness requires these manifests to have loaded.
- Default audio is cache-first, with 256 entries, oldest insertion out
  first; bodies advertised above 16 MiB by Content-Length are skipped.
  Concurrent writes/pruning are serialized. This is an entry bound, not a
  disk-byte quota: missing Content-Length is permitted. Allow-listed bases
  are raw.githubusercontent.com's `tidalcycles/dirt-samples/`,
  `tidalcycles/uzu-drumkit/`, `ritchse/tidal-drum-machines/` (case-insensitive
  paths), `https://strudel.b-cdn.net/`, and
  `https://felixroos.github.io/webaudiofontdata/sound/`. Other JSON URLs,
  user packs, shabda, analytics and APIs pass through.
- Only successful, non-opaque, non-206 responses may be cached. A failed
  shell install leaves the previous worker active. Cache storage can be
  evicted by the browser; it is not a backup for compositions.

**Lifecycle invariants:** every cache name starts with `strasbeat-`.
`sw.js` must never be intercepted or stored in a cache, and its hosting
header stays `no-cache`. Registration explicitly checks for updates on
launch, then hourly while visible and on returning after an hour. Normal
install must **never** call `skipWaiting()`. A waiting worker offers a
polite notice without taking focus; it waits behind the drum-kit card.
Only "Reload to update" posts `SKIP_WAITING`, and the requesting page
reloads once on `controllerchange`. Dismissal leaves the worker waiting;
closing every app window permits activation without a click. Activation
removes other versioned precaches, prunes runtime assets outside the new
build, preserves manifests/audio, and claims clients. Before pruning, it
retains
old assets under `strasbeat-retired-*`, leased to the IDs of windows still
open. Only those windows can read them, so another window's update cannot
strand an old lazy import. Navigation/activation reclaims retired caches
when their last owning window has gone. No other window auto-reloads.

**Emergency deployment:** set `STRASBEAT_SW=off` in Vercel's production
environment and redeploy (or commit `STRASBEAT_SW=off` in `.env.production`
and deploy that commit). The resulting `/sw.js` immediately activates,
deletes every `strasbeat-` cache, unregisters itself, and navigates each
window to its own URL. The off build's page also skips registration and
cleans up. Leave this build deployed long enough for installed users to
reconnect. Remove the environment variable/committed line and redeploy to
restore normal registration. Never remove `/sw.js` as the emergency fix:
stale installations must be able to fetch its replacement. The emergency
reload deliberately interrupts running sessions.

**Per-browser escape hatch:** open `/?sb-sw=off`. This records `off` under
`localStorage["strasbeat:flag:sw"]`, unregisters, deletes only our caches,
and reloads a controlled page once to release the old controller. Future
launches stay on the network. `/?sb-sw=on` clears the override. If storage
is blocked, the URL flag still applies to this visit; it cannot promise
persistence. Neither switch deletes patterns or other localStorage data.

## Flags

A change that could need switching off on a real machine goes behind a
per-browser flag (`src/flags.js`): `?sb-<name>=off` turns it off and
remembers that in `localStorage["strasbeat:flag:<name>"]` (an installed
app has no address bar), `?sb-<name>=on` forgets it. A flag is temporary
unless it is a safety switch: remove it, and the path it keeps alive, once
the change has proven itself.

| Flag | Default | Off means | Kind |
|---|---|---|---|
| `frameloop` | on | upstream Drawer and per-frame highlighting (reload required) | temporary — remove with the legacy path after comparison on real hardware |
| `sw` | on | no service worker in this browser: unregister, delete strasbeat's caches, load from the network | safety switch, permanent |

## Strudel extensions and the docs index

`src/strudel-ext/` holds the runtime helpers strasbeat layers on top of
Strudel's pattern language. The mechanism is dead simple:
`src/boot.js` passes `strudelExt` (a namespace import of
`src/strudel-ext/index.js`) as one of the arguments to `evalScope()`,
the same call that wires `@strudel/core`, `@strudel/mini`,
`@strudel/tonal`, etc. So everything re-exported from
`src/strudel-ext/index.js` becomes a global inside pattern code with no
extra import — exactly like `note`, `s`, `chord`.

To add a new helper: drop a file under `src/strudel-ext/`, re-export it
from `index.js`, and it's available in every pattern file on next reload.
Add a `/** ... */` JSDoc block with `@param` and `@example` tags directly
above the exported function — `pnpm gen:docs` (alias for
`node scripts/build-strudel-docs.mjs`) will pick it up and add it to
`src/editor/strudel-docs.json` so it appears in hover docs, signature
hints, autocomplete and the Reference panel. Run `pnpm gen:docs` after
adding or changing the JSDoc and commit the updated JSON alongside the
code. For internal helpers that pattern authors shouldn't call directly,
use `// comments` (not `/** */`) or add `@noAutocomplete` to the JSDoc.
Add the helper's test file to the `test` script in `package.json`, and
document the helper in `STRUDEL.md` under "Strasbeat extensions".

**The docs index describes what the installed packages can run.**
`pnpm gen:docs` first collects every callable name from the runtime scope
(`scripts/strudel-scope.mjs` imports the installed packages the way
`boot.js` does, plus each opt-in package), and only then looks for JSDoc:
in `src/strudel-ext/`, then in the sources shipped in `node_modules`, and
last in the `strudel-source/` clone — which may contribute text for a
name that exists here, never a new name. Upstream `main` runs ahead of
the published packages, so unreleased functions stay out until a release
ships them; entries from opt-in packages carry a `requires` hint. The
script exits 1 (leaving the JSON untouched) when `strudel-source/` is
missing. `src/editor/strudel-docs.test.js` fails if the committed index
names something that is not callable — expect it after a package upgrade,
and regenerate.

Anything you put here is *strasbeat-specific* — it doesn't exist in
upstream Strudel and won't show up in `strudel.cc/learn/`. Reflect that
in the docs (STRUDEL.md "Strasbeat extensions" section, README "What
strasbeat adds on top of Strudel").

Current helpers:

- **`progression(chords, options?)`** — one-line chord progressions; wraps
  `chord().dict().voicing().arp().s()` from `@strudel/tonal`. The user-facing
  reference (rhythm and style presets, bass layer, Roman numerals) is in
  `STRUDEL.md` § "Strasbeat extensions". Source:
  `src/strudel-ext/progression.js`, with `styles.js` and `roman.js`. Demo:
  `patterns/03-progression-demo.js`. Spec:
  `design/work/07-chord-progression.md`. Tests: `progression.test.js` and
  `roman.test.js`.

- **`.piano()`** — the Pattern method strudel.cc's REPL defines next to
  its piano sample map (`piano` sound, `clip(1)`, short release, pan by
  pitch). Not in any published package, so it lives in
  `src/strudel-ext/piano.js`, imported by the barrel for its side effect.

The dispatch is delegated where possible: chord parsing and voicing
dictionaries belong to `@strudel/tonal`; this module owns only the
defaults, the rhythm preset table, the style merge precedence, and the
Roman-numeral string math. Don't reinvent music theory in here.

## Bottom canvas and docSync

`src/ui/bottom-canvas.js` owns the `#roll` canvas, shared by the piano
roll, the scope and Strudel's own draw functions. One rule for all three:
paint only when the canvas can be seen and there is something new to
show.

- While playing, `src/frame-loop.js` calls `bottomCanvas.draw(haps, time)` every
  frame; nothing is painted while the pane is collapsed, another mode
  (Beat grid, Visuals) covers the canvas, or the tab is in the
  background. While stopped there is no frame loop: the last frame is
  kept and repainted on resize, display change, mode switch or hover.
  Geometry comes from one ResizeObserver; no frame reads layout.
- `src/hap-window.js` owns the numeric hap window and query horizon. It
  caches timing once per incoming hap, queries ahead in slices of `cps / 6`
  cycles (roughly six queries per second), and expires notes by numeric
  `endClipped`. Consecutive slices share the exact boundary. Re-evaluate
  keeps past onsets and replaces future ones. Time jumps refill around the
  new playhead; long notes crossing the refill's left edge are recovered
  with point queries at their onsets, never a query across the whole gap.
- The window is four cycles only while the roll or a painter needs it,
  otherwise `[0, 0]`. Demand changes refill synchronously, including the
  past on expansion; a stopped canvas cleared by a tab swap stays empty.
  New consumers must use the visible snapshot, not the private prefetched
  records, and must not mutate haps or published arrays. The bottom canvas
  retains that array after stop. Painters receive only the visible window;
  highlights receive the inclusive active set. Uniforms detect crossed
  onsets themselves and cache numeric times per hap.
- The loop replaces `editor.drawer` before `drawFirstFrame()`. Its
  `invalidate` fills haps and discovers painters synchronously, including
  the scrubber and capture preview's direct repl evaluations. Only a running
  scheduler owns rAF. Highlight signatures contain each source location's
  winning CSS (latest onset wins, first wins ties); transactions occur only
  on signature changes or a 250 ms keep-alive. Frame errors reach the console
  and status line once per evaluation, while the loop keeps running.
- `?sb-frameloop=off` selects the unchanged upstream Drawer plus
  `src/legacy-drawer.js` interception at startup. This remembered flag needs
  a reload; remove it and the legacy module together after hardware review.
- Painters registered by a pattern (`.punchcard()`, `.spiral()`,
  `.wordfall()`, `.onPaint(fn)`) draw into this canvas under the
  **Custom** mode, which is offered and selected once when a pattern has
  one. Painters that bring their own canvas (the inline `._punchcard()`
  widgets) run every frame regardless. `.pianoroll()`, `.scope()` and
  `.pitchwheel()` still draw on Strudel's unmanaged full-page canvas.
- The roll honours `hap.value.color`, and click-to-locate maps through
  edits made since the evaluate (it does nothing when the frame belongs
  to another tab).

Views that render the buffer (track bar, arrange bar, beat grid, the
bottom canvas) **subscribe to `docSync`** (`src/editor/doc-sync.js`) —
never append their own `updateListener`, which would exist in one tab's
state only. The parsers (`parseLabels`, the arrange and drum-lane
parsers) memoise their last result per buffer text, so a subscriber
compares what it got with what it rendered and **does nothing when the
parse result is unchanged**; the beat grid builds nothing at all while
hidden. Keep new views to that shape. The transport readout follows the
playback state (1 Hz poll when idle, none while the tab is hidden) and
animates by `transform`; the arrange bar's loop stops when playback does.

## Responsive layout and keyboard models

Three layouts, switched at 900 px and 600 px: **docked** (≥ 900 px, rails
are grid columns), **overlay** (600–899 px, rails pinned to 36 px strips;
an opened rail floats over the editor behind a scrim, Escape closes it)
and **compact** (< 600 px, the left strip goes too and the top bar and
transport condense). The right rail can never squeeze the editor under
360 px. The stored "rail open" flag is a docked-layout preference: a
narrow viewport neither reads nor writes it. The breakpoints and the
width arithmetic live twice — in the stylesheets and in
`src/ui/responsive.js` — and `responsive.test.js` reads the CSS to keep
them equal; change them together. `pointer: coarse` makes the top bar and
transport 48 px and enlarges hit areas.

The patterns library is an ARIA **tree** (one tab stop; arrows, Home/End,
type-to-find, Enter, F2, Shift+F10 for a keyboard-operable menu; `inert`
when the rail is collapsed) and the tab strip a **tablist** whose tabs and
close buttons are siblings (arrows move, Delete closes). Both get their
index math from `src/ui/roving.js` and keep focus across re-renders —
when changing how either renders, preserve the focused item rather than
replacing all children blindly. The text tokens' contrast ratios are
asserted in `src/ui/responsive.test.js`; focus is one `--focus-ring`
outline (see `design/SYSTEM.md`).

## WAV export

**Do not use upstream `renderPatternAudio`.**

strasbeat ships its own `renderPatternToBuffer` in `src/export.js` instead of
calling `@strudel/webaudio`'s `renderPatternAudio`. The upstream function
has a bug: it eagerly constructs a fresh `SuperdoughAudioController` against
the offline context *before* `await initAudio()` runs, and somewhere in that
path live-context audio nodes leak into the offline graph. The result is a
WAV file with the right header, the right duration, and bit-exact silence —
the per-hap mismatch errors get swallowed by superdough's `errorLogger`.

Our local version follows the same setup but passes `null` to
`setSuperdoughAudioController()` so the controller is built lazily on the
first `superdough()` call (which always happens after the audio context swap
is fully settled). That avoids the leak entirely.

If `renderPatternToBuffer` ever produces silent output again, the cause is
almost always that the controller was constructed too eagerly somewhere new.
Check for that first before chasing other hypotheses.

Two more rules around the live ↔ offline context swap:

- **Flush the node pools after every swap.** superdough pools audio nodes
  per node type, not per `AudioContext`, so after a swap a pooled node from
  the other context makes the first filtered notes drop — in the render,
  and in live playback afterwards. `flushStaleNodePools()` in
  `src/export.js` uses the stale nodes up with silent probe events; call it
  after any new context swap, before scheduling anything audible. Known
  gap: wavetable pools are probed only with the sounds the rendered
  pattern uses.
- **Never call a bare `initAudio()` for the live context.** Without
  `maxPolyphony` superdough parses `undefined` into NaN and voice stealing
  silently switches off. Every live call passes
  `{ maxPolyphony: LIVE_MAX_POLYPHONY }` (128, from `src/export.js`); the
  offline render passes `EXPORT_MAX_POLYPHONY`.

An export whose code fails to evaluate stops with the error (it checks the
outcome of `editor.evaluate(false)`), rather than rendering whatever the
repl evaluated last. While an export runs, `isExportRunning()` blocks
play, live MIDI notes, the metronome and sound previews.

## Visuals lifecycle

A visual layer exists if and only if the most recently evaluated code
asked for it (`initHydra()` / `shader()`) **and** the scheduler is
running. `src/strudel-ext/visuals-host.js` enforces that from one place:
`syncVisualsToRepl` is wired as the repl's `onUpdateState` in
`src/main.js`, so it sees every stop path (play button, Ctrl+., palette,
vim, export) and every evaluate, including the silent `evaluate(false)`
at boot and during export.

- Don't call `clearHydra()` / `clearShader()` from stop handlers or add a
  new teardown hook; the host does it.
- The patched evaluate takes a start hold (`holdVisualsForStart`) because
  the repl no longer autostarts: without it the layer would be torn down
  in the gap between evaluate and scheduler start.
- A hidden canvas never renders, and `prefers-reduced-motion` renders one
  still frame (`localStorage['strasbeat:visuals-motion'] = 'full'` opts
  out).
- A new visual layer registers with the host instead of owning its own
  canvas placement or render gate.

## Persistence

- **Autosave writes only real edits, and merges.** A flush does nothing
  unless the buffer was edited, and it merges into the stored record
  instead of rebuilding it — a record carries more than `code` (its
  folder, for one). Never write a pattern record from scratch on a save
  path.
- **Closing a tab, `pagehide` and `visibilitychange → hidden` flush**, as
  well as `beforeunload`. Delete paths opt out.
- **Auto-heal never discards.** A shipped pattern whose stored working copy
  does not transpile (while the original does) falls back to the original,
  but the copy is first moved to a listed user pattern `<name>-recovered`
  (`resolveWorkingCopy` in `patterns.js`) — autosave stores the buffer as
  typed, so such a copy is usually someone's unfinished edit. No path that
  reacts to stored data may delete a record the user did not ask to delete.
- **Library import** treats differing local edits to a shipped pattern as a
  conflict, like a user pattern of the same name.
- **Share links** (`#code=…`) arrive as an indexed user pattern named
  `shared-<name>` (`-2`, `-3`, … when taken) and the hash is cleared once
  it is stored, so a reload restores the recipient's edits rather than the
  original snapshot.
- **Unusable localStorage** (blocked, `null`, zero quota): the
  `storage-guard.js` stand-in keeps the app working for the session and
  `src/ui/storage-notice.js` shows a persistent "Not saving" notice. A
  working-but-full store is not replaced; failed writes stay pending, are
  retried, and raise the same notice.
- **Cross-window rule:** a window follows another window's save of a
  pattern only while its own buffer still equals the previously stored
  code. If it has edits of its own it keeps them; within the 1 s autosave
  debounce the last writer wins.
- **"Try"** in Learn and Reference opens the example in a scratch user
  pattern named `try-example`; it never replaces the open pattern.

## The single-quote rule

Strudel's transpiler (`strudel-source/packages/transpiler/plugin-mini.mjs`)
rewrites **every double-quoted string literal** in a pattern file into a
`mini(...)` call before evaluation. That's the right behavior for
`s("bd sd")`, but it silently breaks any helper that expects an actual
JS string — `progression("Cm7 F7")` lands inside `progression()` as a
Pattern, not a string, and the typical guard returns silence.

**The fix is single quotes everywhere `progression()` is called**:

```js
progression('Cm7 F7 Bb^7', { rhythm: 'arp-up', bass: true })
```

Both the chord argument *and* the option string values must be
single-quoted — the transpiler rewrites string literals regardless of
position in the AST. The drum line in the same file
(`s("bd*2, ~ sd:1, hh*8")`) still uses double quotes, because the
transpiler rewrite is *correct* for `s(...)` — it's mini-notation.

`progression()` itself has a defense-in-depth `_Pattern === true`
detector at the top of the function that warns to the console with the
actionable fix, so the failure is at least diagnosable. But the clean
solution is to just type `'`. Same rule applies to any new helper added
to `src/strudel-ext/` that takes a literal string argument: document it
explicitly and add a Pattern-input guard.

## MIDI

### The bridge uses trigger-and-decay (no noteoff)

`src/midi-bridge.js` ignores noteoff events on purpose. Each noteon
schedules a one-shot `superdough()` call with a tuned envelope (long natural
decay for piano-like sounds, sustained envelope for organ/strings) and
relies on the envelope to terminate the voice. This is what keeps the
implementation 100% public-API and lets *any* Strudel sound be played live
without patching internals — the trade-off is that truly key-up-released
pads aren't supported. If a future feature needs key-up release, it has to
either bypass superdough or extend it with a noteoff path.

### MIDI/OSC output routing model

strasbeat has two independent MIDI paths:

```
Input:  Web MIDI input device → MidiBridge → superdough (live play)
Output: pattern → .midi() → @strudel/midi → Web MIDI output device
```

Both use the browser's `MIDIAccess`. The bridge reads inputs (no sysex);
`@strudel/midi` (via the `webmidi` library) writes outputs (sysex: true).
No conflict — `requestMIDIAccess()` returns the same shared object.

**Permission is never requested on page load.** At boot both paths check
the Permissions API and connect only if access was already granted
(`midi.startIfPermitted()`; the output side does the same in
`user-setup.js`). Otherwise the transport pill reads "Connect MIDI" and
the request happens on that click (`midi.start()`), on the MIDI bar's
Enable / Retry button, or when a pattern that calls `.midi()` is
evaluated. Don't add a `requestMIDIAccess()` call outside a user gesture.

**Mod wheel:** at rest (0) live notes are unfiltered; pushing the wheel up
closes the low-pass.

**Voice budget:** superdough returns no voice handle, so the bridge cannot
steal voices. Held notes taper instead — from 24 sounding voices the
sustain pedal stops extending them, past 48 the hold shrinks in
proportion.

**MIDI output** (`@strudel/midi`) is an opt-in package toggled in
Settings. The output device picked in the MIDI bar is persisted to
`localStorage("strasbeat:midi-output-device")` and applied by a wrapper
around `Pattern.prototype.midi` (`installMidiOutputDefault` in
`user-setup.js`): a bare `.midi()` goes to the selected device, a call
that names a port still wins, and a selected device that has gone missing
warns once and falls back to upstream's default. The device is resolved at
evaluate time.

**OSC output** (`@strudel/osc`) is also opt-in. It sends events over
WebSocket to `ws://localhost:8080` (hardcoded in the upstream package —
not configurable). Settings shows the fixed URL and a connection
test button. Users must run an OSC bridge server on that port.

## Tempo

`setcps(BPM/60/beats_per_cycle)` is the standard way to set tempo from
inside a pattern. The Strudel scheduler reads the new value when the pattern
re-evaluates. The WAV exporter reads `editor.repl.scheduler.cps` after
calling `editor.evaluate(false)` — that's the synchronous, post-eval
authoritative value.

## Dev server

`vite.config.js` ships a tiny dev-only middleware at `POST /api/save` that
writes the editor buffer to `patterns/<name>.js` so the browser-side ⤓ save
button has a disk-side counterpart. It refuses cross-origin posts (403 on a
mismatched `Origin` or `Sec-Fetch-Site`, and on a `Host` that is neither
`localhost` nor an IP address — a rebound hostname), requires
`content-type: application/json` (415), and answers 409 instead of
replacing an existing file unless the body says `overwrite: true`. It also
proxies `/strudel-cc/*` → `https://strudel.cc/*`
to work around missing CORS headers on Strudel's sample manifests, and it
shapes the bundle: `@strudel/codemirror` is built from its source modules
and two small plugins stub what the app does not use (see "Bundle and
lazy loading").

## CI and the smoke test

`.github/workflows/ci.yml` runs `pnpm test`, `pnpm build` and the bundle
ceilings (see "Performance rig and ratchets") on pull requests, on pushes
to `main`, and on pushes to `ci/**` branches. Tests are `node:test` files
listed explicitly in the `test` script in `package.json` — a new
`*.test.js` does not run until it is added there.

`ci/**` branches exist to check a commit on a clean runner without opening
a PR. **Use `node scripts/ci-run.mjs test|smoke|perf`**, not a hand-typed
push: it pushes the commit to a throwaway branch, waits for every run of
it, prints the verdict and where the artifacts are, and deletes the branch
whatever happened (`--keep` leaves it).

`vercel.json` keeps `ci/**` from creating preview deployments, but Vercel
reads that file **from the pushed commit**: a commit older than the guard
(anything before `15c8bf9`), pushed to a `ci/` branch, is deployed as a
public preview. That happened once. So the command refuses a commit whose
`vercel.json` lacks the guard, refuses to push as a GitHub account that
does not own the repository, and afterwards fails if a deployment appeared
for the commit. To run an old commit, name it as `--base` for the perf
workflow: it is checked out on the runner and never becomes a branch.

**Browser smoke test (opt-in).** `.github/workflows/smoke.yml` builds the
app, serves it with `vite preview` and drives it in headless Chromium with
`.github/smoke/smoke.mjs`: boot, play/stop, evaluate outcomes, the playback
frame loop and its flag, every panel, completions, formatting in its
worker, visuals, a stored Vim profile, three viewport widths. It runs only
for branches named `ci/smoke-*` and from the Actions tab — never on `main`
or pull requests:

```sh
node scripts/ci-run.mjs smoke
```

After it, the workflow runs `.github/smoke/sw.mjs`, the service worker's
lifecycle test, against three builds (two that differ only by
`STRASBEAT_BUILD_ID`, and a `STRASBEAT_SW=off` build). It owns a switchable
Node HTTP server with production's cache headers, so it can replace the
"deploy" under a running page: install, a second launch with no shell or
asset request, a launch with the server down, the update notice with a
second window open, the next launch picking up a waiting build without a
click, and both kill switches.

Screenshots, `report.json` and `sw-report.json` (with the server traffic of
each phase) are uploaded as the run's `smoke` artifact. The runner image
and the Playwright version are pinned in the workflow; bump them
deliberately. When a fix has a browser-visible effect, add a check for it
to the script. Nothing here is run locally.

## Performance rig and ratchets

`.github/perf/` measures the production build from outside — the app has
no hook for it — in headless Chromium on a GitHub runner
(`.github/workflows/perf.yml`: `ci/perf-*` branches and manual dispatch,
pinned `ubuntu-24.04` and Playwright 1.65.1). Two builds are measured in
one job, on one machine, turn and turn about: the commit under test and a
base (`main` unless told otherwise).

```sh
node scripts/ci-run.mjs perf                        # this commit against main
node scripts/ci-run.mjs perf --base <ref>           # against another commit
node scripts/ci-run.mjs perf --scenarios typing,eval   # some journeys only
node scripts/ci-run.mjs perf --scenarios sweep      # the proxy evidence, below
```

A full run takes 20 to 25 minutes. A run of some journeys is checked
against the ceilings of those journeys only.

| Journey | From → to |
|---|---|
| `launch-cold` | navigation start, empty caches → the editor is in the document; the task that put it there has ended (a key press is handled from here); boot reports ready. Also at CPU ×4 and with 150 ms added to every response |
| `launch-warm` | the same, for the second and third launch of one browser profile: HTTP cache warm, service worker installed and in control |
| `typing` | the app at rest; a key goes down at the end of a 180-line pattern → two frames later; 103 keys. Also into a short and a long document (`default@short`, `default@long`), while a pattern plays, and at CPU ×4 |
| `playing` | playback is steady → 600 frames later, stepped at exactly 120 Hz. Roll visible, roll collapsed, scope, beat grid; Hydra and shader at 30 Hz; the roll at 1, 2 and 8 layers as well as the usual 4 (`roll@8`) |
| `tabs` | the app at rest; a click on a library item or a tab → three frames later |
| `eval` | the app at rest; Ctrl+Enter goes down → the first `AudioScheduledSourceNode.start()` |
| `idle` | boot is over, nothing playing → ten seconds later |
| `memory` | 120 evaluate/stop cycles, then 60 tab switches; heap after GC, DOM nodes and listeners every 20 |
| `sweep` | on request only: the four 120 Hz views of `playing`, each at four pattern sizes |

**Counts, not clocks.** On a shared runner two runs of identical code
differed by up to 25 % in script time and by less than 0.1 % in function
calls (about 1 % for playback since the frame loop: the measured five
seconds are two and a half cycles of the pattern, and 21 to 23 highlight
updates fall inside them depending on where they start). So each journey
is measured twice: a timing pass with nothing attached, and a count pass —
V8 precise-coverage call counts, attributed to source modules through
hidden source maps (`pnpm build --sourcemap hidden` leaves the JS
byte-identical), CodeMirror transactions, Canvas 2D calls, rAF callbacks,
layouts, style recalculations, DOM mutation records, requests and bytes.
Timings are reported as base against head from the same run; they are
never a gate.

A ceiling is one of two things. Most are **structural**: the count is the
cost itself, or work nobody should add without saying so — requests before
ready, bytes of initial JS, asset requests on a repeat launch, rAF
callbacks, timers and DOM mutations at rest, CodeMirror transactions per
second while nothing is typed, layouts and DOM mutation records per
keystroke. They are exact and make no claim about time. Four are
**proxies**, counts that stand in for time:
`playing.{roll,collapsed,scope,beats}.callsPerFrame`. A proxy has to earn
that, and it is only ever compared with itself. The summary ends with the
evidence gathered in the run: for a view, the (count, time) pairs at each
pattern size measured (`roll@1`, `roll@2`, `roll`, `roll@8`) and Pearson's
r **within each build**. Both restrictions were learned from a wrong
verdict:

- Pooling two builds misleads. A change that removes cheap calls moves
  the count much further than the time: the frame loop took 81–89 % of
  the calls per frame and 35–58 % of the script time.
- Comparing views misleads. A collapsed roll makes more calls per frame
  than a one-layer visible roll and costs less script time, because
  drawing on a canvas is native work that a call count cannot see. Across
  the seven 120 Hz variants r was 0.85–0.97, and it was one point: without
  the eight-layer roll the new build's r is 0.44–0.57.

A count is "proven" when, in every build measured at four or more points,
r clears 0.8 and the 5 % significance level for that many points (0.95 at
four points, 0.88 at five, 0.81 at six). Add a proxy ceiling only for a
count the summary calls proven. A full run carries the sizes of the roll
view; `--scenarios sweep` measures every view that has a proxy ceiling at
four sizes.

What held up: calls per frame, within each of the four views, at four
pattern sizes — r from 0.96 to 1.00 in both builds, in two sweeps, and
0.97–1.00 for the roll in the six full runs that carried its sizes. The
slope is not one to one: with the roll collapsed the new build goes from
466 to 2,216 calls per frame while its script time goes from 13.3 to
17.5 ms per second, because most of a frame's script cost does not depend
on the pattern. The ceiling trips long before the time has moved much,
which is the safe side. What did not hold up, and so is measured and
reported but has no ceiling: calls per keystroke (the same keys cost more
calls and less time in a short document than in a long one; three
document sizes prove nothing either way, so the typing ceilings are
structural), calls per tab operation (0.70 and 0.77), and calls during
launch — the quadratic sound registration cost 125 ms of boot and not one
extra call, which is why the launch scenario always takes a CPU profile
(self time by module and by function, in the summary).

**Frame stepping.** The playing, typing and tab journeys run in a page
created with DevTools begin-frame control: nothing renders until the rig
issues a frame, so 600 frames are exactly 600 frames on any machine. A
window counts only if its wall time is within 1 % of `frames × interval`;
otherwise it is measured again, up to three times. A window that never
holds pace produces no number: the summary names it first ("not measured
on this runner"), and a ceiling that depends on it fails the check. It
does not fail the run by itself — on the slowest runner model seen (2.8
GHz) the eight-layer variants cannot be stepped at 120 Hz, and they are
evidence, not ceilings. The time compared with the 8.33 ms budget is
measured in the page, from a frame's first rAF callback to the first task
after its rendering update. The browser runs with `--disable-gpu`:
software GL stalls the GPU process for up to a second per frame on a
runner. The price is that the 2D canvas is rasterised on the main thread,
so task time with the roll visible is pessimistic compared with a real
GPU; script time and counts are not affected. The WebGL modes cannot hold
120 Hz in software and are stepped at 30 Hz: their counts compare builds,
their frame times mean nothing.

**From rest.** The app is not finished when it reports ready: at idle it
fetches its lazy panels and registers the service worker, which downloads
its precache and takes the page over. The typing, evaluate and tab
journeys wait for that to end (`settle` in `lib/browser.mjs`); the launch
journeys measure it. Before they waited, the build that booted sooner had
more of that tail inside its window, and the same keys with identical call
counts read 3–8 % slower in script time. A timing that differs between two
builds whose counts are identical is a question about the rig first.

**Fixtures.** The rig serves each build itself, with production's cache
headers. The eight sample manifests are fetched once per run and served
byte-identical to both builds; any audio request is answered with one
tiny WAV; any other external request is aborted and fails the scenario.
Nothing is listened to: this measures work, not sound.

**Ratchets.** `.github/perf/ratchets.json` holds the ceilings:
`"<journey>.<variant>.<metric>": { max, tolerance, unit }`. The
perf workflow fails when a count exceeds `max × (1 + tolerance)`, when a
ratcheted count is missing, or when its window did not hold pace; ordinary
CI checks the `bundle.*` ceilings after every build.

```sh
node .github/perf/ratchet.mjs check results.json          # what CI runs
node .github/perf/ratchet.mjs lower results.json          # after a win
node .github/perf/ratchet.mjs guard base.json head.json   # nothing raised?
```

A ceiling only goes down. After a change that lowers a count, download
the run's `perf` artifact (`ci-run` prints where it put it), run `lower`
on its `results.json` and commit the file with the change. `lower` never
raises a ceiling and never adds or removes a key (`--init --metrics a,b`
adds). The workflow's `guard` step fails when a ceiling was raised or
removed relative to the base commit, or its tolerance widened, unless the
key is listed in `raises` with a reason — which is the reviewable way to
say "this count went up, and here is why".

**Finding the next bottleneck.** Keep a branch
(`node scripts/ci-run.mjs perf <name> --keep`) and dispatch the workflow
on it by hand — `gh workflow run perf.yml --ref ci/perf-<name>` — with
`-f profile=<journey>` for a CPU profile of its measured window (the
`.cpuprofile` in the artifact, and a table of self time by function and
module in the summary), `-f trace=<journey>` for a Chrome trace, or
`-f scenarios=memory -f trace=memory` for a heap census: what the heap
gained over the last 80 evaluate/stop cycles, by kind of object. The
count pass of the playing and typing journeys always lists the 25 most
called functions. Delete the branch when the run has been read.

**What it cannot tell.** How anything sounds or looks; frame cost on a
real GPU or a 120 Hz display; audio glitches under load. Those stay on
the list for a person (`design/work/OPEN.md`).

## Console helpers

Anything attached to `window.strasbeat`, `window.editor`, `window.midi`, or
`window.patterns` is fair game from devtools. The most useful:

```js
strasbeat.findSounds('909')              // every 909-tagged sound
strasbeat.hasSound('gm_pad_warm')        // verify a name before pasting
strasbeat.probeRender(4)                 // render 4 cycles offline, return stats (no file)
editor.code                              // current editor buffer
editor.evaluate()                        // evaluate + play
editor.stop()                            // stop the scheduler
midi.isCaptureEnabled()                  // is live capture on
```
