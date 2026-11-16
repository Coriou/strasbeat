import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  createAutosave,
  discoverPatterns,
  handleExternalStoreChange,
  reconcileStoredPatterns,
  groupUserPatternsByFolder,
  saveNewPattern,
  validateFolderName,
  validatePatternName,
  resolveWorkingCopy,
} from "./patterns.js";
import { createLocalStore, describeStorageEvent } from "./store.js";
import { createMemoryStorage } from "./storage-guard.js";
import { createTabController } from "./tabs.js";

// In-memory store stub matching the createLocalStore interface.
function makeStore({ index = { lastOpen: null, userPatterns: [], folders: [] }, records = {} } = {}) {
  const recs = new Map(Object.entries(records));
  return {
    get: (name) => (recs.has(name) ? recs.get(name) : null),
    set: (name, rec) => recs.set(name, rec),
    delete: (name) => recs.delete(name),
    keys: () => Array.from(recs.keys()),
    getIndex: () => structuredClone(index),
    setIndex: (idx) => Object.assign(index, idx),
    renamePatternKey: () => {},
    renameFolderInRecords: () => 0,
  };
}

describe("groupUserPatternsByFolder", () => {
  test("returns empty groups when no user patterns exist", () => {
    const store = makeStore();
    const result = groupUserPatternsByFolder(store);
    assert.deepEqual(result, { folders: {}, unfiled: [] });
  });

  test("groups patterns into their declared folders, leaves unset/unknown in Unfiled", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["a", "b", "c", "d"], folders: ["Jazz", "Live"] },
      records: {
        a: { code: "1", modified: "2026-05-10T00:00:00Z", isUserPattern: true, folder: "Jazz" },
        b: { code: "2", modified: "2026-05-11T00:00:00Z", isUserPattern: true, folder: "Jazz" },
        c: { code: "3", modified: "2026-05-09T00:00:00Z", isUserPattern: true }, // unfiled
        d: { code: "4", modified: "2026-05-12T00:00:00Z", isUserPattern: true, folder: "Bogus" }, // orphan
      },
    });
    const result = groupUserPatternsByFolder(store);
    // Both declared folders are present; empty ones get [] (matches the
    // docstring "Includes empty folders" and the spec's empty-folder hint).
    assert.deepEqual(Object.keys(result.folders).sort(), ["Jazz", "Live"]);
    // Jazz contains a and b, sorted by modified desc (most recent first).
    assert.deepEqual(result.folders.Jazz, ["b", "a"]);
    assert.deepEqual(result.folders.Live, []);
    // Unfiled contains c (no folder) and d (orphan folder), sorted by modified desc.
    assert.deepEqual(result.unfiled, ["d", "c"]);
  });

  test("includes empty folders (declared in index.folders but with zero patterns)", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: [], folders: ["Empty1", "Empty2"] },
    });
    const result = groupUserPatternsByFolder(store);
    assert.deepEqual(result.folders, { Empty1: [], Empty2: [] });
  });

  test("excludes Demo working copies (isUserPattern false) from groups", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: [], folders: ["Jazz"] },
      records: {
        "05-dub": { code: "x", modified: "t", isUserPattern: false }, // Demo working copy
      },
    });
    const result = groupUserPatternsByFolder(store);
    assert.deepEqual(result.folders.Jazz, []);
    assert.deepEqual(result.unfiled, []);
  });
});

