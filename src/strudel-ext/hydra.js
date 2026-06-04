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
//   3. Host callback — on init/teardown it notifies the host so the
//      bottom-panel "Visuals" mode can gate its availability (mirrors how
//      setBeatsAvailable / setCustomDraw gate modes).
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
import { reify, getTime, controls } from "@strudel/core";

let hydra = null;
let lastOptionsKey = null;

// ─── Render-resolution cap (GPU-OOM safety) ──────────────────────────────
// hydra-synth allocates numOutputs (4, each DOUBLE-buffered = 8 textures) +
// numSources (4) = ~12 FULL-RESOLUTION RGBA float-ish FBOs the moment it first
// renders (hydra-synth.js:103-104, getDrawContext sizes the canvas to the
// VIEWPORT). On a large or HiDPI display innerWidth×innerHeight×~12 buffers is
// hundreds of MB of VRAM allocated in ONE synchronous burst on the first tick
// → GPU process OOM → the tab dies instantly. That first tick happens when the
// user enters Visuals mode (the render gate keeps the loop paused until then),
// which is exactly the reported "click Visuals → crash".
//
// We clamp the backing store: pixelRatio ≤ 1 AND the long edge ≤
// MAX_HYDRA_LONG_EDGE. The canvas still STRETCHES to the viewport via CSS
// (width/height:100%), so full-window looks the same minus fine sharpness, and
// in the small Visuals panel the cap is invisible. This removes the OOM path
// regardless of display size — the leading fix AND a permanent safety net.
const MAX_HYDRA_LONG_EDGE = 1280;

/**
 * Compute the Hydra canvas BACKING-STORE size (the GPU buffer dimensions),
 * clamped so the multiple full-res FBOs can't exhaust VRAM.
 *
 * Pure + exported so the clamp is unit-testable headlessly (no WebGL/DOM).
 *
 * @param {object} a
 * @param {number} a.innerWidth   viewport CSS width
 * @param {number} a.innerHeight  viewport CSS height
 * @param {number} [a.pixelRatio] requested device pixel ratio (capped to ≤ 1)
 * @param {number} [a.maxLongEdge] hard cap on the longest backing-store edge
 * @returns {{ width: number, height: number, pixelRatio: number, clamped: boolean }}
 * @noAutocomplete
 */
export function computeHydraCanvasSize({
  innerWidth,
  innerHeight,
  pixelRatio = 1,
  maxLongEdge = MAX_HYDRA_LONG_EDGE,
}) {
  // Defensive: a 0/NaN viewport (e.g. a detached/hidden context) must not yield
  // a 0×0 or NaN canvas. Fall back to a tiny but valid 1×1 backing store.
  const vw = Number.isFinite(innerWidth) && innerWidth > 0 ? innerWidth : 1;
  const vh = Number.isFinite(innerHeight) && innerHeight > 0 ? innerHeight : 1;
  // Cap pixelRatio at 1 — a HiDPI ratio multiplies every FBO's pixel count.
  const pr = Math.min(Number.isFinite(pixelRatio) ? pixelRatio : 1, 1);
  let w = vw * pr;
  let h = vh * pr;
  // Scale uniformly so the longest edge fits the cap (preserves aspect).
  const longest = Math.max(w, h);
  let clamped = pr < (Number.isFinite(pixelRatio) ? pixelRatio : 1);
  if (longest > maxLongEdge) {
    const scale = maxLongEdge / longest;
    w *= scale;
    h *= scale;
    clamped = true;
  }
  return {
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
    pixelRatio: pr,
    clamped,
  };
}

// ─── Context-loss + resize handlers (registered per live canvas) ─────────
// Tracked at module scope so clearHydra() can remove them with the canvas.
let ctxLostHandler = null;
let ctxRestoredHandler = null;
let resizeClampHandler = null;
let resizeClampTimer = null;

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

function installResizeClamp() {
  if (typeof window === "undefined") return;
  resizeClampHandler = () => {
    if (resizeClampTimer) clearTimeout(resizeClampTimer);
    // 250ms > getDrawContext's 200ms so ours runs AFTER its (un-clamped) resize
    // and re-imposes the cap via hydra.setResolution (which sets canvas.width +
    // resizes every FBO).
    resizeClampTimer = setTimeout(() => {
      if (!hydra || !canvasEl) return;
      const sized = computeHydraCanvasSize({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        pixelRatio: 1,
      });
      try {
        hydra.setResolution?.(sized.width, sized.height);
      } catch (err) {
        console.warn("[strasbeat] hydra resize re-clamp failed:", err);
      }
    }, 250);
  };
  window.addEventListener("resize", resizeClampHandler);
}

