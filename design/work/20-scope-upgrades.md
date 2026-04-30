# 20 — Scope upgrades

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. This task is scoped to the bottom panel's **Scope** mode
> (`src/ui/scope.js`) and a new small control strip. The Roll renderer,
> the canvas wiring, and the bottom-panel mode switcher are not
> touched beyond hooking into their existing callbacks.

## Goal

Our scope (`src/ui/scope.js`) taps `controller.output.destinationGain`
lazily and renders a byte-precision oscilloscope to the shared roll
canvas. That decision — **global, post-mix scope** — stays. But the
implementation is minimal compared to upstream `drawTimeScope` /
`drawFrequencyScope` (`strudel-source/packages/webaudio/scope.mjs`),
and several of upstream's knobs genuinely improve the thing as a
composition aid rather than as a demo.

Port the valuable features:

1. **Float time-domain data** (`getFloatTimeDomainData`) so quiet
   signals don't quantize into a flat line.
2. **Frequency-domain mode** (spectrum bars via
   `getFloatFrequencyData`) with a Time / Freq toggle.
3. **Amplitude scale** control (zoom the y-axis without touching
   output gain).
4. **Smear / persistence** so the trace leaves a trail rather than
   redrawing from zero every frame.
5. **Trigger threshold** (time mode) so the user can park the
   waveform instead of locking it to the zero crossing.

Everything is a **global** view — no per-pattern or per-orbit routing.
The user already has upstream's `.scope()` / `.fscope()` for that;
duplicating it here would fracture the mental model.

## Non-goals

- **Per-pattern analyser injection.** `.analyze(id)` is a pattern-side
  concern — it belongs in user code, not in the shell chrome. If a
  user wants a pattern-specific scope, they can use upstream's
  `.scope()` in their pattern.
- **Per-orbit scopes.** Would require superdough-side routing changes
  we don't own.
- **Color / thickness / position overrides.** The design system owns
  those (`--accent`, `--surface-1`, fixed 1.5px stroke, vertically
  centered). One correct look, not ten configurable ones.
- **In-pattern `.scope()` / `.fscope()` re-implementation.** Those
  already work via upstream — they render to their own canvas. Our
  panel is the global mix view.
- **New design tokens.** Everything renders with existing tokens.
- **Keyboard shortcuts for scope controls.** Not worth the surface-
  area budget; adjust via the control strip.

## Architecture

### Tap (unchanged)

`ensureConnected()` keeps its current shape: pull
`getSuperdoughAudioController().output.destinationGain`, create an
`AnalyserNode`, `connect()` into it, re-tap transparently when the
controller is rebuilt (WAV export teardown). This is the load-bearing
bit that makes the scope work regardless of when audio is first
constructed — don't refactor it away.

One change: the analyser now needs to support **both** time and
frequency reads, so keep a single analyser node but allocate two
typed-array buffers:

```js
const timeBuf = new Float32Array(analyser.fftSize);          // 2048
const freqBuf = new Float32Array(analyser.frequencyBinCount); // 1024
```

Switching modes at runtime is just a different getter call, not a
node rebuild.

### Float time-domain data

Swap `getByteTimeDomainData(Uint8Array)` → `getFloatTimeDomainData(Float32Array)`.
Values are now in `[-1, 1]` centered on 0 (not `[0, 255]` centered on
128). All downstream math needs to follow:

- Falling-edge trigger scan: upstream uses `arr[i-1] > -trigger && arr[i] <= -trigger`.
  Port exactly — it matches the new centering.
- Y mapping: `y = centerY - v * (height / 2) * scale`. The current
  `(v * height) / 2` mapping assumes byte data and gets rewritten.

Keep the falling-edge scan bounded to the first half of the buffer
(the current `scanEnd = len >> 1` behavior) so there's always room to
draw.

### Frequency-domain mode

Add a `mode` state: `'time'` (default) or `'freq'`.

In freq mode, use `analyser.getFloatFrequencyData(freqBuf)`. Values
are in dB, typically `[-100, 0]`. Upstream's `drawFrequencyScope`:

- Clamps `(v - min) / (max - min)` into `[0, 1]` with defaults
  `min = -150, max = 0`.
- Draws filled bars: x from `0 → width` across `frequencyBinCount`,
  bar height proportional to normalized value and `scale`, bar y
  positioned to grow downward from `pos` on the canvas.

