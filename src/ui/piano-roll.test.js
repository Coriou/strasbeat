// Run with: node --import ./scripts/test-register.mjs --test src/ui/piano-roll.test.js

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  compareRowValues,
  hitTest,
  mapRangeThroughEdit,
  renderRoll,
  resetRoll,
  setRollSource,
} from "./piano-roll.js";
import { PALETTE } from "./palette.js";

describe("mapRangeThroughEdit()", () => {
  const code = 'setcpm(30)\n$: s("bd sd")\n$: note("c e g")';
  const bd = code.indexOf("bd");

  test("unchanged text maps to itself", () => {
    assert.deepEqual(mapRangeThroughEdit(code, code, bd, bd + 2), {
      start: bd,
      end: bd + 2,
    });
  });

  test("an insertion above shifts the range by its length", () => {
    const edited = "// hello\n" + code;
    const mapped = mapRangeThroughEdit(code, edited, bd, bd + 2);
    assert.equal(edited.slice(mapped.start, mapped.end), "bd");
  });

  test("an edit below leaves the range where it was", () => {
    const edited = code.replace("c e g", "c e g b");
    assert.deepEqual(mapRangeThroughEdit(code, edited, bd, bd + 2), {
      start: bd,
      end: bd + 2,
    });
  });

  test("a deletion above shifts the range back", () => {
    const edited = code.replace("setcpm(30)\n", "");
    const mapped = mapRangeThroughEdit(code, edited, bd, bd + 2);
    assert.equal(edited.slice(mapped.start, mapped.end), "bd");
  });

  test("a range whose own text was edited has nowhere to go", () => {
    const edited = code.replace("bd", "hh");
    assert.equal(mapRangeThroughEdit(code, edited, bd, bd + 2), null);
  });

  test("a range between two separate edits is not guessed at", () => {
    const edited = "x" + code + "y";
    const g = code.indexOf("g");
    // "g" sits before the trailing edit but after the leading one.
    assert.equal(mapRangeThroughEdit(code, edited.replace("sd", "cp"), g, g + 1), null);
  });

  test("a different document does not produce a range", () => {
    assert.equal(mapRangeThroughEdit(code, 'note("a b")', bd, bd + 2), null);
  });

  test("out-of-bounds and inverted ranges are rejected", () => {
    assert.equal(mapRangeThroughEdit(code, code, 5, code.length + 1), null);
    assert.equal(mapRangeThroughEdit(code, code, 9, 4), null);
    assert.equal(mapRangeThroughEdit(code, code, -1, 4), null);
  });
});

describe("hitTest()", () => {
  const hits = [
    { x: 0, y: 0, w: 10, h: 10, info: "a" },
    { x: 5, y: 5, w: 10, h: 10, info: "b" },
    { x: 100, y: 100, w: 10, h: 10, info: "stale" },
  ];

  test("returns the topmost (last drawn) rectangle under the point", () => {
    assert.equal(hitTest(hits, 2, 7, 7).info, "b");
    assert.equal(hitTest(hits, 2, 2, 2).info, "a");
  });

  test("edges are inclusive", () => {
    assert.equal(hitTest(hits, 2, 15, 15).info, "b");
  });

  test("ignores pooled entries beyond the live count", () => {
    assert.equal(hitTest(hits, 2, 105, 105), null);
    assert.equal(hitTest(hits, 0, 2, 2), null);
  });
});

describe("compareRowValues()", () => {
  test("drum names come first, then pitches ascending", () => {
    const rows = [64, "_sd", 60, "_bd", 67].sort(compareRowValues);
    assert.deepEqual(rows, ["_bd", "_sd", 60, 64, 67]);
  });
});

// ─── renderRoll against a recording context ──────────────────────────────

