# Pattern style guide

**Read this before writing or editing any `patterns/*.js` file.**

This document codifies modern Strudel idioms as of the version strasbeat
ships (core 1.2.6 / codemirror 1.3.0). Everything here is verified against
the installed packages and the upstream docs/examples. When in doubt, the
upstream source under `strudel-source/packages/` is the tiebreaker.

---

## 1. File format

Every pattern lives in `patterns/NN-name.js` and default-exports a
template-literal string:

```js
// 06-groove — short description of what this is
// concepts: list the 2-3 Strudel ideas the pattern demonstrates

export default `
setcpm(120/4)

$: s("bd sd:1 bd sd:1").bank("RolandTR909").gain(0.9)
$: s("hh*8").bank("RolandTR909").gain(0.45)

$: note("<c2 c2 eb2 g2>*4")
  .s("sawtooth")
  .lpf(sine.range(400, 1400).slow(8))
  .lpq(8)
  .decay(0.12).sustain(0)
  .gain(0.7)
`;
```

Rules:
- **Header comment** outside the backticks: `// NN-name — what it is`.
- **Concepts comment**: list the 2-3 Strudel features the pattern uses,
  so a reader (or agent) can find examples of specific techniques.
- **No leading whitespace** inside the template literal — the string
  starts on the line after the opening backtick.
- **One blank line** between the tempo line and the first pattern block.

---

## 2. Tempo

Use `setcpm(BPM / beats_per_cycle)`, not `setcps(BPM/60/beats_per_cycle)`.

```js
// GOOD — reads as "120 BPM in 4/4"
setcpm(120/4)

// AVOID — same thing, harder to read
setcps(120/60/4)
```

`setcpm` (cycles per minute) is the modern wrapper around `setcps` (cycles
per second). Both work; `setcpm` is clearer for musicians thinking in BPM.

The formula: `setcpm(BPM / beats_per_cycle)`.
- 120 BPM, 4 beats/cycle → `setcpm(120/4)` = `setcpm(30)`
- 140 BPM, 4 beats/cycle → `setcpm(140/4)` = `setcpm(35)`

---

## 3. Pattern registration: `$:` over `stack()`

Use **`$:` label syntax** for independent layers. The transpiler converts
`$: expr` into `expr.p('$N')` which registers each layer as a separate
pattern with the scheduler.

```js
// GOOD — each layer is independent, can be soloed/muted, evaluated separately
$: s("bd*4").bank("RolandTR909")
$: s("~ cp").bank("RolandTR909")
$: note("c2 eb2 g2 c3").s("sawtooth").lpf(800)

// AVOID — monolithic stack, can't isolate layers
stack(
  s("bd*4").bank("RolandTR909"),
  s("~ cp").bank("RolandTR909"),
  note("c2 eb2 g2 c3").s("sawtooth").lpf(800),
)
```

**When to use `stack()` inside a `$:` block:** when two patterns are
genuinely a single voice (e.g. a multi-line chord progression that must
stay in sync, or a comma-separated drum kit):

```js
// Fine — single drum-kit voice
$: s("bd*2, ~ sd, hh*8").bank("RolandTR909")

// Fine — tightly coupled chord + bass that share the same FX chain
$: stack(
  "<Cm9 Fm9 Bb^7>".voicing().s("gm_epiano1").room(0.4),
  note("<c2 f2 bb1>").s("gm_acoustic_bass"),
)
```

### Named blocks

For complex compositions, name your blocks with a descriptive label
instead of `$`:

```js
drums: s("bd*2, ~ sd:1, hh*8").bank("RolandTR909").gain(0.8)
bass: note("<c2 c2 eb2 g2>*4").s("sawtooth").lpf(800).gain(0.6)
keys: "<Cm9 Fm9 Bb^7>".voicing().s("gm_epiano1").room(0.4).gain(0.7)
```

Named blocks show up in the block-based evaluator and make large
compositions navigable.

---

## 4. Notes: always use note names, never MIDI numbers

```js
// GOOD
note("c3 e3 g3 b3")
note("c2 eb2 g2 bb2")

// BAD — unreadable without a MIDI chart
note("48 52 55 59")
note("36 39 43 46")

// VERY BAD — mixing conventions
note("~ 52 ~ b5")
```

Always include the octave: `c3`, not just `c`. Flats use `b` suffix
(`eb3`, `bb2`), sharps use `#` (`f#4`, `c#3`).

When notes are scale degrees (not absolute pitches), use `n()` with
`.scale()`:

```js
// Scale degrees — n values are indices, not MIDI
n("0 2 4 7").scale("C4:minor:pentatonic").s("gm_lead_2_sawtooth")
```

---

## 5. Sound selection: `s()` everywhere

Use `s()` for the sound/instrument. Never use `.sound()` — it's the
same function but `s()` is the upstream convention and shorter.

