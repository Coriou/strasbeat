# Strudel cheatsheet

Just enough to read & write the patterns in this repo. For everything
else: <https://strudel.cc/learn>.

## The mental model

A Strudel **pattern** is a function from time → events. You don't
write event lists; you write _expressions_ that describe how events
unfold over **cycles** (one cycle ≈ one bar by default). Tempo is set
in cycles-per-second:

```js
setcps(120 / 60 / 4); // 120 BPM, 4 beats per cycle = 0.5 cps
```

> **Style:** for pattern formatting rules, API choices, and do/don't lists,
> see `design/PATTERN-STYLE.md`.

## Mini-notation (the strings)

Inside `s("…")`, `n("…")`, `note("…")`:

| syntax    | meaning                                   |
| --------- | ----------------------------------------- |
| `bd sd`   | two events, evenly spaced over the cycle  |
| `bd*4`    | repeat 4× (`bd bd bd bd`)                 |
| `bd/2`    | stretch over 2 cycles                     |
| `~`       | rest / silence                            |
| `[bd sd]` | group: fits into one parent step          |
| `<a b c>` | alternate one element per cycle           |
| `bd:2`    | sample number 2 of the `bd` bank          |
| `bd?`     | 50% chance of playing                     |
| `bd!3`    | repeat literally 3× (no time compression) |
| `bd(3,8)` | Euclidean: 3 hits across 8 steps          |
| `a , b`   | layer (chord-like, plays simultaneously)  |
| `bd@3 sd` | weighted: bd takes 3× the time of sd      |

## Sources

| function                                         | what it makes                                             |
| ------------------------------------------------ | --------------------------------------------------------- |
| `s("bd sd")`                                     | trigger samples by name                                   |
| `n("0 1 2")`                                     | numeric index — used for sample variants or scale degrees |
| `note("c e g")`                                  | pitched notes for synths/soundfonts                       |
| `sine`, `saw`, `tri`, `square`, `rand`, `perlin` | continuous signals (LFOs)                                 |

`sound` is an alias for `s`. `freq` lets you specify Hz directly.

## Combining

| function                  | what it does                             |
| ------------------------- | ---------------------------------------- |
| `stack(a, b, c)`          | layer patterns simultaneously            |
| `cat(a, b)` / `seq(a, b)` | play one after the other (one per cycle) |
| `a.append(b)`             | concat into one cycle                    |
| `a.add(b)`                | numeric add (e.g. transpose)             |
| `a.struct("x ~ x x")`     | impose a rhythm onto values              |

## Transformations (chain off any pattern)

Time:

- `.fast(2)` / `.slow(2)` — speed up / slow down
- `.rev()` — reverse
- `.early(0.25)` / `.late(0.25)` — nudge
- `.ply(2)` — repeat each event N times in place
- `.chop(8)` — chop a sample into 8 grains

Mutation:

- `.jux(rev)` — split L/R channels, apply fn to one
- `.off(1/8, fn)` — overlay a delayed, transformed copy
- `.every(4, fn)` — apply fn every Nth cycle
- `.sometimes(fn)` / `.rarely(fn)` / `.often(fn)` — probabilistic

Audio:

- `.gain(0.6)` — volume (0–1+)
- `.pan(0.2)` — stereo position (0=L, 1=R)
- `.lpf(1000).lpq(8)` — low-pass filter cutoff & resonance
- `.hpf(200)` — high-pass filter
- `.room(0.5).size(0.8)` — reverb
- `.delay(0.5).delaytime(0.375).delayfeedback(0.4)` — delay
- `.attack(0.01).decay(0.1).sustain(0.5).release(0.2)` — ADSR
- `.shape(0.4)` — distortion
- `.crush(6)` — bitcrush

## Picking sounds

**Default samples** (TidalCycles "dirt-samples"): `bd cp hh sd oh rim cr ride tom mt lt …`
plus weirder ones like `breath east bass jvbass amencutup` — try them.

**Drum machines** via `.bank('TR909')` — a few you'll likely use:
`RolandTR808`, `RolandTR909`, `RolandTR707`, `RolandTR606`, `LinnDrum`,
`AkaiLinn`, `KorgKR55`, `OberheimDMX`, `RolandCR78`. After picking a
bank, the same names (`bd sd hh cp oh …`) map to that machine.

**Soundfonts** (General MIDI) — pitched, use with `note()`. **Names are
_not_ 1:1 with the official GM-128 list — they've been shortened.** A few
verified working ones:

- pianos / keys: `gm_piano` _(not gm_acoustic_grand_piano!)_, `gm_epiano1`,
  `gm_epiano2`, `gm_harpsichord`, `gm_clavinet`
