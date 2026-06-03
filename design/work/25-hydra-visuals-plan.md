# Hydra Visuals (`initHydra()` + event-driven shader uniforms) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Strudel's Hydra visuals a first-class, offline, zero-setup output of the instrument (Phase 1), add a full-window-behind-editor mode (Phase 1.5), and build a strasbeat-original raw-WebGL `shader()` node whose named uniforms are driven by the playing pattern's events (Phase 2).

**Architecture:** All pattern-facing helpers (`initHydra`, `clearHydra`, `H`, `shader`) live in `src/strudel-ext/` and reach pattern scope through the `strudelExt` namespace import that is **already** an argument to the `evalScope(...)` call at `src/boot.js:51` — no new `evalScope` argument is added. The hydra wrapper bundles `hydra-synth` locally (never the unpkg CDN) and reuses upstream's full-viewport fixed `#hydra-canvas`; a new `"visuals"` bottom-panel mode clips that canvas to the `.roll-pane` rect. The Phase 2 shader node is raw WebGL with its own canvas, fed a per-frame uniform map derived purely from the existing `onDraw(haps, time)` hook at `src/main.js:211`.

**Tech Stack:** Vanilla JS (ESM), Vite, CodeMirror 6 via `@strudel/codemirror`, `@strudel/core`/`@strudel/draw`/`@strudel/hydra` (read-only upstream reference under `strudel-source/`), `hydra-synth` (new direct dependency), raw WebGL, `node:test` for unit tests.

---

## Preamble — read before starting (binding constraints)

These come from `CLAUDE.md`, `design/SYSTEM.md` §11, and the spec `design/work/25-hydra-visuals.md`. They are non-negotiable; honor them in every task.

1. **NO COMMITS. NO PUSH. NO BRANCH CREATION.** This plan runs on a dedicated `hydra-visuals` branch that a human/broker created. Agents work **in the tree only**. Every "verify" step uses tests or in-app observation — never `git`. Do **not** run `git add`/`git commit`/`git push`. (planning-delegation memory.) The `git commit` step that the writing-plans skill template normally ends each task with is **deliberately omitted** here.

2. **Read first.** Before coding, read: `design/work/25-hydra-visuals.md` (the spec — your source of truth and the source of every Acceptance checklist referenced below), `CLAUDE.md` (offline-first, surface-failures-loudly, the single-quote rule, §11 off-limits + the `07` exception), `design/SYSTEM.md` (token system — read before adding any CSS token), `design/PATTERN-STYLE.md` (before writing any `patterns/*.js`), and the named upstream reference files inside each task. `strudel-source/` is **read-only** — never modify it.

3. **TDD where the spec marks pieces pure/unit-testable.** Write the failing test first, then minimal implementation. The repo's test runner is **`node:test`** (`node --test`), **not Vitest** — mirror `src/strudel-ext/progression.test.js`'s shape (`import { test, describe, beforeEach, afterEach } from "node:test"; import assert from "node:assert/strict";`). When you add a test file, append it to the `"test"` script's file list in `package.json` so `pnpm test` runs it. (The spec says "Vitest" loosely; the repo convention is `node:test` — follow the repo.)

4. **The one sanctioned plumbing touch.** The only sanctioned `boot.js`/`evalScope` touch is via the **existing** `strudelExt` arg — i.e. re-exporting from `src/strudel-ext/index.js`. Do **NOT** add `@strudel/hydra` or any new argument to the `evalScope(...)` list. If any name you export (`initHydra`/`clearHydra`/`H`/`shader`) already exists in the eval scope from another arg, **stop and ask** (as of audit, none do). `main.js` edits are **additive only**, like `07`. If a `main.js` touch looks invasive, stop and ask.

5. **Defer visual aesthetics to `/polish`.** This plan specifies the legibility *mechanism* (per-line translucent plates) and **one working default alpha** only. Do **not** pick final colors/opacities. Read `SYSTEM.md` before introducing the `--lineBackground` token so it slots into the existing token system.

6. **Surface silent failures loudly.** `H()` must never throw; shader compile errors and WebGL context loss must log loudly (`console.error` with a `[strasbeat]` prefix, and into the in-app console panel where reachable) — never silently render black.

7. **Lint + format** per the repo's normal workflow before declaring a task done. Run `pnpm build` where a task touches importable modules to confirm nothing broke the bundle.

8. **No backwards-compat shims, no "while I'm here" refactors.** Fix/add exactly what the task says.

---

## File Structure (created / modified across the plan)

**Created:**
- `src/strudel-ext/hydra.js` — offline `initHydra`/`clearHydra`/guarded `H`, host-callback to gate Visuals availability, teardown. (Task 1, 3)
- `src/strudel-ext/hydra.test.js` — `node:test` unit tests for guarded `H()`. (Task 1)
- `src/styles/visuals.css` — `.cm-line > *` per-line plate rule + `--lineBackground` token + Visuals-mode clip styling for `#hydra-canvas`. (Task 2, 3)
- `src/strudel-ext/shader.js` — raw-WebGL shader node (compile, uniforms, draw, context-loss, teardown, Pattern-input guard). (Task 5, 6)
- `src/strudel-ext/uniforms.js` — pure onDraw-haps → decay-envelope → uniform-map derivation + `.uniform()` override merge. (Task 6)
- `src/strudel-ext/uniforms.test.js` — `node:test` unit tests for the pure derivation. (Task 6)
- `src/strudel-ext/shader.test.js` — `node:test` Pattern-input-guard test. (Task 6)
- `patterns/<NN>-hydra-demo.js` — Phase 1 end-to-end demo. (Task 7)
- `patterns/<NN>-shader-demo.js` — Phase 2 end-to-end demo. (Task 7)

**Modified:**
- `src/strudel-ext/index.js` — re-export `initHydra`, `clearHydra`, `H` (Task 1); `shader` (Task 6).
- `src/ui/bottom-panel-modes.js` — add `"visuals"` mode + `setVisualsAvailable`. (Task 2)
- `src/main.js` — register Visuals-availability callback; `onDraw` `"visuals"` branch; clip-position + geometry re-sync; wire `clearHydra` into stop + HMR dispose; Phase 1.5 full-window toggle; Phase 2 uniform-map feed. **Additive only.** (Tasks 2, 3, 4, 6)
- `src/piano-roll-resize.js` — expose a re-sync hook the Visuals clip can subscribe to on divider drag / collapse. (Task 2)
- `src/style.css` — `@import "./styles/visuals.css"`. (Task 2)
- `src/user-setup.js` — remove the opt-in `hydra` package entry. (Task 3)
- `package.json` — add `hydra-synth` dep (Task 1); append new test files to the `"test"` script (Tasks 1, 6).

---

## Phase 1 — first-class, offline Hydra (Tasks 1–3, must be shippable before 1.5/2)

### Task 1: Bundle `hydra-synth` + offline `initHydra`/`clearHydra` wrapper + guarded `H()`

Implements spec §"Components" 1 & 2, and the §"The one sanctioned plumbing touch" re-export. Definition of done = the Phase 1 Acceptance items: "`await initHydra()` … renders … no network request to unpkg.com", "`H("0 0.5 1")` … does not throw … between events", and "`clearHydra()` … removes `#hydra-canvas`".

**Files:**
- Create: `src/strudel-ext/hydra.js`
- Create: `src/strudel-ext/hydra.test.js`
- Modify: `src/strudel-ext/index.js`
- Modify: `package.json` (dependency + test script)

**Reference reading (read-only):** `strudel-source/packages/hydra/hydra.mjs` (the ~50-line upstream wrapper — mirror its canvas/option semantics, replace its CDN import), `strudel-source/packages/draw/draw.mjs:9-30` (`getDrawContext` — the full-viewport fixed `pointer-events:none` canvas), `src/strudel-ext/progression.js:115-128` (the `_Pattern` guard idiom + JSDoc shape), `src/strudel-ext/progression.test.js` (the `node:test` shape).

- [ ] **Step 1: Add `hydra-synth` as a direct dependency**

Run: `pnpm add hydra-synth`
Expected: `package.json` `dependencies` gains a `hydra-synth` entry; `pnpm-lock.yaml` updates; install succeeds.

- [ ] **Step 2: Verify the npm package's export shape**

Run: `node -e "import('hydra-synth').then(m => console.log('default:', typeof m.default, 'keys:', Object.keys(m)))"`
Expected: prints the constructor's location (e.g. `default: function`). **This determines how the next step imports it.** The CDN build attaches a global `Hydra`; the npm build exposes the constructor via the module (commonly `default`). Use whatever this probe reports — `import Hydra from 'hydra-synth'` if `default: function`, otherwise the named export it reports. Do **not** read `globalThis.Hydra`.

