// src/editor/mini-notation-tokens.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { tokenAtOffset, miniContext } from "./mini-notation-tokens.js";

describe("tokenAtOffset", () => {
  test("returns null for empty string", () => {
    assert.equal(tokenAtOffset("", 0), null);
  });

  test("identifies token at cursor", () => {
    const r = tokenAtOffset("bd sd hh", 1);
    assert.deepEqual(r, { token: "bd", from: 0, to: 2, prevSeparator: null });
  });

  test("returns null at separator", () => {
    assert.equal(tokenAtOffset("bd sd", 2), null);
  });

  test("prevSeparator is ':' when cursor is in token after a colon", () => {
    // "bd:2" with cursor after the colon (at position 3, on "2")
    const r = tokenAtOffset("bd:2", 3);
    assert.equal(r.token, "2");
    assert.equal(r.prevSeparator, ":");
  });

  test("prevSeparator is null when cursor is in first token", () => {
    const r = tokenAtOffset("bd:2", 1);
    assert.equal(r.token, "bd");
    assert.equal(r.prevSeparator, null);
  });

  test("prevSeparator is ':' for empty fragment after colon", () => {
    // "bd:" with cursor at end (position 3)
    const r = tokenAtOffset("bd:", 3);
    // No token (cursor at separator end), but the spec wants this to
    // return a special "empty fragment after colon" signal so the
    // provider can offer variants. Encoding: prevSeparator: ':' with
    // token: '', from: 3, to: 3.
    assert.deepEqual(r, { token: "", from: 3, to: 3, prevSeparator: ":" });
  });

  test("prevSeparator is null at empty separator (e.g. trailing space)", () => {
    // "bd " with cursor at end (position 3) — same as bare empty cursor
    assert.equal(tokenAtOffset("bd ", 3), null);
  });
});

describe("miniContext", () => {
  test("recognises s/sound as sound context", () => {
    assert.equal(miniContext("s"), "sound");
    assert.equal(miniContext("sound"), "sound");
  });
  test("recognises note/n as note context", () => {
    assert.equal(miniContext("note"), "note");
    assert.equal(miniContext("n"), "note");
  });
  test("everything else is other", () => {
    assert.equal(miniContext("chord"), "other");
    assert.equal(miniContext("xyz"), "other");
  });
});
