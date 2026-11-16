import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createLocalStore, describeStorageEvent } from "./store.js";
import { createMemoryStorage, diagnoseStorage, installStorageGuard } from "./storage-guard.js";

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

describe("store: write-health reporting", () => {
  function quota() { const e = new Error("full"); e.name = "QuotaExceededError"; return e; }

  test("a failed write is reported and stays reported until that key saves again", () => {
    const s = createLocalStore();
    const seen = [];
    const off = s.onWriteStatus((st) => seen.push(st));
    const realSetItem = localStorage.setItem.bind(localStorage);
    let full = true;
    localStorage.setItem = (k, v) => { if (full && k.includes("pattern:big")) throw quota(); realSetItem(k, v); };

    assert.throws(() => s.set("big", { code: "x".repeat(10) }, { retry: true }), { name: "QuotaExceededError" });
    assert.deepEqual(seen.at(-1), { failing: true, quota: true });

    // An unrelated small write succeeding does NOT clear the problem.
    s.setIndex({ lastOpen: null, userPatterns: [] });
    s.set("small", { code: "y" });
    assert.equal(seen.at(-1).failing, true);

    full = false;
    assert.equal(s.set("big", { code: "x" }), true);
    assert.deepEqual(seen.at(-1), { failing: false, quota: false });
    off();
  });

  test("non-quota failures are reported too, and set() returns false", () => {
    const s = createLocalStore();
    const seen = [];
    const off = s.onWriteStatus((st) => seen.push(st));
    localStorage.setItem = () => { throw new Error("denied"); };
    assert.equal(s.set("a", { code: "x" }, { retry: true }), false);
    assert.deepEqual(seen.at(-1), { failing: true, quota: false });
    // Deleting the pattern that couldn't be saved resolves it.
    s.delete("a");
    assert.equal(seen.at(-1).failing, false);
    off();
  });

  test("a one-shot write that fails is not left reported — nothing is waiting to be saved", () => {
    const s = createLocalStore();
    s.set("old", { code: "x" });
    const seen = [];
    const off = s.onWriteStatus((st) => seen.push(st));
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k, v) => { if (k.includes("pattern:")) throw quota(); realSetItem(k, v); };

    // A new pattern / captured take / import that doesn't fit.
    assert.throws(() => s.set("new", { code: "x" }), { name: "QuotaExceededError" });
    // A rename that doesn't fit; the original record is preserved.
    assert.throws(() => s.renamePatternKey("old", "renamed"), { name: "QuotaExceededError" });
    assert.deepEqual(s.get("old"), { code: "x" });
    assert.deepEqual(seen, []);
    off();
  });

  test("giving up on a retried write clears it", () => {
    const s = createLocalStore();
    const seen = [];
    const off = s.onWriteStatus((st) => seen.push(st));
    localStorage.setItem = () => { throw quota(); };
    assert.throws(() => s.set("a", { code: "x" }, { retry: true }), { name: "QuotaExceededError" });
    assert.equal(seen.at(-1).failing, true);
    s.forgetWriteFailure("a");
    assert.equal(seen.at(-1).failing, false);
    off();
  });

  test("a subscriber that arrives after a failure is told at once", () => {
    const s = createLocalStore();
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => { throw quota(); };
    // e.g. the open-tabs write during boot, before the notice is mounted
    assert.throws(() => s.setIndex({ lastOpen: null, userPatterns: [] }), { name: "QuotaExceededError" });
    const seen = [];
    const off = s.onWriteStatus((st) => seen.push(st));
    assert.deepEqual(seen, [{ failing: true, quota: true }]);
    localStorage.setItem = realSetItem;
    s.setIndex({ lastOpen: null, userPatterns: [] });
    assert.deepEqual(seen.at(-1), { failing: false, quota: false });
    off();

    const quiet = [];
    const off2 = s.onWriteStatus((st) => quiet.push(st));
    assert.deepEqual(quiet, [], "nothing to replay while everything saves");
    off2();
  });
});

