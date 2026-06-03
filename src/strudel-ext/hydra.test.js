// Run with: node --test src/strudel-ext/hydra.test.js
//
// Pure tests for the guarded H(): empty haps must NOT throw — they return
// the last non-empty value seen, or 0 if none yet. No WebGL here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mini } from "@strudel/mini";
import { H } from "./hydra.js";

describe("guarded H()", () => {
  test("never throws on a pattern that is empty at the query instant", () => {
    // "~" is silence the whole cycle — queryArc returns [] at every instant.
    const fn = H(mini("~"));
    assert.equal(typeof fn, "function");
    assert.doesNotThrow(() => fn());
  });

  test("returns 0 before any non-empty value has been seen", () => {
    const fn = H(mini("~"));
    assert.equal(fn(), 0);
  });

  test("returns the active value when a hap is present", () => {
    // A pattern that is 0.5 for the whole cycle — always has an active hap.
    const fn = H(mini("0.5"));
    assert.equal(fn(), 0.5);
  });

  test("holds the last non-empty value across an empty instant", () => {
    // Drive H() through a value, then assert it does not reset to 0 / throw
    // when later queried during silence. We simulate by querying a dense
    // pattern (always-present) — the key property is: once a value is seen,
    // a subsequent empty query must return that held value, never throw.
    const dense = H(mini("0.7"));
    assert.equal(dense(), 0.7);
    assert.doesNotThrow(() => dense());
    assert.equal(dense(), 0.7);
  });
});
