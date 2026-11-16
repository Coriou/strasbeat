// Numeric-window equivalence and query-cost contracts, using installed Strudel.
// Upstream's invalidate overscans and keeps fragments of notes already under
// way (a second copy of a note it has, or the only copy of a new pattern's
// note); the roll draws a fragment at its whole extent, like any note. So the
// comparison is by note — whole span and value — inside the requested window,
// and our snapshots are separately required to hold each note once.
import test from "node:test";
import assert from "node:assert/strict";
import { stack, Hap } from "@strudel/core";
import { mini } from "@strudel/mini";
import { Drawer } from "../node_modules/@strudel/draw/draw.mjs";
import { installLegacyDrawer } from "./legacy-drawer.js";
import { HapWindow } from "./hap-window.js";
import { createUniformDeriver } from "./strudel-ext/uniforms.js";

globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

function keys(haps) {
  return [
    ...new Set(
      haps.map((hap) =>
        JSON.stringify([
          Number(hap.whole.begin),
          Number(hap.whole.end),
          hap.value,
        ]),
      ),
    ),
  ].sort();
}
function visible(haps, time, dt) {
  return haps.filter(
    (h) =>
      h.whole &&
      Number(h.whole.begin) <= time + dt[1] &&
      Number(h.endClipped) >= time - Math.abs(dt[0]),
  );
}
function assertSame(window, drawer, time) {
  assert.deepEqual(
    keys(window.visibleHaps),
    keys(visible(drawer.visibleHaps, time, window.drawTime)),
    `visible at ${time}`,
  );
  assert.deepEqual(
    keys(window.activeHaps),
    keys(drawer.visibleHaps.filter((h) => h.whole && h.isActive(time))),
    `active at ${time}`,
  );
  assert.equal(
    keys(window.visibleHaps).length,
    window.visibleHaps.length,
    "no duplicated onsets",
  );
}
const patterns = {
  stack: () => stack(mini("c e g").note(), mini("bd sd*2").s()),
  alternation: () => mini("<a b>"),
  long: () => mini("c").note().slow(4).clip(1.5),
  struct: () => mini("c e").note().struct(mini("1 0 1 1")),
  degrade: () => mini("bd? sd? hh*4?").s(), // mini's deterministic time seed
  color: () => mini("c e g").note().color("red"),
};
for (const [name, make] of Object.entries(patterns)) {
  for (const dt of [
    [-2, 2],
    [0, 0],
  ]) {
    test(`${name}: upstream onset/active sets at 120 Hz, window ${dt}`, () => {
      let time = 0;
      const pattern = make();
      const scheduler = { pattern, cps: 0.5, now: () => time };
      const drawer = new Drawer(() => {}, dt);
      const window = new HapWindow(dt);
      drawer.start(scheduler);
      drawer.framer.onFrame();
      window.invalidate(pattern, time, scheduler.cps);
      // Offset from rational onsets: upstream's half-open right edge admits
      // exact boundary onsets a frame late; our explicit <= contract does not.
      for (let frame = 1; frame <= 120 * 10; frame++) {
        time = frame / 240 + 0.000001;
        drawer.framer.onFrame();
        window.advance(pattern, time, scheduler.cps);
        assertSame(window, drawer, time);
      }
    });
  }
}

test("invalidate replaces future notes but preserves past notes", () => {
  let time = 0;
  const scheduler = { pattern: mini("a b c d"), cps: 0.5, now: () => time };
  const drawer = new Drawer(() => {}, [-2, 2]);
  const window = new HapWindow();
  drawer.start(scheduler);
  drawer.framer.onFrame();
  window.invalidate(scheduler.pattern, time, scheduler.cps);
  for (let frame = 1; frame <= 600; frame++) {
    time = frame / 240 + 0.000001;
    if (frame === 240) {
      scheduler.pattern = mini("x y z");
      drawer.invalidate(scheduler, time);
      window.invalidate(scheduler.pattern, time, scheduler.cps);
      assert.ok(window.visibleHaps.some((h) => h.value === "a"));
      assert.ok(window.visibleHaps.some((h) => h.value === "y"));
    }
    drawer.framer.onFrame();
    window.advance(scheduler.pattern, time, scheduler.cps);
    assertSame(window, drawer, time);
  }
});

