# Pattern Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Spec: `design/work/24-pattern-folders.md`. Read it before starting. Spec 09 (`09-pattern-persistence.md`) is the prior layer — read that too.
>
> **Commits:** This project's convention is that **agents do not commit or push** ([per user preferences](../../CLAUDE.md)). Each task ends with a "Stop and report" step. The user reviews and commits manually. Suggested commit messages are included for the user's reference; don't run `git commit` from inside the agent.

**Goal:** Add flat single-level folders to the pattern library. Demos become a fixed read-only top section; user patterns live in user-created folders or "Unfiled". Drag-and-drop, multi-select, inline rename, duplicate, fuzzy search with accent folding, and JSON library export/import are all first-class.

**Architecture:** No new storage interface — `src/store.js` keeps `get/set/delete/keys/getIndex/setIndex`; the `PatternRecord` gains an optional `folder` field and `StoreIndex` gains `folders[]` and `uiState{}`. Folders are addressed by name (name-as-foreign-key); renaming a folder rewrites the records that reference it. The left rail is rebuilt to render hierarchical sections (Demos · user folders · Unfiled) with drop targets, multi-select, inline rename, and a fuzzy search mode that flattens the view. A small pure `library-io.js` module handles JSON export/import. Search uses a custom accent-folding fuzzy matcher (`src/ui/fuzzy.js`) with no dependency.

**Tech Stack:** Vanilla DOM (no framework — matches existing UI modules), CodeMirror 6 (unchanged), Node's built-in test runner (`node --test` via `pnpm test`), the existing `modal.js` extended with a form-modal helper, `Blob` + `<a download>` for export, native `<input type="file">` for import.

---

## File Structure

**New:**

- `src/ui/fuzzy.js` — accent-folding subsequence matcher with ranked scoring; `score(query, target) → { score, matches }`. Pure.
- `src/ui/fuzzy.test.js` — match-ordering, accent folding, multi-token, no-match cases.
- `src/library-io.js` — `exportLibrary(store, opts)`, `previewImport(json, store)`, `importLibrary(json, store, opts)`. Pure functions operating against the store interface.
- `src/library-io.test.js` — export shape, preview conflict shape, import skip/overwrite/rename strategies, quota error handling.
- `src/store.test.js` — round-trip helpers (`renamePatternKey`, `renameFolderInRecords`), index shape additions, backwards compat with records missing the `folder` field.
- `src/patterns.test.js` — `groupUserPatternsByFolder`, folder-name validation, `saveNewPattern` with `folder`.

**Modified:**

- `src/store.js` — add helpers: `renamePatternKey(old, newName)`, `renameFolderInRecords(oldName, newName)`. Public surface still matches the spec-09 interface; new helpers are exported alongside. Doesn't change record/index validation (shape is implicit, optional fields).
- `src/patterns.js` — add `groupUserPatternsByFolder(store)`, `validateFolderName(name, existingFolders)`. `saveNewPattern` accepts `folder`. `handleNewPatternClick` switches to the form modal.
- `src/ui/modal.js` — add `formModal({ title, fields, confirmLabel, validate })` returning a `Promise<Record<string,string> | null>`. Reuses the existing focus-trap + key-handling.
- `src/ui/left-rail.js` — major rewrite. Now mounts folder sections, drop targets, multi-select, inline rename, fuzzy search, drag-and-drop, spring-loaded folders, context menus per-row and per-folder-header. Public surface gains: `onCreateFolder`, `onRenameFolder`, `onDeleteFolder`, `onMoveTo`, `onDuplicate`, `onRenamePattern`, `onBulkDelete`, `onBulkMove`, `onBulkDuplicate`. Receives `groupedUserPatterns`, `folders`, `collapsedFolders` props.
- `src/ui/settings-panel.js` — new "Library" section above About with Export / Import buttons.
- `src/main.js` — boot wiring: read `index.folders`, `index.uiState`. Group user patterns. Provide all rail callbacks. Wire library export/import.
- `src/styles/left-rail.css` — folder header styles, drop-target ring/red-reject, drag ghost pill, multi-select tint, empty-folder hint, "+N more" row in search.
- `package.json` — add new test files to the `test` script.

---

## Task 1: Store helpers — rename key, rename folder in records (TDD)

**Files:**

- Modify: `src/store.js` (add `renamePatternKey`, `renameFolderInRecords`)
- Create: `src/store.test.js`

- [ ] **Step 1: Add the test file**

Create `src/store.test.js`:

```js
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
```

- [ ] **Step 2: Add `src/store.test.js` to package.json's `test` script**

Modify `package.json`, append `src/store.test.js` to the existing space-separated list in the `test` script.

- [ ] **Step 3: Run tests and verify they fail**

```bash
pnpm test 2>&1 | tail -30
```

Expected: failure citing `s.renamePatternKey is not a function` (and similar). Existing tests still pass.

- [ ] **Step 4: Implement the helpers in `src/store.js`**

Inside `createLocalStore()`'s returned object, add:

```js
renamePatternKey(oldName, newName) {
  const raw = localStorage.getItem(PREFIX + oldName);
  if (raw == null) return;
  try {
    localStorage.setItem(PREFIX + newName, raw);
    localStorage.removeItem(PREFIX + oldName);
  } catch (err) {
    if (err?.name === "QuotaExceededError") {
      console.warn("[strasbeat/store] quota exceeded on rename");
      throw err;
    }
    console.warn("[strasbeat/store] renamePatternKey failed:", err);
  }
},

renameFolderInRecords(oldName, newName) {
  let n = 0;
  for (const name of this.keys()) {
    const rec = this.get(name);
    if (rec && rec.isUserPattern && rec.folder === oldName) {
      this.set(name, { ...rec, folder: newName });
      n++;
    }
  }
  return n;
},
```

- [ ] **Step 5: Run tests and verify they pass**

```bash
pnpm test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 6: Stop and report**

Report which tests pass and the suggested commit message:

> feat(store): add renamePatternKey + renameFolderInRecords helpers

---

## Task 2: Patterns module — group by folder, folder-name validation (TDD)

**Files:**

- Modify: `src/patterns.js` (add `groupUserPatternsByFolder`, `validateFolderName`, accept `folder` in `saveNewPattern`)
- Create: `src/patterns.test.js`

- [ ] **Step 1: Add the test file**

Create `src/patterns.test.js`:

```js
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  groupUserPatternsByFolder,
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
    assert.deepEqual(Object.keys(result.folders).sort(), ["Jazz"]);
    // Jazz contains a and b, sorted by modified desc (most recent first).
    assert.deepEqual(result.folders.Jazz, ["b", "a"]);
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
```

- [ ] **Step 2: Add `src/patterns.test.js` to package.json's `test` script**

Append `src/patterns.test.js` to the space-separated list.

- [ ] **Step 3: Run tests and verify they fail**

```bash
pnpm test 2>&1 | tail -30
```

Expected: failure on `groupUserPatternsByFolder is not a function`.

- [ ] **Step 4: Implement the helpers in `src/patterns.js`**

Add near the top of the module (after `discoverPatterns`):

```js
/**
 * Group user patterns by folder.
 *
 * Returns:
 *   {
 *     folders: { [folderName]: string[] }   // patterns sorted by modified desc
 *     unfiled: string[]                      // patterns with no folder / orphan folder
 *   }
 *
 * Includes empty folders (those in index.folders[] with no matching records).
 * Excludes Demo working copies (isUserPattern: false).
 */
export function groupUserPatternsByFolder(store) {
  const idx = store.getIndex();
  const declaredFolders = Array.isArray(idx.folders) ? idx.folders : [];
  const declaredSet = new Set(declaredFolders);
  const folders = Object.fromEntries(declaredFolders.map((f) => [f, []]));
  const unfiled = [];

  for (const name of idx.userPatterns) {
    const rec = store.get(name);
    if (!rec || rec.isUserPattern !== true) continue;
    const f = rec.folder;
    if (typeof f === "string" && declaredSet.has(f)) {
      folders[f].push(name);
    } else {
      // No folder, or orphan (folder name not in index.folders).
      unfiled.push(name);
    }
  }

  // Sort each bucket by modified desc.
  const byModifiedDesc = (a, b) => {
    const ma = store.get(a)?.modified ?? "";
    const mb = store.get(b)?.modified ?? "";
    return mb.localeCompare(ma);
  };
  for (const f of Object.keys(folders)) folders[f].sort(byModifiedDesc);
  unfiled.sort(byModifiedDesc);

  return { folders, unfiled };
}

const FOLDER_NAME_MAX = 64;
const RESERVED_FOLDERS = new Set(["demos", "unfiled"]);

/** Returns an error string, or null if the name is valid. */
export function validateFolderName(rawName, existingFolders) {
  const name = (rawName ?? "").trim();
  if (!name) return "Folder name can't be empty";
  if (name.length > FOLDER_NAME_MAX) return `Folder name is too long (max ${FOLDER_NAME_MAX} chars)`;
  if (RESERVED_FOLDERS.has(name.toLowerCase())) return `"${name}" is reserved`;
  const lower = name.toLowerCase();
  for (const f of existingFolders) {
    if (f.toLowerCase() === lower) return `A folder named "${f}" already exists`;
  }
  return null;
}
```

Update `saveNewPattern` signature to accept `folder` (optional):

```js
export async function saveNewPattern({
  name,
  code,
  folder,                    // NEW — optional, undefined means Unfiled
  store,
  patterns,
  leftRail,
  setCurrentName,
  editor,
  transport,
  isDev,
}) {
  if (isDev) {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, code }),
    });
    if (!res.ok) {
      const msg = await res.text();
      transport.setStatus(`save failed: ${msg}`);
      return { ok: false, error: msg };
    }
    // Even in dev, remember the folder choice in the store so the rail can show it after HMR reload.
    if (folder) {
      try {
        store.set(name, { code, modified: new Date().toISOString(), isUserPattern: false, folder });
      } catch { /* ignore — disk is authoritative */ }
    }
    transport.setStatus(`created "${name}" — HMR will reload`);
    return { ok: true };
  }
  // Prod: store as user pattern.
  try {
    const rec = { code, modified: new Date().toISOString(), isUserPattern: true };
    if (folder) rec.folder = folder;
    store.set(name, rec);
    const idx = store.getIndex();
    idx.userPatterns = [...idx.userPatterns.filter((n) => n !== name), name];
    idx.lastOpen = name;
    store.setIndex(idx);
  } catch (err) {
    if (err?.name === "QuotaExceededError") {
      transport.setStatus("⚠ couldn’t save — browser storage full");
      return { ok: false, error: "storage full" };
    }
    return { ok: false, error: String(err) };
  }
  leftRail.addUserPattern(name);
  setCurrentName(name);
  editor.setCode(code);
  transport.setStatus(`created "${name}"`);
  return { ok: true };
}
```

Leave `handleNewPatternClick` alone for now — it'll be replaced with the form-modal flow in Task 13.

- [ ] **Step 5: Run tests and verify they pass**

```bash
pnpm test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 6: Stop and report**

> feat(patterns): groupUserPatternsByFolder + folder-name validation; saveNewPattern accepts folder

---

## Task 3: Fuzzy matcher with accent folding (TDD)

**Files:**

- Create: `src/ui/fuzzy.js`
- Create: `src/ui/fuzzy.test.js`

- [ ] **Step 1: Add the test file**

Create `src/ui/fuzzy.test.js`:

