# 24 — Pattern folders

> Read `../README.md`, `../SYSTEM.md`, `../../CLAUDE.md`, and
> `09-pattern-persistence.md` before starting. This spec extends spec 09
> — autosave, working copies, and user patterns are assumed to be in
> place. Phases are ordered; each one ships on its own.

## Where this came from

Spec 09 gave us a place for the user's patterns to live across reloads.
The library is now flat: shipped Demos at the top, "My patterns" below.
At a handful of patterns this is fine. Past 20 it gets hard to find
anything, and patterns the user is no longer working on clutter the
view they use every day.

What's missing for a daily-driver music tool:

- **Organization** — group patterns by project, mood, or status.
- **Rename** — `untitled-mo04bd7h` is fine as a placeholder, useless as
  a name. The current UX has no way to rename a user pattern.
- **Move** — once organized, patterns need to flow between groups.
- **Duplicate** — fork a Demo (or any pattern) to make your own
  version. Today, "modify a Demo and a working copy is implied" is
  too magical; "duplicate this" is the obvious gesture.
- **Bulk operations** — the first time a user organizes a backlog of
  20+ patterns, doing it one row at a time is brutal.
- **Backup / portability** — patterns live in browser storage with no
  account and no cloud sync. The user needs an escape hatch: a way to
  export everything to a file and restore it elsewhere.

## Goal

Patterns can be organized into user-defined, flat (single-level)
folders. The shipped Demos appear as a fixed, read-only "Demos" folder
at the top of the rail. User patterns live in folders the user
creates, or remain "Unfiled". Renaming, moving, duplicating, and bulk
operations all feel like first-class IDE/DAW gestures. The whole
library can be exported to and restored from a single JSON file.

## Design principles

1. **Folders are organization, not identity.** A pattern's name is its
   identity — globally unique, the localStorage key, the URL share
   target. A folder is metadata layered on top. Moving a pattern
   between folders never changes its name. This keeps spec 09's data
   model intact: one record per pattern, addressed by name.

2. **Demos are sacred, plural form.** Demos can't be renamed, moved
   out, deleted, or have user patterns dropped in. They are reference
   material. The "modified dot + Revert" affordance from spec 09
   stays. To make your own version, you Duplicate.

3. **Spatial first, menu second.** Drag-and-drop is the primary
   gesture for moving patterns between folders. The context menu is a
   complete alternative (and the only path for keyboard-only and bulk
   moves to nested submenu items).

4. **The rail is one scrollable view.** No drill-in, no breadcrumbs,
   no separate folder pane. Folders are inline, collapsible sections.
   Search collapses the hierarchy into a flat result list and the user
   never loses their place when they clear it.

5. **Local-first, single-user, no cloud.** Same as spec 09: pure
   localStorage. The store interface is preserved so a future Phase 3
   (accounts, sync) can replace the backend without touching this
   UI work.

6. **Migration is implicit.** Existing users boot into the new build
   and see: a Demos folder (unchanged), an Unfiled section containing
   every user pattern they had, and zero user-created folders. They
   organize at leisure.

## Concepts

| Term         | Meaning                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder**   | A user-defined named container. Flat — folders cannot contain other folders.                                                                                                        |
| **Demos**    | A synthetic, fixed folder at the top of the rail containing every shipped `patterns/*.js`. Not a folder record. Read-only with respect to organization, collapsible like any other. |
| **Unfiled**  | A synthetic section at the bottom containing every user pattern whose record has no `folder` field. Hidden when empty. Always a valid drop target.                                  |
| **Duplicate**| The supported gesture for forking a pattern (Demo or user). Produces a new user pattern with the source's current code; user picks the name and folder.                             |
| **Rename**   | Change a user pattern's name. Updates the localStorage key, the index, and `lastOpen` if it pointed at the old name. Demos cannot be renamed.                                       |

## Data model

### Storage layer changes

`src/store.js` keeps the same interface. Only the record and index
shapes grow:

```ts
interface PatternRecord {
  code: string;
  modified: string;
  isUserPattern: boolean;
  folder?: string;   // NEW — missing = Unfiled, or N/A for Demo working copies
}

interface StoreIndex {
  lastOpen: string | null;
  userPatterns: string[];         // unchanged
  folders?: string[];             // NEW — user-defined folder names, display order
  uiState?: {
    collapsedFolders?: string[];  // NEW — persisted collapse state per folder name
    lastNewPatternFolder?: string | null;  // NEW — folder pre-selected in new-pattern dialog
  };
}
```

**Why name as foreign key, not folder ID:** simpler, human-readable in
`localStorage`, and rename is rare. The cost of rewriting up to N
records on a folder rename is fine at our scale (hundreds of patterns
max for a personal tool). If the library ever grows past that, the
store interface can swap to IDs without touching the UI.

**Demo working copies** never have a `folder`. They are always shown
under the Demos section of the rail. The `folder` field on a Demo
working copy record is ignored if present.

**Reserved folder names:** `Demos`, `Unfiled` (case-insensitive).
Validation rejects these with the message `"Demos" / "Unfiled" is
reserved`.

**The reserved collapse-state key** for the synthetic Demos section in
`uiState.collapsedFolders[]` is `__demos__` so it can't collide with a
user-created folder named "Demos" (which is also rejected by
validation, but the reserved key is belt-and-suspenders).

### Migration

No upgrade script. Records written by spec 09 have no `folder` field;
they appear in the Unfiled section. The `folders[]` array starts
empty. The user moves patterns into folders by creating folders and
dragging. Old behavior is preserved by default.

## Left rail UI

```
┌────────────────────────────┐
│ Patterns      + 📁  ⋯ ⟨    │
├────────────────────────────┤
│ 🔎 Search patterns…        │
├────────────────────────────┤
│ ▾ Demos             (24)   │   ← read-only, no ⋯, not a drop target
│    Hello                   │
│    Chords                  │
│    Progression Demo        │
│    Dub                  •  │   ← dirty dot still works on Demos
│    …                       │
│ ▾ Jazz             (3)  ⋯  │   ← user folder, hover-reveal ⋯
│    Comp Test               │
│    ii V I                  │
│    Late Night              │
│ ▸ Sketches         (7)  ⋯  │
│ ▸ Live             (2)  ⋯  │
│ ▾ Unfiled          (4)     │   ← synthetic, always last, no ⋯
│    untitled-mo04bd7h       │
│    …                       │
└────────────────────────────┘
```

### Header chrome

The existing rail header (`Patterns`, `+`, `≡`, collapse `⟨`) gains a
**New folder** action: a small folder-plus icon between `+` and the
import button. Order: collapse · "Patterns" title · spacer · `+
pattern` · `+ folder` · `≡ import MIDI`.

Clicking `+ folder` inserts an inline rename row at the top of the
user folder list with a focused text input. Enter creates the folder,
Esc cancels. The new folder appears expanded and selected.

### Folder rows

Each folder header is a single row:

- Chevron (▾/▸) at the left, click toggles collapse.
- Folder name + count `(N)`. The count is the total number of patterns
  in the folder; it does not change with the search query (folder
  headers are hidden during search anyway — see Search below).
- On hover (user folders only): a `⋯` button on the right edge that
  opens the folder context menu.
- Drop target: dropping a pattern onto a folder header (collapsed or
  expanded) or anywhere in its expanded body sets that pattern's
  `folder` to this folder.

### Spring-loaded folders

A collapsed folder header that's hovered for **500 ms during a drag**
auto-expands. The chevron animates to ▾, the body slides open, and the
drag continues unbroken. Mirrors macOS Finder.

### Empty-folder hint

An expanded folder with zero patterns (and no search filter) shows a
single faint row: `Drop patterns here`. The hint is not selectable.

### Unfiled section

Pinned to the bottom of the rail. Rendered only when at least one user
pattern has no `folder` field. Same row shape as any folder. No `⋯`
menu (can't be renamed or deleted — it's synthetic). Always a valid
drop target; dropping a pattern here clears its `folder` field.

