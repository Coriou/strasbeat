// Drawer lifecycle, highlight transactions, escape hatch and failure handling.
// Fake rAF callbacks are stepped explicitly; no browser or clock runs here.
import test from "node:test";
import assert from "node:assert/strict";
import { mini } from "@strudel/mini";
import { Drawer } from "../node_modules/@strudel/draw/draw.mjs";
import {
  FrameLoop,
  highlightSignature,
  installFrameLoop,
} from "./frame-loop.js";
import { installLegacyDrawer } from "./legacy-drawer.js";
import { flagEnabled } from "./flags.js";

function harness(pattern = mini("c").note().slow(8)) {
  let time = 0;
  let reads = 0;
  let nextId = 0;
  const pending = new Map();
  const highlights = [];
  const draws = [];
  const invalidates = [];
  const errors = [];
  const scheduler = {
    pattern,
    cps: 0.5,
    started: true,
    now() {
      reads++;
      return time;
    },
  };
  const editor = {
    highlight: (haps, time) => highlights.push({ haps, time }),
    onDraw: (haps, time, painters) => draws.push({ haps, time, painters }),
  };
  const loop = new FrameLoop({
    editor,
    drawTime: [-2, 2],
    afterInvalidate: (time, refill) => invalidates.push({ time, refill }),
    onError: (error) => errors.push(error),
    requestFrame(fn) {
      pending.set(++nextId, fn);
      return nextId;
    },
    cancelFrame(id) {
      pending.delete(id);
    },
  });
  return {
    loop,
    editor,
    scheduler,
    highlights,
    draws,
    invalidates,
    pending,
    errors,
    setTime(t) {
      time = t;
    },
    step(ms) {
      assert.equal(pending.size, 1, "exactly one queued frame");
      const [[id, fn]] = pending;
      pending.delete(id);
      time = (ms / 1000) * scheduler.cps;
      reads = 0;
      fn(ms);
      assert.equal(reads, 1, "scheduler.now is read once per frame");
    },
  };
}

test("surface fills synchronously, starts once, stops without losing the last snapshot", () => {
  const h = harness();
  h.scheduler.started = false;
  h.loop.invalidate(h.scheduler, -0.001);
  assert.ok(h.loop.visibleHaps.length);
  assert.equal(h.pending.size, 0);
  assert.deepEqual(h.invalidates, [{ time: -0.001, refill: false }]);
  h.loop.setDrawTime([0, 0]);
  assert.deepEqual(h.loop.drawTime, [-2, 2], "roll still demands four cycles");
  h.scheduler.started = true;
  h.loop.start(h.scheduler);
  h.loop.start(h.scheduler);
  h.step(0);
  const snapshot = h.loop.visibleHaps;
  h.loop.stop();
  assert.equal(h.pending.size, 0);
  assert.equal(h.loop.visibleHaps, snapshot);
  assert.deepEqual(h.highlights.at(-1).haps, []);
  h.loop.start(h.scheduler);
  h.step(0);
  assert.equal(h.highlights.length, 3, "restart resets highlight signature");
});

test("unchanged frames skip highlight; keep-alive is at most four per second", () => {
  const h = harness();
  h.loop.start(h.scheduler);
  h.step(0);
  h.step(1000 / 120);
  assert.equal(h.highlights.length, 1);
  for (let frame = 2; frame < 120; frame++) h.step((frame * 1000) / 120);
  assert.equal(h.highlights.length, 4);
  assert.equal(h.draws.length, 120);
  h.loop.invalidate(h.scheduler);
  h.step(1000);
  assert.equal(h.highlights.length, 5, "invalidate forces a refresh");
});

