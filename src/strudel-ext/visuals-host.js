// Shared lifecycle for the live-visual layers (hydra.js, shader.js).
//
// Both layers own a full-viewport WebGL canvas and a render loop. Everything
// that decides WHETHER a layer should exist or draw lives here, so the two
// cannot drift apart:
//
//   - Existence follows the repl. A layer is alive iff the code most recently
//     evaluated asked for it (initHydra() / shader()) AND the scheduler is
//     running. syncVisualsToRepl() is fed every repl state update, which makes
//     it the one place that sees every stop path (play button, Ctrl+., palette,
//     vim, export's direct scheduler.stop()) and every evaluate (including the
//     silent evaluate(false) of the boot first-frame and the WAV export).
//   - Drawing follows visibility. The host (main.js) reports whether the
//     canvases are on screen; a hidden canvas never renders a frame.
//   - prefers-reduced-motion renders one still frame instead of animating.
//
// Layers register { isLive, clear, setRenderMode, resize, getCanvas }.

const layers = new Map(); // id → layer (+ requestedGen)
let evalGen = 0; // bumped at the start of every evaluate
let wasPending = false;
let playing = false;
let startHolds = 0; // evaluates that are about to start the scheduler
let visible = false;
let onChange = () => {};

// ─── Canvas sizing (GPU-OOM safety) ──────────────────────────────────────
// hydra-synth allocates numOutputs (4, each DOUBLE-buffered = 8 textures) +
// numSources (4) = ~12 FULL-RESOLUTION RGBA float-ish FBOs the moment it first
// renders (hydra-synth.js:103-104). On a large or HiDPI display
// innerWidth×innerHeight×~12 buffers is hundreds of MB of VRAM allocated in
// ONE synchronous burst on the first tick → GPU process OOM → the tab dies
// instantly. The raw shader layer has a single buffer but shades every pixel
// of it every frame, so an uncapped 5K backing store is just as wasteful.
//
// We clamp the backing store: pixelRatio ≤ 1 AND the long edge ≤
// MAX_VISUAL_LONG_EDGE. The canvas still STRETCHES to the viewport via CSS
// (width/height:100%), so full-window looks the same minus fine sharpness, and
// in the small Visuals panel the cap is invisible.
export const MAX_VISUAL_LONG_EDGE = 1280;

/**
 * Compute a visuals canvas BACKING-STORE size (the GPU buffer dimensions),
 * clamped so full-res FBOs can't exhaust VRAM.
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
export function computeVisualCanvasSize({
  innerWidth,
  innerHeight,
  pixelRatio = 1,
  maxLongEdge = MAX_VISUAL_LONG_EDGE,
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

function viewportSize(pixelRatio = 1) {
  return computeVisualCanvasSize({
    innerWidth: typeof window !== "undefined" ? window.innerWidth : 1280,
    innerHeight: typeof window !== "undefined" ? window.innerHeight : 720,
    pixelRatio,
  });
}

/**
 * Create a layer's canvas: full-viewport, fixed, pointer-events:none, hidden
 * until the host places it (all of that is the .visuals-canvas rule in
 * visuals.css), with a capped backing store. Replaces any stale canvas with
 * the same id.
 *
 * @noAutocomplete
 */
export function createVisualCanvas(id, { pixelRatio = 1, pixelated } = {}) {
  document.getElementById(id)?.remove();
  const canvas = document.createElement("canvas");
  canvas.id = id;
  canvas.className = "visuals-canvas";
  const size = viewportSize(pixelRatio);
  canvas.width = size.width;
  canvas.height = size.height;
  if (pixelated) canvas.style.imageRendering = "pixelated";
  document.body.prepend(canvas);
  return canvas;
}

// ─── Layer registry ──────────────────────────────────────────────────────

/** @noAutocomplete */
export function registerVisualLayer(id, layer) {
  layers.set(id, { ...layer, requestedGen: -1 });
}

function liveLayers() {
  const out = [];
  for (const layer of layers.values()) if (layer.isLive()) out.push(layer);
  return out;
}

/**
 * Called by initHydra() / shader() every time pattern code asks for the layer,
 * so the sweep after the evaluate knows this code still wants it.
 *
 * @noAutocomplete
 */
export function markVisualRequested(id) {
  const layer = layers.get(id);
  if (layer) layer.requestedGen = evalGen;
}

/**
 * The canvases of every live layer — the host applies its placement classes
 * (panel-clipped / full-window) to these.
 *
 * @noAutocomplete
 */
export function getVisualCanvases() {
  return liveLayers()
    .map((layer) => layer.getCanvas())
    .filter(Boolean);
}

/**
 * Register the host callback, called with `true`/`false` (any layer live?)
 * whenever a layer is created or torn down. main.js uses it to gate the
 * bottom-panel Visuals mode and to place freshly created canvases.
 *
 * @param {function(boolean): void} fn
 * @noAutocomplete
 */
export function setVisualsChangeCallback(fn) {
  if (typeof fn === "function") onChange = fn;
}

// ─── Reduced motion ──────────────────────────────────────────────────────
// With prefers-reduced-motion the layers draw a single still frame (redrawn
// when the code is re-evaluated or the window resizes) instead of animating.
// The pattern author asked for visuals, so nothing is hidden — it just doesn't
// move. localStorage['strasbeat:visuals-motion'] = 'full' opts back in.
const MOTION_KEY = "strasbeat:visuals-motion";
let motionQuery = null;
let stillNoticeLogged = false;

