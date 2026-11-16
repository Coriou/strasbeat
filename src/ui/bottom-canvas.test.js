// Run with: node --import ./scripts/test-register.mjs --test src/ui/bottom-canvas.test.js

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  backingSize,
  canvasJob,
  classifyPainters,
  createBottomCanvas,
  needsHapWindow,
} from "./bottom-canvas.js";
import { createBottomPanelModes } from "./bottom-panel-modes.js";

describe("canvasJob()", () => {
  const on = { visible: true, docHidden: false };

  test("each canvas view paints when the canvas can be seen", () => {
    assert.equal(canvasJob({ mode: "roll", ...on }), "roll");
    assert.equal(canvasJob({ mode: "scope", ...on }), "scope");
    assert.equal(canvasJob({ mode: "custom", ...on }), "custom");
  });

  test("the beat grid and visuals are not canvas views", () => {
    assert.equal(canvasJob({ mode: "beats", ...on }), null);
    assert.equal(canvasJob({ mode: "visuals", ...on }), null);
  });

  test("nothing paints while collapsed or in a background tab", () => {
    assert.equal(canvasJob({ mode: "roll", visible: false, docHidden: false }), null);
    assert.equal(canvasJob({ mode: "scope", visible: true, docHidden: true }), null);
  });
});

describe("needsHapWindow()", () => {
  test("only a visible roll or custom view needs more than the present", () => {
    const base = { visible: true, hasPainters: false };
    assert.equal(needsHapWindow({ ...base, mode: "roll" }), true);
    assert.equal(needsHapWindow({ ...base, mode: "custom" }), true);
    assert.equal(needsHapWindow({ ...base, mode: "scope" }), false);
    assert.equal(needsHapWindow({ ...base, mode: "beats" }), false);
    assert.equal(needsHapWindow({ ...base, mode: "roll", visible: false }), false);
  });

  test("a pattern's own draw functions always do", () => {
    assert.equal(
      needsHapWindow({ mode: "beats", visible: false, hasPainters: true }),
      true,
    );
  });
});

describe("backingSize()", () => {
  test("scales CSS pixels by the device pixel ratio, rounded", () => {
    assert.deepEqual(backingSize(800, 180, 2), { width: 1600, height: 360 });
    assert.deepEqual(backingSize(333.4, 100.6, 1.5), { width: 500, height: 151 });
  });
});

describe("classifyPainters()", () => {
  const target = { canvas: { width: 1 }, fillRect() {}, lineWidth: 1 };
  const run = (painter, ctx) => painter(ctx, 0, [], [-2, 2]);

  test("a painter that draws on the context it is given is a panel painter", () => {
    const calls = (ctx) => ctx.fillRect(0, 0, 1, 1);
    const sets = (ctx) => (ctx.lineWidth = 2);
    const reads = (ctx) => ctx.canvas.width;
    const { panel, self } = classifyPainters([calls, sets, reads], run, target);
    assert.deepEqual(panel, [calls, sets, reads]);
    assert.deepEqual(self, []);
  });

  test("a painter that brings its own canvas is left to itself", () => {
    const own = { fillRect() {} };
    // What an inline `._punchcard()` widget does: forwards the context it was
    // given, but the options it carries override it before anything is read.
    const widget = (ctx) => {
      const opts = { ctx, ...{ ctx: own } };
      opts.ctx.fillRect(0, 0, 1, 1);
    };
    const { panel, self } = classifyPainters([widget], run, target);
    assert.deepEqual(panel, []);
    assert.deepEqual(self, [widget]);
  });

  test("methods reached through the probe still run on the real context", () => {
    let receiver = null;
    const real = {
      fillRect() {
        receiver = this;
      },
    };
    classifyPainters([(ctx) => ctx.fillRect()], run, real);
    assert.equal(receiver, real);
  });

  test("a throwing painter is reported and still classified", () => {
    const warn = console.warn;
    const seen = [];
    console.warn = (...args) => seen.push(args);
    try {
      const bad = (ctx) => {
        ctx.fillRect();
        throw new Error("boom");
      };
      const { panel } = classifyPainters([bad], run, target);
      assert.deepEqual(panel, [bad]);
      assert.equal(seen.length, 1);
    } finally {
      console.warn = warn;
    }
  });
});

// ─── The surface itself, against a minimal fake DOM ──────────────────────

function makeEnv() {
  const env = { resize: null, dprChange: null, frames: [], docListeners: {} };
  // A 2D context that accepts every call the roll renderer makes.
  const makeCtx = () => {
    const ctx = { createLinearGradient: () => ({ addColorStop() {} }) };
    for (const name of [
      "setTransform", "clearRect", "fillRect", "save", "restore", "beginPath",
      "rect", "clip", "moveTo", "lineTo", "stroke", "fill", "fillText", "roundRect",
    ]) {
      ctx[name] = () => {};
    }
    return ctx;
  };
  const ctx = makeCtx();
  const canvas = {
    width: 300,
    height: 150,
    clientWidth: 0,
    clientHeight: 0,
    style: {},
    getContext: () => ctx,
    addEventListener() {},
  };
  ctx.canvas = canvas;
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.ResizeObserver = class {
    constructor(cb) {
      env.resize = (width, height) => cb([{ contentRect: { width, height } }]);
    }
    observe() {}
  };
  globalThis.matchMedia = () => ({
    addEventListener: (_type, fn) => (env.dprChange = fn),
  });
  globalThis.document = {
    hidden: false,
    addEventListener: (type, fn) => (env.docListeners[type] = fn),
    createElement: () => {
      const scratch = makeCtx();
      const el = { width: 0, height: 0, getContext: () => scratch };
      scratch.canvas = el;
      return el;
    },
  };
  globalThis.requestAnimationFrame = (fn) => env.frames.push(fn);
  env.canvas = canvas;
  env.ctx = ctx;
  return env;
}

