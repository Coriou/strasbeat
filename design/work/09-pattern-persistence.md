# 09 — Pattern persistence

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. Then read this whole file. Phases are ordered — each one
> ships on its own and the next phase assumes the previous is landed.

## Where this came from

strasbeat currently has no autosave and no working-copy concept. The
editor buffer lives in memory only. Every one of these loses work:

- **Reload the page** → original pattern reloads from disk/glob, edits gone.
- **Switch patterns in the left rail** → editor is overwritten, no
  confirmation, no way back.
- **Close the tab** → same as reload.
- **Prod (Vercel)** → no `/api/save`, only a manual share-link. If the
  user forgets to click Share, the work is gone.

This is the single biggest quality-of-life gap in the daily-driver
workflow. Every other DAW-like tool autosaves relentlessly — Logic, Ableton,
even browser-based ones like strudel.cc's REPL (which persists to
localStorage). strasbeat should too.

## Goal

Every edit the user makes is automatically persisted to the browser.
Switching patterns, refreshing, closing the tab, and reopening hours
later all restore exactly where the user left off. Original (shipped)
patterns are always recoverable — the user can never "ruin" a built-in
pattern permanently. User-created patterns (new compositions, MIDI
captures) are first-class citizens that live alongside the shipped ones.

## Design principles

1. **Zero-effort persistence.** The user should never have to think about
   saving. Every keystroke (debounced) writes to the store. There is no
   "save" action for working copies — it's always happening.
2. **Originals are sacred.** The shipped `patterns/*.js` files are the
   "factory presets". The user's edits layer on top as working copies.
   Reverting to the original is always one action away.
3. **Offline-first, local-first.** The store is localStorage today. No
   network dependency, no accounts, no sync. Works on an airplane.
4. **Migration-ready.** The storage layer is a thin abstraction so that a
   future phase can swap localStorage for an API-backed store (user
   accounts, cloud sync) without rewriting the UI or the autosave logic.
   The rest of the app talks to the store through a small interface, not
   directly to `localStorage`.
5. **No over-engineering.** No version history, no conflict resolution, no
   multi-device merge. Git is the version history for shipped patterns.
   The share link is the "send it somewhere" mechanism. localStorage is
   per-browser and that's fine for a daily-driver.

## Concepts

| Term             | Meaning                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original**     | The pattern code as shipped in `patterns/*.js` (from git / the Vite bundle). Immutable from the browser's perspective.                                                                                              |
| **Working copy** | The user's current version of a pattern, persisted to the store. Created automatically on first edit. Survives reload, tab close, pattern switching.                                                                |
| **User pattern** | A pattern the user creates from scratch (new button, MIDI capture, or paste). Has no original to diff against. Lives only in the store.                                                                             |
| **Dirty**        | A pattern whose working copy differs from its original. User patterns are always "dirty" in the sense that they have unsaved-to-disk state, but they don't show the modified dot (there's nothing to diff against). |
| **Store**        | The persistence backend. Phase 1 = localStorage. Future = API. The app never calls `localStorage` directly — it goes through the store interface.                                                                   |

## Storage layer

### Interface

```ts
interface PatternStore {
  /** Return the working copy for `name`, or null if none exists. */
  get(name: string): PatternRecord | null;

  /** Write a working copy. Called on every debounced edit. */
  set(name: string, record: PatternRecord): void;

  /** Delete a working copy (revert to original) or a user pattern. */
  delete(name: string): void;

  /** List all names that have working copies or are user patterns. */
  keys(): string[];

  /** Return the store index (last-open pattern, user pattern list). */
  getIndex(): StoreIndex;

  /** Update the store index. */
  setIndex(index: StoreIndex): void;
}

interface PatternRecord {
  /** The pattern code (the Strudel string). */
  code: string;
  /** ISO 8601 timestamp of the last edit. */
  modified: string;
  /** True if this is a user-created pattern (no shipped original). */
  isUserPattern: boolean;
}

interface StoreIndex {
  /** Name of the last-open pattern (restored on boot). */
  lastOpen: string | null;
  /** Ordered list of user-created pattern names. */
  userPatterns: string[];
}
```

This interface is deliberately minimal. A future API-backed store
implements the same shape — `get`/`set`/`delete`/`keys`/`getIndex`/
`setIndex` — but talks to a server instead of localStorage. The UI and
autosave logic don't change.

### localStorage schema (Phase 1)

```
Key                                → Value (JSON)
─────────────────────────────────────────────────────────────
strasbeat:pattern:<name>           → PatternRecord
strasbeat:pattern-index            → StoreIndex
```

Keys are namespaced to avoid collision with existing `strasbeat:accent`
and `strasbeat:right-rail` entries. Pattern names are already validated
to `/^[a-z0-9_-]+$/i` by the save modal, so they're safe as key
suffixes.

### Size budget

A typical pattern is 200–2000 bytes. At 1 KB average, localStorage's
5 MB budget holds ~5000 patterns — effectively unlimited for a personal
tool. The store should log a warning to the console if a `set()` call
throws a `QuotaExceededError`, and surface it in the transport status
bar so the user knows.

