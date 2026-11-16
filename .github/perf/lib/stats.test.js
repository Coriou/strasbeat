import { test } from "node:test";
import assert from "node:assert/strict";
import {
  median,
  quantile,
  stats,
  pearson,
  paired,
  slope,
  proven,
  bar,
} from "./stats.mjs";
test("quantiles interpolate without mutating input", () => {
  const a = [4, 1, 3, 2];
  assert.equal(median(a), 2.5);
  assert.equal(quantile(a, 0), 1);
  assert.deepEqual(a, [4, 1, 3, 2]);
});
test("spread and empty or zero samples", () => {
  assert.equal(stats([]).median, null);
  assert.equal(stats([0, 0]).spread, 0);
  assert.equal(stats([1, 2, 3]).spread, 1);
});
test("correlation rejects constant and small samples", () => {
  assert.equal(pearson([[1, 2]]), null);
  assert.equal(
    pearson([
      [1, 2],
      [1, 3],
    ]),
    null,
  );
  assert.equal(
    pearson([
      [1, 2],
      [2, 4],
      [3, 6],
    ]),
    1,
  );
});
test("paired differences and regression slope", () => {
  assert.equal(paired([10, 20, 30], [9, 18, 28]).differences.median, -2);
  assert.equal(
    slope([
      [10, 100],
      [20, 120],
      [30, 140],
      [40, 160],
    ]),
    2,
  );
});
test("a count is proven only at the bar for its number of points", () => {
  // Seven points per build: the bar is 0.8.
  assert.equal(
    proven({ base: { n: 7, r: 0.97 }, head: { n: 7, r: 0.85 } }),
    true,
  );
  assert.equal(
    proven({ base: { n: 7, r: 0.97 }, head: { n: 7, r: 0.76 } }),
    false,
  );
  // Four points: 0.93 is what chance produces often enough; 0.98 is not.
  assert.equal(
    proven({ base: { n: 4, r: 0.93 }, head: { n: 4, r: 0.91 } }),
    false,
  );
  assert.equal(
    proven({ base: { n: 4, r: 0.98 }, head: { n: 4, r: 0.996 } }),
    true,
  );
  // A build with too few points is left out; the other still has to pass.
  assert.equal(proven({ base: { n: 7, r: 0.9 }, head: { n: 3, r: -1 } }), true);
  assert.equal(proven({ base: { n: 3, r: 1 }, head: { n: 3, r: 1 } }), false);
  assert.equal(proven({ base: { n: 7, r: null } }), false);
  assert.equal(proven({}), false);
  assert.deepEqual([3, 4, 5, 6, 7, 20].map(bar), [
    Infinity,
    0.95,
    0.878,
    0.811,
    0.8,
    0.8,
  ]);
});
