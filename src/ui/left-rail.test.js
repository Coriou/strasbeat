import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { deleteWithConfirmation } from "./left-rail.js";

// Every single-pattern delete gesture in the rail (context-menu Delete and the
// Cmd/Ctrl+Backspace chord) goes through deleteWithConfirmation.
describe("left rail: deleting a pattern always asks first", () => {
  test("does not delete when the prompt is declined or dismissed", async () => {
    for (const answer of [false, null, undefined]) {
      const deleted = [];
      const result = await deleteWithConfirmation({
        name: "song",
        confirm: async () => answer,
        onDelete: (n) => deleted.push(n),
      });
      assert.equal(result, false);
      assert.deepEqual(deleted, []);
    }
  });

  test("deletes exactly once on an explicit yes", async () => {
    const deleted = [];
    const result = await deleteWithConfirmation({
      name: "song",
      confirm: async () => true,
      onDelete: (n) => deleted.push(n),
    });
    assert.equal(result, true);
    assert.deepEqual(deleted, ["song"]);
  });

  test("the prompt names the pattern and is marked destructive", async () => {
    let asked;
    await deleteWithConfirmation({
      name: "song",
      confirm: async (opts) => { asked = opts; return false; },
      onDelete: () => {},
    });
    assert.match(asked.title, /"song"/);
    assert.equal(asked.destructive, true);
  });
});
