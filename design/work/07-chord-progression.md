# 07 — Chord progression helper (`progression()`)

> Read `../README.md`, `../SYSTEM.md`, `../PATTERN-STYLE.md`, and
> `../../CLAUDE.md` before starting. This task is a **runtime feature**,
> not a design-pass feature: it adds a new function to the Strudel eval
> scope so pattern files can call `progression(...)` directly. The wiring
> touches the `prebake` block in `src/main.js` (off-limits during the
> design pass per `SYSTEM.md` §11) — that section explains how to make
> the touch minimal and additive.

## Where this came from

This came out of a brainstorm about "how do we get *real music* into
Strudel patterns?" The fully-built option — a score importer (MusicXML,
MIDI, scraping MuseScore, OMR on PDFs) — is heavy and, in the case of
copyrighted modern music, legally fraught. The user explicitly deferred
that path.

The reframe that landed: **you don't need the score, you need the DNA**.
For a generative tool like Strudel, "use the chord progression" gets you
80% of "use the song" with 5% of the friction and zero of the legal mess.
Chord progressions at the symbolic level (`Cm7 F7 Bb^7`) aren't really
copyrightable, sources are everywhere (lead sheets, chord charts, your
own ear), and a small helper that turns a one-line progression into a
playable pattern is all the tooling you need.

This spec is that helper.

## Goal

A small `progression()` function callable from inside any pattern file,
that turns a chord progression into a playable Strudel pattern with
sensible defaults for voicing, rhythm, and sound. The user should be
able to sketch a tune from any chord chart in under a minute, and then
iterate on the result like any other pattern (chain `.slow()`, `.gain()`,
`.every()`, etc.).

## Background — what Strudel already provides

Strudel's chord support is rich, and `PATTERN-STYLE.md` §6 documents the
canonical idiom:

```js
$: "<Cm9 Fm9 Bb^7 Eb^7>".voicing().s("gm_epiano1").room(0.4)
```

That's already pretty good — Strudel parses chord symbols, handles slash
chords, ships voicing dictionaries (`ireal`, `lefthand`, `triads`,
`guidetones`, `legacy`), does smooth voice leading automatically, and
exposes `.arp()` for stepping through voicings. A reference pattern
exists in `patterns/05-chords.js`.

What Strudel does **not** ship (verified by direct audit of
`strudel-source/packages/tonal/`):

- Roman-numeral / scale-degree chord input (`I IV V` in a key)
- Style/genre presets that bundle a sound + voicing dict + rhythm + FX
- Rhythm templates beyond raw `.arp("…")` indexing
- A "give me a playable progression in one line with no ceremony" entry
  point

Those four things are the gap. This helper fills exactly that gap and
nothing more — voice leading, voicing dictionaries, and chord parsing
all stay delegated to `@strudel/tonal`.

## Why a helper, not a snippet template

A snippet from autocomplete (`work/04-intellisense.md`) could expand
boilerplate, but a real function buys things a snippet can't:

1. **It composes.** `progression("ii V I").slow(2).every(4, x => x.fast(2))`
   works because the return value is a real Strudel `Pattern`. A snippet
   is static text — once expanded it can't be transformed.
2. **Style presets are data, not text.** Adding a new style is editing
   one file, not asking the user to remember and re-type boilerplate.
3. **Defaults are centralised.** A future "set my default chord sound"
   preference flows through one function, not every pattern that ever
   used the snippet.
4. **It reads cleanly in finished patterns.** `progression("Cm7 F7 Bb^7")`
   is shorter to write *and* shorter to read in a committed pattern file.

## API surface

```ts
progression(
  chords: string,
  options?: {
    sound?:  string,                    // default: "gm_epiano1"
    dict?:   string,                    // default: "ireal" (Strudel default)
    rhythm?: RhythmName | string,       // default: "block"
    style?:  StyleName,                 // (Phase 2) preset bundle
    key?:    string,                    // (Phase 3) required for Roman input
    bass?:   boolean | string,          // default: false
  }
): Pattern
```

Returns a Strudel `Pattern` — same type as `note(...)` or `s(...)` —
chainable with any pattern method.

### Rhythm presets (Phase 1)

| Name              | What it does                                       |
| ----------------- | -------------------------------------------------- |
| `"block"` (default) | one chord per cycle, sustained                   |
| `"strum"`         | quick downward strum on each beat                  |
| `"comp"`          | jazz-style off-beat comping (think left-hand jazz) |
| `"arp-up"`        | arpeggio up across the cycle                       |
| `"arp-down"`      | arpeggio down                                      |
| `"alberti"`       | Alberti pattern (1-5-3-5)                          |

`rhythm` also accepts a raw mini-notation string, which is forwarded as
`.arp(rhythm)` — the escape hatch for anything not in the preset table.