describe("createBottomCanvas()", () => {
  let env, modes, scopeRenders, surface, playing;

  beforeEach(() => {
    env = makeEnv();
    modes = createBottomPanelModes();
    scopeRenders = [];
    playing = false;
    surface = createBottomCanvas({
      canvas: env.canvas,
      modes,
      scope: {
        render: (...args) => scopeRenders.push(args),
        markDirty() {},
      },
      drawTime: [-2, 2],
      getView: () => null,
      isPlaying: () => playing,
    });
  });

  test("sizes the backing store from the observed box and the pixel ratio", () => {
    env.resize(400, 180);
    assert.equal(env.canvas.width, 800);
    assert.equal(env.canvas.height, 360);
  });

  test("keeps the old backing store, and paints nothing, while collapsed", () => {
    modes.setMode("scope");
    env.resize(400, 180);
    scopeRenders.length = 0;
    env.resize(0, 0);
    surface.draw([], 1);
    surface.draw([], 1.1);
    assert.equal(env.canvas.width, 800);
    assert.equal(scopeRenders.length, 0);
  });

  test("repaints the kept frame when the pane comes back, without a new one", () => {
    modes.setMode("scope");
    env.resize(400, 180);
    env.resize(0, 0);
    scopeRenders.length = 0;
    env.resize(400, 180);
    assert.equal(scopeRenders.length, 1);
    // CSS size and the ratio the store was sized with travel together.
    assert.deepEqual(scopeRenders[0].slice(1), [400, 180, 2]);
  });

  test("a resize repaints in the same callback (a resized canvas is blank)", () => {
    modes.setMode("scope");
    env.resize(400, 180);
    scopeRenders.length = 0;
    env.resize(400, 240);
    assert.equal(scopeRenders.length, 1);
    env.resize(400, 240); // same size again: nothing to do
    assert.equal(scopeRenders.length, 1);
  });

  test("a pixel-ratio change alone re-sizes the store and repaints", () => {
    modes.setMode("scope");
    env.resize(400, 180);
    scopeRenders.length = 0;
    window.devicePixelRatio = 1;
    env.dprChange();
    assert.equal(env.canvas.width, 400);
    assert.equal(env.canvas.height, 180);
    assert.deepEqual(scopeRenders[0].slice(1), [400, 180, 1]);
  });

  test("paints nothing in a background tab", () => {
    modes.setMode("scope");
    env.resize(400, 180);
    scopeRenders.length = 0;
    document.hidden = true;
    surface.draw([], 1);
    assert.equal(scopeRenders.length, 0);
  });

  test("switching view while stopped repaints at once", () => {
    env.resize(400, 180);
    scopeRenders.length = 0;
    modes.setMode("scope");
    assert.equal(scopeRenders.length, 1);
  });

  test("reports when the need for a wide hap window changes", () => {
    const seen = [];
    surface.setOnHapDemandChange((wide) => seen.push(wide));
    assert.equal(surface.wantsHapWindow(), true, "presumed visible until measured");
    env.resize(0, 0);
    env.resize(0, 0);
    modes.setMode("scope");
    env.resize(400, 180);
    modes.setMode("roll");
    assert.deepEqual(seen, [false, true]);
  });

  test("panel painters get the canvas under Custom; widget painters run regardless", () => {
    env.resize(400, 180);
    const panelCalls = [];
    const widgetCalls = [];
    const panelPainter = (ctx, time) => {
      ctx.fillRect(0, 0, 1, 1);
      panelCalls.push([ctx === env.ctx, time]);
    };
    const widgetPainter = (_ctx, time) => widgetCalls.push(time);

    surface.afterInvalidate({
      code: "",
      painters: [panelPainter, widgetPainter],
      haps: [],
      time: 0,
    });
    assert.equal(modes.getMode(), "custom", "offering Custom selects it");
    panelCalls.length = 0;
    widgetCalls.length = 0;

    surface.draw([], 3);
    assert.deepEqual(panelCalls, [[true, 3]]);
    assert.deepEqual(widgetCalls, [3]);

    // Back on the roll, the panel painter rests; the widget keeps animating.
    modes.setMode("beats");
    modes.setMode("scope");
    panelCalls.length = 0;
    widgetCalls.length = 0;
    surface.draw([], 4);
    assert.deepEqual(panelCalls, []);
    assert.deepEqual(widgetCalls, [4]);

    // Re-evaluating the same pattern does not yank the user back to Custom.
    surface.afterInvalidate({ code: "", painters: [panelPainter, widgetPainter], haps: [], time: 4 });
    assert.equal(modes.getMode(), "scope");

    // Painters gone: Custom is withdrawn.
    modes.setMode("custom");
    surface.afterInvalidate({ code: "", painters: [], haps: [], time: 5 });
    assert.equal(modes.getMode(), "roll");
  });

  test("a painter that first draws on its context mid-play becomes a panel painter then", () => {
    env.resize(400, 180);
    const seen = [];
    // Draws only for sounding notes: at the probe instant there are none.
    const painter = (ctx, _time, haps) => {
      for (const h of haps) {
        ctx.fillRect(0, 0, 1, 1);
        seen.push(ctx === env.ctx);
      }
    };
    surface.afterInvalidate({ code: "", painters: [painter], haps: [], time: 0 });
    assert.equal(modes.getMode(), "roll", "nothing drawn yet, nothing offered");

    surface.draw([], 1);
    assert.equal(modes.getMode(), "roll");

    surface.draw([{}], 2);
    assert.equal(modes.getMode(), "custom", "offered on the first touch");
    assert.equal(seen.at(-1), true, "and painted on the panel in that same frame");

    // Asking the same pattern again during a rest does not take it back.
    surface.afterInvalidate({ code: "", painters: [painter], haps: [], time: 3, refill: true });
    assert.equal(modes.getMode(), "custom");
  });

  test("panel painters cannot leave canvas state behind", () => {
    env.resize(400, 180);
    const order = [];
    env.ctx.save = () => order.push("save");
    env.ctx.restore = () => order.push("restore");
    const painter = (ctx) => {
      ctx.globalAlpha = 0.2;
      order.push("paint");
    };
    surface.afterInvalidate({ code: "", painters: [painter], haps: [], time: 0 });
    order.length = 0;
    surface.draw([], 1);
    assert.deepEqual(order, ["save", "paint", "restore"]);
  });

  test("a repaint asked for right after the last live frame is deferred, not lost", async () => {
    modes.setMode("scope");
    env.resize(400, 180);
    surface.draw([], 1);
    scopeRenders.length = 0;
    env.frames.length = 0;
    surface.requestRepaint();
    assert.equal(env.frames.length, 0, "a live frame may still be coming");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(env.frames.length, 1);
    env.frames[0]();
    assert.equal(scopeRenders.length, 1);
  });

  test("a deferred repaint is dropped when live frames kept coming", async () => {
    modes.setMode("scope");
    env.resize(400, 180);
    surface.draw([], 1);
    env.frames.length = 0;
    surface.requestRepaint();
    await new Promise((resolve) => setTimeout(resolve, 20));
    surface.draw([], 1.1);
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(env.frames.length, 0);
  });

  test("after playback moved to another tab and stopped, roll clicks are called off", async () => {
    const code = 'bass: note("c2")';
    const at = code.indexOf("c2");
    const moves = [];
    const view = {
      state: { doc: { toString: () => code } },
      dispatch: (tr) => moves.push(tr),
      focus() {},
    };
    const frac = (n) => ({ valueOf: () => n });
    const note = {
      whole: { begin: frac(0), end: frac(4) },
      endClipped: frac(4),
      value: { note: "c2" },
      context: { locations: [{ start: at, end: at + 2 }] },
    };
    const listeners = {};
    env.canvas.addEventListener = (type, fn) => (listeners[type] = fn);
    let focused = true;
    let asked = 0;
    surface = createBottomCanvas({
      canvas: env.canvas,
      modes,
      scope: { render() {}, markDirty() {} },
      drawTime: [-2, 2],
      getView: () => view,
      isPlaying: () => playing,
      beforeLocate: () => asked++,
      isPlayingDocFocused: () => focused,
    });
    env.resize(800, 200);
    surface.afterInvalidate({ code, painters: [], haps: [], time: 0 });
    surface.draw([note], 0.5);
    // One row, so the pill spans the note area; click in its middle.
    const click = () => listeners.click({ offsetX: 500, offsetY: 90 });

    playing = true;
    focused = false;
    surface.handleDocSwap();
    await Promise.resolve();
    click();
    assert.equal(asked, 1, "while playing the host is asked to bring the tab forward");
    assert.equal(moves.length, 1);

    playing = false;
    click();
    assert.equal(asked, 1);
    assert.equal(moves.length, 1, "the other tab's offsets are not applied to this one");

    // The next evaluate runs the document in the editor.
    surface.afterInvalidate({ code, painters: [], haps: [note], time: 0 });
    click();
    assert.equal(moves.length, 2);
  });

  test("a tab swap while stopped empties the roll; while playing it is left alone", () => {
    env.resize(400, 180);
    surface.draw([], 2);
    assert.equal(surface.hasFrame(), true);
    playing = true;
    surface.handleDocSwap();
    assert.equal(surface.hasFrame(), true);
    playing = false;
    surface.handleDocSwap();
    assert.equal(surface.hasFrame(), false);
    surface.draw([], 0);
    assert.equal(surface.hasFrame(), true);
  });
});