Port that with one change: **log-scaled x axis**. Upstream is
linear-frequency, which crowds the bottom-left and empties the right
half. Use `x = log2((i + 1)) / log2(binCount) * width` so bass,
mids, and highs each get roughly equal real estate. This is a
standard spectrogram-style axis and reads much better for music.

Vertical position: centered (same as time mode). Bars grow **upward
and downward from the centerline** — the trace should feel like a
spectrogram bloom, not a bar chart sitting on the floor.

Leave a single-pixel baseline under the bars so the panel never
reads empty when no audio is playing.

### Amplitude scale

Add `scale` state, default `1.0`, range `[0.1, 4.0]`.

- **Time mode**: `y = centerY - v * (height / 2) * scale`. Clipping
  at canvas edges is expected and desired — the user is telling us
  they want to zoom.
- **Freq mode**: `barHeight = normalized * scale * (height / 2)`.

Re-clamp at draw time so pathological values from `localStorage`
don't blow up the renderer.

### Smear / persistence

Add `smear` state, default `0` (no smear). Range `[0, 1]` exclusive
of 1 (full smear never clears, which traps stale frames).

Replace the unconditional `ctx.fillRect(0, 0, w, h)` clear with:

```js
if (smear <= 0) {
  ctx.fillStyle = tokens.bg;
  ctx.fillRect(0, 0, w, h);
} else {
  // Alpha-fill the bg so previous frames fade out over ~1/(1-smear) frames.
  // Matches upstream clearScreen(smear, smearRGB).
  ctx.fillStyle = bgWithAlpha(tokens.bg, 1 - smear);
  ctx.fillRect(0, 0, w, h);
}
```

`bgWithAlpha` needs to parse `--surface-1` (which is an OKLCH token)
and emit an `oklch(... / alpha)` string. If that turns out fiddly for
any token edge case, fall back to a hard-coded `rgba(0, 0, 0, 1 - smear)`
— the scope's background is effectively near-black, and a few shades
off on the smear fill won't read as a bug.

**Mode-switch clear**: when the user flips Scope → Roll → Scope, or
Time → Freq, do a one-shot full clear on the next frame so trails
from the previous mode don't bleed through. A `_needsClear` flag set
by `setConfig` and consumed by `render` is enough.

### Trigger threshold

Add `trigger` state, default `0`, range `[-1, 1]`. Only affects time
mode.

Port upstream's falling-edge scan with configurable threshold:

```js
const triggerIndex = align
  ? dataArray.findIndex((v, i, arr) => i && arr[i - 1] > -trigger && v <= -trigger)
  : 0;
```

`align` stays `true` by default — the parking UX is adjusting
`trigger`, not disabling alignment. A disabled-alignment toggle would
be a whole new control with unclear value; skip.

### Public API

`createScope()` grows a single config setter:

```js
return {
  ensureConnected,
  disconnect,
  render,
  setConfig,   // ({ mode?, scale?, smear?, trigger? }) → void
  getConfig,   // () → { mode, scale, smear, trigger }
};
```

`setConfig` merges partials, clamps numeric ranges, and sets the
mode-switch clear flag when `mode` changes. `getConfig` is for the
control strip to read initial state on mount.

### Control strip

New file: `src/ui/scope-controls.js`.

```js
export function mountScopeControls({ container, scope, modes }) { ... }
```

- `container`: a DOM node allocated above the roll canvas. Mounted
  once from `main.js` into the existing `.bottom-panel__bar` region
  alongside the mode switcher. Only visible when Scope mode is
  active; hidden (via `hidden = true` / CSS attribute) otherwise.
- `scope`: the object returned by `createScope()`. The controls call
  `scope.setConfig(...)` on change.
- `modes`: the object returned by `createBottomPanelModes()`. The
  controls subscribe to `modes.setOnChange` (already exists) to
  toggle visibility.

Controls (functional spec only — visual polish belongs to `/polish`):

| Control       | Widget                            | Behavior                                                                                                   |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Mode          | Segmented pill: Time / Freq       | Flips `mode`. Clears canvas on next frame.                                                                  |
| Scale         | Numeric scrubber (drag to scrub)  | Reuses the editor's drag-to-scrub pattern (`src/editor/numeric-scrubber.js`) if reusable; else a slider.    |
| Smear         | Cycle button: Off / Low / High    | Cycles through 0 / 0.3 / 0.7.                                                                               |
| Trigger       | Numeric scrubber, hidden by default | Only visible in Time mode, behind a `…` disclosure (or similar overflow affordance — `/polish` owns the look). |