test("boot fills synchronously, discovers painters, and hides prefetched haps", () => {
  const painter = () => {};
  const pattern = mini("a*16").onPaint(painter);
  const window = new HapWindow();
  window.invalidate(pattern, -0.001, 0.5);
  assert.ok(window.visibleHaps.length > 0);
  assert.ok(window.painters.includes(painter));
  assert.equal(window.activeHaps.length, 0);
  assert.ok(window.visibleHaps.every((h) => Number(h.whole.begin) <= 1.999));
  assert.ok(window.records.some((r) => r.begin > 1.999));
});

test("demand refills the past, does not double queue, and respects stopped blank tabs", () => {
  const pattern = mini("a b c d");
  const window = new HapWindow();
  window.invalidate(pattern, 0, 0.5);
  window.advance(pattern, 3, 0.5);
  assert.equal(
    window.setRollDemand(false, pattern, 3, 0.5, {
      playing: true,
      hasFrame: true,
    }),
    true,
  );
  assert.deepEqual(window.drawTime, [0, 0]);
  window.advance(pattern, 3.01, 0.5);
  window.setRollDemand(true, pattern, 3.01, 0.5, {
    playing: true,
    hasFrame: true,
  });
  assert.ok(window.visibleHaps.some((h) => Number(h.whole.begin) < 2));
  for (let frame = 0; frame < 120; frame++) {
    window.advance(pattern, 3.01 + frame / 240, 0.5);
    assert.equal(keys(window.visibleHaps).length, window.visibleHaps.length);
  }
  window.setRollDemand(false, pattern, 3.6, 0.5, {
    playing: false,
    hasFrame: true,
  });
  const snapshot = window.visibleHaps;
  assert.equal(
    window.setRollDemand(true, pattern, 3.6, 0.5, {
      playing: false,
      hasFrame: false,
    }),
    false,
  );
  assert.equal(window.visibleHaps, snapshot);
  window.setDrawTime([-2, 2]);
  window.setRollDemand(false, pattern, 3.6, 0.5, {
    playing: true,
    hasFrame: true,
  });
  assert.deepEqual(window.drawTime, [-2, 2], "painters demand the wide window");
});

test("backward and forward jumps refill only the new visible window", () => {
  const base = mini("a b c d");
  const arcs = [];
  const pattern = {
    queryArc(a, b, controls) {
      arcs.push([a, b]);
      return base.queryArc(a, b, controls);
    },
  };
  const window = new HapWindow();
  window.invalidate(pattern, 0, 0.5);
  for (const time of [2, 1000, 0, 5]) {
    window.advance(pattern, time, 0.5);
    const [begin, end] = arcs.at(-1);
    assert.ok(end - begin < 4.1);
    const reference = base.queryArc(Math.max(0, time - 2), time + 2 + 0.001);
    assert.deepEqual(
      keys(window.visibleHaps),
      keys(visible(reference, time, [-2, 2])),
    );
  }
});

for (const cps of [0.1, 0.5, 2, 8]) {
  test(`query rate and exact shared boundaries at ${cps} cps`, () => {
    const base = mini("a b");
    const arcs = [];
    const pattern = {
      queryArc(a, b, controls) {
        arcs.push([a, b]);
        return base.queryArc(a, b, controls);
      },
    };
    const window = new HapWindow([0, 0]);
    window.invalidate(pattern, 0, cps);
    for (let frame = 1; frame <= 1200; frame++)
      window.advance(pattern, (frame / 120) * cps, cps);
    assert.ok(
      arcs.length >= 55 && arcs.length <= 62,
      `${arcs.length} queries / 10s`,
    );
    for (let i = 1; i < arcs.length; i++)
      assert.equal(arcs[i][0], arcs[i - 1][1]);
  });
}