describe("validateFolderName", () => {
  test("accepts a simple name", () => {
    assert.equal(validateFolderName("Jazz", []), null);
  });

  test("accepts unicode letters and spaces", () => {
    assert.equal(validateFolderName("Café Sessions", []), null);
  });

  test("rejects empty string", () => {
    assert.match(validateFolderName("", []), /can't be empty/i);
  });

  test("rejects whitespace-only", () => {
    assert.match(validateFolderName("   ", []), /can't be empty/i);
  });

  test("rejects > 64 chars", () => {
    assert.match(validateFolderName("a".repeat(65), []), /too long/i);
  });

  test("rejects reserved names case-insensitively", () => {
    for (const name of ["Demos", "demos", "DEMOS", "Unfiled", "unfiled"]) {
      assert.match(validateFolderName(name, []), /reserved/i);
    }
  });

  test("rejects duplicates against existingFolders (case-insensitive)", () => {
    assert.match(validateFolderName("jazz", ["Jazz"]), /already exists/i);
    assert.match(validateFolderName("Jazz", ["jazz"]), /already exists/i);
  });

  test("trims leading/trailing whitespace before validating", () => {
    assert.equal(validateFolderName("  Jazz  ", []), null);
  });
});

describe("validatePatternName (unchanged)", () => {
  test("accepts simple alphanumeric + dash + underscore", () => {
    assert.equal(validatePatternName("my-pattern_2"), null);
  });

  test("rejects spaces and special chars", () => {
    assert.ok(validatePatternName("has space") != null);
    assert.ok(validatePatternName("hash#") != null);
  });
});

// Stubs for saveNewPattern's dependencies. The real implementations live in
// the browser; these mirror just enough of the surface to assert the write
// path lands in the right shape.
function makeFakes() {
  const idx = { lastOpen: null, userPatterns: [], folders: ["Jazz"] };
  const records = new Map();
  const store = {
    get: (n) => (records.has(n) ? records.get(n) : null),
    set: (n, r) => records.set(n, r),
    keys: () => Array.from(records.keys()),
    getIndex: () => structuredClone(idx),
    setIndex: (next) => Object.assign(idx, next),
  };
  const calls = [];
  const leftRail = {
    addUserPattern: (n, f) => calls.push({ kind: "addUserPattern", n, f }),
  };
  let currentName = null;
  const setCurrentName = (n) => { currentName = n; };
  const editor = { setCode: (c) => calls.push({ kind: "setCode", c }) };
  const statuses = [];
  const transport = { setStatus: (s) => statuses.push(s) };
  return { idx, records, store, leftRail, setCurrentName, getCurrent: () => currentName, editor, transport, statuses, calls };
}

describe("saveNewPattern", () => {
  test("writes a user pattern in the chosen folder", async () => {
    const f = makeFakes();
    const r = await saveNewPattern({
      name: "foo",
      code: "sound('bd')",
      folder: "Jazz",
      store: f.store,
      leftRail: f.leftRail,
      setCurrentName: f.setCurrentName,
      editor: f.editor,
      transport: f.transport,
    });
    assert.deepEqual(r, { ok: true });
    const rec = f.store.get("foo");
    assert.equal(rec.code, "sound('bd')");
    assert.equal(rec.isUserPattern, true);
    assert.equal(rec.folder, "Jazz");
    assert.ok(f.idx.userPatterns.includes("foo"));
    assert.equal(f.idx.lastOpen, "foo");
    assert.equal(f.getCurrent(), "foo");
    assert.ok(f.calls.find((c) => c.kind === "addUserPattern" && c.n === "foo" && c.f === "Jazz"));
    assert.ok(f.statuses.some((s) => /created "foo" in Jazz/.test(s)));
  });

  test("Unfiled (no folder) omits the folder field", async () => {
    const f = makeFakes();
    await saveNewPattern({
      name: "bar",
      code: "x",
      folder: null,
      store: f.store,
      leftRail: f.leftRail,
      setCurrentName: f.setCurrentName,
      editor: f.editor,
      transport: f.transport,
    });
    const rec = f.store.get("bar");
    assert.equal(rec.folder, undefined);
    assert.ok(f.statuses.some((s) => /^created "bar"$/.test(s)));
  });

  test("QuotaExceededError surfaces a status and returns ok:false", async () => {
    const f = makeFakes();
    f.store.set = () => {
      const err = new Error("quota");
      err.name = "QuotaExceededError";
      throw err;
    };
    const r = await saveNewPattern({
      name: "quota",
      code: "x",
      store: f.store,
      leftRail: f.leftRail,
      setCurrentName: f.setCurrentName,
      editor: f.editor,
      transport: f.transport,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "storage full");
    assert.ok(f.statuses.some((s) => /storage full/i.test(s)));
  });
});

// ─── Autosave ────────────────────────────────────────────────────────────

function makeAutosave({ patterns = {}, records = {}, index, currentName = "song", code = "" } = {}) {
  const store = makeStore({
    index: index ?? { lastOpen: null, userPatterns: Object.keys(records).filter((n) => !(n in patterns)), folders: [] },
    records,
  });
  const writes = [];
  const realSet = store.set;
  store.set = (name, rec) => { writes.push(name); return realSet(name, rec); };
  const editor = { code };
  const state = { currentName, statuses: [], dirtyUpdates: 0, added: [] };
  const autosave = createAutosave({
    editor,
    store,
    patterns,
    patternNames: Object.keys(patterns),
    getCurrentName: () => state.currentName,
    leftRail: {
      updateDirtySet: () => { state.dirtyUpdates++; },
      addUserPattern: (name) => { state.added.push(name); },
    },
    transport: { setStatus: (s) => state.statuses.push(s) },
  });
  // An edit = the buffer changes and the editor's update listener schedules.
  const edit = (next) => { editor.code = next; autosave.scheduleAutosave(); };
  return { store, editor, state, writes, edit, ...autosave };
}

describe("createAutosave", () => {
  test("a flush keeps the record's folder (and any other field it doesn't own)", () => {
    const h = makeAutosave({
      records: { song: { code: "A", modified: "2026-01-01T00:00:00Z", isUserPattern: true, folder: "Jazz", extra: 1 } },
      index: { lastOpen: null, userPatterns: ["song"], folders: ["Jazz"] },
      code: "A",
    });
    h.edit("A2");
    assert.equal(h.flushToStore(), true);
    const rec = h.store.get("song");
    assert.equal(rec.code, "A2");
    assert.equal(rec.folder, "Jazz");
    assert.equal(rec.extra, 1);
    assert.equal(rec.isUserPattern, true);
    assert.notEqual(rec.modified, "2026-01-01T00:00:00Z");
    assert.deepEqual(groupUserPatternsByFolder(h.store), { folders: { Jazz: ["song"] }, unfiled: [] });
  });

  test("a flush with no edit since the last one writes nothing", () => {
    const h = makeAutosave({
      records: { song: { code: "A", modified: "2026-01-01T00:00:00Z", isUserPattern: true } },
      code: "A",
    });
    assert.equal(h.flushToStore(), false);
    h.flushToStore();
    assert.deepEqual(h.writes, []);
    assert.equal(h.store.get("song").modified, "2026-01-01T00:00:00Z");
  });

  test("viewing a shipped pattern never creates a working copy", () => {
    const h = makeAutosave({ patterns: { demo: "DEMO" }, currentName: "demo", code: "DEMO" });
    h.flushToStore(); // tab switch / page hide with no edit
    assert.equal(h.store.get("demo"), null);
  });

  test("a second flush after one edit does not rewrite the record", () => {
    const h = makeAutosave({
      records: { song: { code: "A", modified: "t0", isUserPattern: true } },
      code: "A",
    });
    h.edit("B");
    h.flushToStore();
    h.flushToStore();
    assert.deepEqual(h.writes, ["song"]);
  });

  test("an edit that leaves the code unchanged does not bump `modified`", () => {
    const h = makeAutosave({
      records: { song: { code: "A", modified: "t0", isUserPattern: true } },
      code: "A",
    });
    h.edit("AB");
    h.editor.code = "A"; // typed a character, deleted it again
    h.flushToStore();
    assert.deepEqual(h.writes, []);
    assert.equal(h.store.get("song").modified, "t0");
  });

  test("a shipped pattern edited back to its original drops the working copy", () => {
    const h = makeAutosave({
      patterns: { demo: "DEMO" },
      records: { demo: { code: "DEMO edited", modified: "t0", isUserPattern: false } },
      currentName: "demo",
      code: "DEMO edited",
    });
    h.edit("DEMO");
    h.flushToStore();
    assert.equal(h.store.get("demo"), null);
    assert.equal(h.state.dirtyUpdates, 1, "dirty dot cleared");
  });

  test("editing a shipped pattern writes a working copy flagged as not-user", () => {
    const h = makeAutosave({ patterns: { demo: "DEMO" }, currentName: "demo", code: "DEMO" });
    h.edit("DEMO!");
    h.flushToStore();
    assert.deepEqual(h.store.get("demo").isUserPattern, false);
    assert.equal(h.store.get("demo").code, "DEMO!");
    assert.equal(h.state.dirtyUpdates, 1);
  });

  test("pending edits are dropped, not misfiled, when their pattern is no longer the live buffer", () => {
    const h = makeAutosave({
      records: {
        song: { code: "A", modified: "t0", isUserPattern: true },
        other: { code: "O", modified: "t0", isUserPattern: true },
      },
      code: "A",
    });
    h.edit("A-edited");
    // "song" is deleted and its tab closed without a flush; "other" takes over.
    h.store.delete("song");
    h.state.currentName = "other";
    h.editor.code = "O";
    h.flushToStore();
    assert.equal(h.store.get("song"), null, "deleted pattern is not written back");
    assert.equal(h.store.get("other").code, "O");
    assert.deepEqual(h.writes, []);
  });

  test("nothing is scheduled while no pattern is open", () => {
    const h = makeAutosave({ currentName: null, code: "stale" });
    h.edit("stale edited");
    assert.equal(h.hasPending(null), false);
    assert.equal(h.flushToStore(), false);
    assert.deepEqual(h.writes, []);
  });

  test("a failed write keeps the edits pending and the next flush retries", () => {
    const h = makeAutosave({
      records: { song: { code: "A", modified: "t0", isUserPattern: true } },
      code: "A",
    });
    const realSet = h.store.set;
    let full = true;
    h.store.set = (n, r) => {
      if (full) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
      return realSet(n, r);
    };
    h.edit("B");
    assert.equal(h.flushToStore(), false);
    assert.equal(h.hasPending("song"), true);
    assert.match(h.state.statuses.at(-1), /storage full/);
    assert.equal(h.store.get("song").code, "A");
    full = false;
    assert.equal(h.flushToStore(), true);
    assert.equal(h.store.get("song").code, "B");
    assert.equal(h.hasPending("song"), false);
  });

  function fullStore(h) {
    const realSet = h.store.set;
    const state = { full: true };
    h.store.set = (n, r) => {
      if (state.full) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
      return realSet(n, r);
    };
    return state;
  }
  const twoSongs = () => ({
    song: { code: "A", modified: "t0", isUserPattern: true, folder: "Jazz" },
    other: { code: "O", modified: "t0", isUserPattern: true },
  });

  test("a write that failed is still owed after switching tab, and is stored once there is room", () => {
    const h = makeAutosave({ records: twoSongs(), code: "A" });
    const storage = fullStore(h);
    h.edit("A-edited");
    assert.equal(h.flushToStore(), false); // the flush on tab switch
    h.state.currentName = "other";
    h.editor.code = "O";
    h.flushToStore(); // any later flush, storage still full
    assert.equal(h.store.get("song").code, "A");
    assert.equal(h.hasPending("song"), true, "still owed");

    storage.full = false; // the user freed space
    h.flushToStore();
    assert.equal(h.store.get("song").code, "A-edited");
    assert.equal(h.store.get("song").folder, "Jazz");
    assert.equal(h.store.get("other").code, "O", "the live buffer is not misfiled");
    assert.equal(h.hasPending("song"), false);
  });

  test("a failed write is not replayed over a pattern that was deleted or rewritten since", () => {
    const h = makeAutosave({ records: { ...twoSongs(), third: { code: "T", modified: "t0", isUserPattern: true } }, code: "A" });
    const storage = fullStore(h);
    h.edit("A-edited");
    h.flushToStore();
    h.state.currentName = "third";
    h.edit("T-edited");
    h.flushToStore();
    h.state.currentName = "other";
    h.editor.code = "O";
    storage.full = false;
    h.store.delete("song"); // deleted
    h.store.set("third", { code: "T-imported", modified: "t1", isUserPattern: true }); // e.g. an import
    const warn = console.warn;
    console.warn = () => {};
    try { h.flushToStore(); } finally { console.warn = warn; }
    assert.equal(h.store.get("song"), null);
    assert.equal(h.store.get("third").code, "T-imported");
    assert.equal(h.hasPending("song"), false);
    assert.equal(h.hasPending("third"), false);
  });

  test("a failed write follows its pattern through a rename", () => {
    const h = makeAutosave({ records: twoSongs(), code: "A" });
    const storage = fullStore(h);
    h.edit("A-edited");
    h.flushToStore(); // the flush that precedes the rename
    // The rename itself goes through (a raw key move).
    const rec = h.store.get("song");
    h.store.delete("song");
    storage.full = false;
    h.store.set("tune", rec);
    h.writes.length = 0;
    h.renamePending("song", "tune");
    h.state.currentName = "tune";
    assert.equal(h.hasPending("tune"), true);
    assert.equal(h.flushToStore(), true);
    assert.equal(h.store.get("tune").code, "A-edited");
    assert.equal(h.store.get("song"), null);
  });

  test("a user pattern whose record vanished is re-created AND re-listed", () => {
    const h = makeAutosave({ records: {}, index: { lastOpen: null, userPatterns: [], folders: [] }, code: "A" });
    h.edit("A2");
    h.flushToStore();
    assert.equal(h.store.get("song").code, "A2");
    assert.deepEqual(h.store.getIndex().userPatterns, ["song"]);
    assert.deepEqual(h.state.added, ["song"]);
  });
});

describe("discoverPatterns", () => {
  test("`in` is only true for real pattern files, not Object.prototype keys", () => {
    const { patterns, patternNames } = discoverPatterns({
      "../patterns/b.js": { default: "B" },
      "../patterns/a.js": { default: "A" },
    });
    assert.deepEqual(patternNames, ["a", "b"]);
    assert.equal("a" in patterns, true);
    assert.equal("constructor" in patterns, false);
    assert.equal("toString" in patterns, false);
  });
});

describe("validateFolderName: sentinel keys", () => {
  test("rejects the rail's internal section keys", () => {
    for (const n of ["__unfiled__", "__demos__", "__new__"]) {
      assert.match(validateFolderName(n, []), /reserved/);
    }
  });
});

describe("reconcileStoredPatterns", () => {
  test("re-lists a stored pattern the index lost track of", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["kept"], folders: [] },
      records: {
        kept: { code: "K", modified: "t", isUserPattern: true },
        "shared-beat": { code: "S", modified: "t", isUserPattern: true },
        "old-demo": { code: "edits to a demo that was removed", modified: "t", isUserPattern: false },
      },
    });
    const r = reconcileStoredPatterns({ store, patterns: { demo: "DEMO" } });
    assert.deepEqual(r.promoted.sort(), ["old-demo", "shared-beat"]);
    assert.deepEqual(store.getIndex().userPatterns.sort(), ["kept", "old-demo", "shared-beat"]);
    assert.equal(store.get("old-demo").isUserPattern, true);
    assert.deepEqual(groupUserPatternsByFolder(store).unfiled.sort(), ["kept", "old-demo", "shared-beat"]);
  });

  test("drops empty unlisted records and working copies identical to the shipped original", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: [], folders: [] },
      records: {
        ghost: { code: "", modified: "t", isUserPattern: true },
        demo: { code: "DEMO", modified: "t", isUserPattern: false },
        edited: { code: "EDITED v2", modified: "t", isUserPattern: false },
      },
    });
    const r = reconcileStoredPatterns({ store, patterns: { demo: "DEMO", edited: "EDITED" } });
    assert.deepEqual(r.dropped.sort(), ["demo", "ghost"]);
    assert.equal(store.get("ghost"), null);
    assert.equal(store.get("demo"), null);
    assert.equal(store.get("edited").code, "EDITED v2", "a real edit is never dropped");
    assert.deepEqual(store.getIndex().userPatterns, []);
  });

  test("leaves a healthy library untouched", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["a"], folders: [] },
      records: { a: { code: "A", modified: "t", isUserPattern: true } },
    });
    assert.deepEqual(reconcileStoredPatterns({ store, patterns: {} }), { promoted: [], dropped: [] });
  });
});

