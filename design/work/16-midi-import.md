# 16 — MIDI in: file import on a shared translation core

> Read `../README.md`, `../SYSTEM.md`, `../../CLAUDE.md`, and
> `../../STRUDEL.md` before starting. Then read this whole file. This is
> a **runtime + UI feature set** that establishes strasbeat's inbound
> MIDI-to-Strudel path. Phase 1 ships a `.mid` import workflow, but the
> architectural bar is wider: the musical translation core must be shared
> by file import now, live MIDI capture next, and any future MIDI
> seed-library ingestion after that. Upstream Strudel still has no MIDI
> file import capability; `@strudel/midi` is output-oriented work and
> belongs in `14-strudel-learning-and-extensibility.md`.

## Where this came from

The user has been manually transcribing MIDI files into Strudel patterns
(see `patterns/tetriste.js` — the Tetris theme, painstakingly hand-coded
from a MIDI source into `cat()` + mini-notation). That works, but it
takes an hour per song and requires deep Strudel fluency. A DAW-grade
music workspace needs to accept MIDI files as a first-class input.

The goal is not "play back a MIDI file through Strudel" (that's a MIDI
player, not a composing tool). The goal is **generate editable pattern
code** the user can then riff on — just like dropping a MIDI file into
Ableton's piano roll gives you notes you can move, quantize, split into
clips, and rearrange.

## What this spec owns

- **Inbound MIDI → readable Strudel translation.** The core job is to
  turn note data into a draft pattern the user can immediately read and
  edit.
- **File import UI.** Phase 1's user-facing client is a modal dialog for
  dropping or picking `.mid` files.
- **A shared musical translation seam.** The codegen core must accept a
  normalized note-track model rather than being coupled directly to
  `@tonejs/midi`'s object graph.
- **Shared GM mappings and warnings.** Instrument/drum mapping, naming,
  and silent-failure surfacing belong here so inbound MIDI features do
  not drift.

This spec does **not** own outbound `.midi()` routing, OSC output, or
browser MIDI device selection for pattern playback. That's Phase 4 of
`14-strudel-learning-and-extensibility.md`.

## Non-goals

- **No MIDI file playback engine.** We generate a pattern _file_, not a
  runtime player. The user evaluates the resulting pattern code like any
  other pattern.
- **No MusicXML, ABC notation, or other score formats.** MIDI only. Those
  are different parsers, different problems.
- **No AI-assisted transcription or audio-to-MIDI.** This is SMF parsing —
  deterministic, lossless at the data level.
- **No modifications to Strudel internals, `@strudel/core`,
  `@strudel/mini`, the transpiler, or `superdough`.** Everything is
  codegen — we emit Strudel source text.
- **No MIDI file _export_.** Writing a `.mid` from a Strudel pattern is a
  different feature with different challenges. Out of scope.
- **No real-time MIDI file streaming.** The file is parsed once, code is
  generated, done.

## Parsing library: `@tonejs/midi`

Use **`@tonejs/midi`** (v2 — `npm: @tonejs/midi`). It wraps
`midi-file` (the actual binary parser) and gives us:

```ts
interface ParsedMidi {
  name: string;
  duration: number; // seconds
  header: {
    tempos: { bpm: number; ticks: number; time: number }[];
    timeSignatures: { timeSignature: [number, number]; ticks: number }[];
    ppq: number; // pulses per quarter note
  };
  tracks: {
    name: string;
    channel: number;
    notes: {
      name: string; // "C4", "F#3", "Bb2"
      midi: number; // 0–127
      time: number; // seconds
      ticks: number;
      duration: number; // seconds
      velocity: number; // 0–1
    }[];
    instrument: {
      number: number; // GM program 0–127
      name: string; // "acoustic grand piano"
      family: string; // "piano"
      percussion: boolean;
    };
    controlChanges: Record<string, { time: number; value: number }[]>;
  }[];
}
```

**Why this library:**

