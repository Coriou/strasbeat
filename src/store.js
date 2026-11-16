// Pattern persistence store — localStorage-backed, interface-first.
//
// The app talks to the store through this interface, never directly to
// localStorage. A future API-backed store implements the same shape.
// See design/work/09-pattern-persistence.md.

const PREFIX = "strasbeat:pattern:";
const INDEX_KEY = "strasbeat:pattern-index";

// ─── Write-health reporting ──────────────────────────────────────────────
// A failed write that its caller keeps retrying (the autosave of a buffer, the
// index) is remembered by key until a later write (or delete) of that same key
// succeeds. Subscribers get `{ failing, quota }` whenever the "is anything
// currently unsaved?" answer changes, so the shell can show a notice that
// stays up for as long as the problem does — a one-off status line is
// overwritten by the next message and is never seen for a flush that runs
// while the page is closing.
//
// One-shot writes (create, rename, import, a captured take) are NOT remembered
// when they fail: the caller reports the failure and gives up, nothing is left
// waiting to be saved, and a notice for them could never clear.
const failingKeys = new Map(); // key → true when the failure was a quota error
const writeStatusListeners = new Set();
let lastReported = false;

function reportWrite(key, err) {
  if (err) failingKeys.set(key, err?.name === "QuotaExceededError");
  else failingKeys.delete(key);
  const failing = failingKeys.size > 0;
  if (failing === lastReported && !err) return;
  lastReported = failing;
  const status = writeStatus();
  for (const cb of writeStatusListeners) {
    try {
      cb(status);
    } catch (e) {
      console.warn("[strasbeat/store] write-status listener threw:", e);
    }
  }
}

function writeStatus() {
  const failing = failingKeys.size > 0;
  return {
    failing,
    quota: failing && Array.from(failingKeys.values()).every(Boolean),
  };
}

function storedCode(raw) {
  try {
    const code = JSON.parse(raw ?? "null")?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function sameLibrary(oldRaw, newRaw) {
  try {
    const a = JSON.parse(oldRaw ?? "null") ?? {};
    const b = JSON.parse(newRaw ?? "null") ?? {};
    return (
      JSON.stringify(a.userPatterns ?? []) === JSON.stringify(b.userPatterns ?? []) &&
      JSON.stringify(a.folders ?? []) === JSON.stringify(b.folders ?? [])
    );
  } catch {
    return false;
  }
}

/**
 * Classify a window `storage` event (a write made by ANOTHER window on this
 * origin) in store terms.
 *
 * A pattern change carries `oldCode`: the code the record held before the
 * write (null when there was no record). That is what a window with nothing
 * of its own to lose is still showing.
 * @returns {{kind:"index"}|{kind:"pattern", name:string, removed:boolean, oldCode:string|null}|{kind:"cleared"}|null}
 */
export function describeStorageEvent(e) {
  if (e.key == null) return { kind: "cleared" }; // localStorage.clear()
  if (e.key === INDEX_KEY) {
    // Every window keeps its own open tabs / focus / collapse state in the
    // shared index, so most index writes say nothing about the library.
    return sameLibrary(e.oldValue, e.newValue) ? null : { kind: "index" };
  }
  if (e.key.startsWith(PREFIX)) {
    return {
      kind: "pattern",
      name: e.key.slice(PREFIX.length),
      removed: e.newValue == null,
      oldCode: storedCode(e.oldValue),
    };
  }
  return null;
}

/** @returns {StoreIndex} */
function readIndex() {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return { lastOpen: null, userPatterns: [] };
    const parsed = JSON.parse(raw);
    const index = {
      lastOpen: parsed.lastOpen ?? null,
      userPatterns: Array.isArray(parsed.userPatterns)
        ? parsed.userPatterns
        : [],
    };
    if (Array.isArray(parsed.folders)) {
      index.folders = parsed.folders;
    }
    if (parsed.uiState && typeof parsed.uiState === "object") {
      index.uiState = parsed.uiState;
    }
    return index;
  } catch {
    return { lastOpen: null, userPatterns: [] };
  }
}

function writeIndex(index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    reportWrite(INDEX_KEY, null);
  } catch (err) {
    reportWrite(INDEX_KEY, err);
    if (err?.name === "QuotaExceededError") {
      console.warn("[strasbeat/store] localStorage quota exceeded (index)");
      throw err;
    }
    console.warn("[strasbeat/store] failed to write index:", err);
  }
}

