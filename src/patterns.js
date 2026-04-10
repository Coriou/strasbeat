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
    validate: (v) =>
      /^[a-z0-9_-]+$/i.test(v) ? null : "use only letters, numbers, - and _",
  });
  if (!name) return;
  // Check both shipped patterns and user patterns.
  if (name in patterns || store.get(name)?.isUserPattern) {
    transport.setStatus(`"${name}" already exists — pick another name`);
    return;
  }
  const code = `// ${name}\nsetcps(120/60/4)\n\nsound("bd ~ sd ~")\n`;
  if (isDev) {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, code }),
    });
    if (!res.ok) {
      transport.setStatus(`save failed: ${await res.text()}`);
      return;
    }
    transport.setStatus(`created "${name}" — HMR will reload`);
  } else {
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
      }
      return;
    }
    leftRail.addUserPattern(name);
    setCurrentName(name);
    editor.setCode(code);
    transport.setStatus(`created "${name}"`);
  }
}
