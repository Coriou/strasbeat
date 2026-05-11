import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  groupUserPatternsByFolder,
  saveNewPattern,
  validateFolderName,
  validatePatternName,
} from "./patterns.js";

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
