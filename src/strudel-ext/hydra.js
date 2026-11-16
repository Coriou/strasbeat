// strasbeat's offline-first Hydra wrapper.
//
// Mirrors strudel-source/packages/hydra/hydra.mjs's canvas + option
// semantics, with three strasbeat changes:
//   1. Offline source — bundled `hydra-synth`, never `unpkg.com`. (CLAUDE.md
//      offline-first rule.) hydra-synth is lazy-imported inside initHydra()
//      rather than at module load time: its mouse.js module references
//      `window` at evaluation, which fails in Node (test environment) and
//      would crash the entire module on load. The lazy import defers that
//      until initHydra() is actually called in a browser context. Vite
//      still bundles the import statically (it resolves the specifier string).
//   2. Guarded H() — never throws on an empty-hap query (it would otherwise
//      crash the whole render loop). H() only uses @strudel/core, so it is
//      importable and testable in Node with no browser globals. (CLAUDE.md
//      surface-failures-loudly.)
//   3. Host lifecycle — existence, render gating and canvas placement are
//      shared with the shader layer through visuals-host.js.
//
// Reaches pattern scope via the strudelExt namespace arg already passed to
// evalScope() at boot.js:51 — see index.js. No new evalScope arg.
//
// Note on hydra-synth export shape (verified at install time):
//   `node_modules/hydra-synth/src/hydra-synth.js` exports:
//     `export default HydraRenderer`
//   So the dynamic import yields `{ default: HydraRenderer }`.
//   The CDN build attaches a global `Hydra`; the npm build does NOT.
//   We construct `new Hydra({...})` from this import — never from globalThis.

import { getDrawContext } from "@strudel/draw";
import { reify, getTime } from "@strudel/core";
import {
  createVisualCanvas,
  markVisualRequested,
  registerVisualLayer,
  visualsChanged,
} from "./visuals-host.js";

let hydra = null;
let lastOptionsKey = null;
let livePixelRatio = 1;

// ─── Context-loss handlers (registered per live canvas) ──────────────────
// Tracked at module scope so clearHydra() can remove them with the canvas.
let ctxLostHandler = null;
let ctxRestoredHandler = null;
function installContextLossHandlers(canvas) {
  if (!canvas?.addEventListener) return;
  ctxLostHandler = (e) => {
    // preventDefault so the browser will attempt a `restored` event instead of
    // permanently killing the context.
    e.preventDefault?.();
    console.error(
      "[strasbeat] hydra WebGL context LOST (often the last event before a " +
        "GPU-OOM tab crash). Visuals will try to restore. canvas=" +
        `${canvas.width}x${canvas.height}`,
    );
  };
  ctxRestoredHandler = () => {
    console.error(
      "[strasbeat] hydra WebGL context RESTORED. Re-evaluate (Ctrl+Enter) to " +
        "rebuild the visual chain if it doesn't resume.",
    );
  };
  canvas.addEventListener("webglcontextlost", ctxLostHandler, false);
  canvas.addEventListener("webglcontextrestored", ctxRestoredHandler, false);
}

function removeContextLossHandlers() {
  if (canvasEl?.removeEventListener) {
    if (ctxLostHandler)
      canvasEl.removeEventListener("webglcontextlost", ctxLostHandler);
    if (ctxRestoredHandler)
      canvasEl.removeEventListener("webglcontextrestored", ctxRestoredHandler);
  }
  ctxLostHandler = null;
  ctxRestoredHandler = null;
}

// ─── Render loop (owned, stoppable) ──────────────────────────────────────
// hydra-synth's own autoLoop starts a raf-loop whose handle it DISCARDS
// (node_modules/hydra-synth/src/hydra-synth.js:124) — so nothing can ever
// stop it, and hush() doesn't either. That orphaned loop, plus the regl
// WebGL context hush() never frees, is the leak that made the feature slow +
// crash-prone (every stop→play leaked one of each; browsers cap live WebGL
// contexts at ~16). We instead construct Hydra with autoLoop:false and drive
// hydra.tick() from THIS loop, whose id we keep, so clearHydra() can stop it
// deterministically and the host can pause it when the canvas is hidden or the
// scheduler is idle — zero idle GPU cost.
let rafId = null;
let loopOnce = false; // the queued frame is a single still frame, not a loop
let lastTickTs = null;
let firstTickDone = false; // per Hydra instance
let canvasEl = null; // the live #hydra-canvas, kept so teardown removes THIS one

