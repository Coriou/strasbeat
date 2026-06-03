import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { EditorState, Compartment } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";

import { freshTabState } from "./build-editor-state.js";

// freshTabState is pure @codemirror/state. liveCompartmentValues reads the
// @strudel/codemirror compartments and is gated by the in-app acceptance-#3
// tripwire (the user's visual test), not here.

describe("freshTabState", () => {
  test("starts the fresh tab at undoDepth 0 — no cross-tab history bleed (acceptance #2)", () => {
    const base = EditorState.create({ doc: "BOOT", extensions: [history()] });
    // simulate the outgoing tab accruing edits
    let live = base.update({ changes: { from: 4, insert: "_e1" } }).state;
    live = live.update({ changes: { from: 0, to: 0, insert: "x" } }).state;
    assert.equal(undoDepth(live), 2);
    const fresh = freshTabState(base, "new tab code");
    assert.equal(fresh.doc.toString(), "new tab code");
    assert.equal(undoDepth(fresh), 0, "fresh tab MUST have empty undo history");
  });

  test("reconfigures the given compartments to their live values (config carries over)", () => {
    const c = new Compartment();
    const base = EditorState.create({
      doc: "BOOT",
      extensions: [history(), c.of(EditorState.tabSize.of(2))],
    });
    const live = base.update({ effects: c.reconfigure(EditorState.tabSize.of(8)) }).state;
    const fresh = freshTabState(base, "code", [[c, c.get(live)]]);
    assert.equal(fresh.facet(EditorState.tabSize), 8, "compartment carried the live value");
    assert.equal(undoDepth(fresh), 0);
  });

  test("places the cursor at the document start", () => {
    const base = EditorState.create({ doc: "xxxxx", extensions: [history()] });
    const fresh = freshTabState(base, "hello world");
    assert.equal(fresh.selection.main.anchor, 0);
  });

  test("does not mutate the clean base (it's reused for every fresh tab)", () => {
    const base = EditorState.create({ doc: "BOOT", extensions: [history()] });
    freshTabState(base, "a");
    freshTabState(base, "b");
    assert.equal(base.doc.toString(), "BOOT");
    assert.equal(undoDepth(base), 0);
  });
});
