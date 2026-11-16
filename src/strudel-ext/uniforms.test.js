// Run with: node --import ./scripts/test-register.mjs --test src/strudel-ext/uniforms.test.js
//
// Pure tests for the onDraw-haps → decay-envelope → uniform-map derivation.
// No WebGL: this is a pure function of (haps, prevState, dt, config).
//
// The hap shape is the REAL onDraw hap shape, verified against
// src/ui/piano-roll.js (getValue/getGroupKey read hap.value.s, hap.value.note
// / hap.value.n, hap.value.freq; the dynamics path reads hap.value.velocity /
// hap.value.gain; timing is hap.whole.begin — a Fraction). After Strudel's
// transpiler rewrites a drum line like s("bd ~ sd hh") into mini(...), each
// per-step hap carries value { s: "bd" } etc., which is what the stub mirrors.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createUniformDeriver,
  getDeriver,
  _resetDeriver,
  laneToUniform,
  sanitizeGlslIdentifier,
} from "./uniforms.js";

// Minimal hap stub matching the real per-step hap shape (value.s for drums,
// whole.begin/end for timing). begin/end are plain numbers here; the deriver
// reads them with Number(), so a Fraction works identically in the app.
function hap(name, begin, end) {
  return { value: { s: name }, whole: { begin, end } };
}

describe("lane → uniform mapping", () => {
  test("bd → uKick, sd → uSnare, hh → uHat", () => {
    assert.equal(laneToUniform("bd"), "uKick");
    assert.equal(laneToUniform("sd"), "uSnare");
    assert.equal(laneToUniform("hh"), "uHat");
  });
  test("an unmapped sound has no canonical lane", () => {
    assert.equal(laneToUniform("gm_pad_warm"), null);
  });
  test("arbitrary sound `name` → u_<name>, non-alphanumerics → _, leading _ keeps digit-leading names legal GLSL", () => {
    assert.equal(sanitizeGlslIdentifier("gm_pad_warm"), "u_gm_pad_warm");
    assert.equal(sanitizeGlslIdentifier("909-clap"), "u_909_clap");
  });
});

describe("onset detection + decay", () => {
  test("a new hap this frame pulses its uniform to peak", () => {
    const d = createUniformDeriver();
    const m = d.frame([hap("bd", 0)], 0, 0.016);
    assert.ok(m.uKick > 0.9, `expected uKick to pulse to ~1, got ${m.uKick}`);
  });
  test("a percussive sound also exposes its sanitized per-sound uniform", () => {
    const d = createUniformDeriver();
    const m = d.frame([hap("gm_pad_warm", 0)], 0, 0.016);
    assert.ok(
      m.u_gm_pad_warm > 0.9,
      `expected u_gm_pad_warm to pulse, got ${m.u_gm_pad_warm}`,
    );
  });
  test("a bd onset emits BOTH the canonical lane and the per-sound uniform", () => {
    // bd is both mapped (uKick) and gets its sanitized fallback (u_bd) in the
    // same frame — a lane name doesn't suppress the per-sound uniform.
    const d = createUniformDeriver();
    const m = d.frame([hap("bd", 0)], 0, 0.016);
    assert.ok(m.uKick > 0.9, `expected uKick, got ${m.uKick}`);
    assert.ok(m.u_bd > 0.9, `expected u_bd, got ${m.u_bd}`);
  });
  test("a uniform decays toward 0 across frames with no new onset", () => {
    const d = createUniformDeriver();
    d.frame([hap("bd", 0)], 0, 0.016); // onset
    const after = d.frame([], 0.2, 0.2); // no haps, 200ms later
    assert.ok(after.uKick < 0.5, `expected decay, got ${after.uKick}`);
    assert.ok(after.uKick >= 0, "decay never goes negative");
  });
  test("the same hap present two frames running does NOT re-pulse", () => {
    const d = createUniformDeriver();
    const f1 = d.frame([hap("bd", 0)], 0, 0.016).uKick;
    const f2 = d.frame([hap("bd", 0)], 0.016, 0.016).uKick; // still sounding
    assert.ok(f2 < f1, "no re-pulse without a new onset");
  });
  test("a re-triggered hap at a new begin DOES pulse again", () => {
    const d = createUniformDeriver();
    d.frame([hap("bd", 0)], 0, 0.016); // first onset
    d.frame([], 0.4, 0.4); // long gap → decays toward 0
    const m = d.frame([hap("bd", 1)], 1, 0.016); // new begin = new onset
    assert.ok(m.uKick > 0.9, `expected re-pulse to peak, got ${m.uKick}`);
  });
});

