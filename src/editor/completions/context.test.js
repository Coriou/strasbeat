// src/editor/completions/context.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extractBufferTokens } from "./context.js";
import { createRecency } from "./context.js";

describe("extractBufferTokens(text)", () => {
  test("returns a Map keyed by category", () => {
    const tokens = extractBufferTokens("");
    assert.ok(tokens instanceof Map);
    for (const cat of ["sound", "bank", "chord", "function"]) {
      assert.ok(tokens.has(cat), `missing category ${cat}`);
      assert.ok(tokens.get(cat) instanceof Set);
    }
  });

  test("extracts sound names from s() and sound() calls", () => {
    const text = `s("bd sd hh*4").bank("RolandTR909")\nsound("piano")`;
    const tokens = extractBufferTokens(text);
    assert.deepEqual(
      [...tokens.get("sound")].sort(),
      ["bd", "hh", "piano", "sd"],
    );
  });

  test("extracts bank names from bank() calls", () => {
    const text = `s("bd").bank("RolandTR909")\nbank("tr808").s("kick")`;
    const tokens = extractBufferTokens(text);
    assert.deepEqual([...tokens.get("bank")].sort(), ["RolandTR909", "tr808"]);
  });

  test("extracts chord symbols from chord() calls", () => {
    const text = `chord("<C^7 Dm7 G7>")`;
    const tokens = extractBufferTokens(text);
    assert.ok(tokens.get("chord").has("C^7"));
    assert.ok(tokens.get("chord").has("Dm7"));
    assert.ok(tokens.get("chord").has("G7"));
  });

  test("extracts bare function callees", () => {
    const text = `stack(s("bd"), note("c4").room(0.5))`;
    const tokens = extractBufferTokens(text);
    const fns = tokens.get("function");
    assert.ok(fns.has("stack"));
    assert.ok(fns.has("s"));
    assert.ok(fns.has("note"));
  });

  test("strips mini-notation operators from token splits", () => {
    const text = `s("bd*4 [sd cp]")`;
    const tokens = extractBufferTokens(text);
    const sounds = tokens.get("sound");
    assert.ok(sounds.has("bd"));
    assert.ok(sounds.has("sd"));
    assert.ok(sounds.has("cp"));
    // The operator chars themselves should not become "sounds"
    assert.ok(!sounds.has("*"));
    assert.ok(!sounds.has("["));
  });

  test("strips colon variant suffix when extracting sound tokens", () => {
    const text = `s("bd:2 sd:0")`;
    const tokens = extractBufferTokens(text);
    assert.ok(tokens.get("sound").has("bd"));
    assert.ok(tokens.get("sound").has("sd"));
  });

  test("ignores rest token ~", () => {
    const text = `s("bd ~ sd ~")`;
    const tokens = extractBufferTokens(text);
    const sounds = tokens.get("sound");
    assert.ok(!sounds.has("~"));
  });

  test("ignores empty buffer cleanly", () => {
    const tokens = extractBufferTokens("");
    for (const cat of ["sound", "bank", "chord", "function"]) {
      assert.equal(tokens.get(cat).size, 0);
    }
  });
});

function makeMockStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _store: store,
  };
}

describe("createRecency()", () => {
  test("bump records label with current time, score returns ~0.3 fresh", () => {
    globalThis.localStorage = makeMockStorage();
    const rec = createRecency({ now: () => 1000 });
    rec.bump("sound", "bd");
    const s = rec.score("sound", "bd", { now: 1000 });
    assert.ok(s > 0.29 && s <= 0.30, `expected ~0.3, got ${s}`);
  });

  test("score decays linearly to 0 over 30 days", () => {
    globalThis.localStorage = makeMockStorage();
    const t0 = 0;
    const day = 86400 * 1000;
    const rec = createRecency({ now: () => t0 });
    rec.bump("sound", "bd");
    assert.ok(rec.score("sound", "bd", { now: t0 + day * 15 }) > 0.14);
    assert.ok(rec.score("sound", "bd", { now: t0 + day * 15 }) < 0.16);
    assert.equal(rec.score("sound", "bd", { now: t0 + day * 30 }), 0);
    assert.equal(rec.score("sound", "bd", { now: t0 + day * 45 }), 0);
  });

  test("evicts at index 32, keeps most recent", () => {
    globalThis.localStorage = makeMockStorage();
    let t = 0;
    const rec = createRecency({ now: () => t });
    for (let i = 0; i < 40; i++) {
      t = i * 1000;
      rec.bump("sound", `s${i}`);
    }
    assert.equal(rec.score("sound", "s0", { now: t + 1 }) > 0, false,
      "s0 should be evicted");
    assert.ok(rec.score("sound", "s39", { now: t + 1 }) > 0,
      "s39 should still be present");
  });

  test("persists to localStorage on bump (after debounce flush)", () => {
    const storage = makeMockStorage();
    globalThis.localStorage = storage;
    const rec = createRecency({ now: () => 1000, debounceMs: 0 });
    rec.bump("sound", "bd");
    rec.flush();
    const raw = storage.getItem("strasbeat:completions-recency");
    assert.ok(raw, "expected localStorage entry after flush");
    const parsed = JSON.parse(raw);
    assert.ok(parsed.sound.find((e) => e.label === "bd"));
  });

  test("hydrates from localStorage on construction", () => {
    const storage = makeMockStorage();
    storage.setItem(
      "strasbeat:completions-recency",
      JSON.stringify({ sound: [{ label: "bd", t: 5000 }], bank: [], chord: [], function: [], note: [], mode: [] }),
    );
    globalThis.localStorage = storage;
    const rec = createRecency({ now: () => 5000 });
    assert.ok(rec.score("sound", "bd", { now: 5000 }) > 0.29);
  });

  test("ignores corrupt JSON in storage", () => {
    const storage = makeMockStorage();
    storage.setItem("strasbeat:completions-recency", "not json {{");
    globalThis.localStorage = storage;
    const rec = createRecency({ now: () => 1 });
    assert.equal(rec.score("sound", "bd", { now: 1 }), 0);
  });
});
