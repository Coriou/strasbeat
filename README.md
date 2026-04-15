# strasbeat

A version-controlled, IDE-quality workspace for making music with
[Strudel](https://strudel.cc) — TidalCycles ported to JavaScript.

It's Strudel inside a real editor: autocomplete and hover docs for every
function, Prettier formatting, VSCode keybindings, drag-to-scrub on
numeric literals, a Canvas2D piano roll, a hardware MIDI bridge with
capture-to-file, an offline WAV exporter, and a small library of
runtime helpers (`progression()`, …) layered on top of Strudel's pattern
language. Patterns are plain `.js` files in [`patterns/`](./patterns) —
edit them in your IDE *or* live in the browser; both stay in sync via
Vite HMR. Save → commit → diff → branch.

## What strasbeat adds on top of Strudel

Everything below is custom to this repo — Strudel itself ships none of
it.

- **Design-system shell**: top bar with brand/pattern menu/settings, left
  rail patterns library (search + keyboard nav), editor canvas, transport
  bar (BPM/cycle/playhead/MIDI pill), collapsible Canvas2D piano roll.
- **IDE-grade editor extensions** (CodeMirror 6, layered on
  `StrudelMirror`):
  - **Autocomplete chain** for sounds, banks, chords, scales, modes,
    Strudel functions, and mini-notation tokens
    (`src/editor/completions/`).
  - **Hover docs** for every Strudel function, sourced from a generated
    JSDoc index (`pnpm gen:docs`).
  - **Signature hint pill** above the cursor inside argument lists.
  - **Prettier formatter** that restores original quote style after
    formatting (Strudel's transpiler discriminates `"` vs `'`, so this
    matters).
  - **VSCode-style keymap** (Cmd/Ctrl+/, move-line, etc.).
  - **Figma-style numeric scrubber**: drag any number literal to tweak
    it live, debounced to a re-evaluation.
- **Custom Canvas2D piano roll** with per-layer color, beat/cycle
  gridlines, click-to-locate, and active-row labels — written from
  scratch (not Strudel's built-in renderer).
- **Hardware MIDI bridge** (`src/midi-bridge.js`): live play through
  `superdough` with envelope-tuned presets (piano, EP, organ, pluck,
  pad, …), plus a *capture phrase → save as pattern file* flow.
- **Offline WAV exporter**: a custom `renderPatternToBuffer` that works
  around an upstream bug where the eager controller construction leaks
  live audio nodes into the offline graph (see CLAUDE.md for the long
  story). 48 kHz, 16-bit stereo.
- **Pattern files on disk** with Vite-side `POST /api/save` middleware,
  auto-discovery via `import.meta.glob`, and HMR-on-write.
- **In-app modal** (`src/ui/modal.js`) and **settings popover with
  accent color picker** (`src/ui/settings-drawer.js`) — no native
  prompts, OKLCH accent persisted to localStorage.
- **Console helpers** on `window.strasbeat` for sound discovery and
  offline render probing.
- **`src/strudel-ext/`** — runtime helpers exported into Strudel's
  `evalScope()` so they're callable inside any pattern file as if they
  were built-ins. Currently:
  - **`progression()`** — one-line chord progressions with voicing
    dictionaries, rhythm presets, style presets, Roman-numeral input,
    and an optional bass layer. See [STRUDEL.md](./STRUDEL.md) for the
    cheatsheet and `src/strudel-ext/progression.js` for the source.

## Run

```sh
pnpm install   # first time only
pnpm dev       # http://localhost:5173
pnpm build     # production bundle into dist/
pnpm preview   # serve the production build
pnpm test      # node --test (pattern-shape assertions, no audio)
pnpm gen:docs  # rebuild src/editor/strudel-docs.json from upstream JSDoc
```

The browser autoplay policy needs a click before audio can start. After
the page loads, click anywhere once, then press play (or `Ctrl/Cmd+Enter`
inside the editor).

## What's where

```
strasbeat/
├── index.html              # shell: top bar, left rail, editor, transport, piano roll
├── src/
│   ├── main.js             # boot, toolbar, prebake, WAV export, pattern auto-discovery
│   ├── midi-bridge.js      # Web MIDI → superdough trigger-and-decay
│   ├── editor/             # CodeMirror 6 extensions
│   │   ├── format.js              # Prettier + quote-restoration
│   │   ├── keymap.js              # VSCode-style keybindings
│   │   ├── numeric-scrubber.js    # drag-to-scrub on numeric literals
│   │   ├── hover-docs.js          # hoverTooltip for Strudel functions
│   │   ├── signature-hint.js      # signature pill above cursor
│   │   ├── strudel-docs.json      # generated JSDoc index
│   │   └── completions/           # sounds, banks, chords, scales, modes, functions, mini-notation
│   ├── ui/
│   │   ├── left-rail.js           # patterns library (search, keyboard nav)
│   │   ├── transport.js           # BPM, cycle, playhead, status, MIDI pill
│   │   ├── piano-roll.js          # custom Canvas2D renderer
│   │   ├── modal.js               # in-app prompt replacement
│   │   ├── settings-drawer.js     # accent color picker, persisted to localStorage
│   │   └── icons.js               # Lucide icon hydration
│   ├── strudel-ext/        # runtime helpers wired into Strudel's evalScope()
│   │   ├── index.js               # barrel — anything exported here becomes global in patterns
│   │   ├── progression.js         # progression() helper
│   │   ├── styles.js              # style presets (jazz-comp, pop-pad, lo-fi, …)
│   │   └── roman.js               # Roman-numeral → absolute chord parser
│   └── styles/             # design-system CSS (tokens, base, editor, shell, …)
├── patterns/               # *.js — each one default-exports a Strudel string
│   ├── 01-hello.js
│   ├── 02-house.js
│   ├── 03-breakbeat.js
│   ├── 04-melody.js
│   ├── 05-chords.js
│   └── 06-progression-demo.js
├── scripts/
│   ├── build-strudel-docs.mjs     # extracts JSDoc → strudel-docs.json
│   └── test-format.mjs            # asserts every pattern formats cleanly
├── design/
│   ├── README.md           # how to use the design specs
│   ├── SYSTEM.md           # design system (type, color, spacing, layout)
│   ├── PATTERN-STYLE.md    # modern Strudel pattern idioms
│   └── work/               # task specs (01-shell through 07-chord-progression)
├── vite.config.js          # /api/save middleware + strudel.cc proxy
├── vercel.json             # production deployment config
├── STRUDEL.md              # mini-notation + functions cheatsheet (incl. progression())
├── strudel-source/         # full upstream repo, READ-ONLY reference, gitignored
└── CLAUDE.md               # repo guide for AI collaborators
```

## Workflow

1. Pick a pattern from the left rail — its code loads into the editor.
2. Edit live; press play to hear it. Errors show inline.
3. Either:
   - **⤓ save** writes the editor's current code back to
     `patterns/<name>.js` (prompts for the name), or
   - edit `patterns/<name>.js` directly in your IDE — the page
     hot-reloads.
4. `git add patterns/02-house.js && git commit -m "tighten the bassline"`.

Drop a new file into `patterns/` (e.g. `patterns/07-dub.js`) and it
shows up in the left rail automatically.

### MIDI capture flow

Plug in a USB MIDI keyboard, pick a preset (Piano / EPiano / Pad / …),
hit **● capture**, play a phrase, hit capture again. You're prompted for
a filename; the played notes are written to `patterns/<name>.js` as a
real Strudel pattern, the page reloads, and you can tweak it in the
editor before committing.

### Pattern file format

```js
// patterns/05-dub.js
export default `setcps(70/60/4)

stack(
  s("bd ~ ~ ~"),
  s("~ ~ sd ~").room(0.8).delay(0.5),
)
`;
```

Why a string? Strudel's transpiler rewrites things like `"bd sd"` into
mini-notation calls before evaluation, so the *whole* tune needs to be
fed as source text. Wrapping it in `export default \`…\`` keeps the file
a normal JS module that auto-discovery (`import.meta.glob`) can load.

> **Single-quote gotcha for `progression()`**: the transpiler rewrites
> *every* double-quoted string literal in a pattern file into a `mini(...)`
> call. That's the right behavior for `s("bd sd")`, but it silently
> breaks helpers that expect a real string — like `progression()`. Use
> single quotes for chord arguments: `progression('Cm7 F7 Bb^7')`. Same
> goes for option values like `{ rhythm: 'arp-up' }`. The function
> detects the failure mode and warns to the console, but the cleanest
> fix is just to type `'`.

## Strasbeat extensions on top of Strudel

`src/strudel-ext/` is the home for helpers strasbeat layers on top of
Strudel's pattern language. They're wired into Strudel's `evalScope()`
in `src/main.js`, which means anything exported from
`src/strudel-ext/index.js` becomes a global inside pattern code with no
extra import — exactly like `note`, `s`, `chord`, etc.

### `progression()` — one-line chord progressions

```js
$: progression('Cm7 F7 Bb^7 Eb^7')
$: progression('Cm7 F7 Bb^7 Eb^7', { rhythm: 'arp-up' })
$: progression('ii V I', { key: 'C', style: 'jazz-comp' })
$: progression('C G Am F', { style: 'folk-strum', bass: true })
```

What it does:

- Cycles through the chord symbols at one per cycle and runs them
  through `chord().dict().voicing()` from `@strudel/tonal` — voice
  leading, voicing dictionaries (`ireal`, `lefthand`, `triads`,
  `guidetones`, `legacy`), and slash-chord parsing all come for free.
- Six **rhythm presets**: `block` (sustained), `strum` (4 ascending
  sweeps), `comp` (jazz off-beat stabs), `arp-up`, `arp-down`,
  `alberti`. Or pass a raw mini-notation arp string as the escape hatch.
- Five **style presets** that bundle sound + dictionary + rhythm + FX:
  `jazz-comp`, `pop-pad`, `lo-fi`, `folk-strum`, `piano-bare`. Explicit
  options always override the style.
- **Roman-numeral input** when you supply `options.key` —
  `progression('ii V I', { key: 'C' })` → `Dm G C`. Uppercase major,
  lowercase minor, accidentals (`bIII`, `#iv`), extensions (`ii7`,
  `V7`, `I^7`), diminished (`vii°`), augmented (`I+`). Minor keys use
  natural minor (Aeolian).
- Optional **bass layer**: `bass: true` (default `gm_acoustic_bass`) or
  pass a sound name to override.

The full reference is in [STRUDEL.md](./STRUDEL.md#strasbeat-extensions);
the source is in `src/strudel-ext/progression.js`. There's a runnable
demo at `patterns/06-progression-demo.js`.

## Console helpers

Anything attached to `window.strasbeat`, `window.editor`, `window.midi`,
or `window.patterns` is fair game from devtools:

```js
strasbeat.findSounds('909')          // every 909-tagged sound
strasbeat.hasSound('gm_pad_warm')    // verify a name before pasting
strasbeat.countSounds()              // total registered sounds (~1000+)
strasbeat.probeRender(4)             // render 4 cycles offline, return stats
editor.code                          // current editor buffer
editor.evaluate()                    // evaluate + play
editor.stop()                        // stop the scheduler
midi.isCaptureEnabled()              // is live capture on
```

## Learning

- [STRUDEL.md](./STRUDEL.md) — mini-notation cheatsheet, function index,
  progression() reference, MIDI bridge guide.
- [design/PATTERN-STYLE.md](./design/PATTERN-STYLE.md) — modern Strudel
  idioms (`setcpm`, `$:`, `.voicing()`, signal modulation, …).
- [design/SYSTEM.md](./design/SYSTEM.md) — the visual + interaction
  design system the UI is built against.
- [Workshop](https://strudel.cc/workshop/getting-started) — official
  step-by-step tutorial.
- [Function reference](https://strudel.cc/learn/) — every function in
  every package, searchable.
- `strudel-source/packages/` — read the source of any function you're
  curious about (the upstream repo is gitignored but kept locally).

## License

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

strasbeat is licensed under the **GNU Affero General Public License v3.0
(AGPL-3.0)**. See [LICENSE](./LICENSE) for the full text.

Strudel — the live-coding engine strasbeat is built on — is also
AGPL-3.0. Because strasbeat runs in the same process as Strudel and
extends its eval scope, it is a derivative work and inherits the same
license. Any public deployment of a modified version must provide access
to the corresponding source code.