describe("onsets follow the playhead, not the draw window", () => {
  // onDraw passes every hap in the Drawer's ±2-cycle window. A hap that is
  // merely visible must not pulse — only one whose onset the playhead reached.
  test("a hap two cycles ahead of the playhead does not pulse yet", () => {
    const d = createUniformDeriver();
    const ahead = [hap("bd", 2, 2.25)];
    assert.equal(d.frame(ahead, 0, 0.016).uKick ?? 0, 0, "not at time 0");
    assert.equal(d.frame(ahead, 1.99, 0.016).uKick ?? 0, 0, "not at 1.99");
    assert.ok(d.frame(ahead, 2.01, 0.016).uKick > 0.9, "pulses on arrival");
  });
  test("the first frame pulses what is sounding, not what already ended", () => {
    const d = createUniformDeriver();
    const m = d.frame([hap("bd", 3, 3.25), hap("sd", 3.5, 4)], 3.75, 0.016);
    assert.equal(m.uKick ?? 0, 0, "bd ended at 3.25 — no pulse at 3.75");
    assert.ok(m.uSnare > 0.9, "sd is sounding at 3.75 — pulses");
  });
  test("a short hap that starts and ends between two frames still pulses", () => {
    const d = createUniformDeriver();
    d.frame([], 0, 0.016);
    const m = d.frame([hap("hh", 0.1, 0.15)], 0.3, 0.05);
    assert.ok(m.uHat > 0.9, `expected uHat to pulse, got ${m.uHat}`);
  });
  test("a Fraction-like begin/end (valueOf) is read as a number", () => {
    const frac = (n) => ({ valueOf: () => n, toString: () => `${n}/1` });
    const d = createUniformDeriver();
    const haps = [{ value: { s: "bd" }, whole: { begin: frac(1), end: frac(2) } }];
    assert.equal(d.frame(haps, 0.5, 0.016).uKick ?? 0, 0);
    assert.ok(d.frame(haps, 1.01, 0.016).uKick > 0.9);
  });
  test("a playhead that jumps backwards re-pulses what is sounding there", () => {
    const d = createUniformDeriver();
    d.frame([hap("bd", 0, 0.25)], 0.1, 0.016);
    d.frame([], 5, 1); // far ahead, fully decayed
    const m = d.frame([hap("bd", 0, 0.25)], 0.1, 0.016); // restarted
    assert.ok(m.uKick > 0.9, `expected a re-pulse, got ${m.uKick}`);
  });
  test("a hap with no whole (continuous signal) never pulses or throws", () => {
    const d = createUniformDeriver();
    assert.doesNotThrow(() => d.frame([{ value: { s: "bd" } }], 0, 0.016));
    assert.equal(d.frame([{ value: { s: "bd" } }], 1, 0.016).uKick ?? 0, 0);
  });
});

describe("decay is in wall-clock seconds", () => {
  test("the same dt decays the same amount whatever the tempo", () => {
    // Two derivers see the same 50ms frame; one playhead advanced 0.01 cycles
    // (slow tempo), the other 0.5 (fast). The envelope must not care.
    const slow = createUniformDeriver();
    const fast = createUniformDeriver();
    slow.frame([hap("bd", 0, 1)], 0, 0.016);
    fast.frame([hap("bd", 0, 1)], 0, 0.016);
    const a = slow.frame([], 0.01, 0.05).uKick;
    const b = fast.frame([], 0.5, 0.05).uKick;
    assert.equal(a, b);
    assert.ok(Math.abs(a - Math.exp(-0.05 / 0.12)) < 1e-9, `got ${a}`);
  });
});