- organs: `gm_drawbar_organ`, `gm_percussive_organ`, `gm_church_organ`,
  `gm_rock_organ`, `gm_reed_organ`
- bass: `gm_acoustic_bass`, `gm_electric_bass_finger`, `gm_electric_bass_pick`,
  `gm_synth_bass_1`, `gm_synth_bass_2`, `gm_slap_bass_1`
- leads: `gm_lead_1_square`, `gm_lead_2_sawtooth`, `gm_lead_3_calliope`,
  `gm_lead_4_chiff`, `gm_lead_5_charang`, `gm_lead_6_voice`,
  `gm_lead_7_fifths`, `gm_lead_8_bass_lead`
- pads: `gm_pad_warm` _(not gm_pad_2_warm!)_, `gm_pad_new_age`,
  `gm_pad_choir`, `gm_pad_bowed`, `gm_pad_metallic`, `gm_pad_halo`,
  `gm_pad_sweep`, `gm_pad_poly`
- strings/voices: `gm_string_ensemble_1`, `gm_string_ensemble_2`,
  `gm_choir_aahs`, `gm_voice_oohs`, `gm_pizzicato_strings`
- guitars: `gm_acoustic_guitar_nylon`, `gm_acoustic_guitar_steel`,
  `gm_electric_guitar_clean`, `gm_electric_guitar_jazz`,
  `gm_electric_guitar_muted`, `gm_distortion_guitar`, `gm_overdriven_guitar`
- mallets: `gm_marimba`, `gm_xylophone`, `gm_vibraphone`, `gm_glockenspiel`,
  `gm_celesta`, `gm_kalimba`, `gm_music_box`, `gm_steel_drums`

**To find what's actually loaded**, open the browser devtools and run:

```js
strasbeat.findSounds("piano"); // any sound with "piano" in the name
strasbeat.findSounds("gm_pad"); // all soundfont pads
strasbeat.findSounds("909"); // every 909 sample
strasbeat.hasSound("gm_piano"); // true / false
strasbeat.countSounds(); // total registered sounds (~1000+)
```

> **Footgun:** if you write `sound("some_name")` and `some_name` isn't in
> the soundMap, the pattern produces **no audible events** with no error.
> When a layer goes silent, `strasbeat.hasSound("…")` is the first thing
> to check. The MIDI bridge surfaces this as a console warning so you
> notice immediately.

**Synths** built in: `sine`, `triangle`, `sawtooth`, `square`, `white`,
`pink`, `brown`. Use with `note()` or `freq()`.

## Music theory helpers

```js
note("0 2 4 5").scale("C:minor"); // scale degrees → notes
"<Cm9 Fm9 Bb^7>".voicing(); // chord symbols → voicings (singular!)
n("0 2 4 7").scale("C4:minor:pentatonic");
```

## Strasbeat extensions

These are runtime helpers that **strasbeat ships on top of Strudel** —
they live in `src/strudel-ext/` and are wired into Strudel's `evalScope`
in `src/main.js`, so they're callable from any pattern file as if they
were built-in. None of these exist in upstream Strudel; you won't find
them at <https://strudel.cc/learn/>.

### `progression()` — one-line chord progressions

```js
$: progression("Cm7 F7 Bb^7 Eb^7");
$: progression("Cm7 F7 Bb^7 Eb^7", { rhythm: "arp-up" });
$: progression("ii V I", { key: "C", style: "jazz-comp" });
$: progression("C G Am F", { style: "folk-strum", bass: true });
```

The chord string is a whitespace-separated list of either **absolute
chord symbols** (`Cm7 F7 Bb^7 Eb^7`) or **Roman numerals** (`ii V I`,
when `options.key` is supplied). Strudel's voicing dictionaries do the
musical work — `progression()` only owns the defaults, the rhythm
preset table, and the style merge.

> **Single-quote rule**: chord strings _must_ be single-quoted. Strudel's
> transpiler rewrites **every** double-quoted literal into a `mini(...)` call
> — regardless of position in the AST — so `progression("Cm7 F7")` would
> silently land inside the function as a Pattern instead of a string. The
> same rule applies to option string values like `{ rhythm: 'arp-up' }`.
> The function detects the failure mode and warns, but it's cleaner to
> just type `'`.
>
> **Escape hatch**: if you must use double quotes in a region, wrap it with
> `/* mini-off */` … `/* mini-on */` comments to disable the transpiler
> rewrite for that block.

#### Options