### Demos section

Pinned to the top. Rendered from `import.meta.glob` exactly as today.
No `⋯` menu on the header. Collapsible (state persisted under
`__demos__`). Pattern rows inside Demos:

- Render exactly as today (pretty name, modified dot, Revert in
  context menu when dirty).
- Can be dragged, but **only to start a Duplicate** — see drag-and-drop
  below. Dropping a Demo onto a user folder offers a Duplicate, not a
  Move.

## Interactions

### Drag-and-drop (primary)

- Drag handle: any row. `cursor: grab` on hover, `cursor: grabbing`
  while dragging.
- Drag begins after a small threshold (4 px) so single clicks aren't
  confused with drags.
- Drag ghost: faint pill with the pattern's pretty name. If multiple
  rows are selected (see below), the ghost reads `N patterns`.
- Drop targets:
  - User folder header (expanded or collapsed) — moves the
    dragged pattern(s) into that folder.
  - User folder body — same.
  - Unfiled header/body — clears `folder` field(s).
  - **Demos header is not a drop target.** Hovering over it during a
    drag shows a red drop indicator and the drop is rejected.
- **Dragging a Demo into any user destination** (user folder or
  Unfiled) opens the Duplicate dialog with the target folder
  pre-selected. The original Demo is not moved. This is the only
  "drag-to-fork" path.
- **Hover-to-expand:** 500 ms hover over a collapsed user folder
  during a drag expands it. Cancels if the drag leaves.
- **Auto-scroll:** dragging within ~24 px of the rail's top or bottom
  scrolls the list.
- **Drop animation:** the row fades into place at its new home; the
  source position closes up. No bounce or spring needed.
- **Drag fires `flushToStore()`** before the move so the record being
  moved carries the latest code.

### Multi-select

- Cmd/Ctrl-click toggles a row's selection.
- Shift-click range-selects within the current visible list (i.e.,
  respects collapsed folders and search filters — only visible rows
  participate).
