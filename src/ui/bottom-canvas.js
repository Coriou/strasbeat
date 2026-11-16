// The bottom-panel canvas (#roll) and everything that decides whether it gets
// painted. Three renderers share it — the piano roll, the scope, and
// Strudel's own draw functions (`.punchcard()`, `.spiral()`, `.onPaint()` …)
// — and the rule for all of them is the same: draw only when the canvas can
// be seen and there is something new to show.
//
//   playing   The playback loop calls draw(haps, time) once per animation
//             frame. Nothing is painted while the pane is collapsed, another
//             view (beat grid, visuals) covers the canvas, or the tab is in
//             the background.
//   stopped   no frame loop at all. The last frame is kept and repainted
//             when something invalidates the pixels: a resize, a display
//             change, a mode switch, the pointer moving over a note.
//
// Geometry comes from one ResizeObserver, so no frame ever reads layout. The
// canvas reports 0×0 when it is `display: none` — which is how both the
// collapsed pane (.shell--roll-collapsed) and the beat grid hide it — and
// that is the whole visibility test.
//
// Strudel draw functions
// ----------------------
// A pattern can register painters (`.onPaint(fn)`, and the helpers built on
// it). They come in two kinds, told apart by whether they touch the context
// they are handed:
//
//   - panel painters draw on the context they are given (`.punchcard()`,
//     `.spiral()`, `.wordfall()`, a hand-written `.onPaint`). They get this
//     canvas, under the bottom panel's "Custom" mode, which is offered — and
//     selected — as soon as a pattern has one. Switching back to Roll is
//     respected until the painters go away and come back. A painter may
//     only reach for its context some of the time (a hand-written one that
//     draws just the sounding notes, asked during a rest), so one that has
//     not touched it yet keeps being watched and moves here when it does.
//   - self-targeting painters bring their own canvas and ignore the one they
//     are given: the inline `._punchcard()` / `._spiral()` / `._pitchwheel()`
//     editor widgets, and `.pitchwheel()`, which draws on Strudel's own
//     full-page canvas exactly like `.pianoroll()` and `.scope()` do. They
//     run every frame whatever the bottom panel shows.

import { renderRoll, resetRoll, setRollSource } from "./piano-roll.js";

/**
 * What the canvas should paint, if anything.
 *
 * @param {{ mode: string, visible: boolean, docHidden: boolean }} s
 * @returns {"roll" | "scope" | "custom" | null}
 */
export function canvasJob({ mode, visible, docHidden }) {
  if (!visible || docHidden) return null;
  if (mode === "roll" || mode === "scope" || mode === "custom") return mode;
  return null; // beat grid and visuals are not canvas views
}

/**
 * Whether anything on screen needs haps beyond the present moment. The
 * playback loop keeps every hap inside its numeric window, so
 * the window is only worth its full width while the roll or a painter is
 * there to show it; highlighting and shader uniforms need just "now".
 *
 * @param {{ mode: string, visible: boolean, hasPainters: boolean }} s
 */
export function needsHapWindow({ mode, visible, hasPainters }) {
  if (hasPainters) return true;
  return visible && (mode === "roll" || mode === "custom");
}

/**
 * Backing-store size for a CSS size at a device pixel ratio.
 * @returns {{ width: number, height: number }}
 */
export function backingSize(cssWidth, cssHeight, dpr) {
  return {
    width: Math.round(cssWidth * dpr),
    height: Math.round(cssHeight * dpr),
  };
}

/**
 * A stand-in for a drawing context that forwards everything to `target` and
 * remembers whether it was ever read from or written to.
 *
 * @param {object} target
 * @returns {{ ctx: object, touched: () => boolean }}
 */
export function createContextProbe(target) {
  let touched = false;
  const ctx = new Proxy(target, {
    get(t, key) {
      touched = true;
      const v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, key, value) {
      touched = true;
      t[key] = value;
      return true;
    },
  });
  return { ctx, touched: () => touched };
}

/**
 * Split painters into those that draw on the context they are handed and
 * those that did not look at it. Each painter is run once against a
 * recording stand-in for the context; touching it in any way marks a panel
 * painter. "Did not look" is only true of this one call — `probes` holds
 * the stand-in of every painter filed under `self`, so the caller can keep
 * handing it over and see the first touch.
 *
 * @param {Function[]} painters
 * @param {(painter: Function, ctx: any) => void} run  calls the painter
 * @param {object} target  context (or stand-in) the probe forwards to
 * @param {(error: Error) => void} [onError] reports painter failures
 * @returns {{
 *   panel: Function[],
 *   self: Function[],
 *   probes: Map<Function, ReturnType<typeof createContextProbe>>,
 * }}
 */