### Style presets (Phase 2)

| Name           | sound                  | dict       | rhythm    | FX defaults              |
| -------------- | ---------------------- | ---------- | --------- | ------------------------ |
| `"jazz-comp"`  | `gm_epiano1`           | `ireal`    | `comp`    | room 0.4, gain 0.65      |
| `"pop-pad"`    | `gm_pad_warm`          | `ireal`    | `block`   | room 0.6, attack 0.4     |
| `"lo-fi"`      | `gm_epiano1`           | `lefthand` | `arp-up`  | room 0.5, lpf 1500       |
| `"folk-strum"` | `gm_acoustic_guitar`   | `triads`   | `strum`   | room 0.2                 |
| `"piano-bare"` | `gm_piano`             | `ireal`    | `block`   | room 0.3                 |

These are starting points, not commitments — adding/removing styles is a
one-line edit. **Verify every sound name with `strasbeat.hasSound(...)`
before committing the table** (per `CLAUDE.md` "Sound names are NOT 1:1
with General MIDI"). If a default sound isn't in the soundMap on the
shipped Strudel version, swap it for one that is.

When `style` is set, individual options still override:
`{ style: "jazz-comp", sound: "gm_piano" }` is "jazz comp on a real
piano".

---

## Phase 1 — minimal one-line progressions (small, immediate win)

### What

The function `progression(chords, options?)` with absolute chord symbols
and the rhythm presets above. No styles, no Roman numerals.

```js
$: progression("Cm7 F7 Bb^7 Eb^7")
$: progression("Cm7 F7 Bb^7 Eb^7", { sound: "gm_pad_warm" })
$: progression("Cm7 F7 Bb^7 Eb^7", { rhythm: "arp-up" })
$: progression("Cm7 F7 Bb^7 Eb^7", { bass: true })
```

### Why

This is the 80% case. Once you can write `progression("Cm7 F7 Bb^7 Eb^7")`
and hear something playable, the rest of the design is icing.

### Approach

- **One module**: `src/strudel-ext/progression.js`. One default-exported
  function plus a `RHYTHMS` map.
- **Internally**, the function builds the same chain
  `PATTERN-STYLE.md` §6 documents:
  1. Convert the input string into Strudel's `<chord1 chord2 …>` cycle
     alternation form.
  2. Pass it through `chord()` (or use the template-literal form).
  3. Chain `.dict(opts.dict)` (only if non-default — keeps the chain
     clean).
  4. Chain `.voicing()`.
  5. If `opts.rhythm` resolves to an `.arp(...)` argument from
     `RHYTHMS`, chain `.arp(...)`. `block` produces no `.arp()` call.
  6. Chain `.s(opts.sound)`.
  7. If `opts.bass`, layer with a bass pattern built from
     `rootNotes(2).note().s(typeof opts.bass === "string" ? opts.bass : "gm_acoustic_bass")`
     using `stack()`. `rootNotes` is exported from `@strudel/tonal`.
  8. Return the Strudel `Pattern`.
- **Surface unknown rhythm names loudly.** Per `CLAUDE.md` "surface
  silent failures loudly": unknown rhythm name → `console.warn` with
  `[strasbeat]` prefix, then fall back to `"block"`. Do not throw — the
  user is iterating live and a thrown error would stop the scheduler.
- **Slash chords just work** because Strudel's `tokenizeChord` already
  handles them (`tonal/tonleiter.mjs:22`). Don't reinvent the parser.
- **Empty input** (`progression("")`) → warn, return a silent pattern
  (`silence` from `@strudel/core`). Don't throw.

### Wiring (the one place where this touches off-limits code)

`src/main.js` line 171 holds the `evalScope(...)` call inside the
`prebake` block. This is the *only* place runtime helpers can be
registered for use inside pattern strings — it's how `note`, `s`,
`chord`, and every other Strudel global gets into scope. The whole
`prebake` block is marked off-limits in `SYSTEM.md` §11 *for the design
pass*; this work is **not** the design pass, it's a runtime feature, and
the touch must be:

- **Minimal**: one new top-of-file `import * as strudelExt from "./strudel-ext/index.js";`,
  and one new line `strudelExt,` in the `evalScope(...)` arguments. No
  reformatting, no reordering, no other touches in `prebake`.
- **Additive**: do not change behaviour of any existing module — just
  append.
- **Reviewed by the user**: this is the kind of touch that should be in
  its own commit, separate from the helper code, with a one-line message
  like `wire src/strudel-ext into evalScope`. Easy to revert if anything
  breaks.

If anything *else* in `main.js` seems necessary, **stop and ask** — it
likely means the design is wrong, not that the rule should bend.

### Files

- `src/strudel-ext/index.js` — re-exports `progression`. Single import
  surface for `evalScope`.
- `src/strudel-ext/progression.js` — the helper function and `RHYTHMS`
  map.
- `src/strudel-ext/progression.test.js` — unit tests. Use whatever test
  runner the project already has; if none, plain `node --test` works.
- `src/main.js` — one new import line + one new entry in the
  `evalScope(...)` argument list (per "Wiring" above).
- `patterns/06-progression-demo.js` — a new pattern that exercises
  `progression()` end to end. Doubles as the manual smoke test.

### Acceptance — Phase 1

- [ ] In a pattern file, `progression("Cm7 F7 Bb^7 Eb^7")` evaluates and
      produces audible chords on `gm_epiano1`.
- [ ] `progression("Cm7 F7 Bb^7 Eb^7", { sound: "gm_pad_warm" })` uses
      the pad sound.
- [ ] `progression("Cm7 F7 Bb^7", { rhythm: "arp-up" })` arpeggiates
      each chord upward across one cycle.
- [ ] `progression("Cm7 F7 Bb^7", { rhythm: "block" })` is the default;
      output is identical to passing no rhythm.
- [ ] `progression("Cm7 F7", { rhythm: "wat-no-such" })` falls back to
      block AND logs a `[strasbeat]` warning (verify in devtools).
- [ ] `progression("Cm7 F7 Bb^7", { bass: true })` layers a bass line on
      the chord roots using `gm_acoustic_bass`.
- [ ] `progression("Cm7 F7 Bb^7", { bass: "gm_fingered_bass" })` uses
      the supplied bass sound.
- [ ] `progression("Cm7 F7 Bb^7").slow(2).gain(0.5)` works — confirms
      the return value is a real Strudel pattern.
- [ ] Slash chords: `progression("Cm7/G F7/A Bb^7")` honours the bass
      note in the voicing.
- [ ] Empty input: `progression("")` returns silence and warns; does
      not crash the editor.
- [ ] Existing pattern `patterns/05-chords.js` still plays correctly
      (regression check — we shouldn't have touched the lower-level API).
- [ ] `patterns/06-progression-demo.js` plays end to end and demonstrates
      at least 3 of the rhythm presets.

---

## Phase 2 — style presets

### What

Add the `style` option and the preset table from "API surface" above.
Implement as a small dictionary in `src/strudel-ext/styles.js`. When a
style is passed, its values are merged into `options` with explicit
options winning.

### Why

A style bundles five tasteful decisions (sound, dict, rhythm, FX
defaults) into one argument so the user can audition a vibe in a single
keystroke. Without this, they have to remember a stack of names per
genre.

### Approach

- `src/strudel-ext/styles.js` exports a `STYLES` object keyed by name.
- In `progression()`, if `options.style` is set, look it up; merge its
  fields into `options` with explicit options taking precedence.
- FX defaults from a style are applied via Strudel chain methods on the
  returned pattern (`.room(...)`, `.gain(...)`, `.lpf(...)`, etc.) before
  returning to the caller.
- Unknown style name → `console.warn` + fall back to no style.
- **Verify every default sound** in the table resolves on strasbeat's
  shipped Strudel build via `strasbeat.hasSound(...)`. If `gm_pad_warm`
  or any other listed default isn't present, swap it for one that is and
  document the substitution in the table comment.

### Files

- `src/strudel-ext/styles.js` — the `STYLES` dictionary.
- `src/strudel-ext/progression.js` — extended to read `options.style`.
- `src/strudel-ext/progression.test.js` — tests for style merge
  semantics (especially: explicit option wins).

### Acceptance — Phase 2

- [ ] `progression("Cm7 F7 Bb^7", { style: "jazz-comp" })` produces the
      documented sound/dict/rhythm/FX combo and is audibly distinct from
      the default-options call.
- [ ] `progression("Cm7 F7 Bb^7", { style: "jazz-comp", sound: "gm_piano" })`
      keeps the jazz-comp rhythm/dict/FX but uses `gm_piano` (verify by
      ear).
- [ ] All five Phase-2 styles documented in `progression()`'s JSDoc, so
      `04-intellisense.md`'s hover-docs phase picks them up automatically
      when it lands.
- [ ] An unknown style name → `[strasbeat]` warning + falls back to no
      style + does not crash.
- [ ] Each listed default sound has been verified with
      `strasbeat.hasSound(...)` and any substitutions are documented in
      a comment above the table.

---

## Phase 3 — Roman numerals + key context

### What

Accept Roman-numeral input when a `key` option is provided:

```js
progression("i iv v i",   { key: "Cm" })
progression("I V vi IV",  { key: "G" })
progression("ii7 V7 I^7", { key: "F" })
```

Lowercase = minor, uppercase = major. Accidentals on the numeral:
`bIII`, `#iv°`. Extensions stick to the numeral: `ii7`, `V7`, `I^7`.

### Why

Most lead sheets are *in a key*. Typing `I V vi IV` is much faster than
mentally translating to `G D Em C`, and lets you transpose by changing
one parameter — exactly the kind of thing a code-as-source-of-truth tool
should make trivial.

### Approach

- Detect Roman-numeral syntax: if the first whitespace-delimited token
  starts with `[ivIV]` (and the rest of the input matches a small Roman
  regex), treat the whole input as Roman; otherwise treat as absolute
  chord symbols.
- Implement `romanToChord(numeral, key)` in `src/strudel-ext/roman.js`.
  Map numerals to scale degrees, build the absolute chord symbol, then
  forward to the Phase 1 path.
- If `key` is missing and Roman numerals are detected, warn + bail out
  (return silence). Don't try to guess a key.
- Mixing absolute and Roman tokens in the same input: not supported.
  Document this in the function's JSDoc.

### Files

- `src/strudel-ext/roman.js` — the parser. Pure function, no Strudel
  dependency, fully unit-testable.
- `src/strudel-ext/roman.test.js` — exhaustive tests for major/minor
  modes, accidentals, extensions, edge cases.
- `src/strudel-ext/progression.js` — extended to detect and dispatch
  Roman input.

### Acceptance — Phase 3

- [ ] `progression("ii V I", { key: "C" })` plays Dm-G-C.
- [ ] `progression("ii7 V7 I^7", { key: "F" })` plays Gm7-C7-F^7.
- [ ] `progression("i iv v", { key: "Am" })` plays Am-Dm-Em.
- [ ] Transposing: same numerals, `{ key: "C" }` vs `{ key: "G" }`,
      shifts the audible pitches up a fifth.
- [ ] Roman input without a `key` → `[strasbeat]` warning + silence.
- [ ] Mixed input (`progression("Cm7 V7", { key: "F" })`) → either
      treated as absolute (per the documented rule) or warned. Whatever
      the choice, it's documented in JSDoc.
- [ ] All Phase-1 acceptance criteria still pass (regression).

---

## Out of scope (across all phases)

- **Chord substitution**: tritone subs, secondary dominants, modal
  interchange. The user can write the substitute chord by hand. This is
  not a music-theory engine.
- **Voice-leading optimisation beyond what Strudel's `.voicing()`
  already does.** If a future need arises, it's a contribution upstream
  to `@strudel/tonal`, not strasbeat.
- **A UI picker** for chord progressions. The whole point is "type in
  the editor, hear sound." A picker is a separate feature for a
  different time.
- **Importing chord progressions from external files** (ChordPro,
  iReal Pro, MusicXML). Discussed in the brainstorm that produced this
  spec — explicitly deferred.
- **Score / sheet-music import.** Same as above. The brainstorm landed
  on "fix the friction of writing chord progressions, defer the
  importer." Honour that.
- **Chord-symbol completion/hover** in the editor. That's the
  intellisense spec's job (`work/04-intellisense.md`), not this one.
  When 04 lands, it should pick up `progression()`'s JSDoc for free.

## Phase ordering

Recommended: **Phase 1 → 2 → 3.** Each phase compounds the previous.
Phase 1 alone is shippable and useful — it covers the 80% case.

If you only have time for one phase, ship Phase 1.

## Files (across all phases)

- `src/strudel-ext/index.js` — re-exports for `evalScope`.
- `src/strudel-ext/progression.js` — the helper.
- `src/strudel-ext/styles.js` — Phase 2 style presets.
- `src/strudel-ext/roman.js` — Phase 3 Roman numeral parser.
- `src/strudel-ext/progression.test.js` — tests for Phases 1 & 2.
- `src/strudel-ext/roman.test.js` — tests for Phase 3.
- `src/main.js` — one new import + one new line in the `evalScope(...)`
  call inside `prebake`. **Minimal additive touch only**, per the
  "Wiring" subsection of Phase 1.
- `patterns/06-progression-demo.js` — end-to-end demo / smoke test.

## What this builds on

- **`PATTERN-STYLE.md` §6** — the canonical `.voicing()` chain. The
  helper is sugar over that exact chain, not a replacement for it.
- **`@strudel/tonal`** — `chord()`, `.voicing()`, `.dict()`, `.arp()`,
  `rootNotes()`, voicing dictionaries, smooth voice leading, and slash
  chord parsing all come from here. None of these get reimplemented.
- **`CLAUDE.md` "surface silent failures loudly"** — every fallback path
  warns to console with `[strasbeat]` prefix.
- **`work/04-intellisense.md`** — when the hover-docs phase of
  intellisense lands, it auto-discovers `progression()` from the JSDoc
  with no extra work needed here.
