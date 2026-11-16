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
  const entries = [];
  for (const name of store.keys()) {
    const rec = store.get(name);
    if (!rec) continue;
    const out = { code: rec.code, modified: rec.modified, isUserPattern: !!rec.isUserPattern };
    if (rec.isUserPattern && typeof rec.folder === "string") out.folder = rec.folder;
    entries.push([name, out]);
  }
  // (fromEntries, not `patterns[name] = out`: a pattern may be named
  // "__proto__", and assigning that key would set the object's prototype
  // instead of adding the pattern)
  const patterns = Object.fromEntries(entries);
  return {
    version: EXPORT_VERSION,
    exportedAt: now().toISOString(),
    folders,
    patterns,
  };
}

// localStorage keys we'll be writing — accept the same shape validatePatternName
// enforces on the in-app paths so a malicious or corrupted file can't write a
// key with surprising characters that the rest of the app won't be able to
// address. Folder names share the rules of validateFolderName (1..64 chars,
// non-empty after trim, not reserved).
const NAME_RE = /^[a-z0-9_-]+$/i;
const FOLDER_MAX = 64;
const RESERVED_FOLDERS_LOWER = new Set(["demos", "unfiled"]);

export function parseImportJson(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { return { ok: false, error: `Couldn't parse JSON: ${e.message}` }; }
  if (typeof data !== "object" || data == null) return { ok: false, error: "Top-level value must be an object" };
  if (data.version !== EXPORT_VERSION) return { ok: false, error: `Unsupported library version: ${data.version}` };
  if (!Array.isArray(data.folders)) return { ok: false, error: "folders must be an array" };
  for (const f of data.folders) {
    if (typeof f !== "string") return { ok: false, error: "folders must be an array of strings" };
    const trimmed = f.trim();
    if (!trimmed) return { ok: false, error: "folder names can't be empty" };
    if (trimmed.length > FOLDER_MAX) return { ok: false, error: `folder name too long: "${trimmed.slice(0, 24)}…"` };
    if (RESERVED_FOLDERS_LOWER.has(trimmed.toLowerCase())) {
      return { ok: false, error: `reserved folder name in import: "${trimmed}"` };
    }
  }
  if (typeof data.patterns !== "object" || Array.isArray(data.patterns) || data.patterns == null) {
    return { ok: false, error: "patterns must be an object" };
  }
  const declaredFolders = new Set(data.folders.map((f) => f.trim().toLowerCase()));
  for (const [name, rec] of Object.entries(data.patterns)) {
    if (!NAME_RE.test(name)) return { ok: false, error: `invalid pattern name: "${name}"` };
    if (typeof rec !== "object" || rec == null) return { ok: false, error: `pattern "${name}" is not an object` };
    if (typeof rec.code !== "string") return { ok: false, error: `pattern "${name}" is missing code` };
    if (typeof rec.modified !== "string") return { ok: false, error: `pattern "${name}" is missing modified date` };
    if (typeof rec.isUserPattern !== "boolean") return { ok: false, error: `pattern "${name}" is missing isUserPattern flag` };
    if (rec.folder !== undefined) {
      if (typeof rec.folder !== "string") return { ok: false, error: `pattern "${name}" has non-string folder` };
      if (!declaredFolders.has(rec.folder.trim().toLowerCase())) {
        // Orphan folder references in the import (folder not declared in
        // the top-level folders[]) get silently demoted to Unfiled by
        // applyImport via groupUserPatternsByFolder's same rule. Strip the
        // field here so the contract is consistent.
        delete rec.folder;
      }
    }
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
      // A shipped pattern of the same name is a conflict too: the app tells
      // user patterns from Demos by name alone, so the two can't coexist.
      const exists = store.get(name) != null || shippedDemos.has(name);
      if (exists) conflicts.push(name);
      else newUserPatterns.push(name);
    } else {
      if (shippedDemos.has(name)) {
        transferable.push(name);
        // The user's own edits to that Demo would be replaced.
        if (demoCopyConflicts(name, rec, store)) conflicts.push(name);
      } else untransferable.push(name);
    }
  }
  return {
    newFolders,
    conflicts,
    newUserPatterns,
    demoWorkingCopies: { transferable, untransferable },
  };
}

// An incoming Demo working copy conflicts when this browser already holds
// edits to the same Demo and they differ: importing would replace them.
function demoCopyConflicts(name, rec, store) {
  const local = store.get(name);
  return local != null && typeof local.code === "string" && local.code !== rec.code;
}

