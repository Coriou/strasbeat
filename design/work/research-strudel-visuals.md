# Research: How strudel.cc implements live visuals (Hydra + draw)

Inspiration-only reverse-engineering of strudel.cc's visuals stack to inform
strasbeat's offline Hydra integration + `shader()` node. Techniques and
rationale only — no code copied. Primary evidence is the upstream source
(read locally under `strudel-source/`) cross-checked against the public docs.

## TL;DR — actionable takeaways

- **The "code legible over visuals" trick is one CSS rule, not a scrim.**
  strudel.cc makes `.cm-editor` fully transparent and paints a translucent
  plate *behind every token span* with `.cm-line > * { background: var(--lineBackground) }`,
  where `--lineBackground` is a per-theme color at **~60% alpha** (e.g.
  `#282a3699`). Visuals bleed through the inter-line gaps; text always sits on a
  legible strip. ([Repl.css L21-29](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/Repl.css), [dracula.mjs L12](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/themes/dracula.mjs))
- **The canvas is a single full-viewport `position:fixed` layer prepended to
  `<body>`, `pointer-events:none`, behind the editor** (editor is `z-index:11`).
  Resolution = `innerWidth/Height * pixelRatio`, debounced 200ms on resize. ([draw.mjs L17](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **Hydra defaults to `pixelRatio:1` and `pixelated:true` in strudel** (not
  `devicePixelRatio`) — a deliberate perf cap. The base draw canvas defaults to
  `devicePixelRatio` but Hydra overrides it down to 1. ([hydra.mjs L19-26](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
- **Hydra is loaded lazily from a CDN** (`unpkg.com/hydra-synth`) via dynamic
  `import()`, and the canvas is created exactly once (guarded by
  `getElementById('hydra-canvas')`). Re-init only happens when options change. ([hydra.mjs L7-39](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
- **Teardown is explicit and aggressive on stop.** `clearHydra()` calls
  `hydra.hush()`, `s0.clear()`, and **removes the canvas element from the DOM**
  (killing the WebGL context), wired to the REPL's `onToggle(playing=false)`. ([hydra.mjs L41-49](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs), [useReplContext.jsx L99-103](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/useReplContext.jsx))
- **One rAF loop per draw id, synced to the scheduler, not free-running.** A
  `Framer`/`Drawer` pair queries the pattern's haps each frame (last 100ms
  window) so visuals are driven by *playing* haps, and animations are cancelled
  on stop / before full eval. ([draw.mjs L117-203](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **Inactive-tab cost is handled by the browser** — rAF throttles to ~1fps when
  hidden, and the query window is clamped to last 100ms so no haps pile up.
  There is *no* explicit `visibilitychange` gate; they rely on rAF throttling. ([draw.mjs L63-67](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))

---

## 1. How strudel.cc integrates Hydra (`@strudel/hydra`)

The whole package is ~50 lines (`packages/hydra/hydra.mjs`). Mechanics:

- **Activation is in-pattern**, not a toolbar button: you write
  `await initHydra()` at the top of a pattern and then call hydra functions
  (`osc().out()`, etc.) below. ([learn/hydra](https://strudel.cc/learn/hydra/), [hydra README](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/README.md))
- **`initHydra(options)`** destructures strudel-specific keys off the options
  bag (`src`, `feedStrudel`, `contextType`, `pixelRatio`, `pixelated`) and
  passes the *rest* straight through to the `Hydra` constructor. Defaults set in
  strudel: `src = 'https://unpkg.com/hydra-synth'`, `feedStrudel = false`,
  `contextType = 'webgl'`, `pixelRatio = 1`, `pixelated = true`,
  `detectAudio: false`. ([hydra.mjs L15-25](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
- **The canvas is owned by `@strudel/draw`, not by hydra.** strudel calls
  `getDrawContext('hydra-canvas', {contextType, pixelRatio, pixelated})` to get
  a canvas it has full styling control over, then hands that canvas to Hydra via
  `hydraConfig.canvas = canvas`. This is *the* key integration move — it lets
  strudel position/size/layer the canvas instead of letting hydra append its own. ([hydra.mjs L26-31](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
- **`makeGlobal` / `autoLoop` are left at hydra's defaults** (`true`/`true`) —
  strudel does *not* override them. So hydra's `osc`, `noise`, `src`, `s0..s3`,
  `o0..o3` become globals (strudel saves/restores `globalThis.speed`/`shape`
  controls on teardown because hydra clobbers them — see L47-48). And hydra runs
  its own internal `requestAnimationFrame` render loop (`autoLoop:true`). ([hydra.mjs L47-48](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs); hydra defaults from [hydra-synth README](https://github.com/hydra-synth/hydra-synth/blob/main/README.md))
- **`feedStrudel`** wires strudel's *2D* draw canvas (the pianoroll/spiral/scope
  canvas, default id `test-canvas`) into hydra source `s0`
  (`hydra.synth.s0.init({src: canvas})`) and hides that canvas
  (`display:none`). This is how you post-process strudel's own visualizers
  through hydra. ([hydra.mjs L32-36](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
- **`H(pattern)`** is a one-liner bridge: `H = (p) => () => reify(p).queryArc(getTime(), getTime())[0].value`
  — it turns a strudel pattern into a *function* hydra can call each frame,
  sampling the pattern's value at the current transport time. This is how a
  playing pattern drives a hydra parameter live. ([hydra.mjs L51](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
- **Re-init guard:** if `initHydra` is called again with *different* options,
  the old `hydra-canvas` is removed first; if called with identical options it's
  a no-op (returns existing instance). ([hydra.mjs L8-14](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))

---

## 2. Rendering BEHIND the editor while keeping code legible

This is the most directly transferable part. Two layers + one font-trick:

**Layer A — the visuals canvas** (`@strudel/draw` `getDrawContext`):
```
pointer-events:none; width:100%; height:100%; position:fixed; top:0; left:0
```
plus `imageRendering:pixelated` when `pixelated`. It is `document.body.prepend`-ed
so it's the first child (naturally lowest in paint order), and the backing store
is `innerWidth*pixelRatio × innerHeight*pixelRatio`. ([draw.mjs L13-19](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))

**Layer B — the editor**, made transparent and lifted above:
```css
.code-container .cm-editor { background-color: transparent !important; z-index: 11; }
```
([Repl.css L25-29](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/Repl.css))

**The legibility trick — per-token translucent plates, not a global scrim:**
```css
.code-container .cm-line > * { background: var(--lineBackground); }
```
CodeMirror wraps every highlighted token in an inline element; this paints a
plate behind each token span. Because the plate is per-span (and the line itself
has no background), visuals show through the *gaps between lines* and the right
margin, while text always has a contrasting strip directly behind it. The plate
color `--lineBackground` is theme-defined at **~60% alpha** (`99` hex suffix):
`#282a3699` (dracula), `#21202e99` (aura), `#22222299` (site default), or fully
`transparent` for high-contrast themes like sonic-pink. ([Repl.css L21-23](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/Repl.css), [dracula.mjs L12](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/themes/dracula.mjs), [aura.mjs L6](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/themes/aura.mjs), [HeadCommonNext.astro L37](https://codeberg.org/uzu/strudel/src/branch/main/website/src/components/HeadCommonNext.astro))

**How the plate color reaches CSS:** each theme is a JS settings object; on theme
activation strudel emits a `:root { --<key>: <value> !important; }` style block
from `Object.entries(themeSettings)`. So `lineBackground` in the theme object
becomes the `--lineBackground` CSS var the Repl.css rule consumes. ([themes.mjs L200-206](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/themes.mjs))

**Optional global dim:** there's a `.darken::before` overlay (`position:fixed`,
full-viewport, `background:black; opacity:0.5`) used as an extra scrim in some
states — a simple uniform dimmer toggled by class, distinct from the per-line
plates. ([Repl.css L1-11](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/Repl.css))

**Takeaway:** the per-token plate (`--lineBackground` at ~60% alpha) is the
single highest-leverage technique to steal. It beats a uniform scrim because it
keeps the visuals vivid in the negative space while guaranteeing per-glyph
contrast, and it's theme-tunable.

---

## 3. Keeping visuals performant

- **Scheduler-synced single rAF loop, not N free-runners.** `Pattern.prototype.draw`
  and the `Drawer`/`Framer` classes each own exactly one `requestAnimationFrame`
  per draw `id`, tracked in a module-level `animationFrames` map so they can be
  individually `cancelAnimationFrame`-ed. ([draw.mjs L32-71, L117-142](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **Bounded per-frame query.** Each frame queries only the haps in the last
  ~100ms (`Math.max(last, phase - 1/10)`), so work per frame is O(active haps),
  not O(history). Past haps are filtered out of the `visibleHaps`/`memory`
  buffers every frame. ([draw.mjs L63-68, L168-174](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **Idle/hidden-tab cost.** No explicit `visibilitychange` handler; they lean on
  the browser throttling rAF to ~1fps in background tabs, and the 100ms query
  clamp (comment: "inactive tab throttles to 1fps") prevents catch-up storms. ([draw.mjs L63](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **Draw-time gating when nothing paints.** In `afterEval`, if the pattern has no
  `.onPaint` painters, `drawTime` is collapsed to `[0,0]` so the drawer only
  computes the present moment for cursor highlighting — i.e. it does the minimum
  work when there's nothing to animate. ([codemirror.mjs L244-247](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/codemirror.mjs))
- **Stop tears down draw loops + clears the canvas.** On `onToggle(false)`:
  `drawer.stop()` + `cleanupDraw(true, id)` (cancels all animations for that
  repl id and clears the canvas). On full (non-block) eval, `beforeEval` clears
  draws first. ([codemirror.mjs L215-225](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/codemirror.mjs))
- **`willReadFrequently:true`** is set on the 2D draw context, hinting the
  browser to keep it in a CPU-readable layout (matters for pianoroll/scope that
  read pixels / feed `feedStrudel`). ([draw.mjs L29](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **The known perf regression they fixed:** PR #818 removed a `cloneNode(true)`
  of the canvas that was the primary bottleneck, and switched the canvas from
  `absolute` to `fixed` so scroll doesn't reposition it. ([PR #818](https://codeberg.org/uzu/strudel/pulls/818))

---

## 4. Full-viewport canvas posture & resolution capping

- **Sizing.** Backing store = `window.innerWidth * pixelRatio` ×
  `window.innerHeight * pixelRatio`; CSS size pinned to `100% × 100%` over a
  `fixed; top:0; left:0` box. On `resize`, the backing store is recomputed but
  **debounced 200ms** (avoids thrashing GL allocation during drag-resize). ([draw.mjs L15-27](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **pixelRatio policy.** The generic 2D draw canvas defaults to
  `window.devicePixelRatio` (sharp pianoroll/scope), but **Hydra is forced to
  `pixelRatio:1`** in `initHydra`'s defaults — i.e. they render hydra at CSS
  resolution, not retina, and lean on `imageRendering:pixelated` for the aesthetic.
  This is the resolution cap: a HiDPI 4K display renders hydra's expensive
  fragment shaders at 1× pixels, ~4× cheaper than retina. ([hydra.mjs L19](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs) vs [draw.mjs L10](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **Hydra's own resolution.** hydra-synth defaults to `width:1280, height:720`
  but when given an existing `canvas` it adopts that canvas's dimensions;
  `setResolution(w,h)` changes the backing render resolution independently of CSS
  display size, and `precision` defaults to `highp` on iOS / `mediump`
  elsewhere. ([hydra-synth README](https://github.com/hydra-synth/hydra-synth/blob/main/README.md))
- **GPU-OOM / context-loss mitigations.** strudel's explicit defense is
  **destroying the GL context on stop** by removing the canvas element
  (`clearHydra` → `document.getElementById('hydra-canvas')?.remove()`), rather
  than leaving an idle WebGL context alive. There is no `webglcontextlost`
  recovery handler in the package — the mitigation is "don't keep contexts you
  aren't using, and only ever create one (id-guarded)." Combined with
  `pixelRatio:1` this keeps GPU memory bounded. ([hydra.mjs L41-48](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))

---

## 5. The `draw`/`onPaint` hook and `@strudel/draw`

- **`Pattern.prototype.onPaint(painter)`** attaches a painter fn into the
  pattern's `state.controls.painters` array; painters are discovered during query
  (`queryArc(..., {painters})`) and run each frame with
  `(drawContext, time, haps, drawTime)`. This is the pattern-driven visual hook —
  the playing pattern *carries* its painters. ([draw.mjs L91-99](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs), [codemirror.mjs L326-327](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/codemirror.mjs))
- **Per-frame hap flow.** `Drawer.framer` runs each rAF: reads
  `scheduler.now()`, queries the pattern over `[lastFrame, now]` (clamped 100ms),
  maintains a rolling `visibleHaps` window (drops haps past the lookbehind edge,
  appends new onsets), then calls `onDraw(visibleHaps, time, this, painters)`.
  So visuals are a pure function of the haps currently sounding (+ lookahead/
  lookbehind window for scroll effects like pianoroll). ([draw.mjs L152-182](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
- **`invalidate()`** re-queries future haps on (re)eval so the visual window
  stays in sync after a code change without restarting the loop. `drawTime`
  (lookbehind/lookahead) is set from whether painters exist. ([draw.mjs L186-203](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/codemirror.mjs); [codemirror.mjs L246-249](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/codemirror.mjs))
- **Driving hydra params from the pattern** is the `H()` bridge from §1: hydra
  param slots accept functions, and `H(pattern)` returns a function that samples
  the pattern at `getTime()` each call. ([hydra.mjs L51](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))

---

## 6. Notable aesthetic / interaction choices worth emulating

- **In-code activation, not a chrome toggle.** Visuals are part of the pattern
  text (`await initHydra()`), keeping "code is the source of truth." For
  strasbeat this argues for *both* a chrome affordance and a pattern-level entry. ([learn/hydra](https://strudel.cc/learn/hydra/))
- **Pixelated, 1× hydra by default** gives a deliberate lo-fi video-synth look
  *and* is the perf win — the aesthetic and the optimization are the same choice. ([hydra.mjs L19-26](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
- **Theme owns the legibility budget.** Each theme ships its own
  `lineBackground` alpha, so "how much visual shows through the code" is a
  per-theme design decision (transparent for bold themes, ~60% black for dark
  ones) rather than a global hardcode. ([themes/*.mjs](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/themes/))
- **`feedStrudel` self-referential loop** (pianoroll/scope → hydra → screen) is a
  signature "feel" — the music visualizer becomes raw material for the video
  synth. Worth offering as a preset. ([hydra README](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/README.md))
- **Hush-on-stop is instant and total** — stopping audio also blanks visuals
  (canvas removed). No lingering frozen frame. ([useReplContext.jsx L99-103](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/useReplContext.jsx))

---

## Concrete recommendations for strasbeat

### (a) Freeze / perf hardening

1. **Cap hydra/shader resolution at `pixelRatio:1` by default** (optionally a
   user setting up to `devicePixelRatio`), and set `imageRendering:pixelated`.
   This is strudel's single biggest GPU-OOM/jank defense and we already cap
   resolution per the commit log — confirm the cap is `1×` on HiDPI, not capped
   at a large absolute pixel count that still explodes on 4K/5K. ([hydra.mjs L19](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
2. **Destroy the WebGL context on stop**, don't just pause the loop. Remove the
   canvas element (or call `getContext('webgl').getExtension('WEBGL_lose_context').loseContext()`)
   in teardown, mirroring `clearHydra`. Idle live contexts are the leak source. ([hydra.mjs L41-48](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
3. **Guard single-instance creation by element id** so re-eval/HMR can't spawn a
   second context; only re-create when options actually change. ([hydra.mjs L8-31](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))
4. **Debounce resize backing-store resizes (~200ms)** to avoid GL reallocation
   storms during panel/window drag-resize. ([draw.mjs L21-27](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
5. **Add an explicit `visibilitychange` gate** for the offline/full-window case —
   strudel relies on browser rAF throttling, but an explicit pause when
   `document.hidden` is cheap insurance, especially for our raw-WebGL `shader()`
   loop which may not be a hap-driven rAF.
6. **Keep one rAF per visual id and cancel it on stop/before-eval**; bound any
   per-frame pattern query to a ~100ms window so a long-running session never
   accumulates work. ([draw.mjs L63-71, L218-225](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs))
7. **Collapse draw work to "present only" when no painter/visual is active**
   (strudel's `[0,0]` drawTime trick) so the idle cost of having the feature
   enabled is near-zero. ([codemirror.mjs L244-247](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/codemirror.mjs))

### (b) Per-line-plate / full-window polish

1. **Adopt the per-token plate pattern verbatim in spirit:** transparent
   `.cm-editor`, and `background: var(--lineBackground)` on the token-span
   children (`.cm-line > *`), with `--lineBackground` at **~55-65% alpha**. This
   is the proven way to keep code legible over arbitrary visuals while letting
   them bleed through line gaps. ([Repl.css L21-29](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/Repl.css))
2. **Make the plate alpha theme-driven**, not a single hardcode — wire it into
   strasbeat's OKLCH accent/theme system so each theme declares how much visual
   shows through, matching strudel's `transparent` (bold) vs `99`-alpha (dark)
   spectrum. ([themes/*.mjs](https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/themes/))
3. **Layer the canvas as a single `position:fixed; inset:0; pointer-events:none`
   element behind the editor** (editor at a higher z-index), prepended to its
   container. For the bottom-panel mode, scope the same canvas to the panel box
   instead of the viewport. ([draw.mjs L17](https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs), [PR #818 fixed→fixed](https://codeberg.org/uzu/strudel/pulls/818))
4. **Offer an optional uniform dimmer** (`.darken`-style full-viewport
   `black/opacity:0.5`) as a one-key "calm the visuals" toggle for when a busy
   shader fights the code — cheaper and blunter than per-line tuning. ([Repl.css L1-11](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/Repl.css))
5. **Hush visuals instantly on stop** (blank/destroy canvas) so there's no frozen
   last-frame artifact — matches the "stop means stop" feel. ([useReplContext.jsx L99-103](https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/useReplContext.jsx))
6. **Expose a pattern→param bridge like `H()`** so the playing pattern can drive
   `shader()`/hydra uniforms each frame by sampling pattern value at transport
   time — this is what makes the visuals feel *played* rather than decorative. ([hydra.mjs L51](https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs))

---

### Source index

- Strudel hydra package: `strudel-source/packages/hydra/hydra.mjs` — https://codeberg.org/uzu/strudel/src/branch/main/packages/hydra/hydra.mjs
- Strudel draw package: `strudel-source/packages/draw/draw.mjs` — https://codeberg.org/uzu/strudel/src/branch/main/packages/draw/draw.mjs
- REPL CSS (transparency + plates): `website/src/repl/Repl.css` — https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/Repl.css
- Theme → CSS var emission: `packages/codemirror/themes.mjs` — https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/themes.mjs
- Theme plate alphas: `packages/codemirror/themes/*.mjs` (e.g. dracula `#282a3699`) — https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/themes/
- Draw lifecycle wiring: `packages/codemirror/codemirror.mjs` — https://codeberg.org/uzu/strudel/src/branch/main/packages/codemirror/codemirror.mjs
- Stop/clearHydra wiring: `website/src/repl/useReplContext.jsx` — https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/useReplContext.jsx
- Hydra docs: https://strudel.cc/learn/hydra/
- Hydra fixes PR #818: https://codeberg.org/uzu/strudel/pulls/818
- hydra-synth options/defaults: https://github.com/hydra-synth/hydra-synth/blob/main/README.md
- Hydra synth settings (setResolution/pixelRatio): https://hydra.ojack.xyz/hydra-docs-v2/docs/learning/video-synth-basics/settings/