function makeCtx() {
  const fills = []; // { color, alpha } per path fill()
  const ctx = {
    fillStyle: "#000",
    strokeStyle: "#000",
    globalAlpha: 1,
    lineWidth: 1,
    font: "",
    textBaseline: "",
    textAlign: "",
    fills,
    labels: [],
    gradients: 0,
    fill() {
      fills.push({ color: this.fillStyle, alpha: this.globalAlpha });
    },
    fillText(text) {
      this.labels.push(text);
    },
    createLinearGradient() {
      this.gradients++;
      return { addColorStop() {} };
    },
  };
  for (const name of [
    "setTransform", "fillRect", "save", "restore", "beginPath", "rect",
    "clip", "moveTo", "lineTo", "stroke", "roundRect", "clearRect",
  ]) {
    ctx[name] = () => {};
  }
  const listeners = {};
  ctx.canvas = {
    width: 800,
    height: 200,
    style: { cursor: "" },
    listeners,
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  return ctx;
}

const frac = (n) => ({ valueOf: () => n });
function hap({ begin, end, value, loc }) {
  return {
    whole: { begin: frac(begin), end: frac(end) },
    get endClipped() {
      return frac(end);
    },
    value,
    context: loc ? { locations: [{ start: loc[0], end: loc[1] }] } : {},
  };
}

const code = 'bass: note("c2")\nlead: note("e4 g4")';
const view = (text) => {
  const calls = [];
  return {
    calls,
    state: { doc: { toString: () => text } },
    dispatch: (tr) => calls.push(tr),
    focus() {},
  };
};

describe("renderRoll()", () => {
  beforeEach(() => {
    globalThis.window = { devicePixelRatio: 1 };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  });

  const frame = (ctx, haps, extra = {}) =>
    renderRoll({
      haps,
      time: 0.5,
      ctx,
      drawTime: [-2, 2],
      view: null,
      width: 800,
      height: 200,
      dpr: 1,
      ...extra,
    });

  test("colours follow the labels of the evaluated code, not the live document", () => {
    const ctx = makeCtx();
    setRollSource(ctx.canvas, code);
    const lead = code.indexOf("e4");
    // Second label first: first-seen order would hand out the colours the
    // other way round.
    const haps = [
      hap({ begin: 0, end: 0.5, value: { note: "e4" }, loc: [lead, lead + 2] }),
      hap({ begin: 0, end: 1, value: { note: "c2" }, loc: [code.indexOf("c2"), code.indexOf("c2") + 2] }),
    ];
    // The editor meanwhile shows something else entirely.
    frame(ctx, haps, { view: view('other: s("bd")') });
    assert.deepEqual(
      ctx.fills.map((f) => f.color),
      [PALETTE[1], PALETTE[0]],
    );
  });

  test("a colour set on the hap wins over the layer colour", () => {
    const ctx = makeCtx();
    setRollSource(ctx.canvas, code);
    frame(ctx, [
      hap({ begin: 0, end: 1, value: { note: "c2", color: "cyan" }, loc: [12, 14] }),
    ]);
    assert.equal(ctx.fills[0].color, "cyan");
  });

  test("dynamics scale the pill alpha multiplicatively, with no floor", () => {
    const ctx = makeCtx();
    frame(ctx, [
      hap({ begin: 0, end: 1, value: { note: 60 } }), // active, full
      hap({ begin: 0, end: 1, value: { note: 62, velocity: 0.5, gain: 0.5 } }), // active, quiet
      hap({ begin: 1, end: 1.5, value: { note: 64, gain: 0.1 } }), // inactive, very quiet
      hap({ begin: 1, end: 1.5, value: { note: 65, gain: 3 } }), // inactive, clamped
    ]);
    const alphas = ctx.fills.map((f) => f.alpha);
    assert.equal(alphas[0], 0.92);
    assert.equal(alphas[1], 0.92 * 0.25);
    assert.ok(Math.abs(alphas[2] - 0.035) < 1e-12);
    assert.equal(alphas[3], 0.35);
  });

  test("per-hap data is derived once, however many frames draw the hap", () => {
    const ctx = makeCtx();
    let reads = 0;
    const h = hap({ begin: 0, end: 1, value: { note: 60 } });
    const counted = {
      whole: h.whole,
      get endClipped() {
        reads++;
        return frac(1);
      },
      value: h.value,
      context: {},
    };
    for (let i = 0; i < 5; i++) frame(ctx, [counted]);
    assert.equal(reads, 1);
    assert.equal(ctx.fills.length, 5);
    assert.equal(ctx.gradients, 1, "the playhead glow is built once");
  });

  test("off-screen haps and haps without a row are skipped", () => {
    const ctx = makeCtx();
    frame(ctx, [
      hap({ begin: 10, end: 11, value: { note: 60 } }),
      hap({ begin: 0, end: 1, value: {} }),
      hap({ begin: 0, end: 1, value: { s: "bd" } }),
    ]);
    assert.equal(ctx.fills.length, 1);
    assert.ok(ctx.labels.includes("bd"));
  });

  test("a click moves the cursor to the note's source, mapped through later edits", () => {
    const ctx = makeCtx();
    setRollSource(ctx.canvas, code);
    const at = code.indexOf("c2");
    const edited = "// intro\n" + code;
    const v = view(edited);
    let asked = 0;
    frame(ctx, [hap({ begin: 0, end: 4, value: { note: "c2" }, loc: [at, at + 2] })], {
      view: v,
      beforeLocate: () => asked++,
    });
    // One row, so the pill spans the note area; click in its middle.
    ctx.canvas.listeners.click({ offsetX: 500, offsetY: 90 });
    assert.equal(asked, 1);
    assert.equal(v.calls.length, 1);
    const { anchor, head } = v.calls[0].selection;
    assert.equal(edited.slice(anchor, head), "c2");
  });

  test("a click the host calls off moves nothing and is not reported as a failure", () => {
    const ctx = makeCtx();
    setRollSource(ctx.canvas, code);
    const at = code.indexOf("c2");
    const v = view(code);
    let repaints = 0;
    frame(ctx, [hap({ begin: 0, end: 4, value: { note: "c2" }, loc: [at, at + 2] })], {
      view: v,
      beforeLocate: () => false,
      requestRepaint: () => repaints++,
    });
    const before = repaints;
    ctx.canvas.listeners.click({ offsetX: 500, offsetY: 90 });
    assert.equal(v.calls.length, 0);
    assert.equal(repaints, before, "no error flash");
  });

  test("a click on a note whose source was edited away changes nothing", () => {
    const ctx = makeCtx();
    setRollSource(ctx.canvas, code);
    const at = code.indexOf("c2");
    const v = view(code.replace("c2", "d2"));
    let repaints = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
      frame(ctx, [hap({ begin: 0, end: 4, value: { note: "c2" }, loc: [at, at + 2] })], {
        view: v,
        requestRepaint: () => repaints++,
      });
      ctx.canvas.listeners.click({ offsetX: 500, offsetY: 90 });
    } finally {
      console.warn = warn;
    }
    assert.equal(v.calls.length, 0);
    assert.ok(repaints > 0, "asks for a repaint so the refusal is visible");
  });

  test("resetRoll() drops the rows and the hit map", () => {
    const ctx = makeCtx();
    setRollSource(ctx.canvas, code);
    const v = view(code);
    frame(ctx, [hap({ begin: 0, end: 4, value: { note: "c2" }, loc: [12, 14] })], { view: v });
    resetRoll(ctx.canvas);
    ctx.canvas.listeners.click({ offsetX: 500, offsetY: 90 });
    assert.equal(v.calls.length, 0);
    ctx.labels.length = 0;
    frame(ctx, [], { view: v });
    assert.ok(!ctx.labels.includes("C2"));
  });
});
