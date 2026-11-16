import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { moveIndex, treeNavigate, typeaheadIndex } from "./roving.js";
import {
  tabAccessibleName,
  rovingTabName,
  tabToRefocus,
} from "./tab-strip.js";

describe("moveIndex(): linear roving focus", () => {
  test("vertical lists move with Up/Down and stop at the ends", () => {
    assert.equal(moveIndex(0, 3, "ArrowDown"), 1);
    assert.equal(moveIndex(2, 3, "ArrowDown"), 2);
    assert.equal(moveIndex(1, 3, "ArrowUp"), 0);
    assert.equal(moveIndex(0, 3, "ArrowUp"), 0);
  });

  test("horizontal lists move with Left/Right and ignore Up/Down", () => {
    const h = { horizontal: true };
    assert.equal(moveIndex(0, 3, "ArrowRight", h), 1);
    assert.equal(moveIndex(1, 3, "ArrowLeft", h), 0);
    assert.equal(moveIndex(1, 3, "ArrowDown", h), -1);
    assert.equal(moveIndex(1, 3, "ArrowUp", h), -1);
  });

  test("wrap goes round both ends", () => {
    const w = { horizontal: true, wrap: true };
    assert.equal(moveIndex(2, 3, "ArrowRight", w), 0);
    assert.equal(moveIndex(0, 3, "ArrowLeft", w), 2);
  });

  test("Home and End jump to the ends", () => {
    assert.equal(moveIndex(1, 4, "Home"), 0);
    assert.equal(moveIndex(1, 4, "End"), 3);
  });

  test("other keys, and an empty list, are not navigation", () => {
    assert.equal(moveIndex(1, 3, "Enter"), -1);
    assert.equal(moveIndex(1, 3, "a"), -1);
    assert.equal(moveIndex(0, 0, "ArrowDown"), -1);
  });

  test("with nothing focused, next enters at the start and prev at the end", () => {
    assert.equal(moveIndex(-1, 3, "ArrowDown"), 0);
    assert.equal(moveIndex(-1, 3, "ArrowUp"), 2);
  });
});

describe("treeNavigate(): the patterns tree", () => {
  // Demos (open) > a, b · Songs (closed) · Unfiled (open) > c
  const nodes = [
    { level: 1, expanded: true },
    { level: 2, expanded: null },
    { level: 2, expanded: null },
    { level: 1, expanded: false },
    { level: 1, expanded: true },
    { level: 2, expanded: null },
  ];

  test("Down and Up walk every visible node in order", () => {
    assert.deepEqual(treeNavigate(nodes, 0, "ArrowDown"), { focus: 1 });
    assert.deepEqual(treeNavigate(nodes, 2, "ArrowDown"), { focus: 3 });
    assert.deepEqual(treeNavigate(nodes, 3, "ArrowUp"), { focus: 2 });
    assert.equal(treeNavigate(nodes, 5, "ArrowDown"), null);
  });

  test("Up on the first node hands focus back to what is above the tree", () => {
    assert.deepEqual(treeNavigate(nodes, 0, "ArrowUp"), { leave: "start" });
  });

  test("Home and End go to the first and last visible node", () => {
    assert.deepEqual(treeNavigate(nodes, 4, "Home"), { focus: 0 });
    assert.deepEqual(treeNavigate(nodes, 1, "End"), { focus: 5 });
  });

  test("Right opens a closed folder, then steps into an open one", () => {
    assert.deepEqual(treeNavigate(nodes, 3, "ArrowRight"), { toggle: 3 });
    assert.deepEqual(treeNavigate(nodes, 0, "ArrowRight"), { focus: 1 });
    assert.equal(treeNavigate(nodes, 1, "ArrowRight"), null);
  });

  test("Right on an open but empty folder does nothing", () => {
    const empty = [
      { level: 1, expanded: true },
      { level: 1, expanded: false },
    ];
    assert.equal(treeNavigate(empty, 0, "ArrowRight"), null);
  });

  test("Left closes an open folder, and takes a pattern to its folder", () => {
    assert.deepEqual(treeNavigate(nodes, 0, "ArrowLeft"), { toggle: 0 });
    assert.deepEqual(treeNavigate(nodes, 2, "ArrowLeft"), { focus: 0 });
    assert.deepEqual(treeNavigate(nodes, 5, "ArrowLeft"), { focus: 4 });
    assert.equal(treeNavigate(nodes, 3, "ArrowLeft"), null);
  });

  test("flat search results have no parent to go Left to", () => {
    const flat = [
      { level: 1, expanded: null },
      { level: 1, expanded: null },
    ];
    assert.equal(treeNavigate(flat, 1, "ArrowLeft"), null);
    assert.deepEqual(treeNavigate(flat, 0, "ArrowDown"), { focus: 1 });
  });

  test("non-tree keys and out-of-range indices are ignored", () => {
    assert.equal(treeNavigate(nodes, 1, "Enter"), null);
    assert.equal(treeNavigate(nodes, -1, "ArrowDown"), null);
    assert.equal(treeNavigate([], 0, "ArrowDown"), null);
  });
});

