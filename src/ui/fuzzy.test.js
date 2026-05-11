import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { score, foldAccents } from "./fuzzy.js";

describe("foldAccents", () => {
  test("removes diacritical marks", () => {
    assert.equal(foldAccents("Café"), "cafe");
    assert.equal(foldAccents("voilà"), "voila");
    assert.equal(foldAccents("naïve résumé"), "naive resume");
  });

  test("lowercases ascii", () => {
    assert.equal(foldAccents("HELLO"), "hello");
  });

  test("is idempotent", () => {
    assert.equal(foldAccents(foldAccents("Café")), foldAccents("Café"));
  });
});

describe("score: subsequence matching", () => {
  test("returns null for non-matching query", () => {
    assert.equal(score("xyz", "Hello"), null);
  });

  test("returns positive score with match indices for substring match", () => {
    const r = score("hel", "Hello");
    assert.ok(r);
    assert.ok(r.score > 0);
    assert.deepEqual(r.matches, [0, 1, 2]);
  });

  test("matches subsequence with gaps", () => {
    const r = score("ho", "Hello");
    assert.ok(r);
    assert.deepEqual(r.matches, [0, 4]);
  });

  test("accent-folds the target", () => {
    const r = score("cafe", "Café");
    assert.ok(r);
    assert.equal(r.matches.length, 4);
  });

  test("accent-folds the query", () => {
    const r = score("café", "Cafe Sessions");
    assert.ok(r);
    assert.deepEqual(r.matches, [0, 1, 2, 3]);
  });
});

describe("score: ranking", () => {
  test("prefix match scores higher than mid-string match", () => {
    const a = score("late", "Late Night");
    const b = score("late", "Modulate");
    assert.ok(a && b);
    assert.ok(a.score > b.score, `prefix ${a.score} should beat mid ${b.score}`);
  });

  test("word-start match scores higher than mid-word match", () => {
    const a = score("ni", "Late Night"); // 'ni' starts the word "Night"
    const b = score("ni", "Modaning");   // 'ni' mid-word
    assert.ok(a && b);
    assert.ok(a.score > b.score);
  });

  test("consecutive run beats scattered run of the same characters", () => {
    const a = score("lat", "Late Night");      // contiguous run
    const b = score("lat", "L_a_t_e");         // scattered
    assert.ok(a && b);
    assert.ok(a.score > b.score);
  });

  test("longer consecutive run scores higher", () => {
    const a = score("late", "Late");
    const b = score("late", "Late N"); // same prefix, longer target → slightly lower
    assert.ok(a && b);
    assert.ok(a.score >= b.score);
  });
});

describe("score: multi-token (whitespace-separated)", () => {
  test("requires every token to match the target", () => {
    assert.ok(score("late night", "Late Night Comp"));
    assert.equal(score("late xyz", "Late Night Comp"), null);
  });

  test("tokens can match in any order", () => {
    assert.ok(score("night late", "Late Night Comp"));
  });

  test("returns the union of matched indices across tokens, deduped + sorted", () => {
    const r = score("la ni", "Late Night");
    assert.ok(r);
    // 'la' → 0,1; 'ni' → 5,6
    assert.deepEqual(r.matches, [0, 1, 5, 6]);
  });
});

describe("score: edge cases", () => {
  test("empty query returns null (caller filters)", () => {
    assert.equal(score("", "Anything"), null);
  });

  test("whitespace-only query returns null", () => {
    assert.equal(score("   ", "Anything"), null);
  });

  test("empty target returns null", () => {
    assert.equal(score("a", ""), null);
  });
});
