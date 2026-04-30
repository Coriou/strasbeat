// src/editor/completions/context.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extractBufferTokens } from "./context.js";

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