### Future: API-backed store

When user accounts land, the store interface gets a second implementation
that `POST`s/`GET`s to an API. The swap is:

```js
// Phase 1
const store = createLocalStore();

// Phase N (accounts)
const store = user.isLoggedIn ? createApiStore(user.token) : createLocalStore();
```

The migration path for existing localStorage data: on first login, the
client reads all `strasbeat:pattern:*` keys, uploads them to the API as
the user's initial library, and clears the local keys. This is a one-time
operation and doesn't need to be built now — just don't paint yourself
into a corner that makes it impossible.

---

## Phase 1: Autosave + working copies

This is the core. Ship this and the "lose work" problem is solved.

### Boot sequence (updated)

```
1. Discover shipped patterns via import.meta.glob (unchanged)
2. Create the store instance (new)
3. Read store index → restore lastOpen pattern name
4. For the initial pattern:
   a. If URL has #code=... → use that (share links override, unchanged)
   b. Else if store has a working copy for lastOpen → use that
   c. Else if lastOpen is in shipped patterns → use the original
   d. Else → first shipped pattern (fallback, unchanged)
5. Boot StrudelMirror with the resolved code
6. Mount left rail with merged pattern list (shipped + user patterns)
```

### Autosave

- **Trigger:** CodeMirror `updateListener` (already exists for the piano
  roll). On every document change, debounce 1000 ms, then write to store.
- **What's written:** `store.set(currentName, { code, modified, isUserPattern })`.
- **When switching patterns:** flush the current buffer to the store
  immediately (no debounce) before loading the next pattern. This closes
  the "switch fast and lose the last second of typing" gap.
- **On `beforeunload`:** flush once more (synchronous `localStorage`
  write is fine in `beforeunload`). Belt and suspenders.
- **The debounce timer is per-session, not per-pattern.** Switching
  patterns cancels the pending debounce and does an immediate flush.

### Pattern switching (updated)

```
1. Flush current buffer to store (immediate)
2. Update store index: lastOpen = newName
3. Load new pattern:
   a. If store has working copy → use that
   b. Else if shipped original exists → use that
   c. Else → shouldn't happen (pattern was in the list)
4. editor.setCode(resolved code)
5. Update left rail highlight + dirty state
```

### Left rail changes

The left rail currently shows only shipped patterns. It needs to:

1. **Show user patterns.** Below the shipped patterns, under a subtle
   "My patterns" divider. User patterns are sorted by `modified` (most
   recent first). If there are no user patterns, the divider is hidden.
2. **Show the modified dot.** A small accent-colored dot (6×6px, centered
   vertically) on the right edge of any shipped pattern whose working copy
   differs from the original. Semantics: "you've changed this one". The
   dot is the same accent color as the rest of the chrome.
3. **Revert action.** Right-click (or long-press on touch) on a shipped
   pattern with a working copy → context menu with "Revert to original".
   Clicking it: `store.delete(name)`, reload the original into the editor
   if it's the current pattern, remove the modified dot.
4. **Delete action.** Right-click on a user pattern → "Delete pattern".
   Confirm modal ("Delete 'my-tune'? This can't be undone."). On confirm:
   `store.delete(name)`, remove from `store.getIndex().userPatterns`, if
   it was the current pattern switch to the first shipped pattern.
5. **New pattern button** (already exists in dev mode) → also available
   in prod. Creates a user pattern in the store. The prompt dialog is
   unchanged (validate name, etc.). The difference is it writes to the
   store instead of `POST /api/save`.

### Dev-mode save button

Still works as before (writes to disk via `/api/save`). After a
successful disk save, **clear the working copy from the store** — the
disk file is now the canonical version, so the working copy is redundant.
Next reload, the glob picks up the updated file and the cycle continues.

### Share button

Unchanged in behavior. Encodes `editor.code` (which is the working copy)
into the URL hash. The share link is still the "send it somewhere"
mechanism, orthogonal to local persistence.

### MIDI capture

When capture completes, the resulting code is:

- In dev: saved to disk via `/api/save` (unchanged) + cleared from store.
- In prod: created as a user pattern via `store.set(name, ...)` +
  appended to `store.getIndex().userPatterns`. Shows up in the left rail
  under "My patterns" immediately.

### Transport status messages

Update the status bar messages to reflect the new persistence:

| Event                | Status message                                   |
| -------------------- | ------------------------------------------------ |
| Autosave fires       | _(no message — silent, like a real IDE)_         |
| Revert to original   | `reverted "05-dub" to original`                  |
| Delete user pattern  | `deleted "my-tune"`                              |
| Store quota exceeded | `⚠ couldn't save — browser storage full`         |
| Working copy loaded  | `restored your edits to "05-dub"` (only on boot) |

---

## Phase 2: Dirty-state diffing and visual feedback

Phase 1 persists everything but doesn't tell the user _what_ has changed
relative to the originals. Phase 2 adds awareness.

### Modified dot logic