test("highlights change on the exact inclusive active boundary, including color and markcss", () => {
  const h = harness(
    mini("c e")
      .note()
      .withContext(() => ({ locations: [{ start: 0, end: 1 }] }))
      .color("red"),
  );
  h.loop.start(h.scheduler);
  h.step(0);
  h.step(990);
  const before = h.highlights.length;
  h.step(1000);
  assert.equal(
    h.loop.window.activeHaps.length,
    2,
    "endClipped equality is active",
  );
  assert.equal(
    h.highlights.length,
    before,
    "same winning style needs no dispatch",
  );
  h.scheduler.pattern = mini("c e")
    .note()
    .withContext(() => ({ locations: [{ start: 0, end: 1 }] }))
    .color("blue");
  h.loop.invalidate(h.scheduler);
  h.step(1010);
  assert.equal(h.highlights.length, before + 1);
});

test("signature chooses latest onset, first on ties, stable ids and effective CSS", () => {
  const record = (begin, color, markcss, start = 0) => ({
    begin,
    hap: {
      context: { locations: [{ start, end: start + 2 }] },
      value: { color, markcss },
    },
  });
  const red = record(0, "red");
  const blue = record(1, "blue");
  assert.equal(highlightSignature([red, blue]), highlightSignature([blue]));
  assert.equal(
    highlightSignature([blue, record(1, "green")]),
    highlightSignature([blue]),
  );
  assert.notEqual(highlightSignature([red]), highlightSignature([blue]));
  assert.equal(
    highlightSignature([record(1, "red", "opacity: .5")]),
    highlightSignature([record(1, "blue", "opacity: .5")]),
  );
  assert.notEqual(
    highlightSignature([red]),
    highlightSignature([record(0, "red", null, 3)]),
  );
});

test("frame errors report once and retain a single live loop; evaluate allows recovery", () => {
  const h = harness();
  h.loop.start(h.scheduler);
  const warning = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    h.editor.onDraw = () => {
      throw new Error("broken painter");
    };
    h.step(0);
    h.step(10);
    h.step(20);
    assert.equal(h.errors.length, 1);
    assert.equal(warnings.length, 1);
    h.loop.invalidate(h.scheduler);
    h.step(30);
    assert.equal(h.errors.length, 2);
    h.loop.stop();
    assert.equal(h.pending.size, 0);
  } finally {
    console.warn = warning;
  }
});

test("demand while stopped uses kept time and leaves a switched tab blank", () => {
  const h = harness(mini("a b c d"));
  h.loop.start(h.scheduler);
  h.step(6000);
  h.loop.setHapDemand(false, { time: 3, hasFrame: true });
  h.loop.stop();
  h.scheduler.started = false;
  h.setTime(100);
  const draws = h.draws.length;
  h.loop.setHapDemand(true, { time: 3, hasFrame: false });
  assert.equal(h.draws.length, draws);
  h.loop.setHapDemand(false, { time: 3, hasFrame: true });
  h.loop.setHapDemand(true, { time: 3, hasFrame: true });
  assert.equal(h.draws.at(-1).time, 3);
  assert.ok(h.loop.visibleHaps.some((hap) => Number(hap.whole.begin) < 2));
  assert.equal(h.pending.size, 0);
});

test("flag off retains real upstream objects and installs the legacy interception", () => {
  const values = new Map();
  const storage = () => ({
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  });
  const drawer = new Drawer(() => {}, [-2, 2]);
  const framer = drawer.framer;
  const editor = { drawer, repl: { scheduler: null } };
  const enabled = flagEnabled("frameloop", {
    search: "?sb-frameloop=off",
    storage,
  });
  assert.equal(installFrameLoop(editor, { enabled }), drawer);
  assert.equal(flagEnabled("frameloop", { search: "", storage }), false);
  installLegacyDrawer(
    editor,
    { wantsHapWindow: () => false, setOnHapDemandChange() {} },
    [-2, 2],
  );
  editor.drawer.setDrawTime([0, 0]);
  assert.equal(editor.drawer, drawer);
  assert.equal(editor.drawer.framer, framer);
  assert.deepEqual(editor.drawer.drawTime, [0, 0]);
  assert.equal(
    flagEnabled("frameloop", { search: "?sb-frameloop=on", storage }),
    true,
  );
  assert.ok(
    installFrameLoop(editor, { enabled: true, drawTime: [-2, 2] }) instanceof
      FrameLoop,
  );
});
