// ─── Auto-discover patterns ──────────────────────────────────────────────
// Every .js file in /patterns must `export default` a string of Strudel code.
// Adding/removing files triggers Vite HMR (see hot.accept below).
export function discoverPatterns(patternModules) {
  // Null-prototype: `name in patterns` is how the whole app asks "is this a
  // shipped pattern?", and on a plain object that is also true for
  // "constructor", "toString", … — all legal pattern names.
  const patterns = Object.create(null);
  for (const [filePath, mod] of Object.entries(patternModules)) {
    const name = filePath.split("/").pop().replace(/\.js$/, "");
    patterns[name] = mod.default;
  }
  return { patterns, patternNames: Object.keys(patterns).sort() };
}

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
  // Read each record once: the sort below would otherwise re-parse two full
  // records (code included) per comparison.
  const modifiedOf = new Map();

  for (const name of idx.userPatterns) {
    const rec = store.get(name);
    if (!rec || rec.isUserPattern !== true) continue;
    modifiedOf.set(name, typeof rec.modified === "string" ? rec.modified : "");
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
    return modifiedOf.get(b).localeCompare(modifiedOf.get(a));
  };
  for (const f of Object.keys(folders)) folders[f].sort(byModifiedDesc);
  unfiled.sort(byModifiedDesc);

  return { folders, unfiled };
}

const FOLDER_NAME_MAX = 64;
// "demos"/"unfiled" are the rail's fixed sections; the dunder names are the
// sentinel keys the rail and the move / new-pattern dialogs use for them.
const RESERVED_FOLDERS = new Set([
  "demos",
  "unfiled",
  "__demos__",
  "__unfiled__",
  "__new__",
]);

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

/**
 * Resolve the code for a pattern, auto-healing a broken cached working copy.
 *
 * The store (localStorage working copy) normally SHADOWS the shipped disk
 * original — that's how live edits to a Demo persist. But a working copy that
 * no longer *transpiles* is not an edit worth preserving: it can only error
 * the instant you press play. The classic case is a Demo whose disk source was
 * fixed upstream (e.g. a multi-line single-quoted shader string corrected to
 * `'…\n' + '…\n'`) while a stale, broken copy from before the fix lingers in
 * localStorage and keeps winning at boot — the user sees `Unterminated string
 * constant` forever despite the disk file being correct.
 *
 * Auto-heal rule (lossless): for a SHIPPED pattern only (one with a disk
 * original in `patterns`), if the working copy FAILS to transpile but the disk
 * original SUCCEEDS, drop the working copy and fall back to the original. We
 * never touch user patterns (no disk fallback exists), never drop a copy that
 * transpiles (a real edit), and never drop a copy when the original ALSO fails
 * (dropping would lose data without fixing anything). `canTranspile(code)` is
 * injected so this stays headlessly testable and `patterns.js` keeps no
 * transpiler dependency.
 *
 * @param {object} a
 * @param {string} a.name
 * @param {Record<string,string>} a.patterns  shipped disk originals (name→code)
 * @param {{ get(name): {code?:string}|null, delete(name): void }} a.store
 * @param {(code: string) => boolean} a.canTranspile  true iff `code` transpiles
 * @returns {{ code: string|undefined, healed: boolean }}
 *   code: the code to load; healed: true iff a broken copy was dropped.
 */
export function resolveWorkingCopy({ name, patterns, store, canTranspile }) {
  const record = store.get(name);
  const hasOriginal = name in patterns;
  // No working copy → original (if any). Nothing to heal.
  if (!record || typeof record.code !== "string") {
    return { code: hasOriginal ? patterns[name] : undefined, healed: false };
  }
  // User pattern (no disk fallback) → always use the working copy as-is.
  if (!hasOriginal) return { code: record.code, healed: false };
  // Working copy transpiles → it's a real edit; honor it (the normal path).
  if (canTranspile(record.code)) return { code: record.code, healed: false };
  // Working copy is broken. Only heal if the ORIGINAL is itself healthy —
  // otherwise dropping the copy loses data without producing a working file.
  if (!canTranspile(patterns[name])) {
    console.warn(
      `[strasbeat] working copy of "${name}" fails to transpile, and so does ` +
        `the shipped original — keeping the working copy (nothing to fall back to).`,
    );
    return { code: record.code, healed: false };
  }
  console.warn(
    `[strasbeat] working copy of "${name}" no longer transpiles — falling back ` +
      `to the shipped original and dropping the broken cached copy. (A ` +
      `non-compiling cache is not a real edit; your disk version is used.)`,
  );
  store.delete(name);
  return { code: patterns[name], healed: true };
}