The left rail's modified dot requires comparing the working copy to the
original. This is just `store.get(name)?.code !== patterns[name]`. It's
cheap (string equality, not a diff algorithm) and can be computed:

- On mount (for every shipped pattern that has a working copy).
- After autosave fires (for the current pattern only).
- After revert (clears the dot).

No deep diff, no line-by-line comparison. The dot answers "have you
touched this?" — not "what did you change?".

### Revert confirmation

When the user clicks "Revert to original", show a confirmation modal:

> **Revert to original?**
>
> Your changes to "05-dub" will be lost. This can't be undone.
>
> [Cancel] [Revert]

The modal uses the existing `modal.js` confirm flow.

### "Show diff" (stretch)

If there's appetite: a read-only diff view (original on left, working
copy on right) before reverting. This is a nice-to-have, not a
requirement. CodeMirror 6 has a `@codemirror/merge` package that does
exactly this. Could be a future right-rail panel tab.

---

## Phase 3: User accounts and cloud persistence

> **Not built now.** This section exists so Phase 1 and 2 don't paint
> us into a corner.

When user accounts arrive, the persistence story upgrades:

1. **API-backed store.** The `PatternStore` interface gets a second
   implementation that talks to a server. The UI doesn't change.
2. **Migration.** On first login, localStorage patterns are uploaded to
   the user's account, then local keys are cleared. A "merge" strategy
   (server wins, client wins, or manual) is needed if the user already
   has server-side patterns — but that's a Phase 3 design decision.
3. **Multi-device.** With an API store, patterns sync across browsers.
   Conflict resolution policy TBD (last-write-wins is probably fine for
   a personal tool; collaborative editing is out of scope).
4. **Sharing upgrades.** Instead of a `#code=...` URL (which bloats with
   long patterns), a share link becomes a short URL pointing to a
   server-stored snapshot. The share button's behavior changes but its
   position and UX don't.

The key invariant that makes this work: **the app talks to the store
interface, not to localStorage directly.** As long as Phase 1 respects
that, Phase 3 is a backend addition, not a rewrite.

---

## Files touched

| File                       | What changes                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/store.js`             | **New.** The `PatternStore` interface + `createLocalStore()` implementation.                                                                                                                              |
| `src/main.js`              | Boot sequence uses the store. Autosave wiring (updateListener + debounce + beforeunload). Pattern-switching flush logic. Save button clears store after disk write. Capture flow writes to store in prod. |
| `src/ui/left-rail.js`      | Accepts `userPatterns` list + `dirtySet` (Set of names with working copies). Renders "My patterns" section, modified dots, context menu (revert / delete).                                                |
| `src/styles/left-rail.css` | Modified dot style, "My patterns" divider style, context menu styles.                                                                                                                                     |

### Files NOT touched

- `vite.config.js` — the `/api/save` middleware is unchanged.
- `patterns/*.js` — shipped patterns are read-only from the browser.
- `src/midi-bridge.js` — capture output is handled in `main.js`.
- `index.html` — no new DOM elements needed (left rail is already
  dynamically mounted).

## Out of scope

- **Version history / changelog per pattern.** Git handles this for
  shipped patterns. User patterns are ephemeral sketches — if the user
  wants history, they save to disk (dev) or commit.
- **Import / export of user patterns.** Useful but not urgent. Could be
  a future "Export library" button that downloads a zip of all user
  patterns.
- **IndexedDB.** localStorage is sufficient for text. If we ever store
  binary data (recordings, samples), we'd add an IndexedDB layer — but
  that's a different feature.
- **Undo across sessions.** CodeMirror's undo stack is in-memory and
  resets on reload. Persisting it is complex and low-value when the
  working copy itself is always saved.
- **Autosave indicator in the UI.** No spinning icon, no "saving..."
  text. The working copy is always saved. The absence of a "you have
  unsaved changes" warning _is_ the indicator. The modified dot on the
  left rail tells the user which patterns they've touched.

## Acceptance

### Phase 1

- [ ] Editing a pattern and refreshing the page restores the edits.
- [ ] Switching patterns and switching back restores edits to both.
- [ ] Closing the tab and reopening restores edits + last-open pattern.
- [ ] A user-created pattern (new button) appears in the left rail under
      "My patterns" and persists across reloads.
- [ ] MIDI capture in prod creates a user pattern that persists.
- [ ] Reverting a shipped pattern to its original works and clears the
      working copy from the store.
- [ ] Deleting a user pattern removes it from the left rail and the
      store.
- [ ] The dev-mode save button still writes to disk and clears the
      store entry.
- [ ] `store.js` is a clean module with the `PatternStore` interface
      and `createLocalStore()` — no direct `localStorage` calls
      elsewhere.
- [ ] Share links still work (encode current buffer, decode on load).

### Phase 2

- [ ] Modified dot appears on shipped patterns with working copies.
- [ ] Dot disappears on revert.
- [ ] Revert shows a confirmation modal.
- [ ] Dot updates live as the user types (after debounced autosave).
