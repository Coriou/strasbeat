# strasbeat

A version-controlled, IDE-quality workspace for making music with
[Strudel](https://strudel.cc) — TidalCycles ported to JavaScript. The aim is
that someday this becomes a delightful, browser-based, DAW-adjacent tool for
composing on top of Strudel: powerful for veterans, gentle for beginners, the
way Logic / Ableton / Pro Tools are.

For now it's a small Vite app that wraps Strudel's `StrudelMirror` editor and
adds the missing pieces a developer/composer would expect from a daily-driver
tool: pattern files on disk, an offline WAV exporter, a hardware MIDI bridge,
and a console with sane debug helpers.

## Vision the user is steering toward

- A web-based, dev-grade music tool **on top of** Strudel — not a clone of it.
- Editing should feel like a real IDE: autocomplete for Strudel functions,
  hover docs, lint, format. Devs have high expectations.
- Hands-first, code-second composition (MIDI keyboard → captured pattern file
  → tweak in editor → commit).
- Eventually grow into something DAW-shaped (multi-track, mixer-like
  affordances) without losing Strudel's "code is the source of truth" ethos.

The user is new to Strudel — that's a feature, not a bug. Use beginner
intuition to drive towards designs that *don't* require encyclopedic Strudel
knowledge to be useful.

## Run

```sh
pnpm install   # first time only
pnpm dev       # http://localhost:5173
pnpm build     # production bundle into dist/
pnpm preview   # serve the production build
```

The browser autoplay policy needs a click before audio can start. After the
page loads, click anywhere once, then press play (or Ctrl/Cmd+Enter inside
the editor).

## Architecture in one breath

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
table and the arrange registry), the latest wins, and `editor.stop()`
cancels whatever is waiting. New code that evaluates should call
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

