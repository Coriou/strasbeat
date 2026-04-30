// src/editor/completions/score.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { score, segment } from "./score.js";

// Worked-trace fixtures from design/work/22-intellisense-v2.md (lines 196-206).
// Numbers are derived from the constants in score.js — when tuning weights,
// regenerate these by hand (they are intentionally rigid so weight changes
// surface as test failures, forcing a deliberate update).
const FIXTURES = [
  { q: "gmpw", c: "gm_pad_warm", expect: "match", min: 1.18, max: 1.20 },
  { q: "pia",  c: "piano",       expect: "match", min: 0.94, max: 0.96 },
  { q: "pia",  c: "gm_piano",    expect: "match", min: 0.53, max: 0.55 },
  { q: "pia",  c: "gm_pad_choir", expect: "null" },
  { q: "bd",   c: "bd_kick",     expect: "match", min: 0.88, max: 0.90 },
  { q: "bd",   c: "808bd_kick",  expect: "match", min: 0.48, max: 0.50 },
];

describe("score(query, candidate)", () => {
  for (const { q, c, expect, min, max } of FIXTURES) {
    test(`${JSON.stringify(q)} vs ${JSON.stringify(c)} → ${expect}`, () => {
      const result = score(q, c);
      if (expect === "null") {
        assert.equal(result, null);
        return;
      }
      assert.ok(result, "expected match, got null");
      assert.ok(typeof result.score === "number", "score must be number");
      assert.ok(Array.isArray(result.matched), "matched must be array");
      assert.equal(result.matched.length, q.length, "matched.length === q.length");
      assert.ok(
        result.score >= min && result.score <= max,
        `score ${result.score} out of [${min}, ${max}]`,
      );
    });
  }

  test("empty query returns score 0 with empty matched", () => {
    const r = score("", "anything");
    assert.deepEqual(r, { score: 0, matched: [] });
  });

  test("ordering: bd < bd_kick < 808bd_kick by length tiebreaker", () => {
    const a = score("bd", "bd").score;
    const b = score("bd", "bd_kick").score;
    const c = score("bd", "808bd_kick").score;
    assert.ok(a > b, `bd (${a}) should outrank bd_kick (${b})`);
    assert.ok(b > c, `bd_kick (${b}) should outrank 808bd_kick (${c})`);
  });

  test("case-insensitive match", () => {
    const a = score("BD", "bd_kick");
    const b = score("bd", "BD_KICK");
    assert.ok(a, "uppercase query matches lowercase candidate");
    assert.ok(b, "lowercase query matches uppercase candidate");
  });

  test("no match when query chars not in subsequence", () => {
    assert.equal(score("xyz", "abc"), null);
    assert.equal(score("ba", "abc"), null);
  });

  test("matched indices are strictly increasing", () => {
    const r = score("gmpw", "gm_pad_warm");
    assert.ok(r);
    for (let i = 1; i < r.matched.length; i++) {
      assert.ok(r.matched[i] > r.matched[i - 1], "matched must be strictly increasing");
    }
  });
});

describe("segment(candidate, matched)", () => {
  test("splits candidate into hit / non-hit runs", () => {
    const r = score("gmpw", "gm_pad_warm");
    assert.ok(r);
    const segs = segment("gm_pad_warm", r.matched);
    const reconstituted = segs.map((s) => s.text).join("");
    assert.equal(reconstituted, "gm_pad_warm");
    const hits = segs.filter((s) => s.hit).map((s) => s.text).join("");
    assert.equal(hits, "gmpw");
  });

  test("empty matched returns single non-hit segment", () => {
    const segs = segment("anything", []);
    assert.deepEqual(segs, [{ text: "anything", hit: false }]);
  });
});