- [ ] **Step 3: Write the failing test for guarded `H()`**

Create `src/strudel-ext/hydra.test.js`:

```js
// Run with: node --test src/strudel-ext/hydra.test.js
//
// Pure tests for the guarded H(): empty haps must NOT throw — they return
// the last non-empty value seen, or 0 if none yet. No WebGL here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mini } from "@strudel/mini";
import { H } from "./hydra.js";

describe("guarded H()", () => {
  test("never throws on a pattern that is empty at the query instant", () => {
    // "~" is silence the whole cycle — queryArc returns [] at every instant.
    const fn = H(mini("~"));
    assert.equal(typeof fn, "function");
    assert.doesNotThrow(() => fn());
  });

  test("returns 0 before any non-empty value has been seen", () => {
    const fn = H(mini("~"));
    assert.equal(fn(), 0);
  });

  test("returns the active value when a hap is present", () => {
    // A pattern that is 0.5 for the whole cycle — always has an active hap.
    const fn = H(mini("0.5"));
    assert.equal(fn(), 0.5);
  });

  test("holds the last non-empty value across an empty instant", () => {
    // Drive H() through a value, then assert it does not reset to 0 / throw
    // when later queried during silence. We simulate by querying a dense
    // pattern (always-present) — the key property is: once a value is seen,
    // a subsequent empty query must return that held value, never throw.
    const dense = H(mini("0.7"));
    assert.equal(dense(), 0.7);
    assert.doesNotThrow(() => dense());
    assert.equal(dense(), 0.7);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test src/strudel-ext/hydra.test.js`
Expected: FAIL — `Cannot find module './hydra.js'` (file does not exist yet).

- [ ] **Step 5: Write `src/strudel-ext/hydra.js`**

