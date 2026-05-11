import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createLocalStore } from "./store.js";

// Minimal localStorage stub so the store can run under node:test.
class LocalStorageStub {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

beforeEach(() => {
  globalThis.localStorage = new LocalStorageStub();
});

describe("store: existing surface still works after additions", () => {
  test("get returns null for unknown name", () => {
    const s = createLocalStore();
    assert.equal(s.get("nope"), null);
  });

  test("set/get roundtrip a record without folder field (legacy shape)", () => {
    const s = createLocalStore();
    const rec = { code: "x", modified: "2026-05-11T00:00:00Z", isUserPattern: true };
    s.set("a", rec);
    assert.deepEqual(s.get("a"), rec);
  });

  test("set/get roundtrip a record with folder field", () => {
    const s = createLocalStore();
    const rec = { code: "x", modified: "2026-05-11T00:00:00Z", isUserPattern: true, folder: "Jazz" };
    s.set("a", rec);
    assert.deepEqual(s.get("a"), rec);
  });

  test("index defaults to {lastOpen: null, userPatterns: []}", () => {
    const s = createLocalStore();
    assert.deepEqual(s.getIndex(), { lastOpen: null, userPatterns: [] });
  });

  test("index round-trips folders and uiState", () => {
    const s = createLocalStore();
    s.setIndex({
      lastOpen: "a",
      userPatterns: ["a"],
      folders: ["Jazz", "Live"],
      uiState: { collapsedFolders: ["Jazz", "__demos__"], lastNewPatternFolder: "Live" },
    });
    assert.deepEqual(s.getIndex(), {
      lastOpen: "a",
      userPatterns: ["a"],
      folders: ["Jazz", "Live"],
      uiState: { collapsedFolders: ["Jazz", "__demos__"], lastNewPatternFolder: "Live" },
    });
  });
});

describe("store.renamePatternKey", () => {
  test("moves a record from one name to another, preserves contents", () => {
    const s = createLocalStore();
    const rec = { code: "x", modified: "t", isUserPattern: true, folder: "Jazz" };
    s.set("old", rec);
    s.renamePatternKey("old", "new");
    assert.equal(s.get("old"), null);
    assert.deepEqual(s.get("new"), rec);
  });

  test("no-op when source name has no record", () => {
    const s = createLocalStore();
    s.renamePatternKey("ghost", "new");
    assert.equal(s.get("new"), null);
  });

  test("overwrites if a record already exists at the new name (caller is responsible for uniqueness)", () => {
    const s = createLocalStore();
    s.set("old", { code: "A", modified: "t", isUserPattern: true });
    s.set("new", { code: "B", modified: "t", isUserPattern: true });
    s.renamePatternKey("old", "new");
    assert.deepEqual(s.get("new"), { code: "A", modified: "t", isUserPattern: true });
    assert.equal(s.get("old"), null);
  });
});

describe("store.renameFolderInRecords", () => {
  test("rewrites every user-pattern record whose folder matches old name", () => {
    const s = createLocalStore();
    s.set("a", { code: "1", modified: "t", isUserPattern: true, folder: "Jazz" });
    s.set("b", { code: "2", modified: "t", isUserPattern: true, folder: "Jazz" });
    s.set("c", { code: "3", modified: "t", isUserPattern: true, folder: "Live" });
    const n = s.renameFolderInRecords("Jazz", "Bebop");
    assert.equal(n, 2);
    assert.equal(s.get("a").folder, "Bebop");
    assert.equal(s.get("b").folder, "Bebop");
    assert.equal(s.get("c").folder, "Live");
  });

  test("ignores Demo working copies (records where isUserPattern === false)", () => {
    const s = createLocalStore();
    s.set("05-dub", { code: "1", modified: "t", isUserPattern: false, folder: "Jazz" });
    const n = s.renameFolderInRecords("Jazz", "Bebop");
    assert.equal(n, 0);
    assert.equal(s.get("05-dub").folder, "Jazz"); // ignored, untouched
  });

  test("ignores records with no folder field", () => {
    const s = createLocalStore();
    s.set("a", { code: "1", modified: "t", isUserPattern: true });
    const n = s.renameFolderInRecords("Jazz", "Bebop");
    assert.equal(n, 0);
    assert.equal(s.get("a").folder, undefined);
  });

  test("returns zero when no records match", () => {
    const s = createLocalStore();
    assert.equal(s.renameFolderInRecords("Anything", "Else"), 0);
  });
});