export function classifyPainters(
  painters,
  run,
  target,
  onError = (error) => console.warn("[strasbeat] draw function threw:", error),
) {
  const panel = [];
  const self = [];
  const probes = new Map();
  for (const painter of painters) {
    const probe = createContextProbe(target);
    try {
      run(painter, probe.ctx);
    } catch (err) {
      onError(err);
    }
    if (probe.touched()) {
      panel.push(painter);
    } else {
      self.push(painter);
      probes.set(painter, probe);
    }
  }
  return { panel, self, probes };
}

const NO_HAPS = Object.freeze([]);
// A live frame this recent means the Drawer loop is running and will repaint
// by itself; an extra idle repaint would only double the work.
const LIVE_FRAME_MS = 100;

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {(error: Error) => void} [opts.onError] reports painter failures
 * @param {ReturnType<import("./bottom-panel-modes.js").createBottomPanelModes>} opts.modes
 * @param {ReturnType<import("./scope.js").createScope>} opts.scope
 * @param {[number, number]} opts.drawTime  visible window around the playhead, in cycles
 * @param {() => import("@codemirror/view").EditorView | null} opts.getView
 * @param {() => boolean} opts.isPlaying  is the scheduler running
 * @param {() => void} [opts.beforeLocate]  called before a roll click moves
 *   the cursor, so the host can bring the playing document into the editor
 * @param {() => boolean} [opts.isPlayingDocFocused]  is the document in the
 *   editor the one that is playing (true when the host has one document)
 */