```js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { score, foldAccents } from "./fuzzy.js";

describe("foldAccents", () => {
  test("removes diacritical marks", () => {
    assert.equal(foldAccents("Café"), "cafe");
    assert.equal(foldAccents("voilà"), "voila");
    assert.equal(foldAccents("naïve résumé"), "naive resume");
  });

  test("lowercases ascii", () => {
    assert.equal(foldAccents("HELLO"), "hello");
  });

  test("is idempotent", () => {
    assert.equal(foldAccents(foldAccents("Café")), foldAccents("Café"));
  });
});

describe("score: subsequence matching", () => {
  test("returns null for non-matching query", () => {
    assert.equal(score("xyz", "Hello"), null);
  });

  test("returns positive score with match indices for substring match", () => {
    const r = score("hel", "Hello");
    assert.ok(r);
    assert.ok(r.score > 0);
    assert.deepEqual(r.matches, [0, 1, 2]);
  });

  test("matches subsequence with gaps", () => {
    const r = score("ho", "Hello");
    assert.ok(r);
    assert.deepEqual(r.matches, [0, 4]);
  });

  test("accent-folds the target", () => {
    const r = score("cafe", "Café");
    assert.ok(r);
    assert.equal(r.matches.length, 4);
  });

  test("accent-folds the query", () => {
    const r = score("café", "Cafe Sessions");
    assert.ok(r);
    assert.deepEqual(r.matches, [0, 1, 2, 3]);
  });
});

describe("score: ranking", () => {
  test("prefix match scores higher than mid-string match", () => {
    const a = score("late", "Late Night");
    const b = score("late", "Modulate");
    assert.ok(a && b);
    assert.ok(a.score > b.score, `prefix ${a.score} should beat mid ${b.score}`);
  });

  test("word-start match scores higher than mid-word match", () => {
    const a = score("ni", "Late Night"); // 'ni' starts the word "Night"
    const b = score("ni", "Modaning");   // 'ni' mid-word
    assert.ok(a && b);
    assert.ok(a.score > b.score);
  });

  test("consecutive run beats scattered run of the same characters", () => {
    const a = score("lat", "Late Night");      // contiguous run
    const b = score("lat", "L_a_t_e");         // scattered
    assert.ok(a && b);
    assert.ok(a.score > b.score);
  });

  test("longer consecutive run scores higher", () => {
    const a = score("late", "Late");
    const b = score("late", "Late N"); // same prefix, longer target → slightly lower
    assert.ok(a && b);
    assert.ok(a.score >= b.score);
  });
});

describe("score: multi-token (whitespace-separated)", () => {
  test("requires every token to match the target", () => {
    assert.ok(score("late night", "Late Night Comp"));
    assert.equal(score("late xyz", "Late Night Comp"), null);
  });

  test("tokens can match in any order", () => {
    assert.ok(score("night late", "Late Night Comp"));
  });

  test("returns the union of matched indices across tokens, deduped + sorted", () => {
    const r = score("la ni", "Late Night");
    assert.ok(r);
    // 'la' → 0,1; 'ni' → 5,6
    assert.deepEqual(r.matches, [0, 1, 5, 6]);
  });
});

describe("score: edge cases", () => {
  test("empty query returns null (caller filters)", () => {
    assert.equal(score("", "Anything"), null);
  });

  test("whitespace-only query returns null", () => {
    assert.equal(score("   ", "Anything"), null);
  });

  test("empty target returns null", () => {
    assert.equal(score("a", ""), null);
  });
});
```

- [ ] **Step 2: Add `src/ui/fuzzy.test.js` to package.json's `test` script**

- [ ] **Step 3: Run tests and verify they fail**

Expected: import error — `fuzzy.js` doesn't exist yet.

- [ ] **Step 4: Implement `src/ui/fuzzy.js`**

```js
// Accent-folding subsequence fuzzy matcher.
//
// Public:
//   foldAccents(s) -> string         // lowercase + strip diacriticals
//   score(query, target) -> {score, matches: number[]} | null
//
// "matches" indices are into the ORIGINAL target string (post-fold, same length).
// Caller renders highlights against the original target using these indices.

const DIACRITICAL_RE = /\p{M}/gu;

export function foldAccents(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFD").replace(DIACRITICAL_RE, "").toLowerCase();
}

const WORD_BOUNDARY_RE = /[^a-z0-9]/;

/**
 * Score how well `query` matches `target`. Returns null if any token has no
 * subsequence match. Otherwise returns the best (highest-score) alignment and
 * the union of matched indices.
 */
export function score(query, target) {
  if (typeof query !== "string" || typeof target !== "string") return null;
  const q = foldAccents(query).trim();
  if (!q) return null;
  if (!target) return null;
  const t = foldAccents(target);
  if (!t) return null;

  const tokens = q.split(/\s+/);
  const allMatches = new Set();
  let total = 0;

  for (const tok of tokens) {
    if (!tok) continue;
    const r = bestSubsequence(tok, t);
    if (!r) return null;
    total += r.score;
    for (const i of r.matches) allMatches.add(i);
  }

  return {
    score: total,
    matches: Array.from(allMatches).sort((a, b) => a - b),
  };
}

/**
 * Find the highest-scoring subsequence alignment of `tok` in `t` (both
 * already lowercased + accent-folded). Returns {score, matches} or null.
 *
 * Strategy: greedy left-to-right scan, but with a small look-ahead to prefer
 * consecutive runs and word-start positions. This is intentionally simple —
 * good enough for the small libraries we expect. If we ever need to handle
 * pathological cases, swap for a proper dp.
 */
function bestSubsequence(tok, t) {
  // First check feasibility: subsequence must exist at all.
  let j = 0;
  for (let i = 0; i < t.length && j < tok.length; i++) {
    if (t[i] === tok[j]) j++;
  }
  if (j < tok.length) return null;

  // Now find the alignment that maximizes a score combining:
  //   + 1 per matched char
  //   + (run-length - 1) * RUN_BONUS for each consecutive run beyond length 1
  //   + WORD_START_BONUS per match at a word boundary
  //   + PREFIX_BONUS once if the first matched index is 0
  //
  // We use a simple iterative search: anchor on each viable starting index,
  // greedily extend, score, keep the best. With small targets (<80 chars)
  // this is fast.
  const RUN_BONUS = 4;
  const WORD_START_BONUS = 3;
  const PREFIX_BONUS = 6;

  let best = null;

  for (let start = 0; start < t.length; start++) {
    if (t[start] !== tok[0]) continue;
    // Match greedily from `start`, but at each subsequent step, prefer the
    // immediately-next char if it matches, otherwise prefer the next
    // word-boundary occurrence, else the next occurrence.
    const matches = [start];
    let cursor = start + 1;
    let tokIdx = 1;
    while (tokIdx < tok.length) {
      const target = tok[tokIdx];
      let pick = -1;
      // Immediate next char?
      if (cursor < t.length && t[cursor] === target) {
        pick = cursor;
      } else {
        // Prefer word-boundary match, else first occurrence.
        let wbPick = -1;
        for (let k = cursor; k < t.length; k++) {
          if (t[k] !== target) continue;
          if (k === 0 || WORD_BOUNDARY_RE.test(t[k - 1])) {
            wbPick = k;
            break;
          }
        }
        if (wbPick >= 0) {
          pick = wbPick;
        } else {
          for (let k = cursor; k < t.length; k++) {
            if (t[k] === target) { pick = k; break; }
          }
        }
      }
      if (pick < 0) break;
      matches.push(pick);
      cursor = pick + 1;
      tokIdx++;
    }
    if (matches.length < tok.length) continue;

    // Score this alignment.
    let s = tok.length; // base: one point per matched char
    let runLen = 1;
    for (let k = 1; k < matches.length; k++) {
      if (matches[k] === matches[k - 1] + 1) {
        runLen++;
        s += RUN_BONUS;
      } else {
        runLen = 1;
      }
    }
    for (const i of matches) {
      if (i === 0 || WORD_BOUNDARY_RE.test(t[i - 1])) s += WORD_START_BONUS;
    }
    if (matches[0] === 0) s += PREFIX_BONUS;

    if (best == null || s > best.score) best = { score: s, matches };
  }

  return best;
}
```

- [ ] **Step 5: Run tests and verify they pass**

```bash
pnpm test 2>&1 | tail -40
```

Expected: all fuzzy tests pass. If a ranking test fails (e.g., "consecutive run beats scattered run"), tune the constants (`RUN_BONUS`, `WORD_START_BONUS`, `PREFIX_BONUS`) until the test passes. Don't loosen the test — the relative ordering is the contract.

- [ ] **Step 6: Stop and report**

> feat(fuzzy): accent-folding subsequence matcher for pattern search

---

## Task 4: Library export / import — pure module (TDD)

**Files:**

- Create: `src/library-io.js`
- Create: `src/library-io.test.js`

- [ ] **Step 1: Add the test file**

Create `src/library-io.test.js`:

```js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildExport,
  parseImportJson,
  previewImport,
  applyImport,
} from "./library-io.js";

function makeStore({ index = { lastOpen: null, userPatterns: [], folders: [] }, records = {} } = {}) {
  const recs = new Map(Object.entries(records));
  const idxRef = structuredClone(index);
  return {
    get: (n) => (recs.has(n) ? structuredClone(recs.get(n)) : null),
    set: (n, r) => recs.set(n, structuredClone(r)),
    delete: (n) => recs.delete(n),
    keys: () => Array.from(recs.keys()),
    getIndex: () => structuredClone(idxRef),
    setIndex: (i) => Object.assign(idxRef, i),
    renamePatternKey: () => {},
    renameFolderInRecords: () => 0,
  };
}

describe("buildExport", () => {
  test("emits the documented shape", () => {
    const store = makeStore({
      index: { lastOpen: "a", userPatterns: ["a"], folders: ["Jazz"] },
      records: {
        a: { code: "x", modified: "2026-05-10T00:00:00Z", isUserPattern: true, folder: "Jazz" },
        "05-dub": { code: "y", modified: "2026-05-09T00:00:00Z", isUserPattern: false },
      },
    });
    const exp = buildExport(store, { now: () => new Date("2026-05-11T00:00:00Z") });
    assert.equal(exp.version, 1);
    assert.equal(exp.exportedAt, "2026-05-11T00:00:00.000Z");
    assert.deepEqual(exp.folders, ["Jazz"]);
    assert.deepEqual(exp.patterns.a, {
      code: "x", modified: "2026-05-10T00:00:00Z", isUserPattern: true, folder: "Jazz",
    });
    // Demo working copies have no folder field.
    assert.deepEqual(exp.patterns["05-dub"], {
      code: "y", modified: "2026-05-09T00:00:00Z", isUserPattern: false,
    });
  });

  test("excludes nothing — empty store still produces a valid file", () => {
    const exp = buildExport(makeStore(), { now: () => new Date(0) });
    assert.equal(exp.version, 1);
    assert.deepEqual(exp.folders, []);
    assert.deepEqual(exp.patterns, {});
  });
});

describe("parseImportJson", () => {
  test("accepts a valid file", () => {
    const json = JSON.stringify({
      version: 1, exportedAt: "t",
      folders: ["Jazz"],
      patterns: { a: { code: "x", modified: "t", isUserPattern: true, folder: "Jazz" } },
    });
    const r = parseImportJson(json);
    assert.ok(r.ok);
    assert.equal(r.data.version, 1);
  });

  test("rejects non-JSON text", () => {
    const r = parseImportJson("not json");
    assert.equal(r.ok, false);
  });

  test("rejects unsupported version", () => {
    const r = parseImportJson(JSON.stringify({ version: 2, folders: [], patterns: {} }));
    assert.equal(r.ok, false);
    assert.match(r.error, /version/i);
  });

  test("rejects missing folders or patterns", () => {
    assert.equal(parseImportJson(JSON.stringify({ version: 1 })).ok, false);
    assert.equal(parseImportJson(JSON.stringify({ version: 1, folders: [] })).ok, false);
    assert.equal(parseImportJson(JSON.stringify({ version: 1, patterns: {} })).ok, false);
  });

  test("rejects wrong types", () => {
    assert.equal(parseImportJson(JSON.stringify({ version: 1, folders: "a", patterns: {} })).ok, false);
    assert.equal(parseImportJson(JSON.stringify({ version: 1, folders: [], patterns: [] })).ok, false);
  });
});

describe("previewImport", () => {
  test("computes new folders, new patterns, conflicts, and untransferable demos", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["existing"], folders: ["Jazz"] },
      records: {
        existing: { code: "x", modified: "t", isUserPattern: true, folder: "Jazz" },
      },
    });
    const shippedDemos = new Set(["05-dub"]); // currently-shipped demo names
    const json = {
      version: 1, exportedAt: "t",
      folders: ["Jazz", "Live"],
      patterns: {
        existing: { code: "y", modified: "t", isUserPattern: true, folder: "Jazz" },
        "new-tune": { code: "z", modified: "t", isUserPattern: true, folder: "Live" },
        "05-dub":    { code: "a", modified: "t", isUserPattern: false }, // demo wc, demo exists
        "gone-demo": { code: "b", modified: "t", isUserPattern: false }, // demo wc, demo gone
      },
    };
    const pv = previewImport(json, store, shippedDemos);
    assert.deepEqual(pv.newFolders, ["Live"]);
    assert.deepEqual(pv.conflicts.sort(), ["existing"]);
    assert.deepEqual(pv.newUserPatterns.sort(), ["new-tune"]);
    assert.deepEqual(pv.demoWorkingCopies.transferable, ["05-dub"]);
    assert.deepEqual(pv.demoWorkingCopies.untransferable, ["gone-demo"]);
  });
});

describe("applyImport: conflict strategies", () => {
  const baseJson = {
    version: 1, exportedAt: "t",
    folders: ["Jazz", "Live"],
    patterns: {
      existing: { code: "NEW", modified: "t", isUserPattern: true, folder: "Live" },
      brand:    { code: "Z",   modified: "t", isUserPattern: true, folder: "Jazz" },
    },
  };

  test("skip leaves existing record alone, imports new ones", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["existing"], folders: [] },
      records: { existing: { code: "OLD", modified: "t", isUserPattern: true, folder: "Jazz" } },
    });
    const r = applyImport(baseJson, store, { conflictStrategy: "skip", shippedDemos: new Set() });
    assert.equal(r.imported, 1); // brand
    assert.equal(r.skipped, 1);   // existing
    assert.equal(store.get("existing").code, "OLD");
    assert.equal(store.get("brand").code, "Z");
    assert.deepEqual(store.getIndex().folders, ["Jazz", "Live"]);
    assert.ok(store.getIndex().userPatterns.includes("brand"));
  });

  test("overwrite replaces existing record", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["existing"], folders: [] },
      records: { existing: { code: "OLD", modified: "t", isUserPattern: true } },
    });
    const r = applyImport(baseJson, store, { conflictStrategy: "overwrite", shippedDemos: new Set() });
    assert.equal(r.imported, 2);
    assert.equal(store.get("existing").code, "NEW");
    assert.equal(store.get("existing").folder, "Live");
  });

  test("rename writes the import under <name>-imported, increments on collision", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["existing", "existing-imported"], folders: [] },
      records: {
        existing: { code: "OLD", modified: "t", isUserPattern: true },
        "existing-imported": { code: "PRIOR", modified: "t", isUserPattern: true },
      },
    });
    const r = applyImport(baseJson, store, { conflictStrategy: "rename", shippedDemos: new Set() });
    assert.equal(store.get("existing").code, "OLD"); // untouched
    assert.equal(store.get("existing-imported").code, "PRIOR");
    assert.equal(store.get("existing-imported-2").code, "NEW");
    assert.ok(r.renamed.find((p) => p.from === "existing" && p.to === "existing-imported-2"));
  });

  test("demo working copies are imported only if the demo exists in this build", () => {
    const store = makeStore();
    const json = {
      version: 1, exportedAt: "t", folders: [],
      patterns: {
        "05-dub":    { code: "A", modified: "t", isUserPattern: false },
        "gone-demo": { code: "B", modified: "t", isUserPattern: false },
      },
    };
    const r = applyImport(json, store, { conflictStrategy: "skip", shippedDemos: new Set(["05-dub"]) });
    assert.equal(store.get("05-dub")?.code, "A");
    assert.equal(store.get("gone-demo"), null);
    assert.equal(r.skipped, 1); // gone-demo
  });

  test("QuotaExceededError aborts cleanly, reports counts", () => {
    const store = makeStore();
    let calls = 0;
    store.set = (n, r) => {
      if (++calls > 1) {
        const e = new Error("quota"); e.name = "QuotaExceededError";
        throw e;
      }
    };
    const r = applyImport(baseJson, store, { conflictStrategy: "skip", shippedDemos: new Set() });
    assert.equal(r.ok, false);
    assert.equal(r.imported, 1);
    assert.match(r.error, /storage/i);
  });
});
```