export function applyImport(payload, store, { conflictStrategy, shippedDemos }) {
  let imported = 0;
  let skipped = 0;
  const renamed = [];
  // Every name written, so the caller can refresh tabs showing those patterns.
  const written = [];
  // Records that did not exist before this import — what to undo if the index
  // can't be committed.
  const created = [];
  const idx = store.getIndex();
  const total = Object.keys(payload.patterns).length;

  // 1) Merge folders. Matching is case-insensitive, so every incoming folder
  //    resolves to ONE canonical spelling (the local one when it already
  //    exists) and records are filed under that spelling — the rail groups by
  //    exact string, and a record saying "jazz" next to a folder "Jazz" would
  //    silently fall to Unfiled.
  const folders = (idx.folders ?? []).slice();
  const canonicalFolder = new Map(folders.map((f) => [f.toLowerCase(), f]));
  for (const raw of payload.folders) {
    const f = raw.trim();
    if (!canonicalFolder.has(f.toLowerCase())) {
      folders.push(f);
      canonicalFolder.set(f.toLowerCase(), f);
    }
  }
  const userPatterns = (idx.userPatterns ?? []).slice();

  const writeUser = (name, rec) => {
    const isNew = store.get(name) == null;
    const out = { code: rec.code, modified: rec.modified, isUserPattern: true };
    if (typeof rec.folder === "string") {
      const folder = canonicalFolder.get(rec.folder.trim().toLowerCase());
      if (folder) out.folder = folder;
    }
    if (store.set(name, out) === false) throw new Error("browser storage refused the write");
    if (isNew) created.push(name);
    if (!userPatterns.includes(name)) userPatterns.push(name);
    written.push(name);
    imported++;
  };

  let error = null;
  try {
    // 2) Write patterns.
    for (const [name, rec] of Object.entries(payload.patterns)) {
      if (rec.isUserPattern) {
        const shipped = shippedDemos.has(name);
        if (shipped || store.get(name) != null) {
          if (conflictStrategy === "skip") { skipped++; continue; }
          // A Demo can't be overwritten by a user pattern, so "overwrite"
          // falls back to renaming for that one case.
          if (conflictStrategy === "rename" || shipped) {
            const newName = makeRenamedName(name, store, shippedDemos);
            writeUser(newName, rec);
            renamed.push({ from: name, to: newName });
            continue;
          }
          // overwrite
        }
        writeUser(name, rec);
      } else {
        // Demo working copy.
        if (!shippedDemos.has(name)) { skipped++; continue; }
        // Local edits to this Demo are a conflict like any other: kept on
        // "skip", kept next to the import (as a user pattern) on "rename".
        if (demoCopyConflicts(name, rec, store)) {
          if (conflictStrategy === "skip") { skipped++; continue; }
          if (conflictStrategy === "rename") {
            const newName = makeRenamedName(name, store, shippedDemos);
            writeUser(newName, rec);
            renamed.push({ from: name, to: newName });
            continue;
          }
          // overwrite
        }
        const out = { code: rec.code, modified: rec.modified, isUserPattern: false };
        if (store.set(name, out) === false) throw new Error("browser storage refused the write");
        written.push(name);
        imported++;
      }
    }
  } catch (err) {
    error = err;
  }

  // 3) Commit the index — also after a failure part-way through, so whatever
  //    did get written is listed in the library rather than stranded as
  //    invisible records eating the quota that just ran out.
  try {
    store.setIndex({ ...store.getIndex(), folders, userPatterns });
  } catch (err) {
    // Not even the index fits. Undo the records this import created; existing
    // ones that were overwritten stay as written (they are already listed).
    for (const name of created) store.delete(name);
    imported -= created.length;
    const gone = new Set(created);
    return {
      ok: false,
      imported,
      skipped,
      renamed: renamed.filter((r) => !gone.has(r.to)),
      written: written.filter((n) => !gone.has(n)),
      error: describeImportError(error ?? err, imported, total),
    };
  }

  if (error) {
    return { ok: false, imported, skipped, renamed, written, error: describeImportError(error, imported, total) };
  }
  return { ok: true, imported, skipped, renamed, written };
}

function describeImportError(err, imported, total) {
  const why = err?.name === "QuotaExceededError" ? "Storage full" : String(err?.message ?? err);
  return `${why} — imported ${imported} of ${total} patterns`;
}

function makeRenamedName(base, store, shippedDemos) {
  const taken = (n) => store.get(n) != null || shippedDemos.has(n);
  const candidate = `${base}-imported`;
  if (!taken(candidate)) return candidate;
  let n = 2;
  while (taken(`${base}-imported-${n}`)) n++;
  return `${base}-imported-${n}`;
}
