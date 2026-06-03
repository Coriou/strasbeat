import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  readOpenSet,
  writeOpenSet,
  migrateOpenSet,
} from "./tabs.js";

// In-memory store stub matching the createLocalStore interface used by
// readOpenSet/writeOpenSet (only getIndex/setIndex are exercised here).
function makeStore(index = { lastOpen: null, userPatterns: [] }) {
  let idx = structuredClone(index);
  return {
    getIndex: () => structuredClone(idx),
    setIndex: (next) => {
      idx = structuredClone(next);
    },
    _peek: () => idx,
  };
}

describe("readOpenSet", () => {
  test("returns empty open set when uiState is absent", () => {
    const store = makeStore();
    assert.deepEqual(readOpenSet(store), { openTabs: [], activeTab: null });
  });

  test("reads openTabs and activeTab from uiState", () => {
    const store = makeStore({
      lastOpen: "b",
      userPatterns: [],
      uiState: { openTabs: ["a", "b", "c"], activeTab: "b" },
    });
    assert.deepEqual(readOpenSet(store), {
      openTabs: ["a", "b", "c"],
      activeTab: "b",
    });
  });

  test("coerces malformed openTabs to an empty array", () => {
    const store = makeStore({
      lastOpen: null,
      userPatterns: [],
      uiState: { openTabs: "nope", activeTab: 42 },
    });
    assert.deepEqual(readOpenSet(store), { openTabs: [], activeTab: null });
  });
});

describe("writeOpenSet", () => {
  test("persists openTabs + activeTab under uiState, preserving other fields", () => {
    const store = makeStore({
      lastOpen: "a",
      userPatterns: ["x"],
      folders: ["Jazz"],
      uiState: { collapsedFolders: ["Jazz"] },
    });
    writeOpenSet(store, { openTabs: ["a", "b"], activeTab: "b" });
    const idx = store._peek();
    assert.deepEqual(idx.uiState.openTabs, ["a", "b"]);
    assert.equal(idx.uiState.activeTab, "b");
    // Untouched fields survive.
    assert.deepEqual(idx.uiState.collapsedFolders, ["Jazz"]);
    assert.deepEqual(idx.folders, ["Jazz"]);
    assert.deepEqual(idx.userPatterns, ["x"]);
  });

  test("also mirrors activeTab into lastOpen (spec: kept in sync)", () => {
    const store = makeStore({ lastOpen: "a", userPatterns: [] });
    writeOpenSet(store, { openTabs: ["a", "b"], activeTab: "b" });
    assert.equal(store._peek().lastOpen, "b");
  });
});

describe("migrateOpenSet", () => {
  test("seeds open set from existing openTabs/activeTab when present", () => {
    const store = makeStore({
      lastOpen: "b",
      userPatterns: [],
      uiState: { openTabs: ["a", "b"], activeTab: "a" },
    });
    assert.deepEqual(migrateOpenSet(store), { openTabs: ["a", "b"], activeTab: "a" });
  });

  test("legacy boot (only lastOpen) seeds a single tab", () => {
    const store = makeStore({ lastOpen: "05-dub", userPatterns: [] });
    assert.deepEqual(migrateOpenSet(store), {
      openTabs: ["05-dub"],
      activeTab: "05-dub",
    });
  });

  test("empty boot (no lastOpen, no openTabs) seeds an empty open set", () => {
    const store = makeStore({ lastOpen: null, userPatterns: [] });
    assert.deepEqual(migrateOpenSet(store), { openTabs: [], activeTab: null });
  });

  test("lastOpen wins as focus when openTabs exists but disagrees on boot", () => {
    // Older build wrote openTabs but a newer lastOpen; lastOpen is added + focused.
    const store = makeStore({
      lastOpen: "c",
      userPatterns: [],
      uiState: { openTabs: ["a", "b"], activeTab: "a" },
    });
    const r = migrateOpenSet(store);
    assert.equal(r.activeTab, "c");
    assert.ok(r.openTabs.includes("c"));
    // Existing tabs are preserved.
    assert.ok(r.openTabs.includes("a") && r.openTabs.includes("b"));
  });
});