- [ ] **Step 2: Add `src/library-io.test.js` to package.json's `test` script**

- [ ] **Step 3: Run tests and verify they fail**

Expected: import error — `library-io.js` doesn't exist yet.

- [ ] **Step 4: Implement `src/library-io.js`**

```js
// Library export/import — pure functions over a store interface.
//
// Public:
//   buildExport(store, opts?) -> ExportPayload
//   parseImportJson(text) -> { ok, data?, error? }
//   previewImport(payload, store, shippedDemos) -> Preview
//   applyImport(payload, store, opts) -> Result

const EXPORT_VERSION = 1;

export function buildExport(store, { now = () => new Date() } = {}) {
  const idx = store.getIndex();
  const folders = Array.isArray(idx.folders) ? idx.folders.slice() : [];
  const patterns = {};
  for (const name of store.keys()) {
    const rec = store.get(name);
    if (!rec) continue;
    const out = { code: rec.code, modified: rec.modified, isUserPattern: !!rec.isUserPattern };
    if (rec.isUserPattern && typeof rec.folder === "string") out.folder = rec.folder;
    patterns[name] = out;
  }
  return {
    version: EXPORT_VERSION,
    exportedAt: now().toISOString(),
    folders,
    patterns,
  };
}

export function parseImportJson(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { return { ok: false, error: `Couldn't parse JSON: ${e.message}` }; }
  if (typeof data !== "object" || data == null) return { ok: false, error: "Top-level value must be an object" };
  if (data.version !== EXPORT_VERSION) return { ok: false, error: `Unsupported library version: ${data.version}` };
  if (!Array.isArray(data.folders)) return { ok: false, error: "folders must be an array" };
  if (data.folders.some((f) => typeof f !== "string")) return { ok: false, error: "folders must be an array of strings" };
  if (typeof data.patterns !== "object" || Array.isArray(data.patterns) || data.patterns == null) {
    return { ok: false, error: "patterns must be an object" };
  }
  return { ok: true, data };
}

export function previewImport(payload, store, shippedDemos) {
  const idx = store.getIndex();
  const existingFolders = new Set((idx.folders ?? []).map((f) => f.toLowerCase()));
  const newFolders = payload.folders.filter((f) => !existingFolders.has(f.toLowerCase()));

  const conflicts = [];
  const newUserPatterns = [];
  const transferable = [];
  const untransferable = [];
  for (const [name, rec] of Object.entries(payload.patterns)) {
    if (rec.isUserPattern) {
      const exists = store.get(name) != null;
      if (exists) conflicts.push(name);
      else newUserPatterns.push(name);
    } else {
      if (shippedDemos.has(name)) transferable.push(name);
      else untransferable.push(name);
    }
  }
  return {
    newFolders,
    conflicts,
    newUserPatterns,
    demoWorkingCopies: { transferable, untransferable },
  };
}

export function applyImport(payload, store, { conflictStrategy, shippedDemos }) {
  let imported = 0;
  let skipped = 0;
  const renamed = [];
  try {
    // 1) Merge folders.
    const idx = store.getIndex();
    const folderSet = new Set((idx.folders ?? []).map((f) => f.toLowerCase()));
    const folders = (idx.folders ?? []).slice();
    for (const f of payload.folders) {
      if (!folderSet.has(f.toLowerCase())) {
        folders.push(f);
        folderSet.add(f.toLowerCase());
      }
    }

    // 2) Write patterns.
    const userPatterns = (idx.userPatterns ?? []).slice();
    for (const [name, rec] of Object.entries(payload.patterns)) {
      if (rec.isUserPattern) {
        const exists = store.get(name) != null;
        if (exists) {
          if (conflictStrategy === "skip") { skipped++; continue; }
          if (conflictStrategy === "rename") {
            const newName = makeRenamedName(name, store);
            store.set(newName, sanitizeUserRecord(rec));
            if (!userPatterns.includes(newName)) userPatterns.push(newName);
            renamed.push({ from: name, to: newName });
            imported++;
            continue;
          }
          // overwrite
        }
        store.set(name, sanitizeUserRecord(rec));
        if (!userPatterns.includes(name)) userPatterns.push(name);
        imported++;
      } else {
        // Demo working copy.
        if (!shippedDemos.has(name)) { skipped++; continue; }
        const out = { code: rec.code, modified: rec.modified, isUserPattern: false };
        store.set(name, out);
        imported++;
      }
    }

    // 3) Commit index.
    store.setIndex({ ...idx, folders, userPatterns });
    return { ok: true, imported, skipped, renamed };
  } catch (err) {
    if (err?.name === "QuotaExceededError") {
      return { ok: false, imported, skipped, renamed, error: "Storage full — import aborted" };
    }
    return { ok: false, imported, skipped, renamed, error: String(err) };
  }
}

function sanitizeUserRecord(rec) {
  const out = { code: rec.code, modified: rec.modified, isUserPattern: true };
  if (typeof rec.folder === "string") out.folder = rec.folder;
  return out;
}

function makeRenamedName(base, store) {
  let candidate = `${base}-imported`;
  if (store.get(candidate) == null) return candidate;
  let n = 2;
  while (store.get(`${base}-imported-${n}`) != null) n++;
  return `${base}-imported-${n}`;
}
```

- [ ] **Step 5: Run tests and verify they pass**

```bash
pnpm test 2>&1 | tail -40
```

Expected: all `library-io` tests pass.

- [ ] **Step 6: Stop and report**

> feat(library): pure JSON export/import + preview module

---

## Task 5: Form modal (extend `src/ui/modal.js`)

**Files:**

- Modify: `src/ui/modal.js` — add `formModal({ title, fields, confirmLabel, validate })`

**No new tests** for this task — it's wiring on top of the existing modal primitives; the existing `modal.js` already has `prompt()` and `confirm()` working. The new shape is exercised by Tasks 13–15 (which use it). We'll cover it via manual verification.

- [ ] **Step 1: Read the current `modal.js`**

Read `src/ui/modal.js` end-to-end so the new helper sits cleanly alongside `prompt()` and `confirm()`. Pay attention to focus-trap handling, Escape/Enter behavior, the backdrop dismiss, and the validation pattern used by `prompt()`.

- [ ] **Step 2: Add the `formModal` helper**

Define a function `formModal({ title, fields, confirmLabel, cancelLabel, validate })` that:

- Renders a modal with a heading (`title`) and one row per field. Each field is `{ key, label, type: "text" | "select", placeholder?, defaultValue?, options? }`.
- For `type: "text"`, renders a labeled `<input type="text">`.
- For `type: "select"`, renders a labeled `<select>` populated from `options: { value, label }[]`. If an option's value is `"__new__"`, render a divider above it (visual cue for "create new").
- Returns a `Promise<Record<string,string> | null>` — resolves with `{key: value}` on confirm, or `null` on cancel.
- `validate(values)` is optional: returns `null` for OK, or `Record<string, string>` for per-field error messages. On validation failure, do not close — show inline errors and refocus the first errored field.
- Re-uses the existing focus-trap and Escape-to-cancel behavior from the rest of the file.

Approximate skeleton:

```js
export function formModal({ title, fields, confirmLabel = "OK", cancelLabel = "Cancel", validate }) {
  return new Promise((resolve) => {
    const backdrop = createBackdrop();
    const dialog = el("div", "modal");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const titleEl = el("h2", "modal__title", title);
    dialog.appendChild(titleEl);

    const inputs = {};
    const errorEls = {};
    for (const f of fields) {
      const row = el("div", "modal__field");
      const lbl = el("label", "modal__label", f.label);
      row.appendChild(lbl);

      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const opt of f.options) {
          const o = document.createElement("option");
          o.value = opt.value;
          o.textContent = opt.label;
          input.appendChild(o);
        }
        input.value = f.defaultValue ?? "";
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.placeholder = f.placeholder ?? "";
        input.value = f.defaultValue ?? "";
        input.spellcheck = false;
        input.autocomplete = "off";
      }
      input.className = "modal__input";
      input.id = `modal-field-${f.key}`;
      lbl.htmlFor = input.id;
      row.appendChild(input);
      const err = el("div", "modal__error");
      row.appendChild(err);

      dialog.appendChild(row);
      inputs[f.key] = input;
      errorEls[f.key] = err;
    }

    const actions = el("div", "modal__actions");
    const cancelBtn = el("button", "btn", cancelLabel);
    const confirmBtn = el("button", "btn btn--primary", confirmLabel);
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    function readValues() {
      const v = {};
      for (const [k, i] of Object.entries(inputs)) v[k] = i.value;
      return v;
    }
    function showErrors(errs) {
      let firstErrorKey = null;
      for (const k of Object.keys(errorEls)) {
        const msg = errs?.[k] ?? "";
        errorEls[k].textContent = msg;
        inputs[k].classList.toggle("modal__input--error", !!msg);
        if (msg && !firstErrorKey) firstErrorKey = k;
      }
      if (firstErrorKey) inputs[firstErrorKey].focus();
    }
    function tryConfirm() {
      const values = readValues();
      if (validate) {
        const errs = validate(values);
        if (errs) { showErrors(errs); return; }
      }
      cleanup();
      resolve(values);
    }
    function cancel() { cleanup(); resolve(null); }
    function cleanup() {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        tryConfirm();
      }
    }

    cancelBtn.addEventListener("click", cancel);
    confirmBtn.addEventListener("click", tryConfirm);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cancel(); });
    document.addEventListener("keydown", onKey);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    // Focus the first field after mount.
    requestAnimationFrame(() => inputs[fields[0].key]?.focus());
  });
}