describe("handleExternalStoreChange (another window wrote the store)", () => {
  function harness({ open = ["song"], active = "song", pending = null, activeCode = "A", records = {}, patterns = {}, canTranspile } = {}) {
    const calls = { refreshed: [], closed: [], kept: [], rail: 0, statuses: [] };
    const store = makeStore({ records });
    const deps = {
      tabs: {
        getOpenItems: () => open,
        getActiveItem: () => active,
        refresh: (n, opts) => calls.refreshed.push([n, opts]),
        close: (n, opts) => calls.closed.push([n, opts]),
      },
      patterns,
      store,
      hasPending: (n) => n === pending,
      getActiveCode: () => activeCode,
      keepLocalEdits: (n) => calls.kept.push(n),
      canTranspile,
      refreshRail: () => { calls.rail++; },
      setStatus: (s) => calls.statuses.push(s),
    };
    return { calls, deps };
  }
  const user = (code, extra) => ({ code, isUserPattern: true, ...extra });
  const NO_HEAL = { heal: false };
  const NO_FLUSH = { flush: false };

  test("a tab still showing the old stored code follows the newer version — without healing", () => {
    const { calls, deps } = harness({ records: { song: user("B") } });
    handleExternalStoreChange({ kind: "pattern", name: "song", removed: false, oldCode: "A" }, deps);
    assert.deepEqual(calls.refreshed, [["song", NO_HEAL]]);
    assert.deepEqual(calls.kept, []);
    assert.equal(calls.rail, 1);
  });

  test("an untouched shipped pattern follows the first working copy written elsewhere", () => {
    const { calls, deps } = harness({
      open: ["demo"], active: "demo", activeCode: "DEMO", patterns: { demo: "DEMO" },
      records: { demo: { code: "DEMO edited", isUserPattern: false } },
    });
    handleExternalStoreChange({ kind: "pattern", name: "demo", removed: false, oldCode: null }, deps);
    assert.deepEqual(calls.refreshed, [["demo", NO_HEAL]]);
  });

  test("the live tab is left alone when the code is the same (only metadata changed)", () => {
    const { calls, deps } = harness({ records: { song: user("A", { folder: "Jazz" }) } });
    handleExternalStoreChange({ kind: "pattern", name: "song", removed: false, oldCode: "A" }, deps);
    assert.deepEqual(calls.refreshed, []);
    assert.deepEqual(calls.kept, []);
    assert.equal(calls.rail, 1);
  });

  test("edits still pending in this window are not discarded — and the user is told", () => {
    const { calls, deps } = harness({ pending: "song", records: { song: user("B") } });
    handleExternalStoreChange({ kind: "pattern", name: "song", removed: false, oldCode: "A" }, deps);
    assert.deepEqual(calls.refreshed, []);
    assert.deepEqual(calls.closed, []);
    assert.match(calls.statuses[0], /another window/);
  });

  test("a buffer that is neither the old nor the new stored code is kept and queued to be stored", () => {
    const { calls, deps } = harness({ activeCode: "mine", records: { song: user("B") } });
    handleExternalStoreChange({ kind: "pattern", name: "song", removed: false, oldCode: "A" }, deps);
    assert.deepEqual(calls.refreshed, []);
    assert.deepEqual(calls.kept, ["song"]);
    assert.match(calls.statuses[0], /keeping this window/);
  });

  test("a user pattern deleted elsewhere closes its tab here, without writing it back", () => {
    const { calls, deps } = harness();
    handleExternalStoreChange({ kind: "pattern", name: "song", removed: true, oldCode: "A" }, deps);
    assert.deepEqual(calls.closed, [["song", NO_FLUSH]]);
  });

  test("a user pattern deleted elsewhere is kept when this window's buffer has moved on from it", () => {
    const { calls, deps } = harness({ activeCode: "mine" });
    handleExternalStoreChange({ kind: "pattern", name: "song", removed: true, oldCode: "A" }, deps);
    assert.deepEqual(calls.closed, []);
    assert.deepEqual(calls.kept, ["song"]);
  });

  test("a shipped pattern reverted elsewhere refreshes a tab that still shows the reverted copy", () => {
    const { calls, deps } = harness({ open: ["demo"], active: "demo", activeCode: "DEMO edited", patterns: { demo: "DEMO" } });
    handleExternalStoreChange({ kind: "pattern", name: "demo", removed: true, oldCode: "DEMO edited" }, deps);
    assert.deepEqual(calls.refreshed, [["demo", NO_HEAL]]);
    assert.deepEqual(calls.closed, []);
  });

  test("a shipped pattern's copy removed elsewhere never replaces a buffer holding other content", () => {
    const { calls, deps } = harness({ open: ["demo"], active: "demo", activeCode: "DEMO edited more", patterns: { demo: "DEMO" } });
    handleExternalStoreChange({ kind: "pattern", name: "demo", removed: true, oldCode: "DEMO edited" }, deps);
    assert.deepEqual(calls.refreshed, []);
    assert.deepEqual(calls.kept, ["demo"]);
  });

  test("a copy removed while it does not transpile was healed away, not reverted: the buffer is kept", () => {
    const { calls, deps } = harness({
      open: ["demo"], active: "demo", activeCode: "DEMO + (", patterns: { demo: "DEMO" },
      canTranspile: (code) => !code.includes("("),
    });
    handleExternalStoreChange({ kind: "pattern", name: "demo", removed: true, oldCode: "DEMO + (" }, deps);
    assert.deepEqual(calls.refreshed, []);
    assert.deepEqual(calls.kept, ["demo"]);
    assert.match(calls.statuses[0], /keeping this window/);
  });

  test("a background tab drops its cached state; a deleted one closes", () => {
    const { calls, deps } = harness({ open: ["song", "b"], active: "b", activeCode: "B", records: { song: user("A2") } });
    handleExternalStoreChange({ kind: "pattern", name: "song", removed: false, oldCode: "A" }, deps);
    assert.deepEqual(calls.refreshed, [["song", NO_HEAL]]);
    deps.store.delete("song");
    handleExternalStoreChange({ kind: "pattern", name: "song", removed: true, oldCode: "A2" }, deps);
    assert.deepEqual(calls.closed, [["song", NO_FLUSH]]);
  });

  test("changes to patterns not open here only refresh the library", () => {
    const { calls, deps } = harness();
    handleExternalStoreChange({ kind: "pattern", name: "elsewhere", removed: false, oldCode: null }, deps);
    handleExternalStoreChange({ kind: "index" }, deps);
    handleExternalStoreChange(null, deps);
    assert.deepEqual(calls.refreshed, []);
    assert.equal(calls.rail, 2);
  });
});

