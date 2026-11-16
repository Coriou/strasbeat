import { test } from "node:test";
import assert from "node:assert/strict";
import { median, quantile, stats, pearson, paired, slope } from "./stats.mjs";
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