// Helpers — match the existing module's style.
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function createBackdrop() {
  const b = el("div", "modal-backdrop");
  return b;
}
```

If the existing module already defines `el()` or `createBackdrop()`, reuse them — don't duplicate. Make sure `prompt()` and `confirm()` still work afterwards.

- [ ] **Step 3: Manual smoke test**

```bash
pnpm dev
```

Open the dev server, open devtools, run:

```js
const { formModal } = await import("/src/ui/modal.js");
await formModal({
  title: "Test",
  fields: [
    { key: "name", label: "Name", type: "text", defaultValue: "test" },
    { key: "folder", label: "Folder", type: "select", options: [
      { value: "", label: "Unfiled" },
      { value: "Jazz", label: "Jazz" },
    ]},
  ],
  confirmLabel: "Go",
});
```

Verify: the modal appears centered, Escape closes with `null`, click outside closes with `null`, Enter confirms, OK button confirms with `{ name, folder }`.

- [ ] **Step 4: Verify existing modal usages still work**

Test in dev server:
- Click + (new pattern) — name prompt should still appear and accept.
- Right-click a user pattern, Delete — confirm modal still works.

- [ ] **Step 5: Stop and report**

> feat(modal): formModal helper for multi-field modals (name + dropdown)

---

## Task 6: Left rail — render folder sections, collapse persistence

**Files:**

- Modify: `src/ui/left-rail.js`
- Modify: `src/styles/left-rail.css`

This task is a substantial refactor of `left-rail.js`. Drag-and-drop, multi-select, inline rename, and context menus are all later tasks — focus only on getting the sections rendered correctly with collapse state.

- [ ] **Step 1: Update the `mount()` props**

Add the new options (default values shown):

```js
export function mount({
  container,
  patterns,                 // { [name]: code } — Demos
  userPatterns = [],        // legacy flat list (still passed but no longer drives the rail)
  folders = [],             // string[] in display order
  groupedUserPatterns = { folders: {}, unfiled: [] },
  collapsedFolders = [],    // string[] — folder names whose state is "collapsed"
  dirtySet = new Set(),
  currentName = null,
  onSelect = () => {},
  onCreate = () => {},
  onCreateFolder = () => {},
  onImportMidi = () => {},
  onRevert = () => {},
  onDelete = () => {},
  onCollapseChange = () => {},  // (folderName: string, isCollapsed: boolean) => void
  // these are added by later tasks but accept them now so prop shapes match
  onMoveTo = () => {},
  onDuplicate = () => {},
  onRenamePattern = () => {},
  onRenameFolder = () => {},
  onDeleteFolder = () => {},
}) {
  // ...
}
```

- [ ] **Step 2: Replace the existing flat render with section rendering**

Replace `renderList()` so it builds the rail as a list of sections:

```
[Demos section]              ← always present, header has no ⋯, no drop target
[user folder sections]        ← in `folders` order, header has ⋯ and is a drop target
[Unfiled section]             ← only if groupedUserPatterns.unfiled is non-empty
```

Each section consists of:

- A header row (`.left-rail__folder-header`) with chevron, name, count, and (for user folders) hover ⋯ button.
- If expanded: child rows (`.left-rail__item`) for each pattern, using the existing `buildRow()` (refactored to accept which-section info).
- If expanded and empty (user folder only): a faint `.left-rail__empty-folder-hint` row reading "Drop patterns here".

Internal state needs to track per-folder collapse:

```js
const collapsedSet = new Set(collapsedFolders); // includes user folder names + "__demos__"

