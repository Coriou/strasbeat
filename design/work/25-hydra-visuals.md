# 25 — Hydra visuals (`initHydra()` + event-driven shader uniforms)

> Status: shipped, phases 1, 1.5 and 2 (676fbea, 6f2a4ab, 2026-06; lifecycle reworked in 7e42564). How it looks on a real GPU is still to be checked — see `OPEN.md`. Plan: `archive/25-hydra-visuals-plan.md`.

> Read `../README.md`, `../SYSTEM.md`, `../PATTERN-STYLE.md`, and
> `../../CLAUDE.md` before starting. This is a **runtime feature**, not a
> design-pass feature — the same category as `07-chord-progression.md`.
> Phase 1 promotes Strudel's Hydra integration into the core eval scope so
> pattern files can call `await initHydra()` / `H()` / `clearHydra()`
> directly, gives it a first-class toggleable home, and bundles
> `hydra-synth` locally (offline-first). Phase 2 adds a strasbeat-original
> WebGL shader node with event-driven named uniforms. Like `07`, this
> touches the `evalScope(...)` call (off-limits to the design pass per
> `SYSTEM.md` §11) — one minimal, additive line, explained under
> "The one sanctioned plumbing touch" below.

## Where this came from

Strudel ships `@strudel/hydra`: pattern code can `await initHydra()` and
then drive [Hydra](https://hydra.ojack.xyz/) — a WebGL live-coding visual
synth — directly from inside a tune, with `H(pattern)` letting pattern
signals modulate visual parameters. strudel.cc exposes this on its
playground (visuals render full-window *behind* the editor; the editor
stays legible via per-line translucent plates). In strasbeat today,
`@strudel/hydra` is registered only as an **opt-in** package in
`src/user-setup.js:111` (lazy `import("@strudel/hydra")`) — visuals are a
buried, second-class citizen.

The reframe that landed in the brainstorm: **visuals are not a plugin, they
are a first-class output of the instrument** — the same status as audio,
the piano roll, and the scope. Phase 1 makes that true. Phase 2 chases the
"Reddit dream": drop in a Shadertoy-style fragment shader and have your
drums and notes drive its uniforms with zero ceremony — the kind of
event-reactive GLSL that upstream is *still* only prototyping (open,
unmerged PR #1196). strasbeat builds that as original work, informed by
#1196's ideas, not waiting on its churning API.

## Goal

1. **Phase 1:** `await initHydra()` works out of the box (no setup-panel
   toggle), runs fully offline (bundled `hydra-synth`, never the
   `unpkg.com` CDN), gets a first-class **Visuals** home in the bottom
   panel, and stays legible. `H()` never throws. Everything tears down
   cleanly on stop, re-init, and HMR.
2. **Phase 2:** a strasbeat-original `shader('…glsl…')` node that takes a
   drop-in fragment shader and exposes **named uniforms** — derived
   automatically from the playing pattern's drum/note events
   (`uKick`, `uSnare`, `uKeyVelocity`, `u<SoundName>`, …) and overridable
   with an explicit `.uniform({ dest, gain, slow, onTrigger })` API. The
   gentle path is zero-config; the power path borrows PR #1196's vocabulary.

## Background — what Strudel already provides (and how)

Read `strudel-source/packages/hydra/hydra.mjs` — it is ~50 lines:

```js
export async function initHydra(options = {}) {
  // remove #hydra-canvas if options changed since last init
  const { src = 'https://unpkg.com/hydra-synth', feedStrudel = false,
          contextType = 'webgl', pixelRatio = 1, pixelated = true,
          ...hydraConfig } = { detectAudio: false, ...options };
  const { canvas } = getDrawContext('hydra-canvas', { contextType, pixelRatio, pixelated });
  hydraConfig.canvas = canvas;
  await import(/* @vite-ignore */ src);   // CDN build, attaches global `Hydra`
  hydra = new Hydra(hydraConfig);          // reads the global
  if (feedStrudel) { /* hide 2D canvas, feed pixels to s0 */ }
  return hydra;
}
export function clearHydra() { hydra?.hush(); globalThis.s0?.clear();
  document.getElementById('hydra-canvas')?.remove(); /* restore speed/shape */ }
export const H = (p) => () => reify(p).queryArc(getTime(), getTime())[0].value;
```

Load-bearing facts (verified by reading the source):

- **The CDN default.** `src = 'https://unpkg.com/hydra-synth'`, loaded via
  `await import(/* @vite-ignore */ src)`, which attaches a **global
  `Hydra`** that `new Hydra(...)` then reads. This violates strasbeat's
  offline-first rule (`CLAUDE.md`). We must bundle `hydra-synth` locally and
  arrange for `new Hydra(...)` to find it.
- **`#hydra-canvas` is full-viewport, fixed, `pointer-events:none`.**
  `getDrawContext('hydra-canvas', …)` (see
  `strudel-source/packages/draw/draw.mjs:9-30`) creates a canvas with
  `style = 'pointer-events:none;width:100%;height:100%;position:fixed;top:0;left:0'`
  and prepends it to `<body>`. Hydra **owns this canvas**; it cannot be
  trivially re-homed into a height-constrained panel canvas. This is the
  pivotal constraint the Visuals-mode home is designed around (see Phase 1).
- **`H()` throws on empty haps.** `queryArc(...)[0].value` blows up the
  instant the queried pattern has no active hap at the current instant —
  which is most of the time for any sparse pattern. strasbeat must ship its
  own guarded `H()`.
- **`clearHydra()` removes `#hydra-canvas`.** Good — that is exactly the
  teardown we need to stop stale WebGL contexts piling up across HMR. But
  upstream only calls it when *you* call it from a pattern; strasbeat must
  also call it on stop/reset and on HMR dispose.
- **`feedStrudel` needs the full-window 2D canvas.** It does
  `getDrawContext()` (the default `#test-canvas`, full-window 2D), hides it
  (`display:none`), and feeds its pixels into hydra source `s0`. This only
  makes sense when the live Strudel 2D rendering is going to that
  full-window canvas — which, in strasbeat's Phase 1 default, it is **not**
  (see the feedStrudel note in Phase 1). Hence feedStrudel is coherent only
  with the full-window increment.
- **`initHydra()` already returns the hydra object** (the local build and
  upstream main both do this; merged upstream #1784 just guarantees it).
  Our wrapper preserves that return.

**`.shader()` does not exist in upstream `main`.** It is open, unmerged
**PR #1196** — a *separate* `@strudel/shader` package built on PicoGL with a
churning API (`loadShader\`…\`` template literal → `{uniforms}` with
`.incr()`/`.set()`; `.uniform({dest, gain, slow, onTrigger})` /
`.uniformTrigger(name)`; index `N` / `'seq'` / `'random'` / note-based).
Phase 2 borrows these **concepts and vocabulary**, not the code, and does
**not** wrap that unstable API. (Confirmed by reading
`strudel-source/packages/` — there is no `shader` package on `main`.)

## Non-negotiable constraints (from `CLAUDE.md` + `SYSTEM.md` §11)

- **Offline-first.** Bundle `hydra-synth` locally. Never load the
  `unpkg.com` CDN. (`CLAUDE.md`.)
- **Surface silent failures loudly.** `H()` guard, shader-compile failures,
  and WebGL context-loss all log/route loudly — never silently render black
  or degrade. (`CLAUDE.md` "Key gotchas" / "Conventions".)
- **No backwards-compat shims; defer features the user didn't ask for; no
  "while I'm here" refactors.** (`CLAUDE.md` conventions.)
- **Defer visual aesthetics to the polish skills.** This spec specifies the
  legibility *mechanism* and a single working default; it does **not** bake
  final colors/opacities. (User feedback memory.)
- **§11 off-limits, with one sanctioned exception.** `@strudel/*` imports,
  prebake/audio-init, `renderPatternToBuffer`/WAV export, MidiBridge setup,
  `import.meta.glob` of `/patterns`, the share codec, and the
  `window.strasbeat`/`window.editor`/`window.midi` exports are off-limits.
  `editor.updateSettings({...})`, CodeMirror extensions, and toolbar DOM
  listeners are fair game. **The one exception** — adding the hydra wrapper
  to the `evalScope(...)` call in `src/boot.js:51` — is sanctioned by the
  `07-chord-progression` precedent (`design/README.md` notes that work
  "touches evalScope … minimally and additively"). See "The one sanctioned
  plumbing touch".
- **`strudel-source/` is read-only** upstream reference. Read it; never
  modify it.
- **The single-quote rule.** Strudel's transpiler rewrites **every
  double-quoted string literal** into a `mini(...)` call. Any new
  `src/strudel-ext/` helper taking a literal string argument (a shader
  source, a uniform name) MUST document the single-quote rule **and** ship a
  Pattern-input guard, exactly like `progression()`. (`CLAUDE.md` "the
  single-quote rule".)

---

## The one sanctioned plumbing touch

`src/boot.js:51` holds the `evalScope(...)` call:

```js
const loadModules = evalScope(controls, strudelCore, strudelDraw, strudelMini, strudelTonal, strudelWebaudio, strudelSlider, strudelExt);
```

`strudelExt` is already a namespace import of `src/strudel-ext/index.js`
(that is how `progression()` reaches pattern scope). The hydra wrapper,
guarded `H()`, `clearHydra` wrapper, and (Phase 2) the `shader()` node are
all re-exported from `src/strudel-ext/index.js`, so **they reach pattern
scope through the `strudelExt` arg that is already there**. No new argument
to `evalScope` is required.

The *only* edit in `boot.js` is therefore: ensure the hydra wrapper's
re-export does not collide with anything Strudel already registers, and —
because `@strudel/hydra`'s `initHydra`/`H`/`clearHydra` are NOT currently in
the eval scope at all — confirm our `strudel-ext`-exported versions are the
ones that win. Concretely:

- **Do NOT** add `@strudel/hydra` to the `evalScope` arg list. We ship our
  own wrapper instead (it owns the offline `src`, the `H()` guard, and the
  teardown hooks). Re-export `initHydra`, `clearHydra`, `H` from
  `src/strudel-ext/index.js`.
- If any name we export already exists in scope from another arg, **stop and
  ask** — it means a collision needs resolving, not that the rule should
  bend. (As of audit, none of `initHydra`/`clearHydra`/`H`/`shader` are in
  the scope, since hydra is opt-in-only today.)

If anything *else* in `boot.js` seems necessary, stop and ask. As with
`07`, this should land as its own small commit so it is trivially
revertible — but **do not commit**; commits are a human/broker step (see
"Execution model").

---

## Phase 1 — first-class, offline Hydra

### What

`await initHydra()` works in any pattern with no setup step, runs fully
offline, and renders into a first-class **Visuals** bottom-panel mode. `H()`
is guarded. Everything tears down on stop / re-init / HMR.

```js
// patterns/<n>-hydra-demo.js  (single-quoted args — see the rule below)
await initHydra()
osc(10, 0.1, 1.2).color(0.9, 0.3, 0.6).out()

$: s("bd*4, ~ sd").bank("RolandTR909")
```

### Why

Visuals are an output of the instrument, not an optional package. Making
`initHydra()` zero-friction (and offline) is the whole unlock; everything
else in Phase 1 is making that first-class instead of buried.

### Components

#### 1. Local `hydra-synth` bundling + the wrapper (`src/strudel-ext/hydra.js`)

- Add `hydra-synth` as a **direct dependency** (`pnpm add hydra-synth`).
- New module `src/strudel-ext/hydra.js` ships strasbeat's own
  `initHydra` / `clearHydra` / `H`, modeled on upstream
  `hydra.mjs` but:
  - **Offline source.** Instead of `await import('https://unpkg.com/…')`,
    `import Hydra from 'hydra-synth'` (or the package's actual ESM entry —
    verify the export shape at implementation time; the CDN build attaches a
    global, the npm build is an ESM/CJS module, so the constructor is
    obtained from the import, not `globalThis.Hydra`). Construct
    `new Hydra({ …, canvas })` from that import. **Never** read a global
    `Hydra`, **never** fetch `unpkg.com`.
  - **Same canvas + option semantics as upstream** otherwise: reuse
    `getDrawContext('hydra-canvas', …)` for the canvas (we want exactly the
    full-viewport fixed `pointer-events:none` canvas — that is what the
    Visuals-mode clip and the later full-window increment both build on),
    honor `feedStrudel`, `detectAudio`, `pixelRatio`, etc. Re-init on
    changed options by removing `#hydra-canvas` (upstream behavior).
  - **Returns the hydra object** (preserve the upstream/#1784 contract).
  - **Notifies the host that visuals are live.** On successful init, call a
    host callback (registered from `main.js`) so the bottom panel can flip
    the **Visuals** mode available (mirrors how `setBeatsAvailable` /
    `setCustomDraw` gate modes). On `clearHydra`, flip it unavailable.

#### 2. Guarded `H()`

strasbeat's `H()` wraps `reify(p).queryArc(getTime(), getTime())` and
**guards the empty-hap case**: if there is no active hap, return the **last
non-empty value** seen for that pattern, or `0` if none yet — never index
`[0].value` on an empty array. Empty haps are normal (not an error), so this
does **not** warn; it simply never throws. (Per `CLAUDE.md`
surface-failures-loudly ethos: the failure mode here is a crash that takes
down the whole render loop, so we eliminate it.)

#### 3. First-class home — the **Visuals** bottom-panel mode (Phase 1 default)

Add a `"visuals"` entry to `MODES` in `src/ui/bottom-panel-modes.js`
(sibling of Roll / Scope / Beat grid / Custom), gated available by a
`setVisualsAvailable(bool)` function mirroring `setBeatsAvailable`. It
becomes available when `initHydra()` succeeds and unavailable on
`clearHydra` / teardown. **Only one bottom-panel mode is active at a time** —
Visuals is a sibling, not an overlay. When Visuals is active, Roll / Scope /
Beats are not rendering.

**The clip/position approach (Option A).** Hydra's `#hydra-canvas` is fixed,
full-viewport, and owned by hydra — it cannot render into the panel's
height-constrained `#roll` canvas. So in **Visuals** mode strasbeat
**clips and positions the full-viewport `#hydra-canvas` to overlay exactly
the `.roll-pane` rectangle**, using CSS `clip-path: inset(...)` (the canvas
stays `position:fixed` full-viewport; we mask it down to the panel rect).
The panel becomes a window onto the canvas. (Options B "per-frame
`drawImage` mirror" and C "no in-panel preview, just toggle full-window"
were considered and rejected — B adds a needless per-frame texture copy and
a second canvas; C collapses the deliberate distinction between the Visuals
default and the later full-window increment.)

When Visuals mode is **not** active, the clip is removed and `#hydra-canvas`
is hidden (`display:none`) so it does not paint over the editor — that
behavior is reserved for the full-window increment below.

**The clip must track panel geometry, or it drifts.** Because the canvas is
`position:fixed` and the panel is divider-resizable + collapsible, recompute
and re-apply the clip rect on every event that moves the `.roll-pane`:

- **divider drag** — `src/piano-roll-resize.js` mutates `--roll-h` on
  `pointermove`; the Visuals clip must re-sync as the divider drags (hook
  the same path, or observe `--roll-h` / the `.roll-pane` rect).
- **roll-collapse toggle** — `toggleRoll()` adds/removes
  `shell--roll-collapsed` and clears/sets `--roll-h`; re-sync after it (when
  collapsed, the panel has no height, so Visuals mode should clip to nothing
  / hide).
- **window resize** — debounced, **matching the existing 200ms canvas-resize
  debounce** (`getDrawContext`'s own resize handler uses 200ms;
  `piano-roll-resize.js` uses `TOGGLE_DEBOUNCE_MS = 200`). Reuse the
  existing `--roll-h` geometry / `.roll-pane` `getBoundingClientRect()`
  rather than recomputing panel layout independently.

Do not invent a settings-drawer visuals section and do not put any visuals
state in the share codec (off-limits). Panel open/closed + active-mode state
persist to localStorage exactly like the other bottom-panel modes.

#### 4. Teardown / lifecycle (mirror `src/ui/scope.js` discipline)

`scope.js` is the precedent: a lazy, idempotent live resource with explicit
`disconnect()`. The hydra resource follows the same shape. Run the
`clearHydra`-equivalent (`hush()` + remove `#hydra-canvas` + flip Visuals
unavailable) on:

- **editor stop / reset** — wire into the existing stop path so a stopped
  pattern does not leave a live WebGL context running.
- **`initHydra(options)` re-init with changed options** — upstream already
  removes `#hydra-canvas`; preserve that.
- **Vite HMR dispose** — `import.meta.hot.dispose(() => clearHydra())`.
  strasbeat reloads the page on pattern-file change, so without this a stale
  hydra canvas / WebGL context survives the reload and they pile up.
  `clearHydra` removing `#hydra-canvas` is what makes this safe.

#### 5. Legibility mechanism (copy strudel.cc's working approach)

The legibility primitive is **per-line translucent plates**, NOT a global
scrim:

- `.cm-line > * { background: var(--lineBackground); }` at a working default
  alpha (~60%) so text sits on its own translucent strip over the visuals.
- The visuals canvas is already `pointer-events:none` (from `getDrawContext`),
  so it never steals clicks/selection.
- **`.darken::before` in upstream CSS is DEAD CODE — do not copy it.** (It is
  an unused overlay; the real mechanism is the per-line plates above.)

Specify **only the mechanism + one working default alpha**. Defer the final
color/opacity/token choices to a `/polish` pass — read `SYSTEM.md` before
introducing the `--lineBackground` token so it slots into the existing token
system rather than inventing a parallel one. (In the Phase 1 default the
visuals are confined to the bottom panel, so the plates barely matter yet;
they become load-bearing in the full-window increment. Introduce the
mechanism now so the increment is a CSS flip, not a new feature.)

#### 6. feedStrudel — explicitly deferred to the full-window increment

`feedStrudel` hides the full-window 2D `getDrawContext()` (`#test-canvas`)
and feeds its pixels into hydra `s0`. But in the **Phase 1 default**, the
live Strudel 2D rendering goes into the **bottom-panel `#roll` canvas**, not
the full-window `#test-canvas`. So feedStrudel has nothing meaningful to
feed in the panel default. **`feedStrudel` is therefore deferred to — and
only coherent with — the full-window increment below**, where the Strudel
2D rendering is on the full-window canvas. Phase 1's wrapper still accepts
the `feedStrudel` option (it passes through to hydra), but the spec is
explicit: it is not expected to produce useful output until full-window.

#### 7. Remove the redundant opt-in entry

Delete the `id: "hydra"` entry from `PACKAGES` in `src/user-setup.js`
(`:111-116`). A core, always-available feature must not read as an optional
package. (No backwards-compat shim per `CLAUDE.md`.) Confirm nothing else in
`user-setup.js` keys off that id before removing.

### The single-quote rule (Phase 1)

`initHydra` takes an options *object*, not a bare string, so the literal-
string transpiler hazard is mild here — but document in the demo pattern's
header comment that **Hydra source chains use Hydra's own functions
(`osc`, `noise`, `…`), not Strudel mini-notation**, and that any string
passed to a strasbeat helper must be single-quoted (it becomes load-bearing
in Phase 2's `shader('…')`).

### Files (Phase 1)

- `package.json` — add `hydra-synth` direct dependency.
- `src/strudel-ext/hydra.js` — offline `initHydra` / `clearHydra` / guarded
  `H`, the host-callback to gate Visuals availability, and HMR-dispose
  teardown.
- `src/strudel-ext/index.js` — re-export `initHydra`, `clearHydra`, `H`.
- `src/strudel-ext/hydra.test.js` — unit tests for the guarded `H()` (empty
  haps → last value or 0, never throws) — pure, no WebGL. Mirror
  `progression.test.js`'s Vitest shape.
- `src/ui/bottom-panel-modes.js` — add `"visuals"` mode + `setVisualsAvailable`.
- `src/main.js` — register the Visuals-availability callback on the hydra
  wrapper; wire Visuals into the `onDraw` mode switch (Visuals mode does no
  2D paint into `#roll` — hydra paints its own canvas — so the `onDraw`
  branch for `"visuals"` early-returns like `"beats"` does); wire the
  clip-position + the geometry re-sync (divider drag / collapse / resize);
  wire `clearHydra` into the stop path. **Treat `main.js` like `07` treats
  it — additive only.** If a touch looks invasive, stop and ask.
- `src/styles/*.css` — the `.cm-line > *` per-line-plate rule + the
  `--lineBackground` token (working default), and the Visuals-mode
  clip styling for `#hydra-canvas`. Read `SYSTEM.md` first.
- `src/user-setup.js` — remove the opt-in `hydra` package entry.
- `patterns/<n>-hydra-demo.js` — end-to-end demo / smoke test
  (`PATTERN-STYLE.md`-compliant; single-quoted helper args). Number it
  after the current highest pattern at implementation time.

### Acceptance — Phase 1

- [ ] In a fresh pattern, `await initHydra()` + an `osc(...).out()` chain
      renders visuals **with no setup-panel toggle** and **no network
      request to `unpkg.com`** (verify in the devtools Network tab).
- [ ] The Visuals mode appears in the bottom-panel switcher only after
      `initHydra()` succeeds, and is the surface that shows the hydra
      output.
- [ ] In Visuals mode, the hydra canvas is clipped to the `.roll-pane`
      rect and does not paint over the editor.
- [ ] **Resize the panel mid-visual** (drag `rollDivider`): the clip
      follows the new panel height in real time without drift.
- [ ] **Collapse the roll** while Visuals is active: the visuals clip to
      nothing / hide; expanding restores them to the panel rect.
- [ ] **Resize the window** while Visuals is active: the clip re-syncs
      (debounced ~200ms) to the new `.roll-pane` rect.
- [ ] `H("0 0.5 1")` used as a hydra param does not throw when the queried
      pattern is between events (verify by stepping a sparse pattern;
      previously this crashed the render loop).
- [ ] `clearHydra()` from a pattern removes `#hydra-canvas` and flips
      Visuals unavailable.
- [ ] Pressing **stop** tears down the hydra context (no live WebGL context
      lingering — verify `#hydra-canvas` is gone).
- [ ] Editing a pattern file (triggering HMR page reload) leaves **exactly
      one** `#hydra-canvas` afterward, not a growing pile (verify by editing
      a hydra pattern several times and counting WebGL contexts).
- [ ] The opt-in `hydra` entry is gone from the Setup panel.
- [ ] Editor text remains legible over visuals via the per-line plates
      (mechanism present; final aesthetics deferred to `/polish`).
- [ ] `patterns/<n>-hydra-demo.js` plays + renders end to end.

---

## Phase 1.5 (later increment, same spec) — full-window visuals behind the editor

### What

A toggle that **un-clips `#hydra-canvas` to full-viewport behind the
editor** (strudel.cc-style), making the editor itself transparent so the
visuals show through. This is the invasive part — separately scoped so the
Phase 1 default never depends on it.

### Why separate

This requires `bgFill:false` (or an equivalent editor-transparency change)
plus the per-line plates becoming load-bearing, and it interacts with
strasbeat's opaque-shell + OKLCH accent system — invasive enough that it
must not be forced into the Phase 1 default. Sequenced **after** the
Visuals-mode default precisely because both full-window and `feedStrudel`
depend on the full-window 2D canvas being the live one.

### Approach

- A toggle (toolbar DOM listener — fair game per §11) that switches between
  **panel-clipped** (Phase 1 default) and **full-window-behind-editor**.
- Full-window mode: remove the `.roll-pane` clip so `#hydra-canvas` shows
  full-viewport; make the editor transparent (`bgFill:false` via
  `editor.updateSettings({...})` — fair game per §11) so the canvas shows
  through; the per-line plates from Phase 1 keep the text legible (now
  load-bearing — this is where the `/polish` pass on alpha/tokens matters).
- **feedStrudel becomes coherent here:** with the editor over the
  full-window canvas, the live Strudel 2D rendering can target the
  full-window `#test-canvas`, so `feedStrudel:true` has real pixels to feed
  into `s0`. Document this dependency; it is the reason feedStrudel was
  deferred in Phase 1.
- Persist the toggle state to localStorage (not the share codec).

### Acceptance — Phase 1.5

- [ ] Toggling to full-window un-clips `#hydra-canvas` to full-viewport and
      makes the editor transparent; the visuals fill the window behind the
      code.
- [ ] Editor text stays legible via the per-line plates (this is where the
      `/polish` alpha tuning lands).
- [ ] Toggling back returns to the Phase 1 panel-clipped Visuals mode with
      the opaque editor restored.
- [ ] With full-window on + `feedStrudel:true`, a pattern that draws to the
      Strudel 2D canvas feeds those pixels into hydra `s0` (verify a
      `s0`-sampling hydra chain reacts to the Strudel drawing).
- [ ] Toggle state persists across reload (localStorage), and is **not** in
      the share codec.

---

## Phase 2 — event-driven named shader uniforms (the "Reddit dream")

### What

A strasbeat-original **`shader('…glsl…')`** node: drop in a Shadertoy-style
fragment shader and have the playing pattern drive its **named uniforms**.
Two layers:

1. **Auto-uniforms (zero-config, beginner path).** Convention-based uniforms
   derived from the pattern's events with no extra code:
   `uKick` / `uSnare` / `uHat` from drum lanes, `uKeyVelocity` from
   note/MIDI velocity, and `u<SoundName>` for active sounds — each a
   **decay envelope** (a hap onset pulses the uniform to peak; it decays
   toward 0). Borrows PR #1196's *decayModulation* concept.
2. **Explicit `.uniform()` override (power path).** Borrows PR #1196's
   vocabulary: `.uniform({ dest, gain, slow, onTrigger })` with
   `index: 'seq' | 'random' | <note-based>` to drive any named uniform from
   any pattern value with explicit gain/slew.

```js
// patterns/<n>-shader-demo.js  (single-quoted shader source — see the rule)
await shader('
  precision mediump float;
  uniform float uKick;     // auto-uniform from the bd lane
  uniform float uTime;
  void main() {
    float r = 0.3 + uKick * 0.5;
    gl_FragColor = vec4(r, 0.1, 0.4, 1.0);
  }
')

$: s("bd*4, ~ sd, hh*8").bank("RolandTR909")
// power path: drive a custom uniform explicitly
$: note("0 7 5 7").uniform({ dest: 'uMelody', gain: 0.8, slow: 2 })
```

### Why

This is the capability upstream is *still prototyping* (unmerged #1196).
Auto-uniforms give a total beginner reactive visuals with zero GLSL
plumbing (the "gentle for beginners" ethos); `.uniform()` gives a power user
exact control. Building it as original work (concepts from #1196, not its
code) means strasbeat is not blocked on an unstable external API.

### Data flow: `onDraw(haps, time)` → decay envelope → uniform map → shader

**The source is the existing `onDraw(haps, time)` hook
(`src/main.js:211`), NOT a new event bus and NOT a superdough patch.** Every
~60fps frame, `onDraw` carries the active haps (the same ones the roll
renderer sees). There is **no per-event `onTrigger` bus** in strasbeat
(`eval-feedback.js` derives everything from `queryArc`/haps; the
`onTrigger`s in `export.js`/`sound-browser.js` are per-sound, not a global
bus) — so building one is out of bounds. The derivation:

```
onDraw(haps, time):
  newOnsets = haps active this frame that were NOT active last frame
  for each onset: set the matching uniform(s) to peak (gain-scaled)
  for every uniform: value *= decay(dt)    // decay toward 0 between onsets
  feed the uniform map into the shader node's program before it draws
```

- **Uniform derivation is a pure function** of (current haps, previous-frame
  state, dt, config) → uniform map. That purity is what makes it
  unit-testable (see Files/tests).
- **Onset detection** = a hap newly present this frame that was not present
  last frame (compare hap identity across frames). This is how we get
  per-event pulses *without* an event bus.
- **Mapping conventions:** drum-lane sound names → `uKick`/`uSnare`/`uHat`
  (define the lane→uniform table explicitly; verify sound names with
  `strasbeat.hasSound(...)` patterns the way `CLAUDE.md` requires); note
  haps → `uKeyVelocity`; each active sound `name` → `u<Name>` (sanitize to a
  valid GLSL identifier). The explicit `.uniform({dest})` overrides/extends
  this map.

### The shader node (raw WebGL, strasbeat-original)

- New module under `src/strudel-ext/` (e.g. `src/strudel-ext/shader.js`).
  Raw WebGL (PicoGL-style, per #1196's separate-package direction — but our
  own code): compile the drop-in fragment shader against a full-screen
  triangle, expose the named uniforms (auto + explicit), and draw each frame
  with the current uniform map.
- Manages its own canvas with the **same lazy/idempotent + explicit
  teardown discipline** as Phase 1's hydra resource and `scope.js`
  (`ensureConnected`/`disconnect` shape). Tears down on stop / re-init / HMR
  dispose.
- **Built-in uniforms** like `uTime` / `uResolution` are always provided so
  a Shadertoy port runs without any pattern wiring.

### Error handling — route through surface-failures-loudly (explicit)

- **Shader compile failure:** log the GLSL compile/link error log **loudly**
  — `console.error` with a `[strasbeat]` prefix AND, where reachable, into
  the eval-feedback console panel (`console-panel.js`) so it shows in-app,
  not just devtools. **Never silently render black.**
- **Keep the last-good program on a failed compile.** A compile error
  (e.g. the user is mid-edit) must **not** tear the node down — it keeps
  rendering the last successfully-compiled program and surfaces the error, so
  live-editing a shader degrades gracefully instead of going black.
- **WebGL context loss:** listen for `webglcontextlost`
  (`event.preventDefault()` to allow restore) and `webglcontextrestored`;
  on loss, log loudly; on restore, **recompile the current program and
  re-create GL resources**. Never leave a silently-dead canvas.

### The single-quote rule + Pattern-input guard (REQUIRED)

`shader('…glsl…')` takes a **literal string** (the GLSL source), and
`.uniform({ dest: 'uName' })` takes a literal uniform-name string — so the
transpiler will rewrite any **double-quoted** occurrence into `mini(...)`,
turning the shader source into a Pattern and breaking the node. Therefore:

- **Document the single-quote rule** prominently in the helper's JSDoc and
  in the demo pattern header: shader source and uniform names **must be
  single-quoted**. (Drum/note patterns in the same file still use double
  quotes — the rewrite is correct for `s("…")`.)
- **Ship a Pattern-input guard** at the top of `shader()` (and
  `.uniform()`): detect `arg?._Pattern === true` and `console.warn` loudly
  with the actionable fix ("shader source must be single-quoted — see
  CLAUDE.md the single-quote rule"), then bail gracefully (return a no-op /
  silent node) rather than crashing. Exactly the `progression()` pattern.

### Files (Phase 2)

- `src/strudel-ext/shader.js` — the WebGL shader node (compile, uniforms,
  draw, context-loss handling, teardown, the Pattern-input guard).
- `src/strudel-ext/uniforms.js` — the pure onDraw-haps → decay-envelope →
  uniform-map derivation (onset detection, decay, the lane/note/sound
  conventions) + the `.uniform()` override merge.
- `src/strudel-ext/index.js` — re-export `shader` (and the `.uniform()`
  pattern method registration, per how Strudel registers pattern methods).
- `src/strudel-ext/uniforms.test.js` — Vitest unit tests for the pure
  derivation: onset detection across frames, decay envelope shape,
  lane→uniform mapping, explicit `.uniform()` override beats the auto map,
  GLSL-identifier sanitization. Mirror `progression.test.js`.
- `src/strudel-ext/shader.test.js` — Pattern-input guard test (double-quoted
  → guarded warn + no-op; single-quoted → compiles). Pure where possible;
  the WebGL compile path is verified via manual steps in the plan.
- `src/main.js` — feed the per-frame uniform map from the `onDraw` branch
  into the active shader node. Additive only.
- `patterns/<n>-shader-demo.js` — end-to-end demo: a Shadertoy-style shader
  reacting to `uKick`/`uSnare` (auto) and one explicit `.uniform()`.
  `PATTERN-STYLE.md`-compliant; single-quoted shader source.

### Acceptance — Phase 2

- [ ] `await shader('<valid frag shader>')` compiles and renders.
- [ ] A drum pattern with a `bd` lane makes `uKick` pulse-and-decay (the
      shader visibly reacts on each kick; verify the decay between kicks).
- [ ] `uSnare` / `uHat` react to their lanes; `uKeyVelocity` reacts to note
      velocity; an active sound `xyz` exposes `uXyz`.
- [ ] `.uniform({ dest: 'uMelody', gain: 0.8, slow: 2 })` drives `uMelody`
      from the pattern, overriding/extending the auto map.
- [ ] Built-in `uTime` / `uResolution` work with no pattern wiring (a bare
      Shadertoy port animates).
- [ ] **Double-quoted** shader source (`shader("…")`) → loud
      `[strasbeat]` warning about the single-quote rule + a no-op node (does
      not crash the editor).
- [ ] A **shader compile error** logs loudly (console **and** the in-app
      console panel) and **keeps the last-good program** rendering — does not
      go black, does not tear down.
- [ ] **Forcing context loss** (devtools `WEBGL_lose_context`) logs loudly;
      on restore the program **recompiles** and rendering resumes.
- [ ] Stop / HMR dispose tears the shader node down (no lingering WebGL
      context; HMR leaves exactly one).
- [ ] `uniforms.test.js` covers onset detection, decay, mapping, and
      override precedence; `shader.test.js` covers the Pattern-input guard.
- [ ] `patterns/<n>-shader-demo.js` plays + renders end to end.

---

## Execution model

This spec is built to run **end-to-end via
`superpowers:subagent-driven-development`** on a **dedicated hydra-visuals
branch**:

- **Branch creation is a human/broker step.** Agents do **not** create the
  branch, **do not commit, and do not push.** (Per the planning-delegation
  memory: agents execute, humans integrate.)
- **Tasks must be discrete and independently verifiable**, each with
  explicit verification steps. Natural task seams: (1) bundle hydra-synth +
  offline wrapper + guarded `H()`; (2) Visuals bottom-panel mode + clip +
  geometry re-sync; (3) teardown wiring (stop / HMR) + remove opt-in entry +
  legibility plates; (4) full-window increment (1.5); (5) shader node +
  context-loss; (6) uniform derivation (auto) + `.uniform()` override +
  guard; (7) demo patterns + tests. Each is independently testable.
- **Plan file:** `design/work/archive/25-hydra-visuals-plan.md` (written by
  `superpowers:writing-plans` against this spec).

## Out of scope (across all phases)

- **Visuals state in the share codec.** Off-limits (§11). Visuals config
  lives inside the pattern via `initHydra(options)` / `shader('…')`; panel
  state is localStorage like other panels.
- **A settings-drawer "Visuals" section.** strudel.cc has essentially no
  visuals settings UI; config lives in the pattern. Do not invent one.
- **Wrapping PR #1196's `.shader()` API.** It is unmerged and churning;
  Phase 2 is original work informed by its concepts, not a wrapper.
- **A new global `onTrigger` / event bus, or any superdough patch.** Phase 2
  derives events from `onDraw(haps, time)` + onset detection. (`CLAUDE.md`:
  do not patch superdough; surface failures via the public draw hook.)
- **Final visual aesthetics** (plate alpha/color, accent interplay,
  motion). This spec specifies the *mechanism* + one working default; a
  `/polish` pass owns the taste-level choices.
- **Hydra `setFunction` custom GLSL.** Phase 2 is a standalone raw-WebGL
  shader node (per #1196's separate-package direction), not a hydra
  extension.

## What this builds on

- **`07-chord-progression.md`** — the runtime-helper-that-touches-evalScope
  precedent. Same minimal/additive plumbing discipline.
- **`src/ui/scope.js`** — the lazy/idempotent live-resource + explicit
  teardown precedent for the hydra and shader canvases.
- **`src/ui/bottom-panel-modes.js`** — the mode multiplexer; Visuals is a
  new sibling mode gated like Beats/Custom.
- **`src/main.js:211` `onDraw(haps, time)`** — the ~60fps event source for
  Phase 2 uniforms.
- **`src/piano-roll-resize.js`** — the `--roll-h` / collapse / 200ms-debounce
  geometry the Visuals clip must track.
- **`strudel-source/packages/hydra/hydra.mjs`** + **`packages/draw/draw.mjs`**
  — upstream behavior to mirror offline (read-only reference).
- **`CLAUDE.md`** — offline-first, surface-failures-loudly, the single-quote
  rule, the §11 off-limits exception by the `07` precedent.
- **PR #1196 (upstream, unmerged)** — *concepts* for Phase 2: decayModulation,
  `{dest, gain, slow, onTrigger}`, seq/random/note indexing. Not its code.