function prefersStill() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  if (!motionQuery) {
    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    motionQuery.addEventListener?.("change", () => applyRenderMode());
  }
  if (!motionQuery.matches) return false;
  try {
    return localStorage.getItem(MOTION_KEY) !== "full";
  } catch {
    return true;
  }
}

function currentRenderMode() {
  if (!playing || !visible) return "off";
  return prefersStill() ? "still" : "live";
}

// Push the render mode to every live layer. "live"/"off" are idempotent in the
// layers; "still" draws one fresh frame per call, so this is also how a still
// frame is refreshed after a re-evaluate or a resize.
function applyRenderMode() {
  const live = liveLayers();
  if (!live.length) return;
  const mode = currentRenderMode();
  if (mode === "still" && !stillNoticeLogged) {
    stillNoticeLogged = true;
    console.info(
      "[strasbeat] prefers-reduced-motion is on — visuals render a still " +
        `frame instead of animating. Set localStorage['${MOTION_KEY}'] = ` +
        "'full' and re-play to animate anyway.",
    );
  }
  for (const layer of live) layer.setRenderMode(mode);
}

/**
 * Host → wrapper: are the visuals canvases on screen (Visuals panel showing,
 * or full-window on)? A hidden canvas must not render.
 *
 * @param {boolean} isVisible
 * @noAutocomplete
 */
export function setVisualsVisible(isVisible) {
  if (visible === !!isVisible) return;
  visible = !!isVisible;
  applyRenderMode();
}

// ─── Window resize ───────────────────────────────────────────────────────
// One debounced listener for all layers, attached only while a layer is live.
let resizeListening = false;
let resizeTimer = null;

function onWindowResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const layer of liveLayers()) {
      try {
        layer.resize(viewportSize(layer.pixelRatio?.() ?? 1));
      } catch (err) {
        console.warn("[strasbeat] visuals resize failed:", err);
      }
    }
    applyRenderMode();
  }, 200);
}

function syncResizeListener(anyLive) {
  if (typeof window === "undefined") return;
  if (anyLive && !resizeListening) {
    window.addEventListener("resize", onWindowResize);
    resizeListening = true;
  } else if (!anyLive && resizeListening) {
    window.removeEventListener("resize", onWindowResize);
    clearTimeout(resizeTimer);
    resizeTimer = null;
    resizeListening = false;
  }
}

/**
 * A layer calls this after it went live or tore down.
 *
 * @noAutocomplete
 */
export function visualsChanged() {
  const anyLive = liveLayers().length > 0;
  syncResizeListener(anyLive);
  // Host first: it places the new canvas and reports visibility, so the render
  // mode applied below is already the right one.
  try {
    onChange(anyLive);
  } catch (err) {
    console.warn("[strasbeat] visuals host callback threw:", err);
  }
  applyRenderMode();
}

/**
 * Tear down every layer. Layers that are not live are cleared too: that is
 * what abandons an initHydra() still awaiting its chunk, which would otherwise
 * finish building (GL context, overwritten globals) after the teardown.
 *
 * @noAutocomplete
 */
export function clearVisuals() {
  for (const layer of layers.values()) layer.clear();
}

/**
 * Declare that the evaluate about to run intends to start the scheduler.
 *
 * The app evaluates with autostart off and starts the scheduler itself once
 * the user's code has run, so a play from idle reports "evaluate settled,
 * scheduler not started" for a moment — the same state a silent
 * evaluate(false) ends in. While a hold is out that state does not tear the
 * layers down. Returns a release function (idempotent); releasing re-checks
 * against the scheduler, so a start that was cancelled or failed still clears.
 *
 * @returns {function(): void}
 * @noAutocomplete
 */
export function holdVisualsForStart() {
  startHolds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    startHolds--;
    if (startHolds === 0 && !playing && !wasPending) clearVisuals();
  };
}

/**
 * Reconcile the layers with the repl. Wired as the repl's `onUpdateState`, so
 * it runs on every scheduler start/stop and at both ends of every evaluate
 * (success or failure).
 *
 *   - evaluate succeeded → drop layers the new code did not ask for.
 *   - evaluate failed    → the previous pattern keeps playing, keep its visuals.
 *   - scheduler idle and no evaluate in flight → no visuals at all. This is
 *     what tears down on every stop path, and what discards the layers a silent
 *     evaluate(false) (boot first frame, WAV export) built. An evaluate that
 *     is about to start the scheduler says so with holdVisualsForStart().
 *
 * @param {{ pending?: boolean, started?: boolean, evalError?: unknown }} state
 * @noAutocomplete
 */
export function syncVisualsToRepl(state) {
  const pending = !!state?.pending;
  const started = !!state?.started;
  if (pending && !wasPending) evalGen++;
  const settled = wasPending && !pending;
  wasPending = pending;

  if (settled && !state?.evalError) {
    // Every registered layer, not just the live ones — see clearVisuals().
    for (const layer of layers.values()) {
      if (layer.requestedGen !== evalGen) layer.clear();
    }
  }
  if (!started && !pending && startHolds === 0) clearVisuals();

  if (playing !== started) {
    playing = started;
    applyRenderMode();
  } else if (settled) {
    applyRenderMode(); // refresh a still frame for the new code
  }
}

/** @noAutocomplete */
export function _resetVisualsHost() {
  evalGen = 0;
  wasPending = false;
  playing = false;
  startHolds = 0;
  visible = false;
  onChange = () => {};
  stillNoticeLogged = false;
  for (const layer of layers.values()) layer.requestedGen = -1;
}