describe("typeaheadIndex(): type-to-find", () => {
  const labels = ["Demos", "Beat Grid", "Ben Choir", "Chords", "Dub"];

  test("a letter jumps to the next item starting with it", () => {
    assert.equal(typeaheadIndex(labels, 0, "c"), 3);
    assert.equal(typeaheadIndex(labels, 0, "b"), 1);
  });

  test("the same letter again cycles, wrapping past the end", () => {
    assert.equal(typeaheadIndex(labels, 1, "b"), 2);
    assert.equal(typeaheadIndex(labels, 2, "bb"), 1);
    assert.equal(typeaheadIndex(labels, 4, "d"), 0);
  });

  test("a longer query narrows, staying put while it still matches", () => {
    assert.equal(typeaheadIndex(labels, 1, "be"), 1);
    assert.equal(typeaheadIndex(labels, 1, "ben"), 2);
  });

  test("matching ignores case; no match is -1", () => {
    assert.equal(typeaheadIndex(labels, 0, "DU"), 4);
    assert.equal(typeaheadIndex(labels, 0, "z"), -1);
    assert.equal(typeaheadIndex([], 0, "a"), -1);
    assert.equal(typeaheadIndex(labels, 0, ""), -1);
  });
});

describe("pattern tabs: names, tab stop and focus across re-renders", () => {
  test("the accessible name carries the modified and playing states", () => {
    assert.equal(tabAccessibleName({ label: "Dub" }), "Dub");
    assert.equal(
      tabAccessibleName({ label: "Dub", dirty: true }),
      "Dub, modified",
    );
    assert.equal(
      tabAccessibleName({ label: "Dub", dirty: true, playing: true }),
      "Dub, modified, playing",
    );
  });

  test("exactly one tab is the tab stop: the focused pattern, else the first", () => {
    assert.equal(rovingTabName(["a", "b", "c"], "b"), "b");
    assert.equal(rovingTabName(["a", "b", "c"], null), "a");
    assert.equal(rovingTabName(["a", "b"], "gone"), "a");
    assert.equal(rovingTabName([], null), null);
  });

  test("a re-render keeps focus on the same tab", () => {
    assert.equal(
      tabToRefocus({ open: ["a", "b", "c"], previousName: "b", previousIndex: 1 }),
      "b",
    );
    // Reordered: follow the name, not the slot.
    assert.equal(
      tabToRefocus({ open: ["b", "a", "c"], previousName: "b", previousIndex: 1 }),
      "b",
    );
  });

  test("closing the focused tab moves focus to its neighbour", () => {
    assert.equal(
      tabToRefocus({ open: ["a", "c"], previousName: "b", previousIndex: 1 }),
      "c",
    );
    assert.equal(
      tabToRefocus({ open: ["a", "b"], previousName: "c", previousIndex: 2 }),
      "b",
    );
  });

  test("a tab that was only clicked gets no focus back", () => {
    // Otherwise the next Backspace typed for the editor closes a tab.
    assert.equal(
      tabToRefocus({
        open: ["a", "b", "c"],
        previousName: "b",
        previousIndex: 1,
        keyboard: false,
      }),
      null,
    );
    // Clicking the close button: the neighbour must not take focus either.
    assert.equal(
      tabToRefocus({
        open: ["a", "c"],
        previousName: "b",
        previousIndex: 1,
        keyboard: false,
      }),
      null,
    );
  });

  test("no focus to give back when none was held or no tab is left", () => {
    assert.equal(
      tabToRefocus({ open: ["a"], previousName: null, previousIndex: -1 }),
      null,
    );
    assert.equal(
      tabToRefocus({ open: [], previousName: "a", previousIndex: 0 }),
      null,
    );
  });
});