// Injection seam (tests only). Production uses the real dynamic import +
// createVisualCanvas + requestAnimationFrame. _setHydraTestHarness lets the
// teardown CONTRACT be verified headlessly (no real WebGL in Node).
let harness = null;
// Guarded so a stray call in a non-browser context (or a teardown race before
// the DOM exists) is a no-op rather than a ReferenceError.
const realRaf = (cb) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : 0;
const realCaf = (id) => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
};
function _raf(cb) {
  return (harness?.raf ?? realRaf)(cb);
}
function _caf(id) {
  return (harness?.caf ?? realCaf)(id);
}

/** @noAutocomplete */
export function _setHydraTestHarness(h) {
  harness = h;
}
/** @noAutocomplete */
export function _resetHydraTestHarness() {
  // Stop the loop while the harness is STILL set, so the cancel routes to the
  // fake caf (Node has no cancelAnimationFrame). Only then drop the harness.
  stopLoop();
  harness = null;
  hydra = null;
  canvasEl = null;
  lastOptionsKey = null;
  lastTickTs = null;
  initPromise = null;
  initKey = null;
  clobberedGlobals = null;
  lifeGen++;
}

// once=true renders a single frame (the reduced-motion still) and stops.
function startLoop(once = false) {
  if (!hydra) return;
  if (rafId != null) {
    if (loopOnce === once) return; // already queued in this shape
    stopLoop();
  }
  loopOnce = once;
  lastTickTs = null;
  const frame = (ts) => {
    // Re-read each frame so a stop (rafId nulled) or pause halts cleanly even
    // if a frame was already queued.
    if (rafId == null || !hydra) return;
    rafId = once ? null : _raf(frame);
    const dt = lastTickTs == null ? 16 : Math.max(0, ts - lastTickTs);
    lastTickTs = ts;
    // OBSERVABILITY: log the FIRST tick of each instance with the live backing-
    // store dims + dpr. The first tick is when hydra-synth first allocates its
    // FBOs and does the first GPU draw — i.e. the moment a GPU-OOM tab-crash
    // would strike. If the tab dies, this is the last line the user sees, and it
    // tells us EXACTLY how big the canvas was and the dpr → pinpoints the cause.
    if (!firstTickDone) {
      firstTickDone = true;
      const w = canvasEl?.width;
      const h = canvasEl?.height;
      // Only log when we have real backing-store dims (skips the test harness's
      // fake canvas, which has none).
      if (Number.isFinite(w) && Number.isFinite(h)) {
        console.info(
          `[strasbeat] hydra first render — canvas=${w}x${h} ` +
            `dpr=${typeof window !== "undefined" ? window.devicePixelRatio : "?"} ` +
            `(if the tab crashes HERE, the GPU ran out of memory — report this line)`,
        );
      }
    }
    // hydra.tick already wraps its body in try/catch (hydra-synth.js:475); we
    // guard too. Crucially: on a throw we STOP the loop (don't respin a throwing
    // render every frame) and log LOUDLY. A render error becomes a console error
    // + a stopped loop, never a silently-spinning dead loop. (A GPU OOM that
    // kills the whole tab can't be caught here — that's what the resolution cap
    // + the first-render log above are for.)
    try {
      hydra.tick(dt);
    } catch (err) {
      console.error(
        "[strasbeat] hydra render threw — stopping the visuals loop (visuals " +
          "disabled until re-evaluated). This did NOT crash the page:",
        err,
      );
      stopLoop();
    }
  };
  rafId = _raf(frame);
}

function stopLoop() {
  if (rafId != null) {
    _caf(rafId);
    rafId = null;
  }
  lastTickTs = null;
}