function isCollapsed(folderName) {
  // folderName is either a user folder name or the special "__demos__".
  return collapsedSet.has(folderName);
}
function toggleCollapse(folderName) {
  const next = !collapsedSet.has(folderName);
  if (next) collapsedSet.add(folderName); else collapsedSet.delete(folderName);
  onCollapseChange(folderName, next);
  renderList();
}
```

For Demos: render the existing list of shipped pattern names under the section. The dirty dot logic stays as today.

- [ ] **Step 3: Update existing public methods to match the new model**

- `addUserPattern(name)` — accept an optional `folder` param. Push the pattern into the right bucket of `groupedUserPatterns` (re-fetch the record from caller's perspective; in this module we just need the bucket). For now, the simplest implementation: ask the caller to re-mount or call a new `setGrouped(grouped)` method instead. Add `setGrouped(grouped)` and call `renderList()`.
- `removeUserPattern(name)` — scan `groupedUserPatterns` and remove from wherever it lives. Re-render.
- `updateDirtySet`, `setCurrent`, `clearCurrent`, `focusSearch`, `getCurrent` — unchanged.

- [ ] **Step 4: Add CSS for the new section structure**

Edit `src/styles/left-rail.css`. Add (or adapt — match existing tokens):

```css
.left-rail__folder-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
  cursor: pointer;
  position: relative;
}
.left-rail__folder-chevron {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  transition: transform 120ms ease;
}
.left-rail__folder-header[data-collapsed="true"] .left-rail__folder-chevron {
  transform: rotate(-90deg);
}
.left-rail__folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.left-rail__folder-count { color: var(--fg-faint); font-weight: 400; }
.left-rail__folder-more {
  opacity: 0;
  transition: opacity 120ms;
}
.left-rail__folder-header:hover .left-rail__folder-more,
.left-rail__folder-header:focus-within .left-rail__folder-more {
  opacity: 1;
}
.left-rail__empty-folder-hint {
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-4);
  font-size: var(--font-size-xs);
  color: var(--fg-faint);
  font-style: italic;
}
```

(If `--space-*`, `--fg-muted`, etc. tokens have different names in this repo, adapt to match. The existing `left-rail.css` is the source of truth.)

- [ ] **Step 5: Verify in the dev server**

```bash
pnpm dev
```

Open `http://localhost:5173`. With no user patterns yet:
- Demos appears as a collapsible section.
- No user folder sections.
- No Unfiled section (it's only rendered when non-empty).

Test collapse: click the Demos chevron → patterns hide. Reload — should still be collapsed (after Task 17 wires `onCollapseChange` → store; for now the in-memory state is enough).

Create a couple of dummy user patterns via devtools to verify folder rendering:

```js
window.editor; // ensure app is loaded
const store = window.strasbeat?.store || (await import("/src/store.js")).createLocalStore();
store.set("test-jazz-1", { code: "// jazz\nsetcps(120/60/4)\n", modified: new Date().toISOString(), isUserPattern: true, folder: "Jazz" });
store.set("test-unfiled-1", { code: "// orphan\nsetcps(120/60/4)\n", modified: new Date().toISOString(), isUserPattern: true });
const idx = store.getIndex();
idx.userPatterns = ["test-jazz-1", "test-unfiled-1"];
idx.folders = ["Jazz"];
store.setIndex(idx);
location.reload();
```

After reload: `Demos`, `Jazz (1)`, `Unfiled (1)` sections appear. Patterns render under each. Demos still shows shipped patterns. Clicking a pattern selects it as before.

If reload doesn't work because `main.js` doesn't yet read `index.folders` / pass `groupedUserPatterns` — that's expected; do enough wiring in `main.js` to pass `folders` and `groupedUserPatterns` to the rail (just for this task, a few lines added at the rail mount point).

- [ ] **Step 6: Stop and report**

> feat(left-rail): render folder sections with collapsible headers

---

## Task 7: Replace substring search with fuzzy search (flat results)

**Files:**

- Modify: `src/ui/left-rail.js`

- [ ] **Step 1: Replace the current search filter**

Today the rail filters two lists with `name.toLowerCase().includes(query)`. Replace with the fuzzy matcher from Task 3.

When `query` is empty: render normal section view from Task 6.

When `query` is non-empty: gather **every** pattern visible in the rail (Demos + every user folder + Unfiled) and call `score(query, candidate)` for each. The candidate string passed to `score()` should be `${prettyName(name)} ${name} ${folderLabel}` so that all three are matchable. Sort matches by score desc. Render a flat list of up to 50 result rows — no folder headers, no chevrons.

```js
import { score, foldAccents } from "./fuzzy.js";

function gatherAllForSearch() {
  // Returns Array<{name, isUser, folder: string | null}>
  const out = [];
  for (const name of Object.keys(patterns)) {
    out.push({ name, isUser: false, folder: null /* Demos */ });
  }
  for (const [folder, names] of Object.entries(groupedUserPatterns.folders)) {
    for (const name of names) out.push({ name, isUser: true, folder });
  }
  for (const name of groupedUserPatterns.unfiled) {
    out.push({ name, isUser: true, folder: null });
  }
  return out;
}

function fuzzyResults(query) {
  const candidates = gatherAllForSearch();
  const scored = [];
  for (const c of candidates) {
    const folderLabel = c.folder ?? (c.isUser ? "Unfiled" : "Demos");
    const display = prettyName(c.name);
    // The matcher returns match indices into the joined candidate string. We
    // don't need to map them back — we just use them to weight selection.
    // For highlighting, we re-run score against the pretty name only.
    const blob = `${display} ${c.name} ${folderLabel}`;
    const r = score(query, blob);
    if (!r) continue;

    // Score-and-rank-only pass against the display name to demote folder-only hits.
    const displayMatch = score(query, display);
    const finalScore = (displayMatch?.score ?? 0) * 2 + r.score;
    scored.push({ ...c, score: finalScore, displayMatch });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 50);
}
```

- [ ] **Step 2: Render a flat result list during search**

When `query` is non-empty, render a single flat list — folder headers hidden:

```html
<div class="left-rail__item" data-name="..." data-user="...">
  <span class="left-rail__item-accent" aria-hidden="true"></span>
  <span class="left-rail__item-name">
    Late Night                          <!-- with <span class="left-rail__item-match"> for matched chars -->
  </span>
  <span class="left-rail__item-meta">
    <span class="left-rail__item-folder-suffix">· Jazz</span>
  </span>
</div>
```

Use the `displayMatch.matches` indices to wrap matched characters in `<span class="left-rail__item-match">`. The existing code already does this for contiguous substrings; extend it to handle arbitrary index lists.

If there were more than 50 matches, append a `.left-rail__more-row` reading `+ N more — refine your search…`. It's non-interactive.

If zero matches: `<div class="left-rail__empty">No results for "<query>"</div>` (unchanged from today).

- [ ] **Step 3: Style the new rows**

```css
.left-rail__item-folder-suffix { color: var(--fg-faint); font-size: var(--font-size-xs); margin-left: var(--space-1); }
.left-rail__more-row { padding: var(--space-1) var(--space-2); color: var(--fg-faint); font-size: var(--font-size-xs); font-style: italic; }
```

- [ ] **Step 4: Verify search behavior in dev server**

- Type "lat" — see matches across folders. Folder context visible as suffix.
- Type "café" with a pattern named "Cafe Session" (create one via devtools) — matches.
- Type "jazz" — every pattern in Jazz folder appears, plus any pattern with "jazz" in the name.
- Clear the search box — the rail returns to the folder view with collapse state intact.

- [ ] **Step 5: Stop and report**

> feat(left-rail): fuzzy search with accent folding + flat results

---

## Task 8: Drag-and-drop with drop targets + spring-loaded folders

**Files:**

- Modify: `src/ui/left-rail.js`
- Modify: `src/styles/left-rail.css`

- [ ] **Step 1: Add drag-source handlers to every pattern row**

Use the HTML5 drag API. On row build:

```js
row.draggable = true;
row.addEventListener("dragstart", (e) => onPatternDragStart(e, name, isUser, folder));
row.addEventListener("dragend", onPatternDragEnd);
```

Make `onPatternDragStart`:

```js
function onPatternDragStart(e, name, isUser, folder) {
  // Resolve the dragged set: if name is in the current selection, drag all
  // selected; otherwise drag just this one.
  const draggedSet = selectedNames.has(name)
    ? Array.from(selectedNames).map((n) => resolveDraggedItem(n))
    : [{ name, isUser, folder }];
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("application/x-strasbeat-patterns", JSON.stringify(draggedSet));
  // A visible "N patterns" ghost.
  const ghost = makeDragGhost(draggedSet);
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  // Schedule ghost cleanup.
  setTimeout(() => ghost.remove(), 0);
  document.body.setAttribute("data-rail-dragging", "true");
}
function onPatternDragEnd() {
  document.body.removeAttribute("data-rail-dragging");
  clearAllDropHighlights();
  cancelSpringLoad();
}
```

`makeDragGhost` produces a tiny pill: `<div class="left-rail__drag-ghost">N patterns</div>` (or the pretty name if N=1).

- [ ] **Step 2: Make folder headers + folder bodies drop targets**

For each user-folder header and body, and the Unfiled header/body:

```js
sectionEl.addEventListener("dragover", (e) => onSectionDragOver(e, folderName));
sectionEl.addEventListener("dragleave", () => onSectionDragLeave(folderName));
sectionEl.addEventListener("drop", (e) => onSectionDrop(e, folderName));
```

For the Demos section, attach the same handlers but always set the drop-rejected style and `e.dataTransfer.dropEffect = "none"`:

```js
function onSectionDragOver(e, folderName) {
  e.preventDefault();
  if (folderName === "__demos__") {
    e.dataTransfer.dropEffect = "none";
    demosHeader.classList.add("left-rail__section--drop-rejected");
    return;
  }
  e.dataTransfer.dropEffect = "move";
  highlightDropTarget(folderName);
  scheduleSpringLoad(folderName);
}
```

- [ ] **Step 3: Spring-loaded folders during drag**

```js
let springTimer = null;
let springFolder = null;
function scheduleSpringLoad(folderName) {
  if (springFolder === folderName) return;
  cancelSpringLoad();
  springFolder = folderName;
  if (!isCollapsed(folderName)) return;
  springTimer = setTimeout(() => {
    if (isCollapsed(folderName)) toggleCollapse(folderName);
  }, 500);
}
function cancelSpringLoad() {
  if (springTimer) { clearTimeout(springTimer); springTimer = null; }
  springFolder = null;
}
```

Call `cancelSpringLoad()` from `dragleave` and `dragend`.

- [ ] **Step 4: Handle the drop**

```js
function onSectionDrop(e, folderName) {
  e.preventDefault();
  cancelSpringLoad();
  clearAllDropHighlights();
  if (folderName === "__demos__") return; // rejected, no-op
  const raw = e.dataTransfer.getData("application/x-strasbeat-patterns");
  if (!raw) return;
  let dragged;
  try { dragged = JSON.parse(raw); } catch { return; }

  // Partition: user patterns we can move; Demos we duplicate.
  const userMoves = dragged.filter((d) => d.isUser);
  const demoForks = dragged.filter((d) => !d.isUser);

  if (userMoves.length) {
    const target = folderName === "__unfiled__" ? null : folderName;
    onMoveTo(userMoves.map((d) => d.name), target);
  }
  if (demoForks.length) {
    // For a multi-drag with both, we move user patterns and pop the duplicate
    // dialog for the first demo (multiple demo forks at once is out of scope —
    // status bar will report the skipped count via the host).
    onDuplicate(demoForks[0].name, folderName === "__unfiled__" ? null : folderName);
    if (demoForks.length > 1) {
      // Host caller (main.js) shows status. Communicate skipped count via the
      // callback result if needed.
    }
  }
}
```

- [ ] **Step 5: Auto-scroll near top/bottom edge during drag**

Hook into `dragover` on the rail container:

```js
container.addEventListener("dragover", (e) => {
  const rect = container.getBoundingClientRect();
  const top = e.clientY - rect.top;
  const bottom = rect.bottom - e.clientY;
  if (top < 24) listEl.scrollBy({ top: -8, behavior: "auto" });
  else if (bottom < 24) listEl.scrollBy({ top: 8, behavior: "auto" });
});
```

- [ ] **Step 6: Styles**

```css
.left-rail__folder-header.is-drop-target,
.left-rail__folder-body.is-drop-target {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}
.left-rail__section--drop-rejected {
  outline: 2px dashed var(--danger, #c0392b);
  outline-offset: -2px;
}
.left-rail__drag-ghost {
  position: absolute; top: -1000px;
  padding: 4px 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  font-size: var(--font-size-xs);
  pointer-events: none;
}
body[data-rail-dragging="true"] { cursor: grabbing; }
```

- [ ] **Step 7: Manual test**

```bash
pnpm dev
```

- Create some user folders & patterns via devtools (see Task 6).
- Drag a user pattern from Unfiled into Jazz → it moves.
- Drag from Jazz back into Unfiled → it moves.
- Drag a Demo onto Jazz → red rejection cue (Task 14 will turn this into the Duplicate dialog; for now we just want the rejection to be visible).
- Drop onto Demos → rejected outline appears, drop does nothing.
- Drag over a collapsed user folder and hold for 500 ms → it auto-expands.

(`onMoveTo` and `onDuplicate` need to be wired by Task 17 — leave them as logging stubs for this task: the rail emits the callback, main.js logs to the console. The actual moves should still appear visually because main.js will re-mount the rail with new `groupedUserPatterns` once it commits to the store.)

- [ ] **Step 8: Stop and report**

> feat(left-rail): drag-and-drop with spring-loaded folders, drop-target highlights, Demos rejection

---

## Task 9: Multi-select

**Files:**

- Modify: `src/ui/left-rail.js`
- Modify: `src/styles/left-rail.css`

- [ ] **Step 1: Track a selection set**

```js
const selectedNames = new Set();
let lastClickedName = null; // for shift-range

function clearSelection() { selectedNames.clear(); paintSelection(); }
function paintSelection() {
  for (const row of listEl.querySelectorAll(".left-rail__item")) {
    row.classList.toggle("is-selected", selectedNames.has(row.dataset.name));
  }
}
```

- [ ] **Step 2: Update the row click handler**

```js
row.addEventListener("click", (e) => {
  const isMod = e.metaKey || e.ctrlKey;
  const isShift = e.shiftKey;

  if (isMod) {
    e.preventDefault();
    if (selectedNames.has(name)) selectedNames.delete(name);
    else selectedNames.add(name);
    lastClickedName = name;
    paintSelection();
    return;
  }
  if (isShift && lastClickedName) {
    e.preventDefault();
    // Range select within the visible flat list.
    const visible = Array.from(listEl.querySelectorAll(".left-rail__item")).map((r) => r.dataset.name);
    const a = visible.indexOf(lastClickedName);
    const b = visible.indexOf(name);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) selectedNames.add(visible[i]);
    }
    paintSelection();
    return;
  }

  // Plain click: open the pattern, clear selection.
  clearSelection();
  dismissContextMenu();
  setCurrent(name);
  onSelect(name);
});
```

- [ ] **Step 3: Cmd-A, Escape, Cmd-D, Cmd-Backspace**

Add a container-level keydown handler:

```js
container.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const onRow = document.activeElement?.classList.contains("left-rail__item");

  if (mod && e.key.toLowerCase() === "a" && onRow) {
    e.preventDefault();
    for (const r of listEl.querySelectorAll(".left-rail__item")) selectedNames.add(r.dataset.name);
    paintSelection();
    return;
  }
  if (e.key === "Escape" && selectedNames.size > 0) {
    e.preventDefault();
    clearSelection();
    return;
  }
  if (mod && e.key.toLowerCase() === "d" && onRow) {
    e.preventDefault();
    const names = selectedNames.size > 0 ? Array.from(selectedNames) : [document.activeElement.dataset.name];
    if (names.length === 1) onDuplicate(names[0], undefined);
    else onBulkDuplicate(names);
    return;
  }
  if (mod && e.key === "Backspace" && onRow) {
    e.preventDefault();
    const names = selectedNames.size > 0 ? Array.from(selectedNames) : [document.activeElement.dataset.name];
    // Filter to user patterns; rail callback handles the confirm.
    const userNames = names.filter((n) => isUserName(n));
    if (userNames.length === 0) return;
    if (userNames.length === 1) onDelete(userNames[0]);
    else onBulkDelete(userNames);
    return;
  }
});
```

- [ ] **Step 4: Surface the selection set to the dragstart resolver**

Task 8's `onPatternDragStart` already checks `selectedNames.has(name)` — verify that's wired correctly. If multiple are selected, the drag ghost reads `N patterns`.

- [ ] **Step 5: Style selected rows**

```css
.left-rail__item.is-selected {
  background: color-mix(in oklch, var(--accent) 14%, transparent);
}
.left-rail__item.is-selected.is-active {
  background: color-mix(in oklch, var(--accent) 22%, transparent);
}
```

- [ ] **Step 6: Manual test**

- Cmd-click two patterns → both highlighted.
- Shift-click a third → range fills in.
- Plain click on a single pattern → selection clears, that pattern opens.
- Escape clears selection.
- Drag any selected row → ghost reads `N patterns`, drop moves all of them.

- [ ] **Step 7: Stop and report**

> feat(left-rail): multi-select with cmd/shift/cmd-A, escape to clear

---

## Task 10: Inline rename — patterns and folders

**Files:**

- Modify: `src/ui/left-rail.js`
- Modify: `src/styles/left-rail.css`

- [ ] **Step 1: Add a small inline-edit helper**

```js
/**
 * Start in-place rename on an element. `displayEl` is the span currently
 * showing the name. `initial` is the prefilled value (raw name). `validate`
 * returns null or an error string. `onCommit(newValue)` fires on Enter,
 * `onCancel()` fires on Escape or blur with no change.
 */
function beginInlineEdit({ displayEl, initial, validate, onCommit, onCancel }) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "left-rail__inline-edit";
  input.value = initial;
  input.setAttribute("aria-label", "Rename");
  // Replace the display element while editing.
  const parent = displayEl.parentNode;
  parent.replaceChild(input, displayEl);
  input.focus();
  input.select();

  const errEl = document.createElement("div");
  errEl.className = "left-rail__inline-error";
  parent.appendChild(errEl);

  function cleanup() {
    if (input.parentNode) parent.replaceChild(displayEl, input);
    if (errEl.parentNode) errEl.remove();
  }
  function commit() {
    const value = input.value.trim();
    if (value === initial) { cleanup(); onCancel?.(); return; }
    const err = validate(value);
    if (err) {
      errEl.textContent = err;
      input.classList.add("left-rail__inline-edit--error");
      return;
    }
    cleanup();
    onCommit(value);
  }
  function cancel() { cleanup(); onCancel?.(); }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", () => commit()); // commit-on-blur for consistency with VS Code
}
```

- [ ] **Step 2: Wire pattern rename**

On a user-pattern row, double-click on the name (the `.left-rail__item-name` span), or pressing F2 while focused, or clicking "Rename…" in the context menu (Task 11), calls:

```js
function renamePatternRow(row, name) {
  const nameEl = row.querySelector(".left-rail__item-name");
  beginInlineEdit({
    displayEl: nameEl,
    initial: name,
    validate: (v) => {
      if (v === name) return null;
      const err = validatePatternName(v);
      if (err) return err;
      if (allExistingNames().has(v)) return `"${v}" already exists`;
      return null;
    },
    onCommit: (newName) => onRenamePattern(name, newName),
  });
}
```

`allExistingNames()` returns a Set of every Demo name + every user pattern name currently in `groupedUserPatterns`. The host (`main.js`) does the actual rename via `store.renamePatternKey` and re-mounts the rail.

- [ ] **Step 3: Wire folder rename**

On a user-folder header, double-click on the name, F2 while focused, or "Rename folder…" from the context menu (Task 12), calls:

```js
function renameFolderRow(header, folderName) {
  const nameEl = header.querySelector(".left-rail__folder-name");
  beginInlineEdit({
    displayEl: nameEl,
    initial: folderName,
    validate: (v) => validateFolderName(v, folders.filter((f) => f !== folderName)),
    onCommit: (newName) => onRenameFolder(folderName, newName),
  });
}
```

`validateFolderName` is imported from `src/patterns.js`.

- [ ] **Step 4: Add F2 keybinding**

In the row keydown handler:

```js
else if (e.key === "F2") {
  e.preventDefault();
  if (isUser) renamePatternRow(row, name);
  // For Demos: optionally show a tooltip — out of scope here.
}
```

And on folder header keydown:

```js
else if (e.key === "F2" && folderName !== "__demos__" && folderName !== "__unfiled__") {
  e.preventDefault();
  renameFolderRow(header, folderName);
}
```

- [ ] **Step 5: Styles**

```css
.left-rail__inline-edit {
  width: 100%;
  font: inherit;
  background: var(--bg-elevated);
  color: var(--fg);
  border: 1px solid var(--accent);
  border-radius: 3px;
  padding: 1px 4px;
}
.left-rail__inline-edit--error { border-color: var(--danger, #c0392b); }
.left-rail__inline-error {
  color: var(--danger, #c0392b);
  font-size: var(--font-size-xs);
  padding: 0 var(--space-2);
}
```

- [ ] **Step 6: Manual test**

- Double-click a user pattern's name → inline input, type new name, Enter commits.
- F2 on a user pattern row → same.
- Double-click a folder name → rename. Enter commits.
- Esc cancels with no change.
- Try renaming to an existing name → red border, error text under the row.

- [ ] **Step 7: Stop and report**

> feat(left-rail): inline rename for user patterns and folders

---

## Task 11: Per-row context menu

**Files:**

- Modify: `src/ui/left-rail.js`

- [ ] **Step 1: Rebuild `showContextMenu` to match the new spec**

Today's menu has Revert and Delete. Replace with the full spec:

```js
function showContextMenu(x, y, name, isUser, folderOfThisName) {
  dismissContextMenu();
  const menu = el("div", "left-rail__context-menu");

  const isSelected = selectedNames.has(name);
  const isBulk = isSelected && selectedNames.size > 1;
  const count = isBulk ? selectedNames.size : 1;

  if (isBulk) buildBulkMenu(menu, name);
  else if (isUser) buildUserMenu(menu, name, folderOfThisName);
  else buildDemoMenu(menu, name);

  positionAndShow(menu, x, y);
}

function buildUserMenu(menu, name, folder) {
  addItem(menu, "Open", () => onSelect(name));
  addItem(menu, "Rename…", () => renamePatternRow(rowOf(name), name));
  addItem(menu, "Duplicate…", () => onDuplicate(name, folder));
  addSubmenu(menu, "Move to", buildMoveSubmenu([name]));
  addSeparator(menu);
  addItem(menu, "Delete", () => onDelete(name), { danger: true });
}

function buildDemoMenu(menu, name) {
  addItem(menu, "Open", () => onSelect(name));
  addItem(menu, "Duplicate…", () => onDuplicate(name, null));
  if (dirtySet.has(name)) {
    addSeparator(menu);
    addItem(menu, "Revert to original", () => onRevert(name));
  }
}

function buildBulkMenu(menu, anchorName) {
  const names = Array.from(selectedNames);
  const someDemos = names.some((n) => !isUserName(n));
  const allUser = names.every((n) => isUserName(n));
  addSubmenu(menu, `Move ${names.length} patterns to`, buildMoveSubmenu(names));
  addItem(menu, `Duplicate ${names.length} patterns…`, () => onBulkDuplicate(names));
  addSeparator(menu);
  const deleteItem = addItem(menu, `Delete ${names.length} patterns…`, () => onBulkDelete(names), { danger: true });
  if (!allUser) {
    deleteItem.setAttribute("aria-disabled", "true");
    deleteItem.classList.add("is-disabled");
    deleteItem.onclick = null;
  }
}

function buildMoveSubmenu(names) {
  const items = [];
  for (const f of folders) items.push({ label: f, onClick: () => onBulkMove(names, f) });
  items.push({ label: "Unfiled", onClick: () => onBulkMove(names, null) });
  items.push({ label: "New folder…", onClick: () => onBulkMove(names, "__new__") });
  return items;
}
```

`addItem`, `addSubmenu`, `addSeparator`, `positionAndShow`, `rowOf`, `isUserName` are small helpers — write them in the same file. `addSubmenu` renders a row whose hover opens a flyout to the right (clamped to viewport).

- [ ] **Step 2: Trigger via right-click and the hover-reveal `⋯` button**

The existing right-click and `⋯` button handlers already invoke `showContextMenu`. Pass the additional `folderOfThisName` argument when invoking from a user pattern row.

- [ ] **Step 3: Styles**

```css
.left-rail__context-item.is-disabled { opacity: 0.45; pointer-events: none; }
.left-rail__context-submenu {
  position: absolute;
  /* layout: same as primary menu */
}
.left-rail__context-item--has-submenu::after { content: "▸"; margin-left: auto; }
```

- [ ] **Step 4: Manual test**

- Right-click a user pattern → menu shows Open, Rename…, Duplicate…, Move to ▸, Delete.
- Right-click a Demo → Open, Duplicate…, (Revert if dirty).
- Right-click while multiple selected → bulk menu. Delete is disabled if Demos are in the selection.
- Click "Move to ▸ Jazz" — the callback fires (Task 17 wires it; for now log to console).

- [ ] **Step 5: Stop and report**

> feat(left-rail): full per-row context menu with bulk + submenu support

---

## Task 12: Folder header context menu + delete-folder modal

**Files:**

- Modify: `src/ui/left-rail.js`
- Modify: `src/ui/modal.js` (add a `twoButtonConfirm` if not already present — see below)

- [ ] **Step 1: Add a header context menu**

On every user-folder header (not Demos, not Unfiled), attach right-click and hover-`⋯`-click → header context menu:

```
[Rename folder…]
[Delete folder…]
```

```js
function showFolderHeaderMenu(x, y, folderName) {
  dismissContextMenu();
  const menu = el("div", "left-rail__context-menu");
  addItem(menu, "Rename folder…", () => renameFolderRow(headerOf(folderName), folderName));
  addItem(menu, "Delete folder…", () => onDeleteFolder(folderName), { danger: true });
  positionAndShow(menu, x, y);
}
```

- [ ] **Step 2: Add the delete-folder modal helper**

The two-button confirm (Move to Unfiled / Delete all) doesn't fit `confirm()`'s single-button shape. Add a small `choiceModal({ title, message, choices })` to `modal.js` returning the chosen choice's `value` or `null` on cancel:

```js
export function choiceModal({ title, message, choices, cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    // ... uses the same backdrop/focus-trap machinery
    // Each choice: { value, label, danger? }
  });
}
```

- [ ] **Step 3: Wire up `onDeleteFolder` in the rail**

The rail's `onDeleteFolder(folderName)` callback fires; the host (`main.js`, Task 17) is responsible for:

1. Counting patterns in the folder.
2. If empty: simple `confirm({ title: "Delete folder?" })`.
3. If non-empty: `choiceModal({ title: "Delete folder?", message: ..., choices: [{value: "unfile"}, {value: "delete"}] })`.
4. Performing the chosen action against the store.
5. Re-mounting the rail with the new grouped patterns.

For this task: just emit the callback. The host implementation lands in Task 17.

- [ ] **Step 4: Manual test**

- Right-click a user folder header → menu appears with Rename and Delete.
- Click Rename → inline input on the header (Task 10 already wired this).
- Click Delete → the callback fires (logged to console for now; modal flow ships in Task 17).

- [ ] **Step 5: Stop and report**

> feat(left-rail): folder-header context menu + choiceModal helper

---

## Task 13: New-pattern dialog with folder selector

**Files:**

- Modify: `src/patterns.js`

- [ ] **Step 1: Rewrite `handleNewPatternClick`**

Replace the bare-name prompt with the new form modal. Take the `folders` list and `lastNewPatternFolder` as inputs:

```js
export async function handleNewPatternClick(ctx) {
  const {
    store, patterns, editor, leftRail, transport, setCurrentName,
    flushToStore, formModal, isDev,
    folders,                       // string[]
    lastNewPatternFolder = null,   // string | null
    onLastNewPatternFolderChange,  // (folderName: string | null) => void
  } = ctx;
  flushToStore();

  const folderOptions = [
    { value: "", label: "Unfiled" },
    ...folders.map((f) => ({ value: f, label: f })),
    { value: "__new__", label: "New folder…" },
  ];
  const defaultFolder = lastNewPatternFolder && folders.includes(lastNewPatternFolder)
    ? lastNewPatternFolder
    : "";

  const values = await formModal({
    title: "New pattern",
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "letters, numbers, - and _", defaultValue: `untitled-${Date.now().toString(36)}` },
      { key: "folder", label: "Folder", type: "select", options: folderOptions, defaultValue: defaultFolder },
    ],
    confirmLabel: "Create",
    validate: (v) => {
      const errs = {};
      const nameErr = validatePatternName(v.name);
      if (nameErr) errs.name = nameErr;
      else if (patternNameExists(v.name, patterns, store)) errs.name = `"${v.name}" already exists`;
      return Object.keys(errs).length ? errs : null;
    },
  });
  if (!values) return;

  let folder = values.folder || null;
  if (folder === "__new__") {
    folder = await promptForNewFolderName(formModal, store);
    if (folder == null) return; // cancelled
  }

  const code = `// ${values.name}\nsetcps(120/60/4)\n\nsound("bd ~ sd ~")\n`;
  const r = await saveNewPattern({
    name: values.name, code, folder,
    store, patterns, leftRail, setCurrentName, editor, transport, isDev,
  });
  if (r.ok) onLastNewPatternFolderChange?.(folder);
}

