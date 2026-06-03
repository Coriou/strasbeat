// Run with: node --import ./scripts/test-register.mjs --test src/strudel-ext/shader.test.js
//
// Pattern-input guard: a double-quoted shader source is rewritten by Strudel's
// transpiler into a Pattern (mini(...)) — shader() must detect that, warn
// loudly + return a no-op node, NOT crash. (Mirrors progression()'s guard.)
//
// CRITICAL: the guard returns BEFORE any document/WebGL access, so this runs in
// Node with no DOM. The valid-compile + render path needs a browser and is
// deferred to the user — do NOT add a compile test here.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { note, Pattern } from "@strudel/core";
import { mini } from "@strudel/mini";
import { shader, _getDeriver } from "./shader.js";

let warnings;
let originalWarn;
beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...a) => warnings.push(a.map(String).join(" "));
});
afterEach(() => {
  console.warn = originalWarn;
});

describe("shader() Pattern-input guard", () => {
  test("a Pattern (double-quoted source) warns loudly and returns a no-op", async () => {
    // A double-quoted shader source becomes mini(...) via the transpiler — any
    // Pattern reproduces that. (Real GLSL has ";" which mini can't parse, so we
    // use a bare-token mini string here; the guard only checks ._Pattern.)
    const result = await shader(mini("precision mediump float"));
    assert.ok(
      warnings.some(
        (w) =>
          w.includes("[strasbeat]") && w.toLowerCase().includes("single-quote"),
      ),
      `expected a [strasbeat] single-quote-rule warning, got: ${JSON.stringify(warnings)}`,
    );
    assert.doesNotThrow(() => result);
    // The no-op node exposes .uniform() so a chained call doesn't crash either.
    assert.equal(typeof result.uniform, "function");
    assert.doesNotThrow(() => result.uniform({ dest: "uMelody" }));
  });

  test("empty source warns and returns a no-op (does not crash)", async () => {
    const result = await shader("");
    assert.ok(
      warnings.some((w) => w.includes("[strasbeat]")),
      `expected a [strasbeat] empty-source warning, got: ${JSON.stringify(warnings)}`,
    );
    assert.equal(typeof result.uniform, "function");
  });
});

describe(".uniform() Pattern method", () => {
  test("is registered on Pattern.prototype (module side effect)", () => {
    assert.equal(typeof Pattern.prototype.uniform, "function");
  });

  test("returns a chainable Pattern and tags hap.value._uniformDest", () => {
    const pat = note("0 7 5 7").uniform({
      dest: "uMelody",
      gain: 0.8,
      slow: 2,
    });
    assert.ok(pat instanceof Pattern, "expected a Pattern back");
    for (const hap of pat.firstCycle()) {
      assert.equal(
        hap.value._uniformDest,
        "uMelody",
        "every hap should carry the dest tag",
      );
    }
  });

  test("registers the override on the shared deriver (gain feeds the pulse)", () => {
    // The method's side effect must reach the SAME deriver shader() uses.
    note("0").uniform({ dest: "uMelody", gain: 0.5 });
    const d = _getDeriver();
    const m = d.frame(
      [{ value: { note: 7, _uniformDest: "uMelody" }, whole: { begin: 0 } }],
      0,
      0.016,
    );
    assert.ok(m.uMelody > 0, "the shared deriver pulses the overridden dest");
  });

  test("a Pattern dest (double-quoted) warns and is a no-op pass-through", () => {
    const pat = note("0 7").uniform({ dest: mini("uMelody") });
    assert.ok(pat instanceof Pattern, "still a Pattern (pass-through)");
    assert.ok(
      warnings.some(
        (w) =>
          w.includes("[strasbeat]") && w.toLowerCase().includes("single-quote"),
      ),
      `expected a [strasbeat] single-quote warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test("a missing/non-string dest warns and is a no-op pass-through", () => {
    const pat = note("0 7").uniform({});
    assert.ok(pat instanceof Pattern);
    assert.ok(
      warnings.some((w) => w.includes("[strasbeat]")),
      `expected a [strasbeat] dest warning, got: ${JSON.stringify(warnings)}`,
    );
  });
});
