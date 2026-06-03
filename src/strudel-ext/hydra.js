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
  const hydraConfig = { detectAudio: false, ...rest, canvas };
  hydra = new Hydra(hydraConfig);

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
 * Stop Hydra, remove its canvas, and flip the Visuals mode unavailable.
 * Called from patterns AND from the stop path / HMR dispose (Task 3).
 */
export function clearHydra() {
  // Only restore globals if Hydra was actually constructed — that is the
  // case where hydra-synth (makeGlobal: true) clobbered globalThis.speed /
  // globalThis.shape. `speed` is a synth property written to window via
  // EvalSandbox.add (eval-sandbox.js:17); `shape` is a generator transform
  // written the same way (hydra-synth.js:403). Both names are ALSO Strudel
  // controls, so without this restore a pattern using speed(...)/shape(...)
  // as standalone functions would silently get Hydra's versions after a
  // visual ran. Mirror upstream's exact restore lines
  // (strudel-source/packages/hydra/hydra.mjs:47-48).
  const wasInitialized = hydra !== null;
  hydra?.hush?.();
  globalThis.s0?.clear?.();
  document.getElementById("hydra-canvas")?.remove();
  hydra = null;
  lastOptionsKey = null;
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