describe("describeStorageEvent", () => {
  const idx = (o) => JSON.stringify({ lastOpen: null, userPatterns: [], ...o });

  test("classifies pattern writes and deletions", () => {
    assert.deepEqual(
      describeStorageEvent({ key: "strasbeat:pattern:song", newValue: "{}" }),
      { kind: "pattern", name: "song", removed: false, oldCode: null },
    );
    assert.deepEqual(
      describeStorageEvent({ key: "strasbeat:pattern:song", newValue: null }),
      { kind: "pattern", name: "song", removed: true, oldCode: null },
    );
  });

  test("a pattern change carries the code the record held before it", () => {
    const rec = (code) => JSON.stringify({ code, modified: "t", isUserPattern: true });
    assert.equal(
      describeStorageEvent({ key: "strasbeat:pattern:song", oldValue: rec("A"), newValue: rec("B") }).oldCode,
      "A",
    );
    assert.equal(
      describeStorageEvent({ key: "strasbeat:pattern:song", oldValue: rec("A"), newValue: null }).oldCode,
      "A",
    );
    assert.equal(
      describeStorageEvent({ key: "strasbeat:pattern:song", oldValue: "not json", newValue: rec("B") }).oldCode,
      null,
    );
  });

  test("ignores index writes that only move another window's tabs", () => {
    const e = {
      key: "strasbeat:pattern-index",
      oldValue: idx({ userPatterns: ["a"], uiState: { openTabs: ["a"], activeTab: "a" } }),
      newValue: idx({ userPatterns: ["a"], lastOpen: "b", uiState: { openTabs: ["a", "b"], activeTab: "b" } }),
    };
    assert.equal(describeStorageEvent(e), null);
  });

  test("reports index writes that change the library", () => {
    const e = {
      key: "strasbeat:pattern-index",
      oldValue: idx({ userPatterns: ["a"] }),
      newValue: idx({ userPatterns: ["a", "b"] }),
    };
    assert.deepEqual(describeStorageEvent(e), { kind: "index" });
    assert.deepEqual(
      describeStorageEvent({ key: "strasbeat:pattern-index", oldValue: idx({}), newValue: idx({ folders: ["Jazz"] }) }),
      { kind: "index" },
    );
  });

  test("ignores unrelated keys; flags a full clear", () => {
    assert.equal(describeStorageEvent({ key: "strasbeat:accent", newValue: "x" }), null);
    assert.deepEqual(describeStorageEvent({ key: null }), { kind: "cleared" });
  });
});

describe("storage guard", () => {
  test("a working localStorage is left alone", () => {
    const real = new LocalStorageStub();
    const win = { localStorage: real };
    assert.equal(installStorageGuard(win), null);
    assert.equal(win.localStorage, real);
    assert.equal(real.length, 0, "probe key cleaned up");
  });

  test("blocked storage (the getter throws) is replaced by an in-memory stand-in", () => {
    const win = {};
    Object.defineProperty(win, "localStorage", {
      configurable: true,
      get() { const e = new Error("denied"); e.name = "SecurityError"; throw e; },
    });
    assert.equal(installStorageGuard(win), "blocked");
    win.localStorage.setItem("k", "v");
    assert.equal(win.localStorage.getItem("k"), "v");
    assert.equal(win.localStorage.getItem("missing"), null);
    assert.equal(win.localStorage.key(0), "k");
    assert.equal(win.localStorage.length, 1);
  });

  test("a null localStorage is replaced too", () => {
    const win = { localStorage: null };
    assert.equal(installStorageGuard(win), "blocked");
    assert.equal(win.localStorage.getItem("x"), null);
  });

  test("an empty storage that refuses every write is replaced", () => {
    const zero = new LocalStorageStub();
    zero.setItem = () => { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; };
    assert.equal(diagnoseStorage({ localStorage: zero }), "readonly");
  });

  test("a FULL storage holding data is never swapped out (that would hide the user's patterns)", () => {
    const full = new LocalStorageStub();
    full.setItem("strasbeat:pattern:song", "{}");
    full.setItem = () => { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; };
    const win = { localStorage: full };
    assert.equal(installStorageGuard(win), null);
    assert.equal(win.localStorage, full);
  });

  test("the stand-in behaves like Storage", () => {
    const m = createMemoryStorage();
    m.setItem("a", 1);
    assert.equal(m.getItem("a"), "1");
    m.removeItem("a");
    assert.equal(m.length, 0);
  });
});