test("quiet frames reuse snapshots and never read Hap timing getters", () => {
  const window = new HapWindow();
  const pattern = mini("c").note();
  window.invalidate(pattern, 0, 0.5);
  window.advance(pattern, 0.01, 0.5);
  const visible = window.visibleHaps;
  const active = window.activeHaps;
  const descriptors = ["duration", "endClipped"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(Hap.prototype, name),
  ]);
  try {
    for (const [name] of descriptors)
      Object.defineProperty(Hap.prototype, name, {
        configurable: true,
        get() {
          throw new Error(`frame read ${name}`);
        },
      });
    window.advance(pattern, 0.02, 0.5);
    assert.equal(window.visibleHaps, visible);
    assert.equal(window.activeHaps, active);
  } finally {
    for (const [name, descriptor] of descriptors)
      Object.defineProperty(Hap.prototype, name, descriptor);
  }
});

test("shader pulses at onsets once, never at prefetch, in wide and narrow windows", () => {
  for (const dt of [
    [-2, 2],
    [0, 0],
  ]) {
    const pattern = mini("bd sd").s();
    const window = new HapWindow(dt);
    const deriver = createUniformDeriver();
    window.invalidate(pattern, 0, 0.5);
    let previousKick = 0;
    let previousSnare = 0;
    let kicks = 0;
    let snares = 0;
    for (let frame = 0; frame < 480; frame++) {
      const time = frame / 240;
      window.advance(pattern, time, 0.5);
      const values = deriver.frame(window.visibleHaps, time, 1 / 120);
      if (values.uKick > previousKick) {
        kicks++;
        assert.equal(time % 1, 0);
      }
      if (values.uSnare > previousSnare) {
        snares++;
        assert.equal(time % 1, 0.5);
      }
      previousKick = values.uKick ?? 0;
      previousSnare = values.uSnare ?? 0;
    }
    assert.equal(kicks, 2);
    assert.equal(snares, 2);
  }
});

test("long notes survive narrow refills, forward gaps and restarts without querying the gap", () => {
  const base = mini("c").note().slow(100);
  const arcs = [];
  const pattern = {
    queryArc(a, b, controls) {
      arcs.push([a, b]);
      return base.queryArc(a, b, controls);
    },
  };
  const window = new HapWindow();
  window.invalidate(pattern, 0, 0.5);
  window.advance(pattern, 25, 0.5);
  assert.equal(window.activeHaps.length, 1);
  window.setRollDemand(false, pattern, 25, 0.5, {
    playing: true,
    hasFrame: true,
  });
  assert.equal(window.activeHaps.length, 1);
  window.advance(pattern, 350, 0.5);
  assert.equal(window.activeHaps.length, 1);
  assert.equal(Number(window.activeHaps[0].whole.begin), 300);
  window.advance(pattern, 0, 0.5);
  assert.equal(window.activeHaps.length, 1);
  assert.equal(Number(window.activeHaps[0].whole.begin), 0);
  assert.ok(arcs.every(([a, b]) => b - a < 4.1));
});

test("painter demand changes on evaluate still retain past notes", () => {
  const window = new HapWindow();
  const oldPattern = mini("a b c d");
  window.invalidate(oldPattern, 0, 0.5);
  window.advance(oldPattern, 0.3, 0.5);
  window.rollDemand = false;
  window.setDrawTime([0, 0]);
  window.invalidate(mini("x y z"), 0.3, 0.5);
  assert.ok(window.activeHaps.some((h) => h.value === "b"));
  // The new pattern's "x" began at 0 and is under way at 0.3: upstream lights
  // it at once (its invalidate keeps the fragment), so the highlight follows
  // the code that was just evaluated. So do we.
  assert.ok(window.activeHaps.some((h) => h.value === "x"));
});

