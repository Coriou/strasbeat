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
  const declaredFolders = new Set(data.folders.map((f) => f.toLowerCase()));
  for (const [name, rec] of Object.entries(data.patterns)) {
    if (!NAME_RE.test(name)) return { ok: false, error: `invalid pattern name: "${name}"` };
    if (typeof rec !== "object" || rec == null) return { ok: false, error: `pattern "${name}" is not an object` };
    if (typeof rec.code !== "string") return { ok: false, error: `pattern "${name}" is missing code` };
    if (typeof rec.modified !== "string") return { ok: false, error: `pattern "${name}" is missing modified date` };
    if (typeof rec.isUserPattern !== "boolean") return { ok: false, error: `pattern "${name}" is missing isUserPattern flag` };
    if (rec.folder !== undefined) {
      if (typeof rec.folder !== "string") return { ok: false, error: `pattern "${name}" has non-string folder` };
      if (!declaredFolders.has(rec.folder.toLowerCase())) {
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
