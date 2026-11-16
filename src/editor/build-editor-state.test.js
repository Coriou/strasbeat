import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { EditorState, Compartment } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";

import { freshTabState, syncTabState } from "./build-editor-state.js";

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

describe("syncTabState", () => {
  function setup() {
    const wrap = new Compartment();
    const other = new Compartment();
    const base = EditorState.create({
      doc: "BOOT",
      extensions: [history(), wrap.of(EditorState.tabSize.of(2)), other.of(EditorState.readOnly.of(false))],
    });
    return { wrap, other, base };
  }

  test("a cached tab picks up a setting changed while it was in the background", () => {
    const { wrap, other, base } = setup();
    // Tab B: edited, then cached with the OLD setting.
    let cachedB = freshTabState(base, "tab b");
    cachedB = cachedB.update({ changes: { from: 5, insert: " edit" }, selection: { anchor: 3 } }).state;
    assert.equal(cachedB.facet(EditorState.tabSize), 2);
    // Meanwhile the setting is changed on the live view (tab A).
    const liveA = freshTabState(base, "tab a").update({ effects: wrap.reconfigure(EditorState.tabSize.of(8)) }).state;

    const synced = syncTabState(cachedB, [[wrap, wrap.get(liveA)], [other, other.get(liveA)]]);
    assert.equal(synced.facet(EditorState.tabSize), 8, "live setting applied");
    assert.equal(synced.doc.toString(), "tab b edit", "document untouched");
    assert.equal(synced.selection.main.anchor, 3, "selection untouched");
    assert.equal(undoDepth(synced), undoDepth(cachedB), "no undo step added");
    assert.equal(undoDepth(synced), 1, "the tab's own history survives");
  });

  test("returns the very same state when nothing differs", () => {
    const { wrap, other, base } = setup();
    const cached = freshTabState(base, "tab");
    assert.equal(syncTabState(cached, [[wrap, wrap.get(cached)], [other, other.get(cached)]]), cached);
    assert.equal(syncTabState(cached, []), cached);
  });

  test("syncing twice is stable (the second pass is a no-op)", () => {
    const { wrap, base } = setup();
    const live = base.update({ effects: wrap.reconfigure(EditorState.tabSize.of(4)) }).state;
    const pairs = [[wrap, wrap.get(live)]];
    const once = syncTabState(freshTabState(base, "x"), pairs);
    assert.equal(syncTabState(once, pairs), once);
  });
});