test("demand transitions match the upstream Drawer with the existing adapter", () => {
  let time = 0;
  let wide = true;
  let demandChanged;
  const pattern = mini("a b c d");
  const scheduler = { pattern, cps: 0.5, started: true, now: () => time };
  const drawer = new Drawer(() => {}, [-2, 2]);
  const editor = { drawer, repl: { scheduler, state: { activeCode: "" } } };
  installLegacyDrawer(
    editor,
    {
      wantsHapWindow: () => wide,
      setOnHapDemandChange(fn) {
        demandChanged = fn;
      },
      afterInvalidate() {},
      hasFrame: () => true,
      getLastTime: () => time,
      draw() {},
    },
    [-2, 2],
  );
  drawer.setDrawTime([0, 0]);
  drawer.start(scheduler);
  drawer.framer.onFrame();
  const window = new HapWindow();
  window.invalidate(pattern, time, 0.5);
  for (let frame = 1; frame <= 480; frame++) {
    time = frame / 240 + 0.000001;
    if (frame === 120 || frame === 300) {
      wide = !wide;
      demandChanged(wide);
      window.setRollDemand(wide, pattern, time, 0.5, {
        playing: true,
        hasFrame: true,
      });
    }
    drawer.framer.onFrame();
    window.advance(pattern, time, 0.5);
    assertSame(window, drawer, time);
  }
});

test("a clock that slips back by a rounding error is not a jump", () => {
  const pattern = mini("a b c d");
  const window = new HapWindow();
  window.invalidate(pattern, 0, 0.5);
  window.advance(pattern, 1, 0.5);
  let queries = 0;
  const query = pattern.queryArc.bind(pattern);
  pattern.queryArc = (...args) => {
    queries++;
    return query(...args);
  };
  const snapshot = window.visibleHaps;
  window.advance(pattern, 1 - 1e-12, 0.5);
  assert.equal(queries, 0, "no refill");
  assert.equal(window.visibleHaps, snapshot);
  assert.equal(window.time, 1);
  // A real step back still re-anchors.
  window.advance(pattern, 0.5, 0.5);
  assert.ok(queries > 0);
});

test("a new pattern's note already under way at the evaluate is shown from its start", () => {
  const before = mini("a b c d");
  const window = new HapWindow();
  window.invalidate(before, 0, 0.5);
  window.advance(before, 1.25, 0.5);
  // One note per four cycles: at 1.25 it began at 0 and runs to 4.
  const drone = mini("x").slow(4);
  window.invalidate(drone, 1.25, 0.5);
  const shown = window.visibleHaps.filter((h) => h.value === "x");
  assert.equal(shown.length, 1);
  assert.equal(Number(shown[0].whole.begin), 0);
  assert.ok(window.activeHaps.includes(shown[0]), "and counts as sounding");
  // Past notes of the old pattern stay, as before.
  assert.ok(window.visibleHaps.some((h) => h.value === "a"));
  // Evaluating the same pattern again does not double it.
  window.invalidate(drone, 1.5, 0.5);
  assert.equal(window.visibleHaps.filter((h) => h.value === "x").length, 1);
});

test("a stopped clock (setcps(0)) is not an error", () => {
  const pattern = mini("a b c d");
  const window = new HapWindow();
  window.invalidate(pattern, 0.3, 0);
  assert.ok(window.visibleHaps.some((h) => h.value === "b"));
  // Time stands still: frames come and go, nothing moves, nothing throws.
  const snapshot = window.visibleHaps;
  for (let frame = 0; frame < 10; frame++) window.advance(pattern, 0.3, 0);
  assert.equal(window.visibleHaps, snapshot);
  // And it picks up again when the tempo does.
  window.advance(pattern, 0.4, 0.5);
  assert.ok(window.activeHaps.some((h) => h.value === "b"));
});