/** Build ordered list of user pattern names from the store index. */
export function getUserPatternNames(store) {
  const idx = store.getIndex();
  // Filter out any that no longer have a record (deleted outside our control).
  return idx.userPatterns.filter((n) => store.get(n) !== null);
}

/**
 * Boot-time repair of the store against what actually exists.
 *
 *   - A record nothing lists (not shipped, not in index.userPatterns) is
 *     unreachable from the UI. If it holds code it is promoted to a user
 *     pattern so the work shows up in the library again; if it is empty it is
 *     removed.
 *   - A working copy of a shipped pattern that is byte-identical to the
 *     original is dropped: it carries no edit and would only keep shadowing
 *     the pattern after an update changes it.
 *
 * @returns {{ promoted: string[], dropped: string[] }}
 */
export function reconcileStoredPatterns({ store, patterns }) {
  const promoted = [];
  const dropped = [];
  let idx;
  try {
    idx = store.getIndex();
    const listed = new Set(idx.userPatterns ?? []);
    for (const name of store.keys()) {
      const rec = store.get(name);
      if (!rec || typeof rec !== "object") continue;
      if (name in patterns) {
        if (rec.code === patterns[name]) {
          store.delete(name);
          dropped.push(name);
        }
        continue;
      }
      if (listed.has(name) && rec.isUserPattern === true) continue;
      if (typeof rec.code !== "string" || !PATTERN_NAME_RE.test(name)) continue;
      if (!rec.code.trim()) {
        if (!listed.has(name)) {
          store.delete(name);
          dropped.push(name);
        }
        continue;
      }
      if (rec.isUserPattern !== true) store.set(name, { ...rec, isUserPattern: true });
      listed.add(name);
      promoted.push(name);
    }
    if (promoted.length > 0) {
      store.setIndex({ ...idx, userPatterns: Array.from(listed) });
      console.warn(
        `[strasbeat] recovered ${promoted.length} stored pattern(s) that the library had lost track of: ${promoted.join(", ")}`,
      );
    }
  } catch (err) {
    // Never let a repair pass stop the app from booting.
    console.warn("[strasbeat] store reconciliation failed:", err);
  }
  return { promoted, dropped };
}

