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
  setCurrentName(name);
  editor.setCode(code);
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
