import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  deleteWithConfirmation,
  rowAccessibleName,
  searchEntryIndex,
} from "./left-rail.js";

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

describe("left rail: what a pattern row is called", () => {
  test("a clean pattern is just its name", () => {
    assert.equal(rowAccessibleName({ display: "Dub" }), "Dub");
  });

  test("an edited demo says so, since the dot is only visual", () => {
    assert.equal(
      rowAccessibleName({ display: "Dub", dirty: true }),
      "Dub, modified",
    );
  });

  test("a search result names the folder it was found in", () => {
    assert.equal(
      rowAccessibleName({ display: "Dub", folderLabel: "Songs", dirty: true }),
      "Dub, in Songs, modified",
    );
  });
});

describe("left rail: ArrowDown out of the search field", () => {
  test("with results showing it lands on the first one, the row Enter opens", () => {
    // The open pattern is the tab stop and sits fourth among the results.
    assert.equal(searchEntryIndex({ searching: true, rovingIndex: 3 }), 0);
    assert.equal(searchEntryIndex({ searching: true, rovingIndex: -1 }), 0);
  });

  test("without a search it returns to the tree's tab stop", () => {
    assert.equal(searchEntryIndex({ searching: false, rovingIndex: 3 }), 3);
  });

  test("with no tab stop among the nodes it falls back to the first", () => {
    assert.equal(searchEntryIndex({ searching: false, rovingIndex: -1 }), 0);
  });
});