function removeResizeClamp() {
  if (resizeClampTimer) {
    clearTimeout(resizeClampTimer);
    resizeClampTimer = null;
  }
  if (typeof window !== "undefined" && resizeClampHandler) {
    window.removeEventListener("resize", resizeClampHandler);
  }
  resizeClampHandler = null;
}

// ─── Render loop (owned, stoppable) ──────────────────────────────────────
// hydra-synth's own autoLoop starts a raf-loop whose handle it DISCARDS
// (node_modules/hydra-synth/src/hydra-synth.js:124) — so nothing can ever
// stop it, and hush() doesn't either. That orphaned loop, plus the regl
// WebGL context hush() never frees, is the leak that made the feature slow +
// crash-prone (every stop→play leaked one of each; browsers cap live WebGL
// contexts at ~16). We instead construct Hydra with autoLoop:false and drive
// hydra.tick() from THIS loop, whose id we keep, so clearHydra() can stop it
// deterministically and setHydraRenderEnabled() can pause it when the canvas
// is hidden (Visuals off) — zero idle GPU cost.
let rafId = null;
let lastTickTs = null;
let renderEnabled = true; // gated by canvas visibility from main.js
let canvasEl = null; // the live #hydra-canvas, kept so teardown removes THIS one

// Injection seam (tests only). Production uses the real dynamic import +
// getDrawContext + requestAnimationFrame. _setHydraTestHarness lets the
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
  renderEnabled = true;
}