| key      | type           | default      | what it does                                                                       |
| -------- | -------------- | ------------ | ---------------------------------------------------------------------------------- |
| `sound`  | string         | `gm_epiano1` | sound name (verify with `strasbeat.hasSound`)                                      |
| `dict`   | string         | `ireal`      | voicing dictionary: `ireal`, `lefthand`, `triads`, `guidetones`, `legacy`          |
| `rhythm` | string         | `block`      | rhythm preset name OR a raw mini-notation arp string                               |
| `bass`   | bool \| string | `false`      | layer a bass line on chord roots; pass a sound name to override `gm_acoustic_bass` |
| `style`  | string         | —            | bundle of sound + dict + rhythm + FX (see styles below)                            |
| `key`    | string         | —            | required for Roman-numeral input. Major (`'C'`, `'G'`, `'Bb'`) or minor (`'Am'`)   |

#### Chord symbol cheatsheet

Strudel's voicing dictionaries use iReal Pro-style symbols. Lead sheets,
chord chart websites, and music theory textbooks often use Unicode or
longhand names that **won't resolve** — the lookup is a direct dictionary
key match with no normalisation. Translate before pasting:

| Chart / lead sheet        | Strudel symbol   | Meaning                        |
| ------------------------- | ---------------- | ------------------------------ |
| `CΔ7`, `Cmaj7`            | `C^7`            | major 7th                      |
| `CΔ`, `Cmaj`              | `C^`             | major triad (explicit)         |
| `Cm`, `Cmin`              | `C-` (or `Cm`)   | minor triad                    |
| `Cm7`, `Cmin7`            | `C-7` (or `Cm7`) | minor 7th                      |
| `C7`                      | `C7`             | dominant 7th (works as-is)     |
| `Cø7`, `Cm7(♭5)`, `Cm7b5` | `Ch7`            | half-diminished                |
| `Cdim7`, `C°7`            | `Co7`            | fully diminished 7th           |
| `Cdim`, `C°`              | `Co`             | diminished triad               |
| `Caug`, `C+`              | `C+`             | augmented (works as-is)        |
| `Csus4`, `Csus`           | `Csus`           | suspended 4th                  |
| `Cadd9`                   | `Cadd9`          | added 9th (works as-is)        |
| `C6`                      | `C6`             | major 6th (works as-is)        |
| `Cm6`                     | `C-6`            | minor 6th                      |
| `C♭`, `C♯`                | `Cb`, `C#`       | **ASCII only** for accidentals |

**Key rules:**

- `^` = major, `^7` = major 7th. Plain root (`C`) also resolves as major.
- `-` = minor, `-7` = minor 7th. `m` / `m7` are aliases (both work).
- `h` / `h7` = half-diminished (m7♭5). The `h` is iReal Pro convention.
- `o` / `o7` = diminished. `°` (Unicode) must be rewritten to `o` (ASCII).
- All accidentals must be ASCII `b` and `#` — never `♭` or `♯`.
- Slash chords work natively: `Cm7/G` → bass note G in the voicing.

#### Rhythm presets

| name       | feel                                             |
| ---------- | ------------------------------------------------ |
| `block`    | full chord held across the whole cycle (default) |
| `strum`    | 4 ascending sweeps per cycle                     |
| `comp`     | jazz off-beat comp (stabs on the "and" of 2 & 4) |
| `arp-up`   | ascending single-note arpeggio                   |
| `arp-down` | descending single-note arpeggio                  |
| `alberti`  | classical Alberti pattern (root–top–middle–top)  |

Pass any unrecognised string containing whitespace, brackets, commas, or
rests (e.g. `'0 [0,2] 1'`) and it's forwarded verbatim to `.arp()` as
the escape hatch.

#### Style presets

| name         | sound                      | dict       | rhythm   | fx                       |
| ------------ | -------------------------- | ---------- | -------- | ------------------------ |
| `jazz-comp`  | `gm_epiano1`               | `ireal`    | `comp`   | `room: 0.4, gain: 0.65`  |
| `pop-pad`    | `gm_pad_warm`              | `ireal`    | `block`  | `room: 0.6, attack: 0.4` |
| `lo-fi`      | `gm_epiano1`               | `lefthand` | `arp-up` | `room: 0.5, lpf: 1500`   |
| `folk-strum` | `gm_acoustic_guitar_nylon` | `triads`   | `strum`  | `room: 0.2`              |
| `piano-bare` | `gm_piano`                 | `ireal`    | `block`  | `room: 0.3`              |

Explicit options always override style fields:
`progression('Cm7 F7', { style: 'jazz-comp', sound: 'gm_piano' })` is
"jazz comp on a real piano".

#### Roman numerals

```js
progression("ii V I", { key: "C" }); // → Dm G C
progression("I V vi IV", { key: "G" }); // → G D Em C
progression("i iv v", { key: "Am" }); // → Am Dm Em (natural minor)
progression("I bIII IV", { key: "C" }); // → C Eb F
progression("vii°7", { key: "C" }); // → Bo7 (° → o for Strudel)
progression("ii7 V7 I^7", { key: "F" }); // → Gm7 C7 F^7
```