// mode: "live" | "still" | "off" — decided by visuals-host.js.
function setRenderMode(mode) {
  if (mode === "live") startLoop();
  else if (mode === "still") startLoop(true);
  else stopLoop();
}

registerVisualLayer("hydra", {
  isLive: () => hydra !== null,
  clear: () => clearHydra(),
  setRenderMode,
  getCanvas: () => canvasEl,
  pixelRatio: () => livePixelRatio,
  // hydra.setResolution sets canvas.width/height and resizes every FBO.
  resize: ({ width, height }) => hydra?.setResolution?.(width, height),
});

// ─── Globals hydra-synth overwrites ──────────────────────────────────────
// With makeGlobal (the default, and what puts osc/out/solid/… in pattern
// scope) hydra-synth writes every synth property and generator onto window
// (eval-sandbox.js:17, hydra-synth.js:403), then rewrites window.time on every
// tick. Several of those names are Strudel's own — `time`, `noise`, `src`,
// `hush`, `speed`, `shape` — so without a restore, a pattern evaluated after a
// visual ran would silently call Hydra's versions against a destroyed context.
// We snapshot the writable globals before construction, diff after, and put
// every overwritten value back (and delete every added name) on teardown.
let clobberedGlobals = null; // Map<name, { had: boolean, value: any }>

function snapshotGlobals() {
  const snap = new Map();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const d = Object.getOwnPropertyDescriptor(globalThis, name);
    if (d && "value" in d) snap.set(name, d.value);
  }
  return snap;
}

function recordClobberedGlobals(before) {
  clobberedGlobals = new Map();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const d = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!d || !("value" in d)) continue;
    if (!before.has(name)) clobberedGlobals.set(name, { had: false });
    else if (before.get(name) !== d.value)
      clobberedGlobals.set(name, { had: true, value: before.get(name) });
  }
}

function restoreClobberedGlobals() {
  if (!clobberedGlobals) return;
  for (const [name, prev] of clobberedGlobals) {
    try {
      if (prev.had) globalThis[name] = prev.value;
      else delete globalThis[name];
    } catch {
      /* a non-configurable global can't be removed — leave it */
    }
  }
  clobberedGlobals = null;
}

/**
 * Provide Node's `global` on the browser global object before hydra-synth runs.
 *
 * Why this is needed (offline-first fallout): strasbeat bundles `hydra-synth`
 * locally instead of loading https://unpkg.com/hydra-synth (CLAUDE.md
 * offline-first rule). The unpkg build is browserified, and browserify injects
 * a bundle-wide `global` shim. Vite's esbuild pre-bundle of the *raw* sources
 * does not. hydra-synth's dep chain reaches `right-now/browser.js`, whose
 * top-level `module.exports = global.performance && global.performance.now …`
 * references a bare `global` unconditionally — so in the browser the dev
 * pre-bundle throws `ReferenceError: global is not defined` the instant
 * hydra-synth is imported. (The npm dep chain is hydra-synth → raf-loop →
 * right-now/browser.js.) Pointing `global` at `globalThis` lets that
 * `global.performance` resolve to the standard `globalThis.performance`.
 *
 * Only `global` is shimmed — `process`/`Buffer` appear elsewhere in the bundle
 * but are all `typeof`-guarded or string literals (verified), so they don't
 * need a shim. Guarded so it is a no-op in Node (where `global` already exists)
 * and idempotent across re-evaluations.
 *
 * @noAutocomplete
 */
export function installNodeGlobalShim() {
  if (typeof globalThis.global === "undefined") globalThis.global = globalThis;
}

// initHydra() is async (it awaits the hydra-synth chunk), so two evaluates can
// overlap on a slow first load and a teardown can land mid-import. Concurrent
// callers share the in-flight promise; clearHydra() bumps lifeGen so a build
// that was superseded while it awaited bails instead of constructing a second
// instance or starting after a stop.
let initPromise = null;
let initKey = null;
let lifeGen = 0;