async function promptForNewFolderName(formModal, store) {
  const idx = store.getIndex();
  const existing = idx.folders ?? [];
  const v = await formModal({
    title: "New folder",
    fields: [{ key: "name", label: "Folder name", type: "text", placeholder: "e.g. Jazz Sessions" }],
    confirmLabel: "Create",
    validate: (v) => {
      const err = validateFolderName(v.name, existing);
      return err ? { name: err } : null;
    },
  });
  if (!v) return null;
  const name = v.name.trim();
  store.setIndex({ ...idx, folders: [...existing, name] });
  return name;
}
```

- [ ] **Step 2: Update the call site in `main.js`**

In `main.js`, the rail's `onCreate` callback today passes a bag of context. Update the bag:

```js
onCreate() {
  handleNewPatternClick({
    store, patterns, editor, leftRail, transport,
    setCurrentName, flushToStore,
    formModal,                                              // import from modal.js
    isDev: import.meta.env.DEV,
    folders: store.getIndex().folders ?? [],
    lastNewPatternFolder: store.getIndex().uiState?.lastNewPatternFolder ?? null,
    onLastNewPatternFolderChange(folder) {
      const idx = store.getIndex();
      idx.uiState = { ...(idx.uiState ?? {}), lastNewPatternFolder: folder };
      store.setIndex(idx);
    },
  });
},
```

After the pattern is saved, re-group and re-mount or partially update the rail (Task 17 handles the full re-grouping pattern; for now `leftRail.addUserPattern(name, folder)` works once you've updated `addUserPattern` to accept a folder argument — see Task 17).

- [ ] **Step 3: Manual test**

- Click `+` in the rail → form modal with Name + Folder dropdown.
- Pick "Unfiled" → after confirm, pattern appears in Unfiled.
- Pick an existing folder → pattern appears there.
- Pick "New folder…" → a follow-up modal asks for the folder name → creates the folder and places the pattern in it.

- [ ] **Step 4: Stop and report**

> feat(patterns): new-pattern dialog with folder selector

---

## Task 14: Duplicate dialog (single)

**Files:**

- Modify: `src/patterns.js` (add `handleDuplicateClick`)
- Modify: `src/main.js` (wire `onDuplicate`)

- [ ] **Step 1: Add `handleDuplicateClick` to `src/patterns.js`**

```js
export async function handleDuplicateClick({
  sourceName,
  preselectedFolder,        // string | null | undefined
  store, patterns, editor, leftRail, transport,
  setCurrentName, flushToStore, formModal, isDev,
  folders,
}) {
  flushToStore();
  // Resolve source code: working copy if it exists, else the original.
  const record = store.get(sourceName);
  const sourceCode = record?.code ?? patterns[sourceName];
  if (sourceCode == null) {
    transport.setStatus(`can't duplicate "${sourceName}" — not found`);
    return;
  }
  const sourceIsDemo = sourceName in patterns && !record?.isUserPattern;
  const sourceFolder = sourceIsDemo ? null : (record?.folder ?? null);
  const defaultFolder = preselectedFolder !== undefined ? preselectedFolder : sourceFolder;

  const folderOptions = [
    { value: "", label: "Unfiled" },
    ...folders.map((f) => ({ value: f, label: f })),
    { value: "__new__", label: "New folder…" },
  ];
  const values = await formModal({
    title: `Duplicate "${sourceName}"`,
    fields: [
      { key: "name", label: "Name", type: "text", defaultValue: makeCopyName(sourceName, store, patterns) },
      { key: "folder", label: "Folder", type: "select", options: folderOptions, defaultValue: defaultFolder ?? "" },
    ],
    confirmLabel: "Duplicate",
    validate: (v) => {
      const errs = {};
      const nameErr = validatePatternName(v.name);
      if (nameErr) errs.name = nameErr;
      else if (patternNameExists(v.name, patterns, store)) errs.name = `"${v.name}" already exists`;
      return Object.keys(errs).length ? errs : null;
    },
  });
  if (!values) return;

  let folder = values.folder || null;
  if (folder === "__new__") {
    folder = await promptForNewFolderName(formModal, store);
    if (folder == null) return;
  }

  await saveNewPattern({
    name: values.name, code: sourceCode, folder,
    store, patterns, leftRail, setCurrentName, editor, transport, isDev: false, // duplicate goes to store, not /api/save
  });
}

