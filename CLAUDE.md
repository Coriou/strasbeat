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
`import.meta.glob`, wires the toolbar (play / stop / save / export wav /
capture / preset picker), prebakes sample banks, mounts the MIDI bridge,
and registers `src/strudel-ext/` into Strudel's `evalScope()` so its
helpers (`progression()`, …) become globals inside pattern code.

The shell is a design-system layout (top bar with brand + pattern menu +
share/settings, left rail patterns library, editor canvas, transport bar
with cps/bpm + cycle + playhead + MIDI pill, collapsible piano roll at the
bottom) and the editor is extended with a Prettier-based formatter, a
VSCode-style keymap, a Figma-style numeric drag-to-scrub, an autocomplete
chain (sounds / banks / chords / scales / modes / functions /
mini-notation), hover docs, and a signature hint pill — all CodeMirror 6
extensions layered on top of `StrudelMirror`. Browser prompts are
replaced by an in-app `modal.js`, and a settings popover
(`settings-drawer.js`) hosts an OKLCH accent picker persisted to
localStorage.

`vite.config.js` ships a tiny middleware at `POST /api/save` that writes the
editor buffer to `patterns/<name>.js` so the browser-side ⤓ save button has a
disk-side counterpart. It also proxies `/strudel-cc/*` → `https://strudel.cc/*`
to work around missing CORS headers on Strudel's sample manifests.

`src/midi-bridge.js` listens on Web MIDI directly, routes noteons through
`superdough()` (the same one-shot audio entry point Strudel's pattern engine
uses), and supports a "capture phrase → save as pattern file" workflow.

`src/strudel-ext/` is the home for runtime helpers strasbeat layers on
top of Strudel's pattern language. See the dedicated section below.

`patterns/*.js` are the user's compositions — see "Pattern file contract".

## Where things live

```
strasbeat/
├── index.html              # shell: top bar, left rail, editor, transport, piano roll
├── src/
│   ├── main.js             # boot, toolbar, prebake, WAV export, pattern auto-discovery
│   ├── midi-bridge.js      # Web MIDI → superdough trigger-and-decay
│   ├── editor/
│   │   ├── format.js       # Prettier + quote-restoration post-processor
│   │   ├── keymap.js       # VSCode-style keybindings
│   │   ├── numeric-scrubber.js  # Figma-style drag-to-scrub
│   │   ├── hover-docs.js   # CM6 hoverTooltip for Strudel functions
│   │   ├── signature-hint.js    # signature pill above cursor
│   │   ├── strudel-docs.json    # generated JSDoc index (pnpm gen:docs)
│   │   ├── mini-notation-tokens.js  # tokeniser for mini-notation strings
│   │   └── completions/    # sound, bank, chord, scale, mode, function, mini-notation
│   ├── ui/
│   │   ├── left-rail.js        # patterns library (search, keyboard nav)
│   │   ├── transport.js        # BPM, cycle, playhead readouts, status, MIDI pill
│   │   ├── piano-roll.js       # Canvas2D renderer (per-layer color, click-to-locate)
│   │   ├── modal.js            # in-app prompt replacement (focus-trapped)
│   │   ├── settings-drawer.js  # OKLCH accent picker, persisted to localStorage
│   │   └── icons.js            # Lucide icon wrapper + hydration
│   ├── strudel-ext/        # runtime helpers wired into Strudel's evalScope()
│   │   ├── index.js            # barrel — anything exported here becomes a global in patterns
│   │   ├── progression.js      # progression() helper (chords + voicing + rhythm + style)
│   │   ├── styles.js           # style presets (jazz-comp, pop-pad, lo-fi, folk-strum, piano-bare)
│   │   └── roman.js            # Roman-numeral → absolute chord parser (used by progression())
│   └── styles/             # design-system CSS (base, editor, shell, tokens, etc.)
├── patterns/               # *.js — each one default-exports a Strudel string
├── scripts/
│   ├── build-strudel-docs.mjs   # extracts JSDoc → strudel-docs.json
│   └── test-format.mjs
├── design/
│   ├── README.md           # how to use the design specs
│   ├── SYSTEM.md           # design system (type, color, spacing, layout)
│   ├── PATTERN-STYLE.md    # modern Strudel pattern idioms
│   └── work/               # task specs (01-shell through 07-chord-progression)
├── vite.config.js          # /api/save middleware + strudel.cc proxy
├── vercel.json             # production deployment config
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
`src/main.js:188` passes `strudelExt` (a namespace import of
`src/strudel-ext/index.js`) as one of the arguments to `evalScope()`,
the same call that wires `@strudel/core`, `@strudel/mini`,
`@strudel/tonal`, etc. So everything re-exported from
`src/strudel-ext/index.js` becomes a global inside pattern code with no
extra import — exactly like `note`, `s`, `chord`.

To add a new helper: drop a file under `src/strudel-ext/`, re-export it
from `index.js`, and it's available in every pattern file on next reload.
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
strasbeat.countSounds()         // total registered sounds (~1000+)
```

If you write `sound("not_a_real_name")`, the pattern produces **no audible
events with no error**. The MIDI bridge surfaces unknown preset sounds as a
console warning (`[midi] preset "X" uses sound "Y" which is not in the
loaded soundMap`) — copy the same defensive style if you add new
synthesis/sample features.

### WAV export: DO NOT use upstream `renderPatternAudio`

strasbeat ships its own `renderPatternToBuffer` in `src/main.js` instead of
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
