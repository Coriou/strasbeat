// src/editor/completions/providers/sounds.test.js
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { rankSounds } from "./sounds.js";

const ALL_KEYS = [
  "bd", "bd_kick", "808bd_kick", "RolandTR909_bd",
  "sd", "hh", "piano", "gm_piano", "gm_pad_warm", "gm_pad_choir",
];

const NO_RECENCY = {
  score: () => 0,
  snapshot: () => ({ sound: [], bank: [], chord: [], function: [], note: [], mode: [] }),
};

const NO_BUFFER = new Set();

describe("rankSounds", () => {
  test("query 'pian' surfaces piano + gm_piano in top 2", () => {
    const ranked = rankSounds({
      fragment: "pian",
      buffer: NO_BUFFER,
      recency: NO_RECENCY,
      allKeys: ALL_KEYS,
    });
    const top2 = ranked.slice(0, 2).map((r) => r.label);
    assert.ok(top2.includes("piano"), `top2 missing piano: ${top2}`);
    assert.ok(top2.includes("gm_piano"), `top2 missing gm_piano: ${top2}`);
  });

  test("query 'gmpw' surfaces gm_pad_warm in top 3", () => {
    const ranked = rankSounds({
      fragment: "gmpw",
      buffer: NO_BUFFER,
      recency: NO_RECENCY,
      allKeys: ALL_KEYS,
    });
    const top3 = ranked.slice(0, 3).map((r) => r.label);
    assert.ok(top3.includes("gm_pad_warm"), `top3 missing gm_pad_warm: ${top3}`);
  });

  test("buffer presence boosts an in-buffer name above its sibling", () => {
    const buffer = new Set(["bd_kick"]);
    const ranked = rankSounds({
      fragment: "bd",
      buffer,
      recency: NO_RECENCY,
      allKeys: ALL_KEYS,
    });
    const bdKickIdx = ranked.findIndex((r) => r.label === "bd_kick");
    const bd808Idx = ranked.findIndex((r) => r.label === "808bd_kick");
    assert.ok(bdKickIdx >= 0 && bd808Idx >= 0);
    assert.ok(bdKickIdx < bd808Idx, "bd_kick (in buffer) should outrank 808bd_kick");
  });

  test("recency boost overrides cold ordering", () => {
    // The mock returns 0.5 (above the 0.3 production cap) so the recency
    // delta is large enough to cross the 0.4 prefix advantage `bd_kick`
    // has over `808bd_kick`. The test's intent is to prove the ranker
    // adds the recency value into finalScore — not to assert anything
    // about the cap itself.
    const recency = {
      score: (cat, label) => (label === "808bd_kick" ? 0.5 : 0),
      snapshot: () => ({ sound: [], bank: [], chord: [], function: [], note: [], mode: [] }),
    };
    const ranked = rankSounds({
      fragment: "bd",
      buffer: NO_BUFFER,
      recency,
      allKeys: ALL_KEYS,
    });
    const bd808Idx = ranked.findIndex((r) => r.label === "808bd_kick");
    const bdKickIdx = ranked.findIndex((r) => r.label === "bd_kick");
    assert.ok(bd808Idx < bdKickIdx, "recently-used 808bd_kick should outrank cold bd_kick");
  });

  test("respects MAX_RESULTS cap", () => {
    const big = Array.from({ length: 500 }, (_, i) => `s${i}`);
    const ranked = rankSounds({
      fragment: "s",
      buffer: NO_BUFFER,
      recency: NO_RECENCY,
      allKeys: big,
    });
    assert.ok(ranked.length <= 80, `ranked ${ranked.length} should be ≤ 80`);
  });
});