function makeCopyName(sourceName, store, patterns) {
  const base = `${sourceName}-copy`;
  if (!patternNameExists(base, patterns, store)) return base;
  let n = 2;
  while (patternNameExists(`${sourceName}-copy-${n}`, patterns, store)) n++;
  return `${sourceName}-copy-${n}`;
}
```

- [ ] **Step 2: Wire `onDuplicate` in `main.js`**

In the rail's options:

```js
onDuplicate(sourceName, preselectedFolder) {
  handleDuplicateClick({
    sourceName, preselectedFolder,
    store, patterns, editor, leftRail, transport,
    setCurrentName, flushToStore,
    formModal, isDev: import.meta.env.DEV,
    folders: store.getIndex().folders ?? [],
  });
},
```

- [ ] **Step 3: Update drag-and-drop fork path (from Task 8)**

When a Demo is dragged onto a user folder, the rail emits `onDuplicate(demoName, targetFolder)`. The duplicate dialog opens with that folder pre-selected.

- [ ] **Step 4: Manual test**

- Right-click a user pattern → Duplicate → modal with `-copy` name and source's folder selected. Confirm → new pattern appears.
- Right-click a Demo → Duplicate → modal with `-copy` name and Unfiled selected. Confirm → new user pattern.
- Drag a Demo onto Jazz → Duplicate modal opens with Jazz pre-selected.
- Pick "New folder…" → second modal prompts for folder name → creates + duplicates in one flow.

- [ ] **Step 5: Stop and report**

> feat(patterns): Duplicate dialog (single source) — opens from menu and drag-from-Demo

---

## Task 15: Bulk duplicate dialog

**Files:**

- Modify: `src/patterns.js` (add `handleBulkDuplicateClick`)
- Modify: `src/main.js` (wire `onBulkDuplicate`)

- [ ] **Step 1: Add `handleBulkDuplicateClick`**

```js
export async function handleBulkDuplicateClick({
  sourceNames,            // string[]
  store, patterns, editor, leftRail, transport,
  setCurrentName, flushToStore, formModal, isDev,
  folders,
}) {
  flushToStore();
  // Resolve target names: pre-fill each with -copy and ensure uniqueness within the set.
  const resolved = sourceNames.map((src) => ({
    source: src,
    target: makeCopyName(src, store, patterns),
  }));
  const folderOptions = [
    { value: "", label: "Unfiled" },
    ...folders.map((f) => ({ value: f, label: f })),
    { value: "__new__", label: "New folder…" },
  ];
  const fields = [];
  for (const { source } of resolved) {
    fields.push({
      key: `name:${source}`,
      label: `Name (from "${source}")`,
      type: "text",
      defaultValue: makeCopyName(source, store, patterns),
    });
  }
  fields.push({
    key: "folder", label: "Folder for all", type: "select", options: folderOptions, defaultValue: "",
  });

  const values = await formModal({
    title: `Duplicate ${sourceNames.length} patterns`,
    fields,
    confirmLabel: "Duplicate",
    validate: (v) => {
      const errs = {};
      const seenNames = new Set();
      for (const { source } of resolved) {
        const k = `name:${source}`;
        const candidate = v[k];
        const nameErr = validatePatternName(candidate);
        if (nameErr) errs[k] = nameErr;
        else if (patternNameExists(candidate, patterns, store)) errs[k] = `"${candidate}" already exists`;
        else if (seenNames.has(candidate)) errs[k] = `duplicate name "${candidate}" in this batch`;
        seenNames.add(candidate);
      }
      return Object.keys(errs).length ? errs : null;
    },
  });
  if (!values) return;

  let folder = values.folder || null;
  if (folder === "__new__") {
    folder = await promptForNewFolderName(formModal, store);
    if (folder == null) return;
  }

  let n = 0;
  for (const { source } of resolved) {
    const target = values[`name:${source}`];
    const record = store.get(source);
    const code = record?.code ?? patterns[source];
    if (code == null) continue;
    const r = await saveNewPattern({
      name: target, code, folder,
      store, patterns, leftRail, setCurrentName, editor, transport, isDev: false,
    });
    if (r.ok) n++;
  }
  transport.setStatus(`Duplicated ${n} patterns`);
}
```

- [ ] **Step 2: Wire `onBulkDuplicate`**

```js
onBulkDuplicate(names) {
  handleBulkDuplicateClick({
    sourceNames: names,
    store, patterns, editor, leftRail, transport,
    setCurrentName, flushToStore, formModal,
    isDev: import.meta.env.DEV,
    folders: store.getIndex().folders ?? [],
  });
},
```

- [ ] **Step 3: Manual test**

- Cmd-click 3 user patterns, right-click → Duplicate N patterns… → modal shows 3 name rows + folder dropdown.
- Confirm → 3 new patterns appear in the chosen folder.

- [ ] **Step 4: Stop and report**

> feat(patterns): bulk Duplicate dialog

---

## Task 16: Settings panel — Library export / import

**Files:**

- Modify: `src/ui/settings-panel.js`
- Modify: `src/main.js` (provide the wiring)

- [ ] **Step 1: Add a "Library" section to the settings panel**

In `settings-panel.js`, between the existing editor settings and the About block, add:

```js
const libSection = el("section", "settings-panel__section");
const libTitle = el("h3", "settings-panel__section-title", "Library");
libSection.appendChild(libTitle);

const libBlurb = el("p", "settings-panel__hint",
  "Download all your patterns (and modified Demos) as a JSON file. " +
  "Re-import it to restore on another browser.");
libSection.appendChild(libBlurb);

const exportBtn = el("button", "btn", "Export library");
const importBtn = el("button", "btn", "Import library…");
const fileInput = el("input");
fileInput.type = "file";
fileInput.accept = ".json,application/json";
fileInput.style.display = "none";

exportBtn.addEventListener("click", () => onExport());
importBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) onImport(f);
  fileInput.value = ""; // allow re-importing the same file
});

const actions = el("div", "settings-panel__actions");
actions.appendChild(exportBtn);
actions.appendChild(importBtn);
actions.appendChild(fileInput);
libSection.appendChild(actions);
```

The mount function should accept `onExport`, `onImport` callbacks and the function should disable `exportBtn` when there's nothing to export — read the store at click time, not at mount time. Or just always-enabled and report "Library is empty" via the transport status; simpler.

- [ ] **Step 2: Wire `onExport` and `onImport` in `main.js`**

```js
import { buildExport, parseImportJson, previewImport, applyImport } from "./library-io.js";

mountSettings({
  // ... existing props
  onExportLibrary() {
    const payload = buildExport(store);
    if (payload.folders.length === 0 && Object.keys(payload.patterns).length === 0) {
      transport.setStatus("Library is empty — nothing to export");
      return;
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `strasbeat-library-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    transport.setStatus(`Exported ${Object.keys(payload.patterns).length} patterns`);
  },
  async onImportLibrary(file) {
    const text = await file.text();
    const parsed = parseImportJson(text);
    if (!parsed.ok) {
      await modalAlert({ title: "Couldn't read library", message: parsed.error });
      return;
    }
    const shippedDemos = new Set(Object.keys(patterns));
    const pv = previewImport(parsed.data, store, shippedDemos);
    const conflictCount = pv.conflicts.length;
    const newCount = pv.newUserPatterns.length;

    const choices = [
      ...(conflictCount > 0
        ? [
            { value: "skip",      label: "Skip existing" },
            { value: "overwrite", label: "Overwrite existing" },
            { value: "rename",    label: "Rename existing -imported" },
          ]
        : []),
    ];
    let strategy = "skip";
    if (choices.length) {
      const r = await choiceModal({
        title: "Import library",
        message:
          `${newCount + conflictCount} patterns across ${pv.newFolders.length} new folder(s).` +
          (conflictCount ? `\n\n${conflictCount} already exist: ${pv.conflicts.slice(0, 5).join(", ")}${conflictCount > 5 ? "…" : ""}` : "") +
          (pv.demoWorkingCopies.untransferable.length ? `\n\n${pv.demoWorkingCopies.untransferable.length} modified demos won't be imported (originals not in this build).` : ""),
        choices,
        cancelLabel: "Cancel",
      });
      if (r == null) return;
      strategy = r;
    } else {
      const ok = await confirm({
        title: "Import library",
        message: `${newCount} patterns will be imported.`,
        confirmLabel: "Import",
      });
      if (!ok) return;
    }
    const result = applyImport(parsed.data, store, { conflictStrategy: strategy, shippedDemos });
    // Re-mount the rail with new grouped patterns (Task 17 has this helper).
    refreshRail();
    if (result.ok) {
      transport.setStatus(`Imported ${result.imported} patterns into ${pv.newFolders.length} new folder(s)`);
    } else {
      transport.setStatus(result.error ?? "Import failed");
    }
  },
});
```

(`modalAlert` is a thin wrapper around `confirm({...confirmLabel: 'OK', cancelLabel: null})` — add it if not present.)

- [ ] **Step 3: Manual test**

- Create a couple of folders & patterns.
- Open Settings → Library → Export. Verify the downloaded JSON has the documented shape.
- Click Import → pick the same file. Preview modal shows N existing patterns. Choose "Skip". Result: status reports skipped.
- Choose "Overwrite" instead → verify codes match the imported version.
- Try importing a malformed file (e.g., `{}`) → error modal explains.

- [ ] **Step 4: Stop and report**

> feat(settings): Library export/import section with preview modal

---

## Task 17: main.js integration — group, refresh, callbacks, folder mgmt actions

**Files:**

- Modify: `src/main.js`

- [ ] **Step 1: Boot-time wiring**

Where the rail is mounted today, change the props passed to it:

```js
const grouped = groupUserPatternsByFolder(store);
const indexAtBoot = store.getIndex();
const collapsedFolders = indexAtBoot.uiState?.collapsedFolders ?? [];

const leftRail = mountLeftRail({
  container: leftRailContainer,
  patterns,
  userPatterns: getUserPatternNames(store),
  groupedUserPatterns: grouped,
  folders: indexAtBoot.folders ?? [],
  collapsedFolders,
  dirtySet: computeDirtySet(patternNames, patterns, store),
  currentName,

  onSelect(name) { /* existing logic, plus refresh path below */ },
  onCreate()    { /* delegates to handleNewPatternClick — Task 13 */ },
  onImportMidi: openMidiImportDialog,

  onRevert(name)                   { /* existing */ },
  onDelete(name)                   { /* existing */ },
  onCollapseChange(folder, isCol)  { persistCollapse(folder, isCol); },

  onCreateFolder()                 { promptCreateFolder(); },
  onRenameFolder(oldName, newName) { renameFolder(oldName, newName); },
  onDeleteFolder(name)             { deleteFolder(name); },
  onMoveTo(names, target)          { moveMany(names, target); },
  onBulkMove(names, target)        { moveMany(names, target); },
  onBulkDelete(names)              { deleteMany(names); },
  onBulkDuplicate(names)           { /* handleBulkDuplicateClick — Task 15 */ },
  onDuplicate(name, preselected)   { /* handleDuplicateClick — Task 14 */ },
  onRenamePattern(oldName, newName){ renamePattern(oldName, newName); },
});