- De facto standard (~43K weekly npm downloads), MIT, TypeScript-typed
- Stable (MIDI is a 40-year-old spec; the library hasn't needed updates)
- Small enough for browser-side runtime import in this app
- Current v2 dist ships with `midi-file` plus a tiny helper dependency;
  do **not** assume zero transitive deps when wiring it in
- Does the heavy lifting: note-on/note-off pairing, delta-time →
  absolute-time conversion, tempo map application, instrument detection

**Install as a runtime dependency** (not devDependency) — it runs in the
browser when the user imports a file:

```sh
pnpm add @tonejs/midi
```

## Architecture overview

```
          ┌─────────────┐
 .mid file ──→ │ @tonejs/midi │ ──→ ParsedMidi ──→ file adapter ─┐
          └─────────────┘                                   │
                                            ▼
 live capture buffer ───────────────────────────────→ capture adapter ─┐
                                                │
 future MIDI seed pack ────────────────────────────→ library adapter ─┐ │
                                               ▼ ▼
                                      ┌────────────────────┐
                                      │ TranslationInput    │
                                      │ (normalized tracks) │
                                      └────────────────────┘
                                               │
                                               ▼
                                      ┌────────────────────┐
                                      │ midi-to-strudel    │
                                      │ analyze + codegen  │
                                      └────────────────────┘
                                               │
                                               ▼
                                      pattern source string
                                               │
                                               ▼
                                  import dialog / save flow / store
```

Three layers, clean separation:

1. **Adapters** — parse or normalize the source into a shared
   `TranslationInput` model. Phase 1 only builds the file adapter, but
   the seam must be ready for capture and seed-library sources too.
2. **Analyze + codegen** — `src/midi-to-strudel.js`. Pure functions, no
   DOM, no Strudel runtime dependency. Testable in isolation with
   `node --test`.
3. **UI / entry points** — the import dialog, left-rail action, and
   editor drop target. Thin glue that calls the core and feeds the result
   into the pattern creation flow.

If Phase 1 couples codegen directly to `@tonejs/midi`'s `ParsedMidi`
shape, the seam is wrong.

### Relationship to live capture and seed libraries

Phase 1 does **not** rewrite `src/midi-bridge.js`, but this spec is
deliberately setting up that follow-on. The current capture path builds a
quick draft directly inside `buildPatternFromCapture()`. The new core
must be written so that a later pass can feed captured note events into
the same translation pipeline instead of maintaining a second dialect of
MIDI-to-Strudel output.

The same rule applies to any future seed-bank/library feature: preserve
the original MIDI asset, but generate app-owned Strudel drafts through
this core rather than depending on an upstream generator's format.

## The core problem: codegen that produces _readable_ Strudel

This is where the engineering lives. The goal is **output that looks like
it was hand-written** — something resembling `patterns/tetriste.js`, not
a data dump. The user should be able to read, understand, and edit the
generated code immediately.

### Strategy: grid quantization → mini-notation

Snap notes to a rhythmic grid, group into bars, emit mini-notation per
bar, sequence bars with `cat()`. This is the same approach a human
would take transcribing by ear.

**Why not lossless `compress()` output:**
A lossless strategy (`note("c4").compress(0.3, 0.5).dur(0.2)` per note)
is technically correct but produces code no human would ever write or
want to edit. A 90-bar MIDI file would generate thousands of lines of
opaque fractional arithmetic. It violates the bar — "feels right when
the composer reads it."

### Quantization algorithm

1. **Detect tempo and time signature** from `header.tempos[0]` and
   `header.timeSignatures[0]`. If there are tempo changes mid-file, use
   the first tempo and warn (Phase 2 handles tempo maps).

2. **Compute bar duration** in seconds:

   ```
   beatsPerBar = timeSig[0] * (4 / timeSig[1])
   barDuration = beatsPerBar * (60 / bpm)
   ```

3. **Choose the quantization grid.** Auto-detect the finest subdivision
   that captures ≥95% of note onsets cleanly:
   - Derive candidates from the time signature, including triplet-
     compatible grids in Phase 1
   - Typical candidates:
     - 4/4 → 4, 8, 12, 16, 24, 32 slots per bar
     - 3/4 → 3, 6, 9, 12, 18, 24 slots per bar
     - 6/8 → 6, 12, 24 slots per bar
   - For each grid, count how many note onsets snap within a tolerance
     of ±10% of the grid unit
   - Pick the finest grid where ≥95% of notes are "on grid"
   - If none meet the threshold, fall back to the best-scoring candidate
     and warn
   - The user can override this in the import dialog

4. **Snap each note onset** to the nearest grid position. Durations snap
   to the nearest grid unit (minimum: one grid unit).

5. **Group notes into bars** by their quantized onset time. Within each
   bar, group simultaneous notes (same grid position) into chords.

### Normalized translation input

Phase 1 parses `.mid` files, but the codegen core should not depend on a
file-parser-specific object graph. The shared input shape is:

```ts
interface TranslationInput {
  sourceName: string;
  bpm: number;
  timeSignature: [number, number];
  ppq?: number;
  totalBars?: number;
  tracks: TranslationTrack[];
}

interface TranslationTrack {
  name: string;
  channel: number;
  isDrum: boolean;
  gmInstrument: string;
  notes: TranslationNote[];
}

interface TranslationNote {
  name: string; // "c4", "f#3"
  midi: number; // 0–127
  time: number; // seconds from song start
  duration: number; // seconds
  velocity: number; // 0–1
}
```

The file adapter converts `ParsedMidi` into this model. A later capture
adapter should convert grouped note-on events into the same model before
handing them to analysis + codegen.

### Code generation rules

For each track, generate a pattern block following `PATTERN-STYLE.md`:

#### Single-voice melodic line (no chords)

```js
// Mini-notation per bar, bars sequenced with cat()
const melody = note(
  cat(
    "d4@2 d4 d4@2 d4", // bar 1 — 6/8 time, @ for durations
    "d4@2 d4 d4 d4 d4", // bar 2
    // ...
  ),
);
```

Rules:

- **Note names, never MIDI numbers** — per `PATTERN-STYLE.md` §4.
  `@tonejs/midi` already gives us `.name` as `"C4"`, `"F#3"`, etc.
  Convert sharps to Strudel-style: `F#3` → `f#3` (lowercase).
- **Rests as `~`** — grid positions with no note become `~`.
- **`@N` for duration** — when a note's quantized duration differs from
  the grid unit, use `@N` weight notation: `d4@2` holds for 2 grid
  units. Omit `@1` (it's the default).
- **Brackets `[...]` for sub-groups** — if the bar has an irregular
  number of grid slots that doesn't match the time signature's natural
  grouping, use brackets to group beats.
- **`cat()` for bar sequencing** — each bar is one entry in `cat()`.
  All bars occupy one cycle each. If bars repeat, duplicate them (Phase
  2 can add repetition detection and `cat()` deduplication).

#### Chordal passages (simultaneous notes)

```js
const chords = note(
  cat(
    "[d3,a3,f4]@2 [d3,a3,f4] [c3,g3,e4]@2 [c3,g3,e4]",
    // ...
  ),
);
```

Rules:

- **Comma-separated notes in brackets** — `[c3,e3,g3]` is a chord in
  mini-notation.
- **Max 6 simultaneous notes** — warn and drop lowest-velocity notes if
  a chord exceeds 6 (prevents unreadable notation from dense
  orchestral MIDI).
- **Sort chord tones low to high** — consistent reading order.

#### Harmonic tracks and future uplift

Phase 1 should emit explicit note/chord material exactly as played. Do
**not** silently infer chord symbols or Roman numerals in the first pass.

However, keep enough analysis metadata around to support a later,
high-confidence uplift of obvious harmonic tracks into more native
Strudel abstractions such as:

```js
"<Cm7 F7 Bb^7>".voicing().s("gm_epiano1");
progression("ii V I", { key: "C", style: "jazz-comp" });
```

That future pass should be opt-in or confidence-gated. The baseline
import must remain faithful and readable, not clever-and-wrong.

#### Drum tracks (channel 10 / `percussion: true`)

```js
drums: s(
  cat(
    "bd ~ sd ~ bd ~ sd ~", // bar 1
    "bd ~ sd ~ bd bd sd ~", // bar 2
    // ...
  ),
);
```

Rules:

- **Map GM drum MIDI numbers to Strudel sample names.** Standard GM drum
  map — the 47 most common mappings. See the lookup table section below.
- **Use `s()` instead of `note()`** — drums are sample triggers.
- **Layer drums that hit simultaneously with `,`** — `bd,hh` for a
  simultaneous kick and hihat.
- **Unknown drum notes** → `~` + warning. Don't silently produce broken
  names.

#### Instrument mapping

Map GM program numbers to Strudel `gm_*` sound names. This is a static
lookup table. **Every name must be verified with `strasbeat.hasSound()`
at dev time** (per `CLAUDE.md` "Sound names are NOT 1:1 with General
MIDI").

The table doesn't need to cover all 128 programs — cover the common
families and fall back to a sensible default for unknown instruments.
Suggested fallback chain:

| GM family      | Strudel sound              |
| -------------- | -------------------------- |
| piano          | `gm_piano`                 |
| chromatic perc | `gm_vibraphone`            |
| organ          | `gm_drawbar_organ`         |
| guitar         | `gm_acoustic_guitar_nylon` |
| bass           | `gm_acoustic_bass`         |
| strings        | `gm_string_ensemble_1`     |
| ensemble       | `gm_string_ensemble_1`     |
| brass          | `gm_brass_section`         |
| reed           | `gm_alto_sax`              |
| pipe           | `gm_flute`                 |
| synth lead     | `gm_lead_2_sawtooth`       |
| synth pad      | `gm_pad_warm`              |
| (unknown)      | `gm_piano`                 |

**Verify every single one of these at dev time.** Run
`strasbeat.hasSound("gm_alto_sax")` etc. in the browser console. If a
name doesn't resolve, find one that does with
`strasbeat.findSounds("sax")` and update the table.

#### GM drum number → Strudel sample name lookup table

```js
const GM_DRUM_MAP = {
  35: "bd",
  36: "bd", // Acoustic/Electric Bass Drum
  37: "rim",
  38: "sd",
  40: "sd", // Side Stick, Snare
  39: "cp", // Hand Clap
  41: "lt",
  43: "lt", // Low Floor/Tom
  42: "hh",
  44: "hh",
  46: "oh", // Closed HH, Pedal HH, Open HH
  45: "mt",
  47: "mt",
  48: "mt", // Mid Toms
  49: "cr",
  57: "cr", // Crash Cymbals
  50: "ht",
  52: "cr", // High Tom, Chinese Cymbal
  51: "ride",
  53: "ride",
  59: "ride", // Ride
  54: "tamb", // Tambourine
  56: "cb", // Cowbell
  // ... extend as needed
};
```

**Start with the core ~20 mappings and extend as real MIDI files demand
it.** Unknown drum notes → `~` in the pattern + a console warning listing
the unmapped MIDI numbers.

The instrument-family map and `GM_DRUM_MAP` should live in one shared
module so file import and live MIDI capture do not drift.

### Output file structure

The generated pattern file follows `PATTERN-STYLE.md`:

```js
// imported-song — imported from MIDI file
// original: "Piano Template" · 4 tracks · 6/8 at 200 BPM
// tracks: Right Hand (gm_piano), Left Hand (gm_piano), Strings (gm_string_ensemble_1)
// quantized to 8th note grid · 87 bars

export default `
setcpm(200/4)

const rightHand = note(
  cat(
    "d4@2 d4 d4@2 d4",
    "d4@2 d4 d4 d4 d4",
    // ... remaining bars
  ),
)

const leftHand = note(
  cat(
    "~ ~ ~ ~ ~ ~",
    "~ ~ ~ ~ ~ ~",
    "~ ~ ~ ~ [d1,d2]@5.5 ~",
    // ... remaining bars
  ),
)

const strings = note(
  cat(
    "~ ~ ~ ~ ~ ~",
    // ... remaining bars
  ),
)

rightHand: rightHand
  .s("gm_piano")
  .room(0.2)

leftHand: leftHand
  .s("gm_piano")

strings: strings
  .s("gm_string_ensemble_1")
  .room(0.3)
`;
```

Key formatting decisions:

- **`setcpm(BPM/beatsPerCycle)`** — per `PATTERN-STYLE.md` §2.
- **Named `const` for each track** — makes it easy to reference, stack,
  chain different effects.
- **Named block labels matching the sanitized track identifiers** — per
  `PATTERN-STYLE.md` §3 "Named blocks" convention.
- **Double quotes for mini-notation and normal Strudel APIs inside the
  exported pattern** — `note("…")`, `s("…")`, `cat("…")` should follow
  the repo's normal Strudel style.
- **Single quotes only for helper APIs that require literal JS strings**
  — for example `progression('ii V I', { key: 'C' })`. That rule does
  **not** apply to ordinary `note()` / `s()` mini strings.
- **Use `s()` rather than `.sound()`** — per `PATTERN-STYLE.md` §5.
- **Sanitize track identifiers** into valid, deduped JS names before
  emitting `const` declarations and labels.
- **Header comment** with provenance metadata — where it came from, how
  many tracks, quantization level.
- **`.room(0.2)`** light reverb on pitched tracks as a sensible default.

### Naming and identifier rules

- **Pattern file name** defaults to a sanitized version of the MIDI title
  or filename. If the MIDI metadata is useless, fall back to
  `imported-midi`.
- **Pattern name validation** should reuse the same rules as the existing
  new-pattern flow: letters, numbers, `-`, and `_` only.
- **Pattern name collisions** should surface the same kind of feedback as
  the current `handleNewPatternClick()` path instead of inventing a new
  duplicate-name behavior.
- **Track identifiers** should be normalized to valid JS names and
  deduped (`rightHand`, `rightHand2`, `track3`, etc.) while preserving the
  original track names in header comments / UI.

### Handling edge cases

| Situation                                   | Behavior                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty track (0 notes)                       | Skip entirely; don't generate a silent const.                                                                                                              |
| Track with only CC data (no notes)          | Skip in Phase 1; we don't import CC automation yet.                                                                                                        |
| Tempo changes mid-file                      | Use the first tempo and warn clearly. Tempo-map support is Phase 2.                                                                                        |
| Time signature changes                      | Use the first time signature and warn similarly.                                                                                                           |
| Very long file (>200 bars)                  | Generate anyway but warn: "Long MIDI — consider trimming to a section".                                                                                    |
| Very short file (<2 bars)                   | Generate normally.                                                                                                                                         |
| Triplets / compound grids                   | Phase 1 includes triplet-compatible candidates. If accuracy still misses threshold, import with a warning and let the user override the grid.              |
| Swing / humanized timing                    | Quantize to the nearest supported grid, warn if confidence is low, and keep the draft editable. Don't silently claim exact groove preservation in Phase 1. |
| Notes spanning bar boundaries               | Split/truncate at the bar edge as needed for readable code, and warn if this happens frequently (>10% of notes).                                           |
| Overlapping notes (same pitch)              | Keep the later one, drop the earlier. Overlapping same-pitch notes are usually a MIDI editor artifact.                                                     |
| Expressive velocity variation               | If velocity is not preserved in the generated pattern and the source has meaningful variation, warn that dynamic nuance has been omitted in Phase 1.       |
| Unknown drum notes                          | Emit `~` for that slot and warn with the unmapped MIDI numbers. Never invent sample names.                                                                 |
| Track names with spaces / punctuation       | Sanitize and dedupe emitted identifiers; preserve original names in UI/header comments.                                                                    |
| 0-velocity noteOn (MIDI noteOff convention) | `@tonejs/midi` already handles this — it pairs them as noteOff. No action needed.                                                                          |
| Pattern name collision                      | Reuse the existing new-pattern validation/collision path rather than silently overwriting or inventing a new save rule.                                    |
| Multi-tempo file                            | Phase 2. For now, use the first tempo.                                                                                                                     |

## Phase 1 — CLI-style converter + drag-and-drop UI

### What gets built

1. **`src/midi-to-strudel.js`** — the shared inbound translation core.
   Pure functions, no DOM, no direct dependency on UI.
2. **`src/midi-gm.js`** — shared GM instrument + drum mappings used by
   the importer and later capture migration.
3. **Import UI** — drag-and-drop zone + file picker + track selection
   dialog.
4. **Integration** — wired into `main.js` and the existing pattern-name /
   save flow.

### `src/midi-to-strudel.js` — public API

```js
/**
 * Parse a MIDI file ArrayBuffer and normalize it into the shared
 * TranslationInput model.
 *
 * @param {ArrayBuffer} buffer - Raw .mid file bytes
 * @returns {TranslationInput}
 */
export function parseMidiFile(buffer) { ... }

/**
 * Analyze normalized note tracks and return the information needed for
 * readable code generation.
 *
 * @param {TranslationInput} input
 * @param {ImportOptions} [options]
 * @returns {MidiAnalysis}
 */
export function analyzeTranslationInput(input, options) { ... }

/**
 * Generate a Strudel pattern source string from an analyzed MIDI file.
 *
 * @param {MidiAnalysis} analysis
 * @param {ImportOptions} options
 * @returns {string} - Complete pattern file content (the string that
 *                      goes inside export default `...`)
 */
export function generatePatternDraft(analysis, options) { ... }

/**
 * Convenience: parse + analyze + generate in one call for MIDI files.
 *
 * @param {ArrayBuffer} buffer
 * @param {ImportOptions} [options]
 * @returns {{ name: string, code: string, warnings: string[] }}
 */
export function midiFileToPattern(buffer, options) { ... }
```

The shared `TranslationInput` type:

```js
/**
 * @typedef {Object} TranslationInput
 * @property {string} sourceName - Song/file name
 * @property {number} bpm - Tempo (first tempo event)
 * @property {[number, number]} timeSignature - e.g. [6, 8]
 * @property {number} [ppq] - Pulses per quarter note when available
 * @property {number} [totalBars] - Precomputed bar count when available
 * @property {TranslationTrack[]} tracks
 */

/**
 * @typedef {Object} TranslationTrack
 * @property {string} name - Original track name
 * @property {number} channel
 * @property {boolean} isDrum - Channel 10 or instrument.percussion
 * @property {string} gmInstrument - GM instrument name
 * @property {TranslationNote[]} notes - Raw note events before quantization
 */

/**
 * @typedef {Object} TranslationNote
 * @property {string} name - Note name, lowercase ("c4", "f#3")
 * @property {number} midi - 0–127
 * @property {number} time - Seconds from song start
 * @property {number} duration - Seconds
 * @property {number} velocity - 0–1
 */
```

The `MidiAnalysis` intermediate type:

```js
/**
 * @typedef {Object} MidiAnalysis
 * @property {string} name - Song name from MIDI header
 * @property {number} bpm - Tempo (first tempo event)
 * @property {[number, number]} timeSignature - e.g. [6, 8]
 * @property {number} ppq - Pulses per quarter note
 * @property {number} totalBars - Calculated bar count
 * @property {number} duration - Total duration in seconds
 * @property {boolean} hasTempoChanges - Whether tempo changes mid-file
 * @property {boolean} hasTimeSigChanges - Whether time sig changes
 * @property {AnalyzedTrack[]} tracks
 * @property {string[]} warnings - Any issues detected during analysis
 */

/**
 * @typedef {Object} AnalyzedTrack
 * @property {string} name - Track name
 * @property {number} channel
 * @property {boolean} isDrum - Channel 10 or instrument.percussion
 * @property {string} gmInstrument - GM instrument name
 * @property {string} strudelSound - Mapped Strudel sound name
 * @property {number} noteCount
 * @property {string} pitchRange - "C2–G5" human-readable
 * @property {QuantizedNote[]} notes - All notes, quantized to grid
 * @property {number} quantizationAccuracy - 0–1, what fraction snapped cleanly
 * @property {string} identifier - Sanitized JS/block label to emit
 */

/**
 * @typedef {Object} QuantizedNote
 * @property {string} name - Note name, lowercase ("c4", "f#3", "bb2")
 * @property {number} bar - 0-indexed bar number
 * @property {number} gridPosition - Grid slot within the bar (0-indexed)
 * @property {number} gridDuration - Duration in grid units
 * @property {number} velocity - 0–1
 */
```

The `ImportOptions`:

```js
/**
 * @typedef {Object} ImportOptions
 * @property {number} [gridSubdivision] - Override auto-detected grid
 *   (4 = quarter, 8 = eighth, 16 = sixteenth, etc.)
 * @property {number[]} [trackIndices] - Which tracks to include
 *   (default: all non-empty tracks)
 * @property {boolean} [separateTracks=true] - One const per track
 *   (false = merge all into one)
 * @property {string} [patternName] - Override the generated const names
 * @property {boolean} [preserveVelocity=false] - Generate velocity data
 *   when Phase 2 support lands; Phase 1 may warn instead
 */
```

A follow-on `captureToPattern()` helper should be able to call
`analyzeTranslationInput()` + `generatePatternDraft()` without changing
the codegen path.

### Import dialog UI

Use the existing `modal.js` infrastructure (focus-trapped, keyboard-
navigable). The dialog has two states:

**State 1: file selection** (shown when "Import MIDI" is clicked)

```
┌─── Import MIDI ─────────────────────────────────────┐
│                                                      │
│     ┌─────────────────────────────────┐              │
│     │                                 │              │
│     │   Drop a .mid file here         │              │
│     │   or click to browse            │              │
│     │                                 │              │
│     └─────────────────────────────────┘              │
│                                                      │
└──────────────────────────────────────────────────────┘
```

A simple drag-and-drop zone with file input fallback. Accepts `.mid` and
`.midi` extensions only. Max file size: 5MB (generous — most MIDI files
are <100KB; this prevents accidental loading of non-MIDI files).

**State 2: track selection + options** (shown after file is parsed)

```
┌─── Import: "Piano Template" ────────────────────────┐
│                                                      │
│  Name: piano-template                                │
│                                                      │
│  6/8 at 200 BPM · 87 bars · 1453 notes              │
│                                                      │
│  Tracks:                                             │
│  ☑ Right Hand    560 notes  C3–C6   → gm_piano       │
│  ☑ Left Hand     698 notes  D1–F3   → gm_piano       │
│  ☐ Staff-1       (empty)                              │
│  ☑ Strings       195 notes  A3–C6   → gm_strings     │
│                                                      │
│  Grid: ○ 8th  ○ 16th  ● auto (8th detected)         │
│                                                      │
│  ⚠ 1 note didn't snap cleanly to grid               │
│                                                      │
│         [ Cancel ]   [ Import as pattern ]           │
└──────────────────────────────────────────────────────┘
```

- **Name field** — prefilled from song title / file name, validated with
  the same regex and collision rules as the existing new-pattern flow.
- **Track checkboxes** — check/uncheck which tracks to include. Empty
  tracks are unchecked and disabled.
- **Instrument mapping** shown inline — the user can see what Strudel
  sound was picked. (Phase 2: make this a dropdown to override.)
- **Grid selector** — radio buttons for common grids plus "auto" which
  shows what was detected. The quantization accuracy is shown as a
  warning if <95%.
- **Warnings** — displayed as amber `⚠` lines below the options.
- **Import button** — creates the pattern (either via `/api/save` in
  dev mode, or into the localStorage store in prod, same as the existing
  "new pattern" flow in `src/patterns.js:handleNewPatternClick`).

### Entry point: how the user triggers import

Two paths:

1. **Menu action** — add an "Import MIDI" item to the left rail's `+`
   menu (or as a separate button near the `+` button). This opens the
   import dialog.
2. **Drag-and-drop on the editor** — if the user drags a `.mid` file
   onto the editor area, intercept it (check `dataTransfer.files` for
   `.mid`/`.midi` extension) and open the import dialog directly at
   State 2.

The second path is the "delight" path — it should feel like dropping a
file into a DAW. Only intercept valid MIDI files; non-MIDI drops should
fall through to the browser/editor's normal behavior.

### Wiring into `main.js`

Minimal touch. Import the UI glue and wire one event listener:

```js
import { showMidiImportDialog } from "./ui/midi-import-dialog.js";
```

And connect it to the left rail's import button / drag-and-drop handler.
The dialog itself handles everything — parsing, showing tracks, calling
codegen, and saving the result via the existing pattern creation flow.
If any name-validation or duplicate-check logic currently lives only in
`src/patterns.js`, extract and reuse it rather than duplicating it in the
dialog.

### Files

| File                           | Purpose                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `src/midi-to-strudel.js`       | Shared inbound core: parse/normalize, analyze, and generate readable Strudel drafts. |
| `src/midi-gm.js`               | Shared GM instrument/drum mappings for inbound MIDI features.                        |
| `src/midi-to-strudel.test.js`  | Unit tests for the core module. Use `test-midi.mid` as a fixture.                    |
| `src/ui/midi-import-dialog.js` | Import dialog UI. Uses `modal.js`.                                                   |
| `src/styles/midi-import.css`   | Styles for the import dialog.                                                        |
| `src/main.js`                  | Import trigger + drag/drop handler. Minimal touch.                                   |
| `src/patterns.js`              | Reuse/extract pattern-name validation and creation flow.                             |
| `test-midi.mid`                | Test fixture (already in repo).                                                      |

Phase 1 does not rewrite `src/midi-bridge.js`, but the new core must be
written so `buildPatternFromCapture()` can migrate to it next without
changing the musical codegen rules a second time.

### Acceptance — Phase 1

- [ ] User can click "Import MIDI" in the left rail and select a `.mid`
      file.
- [ ] User can drag a `.mid` file onto the editor to trigger import.
- [ ] The dialog shows song metadata (name, tempo, time sig, bar count).
- [ ] The dialog lists tracks with note count, pitch range, and mapped
      Strudel sound.
- [ ] Empty tracks are shown but disabled.
- [ ] User can check/uncheck which tracks to import.
- [ ] User can choose quantization grid (auto-detected by default).
- [ ] Clicking "Import" creates a new pattern file (dev: `patterns/`,
      prod: store).
- [ ] Pattern name is editable, sanitized, and collision-checked via the
      same rules as the existing new-pattern flow.
- [ ] The generated pattern code follows `PATTERN-STYLE.md`:
      `setcpm(...)`, named consts, named blocks, note names not MIDI
      numbers, `s()` not `.sound()`, and double-quoted mini strings
      inside the exported pattern.
- [ ] The generated pattern evaluates without errors and produces
      audible output.
- [ ] `test-midi.mid` (6/8 at 200 BPM, 87 bars) imports cleanly with
      all 3 non-empty tracks, auto-detects 8th-note grid.
- [ ] A simple 4/4 MIDI file (create one for testing if needed) imports
      correctly.
- [ ] Drum tracks (channel 10) generate `s("bd ~ sd ~ ...")` style
      output, not `note(...)`.
- [ ] GM instruments map to valid Strudel sound names (verified with
      `strasbeat.hasSound()`).
- [ ] Track identifiers are sanitized and deduped cleanly.
- [ ] Warnings are shown when: quantization accuracy <95%, tempo changes
      present, velocity nuance is omitted, unmapped drum notes are
      encountered, or the file is very long.
- [ ] Invalid files (not MIDI, corrupt, >5MB) show a clear error, don't
      crash.
- [ ] The shared core accepts normalized translation input rather than
      depending directly on `@tonejs/midi`'s raw shape.
- [ ] Existing patterns, playback, save, export — all unaffected
      (regression check).

---

## Phase 2 — polish and power features (future, not in this pass)

Documented here for context so Phase 1 decisions don't paint us into a
corner. **Do not build any of this in Phase 1.**

### Repetition detection

Detect when bars repeat and emit `cat()` with variables instead of
duplicated bars:

```js
const A = "c4@2 e4 g4@2 e4";
const B = "d4@2 f4 a4@2 f4";

const melody = note(cat(A, A, B, A));
```

This makes the output dramatically more readable for songs with verse/
chorus structure. Algorithm: hash each bar's note content, find repeated
sequences, extract as named consts.

### Harmonic uplift to native Strudel abstractions

When harmonic confidence is high, lift obvious chord tracks into more
native Strudel output such as `"<Cm7 F7 Bb^7>".voicing()` or
`progression('ii V I', { key: 'C' })` instead of dense bracketed note
lists.

This must be opt-in or confidence-gated. Never silently replace explicit
notes with inferred harmony when the result might be musically wrong.

### Live capture migration

Move `src/midi-bridge.js` capture export onto the same translation core
so live capture and file import stop producing different Strudel dialects.

### Velocity as `.velocity()` pattern

Generate a parallel velocity pattern when velocity variation is musically
significant (not just uniform 0.85):

```js
melody: stack(melody).s("gm_piano").velocity("0.8 0.6 0.9 0.7 ...");
```

### Tempo map support

For files with tempo changes, split into `arrange()` sections:

```js
arrange(
  [16, intro_120bpm],
  [32, verse_140bpm],
  // ...
);
```

Or generate `setcpm()` calls at the start of each section.

### CC automation (sustain pedal, expression)

Map CC64 (sustain) to `.legato()` or `.clip()` adjustments. Map CC11
(expression) to `.gain()` modulation. Map CC7 (volume) to `.gain()`.

### Track instrument override in dialog

Let the user change the Strudel sound mapping before import — dropdown
per track in the dialog.

### Quantization preview

Show a mini piano-roll preview in the dialog, with notes colored by
how well they snapped to the grid. Let the user slide the grid
resolution and see the effect in real-time before committing.

### Swing / humanization inference

Triplet-compatible grids are already in Phase 1. The future work here is
detecting when the file is intentionally swung or humanized and offering
smarter defaults / preview hints rather than only snapping to the nearest
grid.

### Seed-library ingestion

Build a higher-level workflow that imports folders or packs of MIDI
assets, preserves the source `.mid` files, and generates app-owned
Strudel drafts plus metadata through this same translation core.

---

## Implementation notes

### The quantization grid — detailed algorithm

```js
function detectGrid(notes, timeSig, barDuration) {
  // Candidate grids: subdivisions per bar
  // For 4/4: whole=1, half=2, quarter=4, 8th=8, 16th=16, 32nd=32
  // For 6/8: dotted-half=1, dotted-quarter=2, quarter=3, 8th=6, 16th=12, 32nd=24
  // Derive from timeSignature:
  //   baseDivisions = timeSig[0] (beats per bar in the denominator unit)
  //   e.g. 6/8 → 6 eighth-note beats, 4/4 → 4 quarter-note beats

  const baseDivisions = timeSig[0];
  const gridCandidates = new Set([
    baseDivisions,
    baseDivisions * 2,
    baseDivisions * 4,
  ]);

  // Simple meters may contain triplet subdivisions (4/4 → 12, 24;
  // 3/4 → 9, 18). Compound meters like 6/8 already encode triplet feel
  // in the straight candidates above (6, 12, 24).
  if (timeSig[1] === 4) {
    gridCandidates.add(baseDivisions * 3);
    gridCandidates.add(baseDivisions * 6);
  }

  const scored = [];
  for (const grid of [...gridCandidates].sort((a, b) => a - b)) {
    const unit = barDuration / grid;
    let onGrid = 0;
    for (const note of notes) {
      const posInBar = note.time % barDuration;
      const slot = posInBar / unit;
      if (Math.abs(slot - Math.round(slot)) < 0.1) onGrid++;
    }
    scored.push({ grid, accuracy: onGrid / notes.length });
  }

  const passing = scored.filter((candidate) => candidate.accuracy >= 0.95);
  if (passing.length > 0) return passing[passing.length - 1];

  // Fallback: highest accuracy, break ties toward the finer grid.
  return scored.sort((a, b) => b.accuracy - a.accuracy || b.grid - a.grid)[0];
}
```

### Note name formatting

`@tonejs/midi` returns names like `"C4"`, `"C#4"`, `"A#3"` — always
using **sharps**, never flats. Strudel mini-notation accepts both sharps
and flats and is case-insensitive, but `PATTERN-STYLE.md` §4 documents
the convention as lowercase with both `b` (flat) and `#` (sharp).

For Phase 1, just **`.toLowerCase()`** the `@tonejs/midi` output. This
gives `c#4`, `a#3` — valid, readable, and correct. The `a#` vs `bb`
enharmonic choice is cosmetic (both resolve to the same MIDI number in
Strudel). A future refinement could infer the key signature and prefer
flats in flat keys, but it's not worth the complexity in Phase 1.

### Bar-to-mini-notation generation

This is the core codegen function. Pseudocode:

```js
function barToMiniNotation(notes, gridSize) {
  // notes: QuantizedNote[] for this bar, sorted by gridPosition
  // gridSize: number of grid slots in this bar

  const slots = new Array(gridSize).fill(null);

  // Place notes into slots
  for (const note of notes) {
    if (!slots[note.gridPosition]) {
      slots[note.gridPosition] = {
        names: [note.name],
        duration: note.gridDuration,
      };
    } else {
      // Chord: add to existing slot
      slots[note.gridPosition].names.push(note.name);
      // Use the longest duration of chord tones
      slots[note.gridPosition].duration = Math.max(
        slots[note.gridPosition].duration,
        note.gridDuration,
      );
    }
  }

  // Generate mini-notation tokens
  const tokens = [];
  let i = 0;
  while (i < gridSize) {
    const slot = slots[i];
    if (!slot) {
      // Rest — but check if previous note's duration covers this slot
      tokens.push("~");
      i++;
    } else {
      const nameStr =
        slot.names.length === 1
          ? slot.names[0]
          : `[${slot.names.sort(byPitch).join(",")}]`;

      // Duration: if > 1 grid unit, use @N and skip covered slots
      if (slot.duration > 1) {
        tokens.push(`${nameStr}@${slot.duration}`);
        i += slot.duration;
      } else {
        tokens.push(nameStr);
        i++;
      }
    }
  }

  return tokens.join(" ");
}
```

**Important subtlety:** when a note has duration > 1 grid unit, the `@N`
notation takes up that many slots visually, so the subsequent slots
should NOT also emit `~` for the same time range. The loop skips `i`
forward by `slot.duration` to handle this.

### Testing strategy

The `test-midi.mid` file in the repo is the primary test fixture. Tests
should cover:

1. **`parseMidiFile()` + `analyzeTranslationInput()`** — correct tempo,
   time sig, track count, note counts, and instrument detection.
2. **`generatePatternDraft()`** — output is valid Strudel source (no
   syntax errors, `setcpm` present, named blocks, uses `s()` instead of
   `.sound()`, and keeps double-quoted mini strings inside the exported
   pattern).
3. **Quantization accuracy** — the test file should report ≥99% on-grid
   notes with auto-detected 8th-note grid.
4. **Round-trip sanity** — the generated pattern, when evaluated in
   Strudel, should produce notes at approximately the same pitches and
   times as the source MIDI (within quantization tolerance).
5. **Edge cases** — empty tracks skipped, invalid input throws
   descriptively, drum channel detected, GM instrument mapped, track
   identifiers sanitized, and warnings surfaced for dropped velocity /
   unmapped drums.

Use `node --test` (Node's built-in test runner), same as the existing
`progression.test.js` and `roman.test.js`.

### CSS for the import dialog

Follow `design/SYSTEM.md` for all tokens. The dialog should feel
consistent with the existing modal and settings drawer. Key styles:

- Drop zone: dashed border, `--surface-2` background, `--accent` on
  drag-over.
- Track list: monospace note counts, left-aligned names, right-aligned
  metadata.
- Grid radio buttons: styled like the existing settings toggles.
- Warnings: `--rec` color (the project's alert/warning token), `⚠` prefix.
- Import button: primary style (filled `--accent`).