- **Uppercase** numeral → major triad. **Lowercase** → minor triad.
- **Accidentals** on the numeral (`bIII`, `#iv`) lower / raise the root
  chromatically.
- **Extensions** stick to the numeral: `ii7` → `Dm7`, `V7` → `G7`,
  `I^7` → `C^7`.
- **Diminished** `°` is rewritten to `o` (`vii°` → `Bo`).
- **Minor keys** use natural minor (Aeolian) — no harmonic / melodic
  variants.
- Mixing Roman and absolute tokens in the same call is **not**
  supported. The first token decides; if any later token fails to
  resolve in Roman mode, the whole call returns silence with a
  `[strasbeat]` warning.
- Missing `key` with Roman input → silence + warning. Guessing a key
  would be worse than failing audibly.

#### Live demo

`patterns/06-progression-demo.js` shows the helper in action — chords +
arpeggio + bass + drums in 30 lines. Source for the helper itself is in
`src/strudel-ext/progression.js`; the spec (Phase 1–3) is in
`design/work/07-chord-progression.md`.

## Keyboard shortcuts (in the editor)

| key                    | action                                   |
| ---------------------- | ---------------------------------------- |
| `Ctrl/Cmd+Enter`       | evaluate (play / update)                 |
| `Ctrl/Cmd+.`           | stop                                     |
| `Ctrl/Cmd+Shift+Enter` | evaluate just the block under the cursor |

## Render to WAV

The toolbar **⤓ wav** button renders the current pattern offline (faster
than real-time, via `OfflineAudioContext`) and downloads a WAV. You'll
be prompted for a length in cycles — at the default `setcps(120/60/4)`
that's one bar per cycle, so `4` cycles = a 4-bar loop.

Output is 48kHz, 16-bit, stereo. The filename matches the currently
loaded pattern (e.g. `04-melody.wav`). The live audio context is torn
down during rendering and re-initialised afterwards, so you can press
play again immediately without reloading.

> **About "tracks":** Strudel has no track concept — its closest
> equivalent is `orbit`, a global FX-bus index. Layers in the same
> `stack(...)` share orbit 0 by default and render as a single mix. To
> get per-stem output you'd need to assign each layer its own
> `.orbit(N)` and either render multiple times (commenting out the
> others) or modify the export call to enable `multiChannelOrbits`,
> which packs each orbit into its own channel pair of one big WAV.

## Live MIDI keyboard

strasbeat has a built-in bridge from a hardware MIDI keyboard to the
Strudel audio engine. Plug in a USB MIDI device — the toolbar status bar
will show its name. Pick a **preset** (Piano, EPiano, Pluck, Pad, …) and
play. Notes route through `superdough` directly, so they share the
exact same FX bus as anything the editor pattern is playing — improvise
over a running groove and they sit in the same reverb/delay space.

### How it works

The bridge uses a "trigger-and-decay" model: each noteon schedules a
voice with a tuned envelope (long natural decay for piano-like sounds,
medium hold for organ/strings) and ignores noteoff. This is intentional
— it keeps the implementation 100% public-API and means any Strudel
sound can be played live without patching internals. The trade-off is
that _truly_ sustained pads (key-up release) aren't supported; everything
decays naturally based on the preset's envelope.

### Capture mode

Hit **● capture** in the toolbar, play a phrase on the keyboard, hit
the button again to stop. You'll be prompted for a filename and the
played notes are converted into a real Strudel pattern file in
`patterns/`:

```js
// captured live from MIDI · 7 steps · preset "epiano"
// edit me — try .slow(2), .fast(2), add .gain(), or change the sound

note("60 64 67 72 [60,64,67] 67 60").sound("gm_epiano1");
```

The captured file behaves like any other pattern: it shows up in the
dropdown, can be edited in the in-browser editor, and is fully version-
controlled. The intended workflow is:

```
play keyboard → capture phrase → save as pattern file →
git diff → tweak in editor → re-evaluate → commit
```

— hands-first composition, code-second refinement.

### Adding your own preset

Edit `src/midi-bridge.js` and add to the `presets` object:

```js
mypreset: {
  label: 'My Sound',
  s: 'gm_marimba',           // pick from strasbeat.findSounds(...)
  duration: 2,
  attack: 0.01, decay: 2, sustain: 0, release: 0.1,
  room: 0.3,
}
```

The dropdown will rebuild automatically on save (Vite HMR).

## Where to look next

- Search the function reference: <https://strudel.cc/learn/>
- Browse examples in `strudel-source/examples/`
- Read source for any function: `strudel-source/packages/core/`,
  `strudel-source/packages/mini/`, etc. JSDoc comments at the top of
  each definition explain the args.
