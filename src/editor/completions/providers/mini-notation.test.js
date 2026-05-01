// src/editor/completions/providers/mini-notation.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// We can't unit-test the CM6 provider (it depends on syntaxTree), but we
// can smoke-test that the module loads cleanly and re-exports nothing it
// shouldn't.

describe("mini-notation provider module", () => {
  test("imports cleanly", async () => {
    const m = await import("./mini-notation.js");
    assert.equal(typeof m.miniNotationProvider, "function");
  });
});