/**
 * Create a localStorage-backed PatternStore.
 *
 * Interface:
 *   get(name)                          → PatternRecord | null
 *   set(name, record, { retry }?)      → boolean (false when the write was
 *                                        refused for a non-quota reason; quota
 *                                        errors throw). `retry: true` says the
 *                                        caller still holds the data and will
 *                                        try again, so a failure counts as
 *                                        unsaved work until this key saves.
 *   delete(name)                       → void
 *   keys()                             → string[]
 *   getIndex()                         → StoreIndex
 *   setIndex(index)                    → void
 *   renamePatternKey(oldName, newName) → void
 *   renameFolderInRecords(oldName, newName) → number (count of records rewritten)
 *   forgetWriteFailure(name)           → void (a retried write was given up)
 *   onWriteStatus(cb)                  → unsubscribe; cb({ failing, quota }),
 *                                        called at once if a write is already
 *                                        failing
 */
export function createLocalStore() {
  return {
    get(name) {
      try {
        const raw = localStorage.getItem(PREFIX + name);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    set(name, record, { retry = false } = {}) {
      try {
        localStorage.setItem(PREFIX + name, JSON.stringify(record));
        reportWrite(PREFIX + name, null);
        return true;
      } catch (err) {
        if (retry) reportWrite(PREFIX + name, err);
        // QuotaExceededError — surface it so the caller can warn the user.
        if (err?.name === "QuotaExceededError") {
          console.warn("[strasbeat/store] localStorage quota exceeded");
          throw err;
        }
        console.warn("[strasbeat/store] set() failed:", err);
        return false;
      }
    },

    delete(name) {
      try {
        localStorage.removeItem(PREFIX + name);
        // A record that no longer exists can't be "unsaved".
        reportWrite(PREFIX + name, null);
      } catch (err) {
        console.warn("[strasbeat/store] delete() failed:", err);
      }
    },

    keys() {
      const result = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(PREFIX)) {
            result.push(key.slice(PREFIX.length));
          }
        }
      } catch {
        // ignore
      }
      return result;
    },

    getIndex() {
      return readIndex();
    },

    setIndex(index) {
      writeIndex(index);
    },

    // Move a pattern record from one localStorage key to another. No-op when
    // the source has no record. Overwrites the destination if one exists
    // (callers are responsible for uniqueness checks). Raw-string copy
    // preserves the record byte-for-byte without a JSON round-trip.
    renamePatternKey(oldName, newName) {
      let raw = null;
      try {
        raw = localStorage.getItem(PREFIX + oldName);
      } catch (err) {
        console.warn("[strasbeat/store] renamePatternKey read failed:", err);
      }
      if (raw == null) return;
      try {
        localStorage.setItem(PREFIX + newName, raw);
        localStorage.removeItem(PREFIX + oldName);
        reportWrite(PREFIX + newName, null);
        reportWrite(PREFIX + oldName, null);
      } catch (err) {
        if (err?.name === "QuotaExceededError") {
          console.warn("[strasbeat/store] quota exceeded on rename");
          throw err;
        }
        console.warn("[strasbeat/store] renamePatternKey failed:", err);
      }
    },

    // Rewrite every user-pattern record whose folder field matches oldName,
    // setting it to newName. Returns the count of records rewritten. Demo
    // working copies (isUserPattern === false) and records with no folder
    // field are ignored.
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

    // Subscribe to "is anything currently failing to save?" transitions.
    // The caller gave up on a write it had been retrying: nothing is waiting
    // to be saved under this name any more.
    forgetWriteFailure(name) {
      reportWrite(PREFIX + name, null);
    },

    // A failure from before the subscription (boot writes) is replayed, so
    // the subscriber never starts out wrong.
    onWriteStatus(cb) {
      writeStatusListeners.add(cb);
      if (failingKeys.size > 0) cb(writeStatus());
      return () => writeStatusListeners.delete(cb);
    },
  };
}