export function createBottomCanvas({
  canvas,
  onError = (error) => console.warn("[strasbeat] draw function threw:", error),
  modes,
  scope,
  drawTime,
  getView,
  isPlaying,
  beforeLocate = null,
  isPlayingDocFocused = () => true,
}) {
  const ctx = canvas.getContext("2d");

  // Geometry, in CSS px, as last reported by the ResizeObserver. Until the
  // first report the canvas is presumed visible (so the Drawer keeps its
  // full window through boot) but has no size, so nothing paints.
  let cssW = 0;
  let cssH = 0;
  let measured = false;
  let dpr = window.devicePixelRatio || 1;

  // The frame to repaint while stopped. `haps` is the Drawer's own array.
  let lastHaps = NO_HAPS;
  let lastTime = 0;
  let lastLiveAt = -Infinity;
  // Set when the kept frame was dropped on purpose (see handleDocSwap), so
  // nothing quietly brings the old pattern back before the next real frame.
  let blank = false;
  // The kept frame belongs to a document other than the one in the editor:
  // the tab was switched during playback, and playback has since stopped.
  let foreignFrame = false;

  let allPainters = [];
  let panelPainters = [];
  let selfPainters = [];
  // The context stand-in each self-targeting painter is handed (see paint).
  let selfProbes = new Map();
  let customOffered = false;
  let scratchCtx = null;
  let clearBeforeCustom = true;

  let onHapDemandChange = null;
  let lastDemand = null;
  let repaintFrame = null;
  let repaintTimer = null;
  let painting = false;

  const isVisible = () => !measured || (cssW > 0 && cssH > 0);
  const hasSize = () => cssW > 0 && cssH > 0;

  function wantsHapWindow() {
    return needsHapWindow({
      mode: modes.getMode(),
      visible: isVisible(),
      hasPainters: panelPainters.length + selfPainters.length > 0,
    });
  }

  function checkDemand() {
    const demand = wantsHapWindow();
    if (demand === lastDemand) return;
    lastDemand = demand;
    onHapDemandChange?.(demand);
  }

  // ─── Sizing ────────────────────────────────────────────────────────────
  function applySize(w, h) {
    measured = true;
    const wasShown = hasSize();
    cssW = w;
    cssH = h;
    if (!hasSize()) {
      // Hidden: keep the old backing store, there is nothing to draw into.
      checkDemand();
      return;
    }
    const size = backingSize(w, h, dpr);
    let resized = false;
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
      resized = true;
    }
    checkDemand();
    // Resizing a canvas clears it, and this runs after the frame's draw
    // callbacks but before paint — so repaint here, in the same frame, or
    // the roll would flash empty on every step of a resize (and stay empty
    // while stopped).
    if (resized || !wasShown) paint();
  }

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1].contentRect;
      applySize(rect.width, rect.height);
    }).observe(canvas);
  }

  // A device-pixel-ratio change (window dragged to another display, browser
  // zoom) leaves the CSS size alone, so the ResizeObserver stays silent.
  // A resolution media query matches exactly one ratio; re-arm it each time.
  function watchDpr() {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener(
      "change",
      () => {
        dpr = window.devicePixelRatio || 1;
        if (measured) applySize(cssW, cssH);
        watchDpr();
      },
      { once: true },
    );
  }
  watchDpr();

  // One explicit re-measure, for callers that just changed the layout and
  // do not want to wait for the observer. Reads layout once.
  function refresh() {
    applySize(canvas.clientWidth, canvas.clientHeight);
  }

  // ─── Painting ──────────────────────────────────────────────────────────
  function runPainter(painter, target, haps, time) {
    painter(target, time, haps, drawTime);
  }

  function getScratchCtx() {
    if (!scratchCtx) {
      const scratch = document.createElement("canvas");
      scratch.width = 1;
      scratch.height = 1;
      scratchCtx = scratch.getContext("2d");
    }
    return scratchCtx;
  }

  function paint() {
    if (painting) return;
    painting = true;
    try {
      paintFrame();
    } finally {
      painting = false;
    }
  }

  function paintFrame() {
    const haps = lastHaps;
    const time = lastTime;
    const docHidden = document.hidden;

    // Self-targeting painters own their canvases (editor widgets); they
    // animate regardless of what this panel shows. Each still gets a
    // recording stand-in rather than a bare context: one that turns out to
    // draw on it after all is a panel painter from this frame on.
    if (selfPainters.length > 0 && !docHidden) {
      let promoted = false;
      for (const painter of selfPainters) {
        const probe = selfProbes.get(painter);
        try {
          runPainter(painter, probe.ctx, haps, time);
        } catch (err) {
          onError(err);
        }
        if (probe.touched()) {
          selfProbes.delete(painter);
          promoted = true;
        }
      }
      if (promoted) {
        panelPainters = allPainters.filter((p) => !selfProbes.has(p));
        selfPainters = allPainters.filter((p) => selfProbes.has(p));
        syncCustomOffer();
      }
    }

    const job = canvasJob({
      mode: modes.getMode(),
      visible: hasSize(),
      docHidden,
    });
    if (job === null) return;

    if (job === "scope") {
      scope.render(ctx, cssW, cssH, dpr);
    } else if (job === "custom") {
      // Strudel's painters work in device pixels and clear for themselves
      // (or deliberately don't). Hand them an untransformed context, wiped
      // once when they take the canvas over from another renderer.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (clearBeforeCustom) {
        clearBeforeCustom = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      // Whatever a painter leaves set (alpha, composite mode, a transform)
      // must not reach the next renderer to use this context.
      ctx.save();
      if (panelPainters.length > 0) {
        for (const painter of panelPainters) {
          try {
            runPainter(painter, ctx, haps, time);
          } catch (err) {
            onError(err);
          }
        }
      } else {
        const customFn = modes.getCustomDraw();
        if (customFn) {
          try {
            customFn(ctx, haps, time);
          } catch (err) {
            onError(err);
          }
        }
      }
      ctx.restore();
    } else {
      renderRoll({
        haps,
        time,
        ctx,
        drawTime,
        view: getView(),
        width: cssW,
        height: cssH,
        dpr,
        beforeLocate: locateGuard,
        requestRepaint,
      });
    }
  }

  // The Drawer's per-frame entry point.
  function draw(haps, time) {
    lastHaps = haps ?? NO_HAPS;
    lastTime = time;
    lastLiveAt = performance.now();
    blank = false;
    paint();
  }

  // Runs before a roll click moves the cursor; false calls the move off.
  function locateGuard() {
    // The notes on show are another document's and nothing is playing that
    // could be brought forward: their offsets mean nothing in this buffer.
    if (foreignFrame && !isPlaying()) return false;
    beforeLocate?.();
    return true;
  }

  // Repaint the kept frame on the next animation frame. Coalesced, and left
  // to the live frames while those are arriving anyway. A request made just
  // after a live frame cannot tell whether that frame was the last one
  // (playback stopped), so it waits until it can.
  function requestRepaint() {
    if (repaintFrame != null || repaintTimer != null) return;
    const requestedAt = performance.now();
    const wait = LIVE_FRAME_MS - (requestedAt - lastLiveAt);
    if (wait > 0) {
      repaintTimer = setTimeout(() => {
        repaintTimer = null;
        // A live frame since the request has already painted it.
        if (lastLiveAt < requestedAt) requestRepaint();
      }, wait);
      return;
    }
    repaintFrame = requestAnimationFrame(() => {
      repaintFrame = null;
      if (performance.now() - lastLiveAt < LIVE_FRAME_MS) return;
      paint();
    });
  }

  // ─── What the evaluated pattern asked for ──────────────────────────────
  // Called after every Drawer invalidate (each evaluate, and the boot-time
  // first frame): `code` is the text the haps' source offsets refer to,
  // `painters` the draw functions the new pattern registered. `refill` marks
  // an invalidate that only re-queried the pattern already on show (the hap
  // window was widened), as opposed to one that follows an evaluate.
  function afterInvalidate({ code, painters, haps, time, refill = false }) {
    setRollSource(canvas, code);
    // An evaluate runs the document in the editor, so from here on the
    // frames are its own.
    if (!refill) foreignFrame = false;

    allPainters = Array.isArray(painters) ? painters : [];
    if (allPainters.length === 0) {
      panelPainters = [];
      selfPainters = [];
      selfProbes = new Map();
    } else {
      const probeHaps = haps ?? NO_HAPS;
      // A painter already seen drawing on its context (the same pattern,
      // queried again) does not have to prove it a second time.
      const known = new Set(panelPainters);
      const sorted = classifyPainters(
        allPainters.filter((p) => !known.has(p)),
        (painter, probe) => runPainter(painter, probe, probeHaps, time ?? 0),
        getScratchCtx(),
        onError,
      );
      selfPainters = sorted.self;
      selfProbes = sorted.probes;
      panelPainters = allPainters.filter((p) => !selfProbes.has(p));
    }

    syncCustomOffer();
    checkDemand();
  }

  function syncCustomOffer() {
    const offer = panelPainters.length > 0;
    if (offer === customOffered) return;
    customOffered = offer;
    clearBeforeCustom = true;
    // Offering the mode also selects it; withdrawing it falls back to the
    // roll. Only on the edge, so a user who went back to Roll is not
    // yanked into Custom again by every re-evaluate.
    modes.setCustomDraw(offer ? paintPanelPainters : null);
  }

  // The function registered as the bottom panel's custom draw. The panel
  // only uses it as an "is there one" flag; paint() runs the painters.
  function paintPanelPainters() {}

  // The document under the roll was swapped for another one (tab switch).
  // While stopped the kept frame describes a pattern that is no longer in
  // the editor: show an empty roll instead of the previous tab's notes.
  // While playing the roll keeps showing what is sounding, and only notes
  // whether that is still the document in the editor.
  function handleDocSwap() {
    if (isPlaying()) {
      // The swap is announced before the host has moved its focus; ask once
      // it has.
      queueMicrotask(() => {
        if (isPlaying()) foreignFrame = !isPlayingDocFocused();
      });
      return;
    }
    foreignFrame = false;
    lastHaps = NO_HAPS;
    blank = true;
    resetRoll(canvas);
    paint();
  }

  modes.setOnChange((mode) => {
    if (mode === "scope") scope.markDirty();
    if (mode === "custom") clearBeforeCustom = true;
    checkDemand();
    // While stopped nothing else would replace the previous view's pixels.
    paint();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) requestRepaint();
  });

  return {
    draw,
    refresh,
    requestRepaint,
    afterInvalidate,
    handleDocSwap,
    wantsHapWindow,
    getLastTime: () => lastTime,
    /** False once the kept frame was dropped and no new one has arrived. */
    hasFrame: () => !blank,
    /** Called with the new answer whenever wantsHapWindow() changes. */
    setOnHapDemandChange(fn) {
      onHapDemandChange = fn;
      lastDemand = wantsHapWindow();
    },
  };
}