import { createTabController } from "./tabs.js";

// A stub "EditorState" is just an opaque token; the controller never
// inspects it. buildState returns a fresh token; installState records the
// last installed token.
function makeHarness({ openTabs = [], activeTab = null } = {}) {
  let idx = {
    lastOpen: activeTab,
    userPatterns: [],
    uiState: { openTabs, activeTab },
  };
  const store = {
    getIndex: () => structuredClone(idx),
    setIndex: (n) => { idx = structuredClone(n); },
    get: (name) => ({ code: `code-of-${name}`, isUserPattern: true }),
  };
  const events = { installed: [], flushed: 0, currentName: null, changed: [] };
  const ctl = createTabController({
    store,
    patterns: {},
    buildState: ({ name }) => ({ token: `state-of-${name}` }),
    installState: (token) => { events.installed.push(token); },
    captureState: () => ({ token: "captured" }),
    flushToStore: () => { events.flushed++; },
    setCurrentName: (name) => { events.currentName = name; },
    onChange: () => { events.changed.push(true); },
  });
  return { ctl, events, store, _idx: () => idx };
}

describe("createTabController: open-or-focus", () => {
  test("opening a new item appends it and focuses it", () => {
    const { ctl, events } = makeHarness();
    ctl.openOrFocus("a");
    assert.deepEqual(ctl.getOpenItems(), ["a"]);
    assert.equal(ctl.getActiveItem(), "a");
    assert.equal(events.currentName, "a");
  });

  test("opening an already-open item focuses without duplicating", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    ctl.openOrFocus("b");
    assert.deepEqual(ctl.getOpenItems(), ["a", "b"]);
    assert.equal(ctl.getActiveItem(), "b");
  });

  test("switching flushes the outgoing buffer and installs the incoming state", () => {
    const { ctl, events } = makeHarness();
    ctl.openOrFocus("a");
    ctl.openOrFocus("b");
    assert.ok(events.flushed >= 1, "flushToStore called on switch");
    assert.ok(events.installed.length >= 1, "installState called");
  });

  test("persists openTabs + activeTab after a focus change", () => {
    const { ctl, _idx } = makeHarness();
    ctl.openOrFocus("a");
    ctl.openOrFocus("b");
    assert.deepEqual(_idx().uiState.openTabs, ["a", "b"]);
    assert.equal(_idx().uiState.activeTab, "b");
  });
});

describe("createTabController: close + neighbor focus", () => {
  test("closing the focused tab focuses the right neighbor", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b", "c"], activeTab: "b" });
    ctl.hydrate();
    ctl.close("b");
    assert.deepEqual(ctl.getOpenItems(), ["a", "c"]);
    assert.equal(ctl.getActiveItem(), "c"); // right neighbor
  });

  test("closing the last (rightmost) focused tab focuses the left neighbor", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "b" });
    ctl.hydrate();
    ctl.close("b");
    assert.equal(ctl.getActiveItem(), "a");
  });

  test("closing the only tab leaves an empty open set with null focus", () => {
    const { ctl } = makeHarness({ openTabs: ["a"], activeTab: "a" });
    ctl.hydrate();
    ctl.close("a");
    assert.deepEqual(ctl.getOpenItems(), []);
    assert.equal(ctl.getActiveItem(), null);
  });

  test("closing a non-focused tab leaves focus unchanged", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b", "c"], activeTab: "b" });
    ctl.hydrate();
    ctl.close("a");
    assert.equal(ctl.getActiveItem(), "b");
    assert.deepEqual(ctl.getOpenItems(), ["b", "c"]);
  });
});

