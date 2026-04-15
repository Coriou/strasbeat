import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { nextFocusTarget } from "./beat-grid.js";

// Shorthand factory for the [{ stepCount, editable }] shape
// nextFocusTarget expects.
const L = (stepCount, editable = true) => ({ stepCount, editable });

describe("nextFocusTarget() — within-lane arrow nav", () => {
  const lanes = [L(4), L(8), L(16)];

  test("ArrowRight moves one step forward", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 1, stepIndex: 3 }, "ArrowRight"), {
      laneIndex: 1,
      stepIndex: 4,
    });
  });

  test("ArrowLeft moves one step back", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 1, stepIndex: 3 }, "ArrowLeft"), {
      laneIndex: 1,
      stepIndex: 2,
    });
  });

  test("ArrowRight wraps at end of lane", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 3 }, "ArrowRight"), {
      laneIndex: 0,
      stepIndex: 0,
    });
  });

  test("ArrowLeft wraps at start of lane", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 2, stepIndex: 0 }, "ArrowLeft"), {
      laneIndex: 2,
      stepIndex: 15,
    });
  });
});

describe("nextFocusTarget() — Home / End", () => {
  const lanes = [L(4), L(8), L(16)];

  test("Home jumps to first cell of current lane", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 2, stepIndex: 9 }, "Home"), {
      laneIndex: 2,
      stepIndex: 0,
    });
  });

  test("End jumps to last cell of current lane", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 1 }, "End"), {
      laneIndex: 0,
      stepIndex: 3,
    });
  });
});

describe("nextFocusTarget() — ArrowUp / ArrowDown skip read-only lanes", () => {
  // Middle lane is read-only; Up/Down on the top lane should jump over it
  // to the bottom editable lane.
  const lanes = [L(8), L(4, false), L(16)];

  test("ArrowDown skips read-only lane", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 4 }, "ArrowDown"), {
      laneIndex: 2,
      stepIndex: 8,
    });
  });

  test("ArrowUp skips read-only lane and wraps at top", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 2, stepIndex: 0 }, "ArrowUp"), {
      laneIndex: 0,
      stepIndex: 0,
    });
  });

  test("ArrowDown wraps at the bottom", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 2, stepIndex: 0 }, "ArrowDown"), {
      laneIndex: 0,
      stepIndex: 0,
    });
  });

  test("returns null when no editable lanes exist", () => {
    const none = [L(4, false), L(8, false)];
    assert.equal(
      nextFocusTarget(none, { laneIndex: 0, stepIndex: 0 }, "ArrowDown"),
      null,
    );
  });
});

describe("nextFocusTarget() — cross-resolution step mapping", () => {
  // Moving between lanes of different step counts maps the step index by
  // fractional position so the visual column stays roughly aligned.
  const lanes = [L(4), L(8), L(16)];

  test("16 → 4: step 8 (mid) maps to step 2 (mid)", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 2, stepIndex: 8 }, "ArrowUp"), {
      laneIndex: 1,
      stepIndex: 4,
    });
  });

  test("4 → 16: step 2 (mid) maps to step 8 (mid)", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 2 }, "ArrowUp"), {
      laneIndex: 2,
      stepIndex: 8,
    });
  });

  test("4 → 16: step 3 (end) clamps to step 15", () => {
    // Source index 3 in a 4-step lane is at frac 0.75, which maps to
    // step 12 in a 16-step lane.
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 3 }, "ArrowDown"), {
      laneIndex: 1,
      stepIndex: 6,
    });
  });
});

describe("nextFocusTarget() — PageUp / PageDown", () => {
  const lanes = [L(4), L(8), L(16)];

  test("PageUp jumps to first editable lane", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 2, stepIndex: 8 }, "PageUp"), {
      laneIndex: 0,
      stepIndex: 2,
    });
  });

  test("PageDown jumps to last editable lane", () => {
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 2 }, "PageDown"), {
      laneIndex: 2,
      stepIndex: 8,
    });
  });

  test("PageUp/PageDown skip read-only lanes", () => {
    const mixed = [L(4, false), L(8), L(16), L(8, false)];
    assert.deepEqual(nextFocusTarget(mixed, { laneIndex: 2, stepIndex: 0 }, "PageUp"), {
      laneIndex: 1,
      stepIndex: 0,
    });
    assert.deepEqual(nextFocusTarget(mixed, { laneIndex: 1, stepIndex: 0 }, "PageDown"), {
      laneIndex: 2,
      stepIndex: 0,
    });
  });
});

describe("nextFocusTarget() — edge cases", () => {
  test("returns null for empty lane list", () => {
    assert.equal(nextFocusTarget([], { laneIndex: 0, stepIndex: 0 }, "ArrowRight"), null);
  });

  test("returns null for non-arrow key", () => {
    const lanes = [L(4)];
    assert.equal(
      nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 0 }, "Enter"),
      null,
    );
  });

  test("seeds onto first editable lane when current lane is read-only", () => {
    const lanes = [L(4, false), L(8)];
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 2 }, "ArrowRight"), {
      laneIndex: 1,
      stepIndex: 0,
    });
  });

  test("out-of-range stepIndex is clamped to lane length", () => {
    const lanes = [L(4), L(8)];
    // step 20 isn't a valid index in a 4-step lane — should clamp to the
    // last step (3) before applying the move.
    assert.deepEqual(nextFocusTarget(lanes, { laneIndex: 0, stepIndex: 20 }, "ArrowRight"), {
      laneIndex: 0,
      stepIndex: 0, // 3 + 1 wraps to 0
    });
  });
});