Defaults: `mode='time'`, `scale=1.0`, `smear=0`, `trigger=0`. These
reproduce today's behavior exactly, so existing users don't notice a
change until they touch a control.

### Persistence

Persist the config to `localStorage` under
`strasbeat:scope-config` as a JSON blob. Load on mount; save on every
`setConfig` (debounced to an animation frame so dragging the scrubber
doesn't thrash storage).

Mirror the pattern used by `src/ui/settings-drawer.js` for the accent
color, and by `midi-output-device` — one namespaced key per concern.

### Guard against stale config

If `localStorage` contains garbage (hand-edited, old schema,
unrelated keys), the loader must fall through to defaults silently.
Wrap the `JSON.parse` in try/catch and validate each field before
merging — a bad `smear = "oops"` should not brick the panel.

## Files

- `src/ui/scope.js` — float data, freq mode, smear, trigger,
  `setConfig`/`getConfig`. Keep `ensureConnected` and `disconnect`
  exactly as-is.
- `src/ui/scope-controls.js` — **new**. Exports
  `mountScopeControls(...)`.
- `src/main.js` — after `const scope = createScope();`, call
  `mountScopeControls({ container, scope, modes: bottomModes })`.
  The `container` is a new child of `.bottom-panel__bar` (adjacent
  to the existing mode switcher). No changes to the `onDraw`
  callback or anywhere else.
- `src/styles/*.css` — minimal: the control strip needs basic
  layout. Actual visual polish (spacing, dividers, hover states) is
  a subsequent `/polish` pass.

## Acceptance

- [ ] Play `s("sine").gain(0.05)` — trace is visible and non-flat in
      Time mode. Today's byte data compresses this into a flat line.
- [ ] Play `s("sawtooth")` — in Freq mode, bars are distributed
      across bass/mid/treble (log scale), not bunched at the left.
      Harmonics are visible as distinct peaks.
- [ ] Toggle Time / Freq — no trails from the previous mode remain
      on the first frame after the switch.
- [ ] Smear set to Low: trace leaves a fading trail over ~0.5s. No
      stuck pixels or cumulative brightness.
- [ ] Smear set to High: longer tail, trace still readable. No
      flicker when the trace crosses centerline repeatedly.
- [ ] Scale set above 1 clips peaks at canvas edges (expected).
      Scale below 1 shrinks the trace symmetrically around center.
- [ ] Switch to Roll, then back to Scope — control strip hides and
      re-shows. Scope canvas clears before redrawing.
- [ ] Reload the page — last-used mode, scale, smear, trigger
      restore from `localStorage`.
- [ ] Run WAV export (uses `renderPatternToBuffer` from
      `src/main.js`) — after export, scope still renders on the next
      Play (the existing lazy `ensureConnected` covers this;
      regression test it).
- [ ] Corrupt `localStorage` manually (set to `"{"`), reload — scope
      opens with defaults, no console error.
- [ ] `patterns/03-progression-demo.js` at default play — scope
      visibly responds in both modes.

## Out of scope

- Per-pattern or per-orbit analysers. Stays global.
- `.scope()` / `.fscope()` in-pattern calls. Already work via
  upstream — don't touch.
- New design tokens. Use what exists.
- Command palette entries for scope controls. No shortcuts either.
- Freeze / snapshot / save-as-PNG of the scope. Maybe later.
- Multiple simultaneous scopes (A/B, before/after).

## Notes

- Upstream reference: `strudel-source/packages/webaudio/scope.mjs`
  (drawTimeScope, drawFrequencyScope, clearScreen) and
  `strudel-source/packages/superdough/superdough.mjs:383` for how
  the analyser is constructed. Read these before touching
  `src/ui/scope.js`.
- `AnalyserNode.fftSize = 2048` gives `frequencyBinCount = 1024`.
  That's fine for both modes. If freq mode ever needs finer
  resolution, bump `fftSize` to 4096 — but that's a follow-up, not
  part of this spec.
- The control strip is a functional spec only. Colors, spacing,
  hover animations, the exact shape of the Smear cycle button —
  defer to `/polish` and `/critique` after the feature lands. The
  commit for this spec should be clean, readable, and plain; the
  polish commit can come behind it.
- The existing in-code comment at the top of `src/ui/scope.js`
  (why-it-taps-`destinationGain`) should stay. Add a short block
  under it for the new float-data / mode / smear machinery so the
  next reader understands the layering.