- Cmd/Ctrl-A selects all visible rows.
- Escape clears the selection.
- A plain click (no modifiers) clears selection and opens that
  pattern (today's behavior).
- Selected rows render with a faint accent-tinted background.
- Drag any selected row to drag the whole selection. The ghost reads
  `N patterns`. Drop applies the move to every selected pattern.
- Right-click on a selected row opens a bulk menu:
  - `Move N patterns to ▸` (submenu with folders + Unfiled + `New
    folder…`)
  - `Duplicate N patterns…` (opens a modal that lists each new name
    inline-editable, lets the user pick a single target folder for
    all; pre-fills `<source>-copy`, validates uniqueness across the
    set)
  - `Delete N patterns…` (destructive — confirm modal: "Delete N
    patterns? This can't be undone.")
- **Mixed selections** (some user patterns, some Demos) disable
  Delete and Rename. Move and Duplicate stay enabled — Demos in a
  Move are silently skipped (status: `Skipped 3 Demos — duplicate to
  customize`).

### Per-row context menu

Right-click on a pattern row (replaces today's hover-reveal `⋯` —
which we keep as a touch/accessibility surface):

User pattern:

- `Open`
- `Rename…`
- `Duplicate…`
- `Move to ▸` (folders + Unfiled + `New folder…`)
- `Delete` (destructive)

Demo (clean):

- `Open`
- `Duplicate…`

Demo (dirty — has a working copy):

- `Open`
- `Duplicate…`
- `Revert to original` (current behavior)

### Folder header context menu

User folder:

- `Rename folder…`
- `Delete folder…`

Demos / Unfiled: no menu.

### Keyboard

- Up/Down navigate rows across folder boundaries (folder headers are
  also navigable; Enter on a header toggles collapse).
- Left/Right on a folder header collapse/expand it.
- Enter on a pattern row opens it.
- Space toggles selection (when multi-select is active — i.e., when
  any row is already selected or when modifier was used).
- F2 on a user pattern row or user folder header enters inline
  rename.
- Cmd/Ctrl-D opens Duplicate for the focused/selected pattern(s).
- Cmd/Ctrl-Backspace deletes the focused/selected user pattern(s)
  with confirm.

## Search

The current substring search is replaced with a small fuzzy matcher in
`src/ui/fuzzy.js`:

- **Accent folding:** query and target normalized via
  `s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()`. "cafe"
  matches "Café", "voila" matches "voilà".
- **Subsequence + ranked.** Query tokens (whitespace-split) must each
  appear as a subsequence of the normalized target. Score per token:
  - Consecutive-char run bonus (run length squared).
  - Word-start bonus (a match starting at a word boundary scores
    higher than a match in the middle of a word).
  - Prefix bonus (a match starting at index 0 scores highest).
- **Match scope:** raw filename + pretty name + folder name. A query
  that matches a folder name lists every pattern in that folder.
  Folder-name-only hits rank below pattern-name hits.
- **Highlights:** the matcher returns the matched character indices
  per result. The row renders matched chars in the accent-underline
  span we already have (extended from contiguous substring to
  arbitrary index list).
- **Output:** when a query is active, the rail renders a flat list
  (folder headers hidden). Each row shows `<pretty name>` with a
  faint suffix `· <folder>` to keep folder context visible. Demos
  hits show `· Demos`.
- **Limits:** show at most 50 results; if more match, append a faint
  `+N more…` row that refines the search prompt rather than expanding
  (forces the user to type more, keeps the rail snappy).

The matcher is ~50 lines and has no dependencies. Performance is fine
for libraries of several hundred patterns — well within the budget
for a personal tool.

## Duplicate, rename, new-pattern dialogs

### Duplicate

A single modal (reuses `modal.js`):

```
┌─────────────────────────────────────┐
│ Duplicate "05-dub"                  │
├─────────────────────────────────────┤
│ Name:    05-dub-copy            ⓘ  │   ← validated as a normal pattern name
│ Folder:  ▾ Jazz                     │   ← dropdown: all folders + Unfiled + "New folder…"
│                                     │
│              [Cancel]   [Duplicate] │
└─────────────────────────────────────┘
```

- Name validates with the existing rules (`/^[a-z0-9_-]+$/i`) plus
  uniqueness across all stored names + Demo names.
- Folder defaults to the source's folder, or Unfiled if the source is
  a Demo.
- `New folder…` in the dropdown opens an inline input below the
  dropdown; on confirm, the folder is created (added to `folders[]`)
  and pre-selected.
- On confirm: write a new `PatternRecord` with the source's current
  code (working copy if it exists, else original), append to
  `userPatterns[]`, open the new pattern.

### Rename

User patterns and user folders only. Inline rename, no modal:

- Row's name becomes a contenteditable input on `F2`, double-click on
  the name, or `Rename…` from the context menu.
- Validation: name rules + uniqueness; folder names additionally
  forbid `Demos` and `Unfiled` and a length cap of 64 chars.
- Enter commits, Esc cancels. Invalid input shows a red outline and
  a small inline hint; doesn't commit.
- On rename of a pattern: rewrite the localStorage key, update
  `userPatterns[]`, update `lastOpen` if pointed at the old name,
  update any selection state.
- On rename of a folder: rewrite every pattern record where
  `folder === oldName`, update `folders[]`, update
  `uiState.collapsedFolders` if it referenced the old name.

### New pattern

The current name-only prompt is replaced with the Duplicate-shaped
modal but with the source-code fixed to the existing starter:

```js
`// ${name}\nsetcps(120/60/4)\n\nsound("bd ~ sd ~")\n`
```

Folder defaults to `uiState.lastNewPatternFolder` if set and still
exists, otherwise Unfiled. On confirm, that folder becomes the new
`lastNewPatternFolder`.

In dev mode the `/api/save` flow is preserved for the no-folder path
(the on-disk pattern lands as a Demo on next reload). If the user
picks a non-Unfiled folder in dev, the pattern still goes through
`/api/save` (so it's on disk) **and** the store records the chosen
folder so the rail shows it in that folder on the next reload. (In
other words: in dev, a "folder choice" survives because the store has
the folder metadata even though the code lives on disk.)

## Folder management

### Create

- `+ folder` toolbar button or `New folder…` option in any "Move to"
  / "Folder" dropdown.
- Inline input at top of user folder list (or in the dropdown).
- Validation: 1–64 chars, not `Demos` / `Unfiled`, unique
  case-insensitively.
- Appended to `folders[]` (preserves user-defined order).

### Rename

Inline (see Rename above).

### Delete

Right-click → `Delete folder…`:

- Empty folder: single confirm — "Delete folder 'Jazz'?" → on
  confirm, remove from `folders[]`.
- Non-empty folder: two-button modal:
  - **Move 3 patterns to Unfiled** (default, non-destructive).
  - **Delete folder and all 3 patterns** (destructive, red).
- On move-to-Unfiled: clear `folder` on each record, remove folder
  from `folders[]`.
- On delete-all: `store.delete(name)` for each pattern, remove from
  `userPatterns[]`, remove folder. If `lastOpen` was inside, fall
  back to the first Demo.

### Reorder (deferred)

Drag folder headers up/down to reorder. Spec'd as a follow-up; not a
blocker for initial ship. The data model already supports it
(`folders[]` is order-preserving).

## Library export / import (JSON)

Lives as a new "Library" section in `src/ui/settings-panel.js`,
below editor settings and above the About block.

### Format

`strasbeat-library-YYYY-MM-DD.json`:

```json
{
  "version": 1,
  "exportedAt": "2026-05-11T14:32:00.000Z",
  "folders": ["Jazz", "Sketches", "Live"],
  "patterns": {
    "comp-test": {
      "code": "...",
      "modified": "2026-05-10T18:11:00.000Z",
      "isUserPattern": true,
      "folder": "Jazz"
    },
    "05-dub": {
      "code": "...",
      "modified": "2026-05-09T10:02:00.000Z",
      "isUserPattern": false
    }
  }
}
```

- `version: 1` is the only version. A future bump gets a small
  migrator before parse.
- Includes user patterns and Demo working copies. Demo working copies
  have no `folder` field.
- Excludes Demos themselves (they're in git).

### Export

- "Export library" button in Library section. Disabled if there's
  nothing to export (no user patterns and no Demo working copies).
- On click: serialize, `Blob` + temp `<a download>`, trigger
  download. No extra deps.
- Status bar: `Exported N patterns`.

### Import

- "Import library…" button → native `<input type="file"
  accept=".json">`.
- Parse + shape-validate (`version === 1`, `folders: string[]`,
  `patterns: Record<string, PatternRecord>`).
- Bad file → modal: `Couldn't read library — expected a strasbeat
  library JSON file.`
- **Preview modal** before any writes:
  - `12 patterns across 3 folders will be imported.`
  - Conflicts (existing names): list up to 5 colliding names + radio
    choice **Skip** (default) / **Overwrite** / **Rename** (append
    `-imported`, `-imported-2`, …).
  - Demo working copies for demos not present in this build: list up
    to 5 + count, e.g. `2 modified demos won't be imported (their
    originals aren't in this build).`
  - `[Cancel] [Import]`
- On confirm:
  1. Merge folders: append any folder name from the import that
     doesn't already exist (case-insensitive), preserving the
     import's order for new folders.
  2. Per pattern: apply the conflict choice and write the record.
  3. Update `userPatterns[]` to include any newly imported user
     patterns.
- `QuotaExceededError` mid-import: abort, leave partial state
  intact, show modal "Storage full — imported X of Y patterns
  before stopping."
- Success status: `Imported N patterns into M folders`.

## Edge cases

- **Orphan folder reference.** A pattern record whose `folder` value
  is not in `index.folders[]`. Treat as Unfiled and log a console
  warning; offer "Restore folder X" in the future if helpful. Not a
  blocker for initial ship.
- **Folder in index with no patterns.** Render the folder normally.
  Empty-folder hint shows when expanded.
- **Renaming a pattern that's currently open.** Update `lastOpen`,
  `currentName`, the top-bar wordmark, and the rail's `setCurrent()`
  in one transition. The editor buffer doesn't reload (same code,
  new name).
- **Renaming a folder that contains the currently open pattern.**
  Update the open pattern's `folder` field, no UI surprise.
- **Deleting the currently open pattern (single or bulk).** Same as
  today: fall back to the first Demo, update `lastOpen`, set the
  editor buffer.
- **Deleting a folder that contains the open pattern, choosing
  "delete all".** Same fallback as above.
- **Drag while multi-select includes Demos and user patterns onto a
  user folder.** User patterns move; Demos are silently skipped with
  a status bar report. (The Duplicate flow is per-pattern and doesn't
  make sense as a "bulk" gesture mid-drag.)
- **Quota exceeded** on any write (autosave, rename, duplicate,
  import, folder operation): the existing pathway logs to console,
  surfaces `⚠ couldn't save — browser storage full` in the
  transport, and aborts the operation cleanly without partial state
  if possible.
- **Pattern name collision with a Demo.** Existing validation
  (`patternNameExists`) already checks this. Extended to also reject
  reserved folder names where relevant.
- **Search with zero results.** Today's behavior preserved: a single
  `No results for "<query>"` row.

## Files touched

| File                              | What changes                                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/store.js`                    | `PatternRecord.folder` field. `StoreIndex.folders`, `StoreIndex.uiState`. No interface changes — just shape additions. Adds small helpers: `getFolders()`, `setFolders()`, `renameFolderInRecords(old, new)`, `renamePatternKey(old, new)`.                |
| `src/patterns.js`                 | `getUserPatternNames()` grows a sibling `groupUserPatternsByFolder(store)` that returns `{ folders: { name → string[] }, unfiled: string[] }`. `saveNewPattern()` accepts a `folder` argument and writes it to the record. `validatePatternName` unchanged. |
| `src/ui/left-rail.js`             | Big rewrite. Mounts folder sections instead of one flat list. New props: `folders`, `groupedUserPatterns`, `collapsedFolders`, `onCreateFolder`, `onRenameFolder`, `onDeleteFolder`, `onMoveTo`, `onDuplicate`, `onRenamePattern`, `onSelectionChange`. Handles drag, multi-select, inline rename, spring-load. |
| `src/ui/fuzzy.js`                 | **New.** Accent-folding fuzzy matcher with consecutive/word-start/prefix scoring. Returns `{ score, matches: number[] }` per candidate. ~50 lines + a small unit-test file.                                                                                |
| `src/ui/modal.js`                 | Add support for a generic "form" modal shape with a name input + a folder dropdown (or arbitrary fields). Used by Duplicate / New pattern. Keep the existing prompt/confirm helpers for now.                                                              |
| `src/ui/settings-panel.js`        | New "Library" section with Export / Import buttons. Wires to the export/import helpers.                                                                                                                                                                   |
| `src/library-io.js`               | **New.** `exportLibrary(store)` → `Blob`. `importLibrary(file, store, opts)` → `{ imported, skipped, conflicts, error? }`. Handles the preview shape too: `previewImport(file, store)` → `{ folders, patterns, conflicts, untransferableDemos }`.        |
| `src/main.js`                     | Wire all the new rail callbacks. Pass the grouped pattern lists. Hook up `+folder` button, multi-select selection state, Duplicate flow. Pre-flight `flushToStore()` before drag commits. Settings panel mount gains the library export/import wiring.    |
| `src/styles/left-rail.css`        | Folder header styles, drop-target highlight, drag ghost, multi-select highlight, empty-folder hint, "+N more" row in search.                                                                                                                              |

### Files NOT touched

- `vite.config.js` — `/api/save` middleware is unchanged.
- `patterns/*.js` — Demo files remain read-only from the browser.
- `src/midi-bridge.js` — capture flow unchanged (still produces a
  user pattern via `saveNewPattern`).
- `src/share.js` — share links continue to encode the current
  buffer; folder metadata isn't part of the share URL.

## Out of scope

- **Nested folders.** Flat single-level only. The data model leaves
  room (a future `parent` field on a folder), but no UI for it.
- **Tags / multi-folder membership.** A pattern is in exactly one
  folder (or Unfiled).
- **Pinned / Recently modified sections.** Considered and skipped.
- **Storage quota indicator.** Considered and skipped. The existing
  `QuotaExceededError` flow is enough for now.
- **Per-folder sort options.** Patterns within a folder are sorted by
  `modified` desc (most recent first). Demos are sorted by filename
  ascending (as today). No user-configurable sort.
- **Drag-to-reorder folder headers.** Deferred; data model supports
  it.
- **Cloud sync / accounts.** Spec 09 Phase 3 territory.
- **Sharing a folder via URL.** Share is still pattern-level.
- **Importing Demos from an export.** Demos are git-tracked.
- **Undoing a delete.** Same as today — confirm modal is the safety
  net. No trash, no undo stack.
- **Renaming Demos.** Read-only.

## Acceptance

### Core (must ship together)

- [ ] Existing user patterns appear in an "Unfiled" section after
      upgrade; nothing is lost.
- [ ] The user can create a folder, rename it, and delete it.
      Deleting a non-empty folder offers "move to Unfiled" or
      "delete all".
- [ ] The user can drag a user pattern between folders, into
      Unfiled, and from Unfiled into a folder. The change persists
      across reload.
- [ ] Dropping a pattern onto a collapsed folder header expands it
      after a 500 ms hover (spring-loaded).
- [ ] Dropping onto Demos is rejected with a visible cue.
- [ ] Dragging a Demo onto a user folder opens the Duplicate dialog
      with that folder pre-selected. The original Demo doesn't move.
- [ ] Cmd/Ctrl-click and Shift-click select multiple rows. Drag of a
      selected row moves all selected. Right-click on a selected row
      shows bulk actions (Move to ▸, Duplicate, Delete).
- [ ] Multi-select Delete confirms and deletes user patterns only;
      Demos in the selection are silently skipped.
- [ ] The Duplicate dialog creates a user pattern with the source's
      current code, in the chosen folder, with a unique name.
- [ ] Renaming a user pattern (F2 or context menu) updates the
      localStorage key, the index, and `lastOpen` if applicable.
- [ ] Renaming a folder rewrites every pattern record whose
      `folder === oldName`; collapse state and `lastNewPatternFolder`
      follow the rename.
- [ ] Folder collapse state persists across reload.
- [ ] The `+ folder` toolbar button creates a folder with inline
      naming.
- [ ] The new-pattern dialog now includes a folder dropdown that
      defaults to the last-used folder.
- [ ] Search uses fuzzy matching with accent folding ("cafe" matches
      "Café"). Results show as a flat list with folder context shown
      faintly. Folder name hits surface all matching patterns.
- [ ] When the search box is empty, the rail returns to the folder
      view exactly where the user left off (collapsed state
      preserved).
- [ ] Library export downloads a JSON file with the documented
      shape. Import previews changes, handles conflicts (skip /
      overwrite / rename), and writes successfully.
- [ ] `QuotaExceededError` during any operation surfaces the
      existing transport warning and aborts cleanly.

### Stretch (nice-to-have, can land later)

- [ ] Drag-to-reorder folder headers.
- [ ] "Restore folder" action for orphan-folder pattern records.
- [ ] Folder-level color or emoji accent (purely cosmetic).

## Open questions

None at spec time. The design has chosen the foundational pivots
(flat folders, Demos read-only, name-as-FK, drag-primary,
multi-select first-class, JSON export). If any of these change later,
it's a new spec, not a patch.