describe("createTabController: reorder + reKey", () => {
  test("reorder moves an item to a new index and persists", () => {
    const { ctl, _idx } = makeHarness({ openTabs: ["a", "b", "c"], activeTab: "a" });
    ctl.hydrate();
    ctl.reorder("c", 0); // move c to front
    assert.deepEqual(ctl.getOpenItems(), ["c", "a", "b"]);
    assert.deepEqual(_idx().uiState.openTabs, ["c", "a", "b"]);
  });

  test("reKey renames an open item in place, preserving order and focus", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b", "c"], activeTab: "b" });
    ctl.hydrate();
    ctl.reKey("b", "b2");
    assert.deepEqual(ctl.getOpenItems(), ["a", "b2", "c"]);
    assert.equal(ctl.getActiveItem(), "b2");
  });

  test("reKey updates playingItem and orphanedPlaying when they match", () => {
    const { ctl } = makeHarness({ openTabs: ["a"], activeTab: "a" });
    ctl.hydrate();
    ctl.setPlaying("a");
    ctl.reKey("a", "a2");
    assert.equal(ctl.getPlayingItem(), "a2");
  });
});

describe("createTabController: playing + orphan", () => {
  test("setPlaying records the playing item", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    ctl.setPlaying("a");
    assert.equal(ctl.getPlayingItem(), "a");
    assert.equal(ctl.getOrphanedPlaying(), null);
  });

  test("closing the playing tab orphans playback (audio continues)", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    ctl.setPlaying("a");
    ctl.close("a");
    assert.equal(ctl.getPlayingItem(), null);
    assert.equal(ctl.getOrphanedPlaying(), "a");
  });

  test("clearPlaying resets both playing and orphan state", () => {
    const { ctl } = makeHarness({ openTabs: ["a"], activeTab: "a" });
    ctl.hydrate();
    ctl.setPlaying("a");
    ctl.close("a");
    ctl.clearPlaying();
    assert.equal(ctl.getPlayingItem(), null);
    assert.equal(ctl.getOrphanedPlaying(), null);
  });

  test("reopening an orphaned playing item via openOrFocus clears orphan into playingItem", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "b" });
    ctl.hydrate();
    ctl.setPlaying("a");
    ctl.close("a");
    assert.equal(ctl.getOrphanedPlaying(), "a");
    ctl.openOrFocus("a"); // jump-to-playing
    assert.equal(ctl.getOrphanedPlaying(), null);
    assert.equal(ctl.getPlayingItem(), "a");
  });
});

describe("createTabController: adoptInitial (boot focus)", () => {
  test("focuses the boot pattern without swapping, adding it to the open set", () => {
    const { ctl, events } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    ctl.adoptInitial("shared-x"); // editor already shows shared-x; not previously open
    assert.ok(ctl.getOpenItems().includes("shared-x"));
    assert.equal(ctl.getActiveItem(), "shared-x");
    assert.equal(events.installed.length, 0, "adoptInitial must NOT install/swap a state");
  });

  test("adopting the already-active boot pattern keeps the set and installs nothing", () => {
    const { ctl, events } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    ctl.adoptInitial("a");
    assert.deepEqual(ctl.getOpenItems(), ["a", "b"]);
    assert.equal(ctl.getActiveItem(), "a");
    assert.equal(events.installed.length, 0);
  });

  test("adoptInitial seeds a single tab when the open set was empty", () => {
    const { ctl } = makeHarness({ openTabs: [], activeTab: null });
    ctl.hydrate();
    ctl.adoptInitial("05-dub");
    assert.deepEqual(ctl.getOpenItems(), ["05-dub"]);
    assert.equal(ctl.getActiveItem(), "05-dub");
  });
});

describe("createTabController: refresh (revert)", () => {
  test("rebuilds + reinstalls the active tab's state from the working copy", () => {
    const { ctl, events } = makeHarness({ openTabs: ["a"], activeTab: "a" });
    ctl.hydrate();
    const before = events.installed.length;
    ctl.refresh("a");
    assert.ok(events.installed.length > before, "installState called on active refresh");
  });

  test("refreshing a non-active open tab evicts but does not install", () => {
    const { ctl, events } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    const before = events.installed.length;
    ctl.refresh("b");
    assert.equal(events.installed.length, before, "no install for a non-active refresh");
  });
});
