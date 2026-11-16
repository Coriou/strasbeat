import { test } from "node:test";
import assert from "node:assert/strict";
import { check, lower, guard, measurements } from "./ratchets.mjs";
const r = {
  "a.default.calls": { max: 100, tolerance: 0.02, unit: "calls" },
  raises: [],
};
const m = (value, valid = true) => ({ "a.default.calls": { value, valid } });
test("check passes inclusive tolerance, fails over it and missing", () => {
  assert.equal(check(r, m(102))[0].ok, true);
  assert.equal(check(r, m(103))[0].ok, false);
  assert.equal(check(r, {})[0].reason, "missing");
});
test("invalid pace cannot pass or lower", () => {
  assert.equal(check(r, m(1, false))[0].ok, false);
  assert.deepEqual(lower(r, m(1, false)), r);
});
test("lower never raises or adds without init", () => {
  assert.deepEqual(lower(r, m(200)), r);
  assert.equal(lower(r, m(90))["a.default.calls"].max, 90);
  assert.equal(r["a.default.calls"].max, 100);
});
test("guard catches raises, removals, tolerance bypass and honours reasons", () => {
  const h = lower(r, m(90));
  assert.deepEqual(guard(r, h), []);
  h["a.default.calls"].max = 101;
  assert.equal(guard(r, h).length, 1);
  delete h["a.default.calls"];
  assert.equal(guard(r, h).length, 1);
  h.raises = [{ key: "a.default.calls", reason: "Changed fixture" }];
  assert.deepEqual(guard(r, h), []);
  h.raises[0].reason = " ";
  assert.equal(guard(r, h).length, 1);
  assert.equal(
    guard(r, {
      ...r,
      "a.default.calls": { ...r["a.default.calls"], tolerance: 0.03 },
    }).length,
    1,
  );
});
test("init requires valid listed metrics", () => {
  assert.equal(
    lower({ raises: [] }, m(80), ["a.default.calls"])["a.default.calls"].max,
    80,
  );
  assert.throws(() => lower({ raises: [] }, {}, ["missing"]));
});
test("measurements exclude timing passes and reject invalid counts", () => {
  const record = {
    scenario: "a",
    variant: "default",
    target: "head",
    pass: "count",
    status: "ok",
    counts: { calls: 10 },
  };
  assert.equal(
    measurements({
      records: [record, { ...record, pass: "timing", counts: { calls: 50 } }],
    })["a.default.calls"].value,
    10,
  );
  assert.equal(
    measurements({ records: [{ ...record, pacingValid: false }] })[
      "a.default.calls"
    ].valid,
    false,
  );
});

test("a missing or failed repeat invalidates an otherwise present metric", () => {
  const row = {
    target: "head",
    scenario: "a",
    variant: "default",
    pass: "count",
    status: "ok",
    counts: { calls: 10 },
  };
  assert.equal(
    measurements({ records: [row, { ...row, status: "error", counts: {} }] })[
      "a.default.calls"
    ].valid,
    false,
  );
});
test("a lowered ceiling is rounded up to two decimals and raises stays last", () => {
  const two = {
    "b.default.calls": { max: 10, tolerance: 0, unit: "calls" },
    ...r,
  };
  const next = lower(two, {
    "a.default.calls": { value: 12.3401, valid: true },
    "b.default.calls": { value: 7, valid: true },
  });
  assert.equal(next["a.default.calls"].max, 12.35);
  assert.equal(next["b.default.calls"].max, 7);
  assert.deepEqual(Object.keys(next), [
    "a.default.calls",
    "b.default.calls",
    "raises",
  ]);
  // The run a ceiling came from passes it.
  assert.equal(
    check(next, {
      "a.default.calls": { value: 12.3401, valid: true },
      "b.default.calls": { value: 7, valid: true },
    }).every((row) => row.ok),
    true,
  );
});