```js
// GOOD
note("c3 e3 g3").s("gm_epiano1")
s("bd sd").bank("RolandTR909")

// AVOID
note("c3 e3 g3").sound("gm_epiano1")
```

**Always verify sound names** before using them. Unknown names produce
silent output with no error:

```js
strasbeat.hasSound("gm_epiano1")    // true/false
strasbeat.findSounds("piano")       // search
```

---

## 6. Chords and voicings: modern API

Use `.voicing()` (singular) with `.dict()`, not the legacy
`.voicings('lefthand').note()` chain:

```js
// MODERN — .voicing() handles note generation internally
$: "<Cm9 Fm9 Bb^7 Eb^7>".voicing().s("gm_epiano1").room(0.4)

// MODERN — with explicit dictionary
$: "<Cm9 Fm9 Bb^7>".dict("lefthand").voicing().s("gm_epiano1")

// LEGACY — avoid
$: "<Cm9 Fm9 Bb^7>".voicings("lefthand").note().s("gm_epiano1")
```

For arpeggiated chords, chain `.arp()` after `.voicing()`:

```js
$: "<Cm9 Fm9 Bb^7>"
  .voicing()
  .arp("0 1 2 3 2 1")
  .s("gm_epiano1")
  .release(0.4)
  .room(0.4)
```

---

## 7. Effect chains: one concern per line

Break long chains into logical groups. Each line should address one
sonic concern.

```js
// GOOD — grouped by function
$: note("c2 eb2 g2 c3")
  .s("sawtooth")
  .lpf(sine.range(300, 2000).slow(8))
  .lpq(8)
  .decay(0.12).sustain(0)
  .gain(0.6)
  .room(0.3)

// BAD — wall of dots
$: note("c2 eb2 g2 c3").s("sawtooth").lpf(sine.range(300,2000).slow(8)).lpq(8).decay(0.12).sustain(0).gain(0.6).room(0.3)
```

Guideline for grouping:
- **Source line:** the note/sound/sample selection
- **Filter line:** `lpf`, `lpq`, `hpf` (+ modulation signal)
- **Envelope line:** `attack`, `decay`, `sustain`, `release` (or the
  short form: `.adsr(".01:.1:.5:.2")`)
- **Dynamics line:** `gain`, `pan`
- **Space line:** `room`, `size`, `delay`, `delaytime`, `delayfeedback`
- **Transform line:** `jux`, `off`, `every`, `sometimes`, etc.

Short ADSR can go on one line: `.decay(0.12).sustain(0)` is fine when
attack and release are defaults.

---

## 8. Alias consistency

Strudel has many aliases. Pick one and stick to it across all patterns:

| Use this | Not this | Why |
|---|---|---|
| `s("…")` | `sound("…")` | Shorter, upstream convention |
| `lpf(…)` | `cutoff(…)`, `lp(…)`, `ctf(…)` | Most common in examples |
| `lpq(…)` | `resonance(…)` | Matches `lpf` naming |
| `hpf(…)` | `hp(…)` | Matches `lpf` naming |
| `~` | `-` | More common in Strudel community |
| `setcpm(…)` | `setcps(…)` | More readable for musicians |

---

## 9. Make sounds move

Static filter values and gains make patterns sound flat and lifeless.
Use **signal modulation** wherever a parameter could benefit from motion:

```js
// GOOD — filter breathes
.lpf(sine.range(400, 2000).slow(8))

// GOOD — gain swells
.gain(isaw.range(0, 0.6).fast(4))

// GOOD — delay time varies
.delaytime(sine.range(0.1, 0.4).slow(16))

// FLAT — everything locked at a constant
.lpf(800).gain(0.5).delaytime(0.25)
```

Available signals: `sine`, `saw`, `isaw`, `tri`, `square`, `rand`,
`perlin`. Chain `.range(lo, hi)` to set bounds and `.slow(N)` /
`.fast(N)` to set speed.

Use `perlin` for organic, non-repeating movement. Use `sine`/`tri` for
predictable sweeps.

---

## 10. Rhythmic idioms: use Strudel's strengths

**Euclidean rhythms** for organic grooves:

```js
s("bd(3,8)")       // 3 hits across 8 steps
s("cp(2,5)")       // 2 in 5 — displaced feel
```

**Per-cycle alternation** with `<>`:

```js
note("<c3 eb3 g3 bb3>")    // one note per cycle, rotating
s("<bd cp> hh")             // alternate bd/cp each cycle
```

**Probabilistic transforms** for variation:

```js
.sometimes(x => x.ply(2))       // 50% chance: stutter
.rarely(x => x.speed("-1"))     // ~10%: reverse
.every(4, x => x.rev())         // every 4th cycle: reverse
.sometimesBy(0.3, x => x.delay(0.5))  // 30%: add delay
```

**Self-layering** with `.off()` and `.superimpose()`:

```js
// Delay a transposed copy by 1/8 cycle
.off(1/8, x => x.add(note(7)))

// Stereo split + transform one side
.jux(rev)
```

---

## 11. Drum machines

Use `.bank()` on a single pattern rather than repeating it per line.
Group the whole kit in one `$:` block with comma-separated layers:

```js
// GOOD — one bank call, comma-layered
$: s("bd*2, ~ sd:1, hh*8, ~ ~ ~ oh")
  .bank("RolandTR909")
  .gain(0.8)

// ALSO GOOD — separate blocks when individual FX matter
drums_kick: s("bd*2").bank("RolandTR909").gain(0.9)
drums_snare: s("~ sd:1").bank("RolandTR909").room(0.3)
drums_hats: s("hh*8").bank("RolandTR909").gain(0.45)

// AVOID — bank repeated on every line in a stack
stack(
  s("bd*2").bank("RolandTR909"),
  s("~ sd").bank("RolandTR909"),
  s("hh*8").bank("RolandTR909"),
)
```

---

## 12. Complex compositions: use `let` variables

For patterns with 5+ voices, extract subsections into `let` variables
for readability (this is exactly how the canonical upstream examples
like "funk42" are structured):

```js
let drums = s("bd*2, ~ sd:1, hh*4")
  .bank("RolandTR707")
  .gain(0.8)

let bass = note("<c2 c2 eb2 g2>*4")
  .s("sawtooth")
  .lpf(sine.range(400, 1400).slow(8))
  .lpq(8)
  .decay(0.12).sustain(0)
  .gain(0.6)

let keys = "<Cm9 Fm9 Bb^7>"
  .voicing()
  .s("gm_epiano1")
  .room(0.4)
  .gain(0.7)

stack(drums, bass, keys)
```

Note: when using `let` variables with a final `stack()`, `$:` syntax
doesn't apply to the individual variables — use `stack()` for the
final merge.

---

## 13. What NOT to do

- **Don't use MIDI numbers for notes.** `note("48")` is unreadable.
  Write `note("c3")`.
- **Don't use `.sound()`.** Use `.s()`.
- **Don't mix MIDI numbers and note names.** `note("~ 52 ~ b5")` is
  a hard no.
- **Don't write walls of chained methods.** Break at logical groups.
- **Don't use static values everywhere.** At least one filter or gain
  in the pattern should be signal-modulated.
- **Don't use `setcps` when `setcpm` reads better.** `setcpm(120/4)`
  beats `setcps(120/60/4)`.
- **Don't add `samples()` calls.** strasbeat prebakes all samples in
  `main.js`. The pattern doesn't need to load them.
- **Don't use `.voicings('lefthand').note()`.** Use `.dict('lefthand')`
  before `.voicing()` if you need a specific dictionary (dict must come
  first — `.voicing()` reads the dictionary from the hap value).
- **Don't forget to verify sound names.** If a layer is silent, the
  sound name is probably wrong. `strasbeat.hasSound("…")` is the first
  check.

---

## Quick reference: a well-formed pattern

```js
// 07-late-night — downtempo chords + acid bass + shuffled drums
// concepts: .voicing(), signal-modulated filter, .off() self-layering

export default `
setcpm(90/4)

drums: s("bd(3,8), ~ cp, [~ hh]*4")
  .bank("RolandTR808")
  .sometimes(x => x.ply(2))
  .gain(0.8)

bass: note("c2 c2 eb2 c2 g1 c2 bb1 c2")
  .s("sawtooth")
  .lpf(sine.range(300, 2500).slow(6))
  .lpq(12)
  .decay(0.1).sustain(0)
  .gain(0.6)

keys: "<Cm9 Fm9 Bb^7 Eb^7>"
  .voicing()
  .arp("0 1 2 3 2 1")
  .s("gm_epiano1")
  .release(0.4)
  .room(0.5)
  .delay(0.4).delaytime(0.375).delayfeedback(0.3)
  .gain(0.65)

lead: n("<0 2 4 7 6 4 2 0>*2")
  .scale("C4:minor:pentatonic")
  .s("gm_lead_2_sawtooth")
  .lpf(perlin.range(800, 3000).slow(12))
  .off(1/8, x => x.add(note(12)).gain(0.3))
  .delay(0.5).delaytime(0.375).delayfeedback(0.4)
  .gain(0.5)
`;
```

---

## Version notes

These guidelines target strasbeat's installed Strudel packages:
- `@strudel/core` 1.2.6
- `@strudel/codemirror` 1.3.0
- `@strudel/tonal` 1.2.6
- `@strudel/transpiler` 1.2.6

All APIs referenced here (`setcpm`, `$:`, `.voicing()`, `.dict()`,
`.arp()`, signal `.range()`) are verified available at these versions.

**Not available** in strasbeat (requires `@strudel/repl` which we don't
bundle): `.piano()` shorthand. Use `.s("piano").release(0.1)` instead.
