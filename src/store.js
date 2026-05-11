// Pattern persistence store — localStorage-backed, interface-first.
//
// The app talks to the store through this interface, never directly to
// localStorage. A future API-backed store implements the same shape.
// See design/work/09-pattern-persistence.md.

const PREFIX = "strasbeat:pattern:";
const INDEX_KEY = "strasbeat:pattern-index";

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
  } catch (err) {
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
 *   set(name, record)                  → void
 *   delete(name)                       → void
 *   keys()                             → string[]
 *   getIndex()                         → StoreIndex
 *   setIndex(index)                    → void
 *   renamePatternKey(oldName, newName) → void
 *   renameFolderInRecords(oldName, newName) → number (count of records rewritten)
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

    set(name, record) {
      try {
        localStorage.setItem(PREFIX + name, JSON.stringify(record));
      } catch (err) {
        // QuotaExceededError — surface it so the caller can warn the user.
        if (err?.name === "QuotaExceededError") {
          console.warn("[strasbeat/store] localStorage quota exceeded");
          throw err;
        }
        console.warn("[strasbeat/store] set() failed:", err);
      }
    },

    delete(name) {
      try {
        localStorage.removeItem(PREFIX + name);
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
  };
}