`vite.config.js` ships a tiny dev-only middleware at `POST /api/save` that
writes the editor buffer to `patterns/<name>.js` so the browser-side ⤓ save
button has a disk-side counterpart. It refuses cross-origin posts (403 on a
mismatched `Origin` or `Sec-Fetch-Site`), requires
`content-type: application/json` (415), and answers 409 instead of
replacing an existing file unless the body says `overwrite: true`. It also
proxies `/strudel-cc/*` → `https://strudel.cc/*`
to work around missing CORS headers on Strudel's sample manifests, and it
shapes the bundle: `@strudel/codemirror` is built from its source modules
and two small plugins stub what the app does not use (see "Bundle shape
and lazy loading").

`src/midi-bridge.js` listens on Web MIDI directly, routes noteons through
`superdough()` (the same one-shot audio entry point Strudel's pattern engine
uses), and supports a "capture phrase → save as pattern file" workflow.
MIDI files are read by `src/midi-smf.js` (not a library) and translated by
`src/midi-to-strudel.js`.

`src/strudel-ext/` is the home for runtime helpers strasbeat layers on
top of Strudel's pattern language. See the dedicated section below.

`patterns/*.js` are the user's compositions — see "Pattern file contract".

## Where things live

```
strasbeat/
├── index.html              # shell: top bar, left rail, editor, transport, piano roll
├── src/
│   ├── main.js             # orchestration: editor construction, panel wiring, toolbar
│   ├── boot.js             # prebake state machine (evalScope, soundfonts, samples)
│   ├── default-samples.js  # the default sample maps as data + the name-precedence rule
│   ├── lazy-import.js      # lazyImport()/once(): every on-demand import() goes through here
│   ├── eval-feedback.js    # patched evaluate/stop, error tracking, sound validation
│   ├── eval-state.js       # pure evaluate/stop sequencer + engine-log classification
│   ├── storage-guard.js    # in-memory localStorage stand-in when storage is blocked (imported first)
│   ├── capture.js          # MIDI capture preview modal + capture handler
│   ├── panels.js           # right-rail panel registration (console eager, five lazy)
│   ├── export.js           # WAV render (renderPatternToBuffer) + encode + download
│   ├── share.js            # URL share codec + share-link arrival as a user pattern
│   ├── editor-actions.js   # sound preview, insert, try example, insert template
│   ├── editor-setup.js     # CM settings merge + extension dispatch
│   ├── piano-roll-resize.js # roll toggle + divider drag
│   ├── command-palette-actions.js # Cmd+Shift+P action builders
│   ├── debug.js            # window.strasbeat console helpers
│   ├── patterns.js         # pattern discovery, persistence bridge, autosave
│   ├── store.js            # localStorage persistence (dirty tracking, user patterns)
│   ├── strudel-logger.js   # strudel.log filtering
│   ├── user-setup.js       # user setup script runner
│   ├── midi-bridge.js      # Web MIDI → superdough trigger-and-decay
│   ├── midi-smf.js         # Standard MIDI File reader (linear, tick-based)
│   ├── midi-to-strudel.js  # MIDI file → Strudel pattern translation pipeline
│   ├── midi-gm.js          # GM program → Strudel sound mapping
│   ├── editor/
│   │   ├── format.js       # Prettier + quote-restoration post-processor
│   │   ├── text-diff.js    # minimal diff → CM changes (whole-buffer rewrites keep marks/widgets)
│   │   ├── latest-wins.js  # one-in-flight, trailing-run throttle (scrubber evaluates)
│   │   ├── keymap.js       # VSCode-style keybindings
│   │   ├── numeric-scrubber.js  # Figma-style drag-to-scrub
│   │   ├── hover-docs.js   # CM6 hoverTooltip for Strudel functions
│   │   ├── signature-hint.js    # signature pill above cursor
│   │   ├── strudel-docs.json    # generated JSDoc index (pnpm gen:docs) — its own chunk
│   │   ├── docs-store.js   # getDocs()/onDocsLoaded(): the index, loaded after the editor mounts
│   │   ├── lazy-keymaps.js # stand-in for the Vim/Emacs packages; fetches them on first use
│   │   ├── doc-sync.js     # one doc-change signal for every view that renders the buffer
│   │   ├── error-marks.js  # inline error decorations + gutter markers
│   │   ├── track-labels.js # track mute/solo label parsing
│   │   ├── mini-notation-tokens.js  # tokeniser for mini-notation strings
│   │   └── completions/    # sound, bank, chord, scale, mode, function, mini-notation
│   ├── ui/
│   │   ├── left-rail.js        # patterns library: an ARIA tree (search, one tab stop, keyboard menu)
│   │   ├── tab-strip.js        # open-pattern tabs: a tablist with roving focus
│   │   ├── roving.js           # pure index math for roving focus (tabs, tree, menu)
│   │   ├── responsive.js       # layout breakpoints + rail rules, mirrored from shell.css
│   │   ├── transport.js        # BPM, cycle, playhead readouts, status, MIDI pill
│   │   ├── midi-bar.js         # MIDI bar (mini-keyboard, presets, capture, controls)
│   │   ├── midi-import-dialog.js # MIDI file import dialog
│   │   ├── piano-roll.js       # Canvas2D renderer (per-layer color, click-to-locate)
│   │   ├── bottom-canvas.js    # owner of the #roll canvas: paint gating, Strudel painters
│   │   ├── right-rail.js       # resizable panel host
│   │   ├── lazy-panel.js       # panel handle that loads its module on first open
│   │   ├── sound-browser.js    # sound search + preview + insert
│   │   ├── reference-panel.js  # function reference + in-use highlighting
│   │   ├── console-panel.js    # log/warn/error console
│   │   ├── export-panel.js     # WAV export UI
│   │   ├── settings-panel.js   # editor settings + about
│   │   ├── learn-panel.js      # interactive Strudel lessons
│   │   ├── setup-panel.js      # UNUSED — setup lives in settings-panel.js; nothing imports this
│   │   ├── storage-notice.js   # persistent "Not saving" notice
│   │   ├── track-bar.js        # track mute/solo bar
│   │   ├── scope.js            # oscilloscope visualizer
│   │   ├── bottom-panel-modes.js # roll/scope/custom mode switcher
│   │   ├── command-palette.js  # Cmd+Shift+P fuzzy command menu
│   │   ├── modal.js            # in-app prompt replacement (focus-trapped)
│   │   ├── settings-drawer.js  # OKLCH accent picker, persisted to localStorage
│   │   └── icons.js            # Lucide icon wrapper + hydration
│   ├── strudel-ext/        # runtime helpers wired into Strudel's evalScope()
│   │   ├── index.js            # barrel — anything exported here becomes a global in patterns
│   │   ├── progression.js      # progression() helper (chords + voicing + rhythm + style)
│   │   ├── piano.js            # .piano() Pattern method (strudel.cc's REPL defines it outside the packages)
│   │   ├── visuals-host.js     # shared lifecycle for the Hydra and shader layers
│   │   ├── styles.js           # style presets (jazz-comp, pop-pad, lo-fi, folk-strum, piano-bare)
│   │   └── roman.js            # Roman-numeral → absolute chord parser (used by progression())
│   └── styles/             # design-system CSS (base, editor, shell, tokens, etc.)
├── patterns/               # *.js — each one default-exports a Strudel string
├── scripts/
│   ├── build-strudel-docs.mjs   # extracts JSDoc → strudel-docs.json
│   ├── strudel-scope.mjs        # every name pattern code can call, from the installed packages
│   ├── build-learn-index.mjs    # builds learn panel content index
│   └── test-format.mjs
├── design/
│   ├── README.md           # how to use the design specs
│   ├── SYSTEM.md           # design system (type, color, spacing, layout)
│   ├── PATTERN-STYLE.md    # modern Strudel pattern idioms
│   └── work/               # task specs (01-shell through 28-upgrade-session)
├── vite.config.js          # /api/save middleware, strudel.cc proxy, bundle-shaping plugins
├── vercel.json             # production config (immutable /assets, ci/** branches don't deploy)
├── .github/workflows/ci.yml # pnpm test + pnpm build on PRs, main and ci/** branches
├── README.md               # user-facing front door
├── STRUDEL.md              # mini-notation cheatsheet (incl. progression() reference)
├── strudel-source/         # full upstream repo, READ-ONLY reference, gitignored
└── CLAUDE.md               # you are here
```

`strudel-source/` is a checked-out copy of the upstream repo at
<https://codeberg.org/uzu/strudel>. It's gitignored from strasbeat itself.
When you need to understand a Strudel function's behavior, read its source
under `strudel-source/packages/<pkg>/`. Don't ever modify files there as
part of strasbeat work — patches belong upstream.

## Custom Strudel extensions (`src/strudel-ext/`)

This directory holds the runtime helpers strasbeat layers on top of
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

- **`progression(chords, options?)`** — one-line chord progressions.
  Wraps `chord().dict().voicing().arp().s()` from `@strudel/tonal`.
  - Six rhythm presets (`block`, `strum`, `comp`, `arp-up`, `arp-down`,
    `alberti`) plus a raw mini-notation escape hatch.
  - Five style presets in `styles.js` (`jazz-comp`, `pop-pad`, `lo-fi`,
    `folk-strum`, `piano-bare`) bundling sound + dict + rhythm + FX.
  - Optional bass layer via `bass: true` or a custom sound name.
  - Roman-numeral input (`'ii V I'`) when `options.key` is supplied,
    parsed by `roman.js` (natural minor for minor keys; accidentals,
    extensions, diminished, augmented all supported).
  - Source: `src/strudel-ext/progression.js`. Demo:
    `patterns/06-progression-demo.js`. Spec:
    `design/work/07-chord-progression.md`. Tests:
    `progression.test.js` and `roman.test.js`.

- **`.piano()`** — the Pattern method strudel.cc's REPL defines next to
  its piano sample map (`piano` sound, `clip(1)`, short release, pan by
  pitch). Not in any published package, so it lives in
  `src/strudel-ext/piano.js`, imported by the barrel for its side effect.

The dispatch is delegated where possible: chord parsing and voicing
dictionaries belong to `@strudel/tonal`; this module owns only the
defaults, the rhythm preset table, the style merge precedence, and the
Roman-numeral string math. Don't reinvent music theory in here.

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

## Design system

Visual and interaction design has a single source of truth: `design/SYSTEM.md`
(layout grammar, type, color tokens, spacing, elevation, motion) and
`design/README.md` (how to use the specs). Every UI feature lives as its
own task spec under `design/work/` (01-shell, 02-format-and-keybindings,
03-numeric-scrubber, 04-intellisense, 05-piano-roll, 06-future, …). Read
the relevant work spec before building or modifying a UI feature, and read
SYSTEM.md before adding any new visual primitive — the goal is that the
chrome stays internally consistent as more features land.

## STRUDEL.md and the strudel.cc docs

`STRUDEL.md` is a focused cheatsheet covering mini-notation, sources,
combinators, transformations, sound banks, and the live MIDI / WAV
features. **Read it before guessing at Strudel syntax.** For anything not
covered there, the upstream function reference at
<https://strudel.cc/learn/> is the source of truth.

## Key gotchas

### Sound names are NOT 1:1 with General MIDI

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
in `src/default-samples.js` (tidal-drum-machines alone is registered
inline in `boot.js`); each has its own 15 s timeout and a sentence saying
what goes silent if it fails (`getBootFailures()`). The soundfont helpers (`loadSoundfont`, …) are in
pattern scope. Nothing here is opt-in any more — the opt-in packages in
Settings are xen, midi, osc, csound and serial.

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

`slider()` / `sliderWithID` are imported from the `@strudel/codemirror`
entry, the same module instance the editor uses — a second copy has its
own value store and never hears the widgets.

### Bundle shape and lazy loading

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
- as before: Prettier, hydra-synth, and the opt-in packages.

Rules:

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

### The bottom canvas and views of the buffer

`src/ui/bottom-canvas.js` owns the `#roll` canvas, shared by the piano
roll, the scope and Strudel's own draw functions. One rule for all three:
paint only when the canvas can be seen and there is something new to
show.

- While playing, the Drawer calls `bottomCanvas.draw(haps, time)` every
  frame; nothing is painted while the pane is collapsed, another mode
  (Beat grid, Visuals) covers the canvas, or the tab is in the
  background. While stopped there is no frame loop: the last frame is
  kept and repainted on resize, display change, mode switch or hover.
  Geometry comes from one ResizeObserver; no frame reads layout.
- The Drawer's hap window is the roll's four cycles only while the roll
  or a painter needs it; otherwise `main.js` narrows it to `[0, 0]`
  (highlighting and shader uniforms only need "now"). `main.js`
  intercepts `drawer.setDrawTime` and `drawer.invalidate` for this —
  don't call the originals from new code.
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

### Responsive layout and keyboard models

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

### WAV export: DO NOT use upstream `renderPatternAudio`

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

### Visuals lifecycle (Hydra and shader)

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

### Persistence and autosave

- **Autosave writes only real edits, and merges.** A flush does nothing
  unless the buffer was edited, and it merges into the stored record
  instead of rebuilding it — a record carries more than `code` (its
  folder, for one). Never write a pattern record from scratch on a save
  path.
- **Closing a tab, `pagehide` and `visibilitychange → hidden` flush**, as
  well as `beforeunload`. Delete paths opt out.
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

### `progression()` and the single-quote rule

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

### MIDI bridge uses trigger-and-decay (no noteoff)

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

### `setcps(...)` propagation

`setcps(BPM/60/beats_per_cycle)` is the standard way to set tempo from
inside a pattern. The Strudel scheduler reads the new value when the pattern
re-evaluates. The WAV exporter reads `editor.repl.scheduler.cps` after
calling `editor.evaluate(false)` — that's the synchronous, post-eval
authoritative value.

## Dev workflow

```
pick pattern from dropdown → edit live → press play to hear it →
⤓ save (writes patterns/<name>.js) → tweak in your IDE if you want →
HMR reloads the page → re-evaluate
```

The MIDI capture flow:

```
plug in keyboard → pick a preset → ● capture → play a phrase →
● capture again → save as patterns/<name>.js → HMR reloads → tweak / commit
```

## Git status

strasbeat is a git repo on `main`, with a remote at `origin`. The
`strudel-source/` clone is gitignored (it's its own separate repo) and
should never be touched by strasbeat commits.

## CI

`.github/workflows/ci.yml` runs `pnpm test` and `pnpm build` on pull
requests, on pushes to `main`, and on pushes to `ci/**` branches. Those
branches exist to check work in progress on a clean runner without opening
a PR (`git push origin <branch>:ci/<name>`); `vercel.json` keeps them from
creating preview deployments. Tests are `node:test` files listed
explicitly in the `test` script in `package.json` — a new `*.test.js` does
not run until it is added there.

## License note

Strudel is AGPL-3.0. Code that runs in the same process as Strudel and
extends it (which is what strasbeat does) is generally considered a
derivative work. If strasbeat is ever distributed, it falls under the same
license. For private/local use there's no obligation.

## Conventions for working in this repo

- **Read before editing.** Strudel has a *lot* of functions and a lot of
  surface area. When the user asks "why does X behave this way", read the
  function's source under `strudel-source/packages/` instead of guessing.
- **Patterns are taste-driven.** When changing a pattern, prefer one small
  edit at a time so the user can A/B it. Don't bulk-rewrite a layer to be
  "more correct" — Strudel rewards iteration on feel, not formal
  correctness.
- **Don't add backwards-compat shims to strasbeat itself.** This is a
  personal tool, not a library — there are no downstream consumers. Just
  change the code.
- **Surface silent failures loudly.** Strudel's stack has a habit of
  swallowing errors (`errorLogger`, `getSound()` returning `triangle` for
  missing sounds, etc.). Anywhere we wrap a Strudel API, prefer to log
  warnings or throw rather than silently degrade.
- **Defer features the user didn't ask for.** When fixing a bug, fix the
  bug. When adding a feature, add the feature. Don't sneak in refactors,
  type annotations, or "while I'm here" cleanups. The user iterates fast
  and big diffs make A/B harder.
- **Read `design/PATTERN-STYLE.md` before writing or editing any pattern
  file.** It codifies modern Strudel idioms (`setcpm` over `setcps`, `$:`
  over `stack()`, `.voicing()` over `.voicings()`, note names not MIDI
  numbers, signal modulation, effect chain formatting).

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