describe("note velocity → uKeyVelocity", () => {
  test("a note hap drives uKeyVelocity from its velocity/gain", () => {
    const d = createUniformDeriver();
    const m = d.frame(
      [{ value: { note: "c3", velocity: 0.7 }, whole: { begin: 0 } }],
      0,
      0.016,
    );
    assert.ok(
      Math.abs(m.uKeyVelocity - 0.7) < 0.05,
      `expected uKeyVelocity ~0.7, got ${m.uKeyVelocity}`,
    );
  });
  test("a note hap with neither velocity nor gain falls back to uKeyVelocity 1", () => {
    const d = createUniformDeriver();
    const m = d.frame(
      [{ value: { note: "c3" }, whole: { begin: 0 } }],
      0,
      0.016,
    );
    assert.ok(
      Math.abs(m.uKeyVelocity - 1) < 1e-6,
      `expected uKeyVelocity to default to 1, got ${m.uKeyVelocity}`,
    );
  });
});

describe("explicit .uniform() override beats the auto map", () => {
  test("an explicit override for a dest replaces the auto value", () => {
    const d = createUniformDeriver();
    d.setOverride("uMelody", { gain: 0.8 });
    const m = d.frame(
      [{ value: 7, dest: "uMelody", whole: { begin: 0 } }],
      0,
      0.016,
    );
    assert.ok("uMelody" in m, "explicit dest is present in the map");
  });
  test("the dest tag is also read from value._uniformDest (real Pattern-method shape)", () => {
    // The .uniform() Pattern method tags hap.value._uniformDest (controls live
    // in hap.value). The deriver must route that the same way as the top-level
    // h.dest the test stub uses.
    const d = createUniformDeriver();
    d.setOverride("uMelody", { gain: 0.5 });
    const m = d.frame(
      [{ value: { note: 7, _uniformDest: "uMelody" }, whole: { begin: 0 } }],
      0,
      0.016,
    );
    assert.ok("uMelody" in m, "value._uniformDest routes to the dest uniform");
    assert.ok(m.uMelody > 0, "the override uniform pulses on a tagged hap");
  });
});

describe("shared singleton + teardown reset (_resetDeriver)", () => {
  test("getDeriver() returns the same instance until reset, a fresh one after", () => {
    const a = getDeriver();
    assert.equal(getDeriver(), a, "same singleton across calls");
    _resetDeriver();
    const b = getDeriver();
    assert.notEqual(b, a, "a fresh deriver is built after reset");
  });
  test("reset clears the stale playhead (no swallowed re-pulse after restart)", () => {
    // Part of the I-1 contract clearShader() relies on: a hap identity that was
    // live before the stop must still pulse on the first frame after restart.
    _resetDeriver();
    const before = getDeriver();
    before.frame([hap("bd", 0)], 0.5, 0.016); // playhead now past bd@0

    _resetDeriver(); // what clearShader() now calls on stop
    const after = getDeriver();
    assert.notEqual(after, before, "restart gets a clean deriver");

    const m = after.frame([hap("bd", 0)], 0, 0.016); // same identity bd@0
    assert.ok(m.uKick > 0.9, `expected a clean re-pulse, got ${m.uKick}`);
    _resetDeriver();
  });
  test("reset clears overrides (a stale low gain does not leak into the next deriver)", () => {
    // The other half of I-1: overrides must not survive teardown (else they
    // grow unbounded across stop→restart and a stale gain warps later pulses).
    // A scalar dest hap of value 1 with gain 0.3 → peak 0.3; with the default
    // gain 1 → peak 1. So a cleared override is observable as peak ≈ 1.
    _resetDeriver();
    getDeriver().setOverride("uMelody", { gain: 0.3 });

    _resetDeriver();
    const m = getDeriver().frame(
      [{ value: 1, dest: "uMelody", whole: { begin: 0 } }],
      0,
      0.016,
    );
    assert.ok(
      Math.abs(m.uMelody - 1) < 1e-6,
      `expected default gain (1) after reset, got ${m.uMelody} — override leaked`,
    );
    _resetDeriver();
  });
});
