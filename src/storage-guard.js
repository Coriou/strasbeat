// Boot guard for browsers where localStorage can't be used at all.
//
// With site data blocked, merely READING `window.localStorage` throws a
// SecurityError; some embedded webviews hand back `null`; and a zero-quota
// profile rejects every write. strasbeat (and the Strudel packages it loads)
// touch localStorage in dozens of places during module evaluation, so any one
// of those aborts the top-level-await boot and leaves a dead page.
//
// Rather than guard every call site, this module — imported FIRST by
// src/main.js — swaps in an in-memory stand-in for exactly those cases. The
// app then boots and works for the session, and `storageIsEphemeral()` lets
// the shell say plainly that nothing will survive a reload.
//
// It deliberately does NOT replace a working-but-full localStorage: that still
// holds the user's patterns, and hiding it behind an empty stand-in would look
// like data loss. Full storage is reported per write by src/store.js instead.

/** A Storage-shaped object backed by a Map. Lives only as long as the page. */
export function createMemoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(i) {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k) {
      return map.has(String(k)) ? map.get(String(k)) : null;
    },
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
    clear() {
      map.clear();
    },
  };
}

/**
 * Why the window's localStorage is unusable, or null when it works.
 *   "blocked"  — access throws, or the property is missing/null
 *   "readonly" — empty and still refuses a one-byte write (zero quota)
 */
export function diagnoseStorage(win) {
  let storage;
  try {
    storage = win.localStorage;
  } catch {
    return "blocked";
  }
  if (storage == null) return "blocked";
  const probe = "strasbeat:storage-probe";
  try {
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return null;
  } catch {
    try {
      // Refusing a write while holding data means "full", which is a real,
      // recoverable state the store reports on its own. Only an EMPTY storage
      // that still refuses writes is unusable outright.
      return storage.length === 0 ? "readonly" : null;
    } catch {
      return "blocked";
    }
  }
}

let ephemeralReason = null;

/**
 * Install the in-memory stand-in on `win` when its localStorage is unusable.
 * @returns {"blocked"|"readonly"|null} the reason a stand-in was installed
 */
export function installStorageGuard(win) {
  const reason = diagnoseStorage(win);
  if (!reason) return null;
  try {
    Object.defineProperty(win, "localStorage", {
      configurable: true,
      enumerable: true,
      value: createMemoryStorage(),
    });
  } catch (err) {
    console.error(
      "[strasbeat] browser storage is unavailable and could not be replaced — the app may fail to start:",
      err,
    );
    return null;
  }
  console.warn(
    `[strasbeat] browser storage is ${reason === "blocked" ? "blocked" : "read-only"} — running in memory only; nothing will be saved across reloads.`,
  );
  return reason;
}

/** True when this session is running on the in-memory stand-in. */
export function storageIsEphemeral() {
  return ephemeralReason != null;
}

if (typeof window !== "undefined") {
  ephemeralReason = installStorageGuard(window);
}
