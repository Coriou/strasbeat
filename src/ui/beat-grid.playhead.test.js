import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { playheadXForCycle } from "./beat-grid.js";

describe("playheadXForCycle()", () => {
  test("0 cycle sits at x=0", () => {
    assert.equal(playheadXForCycle(0, 100), 0);
  });

  test("sweeps to end of lane at cycle == 1 (exclusive modulo)", () => {
    // 1 % 1 === 0, so the playhead wraps to the left edge exactly on the
    // downbeat — same behaviour as transport.js's playhead.
    assert.equal(playheadXForCycle(1, 160), 0);
  });

  test("halfway through a cycle lands at half the lane width", () => {
    assert.equal(playheadXForCycle(0.5, 160), 80);
    assert.equal(playheadXForCycle(2.5, 160), 80);
  });

  test("fractional cycles inside a period interpolate linearly", () => {
    assert.equal(playheadXForCycle(0.25, 400), 100);
    assert.equal(playheadXForCycle(0.75, 400), 300);
  });

  test("multi-cycle values fold into a single cycle", () => {
    // Scheduler.now() keeps counting across cycles — the grid expects one
    // cycle to fill the full lane, so anything past 1 must fold back.
    assert.equal(playheadXForCycle(3.25, 400), 100);
    assert.equal(playheadXForCycle(7.75, 400), 300);
  });

  test("handles negative cycles (pre-first-downbeat) via positive modulo", () => {
    // The scheduler can report small negative values during start-up
    // transients. Without the double-modulo guard JS's % operator yields
    // negative results and the playhead would jump off-screen.
    assert.equal(playheadXForCycle(-0.25, 400), 300);
    assert.equal(playheadXForCycle(-1.5, 400), 200);
  });

  test("returns 0 for non-finite cycle", () => {
    assert.equal(playheadXForCycle(NaN, 400), 0);
    assert.equal(playheadXForCycle(Infinity, 400), 0);
    assert.equal(playheadXForCycle(-Infinity, 400), 0);
  });

  test("returns 0 for non-positive lane width", () => {
    assert.equal(playheadXForCycle(0.5, 0), 0);
    assert.equal(playheadXForCycle(0.5, -50), 0);
    assert.equal(playheadXForCycle(0.5, NaN), 0);
  });

  test("scales correctly for different lane widths", () => {
    // Lanes of different resolutions (4/8/16 steps) all share the same
    // pixel width here — the rAF loop sees identical X across lanes at
    // any moment, even though the cell-count differs.
    for (const w of [100, 240, 480, 800]) {
      assert.equal(playheadXForCycle(0.5, w), w / 2);
    }
  });
});