/**
 * Initialize Hydra visuals into the full-viewport `#hydra-canvas`.
 * Runs fully offline (bundled hydra-synth — never the unpkg CDN). Returns the
 * hydra instance (preserves the upstream/#1784 contract). Re-init with changed
 * options removes the old `#hydra-canvas` first (upstream behavior).
 *
 * Hydra source chains use Hydra's own functions (osc, noise, …), NOT Strudel
 * mini-notation. Any string passed to a strasbeat helper must be single-quoted
 * (becomes load-bearing for shader('…') in Phase 2). See CLAUDE.md.
 *
 * @param {object} options detectAudio (default false — passed to the Hydra constructor to enable mic-reactive sources), contextType (default 'webgl'), pixelRatio (default 1), pixelated (default true), feedStrudel (deferred — only coherent with the full-window increment).
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

  const optionsKey = JSON.stringify({
    contextType,
    pixelRatio,
    pixelated,
    feedStrudel,
  });

  // Tell the host this evaluate still wants Hydra, so the post-evaluate sweep
  // keeps it.
  markVisualRequested("hydra");

  // Re-init with changed options: tear down the old canvas first (this also
  // abandons an in-flight build with the old options).
  if (
    (hydra && optionsKey !== lastOptionsKey) ||
    (initPromise && optionsKey !== initKey)
  )
    clearHydra();
  // Already initialized with these options — reuse it. Patterns put
  // `await initHydra()` at the top and re-evaluate on every Ctrl+Enter
  // without stopping; constructing a second Hydra here would orphan the
  // previous instance (its render loop + WebGL context keep running, never
  // hushed). Upstream gates construction on `#hydra-canvas` not already
  // existing for the same reason — re-eval just re-defines the visual chain
  // on the existing instance. (strudel-source/packages/hydra/hydra.mjs:14)
  if (hydra) return hydra;
  if (initPromise) return initPromise;

  const building = buildHydra({
    feedStrudel,
    contextType,
    pixelRatio,
    pixelated,
    rest,
    optionsKey,
    gen: lifeGen,
  }).finally(() => {
    if (initPromise === building) {
      initPromise = null;
      initKey = null;
    }
  });
  initPromise = building;
  initKey = optionsKey;
  return building;
}

async function buildHydra({
  feedStrudel,
  contextType,
  pixelRatio,
  pixelated,
  rest,
  optionsKey,
  gen,
}) {
  // hydra-synth's offline npm bundle references Node's `global` (via
  // right-now/browser.js) at module-eval time; without this it throws
  // `global is not defined` in the browser the moment it's imported. Must run
  // BEFORE the import below. See installNodeGlobalShim() for the full why.
  installNodeGlobalShim();

  if (harness) {
    // Test path: skip the real hydra-synth import + DOM/WebGL entirely. The
    // harness returns a fake { hydra, canvas } so the lifecycle (loop start,
    // teardown) can be exercised headlessly. makeHydra may be async to stand
    // in for the chunk load.
    await harness.beforeMake?.();
    if (gen !== lifeGen) return null;
    const before = snapshotGlobals();
    const made = harness.makeHydra();
    recordClobberedGlobals(before);
    hydra = made.hydra;
    canvasEl = made.canvas ?? null;
    lastOptionsKey = optionsKey;
    visualsChanged();
    return hydra;
  }

  // KILL-SWITCH: a localStorage flag to disable visuals entirely. Set
  // `localStorage['strasbeat:visuals-disabled'] = 'true'` (then re-play) if a
  // machine reliably crashes on visuals — the rest of the app keeps working and
  // initHydra() becomes an explicit, logged no-op instead of a tab-killer.
  if (
    typeof localStorage !== "undefined" &&
    localStorage.getItem("strasbeat:visuals-disabled") === "true"
  ) {
    console.warn(
      "[strasbeat] Hydra visuals are DISABLED via localStorage " +
        "('strasbeat:visuals-disabled'). initHydra() is a no-op. Remove that " +
        "key and re-play to re-enable.",
    );
    return null;
  }

  // Lazy import: hydra-synth's mouse.js touches `window` at evaluation time,
  // which breaks Node (tests). Deferring to here means the import only runs
  // in a browser context when initHydra() is called. Vite bundles this
  // statically (it resolves the string literal 'hydra-synth' at build time),
  // so the bundle is still fully offline — no network request.
  const { default: Hydra } = await import("hydra-synth");
  // Torn down (stop, or a re-init with other options) while the chunk loaded.
  if (gen !== lifeGen) return null;

  // Our own canvas rather than @strudel/draw's getDrawContext: that helper
  // adds an anonymous window resize listener per canvas it creates and never
  // removes it, leaking one listener + one retained canvas per stop→play.
  // createVisualCanvas applies the resolution cap (see visuals-host.js) BEFORE
  // Hydra is constructed, so hydra-synth's _initCanvas reads the clamped dims
  // (hydra-synth.js:236) and allocates its ~12 FBOs at that size. The canvas
  // still CSS-stretches to the viewport, so visuals fill the panel/window.
  const canvas = createVisualCanvas("hydra-canvas", { pixelRatio, pixelated });
  // Create the context up front with the requested type (what getDrawContext
  // did); regl then picks up this same context.
  canvas.getContext(contextType);
  // OBSERVABILITY: log the EXACT runtime numbers the user must read back if the
  // cap doesn't fix it — viewport, dpr and the clamped backing store.
  console.info(
    `[strasbeat] initHydra — viewport=${window.innerWidth}x${window.innerHeight} ` +
      `dpr=${window.devicePixelRatio} → ` +
      `canvas backing-store=${canvas.width}x${canvas.height}`,
  );

  // autoLoop:false — we drive hydra.tick() from our OWN stoppable rAF loop so
  // teardown actually stops it (hydra-synth's own loop handle is unreachable;
  // see the render-loop block above). enableStreamCapture:false — the default
  // true wires a 25fps canvas.captureStream + MediaRecorder we never use, pure
  // overhead. makeGlobal stays default true: it's what puts osc/out/solid/etc.
  // on window for pattern code (eval-sandbox.js:17) — turning it off breaks the
  // demo. detectAudio stays false (no mic).
  const hydraConfig = {
    detectAudio: false,
    autoLoop: false,
    enableStreamCapture: false,
    ...rest,
    canvas,
  };
  // KILL-SWITCH (fail-safe): if Hydra construction throws (regl/WebGL init
  // failure, etc.), tear down and surface a clear, actionable error rather than
  // leaving a half-built instance + an orphaned canvas. Visuals stay
  // unavailable; the editor keeps working.
  const before = snapshotGlobals();
  try {
    hydra = new Hydra(hydraConfig);
  } catch (err) {
    console.error(
      "[strasbeat] Hydra failed to initialize — visuals disabled for this " +
        "session. The editor is unaffected. To force-disable visuals on this " +
        "machine, set localStorage['strasbeat:visuals-disabled']='true'.",
      err,
    );
    recordClobberedGlobals(before);
    restoreClobberedGlobals();
    try {
      canvas.remove();
    } catch {
      /* canvas may already be gone */
    }
    hydra = null;
    return null;
  }
  recordClobberedGlobals(before);
  canvasEl = canvas;
  lastOptionsKey = optionsKey;
  livePixelRatio = pixelRatio;

  // WebGL context-loss handlers (surface-failures-loudly). On loss we
  // preventDefault (so the browser will fire `restored`) and log loudly; on
  // restore we log. A GPU OOM typically fires `lost` right before the tab dies
  // — capturing it gives the user one more diagnostic breadcrumb.
  installContextLossHandlers(canvas);

  if (feedStrudel) {
    // Deferred to the full-window increment (Phase 1.5): only coherent when
    // the live Strudel 2D rendering targets the full-window #test-canvas.
    // Pass-through so the option is accepted now; not expected to produce
    // useful output in the Phase 1 panel default. (Spec §"feedStrudel".)
    // Source via the instance (hydra.synth.s0), not globalThis.s0 — the
    // latter only exists under makeGlobal, an implementation detail.
    // Mirrors upstream (strudel-source/packages/hydra/hydra.mjs:35); optional
    // chaining because this path is deferred/unexercised in Phase 1.
    const { canvas: testCanvas } = getDrawContext();
    testCanvas.style.display = "none";
    hydra.synth?.s0?.init?.({ src: testCanvas });
  }

  // The host places the canvas and decides whether the loop runs (scheduler
  // playing + canvas on screen) — initHydra() itself never starts rendering.
  visualsChanged();
  return hydra;
}