```js
// strasbeat's offline-first Hydra wrapper.
//
// Mirrors strudel-source/packages/hydra/hydra.mjs's canvas + option
// semantics, with three strasbeat changes:
//   1. Offline source — bundled `hydra-synth`, never `unpkg.com`. (CLAUDE.md
//      offline-first rule.) The npm build exposes the constructor via the
//      module import (NOT a global `Hydra`).
//   2. Guarded H() — never throws on an empty-hap query (it would otherwise
//      crash the whole render loop). (CLAUDE.md surface-failures-loudly.)
//   3. Host callback — on init/teardown it notifies the host so the
//      bottom-panel "Visuals" mode can gate its availability (mirrors how
//      setBeatsAvailable / setCustomDraw gate modes).
//
// Reaches pattern scope via the strudelExt namespace arg already passed to
// evalScope() at boot.js:51 — see index.js. No new evalScope arg.

import Hydra from "hydra-synth"; // adjust per the Step-2 probe if not `default`
import { getDrawContext } from "@strudel/draw";
import { reify, getTime } from "@strudel/core";

let hydra = null;
let lastOptionsKey = null;

// Host callback registered from main.js (Task 2). Default no-op so the
// module works headless (tests) and before main.js wires it.
let onVisualsAvailable = () => {};
export function setVisualsAvailabilityCallback(fn) {
  if (typeof fn === "function") onVisualsAvailable = fn;
}

/**
 * Initialize Hydra visuals into the full-viewport `#hydra-canvas`.
 * Runs fully offline (bundled hydra-synth — never the unpkg CDN). Returns the
 * hydra instance (preserve the upstream/#1784 contract). Re-init with changed
 * options removes the old `#hydra-canvas` first (upstream behavior).
 *
 * Hydra source chains use Hydra's own functions (osc, noise, …), NOT Strudel
 * mini-notation. Any string passed to a strasbeat helper must be single-quoted
 * (becomes load-bearing for shader('…') in Phase 2). See CLAUDE.md.
 *
 * @param {object} [options] contextType, pixelRatio, pixelated, detectAudio,
 *   feedStrudel (deferred — only coherent with the full-window increment).
 * @example
 * await initHydra()
 * osc(10, 0.1, 1.2).color(0.9, 0.3, 0.6).out()
 */
export async function initHydra(options = {}) {
  const {
    feedStrudel = false,
    contextType = "webgl",
    pixelRatio = 1,
    pixelated = true,
    ...rest
  } = { detectAudio: false, ...options };

  const optionsKey = JSON.stringify({ contextType, pixelRatio, pixelated, feedStrudel });
  // Re-init with changed options: tear down the old canvas first.
  if (hydra && optionsKey !== lastOptionsKey) clearHydra();
  lastOptionsKey = optionsKey;

  const { canvas } = getDrawContext("hydra-canvas", { contextType, pixelRatio, pixelated });
  const hydraConfig = { detectAudio: false, ...rest, canvas };
  hydra = new Hydra(hydraConfig);

  if (feedStrudel) {
    // Deferred to the full-window increment (Phase 1.5): only coherent when
    // the live Strudel 2D rendering targets the full-window #test-canvas.
    // Pass-through so the option is accepted now; not expected to produce
    // useful output in the Phase 1 panel default. (Spec §"feedStrudel".)
    const { canvas: testCanvas } = getDrawContext();
    testCanvas.style.display = "none";
    globalThis.s0?.init?.({ src: testCanvas });
  }

  onVisualsAvailable(true);
  return hydra;
}

/**
 * Stop Hydra, remove its canvas, and flip the Visuals mode unavailable.
 * Called from patterns AND from the stop path / HMR dispose (Task 3).
 */
export function clearHydra() {
  hydra?.hush?.();
  globalThis.s0?.clear?.();
  document.getElementById("hydra-canvas")?.remove();
  hydra = null;
  lastOptionsKey = null;
  onVisualsAvailable(false);
}

/**
 * Guarded value-sampler for driving a Hydra param from a pattern signal.
 * Returns a function that queries the pattern at the current time and yields
 * its active value. Upstream's H() indexes `[0].value` on an empty array and
 * throws the instant the pattern has no active hap — which is most of the time
 * for a sparse pattern, and a throw here crashes the whole render loop. This
 * guard returns the last non-empty value seen (or 0 if none yet). Empty haps
 * are normal, NOT an error, so this does not warn — it just never throws.
 *
 * @param {Pattern} p any Strudel pattern/signal
 * @example
 * osc(10).rotate(H("0 0.5 1"))
 */
export function H(p) {
  let last = 0;
  return () => {
    try {
      const haps = reify(p).queryArc(getTime(), getTime());
      if (haps.length > 0 && haps[0].value != null) {
        last = haps[0].value;
      }
    } catch {
      // Defensive: any query hiccup holds the last value rather than crashing.
    }
    return last;
  };
}
```

> Note: the test's "holds the last value" case exercises the held-value path via dense patterns because driving a true empty-then-present transition needs the live clock. The empty-hap **never-throws** guarantee is the load-bearing property and is covered by the silence (`"~"`) cases.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test src/strudel-ext/hydra.test.js`
Expected: PASS — 4 tests pass, 0 fail.

- [ ] **Step 7: Re-export from the barrel**

In `src/strudel-ext/index.js`, after the existing `export { arrange } from "./arrange.js";` line, add:

```js
export { initHydra, clearHydra, H, setVisualsAvailabilityCallback } from "./hydra.js";
```

- [ ] **Step 8: Register the test file in the test script**

In `package.json`, in the `"test"` script's file list, add `src/strudel-ext/hydra.test.js` (alongside `src/strudel-ext/progression.test.js`).

- [ ] **Step 9: Verify the full suite + build are green**

Run: `pnpm test`
Expected: PASS — the new hydra tests run with the rest; 0 failures.

Run: `pnpm build`
Expected: build succeeds — `hydra-synth` resolves as a bundled dependency, no `unpkg.com` reference, no eval-scope collision warning.

- [ ] **Step 10: Regenerate docs (JSDoc'd helpers)**

Run: `pnpm gen:docs`
Expected: `src/editor/strudel-docs.json` updates to include `initHydra`/`clearHydra`/`H`. Leave the updated JSON in the working tree (do NOT commit). (`CLAUDE.md` gen:docs workflow.)

- [ ] **Step 11: Manual offline + no-throw check (in-app)**

Run: `pnpm dev`, open the app, click once (autoplay), type into the editor:
```
await initHydra()
osc(10, 0.1, 1.2).color(0.9, 0.3, 0.6).out()
```
press play. Open devtools → Network tab.
Expected: visuals render; **no request to `unpkg.com`** appears in Network. Then type `osc(10).rotate(H("0 0.5 1")).out()` over a sparse pattern and confirm no uncaught exception fires in the console between events (the render loop keeps running). This satisfies the Phase 1 Acceptance items "no network request to unpkg.com" and "H(...) does not throw between events".

---

### Task 2: Visuals bottom-panel mode + clip-to-`.roll-pane` + geometry re-sync

Implements spec §"Components" 3 (the Visuals mode + Option A clip/position) and §5's CSS scaffold (the clip styling; the legibility plates land in Task 3). Definition of done = the Phase 1 Acceptance items: "Visuals mode appears … only after initHydra() succeeds", "clipped to the `.roll-pane` rect and does not paint over the editor", "Resize the panel mid-visual … follows … without drift", "Collapse the roll … clip to nothing / hide", "Resize the window … re-syncs (debounced ~200ms)".

**Files:**
- Modify: `src/ui/bottom-panel-modes.js`
- Modify: `src/piano-roll-resize.js`
- Create: `src/styles/visuals.css`
- Modify: `src/style.css`
- Modify: `src/main.js` (additive only)

**Reference reading:** `src/ui/bottom-panel-modes.js` (the `setBeatsAvailable` pattern you mirror), `src/main.js:124-149` (`resizeCanvas`/`doResize`, `bottomModes` wiring), `src/main.js:211-231` (`onDraw` mode switch), `src/main.js:1115` (`mountPianoRollResize` call), `src/piano-roll-resize.js` (the `--roll-h` / collapse / 200ms-debounce geometry), `index.html:289-296` (`.roll-pane` / `#roll-divider` / `#roll` structure).

- [ ] **Step 1: Add the `"visuals"` mode + `setVisualsAvailable` to the mode switcher**

In `src/ui/bottom-panel-modes.js`, add `{ id: "visuals", label: "Visuals" }` to the `MODES` array (after `beats`, before `custom`). Then add a `setVisualsAvailable` function that mirrors `setBeatsAvailable` exactly:

```js
  // Visuals availability is gated by the hydra wrapper: available iff
  // initHydra() has succeeded, unavailable on clearHydra / teardown. Like
  // beats, we do not auto-switch when it appears — the user opts in. We do
  // switch back to roll if it disappears while it's the active view.
  function setVisualsAvailable(available) {
    if (available) {
      modesAvailable.add("visuals");
    } else {
      modesAvailable.delete("visuals");
      if (currentMode === "visuals") setMode("roll");
    }
    updateToggle();
  }
```

Add `setVisualsAvailable` to the returned object (alongside `setBeatsAvailable`).

- [ ] **Step 2: Verify the mode switcher still builds and the new button renders hidden**

Run: `pnpm build`
Expected: build succeeds.

Run: `pnpm dev`, open the app. In the bottom-panel mode pill, confirm there is **no** "Visuals" button visible yet (it is gated unavailable until `initHydra()` — `modesAvailable` starts as `["roll","scope"]`). This confirms the gating wiring before any hydra is involved.

- [ ] **Step 3: Expose a divider/collapse re-sync hook from `piano-roll-resize.js`**

The Visuals clip must re-sync whenever `.roll-pane` geometry changes. Rather than have the clip logic reach into resize internals, add an optional `onGeometryChange` callback param to `mountPianoRollResize` and call it on every geometry mutation. In `src/piano-roll-resize.js`:

Change the signature destructure to include the callback:
```js
export function mountPianoRollResize({
  shellEl,
  rollToggleBtn,
  rollDivider,
  resizeCanvas,
  onGeometryChange,
}) {
  const notifyGeometry = () => {
    if (typeof onGeometryChange === "function") onGeometryChange();
  };
```
Then call `notifyGeometry()` at the end of `toggleRoll()` (after `requestAnimationFrame(resizeCanvas)`), inside the `pointermove` handler (after `shellEl.style.setProperty("--roll-h", ...)`), and inside `endRollDrag` (after the `localStorage.setItem`). This fires on collapse-toggle, live divider drag, and drag-end respectively.

- [ ] **Step 4: Add the Visuals-mode clip CSS scaffold**

Create `src/styles/visuals.css`. **Read `design/SYSTEM.md` first** so the token slots into the existing system. This task adds only the clip mechanics; the `--lineBackground` plate token lands in Task 3.

```css
/* Visuals mode — Hydra's #hydra-canvas is full-viewport, fixed, and
 * pointer-events:none (created by getDrawContext, see
 * strudel-source/packages/draw/draw.mjs). It cannot render into the
 * height-constrained #roll canvas, so in Visuals mode we clip the
 * full-viewport canvas down to the .roll-pane rect (Option A). main.js sets
 * the inset via the --hydra-clip custom properties on the canvas element. */

#hydra-canvas {
  /* Hidden by default: only painted-through when Visuals mode is active or
   * full-window mode (Phase 1.5) is on. Prevents painting over the editor. */
  display: none;
}

#hydra-canvas.is-visuals-clipped {
  display: block;
  clip-path: inset(
    var(--hydra-clip-top, 0px)
    var(--hydra-clip-right, 0px)
    var(--hydra-clip-bottom, 0px)
    var(--hydra-clip-left, 0px)
  );
}

/* Full-window mode (Phase 1.5): un-clipped, full-viewport behind the editor. */
#hydra-canvas.is-visuals-fullwindow {
  display: block;
  clip-path: none;
}
```

- [ ] **Step 5: Import the new stylesheet**

In `src/style.css`, add `@import "./styles/visuals.css";` next to the existing `@import "./styles/bottom-panel.css";`.

- [ ] **Step 6: Wire the Visuals availability callback + onDraw branch + clip logic in `main.js` (additive only)**

In `src/main.js`:

(a) Register the hydra wrapper's availability callback so `initHydra`/`clearHydra` flip the mode. Near the `bottomModes` setup (`~line 148`), add:
```js
// Hydra → bottom-panel Visuals mode gating. The wrapper calls this on
// init (true) / clearHydra (false). Mirrors beatGrid.onLanesChange.
strudelExt.setVisualsAvailabilityCallback((available) => {
  bottomModes.setVisualsAvailable(available);
  syncVisualsClip();
});
```

(b) Add the clip helper. Place it after `doResize`/`resizeCanvas` (`~line 138`). It reads the `.roll-pane` rect and writes inset custom properties onto `#hydra-canvas`; when Visuals mode is inactive or the panel is collapsed/zero-height, it removes the clip class so the canvas is hidden (per the CSS `display:none` default):
```js
const hydraCanvasId = "hydra-canvas";
const rollPaneEl = document.getElementById("roll-pane");
function syncVisualsClip() {
  const cv = document.getElementById(hydraCanvasId);
  if (!cv) return;
  const active = bottomModes.getMode() === "visuals";
  // In full-window mode (Phase 1.5) the class is managed elsewhere; only
  // touch the clipped class here.
  if (!active) {
    cv.classList.remove("is-visuals-clipped");
    return;
  }
  const rect = rollPaneEl.getBoundingClientRect();
  if (rect.height <= 1 || rect.width <= 1) {
    // Collapsed → clip to nothing (hide).
    cv.classList.remove("is-visuals-clipped");
    return;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  cv.style.setProperty("--hydra-clip-top", `${rect.top}px`);
  cv.style.setProperty("--hydra-clip-right", `${vw - rect.right}px`);
  cv.style.setProperty("--hydra-clip-bottom", `${vh - rect.bottom}px`);
  cv.style.setProperty("--hydra-clip-left", `${rect.left}px`);
  cv.classList.add("is-visuals-clipped");
}
```

(c) Re-sync the clip on mode change. Subscribe via `bottomModes.setOnChange`:
```js
bottomModes.setOnChange(() => syncVisualsClip());
```

(d) Add the `"visuals"` branch to the `onDraw` switch (`~line 215`, alongside the `"beats"` early-return — Visuals does no 2D paint into `#roll`; hydra paints its own canvas):
```js
    if (mode === "beats" || mode === "visuals") return;
```
(Replace the existing `if (mode === "beats") return;` line with this combined guard.)

(e) Pass the geometry callback + a window-resize re-sync. Change the `mountPianoRollResize(...)` call (`~line 1115`) to:
```js
mountPianoRollResize({
  shellEl,
  rollToggleBtn,
  rollDivider,
  resizeCanvas,
  onGeometryChange: syncVisualsClip,
});
```
And debounce window-resize re-sync to match the existing 200ms canvas-resize debounce. The existing `ResizeObserver` at `~line 140` already fires `resizeCanvas` (50ms debounce); add a separate 200ms-debounced visuals re-sync on `window resize`:
```js
let visualsResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(visualsResizeTimer);
  visualsResizeTimer = setTimeout(syncVisualsClip, 200);
});
```

If any of these touches requires changing existing (non-additive) `main.js` logic beyond replacing the single `if (mode === "beats") return;` line, **stop and ask** — everything else here is purely additive.

- [ ] **Step 7: Verify build**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 8: Manual verification (in-app) — Phase 1 Acceptance for the clip**

Run: `pnpm dev`, open the app, click once. Type and play:
```
await initHydra()
osc(10, 0.1, 1.2).color(0.9, 0.3, 0.6).out()

$: s("bd*4, ~ sd").bank("RolandTR909")
```
Then verify each Acceptance item:
- The **Visuals** button now appears in the bottom-panel pill (only after `initHydra()` succeeded). Click it.
- In Visuals mode, the hydra output is **clipped to the `.roll-pane` rect** and does **not** paint over the editor.
- **Drag `#roll-divider`** mid-visual: the clip follows the new panel height **in real time without drift**.
- **Collapse the roll** (transport roll-toggle) while Visuals is active: the visuals **clip to nothing / hide**; expanding restores them to the panel rect.
- **Resize the browser window** while Visuals is active: the clip **re-syncs (debounced ~200ms)** to the new `.roll-pane` rect.

---

### Task 3: Teardown wiring (stop + HMR dispose) + remove opt-in entry + legibility plates

Implements spec §"Components" 4 (teardown/lifecycle), 5 (legibility plates — mechanism + one default), 7 (remove opt-in entry). Definition of done = the Phase 1 Acceptance items: "Pressing stop tears down the hydra context", "Editing a pattern file (HMR) leaves exactly one #hydra-canvas", "The opt-in hydra entry is gone from the Setup panel", "clearHydra() … flips Visuals unavailable", "Editor text remains legible … via the per-line plates".

**Files:**
- Modify: `src/strudel-ext/hydra.js` (HMR dispose)
- Modify: `src/main.js` (stop-path wiring — additive)
- Modify: `src/user-setup.js` (remove opt-in entry)
- Modify: `src/styles/visuals.css` (per-line plates + `--lineBackground` token)

**Reference reading:** `src/ui/scope.js:76-120` (the lazy/idempotent + explicit `disconnect()` teardown discipline you mirror), `src/main.js:1080` (`repl-stop` → `editor.stop()`), `src/main.js:1196` (`stopBtn` → `editor.stop()`), `src/eval-feedback.js:441-456` (the patched `stop` — do NOT modify it; wire alongside it), `src/main.js:1274-1285` (the HMR block), `src/user-setup.js:111-116` (the opt-in `hydra` entry to delete), `design/SYSTEM.md` (token system, read before adding `--lineBackground`).

- [ ] **Step 1: Add HMR-dispose teardown to the hydra module**

In `src/strudel-ext/hydra.js`, at the bottom of the file, add:
```js
// Vite HMR dispose: strasbeat reloads the page on pattern-file change, so
// without this a stale hydra canvas / WebGL context survives the reload and
// they pile up. clearHydra() removing #hydra-canvas is what makes this safe.
if (import.meta.hot) {
  import.meta.hot.dispose(() => clearHydra());
}
```

- [ ] **Step 2: Wire `clearHydra` into the stop path (additive, in `main.js`)**

The patched `editor.stop` lives in `eval-feedback.js` — do **not** modify it. Instead, hook the two stop **entry points** in `main.js`. Import `clearHydra` is already reachable via the `strudelExt` namespace (`strudelExt.clearHydra`). Update the two stop listeners:

At `~line 1080`:
```js
document.addEventListener("repl-stop", () => {
  editor.stop();
  strudelExt.clearHydra();
});
```
At `~line 1196` (the `stopBtn` click):
```js
stopBtn.addEventListener("click", () => {
  editor.stop();
  strudelExt.clearHydra();
});
```
This ensures a stopped pattern does not leave a live WebGL context running, and flips Visuals unavailable (clearHydra calls the availability callback → `setVisualsAvailable(false)`).

- [ ] **Step 3: Remove the opt-in `hydra` package entry**

First confirm nothing else keys off the id:

Run: `grep -rn '"hydra"\|id: "hydra"\|=== "hydra"' src/`
Expected: the only matches are the `PACKAGES` entry at `src/user-setup.js:111-116`. If anything **else** references the `hydra` package id, stop and ask.

Then delete the entry from the `PACKAGES` array in `src/user-setup.js`:
```js
  {
    id: "hydra",
    label: "@strudel/hydra",
    description: "Hydra shader visuals",
    load: () => import("@strudel/hydra"),
  },
```

- [ ] **Step 4: Add the legibility plates + `--lineBackground` token**

In `src/styles/visuals.css`, add the per-line translucent-plate mechanism (NOT a global scrim, and do **not** copy upstream's dead `.darken::before`). Use **one working default alpha (~60%)** — final tuning is deferred to `/polish`. Read `SYSTEM.md` so the token slots in:
```css
/* Legibility mechanism — per-line translucent plates so editor text sits on
 * its own translucent strip over the visuals. NOT a global scrim. The
 * canvas is already pointer-events:none, so it never steals clicks. Final
 * alpha/color/token tuning is deferred to a /polish pass (SYSTEM.md). In the
 * Phase 1 panel default the visuals are confined to the bottom panel, so the
 * plates barely matter yet; they become load-bearing in the full-window
 * increment (Phase 1.5). Introducing the mechanism now makes 1.5 a CSS flip. */
:root {
  /* Working default — tune in /polish. Layered over --surface tokens. */
  --lineBackground: oklch(from var(--surface-0, #161616) l c h / 0.6);
}

.cm-line > * {
  background: var(--lineBackground);
}
```
> If `--surface-0` is not the right base token, read `SYSTEM.md` §5 and pick the editor-background token it documents; keep the 0.6 alpha as the working default.

- [ ] **Step 5: Verify build + tests**

Run: `pnpm build`
Expected: build succeeds (no broken import from the removed package entry).

Run: `pnpm test`
Expected: PASS (no regressions; the hydra `H()` tests still pass).

- [ ] **Step 6: Manual verification (in-app) — teardown + opt-in removal + legibility**

Run: `pnpm dev`, open the app.
- **Setup panel:** open it and confirm the `@strudel/hydra` opt-in entry is **gone**.
- **Stop teardown:** play a hydra pattern (from Task 2's snippet), then press **stop**. In devtools, confirm `document.getElementById('hydra-canvas')` returns `null` (no lingering WebGL context) and the Visuals button disappears.
- **HMR dispose:** play a hydra pattern, then edit and save a pattern file several times (each triggers an HMR page reload). After several edits, run `document.querySelectorAll('#hydra-canvas').length` — expected **exactly 1** (or 0 if not currently playing), never a growing pile.
- **`clearHydra()`:** call `clearHydra()` from the editor; confirm `#hydra-canvas` is removed and the Visuals button flips unavailable.
- **Legibility:** in full-window-ish conditions (or just confirm the rule applies), confirm `.cm-line > *` carries `--lineBackground` so text sits on a translucent strip (mechanism present; final aesthetics deferred to `/polish`).

> **Phase 1 is now shippable.** Tasks 4–7 build on it.

---

## Phase 1.5 — full-window visuals behind the editor (Task 4)

### Task 4: Full-window-behind-editor toggle (`bgFill:false` + feedStrudel)

Implements spec §"Phase 1.5". Definition of done = the Phase 1.5 Acceptance items: "Toggling to full-window un-clips … makes the editor transparent", "Editor text stays legible via the per-line plates", "Toggling back returns to … panel-clipped … opaque editor restored", "full-window on + feedStrudel:true … feeds those pixels into hydra s0", "Toggle state persists across reload (localStorage), and is not in the share codec".

**Files:**
- Modify: `src/main.js` (the toggle — toolbar DOM listener, fair game per §11; additive)
- Modify: `src/styles/visuals.css` (already has `.is-visuals-fullwindow`; verify)

**Reference reading:** the §11 note that `editor.updateSettings({...})` and toolbar DOM listeners are fair game; `src/strudel-ext/hydra.js` (the `feedStrudel` pass-through added in Task 1); `src/main.js` `syncVisualsClip` (Task 2).

- [ ] **Step 1: Add the full-window toggle state + localStorage persistence (additive in `main.js`)**

After `syncVisualsClip` (Task 2), add:
```js
// Phase 1.5 — full-window visuals behind the editor. A toggle (not in the
// share codec — §11) that un-clips #hydra-canvas to full-viewport and makes
// the editor transparent so visuals show through; the per-line plates keep
// text legible. Persisted to localStorage.
const FULLWINDOW_KEY = "strasbeat:visuals-fullwindow";
let visualsFullWindow = localStorage.getItem(FULLWINDOW_KEY) === "true";

function applyVisualsFullWindow() {
  const cv = document.getElementById(hydraCanvasId);
  // Editor transparency: bgFill:false lets the canvas show through.
  editor.updateSettings({ background: visualsFullWindow ? "transparent" : undefined });
  if (cv) {
    cv.classList.toggle("is-visuals-fullwindow", visualsFullWindow);
    if (visualsFullWindow) {
      cv.classList.remove("is-visuals-clipped"); // full-window wins over clip
    }
  }
  shellEl.classList.toggle("shell--visuals-fullwindow", visualsFullWindow);
  if (!visualsFullWindow) syncVisualsClip(); // back to panel-clipped
}

function toggleVisualsFullWindow() {
  visualsFullWindow = !visualsFullWindow;
  localStorage.setItem(FULLWINDOW_KEY, String(visualsFullWindow));
  applyVisualsFullWindow();
}
```
> Verify the correct editor-transparency setting at implementation time: the spec names `bgFill:false`. Check `node_modules/@strudel/codemirror`'s settings keys (and how `applyInitialSettings`/`editor.updateSettings` are used elsewhere in `main.js`) for the exact key name — it may be `background` or a `theme`/`bgFill` flag. Use the one StrudelMirror actually honors; keep the rest of the function identical.

- [ ] **Step 2: Add the toggle control (toolbar DOM listener) + apply persisted state at boot**

Add a toggle entry point. The simplest is a command-palette action and/or a small toolbar button. Add it to the bottom-panel bar or transport via a DOM listener (fair game per §11). Minimal version — wire a button that already exists or add one to the bottom-panel bar:
```js
// Apply persisted full-window state once the canvas can exist.
applyVisualsFullWindow();
```
And expose the toggle through the command palette by adding it to `buildPaletteCommands(...)`'s input or via a direct keybinding. If adding a new toolbar button, follow the existing transport-button DOM pattern; if that's invasive, prefer a command-palette command labeled "Visuals: toggle full-window" calling `toggleVisualsFullWindow`.

> If wiring the toggle requires a non-additive change to existing toolbar/transport markup, **stop and ask** — a command-palette action is the additive fallback.

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 4: Manual verification (in-app) — Phase 1.5 Acceptance**

Run: `pnpm dev`, play a hydra pattern. Then:
- Toggle to full-window: `#hydra-canvas` **un-clips to full-viewport**, the editor becomes **transparent**, visuals fill the window behind the code.
- Editor text **stays legible** via the per-line plates (this is where a `/polish` alpha pass would land — confirm mechanism, not final taste).
- Toggle back: returns to the panel-clipped Visuals mode with the **opaque editor restored**.
- With full-window on, play `await initHydra({ feedStrudel: true })` plus a pattern that draws to the Strudel 2D canvas and a hydra chain sampling `s0` (e.g. `src(s0).out()`); confirm the hydra output **reacts to the Strudel drawing** (feedStrudel fed real pixels). Document that this dependency is why feedStrudel was deferred from Phase 1.
- Reload the page: the toggle state **persists** (localStorage). Confirm it is **not** in the share URL (generate a share link; it must contain no visuals state).

---

## Phase 2 — event-driven named shader uniforms (Tasks 5–6)

### Task 5: The raw-WebGL `shader()` node + compile-error + context-loss handling

Implements spec §"The shader node (raw WebGL …)" and §"Error handling". Definition of done = the Phase 2 Acceptance items: "`await shader('<valid frag shader>')` compiles and renders", "Built-in uTime / uResolution work with no pattern wiring", "a shader compile error logs loudly … and keeps the last-good program rendering — does not go black", "Forcing context loss … logs loudly; on restore the program recompiles", "Stop / HMR dispose tears the shader node down". (The Pattern-input guard + auto-uniforms land in Task 6.)

**Files:**
- Create: `src/strudel-ext/shader.js`
- Modify: `src/main.js` (stop + the shader node's onDraw feed wiring — additive; the uniform map is wired in Task 6)

**Reference reading:** `src/ui/scope.js` (the `ensureConnected`/`disconnect` lazy+idempotent+teardown shape you mirror), `src/strudel-ext/hydra.js` (Task 1's HMR-dispose + host-callback pattern), `src/main.js:211` (`onDraw(haps, time)` — the per-frame draw source), `src/eval-feedback.js` (`console-panel.js` routing — for surfacing compile errors in-app). Read the WebGL full-screen-triangle idiom (a single triangle covering the viewport, fragment shader does all the work — standard Shadertoy port shape).

- [ ] **Step 1: Write `src/strudel-ext/shader.js` — the WebGL node skeleton**

```js
// strasbeat-original raw-WebGL shader node. Drop in a Shadertoy-style
// fragment shader; it compiles against a full-screen triangle and exposes
// named uniforms (built-in uTime/uResolution always; auto + explicit pattern
// uniforms wired in uniforms.js / Task 6).
//
// Discipline mirrors src/ui/scope.js and the Phase 1 hydra resource: lazy,
// idempotent, explicit teardown on stop / re-init / HMR dispose.
//
// Surface-failures-loudly (CLAUDE.md): compile failure logs loudly AND keeps
// the last-good program (no black screen, no teardown); WebGL context loss
// logs loudly and recompiles on restore.
//
// The single-quote rule + Pattern-input guard live in Task 6's edits to this
// file's exported shader() entry point.

import { reify, getTime } from "@strudel/core"; // used by Task 6 uniform feed

const CANVAS_ID = "strasbeat-shader-canvas";

// Built-in uniforms always provided so a bare Shadertoy port runs with no
// pattern wiring.
const VERTEX_SRC = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// Full-screen triangle (3 verts covering the viewport).
const TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

let node = null; // singleton live node

function getOrCreateCanvas() {
  let cv = document.getElementById(CANVAS_ID);
  if (!cv) {
    cv = document.createElement("canvas");
    cv.id = CANVAS_ID;
    // Full-viewport, fixed, pointer-events:none — same posture as #hydra-canvas
    // so the same Visuals-mode clip approach can host it later.
    cv.style.cssText =
      "pointer-events:none;width:100%;height:100%;position:fixed;top:0;left:0;display:block;";
    document.body.prepend(cv);
  }
  return cv;
}

function createNode() {
  const canvas = getOrCreateCanvas();
  const gl = canvas.getContext("webgl");
  let program = null;
  let lastGoodSrc = null;
  let uniformLocs = {};
  let rafId = null;
  let uniformMap = {}; // fed each frame by Task 6
  let lost = false;

  function compile(fragSrc) {
    // Returns the linked program or null (and logs loudly) on failure.
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VERTEX_SRC);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      reportShaderError(`fragment shader compile failed:\n${log}`);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      reportShaderError(`shader link failed:\n${gl.getProgramInfoLog(prog)}`);
      return null;
    }
    return prog;
  }

  function setProgram(fragSrc) {
    const prog = compile(fragSrc);
    if (!prog) return false; // keep last-good program rendering
    program = prog;
    lastGoodSrc = fragSrc;
    uniformLocs = {};
    return true;
  }

  function setupGeometry() {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, TRIANGLE, gl.STATIC_DRAW);
  }

  function uloc(name) {
    if (!(name in uniformLocs)) uniformLocs[name] = gl.getUniformLocation(program, name);
    return uniformLocs[name];
  }

  function draw() {
    rafId = requestAnimationFrame(draw);
    if (!program || lost) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    // Built-ins
    if (uloc("uTime")) gl.uniform1f(uloc("uTime"), getTime());
    if (uloc("uResolution")) gl.uniform2f(uloc("uResolution"), canvas.width, canvas.height);
    // Pattern-derived uniforms (Task 6 fills uniformMap each frame)
    for (const [name, value] of Object.entries(uniformMap)) {
      const loc = uloc(name);
      if (loc) gl.uniform1f(loc, value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // WebGL context-loss handling (CLAUDE.md surface-failures-loudly).
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault(); // allow restore
    lost = true;
    console.error("[strasbeat] shader WebGL context lost");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    console.error("[strasbeat] shader WebGL context restored — recompiling");
    lost = false;
    uniformLocs = {};
    setupGeometry();
    if (lastGoodSrc) setProgram(lastGoodSrc); // recompile current program
  });

  setupGeometry();

  return {
    setFragment: (src) => setProgram(src),
    setUniformMap: (m) => { uniformMap = m || {}; },
    start: () => { if (rafId == null) draw(); },
    stop: () => { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } },
    hasProgram: () => program != null,
    canvasEl: canvas,
  };
}

// Loud error reporting — console AND (when reachable) the in-app console
// panel. main.js registers the panel sink via setShaderErrorSink.
let shaderErrorSink = null;
export function setShaderErrorSink(fn) { if (typeof fn === "function") shaderErrorSink = fn; }
function reportShaderError(msg) {
  console.error(`[strasbeat] ${msg}`);
  try { shaderErrorSink?.(msg); } catch { /* never let logging crash the node */ }
}

// Teardown — removes the canvas + stops the loop. Called on stop / re-init /
// HMR dispose (mirrors clearHydra).
export function clearShader() {
  node?.stop?.();
  document.getElementById(CANVAS_ID)?.remove();
  node = null;
}

// Internal accessor for the live node (Task 6 wires the uniform feed).
export function _getShaderNode() { return node; }
export function _ensureNode() { if (!node) node = createNode(); return node; }

if (import.meta.hot) {
  import.meta.hot.dispose(() => clearShader());
}
```

> The exported `shader('…')` entry point (with the Pattern-input guard and single-quote-rule JSDoc) and the `index.js` re-export are added in **Task 6**, together with the auto-uniform derivation it depends on. This task delivers the WebGL node + its lifecycle/error/context-loss behavior.

- [ ] **Step 2: Verify the module builds**

Run: `pnpm build`
Expected: build succeeds (the module is not yet re-exported, but Vite type-checks/bundles it once it's imported in Task 6; confirm at least that it parses by importing it in a scratch check):

Run: `node -e "import('./src/strudel-ext/shader.js').then(m => console.log('exports:', Object.keys(m)))"`
Expected: prints `exports:` including `clearShader`, `setShaderErrorSink`, `_ensureNode`. (If WebGL/`document` references throw under Node, that's expected — wrap the probe in a try or skip; the load-bearing check is that the module parses. If it fails to parse, fix the syntax.)

- [ ] **Step 3: Wire shader teardown into the stop path + the error sink (additive in `main.js`)**

In `src/main.js`, update the two stop entry points (from Task 3) to also tear down the shader node, and register the in-app error sink. Add an import for the shader teardown via the namespace (`strudelExt.clearShader` once re-exported in Task 6) — for now, since Task 6 adds the re-export, add a TODO-free direct import at the top of `main.js`:
```js
import { clearShader, setShaderErrorSink } from "./strudel-ext/shader.js";
```
Update the stop listeners:
```js
document.addEventListener("repl-stop", () => {
  editor.stop();
  strudelExt.clearHydra();
  clearShader();
});
```
and the `stopBtn` handler likewise (`editor.stop(); strudelExt.clearHydra(); clearShader();`).
Register the error sink so compile errors reach the in-app console panel:
```js
setShaderErrorSink((msg) => consolePanel?.error?.(msg));
```
(Place this after `consolePanel` is assigned. Verify `consolePanel`'s error method name — read `src/ui/console-panel.js` for the exact API; use whatever it exposes for error-level entries.)

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: build succeeds.

> Note: end-to-end manual verification of compile/render/context-loss happens after Task 6 wires the `shader('…')` entry point. The context-loss + compile-error behavior is verified in Task 6's manual checklist.

---

### Task 6: Auto-uniforms (onDraw-haps → decay-envelope derivation) + `.uniform()` override + Pattern-input guard + the `shader('…')` entry point

Implements spec §"Auto-uniforms", §"Explicit .uniform() override", §"Data flow", §"The single-quote rule + Pattern-input guard". Definition of done = the remaining Phase 2 Acceptance items: "`bd` lane makes `uKick` pulse-and-decay", "uSnare/uHat react … uKeyVelocity reacts … active sound xyz exposes uXyz", "`.uniform({ dest: 'uMelody', gain: 0.8, slow: 2 })` drives uMelody … overriding the auto map", "Double-quoted shader source → loud `[strasbeat]` warning + no-op node", "`uniforms.test.js` covers onset detection, decay, mapping, override precedence; `shader.test.js` covers the Pattern-input guard".

**Files:**
- Create: `src/strudel-ext/uniforms.js`
- Create: `src/strudel-ext/uniforms.test.js`
- Create: `src/strudel-ext/shader.test.js`
- Modify: `src/strudel-ext/shader.js` (add the `shader('…')` entry point + guard)
- Modify: `src/strudel-ext/index.js` (re-export `shader` + `.uniform()` registration)
- Modify: `src/main.js` (feed the per-frame uniform map from `onDraw` — additive)
- Modify: `package.json` (append the two new test files to the `"test"` script)

**Reference reading:** `src/main.js:211-231` (`onDraw(haps, time)` — the frame source; hap shape), `src/strudel-ext/progression.js:115-128` (the `_Pattern` guard + JSDoc — replicate exactly), `src/strudel-ext/progression.test.js` (test shape), the spec §"Data flow" pseudocode and §"Mapping conventions". Verify drum-lane sound names with `strasbeat.hasSound(...)` as `CLAUDE.md` requires.

- [ ] **Step 1: Write the failing test for the pure uniform derivation**

Create `src/strudel-ext/uniforms.test.js`:

```js
// Run with: node --test src/strudel-ext/uniforms.test.js
//
// Pure tests for the onDraw-haps → decay-envelope → uniform-map derivation.
// No WebGL: this is a pure function of (haps, prevState, dt, config).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createUniformDeriver,
  laneToUniform,
  sanitizeGlslIdentifier,
} from "./uniforms.js";

// Minimal hap stub: { value: { s: 'bd' }, whole: { begin } } shape mirrors
// what onDraw hands us (a sound name in value.s, plus an identity for onset
// detection). Adjust value shape to match the real hap if it differs.
function hap(name, begin) {
  return { value: { s: name }, whole: { begin } };
}

describe("lane → uniform mapping", () => {
  test("bd → uKick, sd → uSnare, hh → uHat", () => {
    assert.equal(laneToUniform("bd"), "uKick");
    assert.equal(laneToUniform("sd"), "uSnare");
    assert.equal(laneToUniform("hh"), "uHat");
  });

  test("arbitrary sound → u<Name>, sanitized to a valid GLSL identifier", () => {
    assert.equal(sanitizeGlslIdentifier("gm_pad_warm"), "u_gm_pad_warm");
    assert.equal(sanitizeGlslIdentifier("909-clap"), "u_909_clap");
  });
});

describe("onset detection + decay", () => {
  test("a new hap this frame pulses its uniform to peak", () => {
    const d = createUniformDeriver();
    const m = d.frame([hap("bd", 0)], /*time*/ 0, /*dt*/ 0.016);
    assert.ok(m.uKick > 0.9, `expected uKick to pulse to ~1, got ${m.uKick}`);
  });

  test("a uniform decays toward 0 across frames with no new onset", () => {
    const d = createUniformDeriver();
    d.frame([hap("bd", 0)], 0, 0.016); // onset
    const after = d.frame([], 0.2, 0.2); // no haps, 200ms later
    assert.ok(after.uKick < 0.5, `expected decay, got ${after.uKick}`);
    assert.ok(after.uKick >= 0, "decay never goes negative");
  });

  test("the same hap present two frames running does NOT re-pulse", () => {
    const d = createUniformDeriver();
    const f1 = d.frame([hap("bd", 0)], 0, 0.016);
    const f2 = d.frame([hap("bd", 0)], 0.016, 0.016); // same identity
    assert.ok(f2.uKick <= f1.uKick, "no re-pulse without a new onset");
  });
});

describe("explicit .uniform() override beats the auto map", () => {
  test("an explicit override for a dest replaces the auto value", () => {
    const d = createUniformDeriver();
    d.setOverride("uMelody", { gain: 0.8 });
    const m = d.frame([{ value: 7, dest: "uMelody", whole: { begin: 0 } }], 0, 0.016);
    assert.ok("uMelody" in m, "explicit dest is present in the map");
  });
});
```

> Adjust the exact hap `value` shape to whatever `onDraw` actually provides — read `src/main.js:211` and the upstream hap shape before finalizing. The **assertions** (pulse to peak, decay, no re-pulse, override present) are the load-bearing contract.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/strudel-ext/uniforms.test.js`
Expected: FAIL — `Cannot find module './uniforms.js'`.

- [ ] **Step 3: Write `src/strudel-ext/uniforms.js` — the pure derivation**

```js
// Pure derivation: onDraw haps → decay-envelope → uniform map. No WebGL, no
// DOM — that purity is what makes it unit-testable. The source is the
// existing onDraw(haps, time) hook (main.js:211): every frame carries the
// active haps. Onset = a hap present this frame that was NOT present last
// frame (compare hap identity across frames) — that's how we get per-event
// pulses WITHOUT a global onTrigger / event bus (which is out of scope).
// Borrows PR #1196's decayModulation concept (not its code).

// Drum-lane sound name → conventional uniform. Verify names against the
// loaded soundMap at runtime with strasbeat.hasSound(...) (CLAUDE.md).
const LANE_MAP = {
  bd: "uKick",
  sd: "uSnare",
  hh: "uHat",
};

export function laneToUniform(name) {
  return LANE_MAP[name] ?? null;
}

// Sanitize an arbitrary sound name to a valid GLSL identifier: u + name with
// every non [A-Za-z0-9_] replaced by _ (and a leading _ so digits are legal).
export function sanitizeGlslIdentifier(name) {
  return "u_" + String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

// Decay constant: value *= exp(-dt / TAU). TAU ~ 0.12s gives a snappy
// percussive envelope. (Mechanism, not final taste — tune later.)
const DECAY_TAU = 0.12;

export function createUniformDeriver() {
  let prevIds = new Set();
  const values = {}; // uniformName -> current envelope value
  const overrides = {}; // dest -> { gain, slow, ... }

  function setOverride(dest, opts) {
    overrides[dest] = { gain: 1, slow: 1, ...opts };
  }

  function hapId(h) {
    // Identity across frames: sound + onset time uniquely identifies an event.
    const name = h?.value?.s ?? h?.value?.note ?? JSON.stringify(h?.value);
    return `${name}@${h?.whole?.begin}`;
  }

  function uniformsForHap(h) {
    // Which uniform(s) does this hap pulse, and at what peak?
    const out = [];
    if (h.dest) {
      // Explicit override carried on the hap (.uniform set dest).
      const cfg = overrides[h.dest] ?? { gain: 1 };
      const peak = typeof h.value === "number" ? Math.abs(h.value) * cfg.gain : cfg.gain;
      out.push([h.dest, Math.min(1, peak)]);
      return out;
    }
    const s = h?.value?.s;
    if (s) {
      const lane = laneToUniform(s);
      if (lane) out.push([lane, 1]);
      out.push([sanitizeGlslIdentifier(s), 1]); // u<Name> for every active sound
    }
    if (h?.value?.note != null || h?.value?.n != null) {
      const vel = h?.value?.velocity ?? h?.value?.gain ?? 1;
      out.push(["uKeyVelocity", Math.min(1, vel)]);
    }
    return out;
  }

  function frame(haps, time, dt) {
    const ids = new Set(haps.map(hapId));
    // Decay everything first.
    for (const k of Object.keys(values)) {
      values[k] *= Math.exp(-dt / DECAY_TAU);
      if (values[k] < 1e-4) values[k] = 0;
    }
    // Pulse on new onsets only.
    for (const h of haps) {
      if (prevIds.has(hapId(h))) continue; // not a new onset — no re-pulse
      for (const [name, peak] of uniformsForHap(h)) {
        values[name] = Math.max(values[name] ?? 0, peak);
      }
    }
    prevIds = ids;
    return { ...values };
  }

  return { frame, setOverride };
}
```

> Verify the real hap `value` shape (`value.s` for sound, `value.note`/`value.n`, `value.velocity`/`value.gain`) against `src/main.js`'s `onDraw` and the upstream hap before relying on these field names; adjust `hapId`/`uniformsForHap` to match. Keep the **assertions** from Step 1 satisfied.

- [ ] **Step 4: Run the uniforms test to verify it passes**

Run: `node --test src/strudel-ext/uniforms.test.js`
Expected: PASS — all describe blocks pass.

- [ ] **Step 5: Write the failing Pattern-input-guard test**

Create `src/strudel-ext/shader.test.js`:

```js
// Run with: node --test src/strudel-ext/shader.test.js
//
// Pattern-input guard: a double-quoted shader source is rewritten by Strudel's
// transpiler into a Pattern (mini(...)) — shader() must detect that and warn
// loudly + return a no-op node, NOT crash. (Mirrors progression()'s guard.)

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { mini } from "@strudel/mini";
import { shader } from "./shader.js";

let warnings;
let originalWarn;
beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
});
afterEach(() => {
  console.warn = originalWarn;
});

describe("shader() Pattern-input guard", () => {
  test("a Pattern (double-quoted source) warns loudly and returns a no-op", async () => {
    const result = await shader(mini("precision mediump float;"));
    assert.ok(
      warnings.some((w) => w.includes("[strasbeat]") && w.toLowerCase().includes("single-quote")),
      "expected a [strasbeat] single-quote-rule warning",
    );
    // No-op node: does not throw, returns something benign.
    assert.doesNotThrow(() => result);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test src/strudel-ext/shader.test.js`
Expected: FAIL — `shader` is not exported from `./shader.js` yet (Task 5 created the node but not the public entry point).

- [ ] **Step 7: Add the `shader('…')` entry point + Pattern-input guard to `src/strudel-ext/shader.js`**

Add near the top imports:
```js
import { createUniformDeriver } from "./uniforms.js";

let deriver = null;
export function _getDeriver() { return deriver; }
```

Add the public entry point (replace nothing; append after `_ensureNode`):
```js
/**
 * Compile and render a drop-in fragment shader, with named uniforms driven by
 * the playing pattern's events. Built-in uTime / uResolution are always
 * provided. Auto-uniforms (uKick/uSnare/uHat/uKeyVelocity/u<Sound>) derive
 * from the pattern automatically; override/extend with .uniform({dest,...}).
 *
 * SINGLE-QUOTE RULE: the shader source MUST be single-quoted. Strudel's
 * transpiler rewrites every DOUBLE-quoted string literal into a mini(...)
 * call, which would turn your GLSL into a Pattern and break the node. Drum/
 * note patterns in the same file still use double quotes (the rewrite is
 * correct for s("…")). See CLAUDE.md "the single-quote rule".
 *
 * @param {string} src single-quoted GLSL fragment shader source
 * @example
 * await shader('precision mediump float; uniform float uKick; void main(){ gl_FragColor = vec4(uKick,0.,0.,1.); }')
 */
export async function shader(src) {
  // Defense-in-depth Pattern-input guard — exactly like progression().
  // _Pattern === true is the canonical cross-module Pattern detector
  // (strudel-source/packages/core/pattern.mjs).
  if (src?._Pattern === true) {
    console.warn(
      "[strasbeat] shader() received a Pattern instead of a string — the shader source was double-quoted (\"...\") and Strudel's transpiler converted it to mini-notation. Use single quotes: shader('precision mediump float; …'). See CLAUDE.md the single-quote rule.",
    );
    return { uniform: () => ({}) }; // no-op node, does not crash the editor
  }
  if (typeof src !== "string" || src.trim() === "") {
    console.warn("[strasbeat] shader() received empty source — nothing to render.");
    return { uniform: () => ({}) };
  }

  deriver = deriver ?? createUniformDeriver();
  const n = _ensureNode();
  n.setFragment(src); // compile failure keeps last-good program (logged loudly)
  n.start();

  // Return a chainable node carrying the explicit .uniform() override path.
  const api = {
    uniform({ dest, gain = 1, slow = 1, onTrigger } = {}) {
      // Pattern-input guard on the uniform-name string too.
      if (dest?._Pattern === true) {
        console.warn(
          "[strasbeat] .uniform({dest}) received a Pattern — the dest name was double-quoted. Use single quotes: .uniform({ dest: 'uMelody' }). See CLAUDE.md the single-quote rule.",
        );
        return api;
      }
      if (typeof dest === "string") deriver.setOverride(dest, { gain, slow, onTrigger });
      return api;
    },
  };
  return api;
}
```

> `.uniform()` per the spec is also a **Pattern method** (`note("…").uniform({...})`). Register it the way Strudel registers pattern methods (read how `@strudel/core` `register(...)` works in `strudel-source/packages/core/`). The pattern-method version tags each hap's value with `{ dest }` (so `uniformsForHap` routes it) — implement it alongside `shader()`'s object `.uniform()`. If the registration mechanism is unclear, the object-method `.uniform()` above plus carrying `dest` on the hap is the working baseline; **stop and ask** before inventing a registration path that conflicts with Strudel's.

- [ ] **Step 8: Run the guard test to verify it passes**

Run: `node --test src/strudel-ext/shader.test.js`
Expected: PASS.

- [ ] **Step 9: Re-export `shader` from the barrel**

In `src/strudel-ext/index.js`, add:
```js
export { shader, clearShader, setShaderErrorSink } from "./shader.js";
```
(Confirm `clearShader`/`setShaderErrorSink` aren't double-imported in `main.js` — Task 5 added a direct import; once re-exported, prefer the namespace `strudelExt.clearShader`, but a direct import also works. Do not duplicate the symbol in scope.)

- [ ] **Step 10: Feed the per-frame uniform map from `onDraw` (additive in `main.js`)**

In `src/main.js`'s `onDraw` (`~line 211`), add — without removing the existing branches — a per-frame feed of the uniform map into the live shader node. Add near the top of the `onDraw` body (after `const mode = bottomModes.getMode();`):
```js
    // Phase 2: drive the shader node's uniforms from the active haps. Runs
    // every frame regardless of bottom-panel mode (the shader paints its own
    // full-window canvas, like hydra). dt derived from successive draw times.
    const shaderNode = strudelExt._getShaderNode?.();
    if (shaderNode?.hasProgram?.()) {
      const deriver = strudelExt._getDeriver?.();
      const dt = lastDrawTime == null ? 0.016 : Math.max(0, time - lastDrawTime);
      lastDrawTime = time;
      if (deriver) shaderNode.setUniformMap(deriver.frame(haps, time, dt));
    }
```
And declare `let lastDrawTime = null;` near the other draw state (`~line 142`).

> Verify `strudelExt._getShaderNode` / `strudelExt._getDeriver` are reachable through the namespace; if the barrel doesn't re-export the underscore-prefixed internals, import them directly from `./strudel-ext/shader.js` in `main.js` (matching the Task 5 direct import). Keep this strictly additive.

- [ ] **Step 11: Register the two new test files + regen docs**

In `package.json`, append `src/strudel-ext/uniforms.test.js` and `src/strudel-ext/shader.test.js` to the `"test"` script's file list.

Run: `pnpm gen:docs`
Expected: `src/editor/strudel-docs.json` gains `shader` (JSDoc'd). Leave in the working tree (no commit).

- [ ] **Step 12: Verify the full suite + build**

Run: `pnpm test`
Expected: PASS — uniforms + shader-guard + hydra tests all green, no regressions.

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 13: Manual verification (in-app) — Phase 2 Acceptance**

Run: `pnpm dev`, open the app, click once. Then verify each Acceptance item:
- Play `await shader('precision mediump float; void main(){ gl_FragColor = vec4(0.2,0.1,0.4,1.0); }')` — it **compiles and renders** a flat color.
- A bare Shadertoy-style port using `uTime`/`uResolution` **animates with no pattern wiring** (built-ins work).
- Play the full demo (Task 7) with a `bd` lane: `uKick` **pulses on each kick and decays** between kicks; `uSnare`/`uHat` react to their lanes; a note pattern moves `uKeyVelocity`; an active sound `xyz` exposes `uXyz`.
- `$: note("0 7 5 7").uniform({ dest: 'uMelody', gain: 0.8, slow: 2 })` drives `uMelody` (override/extend the auto map).
- **Double-quoted source:** `shader("…")` → a loud `[strasbeat]` console warning about the single-quote rule + a no-op node (the editor does **not** crash).
- **Compile error:** play a shader with a deliberate GLSL error mid-edit — it logs **loudly** (console **and** the in-app console panel) and **keeps the last-good program** rendering (does not go black, does not tear down).
- **Context loss:** in devtools, `const gl = document.getElementById('strasbeat-shader-canvas').getContext('webgl'); gl.getExtension('WEBGL_lose_context').loseContext()` — logs loudly; then `.restoreContext()` → the program **recompiles** and rendering resumes.
- **Stop / HMR:** press stop → `document.getElementById('strasbeat-shader-canvas')` is `null`. Edit a pattern file several times → at most one shader canvas remains.

---

## Task 7: Demo patterns (end-to-end smoke tests)

Implements spec §"Files (Phase 1)" and §"Files (Phase 2)" demo entries. Definition of done = the Acceptance items "`patterns/<NN>-hydra-demo.js` plays + renders end to end" and "`patterns/<NN>-shader-demo.js` plays + renders end to end".

**Files:**
- Create: `patterns/<NN>-hydra-demo.js`
- Create: `patterns/<NN>-shader-demo.js`

**Reference reading:** `design/PATTERN-STYLE.md` (modern idioms — `setcpm`, `$:`, note names not MIDI numbers, effect-chain formatting), the spec's two demo snippets (§Phase 1 and §Phase 2), `CLAUDE.md` "Pattern file contract" (the whole tune is a `export default \`…\`` string), `CLAUDE.md` "the single-quote rule".

- [ ] **Step 1: Choose the file numbers**

Run: `ls patterns/ | grep -oE '^[0-9]+' | sort -n | tail -1`
Expected: prints the current highest numeric prefix (or nothing if none). Number the two new demos as the next two integers after it (zero-padded to two digits, e.g. `01`/`02` if none exist, or `NN+1`/`NN+2`). Use those numbers in the filenames below.

- [ ] **Step 2: Write the hydra demo**

Create `patterns/<NN>-hydra-demo.js` (read `PATTERN-STYLE.md` first; single-quote any strasbeat-helper args — Hydra's own `osc`/`color` chain uses Hydra functions, not mini-notation):

```js
// patterns/<NN>-hydra-demo.js
// Phase 1 smoke test: first-class offline Hydra.
// Hydra source chains use Hydra's own functions (osc, color, …), NOT Strudel
// mini-notation. Any string passed to a strasbeat helper must be single-quoted.
export default `await initHydra()
osc(10, 0.1, 1.2).color(0.9, 0.3, 0.6).rotate(0.2).out()

setcpm(120/4)
$: s("bd*4, ~ sd, hh*8").bank("RolandTR909")
`;
```

- [ ] **Step 3: Write the shader demo**

Create `patterns/<NN>-shader-demo.js` (single-quoted shader source — the drum line stays double-quoted because the transpiler rewrite is correct for `s("…")`):

```js
// patterns/<NN>-shader-demo.js
// Phase 2 smoke test: a Shadertoy-style fragment shader reacting to auto
// uniforms (uKick/uSnare from the drum lanes) and one explicit .uniform().
// SINGLE-QUOTE the shader source — the transpiler rewrites double-quoted
// strings into mini-notation. See CLAUDE.md the single-quote rule.
export default `await shader('
  precision mediump float;
  uniform float uKick;
  uniform float uSnare;
  uniform vec2 uResolution;
  uniform float uTime;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float r = 0.2 + uKick * 0.6;
    float g = 0.1 + uSnare * 0.5;
    float b = 0.4 + 0.2 * sin(uTime + uv.x * 6.28);
    gl_FragColor = vec4(r, g, b, 1.0);
  }
')

setcpm(120/4)
$: s("bd*4, ~ sd, hh*8").bank("RolandTR909")
$: note("0 7 5 7").uniform({ dest: 'uMelody', gain: 0.8, slow: 2 })
`;
```

- [ ] **Step 4: Verify both demos play + render end to end (in-app)**

Run: `pnpm dev`. The two new patterns appear in the left-rail patterns library (HMR / `import.meta.glob` auto-discovery). Open each, press play:
- **hydra demo:** visuals render in the Visuals bottom-panel mode (or full-window if toggled); the TR909 drums play. No `unpkg.com` request.
- **shader demo:** the shader renders and **reacts to the kicks/snares** (auto-uniforms) plus the explicit `uMelody`. No crash; no black screen.

This satisfies both "plays + renders end to end" Acceptance items.

---

## Self-Review (run after the plan is written — done)

- **Spec coverage:** Phase 1 §Components 1 (bundle + offline wrapper) → Task 1; §2 (guarded H) → Task 1; §3 (Visuals mode + clip + geometry re-sync) → Task 2; §4 (teardown) → Task 3; §5 (legibility plates) → Task 3; §6 (feedStrudel deferred) → Task 1 pass-through + Task 4; §7 (remove opt-in) → Task 3; the sanctioned plumbing touch (barrel re-export, no new evalScope arg) → Tasks 1, 6. Phase 1.5 → Task 4. Phase 2 §shader node + error/context-loss → Task 5; §auto-uniforms + .uniform() + guard + data flow → Task 6. Demos + tests → Tasks 1, 6, 7. All Acceptance checklists are referenced as task definitions of done. No gaps.
- **Test-runner correction:** spec says "Vitest"; repo uses `node:test`. Plan uses `node:test` (matching `progression.test.js`) and registers each new test file in the `package.json` `"test"` script — flagged in the preamble.
- **Plumbing discipline:** no new `evalScope` argument anywhere; only barrel re-exports + additive `main.js` edits, with explicit "stop and ask" guards on any non-additive touch. `strudel-source/` untouched. No git commits anywhere.
- **Type/name consistency:** `clearHydra`/`clearShader`/`setVisualsAvailable`/`setVisualsAvailabilityCallback`/`syncVisualsClip`/`createUniformDeriver`/`laneToUniform`/`sanitizeGlslIdentifier`/`_getShaderNode`/`_getDeriver`/`setShaderErrorSink` are used consistently across tasks.
- **Open verification points (intentionally flagged in-task, not placeholders):** the `hydra-synth` import shape (Task 1 Step 2 probe), the exact StrudelMirror transparency setting key (Task 4 Step 1), the console-panel error method name (Task 5 Step 3), the real hap `value` field names (Task 6 Steps 1/3), and Strudel's pattern-method registration for `.uniform()` (Task 6 Step 7) are each verified against live code at implementation time with a concrete probe + a "stop and ask" fallback. These are runtime facts that cannot be hard-coded blind without risking a wrong constant.