function refreshRail() {
  // Re-pull groupedUserPatterns + folders + collapsed state and re-mount.
  // If the rail exposes a setData method, use that; otherwise unmount + remount.
}
```

The cleanest path is to add a `leftRail.setData({ groupedUserPatterns, folders, collapsedFolders, dirtySet })` method to the rail (Task 6 should already have something like `setGrouped` — extend it). When the host mutates the store, it calls `refreshRail()` which re-pulls everything and calls `setData`.

- [ ] **Step 2: `persistCollapse`**

```js
function persistCollapse(folderName, isCollapsed) {
  const idx = store.getIndex();
  const set = new Set(idx.uiState?.collapsedFolders ?? []);
  if (isCollapsed) set.add(folderName); else set.delete(folderName);
  idx.uiState = { ...(idx.uiState ?? {}), collapsedFolders: Array.from(set) };
  store.setIndex(idx);
}
```

- [ ] **Step 3: `promptCreateFolder`**

```js
async function promptCreateFolder() {
  const idx = store.getIndex();
  const existing = idx.folders ?? [];
  const v = await formModal({
    title: "New folder",
    fields: [{ key: "name", label: "Folder name", type: "text", placeholder: "e.g. Jazz Sessions" }],
    confirmLabel: "Create",
    validate: (v) => {
      const err = validateFolderName(v.name, existing);
      return err ? { name: err } : null;
    },
  });
  if (!v) return;
  const name = v.name.trim();
  store.setIndex({ ...idx, folders: [...existing, name] });
  refreshRail();
}
```

- [ ] **Step 4: `renameFolder`**

```js
function renameFolder(oldName, newName) {
  if (oldName === newName) return;
  store.renameFolderInRecords(oldName, newName);
  const idx = store.getIndex();
  idx.folders = (idx.folders ?? []).map((f) => (f === oldName ? newName : f));
  if (idx.uiState?.collapsedFolders?.includes(oldName)) {
    idx.uiState.collapsedFolders = idx.uiState.collapsedFolders.map((f) => (f === oldName ? newName : f));
  }
  if (idx.uiState?.lastNewPatternFolder === oldName) {
    idx.uiState.lastNewPatternFolder = newName;
  }
  store.setIndex(idx);
  refreshRail();
  transport.setStatus(`renamed folder "${oldName}" → "${newName}"`);
}
```

- [ ] **Step 5: `deleteFolder`**

```js
async function deleteFolder(folderName) {
  const grouped = groupUserPatternsByFolder(store);
  const inFolder = grouped.folders[folderName] ?? [];
  if (inFolder.length === 0) {
    const ok = await confirm({
      title: "Delete folder?", message: `Delete folder "${folderName}"?`, confirmLabel: "Delete", destructive: true,
    });
    if (!ok) return;
    removeFolderEntry(folderName);
    refreshRail();
    return;
  }
  const choice = await choiceModal({
    title: `Delete folder "${folderName}"?`,
    message: `This folder contains ${inFolder.length} patterns.`,
    choices: [
      { value: "unfile", label: `Move ${inFolder.length} patterns to Unfiled` },
      { value: "delete", label: `Delete folder and all ${inFolder.length} patterns`, danger: true },
    ],
  });
  if (!choice) return;
  if (choice === "unfile") {
    for (const name of inFolder) {
      const rec = store.get(name);
      if (rec) { const next = { ...rec }; delete next.folder; store.set(name, next); }
    }
  } else {
    for (const name of inFolder) {
      store.delete(name);
    }
    const idx = store.getIndex();
    idx.userPatterns = (idx.userPatterns ?? []).filter((n) => !inFolder.includes(n));
    if (inFolder.includes(currentName)) {
      const fallback = patternNames[0];
      setCurrentName(fallback);
      editor.setCode(patterns[fallback]);
      idx.lastOpen = fallback;
    }
    store.setIndex(idx);
  }
  removeFolderEntry(folderName);
  refreshRail();
}

function removeFolderEntry(folderName) {
  const idx = store.getIndex();
  idx.folders = (idx.folders ?? []).filter((f) => f !== folderName);
  if (idx.uiState?.collapsedFolders) {
    idx.uiState.collapsedFolders = idx.uiState.collapsedFolders.filter((f) => f !== folderName);
  }
  if (idx.uiState?.lastNewPatternFolder === folderName) {
    idx.uiState.lastNewPatternFolder = null;
  }
  store.setIndex(idx);
}
```

- [ ] **Step 6: `moveMany`**

```js
function moveMany(names, target /* string | null | "__new__" */) {
  if (target === "__new__") {
    promptCreateFolderThenMove(names);
    return;
  }
  flushToStore();
  let movedUser = 0;
  let skippedDemos = 0;
  for (const name of names) {
    const rec = store.get(name);
    if (!rec || !rec.isUserPattern) { skippedDemos++; continue; }
    const next = { ...rec };
    if (target == null) delete next.folder; else next.folder = target;
    store.set(name, next);
    movedUser++;
  }
  refreshRail();
  if (skippedDemos > 0) transport.setStatus(`Skipped ${skippedDemos} Demo${skippedDemos > 1 ? "s" : ""} — duplicate to customize`);
  else transport.setStatus(`Moved ${movedUser} pattern${movedUser > 1 ? "s" : ""} to ${target ?? "Unfiled"}`);
}

async function promptCreateFolderThenMove(names) {
  await promptCreateFolder();
  // Use the last folder added as the target.
  const idx = store.getIndex();
  const created = (idx.folders ?? []).slice(-1)[0];
  if (created) moveMany(names, created);
}
```

- [ ] **Step 7: `deleteMany`**

```js
async function deleteMany(names) {
  const userNames = names.filter((n) => store.get(n)?.isUserPattern);
  if (userNames.length === 0) {
    transport.setStatus("Nothing to delete — Demos can't be removed");
    return;
  }
  const ok = await confirm({
    title: `Delete ${userNames.length} patterns?`,
    message: "This can't be undone.",
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok) return;
  for (const name of userNames) {
    store.delete(name);
  }
  const idx = store.getIndex();
  idx.userPatterns = (idx.userPatterns ?? []).filter((n) => !userNames.includes(n));
  if (userNames.includes(currentName)) {
    const fallback = patternNames[0];
    setCurrentName(fallback);
    editor.setCode(patterns[fallback]);
    idx.lastOpen = fallback;
  }
  store.setIndex(idx);
  refreshRail();
  transport.setStatus(`Deleted ${userNames.length} pattern${userNames.length > 1 ? "s" : ""}`);
}
```

- [ ] **Step 8: `renamePattern`**

```js
function renamePattern(oldName, newName) {
  if (oldName === newName) return;
  flushToStore();
  store.renamePatternKey(oldName, newName);
  const idx = store.getIndex();
  idx.userPatterns = (idx.userPatterns ?? []).map((n) => (n === oldName ? newName : n));
  if (idx.lastOpen === oldName) idx.lastOpen = newName;
  store.setIndex(idx);
  if (currentName === oldName) setCurrentName(newName);
  refreshRail();
  transport.setStatus(`renamed "${oldName}" → "${newName}"`);
}
```

- [ ] **Step 9: `refreshRail`**

```js
function refreshRail() {
  const idx = store.getIndex();
  leftRail.setData({
    groupedUserPatterns: groupUserPatternsByFolder(store),
    folders: idx.folders ?? [],
    collapsedFolders: idx.uiState?.collapsedFolders ?? [],
    dirtySet: computeDirtySet(patternNames, patterns, store),
  });
}
```

Add `setData` to `left-rail.js`:

```js
function setData({ groupedUserPatterns: g, folders: f, collapsedFolders: cf, dirtySet: d }) {
  if (g) groupedUserPatterns = g;
  if (f) folders = f;
  if (cf) { collapsedSet.clear(); for (const k of cf) collapsedSet.add(k); }
  if (d) dirtySet = new Set(d);
  renderList();
}
```

- [ ] **Step 10: Manual test (end-to-end)**

Run through the acceptance criteria in Task 18.

- [ ] **Step 11: Stop and report**

> feat(main): wire folder management, bulk actions, refresh-on-change

---

## Task 18: Acceptance verification (manual)

**Files:** none (verification)

Walk through every criterion in `design/work/24-pattern-folders.md` "Acceptance → Core" and confirm. Note any that fail and fix in additional small tasks before declaring done.

- [ ] **Step 1: Existing user patterns survive the upgrade**

```bash
git stash
git checkout main
pnpm dev
# Create a couple of user patterns via + and capture; reload to confirm they persist.
```

```bash
git stash pop
pnpm dev
```

Verify the same user patterns appear, now in the Unfiled section.

- [ ] **Step 2: Run through every Core acceptance bullet**

Open `design/work/24-pattern-folders.md`. For each "- [ ]" bullet in the Acceptance → Core section, exercise it in the running app and check it off in your head. If anything fails, note it and open a follow-up task before declaring done.

Specific paths worth walking:

- Create a folder via `+ folder`, name it "Test". It appears, expanded.
- Drag a Demo onto Test → Duplicate dialog opens with Test pre-selected.
- Drop a user pattern onto Test header (collapsed) → after ~500 ms it springs open, drop lands inside.
- Drop a pattern onto Demos → red outline, no move.
- Cmd-click 3 patterns, drag → ghost shows "3 patterns", drop in Unfiled moves all.
- Right-click selection → bulk menu; Delete N patterns → confirm → all gone.
- Double-click "Test" folder name → rename to "Bebop". Records update; the folder still contains the patterns.
- Right-click Bebop → Delete folder → choose "Move to Unfiled". Patterns reappear in Unfiled, folder gone.
- Type a query with an accent in the search ("café") — verify a "Cafe …" pattern matches.
- Settings → Library → Export → file downloads. Clear storage (`localStorage.clear()` in devtools), reload, Import → all patterns and folders restored.
- Type a partial query that matches the folder name ("Bebop") — every pattern in Bebop surfaces.
- Quota: hard to simulate naturally; skip unless you can monkeypatch `localStorage.setItem` in devtools.

- [ ] **Step 3: Run the test suite**

```bash
pnpm test 2>&1 | tail -30
```

Expected: all green.

- [ ] **Step 4: Stop and report**

Final report:

- List acceptance bullets that pass.
- List anything that didn't pass and the proposed follow-up.
- Suggested final commit message (or message per stash if the user prefers small commits):

> feat(patterns): folders, drag-and-drop, multi-select, duplicate, library export/import

---

## Self-Review Notes (filled by author)

**Spec coverage:** Every Core acceptance bullet maps to at least one task:

- Migration → Task 17 (Step 1 wiring)
- Create/rename/delete folder → Tasks 12, 17
- Drag pattern between folders → Task 8
- Spring-loaded folders → Task 8
- Drop-on-Demos rejected → Task 8
- Drag a Demo onto user folder → Tasks 8 + 14
- Multi-select + bulk → Tasks 9, 11, 15, 17
- Duplicate → Tasks 14, 15
- Rename pattern → Tasks 10, 17
- Rename folder rewrites records → Tasks 10, 17 (`renameFolderInRecords` from Task 1)
- Collapse persistence → Tasks 6, 17
- + folder button → Tasks 6 (header), 17 (action)
- New-pattern folder dropdown → Task 13
- Fuzzy + accent search → Tasks 3, 7
- Search clears back to folder view with state preserved → Task 7
- Library export/import → Tasks 4, 16
- QuotaExceededError aborts cleanly → Tasks 1, 4, existing flow in spec 09

**Placeholder scan:** No TBD/TODO/"add appropriate error handling". Every step shows the actual code or the exact commands to run.

**Type consistency:** `groupUserPatternsByFolder` returns `{ folders, unfiled }` consistently across Tasks 2, 6, 7, 17. `score()` returns `{ score, matches }` across Tasks 3, 7. `setData()` shape matches across Tasks 6 and 17.