// Two windows over ONE storage, built from the real store, autosave and tab
// controller. A write in one window is delivered to the other as the storage
// event the browser would fire.
describe("two windows on the same shipped pattern", () => {
  const KEY = "strasbeat:pattern:demo";
  const canTranspile = (code) => !code.includes("(");
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
  });

  function openWindow(store, patterns) {
    const editor = { code: patterns.demo };
    const statuses = [];
    let current = null;
    const transport = { setStatus: (s) => statuses.push(s) };
    const autosave = createAutosave({
      editor, store, patterns, patternNames: Object.keys(patterns),
      getCurrentName: () => current,
      leftRail: { updateDirtySet() {}, addUserPattern() {} },
      transport,
    });
    const resolveCode = (name) => resolveWorkingCopy({ name, patterns, store, canTranspile }).code;
    const tabs = createTabController({
      store, patterns, resolveCode,
      buildState: ({ code }) => ({ code }),
      installState: (state) => { editor.code = state.code; },
      captureState: () => ({ code: editor.code }),
      flushToStore: autosave.flushToStore,
      setCurrentName: (n) => { current = n; },
    });
    tabs.hydrate();
    tabs.adoptInitial("demo");
    return {
      editor, statuses, autosave, tabs,
      type(code) { editor.code = code; autosave.scheduleAutosave(); },
      // What a page load does: resolve the last-open pattern, healing included.
      boot() { editor.code = resolveCode("demo"); },
      receive(e) {
        handleExternalStoreChange(describeStorageEvent(e), {
          tabs, patterns, store,
          hasPending: autosave.hasPending,
          getActiveCode: () => editor.code,
          keepLocalEdits: autosave.scheduleAutosave,
          canTranspile,
          refreshRail() {},
          setStatus: transport.setStatus,
        });
      },
    };
  }

  // Run `act` in one window and return the storage event the other receives.
  function eventFor(act) {
    const oldValue = localStorage.getItem(KEY);
    act();
    const newValue = localStorage.getItem(KEY);
    return oldValue === newValue ? null : { key: KEY, oldValue, newValue };
  }

  function quietly(fn) {
    const warn = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = warn; }
  }

  test("pausing mid-expression in one window does not lose the edit when the other follows", () => {
    const patterns = { demo: "ORIG" };
    const store = createLocalStore();
    const a = openWindow(store, patterns);
    const b = openWindow(store, patterns);
    const edit = "ORIG + my long edit (";

    // A pauses while the code does not parse; its autosave fires.
    a.type(edit);
    const written = eventFor(() => a.autosave.flushToStore());
    assert.equal(store.get("demo").code, edit);

    // B is idle on the same pattern and follows — without deleting the copy.
    const fromB = eventFor(() => quietly(() => b.receive(written)));
    assert.equal(fromB, null, "following must not write to the store");
    assert.equal(b.editor.code, edit);
    assert.equal(store.get("demo").code, edit);
    assert.equal(a.editor.code, edit);
  });

  test("a second window healing the copy as it loads does not wipe the window being typed in", () => {
    const patterns = { demo: "ORIG" };
    const store = createLocalStore();
    const a = openWindow(store, patterns);
    const edit = "ORIG + my long edit (";
    a.type(edit);
    a.autosave.flushToStore();

    // Another window boots on the same pattern: the non-transpiling copy is
    // healed away there.
    const b = openWindow(store, patterns);
    const removal = eventFor(() => quietly(() => b.boot()));
    assert.equal(removal.newValue, null);
    assert.equal(b.editor.code, "ORIG");

    // A gets the removal. Its buffer is the only copy of the edit: kept, and
    // stored again by the next flush.
    a.receive(removal);
    assert.equal(a.editor.code, edit);
    assert.match(a.statuses.at(-1), /keeping this window/);
    assert.equal(a.autosave.hasPending("demo"), true);
    a.autosave.flushToStore();
    assert.equal(store.get("demo").code, edit);
  });

  test("a real revert in one window still reaches the other", () => {
    const patterns = { demo: "ORIG" };
    const store = createLocalStore();
    const a = openWindow(store, patterns);
    const b = openWindow(store, patterns);
    a.type("ORIG.fast2"); // transpiles
    b.receive(eventFor(() => a.autosave.flushToStore()));
    assert.equal(b.editor.code, "ORIG.fast2");

    // B reverts: the working copy is deleted.
    a.receive(eventFor(() => store.delete("demo")));
    assert.equal(a.editor.code, "ORIG");
    assert.equal(store.get("demo"), null);
  });
});