/**
 * Stop Hydra, free its WebGL context, remove its canvas, and tell the host.
 * Callable from patterns; the app itself tears down through visuals-host.js
 * (every stop path, every evaluate that no longer asks for Hydra) and on HMR
 * dispose.
 *
 * This is where the leak is closed. In order:
 *   1. stop OUR render loop  → no orphaned tick survives.
 *   2. hush()                → clears sources/outputs (paints black once).
 *   3. regl.destroy()        → frees all FBOs/textures/programs/buffers AND
 *                              removes regl's own context-loss listeners
 *                              (regl/dist/regl.js:9845).
 *   4. loseContext()         → tells the browser to reclaim the WebGL context
 *                              slot immediately, instead of waiting for GC —
 *                              this is what avoids the ~16-context ceiling that
 *                              force-kills contexts (and the tab) under
 *                              repeated stop→play.
 *   5. remove the canvas + restore the globals hydra-synth overwrote.
 */
export function clearHydra() {
  const wasInitialized = hydra !== null;
  // Abandon any build still awaiting its import.
  lifeGen++;
  initPromise = null;
  initKey = null;

  // 1. Stop the loop FIRST so no tick runs against a half-destroyed context.
  stopLoop();
  // Our context-loss listeners go before the forced loss below, so a normal
  // teardown is not reported as a lost context.
  removeContextLossHandlers();

  // 2-4. Free GPU resources. All optional-chained so a partially-constructed
  // or fake instance tears down without throwing.
  try {
    hydra?.hush?.();
  } catch {
    /* hush touches GL; never let it block teardown */
  }
  try {
    const gl = hydra?.regl?._gl;
    hydra?.regl?.destroy?.();
    // loseContext() must come AFTER destroy() — destroy() removes regl's own
    // contextlost listener, so forcing the loss here won't re-enter regl.
    gl?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
  } catch {
    /* defensive: a destroy/loseContext hiccup must not strand the rest */
  }

  // Remove the canvas we actually created (works headless too); fall back to a
  // DOM lookup in case canvasEl was lost. document is guarded so a teardown in
  // a non-browser context is a no-op, not a ReferenceError.
  (
    canvasEl ??
    (typeof document !== "undefined"
      ? document.getElementById("hydra-canvas")
      : null)
  )?.remove?.();
  canvasEl = null;
  hydra = null;
  lastOptionsKey = null;
  lastTickTs = null;
  firstTickDone = false;

  // 5. Put back every global hydra-synth overwrote (see the snapshot block
  // above) so Strudel's own time/noise/src/hush/speed/shape are themselves
  // again for the next evaluate.
  restoreClobberedGlobals();
  if (wasInitialized) visualsChanged();
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
 * Use single quotes when calling H() from a pattern file — Strudel's
 * transpiler rewrites double-quoted strings to mini-notation. See CLAUDE.md.
 *
 * @param {Pattern} p any Strudel pattern/signal
 * @example
 * osc(10).rotate(H("0 0.5 1"))
 */
export function H(p) {
  let last = 0;
  return () => {
    try {
      // getTime() throws "no time set" when called outside an active
      // scheduler (e.g. tests). Fall back to 0 so tests and any
      // pre-scheduler calls return a stable value rather than crashing.
      let t;
      try {
        t = getTime();
      } catch {
        t = 0;
      }
      const haps = reify(p).queryArc(t, t);
      if (haps.length > 0 && haps[0].value != null) {
        last = haps[0].value;
      }
    } catch {
      // Defensive: any query hiccup holds the last value rather than crashing.
    }
    return last;
  };
}

// Vite HMR dispose: strasbeat reloads the page on pattern-file change, so
// without this a stale hydra canvas / WebGL context survives the reload and
// they pile up. clearHydra() removing #hydra-canvas is what makes this safe.
if (import.meta.hot) {
  import.meta.hot.dispose(() => clearHydra());
}
