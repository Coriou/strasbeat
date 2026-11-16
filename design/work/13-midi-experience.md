# 13 — MIDI experience overhaul

> Status: shipped, including the "future" phases 2 and 3 (ebf7ff4, 3e8e496, 01e5eea, 2026-04-10/11).

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. Then read this whole file. This elevates strasbeat's MIDI
> input stack from a functional prototype to a polished, DAW-grade
> live-play experience with its own dedicated UI bar.

## Where this came from

The MIDI bridge (`src/midi-bridge.js`) already works: 12 presets,
trigger-and-decay model, capture mode. But the UI is crammed into
the transport bar — a native `<select>` for presets (violating design
principle #7), no volume control, no note/chord display, no sustain
pedal, no octave shift, no visual keyboard. The experience of playing
the MIDI keyboard is functional but far from delightful. This spec
fixes that.

## Non-goals

- **No noteoff tracking.** The trigger-and-decay model stays. Sustain
  pedal (CC64) extends duration for new notes rather than holding voices
  open. True key-up release needs bypassing superdough — documented as
  future work.
- **No MIDI output.** strasbeat is an input tool; we're not sending MIDI
  to external synths.
- **No MIDI learn / CC mapping.** Phase 3+ territory.
- **No changes to Strudel internals, superdough API, or the pattern
  transpiler.**

## Architecture

### New shell grid row

The MIDI bar is a new full-width strip in the shell grid, positioned
**between the track bar and the piano roll**:

```
topbar → editor → transport → trackbar → midibar → roll
```

Grid row sizing: `auto` — collapses to 0px when `hidden`, same pattern
as the track bar. The bar auto-shows when a MIDI device connects and
auto-hides when all devices disconnect.

### MIDI bar layout (32px height)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ╔═ mini-keyboard ═══╗  C4 · Cm7    ⊖ 0 ⊕   ━━━ 80%   🎹 EPiano ▾  ◉  ● 3 │
│ ╚═══════════════════╝  note/chord   oct/shift  volume   preset    sus cap│
└──────────────────────────────────────────────────────────────────────────┘
```

Left to right:

1. **Mini-keyboard canvas** (~120px wide, ~22px tall) — 2-octave range
   centered on last played note. Active keys light up in `--accent` with
   velocity-proportional opacity. Sustained keys show with a dimmer hold
   indicator.
2. **Note/chord text** — shows `"C4"` for single notes, `"Cm7"` for
   chords. Fades to `--text-dim` after ~1.5s of inactivity.
3. **Octave shift** — `⊖` / `⊕` buttons flanking the current offset
   (e.g. `0`, `+1`, `-2`). Range: -3 to +3. Persisted to localStorage.
4. **Volume slider** — horizontal range 0–100%, mapped to master MIDI
   gain multiplier. Default 80%. Persisted.
5. **Preset picker** — styled button showing the current preset label.
   Click opens a popover with categorized preset list, keyboard nav,
   search/filter. Preview on hover (plays C4 at 50% velocity).
6. **Sustain lamp** — small circle, lights up in `--ok` when CC64 is
   active (pedal down).
7. **Capture button + count badge** — migrated from transport. Same
   behavior, new home.

### MidiBridge extensions

`src/midi-bridge.js` gains:

1. **Simple event emitter** — `on(event, fn)` / `off(event, fn)`:
   - `'noteon'` → `{ midi, velocity, noteName }`
   - `'cc'` → `{ cc, value }` (0–127)
   - `'sustain'` → `{ down: boolean }`
   - `'devicechange'` → `{ devices: [{id, name}] }`
     Events are emitted _after_ the sound has been triggered, so listeners
     never block audio.

2. **CC message handling** — parse `0xB0` (control change) in
   `_onMessage`. CC64 ≥ 64 → sustain on, < 64 → sustain off. When
   sustain is on, new notes get `duration * 3` (stays within
   trigger-and-decay — no noteoff needed, just longer envelopes).

3. **Octave shift** — `setOctaveShift(n)` stores an offset (-3 to +3,
   clamped). Applied to the MIDI note number _before_ the superdough
   call: `midi + (octaveShift * 12)`. The emitted `noteon` event
   carries the _shifted_ note.

4. **Master volume** — `setVolume(0–1)` multiplied into the `gain`
   value of every `_noteOn` call (replacing the hardcoded `0.9`).
   Default: `0.8`.

5. **Active notes tracking** — `this.activeNotes` is a `Map<midi, {velocity, timeout}>`.
   On noteon, add with a timeout that removes after `preset.duration * 1000`ms.
   Sustain extends the timeout. The midi-bar reads this to paint the
   keyboard.

6. **Device enumeration** — `getDevices()` returns `[{id, name}]` from
   `this.access.inputs`.

### Chord detection

Small pure-function module (can live in `src/ui/midi-bar.js` or a
separate file):

- `midiToNoteName(midi)` → `"C4"`, `"F#3"`, `"Bb2"` — simple modulo
  math + lookup table, no library.
- `detectChord(midiNumbers[])` → `"Cm7"` / `"D"` / `"F#dim"` / `null`
  — interval-set lookup covering triads (major, minor, dim, aug, sus2,
  sus4), 7ths (dom7, maj7, min7, half-dim, dim7, min-maj7), and 6ths.
  ~20 chord types total. Returns `null` if no match (shows individual
  note names instead).

### Preset picker popover

A custom-styled floating panel (design principle #7 — no native
dropdowns). Matches the shadow/radius vocabulary from design/SYSTEM.md.

Structure:

```
┌─────────────────────────┐
│ 🔍 filter               │
├─────────────────────────┤
│ Keys                    │
│  ● Piano                │
│  ○ EPiano               │
│  ○ Harpsichord          │
│  ○ Organ                │
│  ○ Marimba              │
│ Strings & Pads          │
│  ○ Strings              │
│  ○ Pad (synth)          │
│  ○ Pad (warm)           │
│ Synth                   │
│  ○ Lead                 │
│  ○ Pluck                │
│ Bass                    │
│  ○ Bass                 │
│ Drums                   │
│  ○ Drums                │
└─────────────────────────┘
```

- Keyboard navigable (↑/↓ to move, Enter to select, Esc to close).
- Hovering a preset for 300ms triggers a preview (single C4 note at
  50% velocity through `superdough`). Debounced so rapid scrolling
  doesn't spam audio.
- Clicking outside or pressing Esc closes.
- Selected preset persisted to localStorage.

## Status

**Phase 1 is fully implemented.** All the files listed in "Files to
create" and "Files to modify" have been shipped. The MIDI bar, event
emitter, CC64 sustain, octave shift, volume, active notes, chord
detection, preset popover, and capture migration are all in place.
A fresh agent picking up this spec should start with Phase 2.

## Files to create

| file                      | purpose                                               |
| ------------------------- | ----------------------------------------------------- |
| `src/ui/midi-bar.js`      | Mount function, event wiring, sub-component rendering |
| `src/styles/midi-bar.css` | 32px bar styling, mini-keyboard, controls             |

## Files to modify

| file                       | changes                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/midi-bridge.js`       | Event emitter, CC handling, sustain, volume, octave shift, active notes                                                                                            |
| `index.html`               | Add `<div class="midi-bar" id="midi-bar" hidden>` between track-bar and roll-pane. Remove `<select id="preset-picker">` and `<button id="capture">` from transport |
| `src/styles/shell.css`     | Add `midibar` grid area, add `auto` row between trackbar and roll                                                                                                  |
| `src/main.js`              | Import `mountMidiBar`, wire it, remove transport preset/capture wiring                                                                                             |
| `src/ui/transport.js`      | Remove `setCaptureState` and capture DOM refs (stay compatible — methods can become no-ops if still called)                                                        |
| `src/styles/transport.css` | Remove `.preset-picker` and `.capture` styles (moved to midi-bar.css)                                                                                              |
| `src/style.css`            | Add `@import "./styles/midi-bar.css"` after track-bar                                                                                                              |

## Files to reference (read, don't modify)

| file                             | why                                           |
| -------------------------------- | --------------------------------------------- |
| `src/ui/track-bar.js`            | Best pattern for an auto-hiding bar component |
| `src/styles/track-bar.css`       | Styling reference for a 24px strip            |
| `src/editor/numeric-scrubber.js` | Drag-to-scrub interaction (for volume)        |
| `design/SYSTEM.md`               | Tokens, spacing grid, elevation vocabulary    |
| `src/ui/palette.js`              | Color palette                                 |

## Implementation order

1. **Extend `MidiBridge`** — event emitter, CC64 sustain, octave shift,
   master volume, active notes tracking, device enumeration. All pure
   logic, no DOM. Test in console before proceeding.

2. **Shell grid update** — add `midibar` row to `shell.css` grid
   template. Add the empty `<div>` to `index.html`. Verify grid doesn't
   break with the hidden element.

3. **MIDI bar mount + CSS** — create `midi-bar.js` and `midi-bar.css`.
   Start with the skeleton: auto-show/hide on device connect, note text
   display, volume slider, octave buttons, sustain lamp. Mini-keyboard
   canvas is Phase 1b if time is tight.

4. **Preset picker popover** — custom picker replacing the native
   `<select>`. Categorized, keyboard nav, preview on hover.

5. **Migrate capture** — move capture button + count badge from
   transport to MIDI bar. Rewire the click handler in `main.js`.

6. **Clean up transport** — remove the migrated DOM elements from the
   transport section of `index.html`. Remove orphaned CSS. Confirm
   `setCaptureState` / `setMidiStatus` still work (or are now no-ops).

7. **Persistence** — volume, octave shift, selected preset all
   round-trip through localStorage.

8. **Mini-keyboard canvas** — 2-octave piano visualization. Canvas
   renders white and black keys; active notes light up synchronously
   from the `activeNotes` map on MidiBridge.

## Styling

- Bar height: 32px, matching transport.
- Background: `var(--surface-1)`.
- Top border: `1px solid var(--border-soft)`.
- All controls use the 8px spacing grid.
- Buttons: `--text-xs` font, 24px hit target.
- Volume slider: custom-styled `<input type="range">` or a CSS-only
  horizontal bar with pointer-event drag (matching the numeric scrubber
  aesthetic — not a native range input unless time-constrained).
- Preset picker popover: `--shadow-pop` elevation, `--radius-sm`
  corners, max-height 300px with overflow-y auto.
- Mini-keyboard canvas: thin white/black keys, `--surface-0` background
  for black keys, `oklch(0.9 0 0)` for white keys. Active note fill:
  `--accent` at `0.4 + velocity * 0.5` opacity. Sustained keys: 50%
  opacity hold after the initial flash.

## Verification

1. MIDI bar auto-shows when a MIDI device is connected, auto-hides when
   disconnected, grid collapses cleanly (no gap).
2. Note display shows `"C4"` for single notes, `"Cm7"` for chords,
   fades after ~1.5s.
3. Mini-keyboard lights correct keys in real time with velocity
   brightness; sustained notes show distinctly.
4. Volume slider ranges 0–100%, gain is audibly correct, persisted
   across reload.
5. Octave shift audibly shifts ±3 octaves, keyboard display follows,
   persisted.
6. Sustain pedal (CC64): notes ring ~3× longer when pedal is down,
   lamp lights up, releasing pedal doesn't cut existing notes.
7. Custom preset picker opens a styled popover, categories work,
   no native `<select>` remains.
8. Capture works end-to-end after migration from transport to MIDI bar.
9. Grid integrity: test with MIDI bar hidden, both bars showing, roll
   collapsed, right rail open.
10. Play a rapid passage — latency feels the same (10ms cushion in
    `_noteOn` is preserved).

## Future phases (documented, not blocking)

### Phase 2 — Sound expansion + polish

- Expand to ~25-30 categorized presets (verify every `s` value).
- Per-preset FX tweaking (room, delay, lpf as drag-to-scrub values on
  the preset popover, ephemeral per-session).

### Phase 3 — Advanced MIDI + Capture 2.0

- Mod wheel (CC1) → route to lpf.
- Pitch bend (`0xE0`) → cent offset on note frequency.
- Velocity curve modes (soft / linear / hard).
- MIDI device selector (when multiple devices are connected).
- Capture preview (playback before saving).
- Capture quantize (snap to 1/4, 1/8, 1/16 grid).
- Metronome for capture (click track synced to cps).