function startLoop() {
  if (rafId != null || !hydra || !renderEnabled) return;
  lastTickTs = null;
  let firstTickDone = false;
  const frame = (ts) => {
    // Re-read each frame so a stop (rafId nulled) or pause halts cleanly even
    // if a frame was already queued.
    if (rafId == null || !hydra) return;
    rafId = _raf(frame);
    const dt = lastTickTs == null ? 16 : Math.max(0, ts - lastTickTs);
    lastTickTs = ts;
    // OBSERVABILITY: log the FIRST tick after a (re)start with the live backing-
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

/**
 * Pause or resume Hydra's render loop. main.js calls this from the same paths
 * that show/hide #hydra-canvas so Hydra renders ONLY when visible (Visuals
 * panel or full-window) — a hidden full-viewport GL render every frame is pure
 * waste and a big contributor to the "very very slow" report. No-op when no
 * Hydra is live.
 *
 * @param {boolean} enabled
 * @noAutocomplete
 */
export function setHydraRenderEnabled(enabled) {
  renderEnabled = !!enabled;
  if (!hydra) return;
  if (renderEnabled) startLoop();
  else stopLoop();
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

// Host callback registered from main.js (Task 2). Default no-op so the
// module works headless (tests) and before main.js wires it.
let onVisualsAvailable = () => {};

/**
 * Register a callback to be notified when Hydra visuals become available or
 * unavailable. Called with `true` on successful `initHydra()`, `false` on
 * `clearHydra()`. Used by the bottom-panel Visuals mode (Task 2) to gate
 * the mode's availability.
 *
 * @param {function(boolean): void} fn
 * @noAutocomplete
 */
export function setVisualsAvailabilityCallback(fn) {
  if (typeof fn === "function") onVisualsAvailable = fn;
}

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

  // Re-init with changed options: tear down the old canvas first.
  if (hydra && optionsKey !== lastOptionsKey) clearHydra();
  // Already initialized with these options — reuse it. Patterns put
  // `await initHydra()` at the top and re-evaluate on every Ctrl+Enter
  // without stopping; constructing a second Hydra here would orphan the
  // previous instance (its render loop + WebGL context keep running, never
  // hushed). Upstream gates construction on `#hydra-canvas` not already
  // existing for the same reason — re-eval just re-defines the visual chain
  // on the existing instance. (strudel-source/packages/hydra/hydra.mjs:14)
  if (hydra) return hydra;
  lastOptionsKey = optionsKey;

  // hydra-synth's offline npm bundle references Node's `global` (via
  // right-now/browser.js) at module-eval time; without this it throws
  // `global is not defined` in the browser the moment it's imported. Must run
  // BEFORE the import below. See installNodeGlobalShim() for the full why.
  installNodeGlobalShim();

  if (harness) {
    // Test path: skip the real hydra-synth import + DOM/WebGL entirely. The
    // harness returns a fake { hydra, canvas } so the lifecycle (loop start,
    // teardown) can be exercised headlessly.
    const made = harness.makeHydra();
    hydra = made.hydra;
    canvasEl = made.canvas ?? null;
    startLoop();
    onVisualsAvailable(true);
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
    hydra = null;
    lastOptionsKey = null;
    onVisualsAvailable(false);
    return null;
  }

  // Lazy import: hydra-synth's mouse.js touches `window` at evaluation time,
  // which breaks Node (tests). Deferring to here means the import only runs
  // in a browser context when initHydra() is called. Vite bundles this
  // statically (it resolves the string literal 'hydra-synth' at build time),
  // so the bundle is still fully offline — no network request.
  const { default: Hydra } = await import("hydra-synth");

  const { canvas } = getDrawContext("hydra-canvas", {
    contextType,
    pixelRatio,
    pixelated,
  });

  // RESOLUTION CAP (GPU-OOM safety + the leading crash fix). getDrawContext
  // just sized `canvas` to innerWidth×innerHeight (pixelRatio 1). Override the
  // backing store to the clamped size BEFORE constructing Hydra so hydra-synth's
  // _initCanvas reads the clamped dims (hydra-synth.js:236) and allocates its
  // ~12 FBOs at that smaller size. The canvas still CSS-stretches to the
  // viewport (width/height:100%), so visuals fill the panel/window unchanged.
  const sized = computeHydraCanvasSize({
    innerWidth: typeof window !== "undefined" ? window.innerWidth : 1280,
    innerHeight: typeof window !== "undefined" ? window.innerHeight : 720,
    pixelRatio,
  });
  canvas.width = sized.width;
  canvas.height = sized.height;
  // OBSERVABILITY: log the EXACT runtime numbers the user must read back if the
  // cap doesn't fix it — viewport, dpr, the clamped backing store, whether the
  // clamp engaged. Confirms pixelRatio is really capped and the canvas isn't huge.
  console.info(
    `[strasbeat] initHydra — viewport=${typeof window !== "undefined" ? window.innerWidth : "?"}x${typeof window !== "undefined" ? window.innerHeight : "?"} ` +
      `dpr=${typeof window !== "undefined" ? window.devicePixelRatio : "?"} → ` +
      `canvas backing-store=${canvas.width}x${canvas.height} ` +
      `(pixelRatio capped to ${sized.pixelRatio}, clamped=${sized.clamped}, maxLongEdge=${MAX_HYDRA_LONG_EDGE})`,
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
  try {
    hydra = new Hydra(hydraConfig);
  } catch (err) {
    console.error(
      "[strasbeat] Hydra failed to initialize — visuals disabled for this " +
        "session. The editor is unaffected. To force-disable visuals on this " +
        "machine, set localStorage['strasbeat:visuals-disabled']='true'.",
      err,
    );
    try {
      canvas.remove();
    } catch {
      /* canvas may already be gone */
    }
    hydra = null;
    canvasEl = null;
    lastOptionsKey = null;
    onVisualsAvailable(false);
    return null;
  }
  canvasEl = canvas;

  // WebGL context-loss handlers (surface-failures-loudly). On loss we
  // preventDefault (so the browser will fire `restored`) and log loudly; on
  // restore we log. A GPU OOM typically fires `lost` right before the tab dies
  // — capturing it gives the user one more diagnostic breadcrumb.
  installContextLossHandlers(canvas);

  // Re-clamp on resize. getDrawContext registered its OWN resize listener that
  // resets canvas.width to innerWidth×pixelRatio (bypassing our cap) — so we
  // register ours too and call hydra.setResolution() to resize the FBOs to the
  // clamped size. Debounced to match getDrawContext's 200ms cadence and run
  // just after it (ours wins because setResolution overrides canvas.width).
  installResizeClamp();

  startLoop();

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

  onVisualsAvailable(true);
  return hydra;
}

/**
 * Stop Hydra, free its WebGL context, remove its canvas, and flip the Visuals
 * mode unavailable. Called from patterns AND from the stop path / HMR dispose.
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
 *   5. remove the canvas + restore the clobbered Strudel globals.
 */
export function clearHydra() {
  const wasInitialized = hydra !== null;

  // 1. Stop the loop FIRST so no tick runs against a half-destroyed context.
  stopLoop();

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

  globalThis.s0?.clear?.();
  // Remove OUR listeners before dropping the canvas/window refs (these read
  // canvasEl, so they must run while it's still set).
  removeContextLossHandlers();
  removeResizeClamp();
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

  // 5. Restore globals only if Hydra was actually constructed — that is the
  // case where hydra-synth (makeGlobal: true) clobbered globalThis.speed /
  // globalThis.shape. `speed` is a synth property written to window via
  // EvalSandbox.add (eval-sandbox.js:17); `shape` is a generator transform
  // written the same way (hydra-synth.js:403). Both names are ALSO Strudel
  // controls, so without this restore a pattern using speed(...)/shape(...)
  // as standalone functions would silently get Hydra's versions after a
  // visual ran. Mirror upstream's exact restore lines
  // (strudel-source/packages/hydra/hydra.mjs:47-48).
  if (wasInitialized) {
    globalThis.speed = controls.speed;
    globalThis.shape = controls.shape;
  }
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