// ─── Autosave ────────────────────────────────────────────────────────────
// Every document change is debounced 1000ms then flushed to the store.
// Switching patterns or closing the tab triggers an immediate flush.
//
// A flush only ever writes when the buffer was actually edited since the last
// one. Flushes are requested from many places that involve no edit at all
// (every tab switch, page hide, the new/duplicate/move/rename dialogs), and an
// unconditional write there pins a merely-viewed Demo under a working copy,
// reshuffles the library by `modified`, and lets an idle window overwrite what
// another window just saved.
//
// A write that fails (storage full) is not forgotten when the user moves on to
// another tab: the code is held here per pattern and every later flush tries
// it again, so freeing space is enough for the edits to reach the store.
export function createAutosave({
  editor,
  store,
  patterns,
  patternNames,
  getCurrentName,
  leftRail,
  transport,
  onDirtyChange,
}) {
  let timer = null;
  /** The pattern whose buffer has edits not yet flushed, or null. */
  let pendingName = null;
  /**
   * Writes that failed and are still owed to the store: name → the code that
   * could not be written, and the code the record held at the time (`base`).
   * @type {Map<string, { code: string, base: string|undefined }>}
   */
  const unsaved = new Map();

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * Write the current editor buffer to the store as a working copy — if it
   * has unflushed edits. Returns true when the buffer is now safely stored
   * (or needed no write), false when there was nothing pending or the write
   * failed (the edits stay pending and the next flush retries).
   */
  function flushToStore() {
    clearTimer();
    const stored = flushPending();
    retryUnsaved();
    return stored;
  }

  // Try the failed writes of patterns that are no longer the live buffer.
  function retryUnsaved() {
    for (const [name, { code, base }] of unsaved) {
      // Newer edits to it are pending; their own flush supersedes this one.
      if (name === pendingName) continue;
      const isUserPattern = !(name in patterns);
      const rec = store.get(name);
      const prev =
        rec && typeof rec === "object" && !Array.isArray(rec) ? rec : null;
      // Only write over the record the edits were made against. If it was
      // deleted, reverted, renamed or rewritten since (here or in another
      // window), that newer state stands.
      if (prev?.code !== base || (isUserPattern && !prev)) {
        unsaved.delete(name);
        store.forgetWriteFailure?.(name);
        console.warn(
          `[strasbeat] unsaved edits to "${name}" were dropped — the pattern changed before they could be stored.`,
        );
        continue;
      }
      try {
        const ok = store.set(
          name,
          { ...(prev ?? {}), code, modified: new Date().toISOString(), isUserPattern },
          { retry: true },
        );
        if (ok === false) continue;
      } catch {
        continue; // still no room; the store keeps the save notice up
      }
      unsaved.delete(name);
      if (!isUserPattern) {
        leftRail.updateDirtySet(computeDirtySet(patternNames, patterns, store));
        onDirtyChange?.();
      }
    }
  }

  function flushPending() {
    const name = pendingName;
    if (name == null) return false;
    // The edits belong to a pattern that is no longer the live buffer (it was
    // deleted or closed without saving): there is nothing of it left to write,
    // and the buffer now holds some other pattern's code. (A write of it that
    // FAILED is a different matter — that one is kept in `unsaved`.)
    if (name !== getCurrentName()) {
      pendingName = null;
      return false;
    }
    const code = editor.code;
    if (code == null) return false;
    const isUserPattern = !(name in patterns);
    const stored = store.get(name);
    const prev =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? stored
        : null;
    try {
      if (!isUserPattern && code === patterns[name]) {
        // Edited back to the shipped original. Keeping an identical working
        // copy would shadow the pattern forever, so drop it instead.
        if (prev) store.delete(name);
      } else if (!prev || prev.code !== code) {
        // Merge, never rebuild: the record also carries `folder` (and whatever
        // else is added later), which a from-scratch write would strip.
        const ok = store.set(
          name,
          {
            ...(prev ?? {}),
            code,
            modified: new Date().toISOString(),
            isUserPattern,
          },
          { retry: true },
        );
        if (ok === false) {
          unsaved.set(name, { code, base: prev?.code });
          return false;
        }
        if (isUserPattern && prev?.isUserPattern !== true) {
          // The record had vanished (storage cleared underneath us) or was
          // never listed. Re-list it so the work stays reachable.
          const idx = store.getIndex();
          if (!(idx.userPatterns ?? []).includes(name)) {
            store.setIndex({
              ...idx,
              userPatterns: [...(idx.userPatterns ?? []), name],
            });
            leftRail.addUserPattern?.(name, prev?.folder);
          }
        }
      }
    } catch (err) {
      unsaved.set(name, { code, base: prev?.code });
      if (err?.name === "QuotaExceededError") {
        transport.setStatus(
          "⚠ couldn’t save — browser storage full",
        );
      } else {
        console.warn(`[strasbeat] autosave of "${name}" failed:`, err);
        transport.setStatus(`⚠ couldn’t save "${name}"`);
      }
      return false;
    }
    pendingName = null;
    unsaved.delete(name);
    // Update dirty dot for shipped patterns — only if dirty state changed.
    if (!isUserPattern) {
      const isDirtyNow = code !== patterns[name];
      const wasDirty = prev != null && prev.code !== patterns[name];
      if (isDirtyNow !== wasDirty) {
        leftRail.updateDirtySet(computeDirtySet(patternNames, patterns, store));
        onDirtyChange?.();
      }
    }
    return true;
  }

  function scheduleAutosave() {
    clearTimer();
    pendingName = getCurrentName() || null;
    // No pattern is open (the empty state): the buffer belongs to nothing.
    if (pendingName == null) return;
    timer = setTimeout(flushToStore, 1000);
  }

  /** True when `name` has edits that are not in the store yet. */
  function hasPending(name) {
    return (pendingName != null && pendingName === name) || unsaved.has(name);
  }

  /** A pattern was renamed: what is owed to the old name is owed to the new. */
  function renamePending(oldName, newName) {
    if (pendingName === oldName) pendingName = newName;
    if (unsaved.has(oldName)) {
      unsaved.set(newName, unsaved.get(oldName));
      unsaved.delete(oldName);
    }
  }

  return { flushToStore, scheduleAutosave, hasPending, renamePending };
}

