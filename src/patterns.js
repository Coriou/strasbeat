// ─── Auto-discover patterns ──────────────────────────────────────────────
// Every .js file in /patterns must `export default` a string of Strudel code.
// Adding/removing files triggers Vite HMR (see hot.accept below).
export function discoverPatterns(patternModules) {
  const patterns = {};
  for (const [filePath, mod] of Object.entries(patternModules)) {
    const name = filePath.split("/").pop().replace(/\.js$/, "");
    patterns[name] = mod.default;
  }
  return { patterns, patternNames: Object.keys(patterns).sort() };
}

/** Compute which shipped patterns have working copies that differ from the original. */
export function computeDirtySet(patternNames, patterns, store) {
  const dirty = new Set();
  for (const name of patternNames) {
    const record = store.get(name);
    if (record && record.code !== patterns[name]) {
      dirty.add(name);
    }
  }
  return dirty;
}

/** Build ordered list of user pattern names from the store index. */
export function getUserPatternNames(store) {
  const idx = store.getIndex();
  // Filter out any that no longer have a record (deleted outside our control).
  return idx.userPatterns.filter((n) => store.get(n) !== null);
}

// ─── Autosave ────────────────────────────────────────────────────────────
// Every document change is debounced 1000ms then flushed to the store.
// Switching patterns or closing the tab triggers an immediate flush.
export function createAutosave({
  editor,
  store,
  patterns,
  patternNames,
  getCurrentName,
  leftRail,
  transport,
}) {
  let timer = null;
  /** Tracks per-pattern dirty state to avoid redundant renderList() calls. */
  const lastDirtyState = new Map();

  /** Write the current editor buffer to the store as a working copy. */
  function flushToStore() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    const currentName = getCurrentName();
    if (!currentName) return;
    const code = editor.code;
    if (code == null) return;
    const isUserPattern = !(currentName in patterns);
    try {
      store.set(currentName, {
        code,
        modified: new Date().toISOString(),
        isUserPattern,
      });
    } catch (err) {
      if (err?.name === "QuotaExceededError") {
        transport.setStatus(
          "\u26a0 couldn\u2019t save \u2014 browser storage full",
        );
      }
      return;
    }
    // Update dirty dot for shipped patterns — only if dirty state changed.
    if (!isUserPattern) {
      const isDirtyNow = code !== patterns[currentName];
      const wasDirty = lastDirtyState.get(currentName) ?? false;
      if (isDirtyNow !== wasDirty) {
        lastDirtyState.set(currentName, isDirtyNow);
        leftRail.updateDirtySet(computeDirtySet(patternNames, patterns, store));
      }
    }
  }

  function scheduleAutosave() {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(flushToStore, 1000);
  }

  return { flushToStore, scheduleAutosave, lastDirtyState };
}

// ─── Pattern-name validation (shared by new-pattern, MIDI import, etc.) ──
const PATTERN_NAME_RE = /^[a-z0-9_-]+$/i;

/** Returns an error string, or null if the name is valid. */
export function validatePatternName(name) {
  if (!PATTERN_NAME_RE.test(name)) return "use only letters, numbers, - and _";
  return null;
}

/** Returns true if `name` already exists (shipped or user-created). */
export function patternNameExists(name, patterns, store) {
  return name in patterns || !!store.get(name)?.isUserPattern;
}

/**
 * Save a pattern (dev: /api/save, prod: store). Returns { ok, error? }.
 * On success in prod, also updates the store index and left rail.
 *
 * @param {string} code - Raw Strudel code (no export wrapper). Used for the
 *   editor and the store in prod.
 * @param {string} [fileContent] - Optional full file content for the disk
 *   write (dev only). Pass this when the caller has built an
 *   `export default \`...\`` wrapper (e.g. MIDI import). When omitted,
 *   `code` is written verbatim.
 */
export async function saveNewPattern({
  name,
  code,
  fileContent,
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
      body: JSON.stringify({ name, code: fileContent ?? code }),
    });
    if (!res.ok) {
      const msg = await res.text();
      transport.setStatus(`save failed: ${msg}`);
      return { ok: false, error: msg };
    }
    transport.setStatus(`created "${name}" — HMR will reload`);
    return { ok: true };
  }
  // Prod: store as user pattern.
  try {
    store.set(name, {
      code,
      modified: new Date().toISOString(),
      isUserPattern: true,
    });
    const idx = store.getIndex();
    idx.userPatterns = [...idx.userPatterns.filter((n) => n !== name), name];
    idx.lastOpen = name;
    store.setIndex(idx);
  } catch (err) {
    if (err?.name === "QuotaExceededError") {
      transport.setStatus(
        "\u26a0 couldn\u2019t save \u2014 browser storage full",
      );
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

// ─── New pattern ("+") button ─────────────────────────────────────────────
// In dev: writes to disk via /api/save, HMR reloads.
// In prod: creates a user pattern in the store, appears in left rail.
export async function handleNewPatternClick(ctx) {
  const {
    store,
    patterns,
    editor,
    leftRail,
    transport,
    setCurrentName,
    flushToStore,
    prompt,
    isDev,
  } = ctx;
  // Flush current buffer before creating a new pattern.
  flushToStore();
  const name = await prompt({
    title: "New pattern name",
    placeholder: "letters, numbers, - and _",
    defaultValue: `untitled-${Date.now().toString(36)}`,
    confirmLabel: "Create",
    validate: validatePatternName,
  });
  if (!name) return;
  if (patternNameExists(name, patterns, store)) {
    transport.setStatus(`"${name}" already exists — pick another name`);
    return;
  }
  const code = `// ${name}\nsetcps(120/60/4)\n\nsound("bd ~ sd ~")\n`;
  await saveNewPattern({
    name,
    code,
    store,
    patterns,
    leftRail,
    setCurrentName,
    editor,
    transport,
    isDev,
  });
}