/**
 * React to a store write made by ANOTHER window (see describeStorageEvent in
 * store.js). The store is shared, the editor buffers are not, so a window
 * whose copy of a pattern is untouched follows the newer stored version
 * instead of holding a stale buffer it might later write back.
 *
 * Following replaces the buffer, so it only ever happens when this window has
 * nothing of its own to lose — the buffer still holds exactly what the store
 * held before the other window's write (`change.oldCode`). In every other case
 * the buffer is kept and queued to be stored again, and the user is told:
 *
 *   - edits still inside the autosave debounce, or a write that failed;
 *   - a buffer that matches neither the old nor the new stored code;
 *   - a shipped pattern's working copy removed while it does not transpile.
 *     That is what the other window's auto-heal does to a copy saved
 *     mid-expression (see resolveWorkingCopy) — the buffer here is then the
 *     only copy of what is being typed.
 *
 * For the same reason nothing on this path may heal: reacting to another
 * window's write must never itself delete a record.
 */
export function handleExternalStoreChange(change, deps) {
  const {
    tabs,
    patterns,
    hasPending,
    getActiveCode,
    store,
    refreshRail,
    setStatus,
    keepLocalEdits = () => {},
    canTranspile = () => true,
  } = deps;
  if (!change) return;
  if (change.kind === "pattern" && tabs.getOpenItems().includes(change.name)) {
    const { name, removed } = change;
    const shipped = name in patterns;
    const keeping = `"${name}" was also changed in another window — keeping this window’s edits`;
    if (hasPending(name)) {
      setStatus(keeping);
    } else if (tabs.getActiveItem() !== name) {
      // A background tab was flushed when it lost focus, so its cached state
      // holds nothing the store didn't. Drop it; it is rebuilt on next focus.
      if (removed && !shipped) tabs.close(name, { flush: false });
      else tabs.refresh(name, { heal: false });
    } else {
      const local = getActiveCode();
      const known = change.oldCode ?? patterns[name];
      const healedAway = removed && shipped && !canTranspile(local);
      if (local === (store.get(name)?.code ?? patterns[name])) {
        // Same code (e.g. only its folder changed) keeps the live tab — and
        // its undo history — exactly as it is.
      } else if (local !== known || healedAway) {
        keepLocalEdits(name);
        setStatus(keeping);
      } else if (removed && !shipped) {
        // Deleted over there; flushing would write the pattern straight back.
        tabs.close(name, { flush: false });
      } else {
        tabs.refresh(name, { heal: false });
      }
    }
  }
  // index / pattern / cleared all change what the library shows.
  refreshRail();
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
 * True when `name` is taken by ANYTHING — a shipped pattern or any stored
 * record, listed or not. Stricter than patternNameExists; used wherever a new
 * record is about to be written and must not land on top of existing data.
 */
export function patternNameTaken(name, patterns, store) {
  return name in patterns || store.get(name) != null;
}

/**
 * Save a new pattern as a user pattern in the store. Returns { ok, error? }.
 * On success, updates the store index, left rail, and editor buffer.
 *
 * New patterns ALWAYS go to the store, in both dev and prod. The "Save"
 * toolbar button (dev only) is the explicit gesture for promoting a
 * buffer to a tracked Demo file on disk. Two reasons:
 *   - Folder choice is honored synchronously: no HMR round-trip, no
 *     dev/prod divergence where "Unfiled" silently means different things.
 *   - Matches Duplicate's behaviour: a fork is always a user pattern,
 *     never a disk write, even in dev.
 *
 * `code` is always raw Strudel code (no export wrapper).
 */
export async function saveNewPattern({
  name,
  code,
  folder, // optional: undefined or null means Unfiled
  store,
  leftRail,
  setCurrentName,
  editor,
  transport,
  openPattern, // optional: (name) => void — if provided, called instead of setCurrentName+setCode
}) {
  try {
    const rec = {
      code,
      modified: new Date().toISOString(),
      isUserPattern: true,
    };
    if (folder) rec.folder = folder;
    store.set(name, rec);
    const idx = store.getIndex();
    idx.userPatterns = [
      ...(idx.userPatterns ?? []).filter((n) => n !== name),
      name,
    ];
    idx.lastOpen = name;
    store.setIndex(idx);
  } catch (err) {
    if (err?.name === "QuotaExceededError") {
      transport.setStatus(
        "\u26a0 couldn\u2019t save \u2014 browser storage full",
      );
      return { ok: false, error: "storage full" };
    }
    transport.setStatus(`couldn\u2019t create "${name}"`);
    return { ok: false, error: String(err) };
  }
  leftRail.addUserPattern(name, folder);
  if (openPattern) openPattern(name);
  else {
    setCurrentName(name);
    editor.setCode(code);
  }
  transport.setStatus(
    folder ? `created "${name}" in ${folder}` : `created "${name}"`,
  );
  return { ok: true };
}

// ─── New pattern ("+") button ─────────────────────────────────────────────
// Creates a user pattern in the store (dev and prod alike). Appears in the
// left rail synchronously, in the chosen folder. The dev "Save" toolbar
// button is the explicit gesture for promoting a buffer to a tracked file
// on disk — see saveNewPattern's block comment for the rationale.
//
// Uses a form modal with Name + Folder fields. The folder dropdown lists
// Unfiled, every user folder, and a "New folder…" affordance. The default
// selection is `lastNewPatternFolder` (if it still exists in `folders`),
// else Unfiled. On confirm, the chosen folder is fed back to the host via
// `onLastNewPatternFolderChange` so it can persist into `index.uiState`.
export async function handleNewPatternClick(ctx) {
  const {
    store,
    patterns,
    editor,
    leftRail,
    transport,
    setCurrentName,
    flushToStore,
    formModal,
    folders = [],
    lastNewPatternFolder = null,
    onLastNewPatternFolderChange,
    openPattern,
  } = ctx;
  // Flush current buffer before creating a new pattern.
  flushToStore();

  const folderOptions = [
    { value: "", label: "Unfiled" },
    ...folders.map((f) => ({ value: f, label: f })),
    { value: "__new__", label: "New folder…" },
  ];
  const defaultFolder =
    lastNewPatternFolder && folders.includes(lastNewPatternFolder)
      ? lastNewPatternFolder
      : "";

  const values = await formModal({
    title: "New pattern",
    fields: [
      {
        key: "name",
        label: "Name",
        type: "text",
        placeholder: "letters, numbers, - and _",
        defaultValue: makeUntitledName(store, patterns),
      },
      {
        key: "folder",
        label: "Folder",
        type: "select",
        options: folderOptions,
        defaultValue: defaultFolder,
      },
    ],
    confirmLabel: "Create",
    validate: (v) => {
      const errs = {};
      const nameErr = validatePatternName(v.name);
      if (nameErr) errs.name = nameErr;
      else if (patternNameExists(v.name, patterns, store)) {
        errs.name = `"${v.name}" already exists`;
      }
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
    name: values.name,
    code,
    folder,
    store,
    leftRail,
    setCurrentName,
    editor,
    transport,
    openPattern,
  });
  if (r.ok) onLastNewPatternFolderChange?.(folder);
}

// ─── Duplicate pattern (single) ──────────────────────────────────────────
// Source can be a user pattern or a Demo. Working copy code is used when
// present, else the original/shipped code. Duplicates always go to the
// store as user patterns — never to disk — so the chosen folder takes
// effect immediately and forks don't accumulate in patterns/ as new files.
/**
 * Open the Duplicate dialog for a single source pattern. Creates a user
 * pattern with the source's current code (working copy if any, else
 * original).
 */
export async function handleDuplicateClick({
  sourceName,
  preselectedFolder, // string | null | undefined
  store,
  patterns,
  editor,
  leftRail,
  transport,
  setCurrentName,
  flushToStore,
  formModal,
  folders,
  openPattern,
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
  const defaultFolder =
    preselectedFolder !== undefined ? preselectedFolder : sourceFolder;

  const folderOptions = [
    { value: "", label: "Unfiled" },
    ...folders.map((f) => ({ value: f, label: f })),
    { value: "__new__", label: "New folder…" },
  ];
  const values = await formModal({
    title: `Duplicate "${sourceName}"`,
    fields: [
      {
        key: "name",
        label: "Name",
        type: "text",
        defaultValue: makeCopyName(sourceName, store, patterns),
      },
      {
        key: "folder",
        label: "Folder",
        type: "select",
        options: folderOptions,
        defaultValue: defaultFolder ?? "",
      },
    ],
    confirmLabel: "Duplicate",
    validate: (v) => {
      const errs = {};
      const nameErr = validatePatternName(v.name);
      if (nameErr) errs.name = nameErr;
      else if (patternNameExists(v.name, patterns, store)) {
        errs.name = `"${v.name}" already exists`;
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

  await saveNewPattern({
    name: values.name,
    code: sourceCode,
    folder,
    store,
    leftRail,
    setCurrentName,
    editor,
    transport,
    openPattern,
  });
}

// ─── Duplicate pattern (bulk) ────────────────────────────────────────────
// One modal with N name inputs (one per source) plus one shared folder
// dropdown. Names pre-fill with `-copy` (collision-resolved against the
// existing index). Same store-only invariant as the single-duplicate path.
/**
 * Open the Duplicate dialog for multiple source patterns at once. Each
 * source becomes a new user pattern under the chosen folder. Validation
 * catches name collisions both against the existing index and within the
 * batch itself (so two inputs can't share the same target name).
 */
export async function handleBulkDuplicateClick({
  sourceNames,
  store,
  patterns,
  editor,
  leftRail,
  transport,
  setCurrentName,
  flushToStore,
  formModal,
  folders,
  openPattern,
}) {
  flushToStore();

  // Per-source target names: pre-filled with -copy (collision-resolved).
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
    key: "folder",
    label: "Folder for all",
    type: "select",
    options: folderOptions,
    defaultValue: "",
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
        else if (patternNameExists(candidate, patterns, store)) {
          errs[k] = `"${candidate}" already exists`;
        } else if (seenNames.has(candidate)) {
          errs[k] = `duplicate name "${candidate}" in this batch`;
        }
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
      name: target,
      code,
      folder,
      store,
      leftRail,
      setCurrentName,
      editor,
      transport,
      openPattern,
    });
    if (r.ok) n++;
  }
  transport.setStatus(
    folder
      ? `Duplicated ${n} pattern${n === 1 ? "" : "s"} into ${folder}`
      : `Duplicated ${n} pattern${n === 1 ? "" : "s"}`,
  );
}

function makeCopyName(sourceName, store, patterns) {
  const base = `${sourceName}-copy`;
  if (!patternNameExists(base, patterns, store)) return base;
  let n = 2;
  while (patternNameExists(`${sourceName}-copy-${n}`, patterns, store)) n++;
  return `${sourceName}-copy-${n}`;
}

// Default-name suggestion for the "+ pattern" dialog. Picks the first
// unused name in the "untitled", "untitled-2", "untitled-3", … sequence
// so the placeholder is something the user can actually leave as-is
// without colliding. Beats a base36 timestamp ("untitled-mo04bd7h")
// which reads as a bug to most people.
function makeUntitledName(store, patterns) {
  if (!patternNameExists("untitled", patterns, store)) return "untitled";
  let n = 2;
  while (patternNameExists(`untitled-${n}`, patterns, store)) n++;
  return `untitled-${n}`;
}

/**
 * Open the "New folder" form modal as a follow-up step inside the new-pattern
 * flow. Resolves to the new folder name (after appending it to
 * `index.folders`), or null if the user cancels.
 */
async function promptForNewFolderName(formModal, store) {
  const idx = store.getIndex();
  const existing = idx.folders ?? [];
  const v = await formModal({
    title: "New folder",
    fields: [
      {
        key: "name",
        label: "Folder name",
        type: "text",
        placeholder: "e.g. Jazz Sessions",
      },
    ],
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
