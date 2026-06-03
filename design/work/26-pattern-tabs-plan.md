# Pattern Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Spec: `design/work/26-pattern-tabs.md`. Read it before starting — every design decision is settled there. Prior layers: `09-pattern-persistence.md` (store, autosave, dirty model) and `24-pattern-folders.md` (rail, `groupUserPatternsByFolder`, `refreshRail`, open-or-operate discipline) are already implemented on disk; read them too. Date: 2026-06-03.
>
> **Commits:** This project's convention is that **agents do not commit or push** ([per user preferences](../../CLAUDE.md)). Each task ends with a "Stop and report" step. The user reviews and commits manually. Suggested commit messages are included for the user's reference; don't run `git commit` from inside the agent.
>
> **Off-limits plumbing (SYSTEM.md §11 / spec "Files NOT touched"):** Do NOT edit `@strudel/*` imports, prebake/audio init (`boot.js`), `renderPatternToBuffer`/WAV export (`export.js`), `MidiBridge` setup + capture handler (`midi-bridge.js`, `capture.js`), `import.meta.glob` of `/patterns`, share encode/decode internals (`share.js`), `window.*` exports, `vite.config.js` middleware, and anything in `strudel-source/` (including `codemirror.mjs` / `basicSetup.mjs` — read-only reference). If a task seems to require editing any of these, STOP and report a scope error — do not plan around it. Fair game: the CM extension wiring in `editor-setup.js`, the switch path in `main.js`, a new `src/ui/tab-strip.js` (+ optional `src/tabs.js`), store `uiState` fields, the transport chip, left-rail click routing, and the `index.html` / `src/styles/` slot.

**Goal:** IDE-style pattern tabs above the editor: a tab strip over the existing spec-09/24 persistence store. Switching tabs swaps a per-tab CodeMirror `EditorState` on the single `StrudelMirror` view (lossless cursor/scroll/undo), with a hybrid playing-vs-focused audio model (switching/closing never cuts audio; transport targets the focused tab; a now-playing chip + orphan-and-reopen on close).

**Architecture:** Tabs are a **view over the existing store** — no second code store, no second dirtiness model. Two new persisted `uiState` fields (`openTabs`, `activeTab`) and a runtime open-set controller (`src/tabs.js`) holding `openItems` / `activeItem` / a `Map<name, EditorState>` cache / `playingItem` / `orphanedPlaying`. The load-bearing mechanism is **snapshot-and-restore on the single `EditorView`** (not a from-scratch rebuild — `@strudel/codemirror` ships one bundled entry, so StrudelMirror's private base extensions aren't importable): an already-opened tab is restored by `view.setState(cachedState)` (the cached `EditorState` carries the full live config + that tab's own history/cursor/scroll); a fresh tab is derived from the **live** `view.state` via `freshTabState(liveState, doc)` (a full-document transaction that inherits the live config and every runtime-mutated compartment value, reusing the module-level compartment singletons so `reconfigureExtension`/`reconfigureOverlay` keep working). Switching is "flush + cache outgoing `view.state`, restore-or-derive incoming, `view.setState(...)`, keep `editor.code`/`repl.setCode` consistent." The tab strip UI (`src/ui/tab-strip.js`) renders the open set and routes open/focus/close/reorder; `main.js`'s `onSelect` is replaced by an open-or-focus flow that the rail, create, duplicate, import, and capture paths all call.

**Tech Stack:** CodeMirror 6 (`@codemirror/state` — `EditorState`, `Compartment`, `StateEffect`; `@codemirror/view` — `EditorView`), `@strudel/codemirror` (StrudelMirror + its exported `compartments` / `extensions` / `codemirrorSettings`), vanilla DOM for the tab strip (no framework — matches existing UI modules), Node's built-in test runner (`node --test` via the `pnpm test` script using `scripts/test-register.mjs`).

---

## Reading the existing code first

These files already exist and are load-bearing. The plan modifies them; read each before its task:

- `src/main.js` — boots `StrudelMirror`, calls `applyInitialSettings` → `dispatchEditorExtensions` → `installCompletions`, then appends **two `updateListener`s** (autosave at ~L866, bank-detect at ~L881). The rail's `onSelect` (L687) currently does a hard `editor.setCode(record.code)` cut — this is what spec 26 replaces. `setCurrentName` (L841) syncs wordmark + rail highlight. `flushToStore` comes from `createAutosave`.
- `src/editor-setup.js` — `dispatchEditorExtensions(editor, { onOpenReference, onAuditionSelected, onRevealSound, onFocusBrowser })` appends extensions via `StateEffect.appendConfig`. `strasbeatOverlayCompartment` is **module-private** (line 16); `reconfigureOverlay(editor, applyOverlay, onEvaluate)` reconfigures it. The factory will need to read/seed this compartment.
- `src/store.js` — `getIndex()` / `setIndex()` already round-trip `uiState` (lines 25-27). No interface change needed; `openTabs` / `activeTab` live under `uiState`.
- `src/ui/transport.js` — `mountTransport(...)` returns `{ setBank, setStatus, setPlaybackState, ... }`. The bank chip (L68-73, `setBank` at L269) is the sibling pattern for the now-playing chip. `onPlaybackStateChange` (L42) fires on visible playback-state change — read it to clear `playingItem` on idle.
- `src/ui/left-rail.js` — `onSelect(name)` is the rail click callback; `setCurrent` / `clearCurrent` drive the highlight. No structural rail change; only the `onSelect` wiring in `main.js` changes.
- `strudel-source/packages/codemirror/codemirror.mjs` (READ-ONLY) — `compartments` and `extensions` are **exported** (line 52); `codemirrorSettings` is the persistent atom (line 75). The `onChange` listener (L262-265) sets `this.code` + `repl.setCode` on `docChanged`. `setFontSize`/`setFontFamily` write `this.root.style` directly (L378-383), NOT compartments — so font is not a swap hazard (verify, don't rely on it for the settings compartments).

---

## File Structure

**New:**

- `src/tabs.js` — the open-set controller (pure-ish logic). Owns `openItems`, `activeItem`, `playingItem`, `orphanedPlaying`, and the `stateCache: Map<string, EditorState>`. Exposes operations: `openOrFocus`, `close`, `reorder`, `reKey` (rename), `evictFresh` (revert/delete), `setPlaying`, `clearPlaying`, `orphanPlaying`, plus getters and a `persist()` that writes `uiState.openTabs` / `uiState.activeTab`. Construction takes injected callbacks (`buildState`, `installState`, `flushToStore`, `setCurrentName`, `onChange`, `store`, `patterns`) so the controller itself stays DOM-free and unit-testable. The generic `openItems`/`activeItem` naming reserves the spec's forward-compat seam.
- `src/tabs.test.js` — open-set logic: migration from `lastOpen`, open-or-focus (append vs focus), close + neighbor selection, reorder, re-key, persistence shape, playing/orphan transitions. Uses an in-memory store stub and stub `EditorState` placeholders (the controller treats cache values opaquely).
- `src/editor/build-editor-state.js` — the **swap mechanism**. `freshTabState(liveState, doc)` derives a new tab's `EditorState` from the current live state via a full-document transaction (inheriting the full live config + every runtime-mutated compartment value, with a fresh history). `readLiveCompartments(state)` reads the live value of each settings compartment + the overlay compartment for diagnostics / the tripwire. Kept in `src/editor/` next to the other CM wiring. (Named `build-editor-state.js` for discoverability; it does not rebuild from scratch — see the PACKAGING note in Task 2.)
- `src/ui/tab-strip.js` — the tab strip component. Renders the open set (name, dirty dot for Demos, close affordance, focused emphasis, playing marker), wires click→focus, close→close, drag→reorder, overflow auto-scroll-into-view, and the empty state. Pure DOM, mirrors `left-rail.js` conventions (`el()` helper, `setData`-style refresh).
- `src/styles/tab-strip.css` — token-based structural styling (no hex/easing/pixel craft choices — those come from /impeccable → /polish → /animate). Imported by the existing styles entry.

**Modified:**

- `src/editor-setup.js` — export `strasbeatOverlayCompartment` (currently module-private) so `build-editor-state.js`'s `readLiveCompartments` can read its live value. No behavior change to `dispatchEditorExtensions` or `reconfigureOverlay`.
- `src/main.js` — replace `onSelect`'s body with the open-or-focus + state-swap flow; build the open-set controller and tab strip; move the autosave + bank-detect `updateListener`s into the factory; route create / duplicate / import / capture through open-or-focus; set `playingItem` on evaluate; reconcile delete/rename/revert with the open set.
- `src/ui/transport.js` — add the now-playing chip (sibling to the bank chip) with `setNowPlaying({ name, isFocused, isOrphan }) ` and an `onNowPlayingClick` callback; read `onPlaybackStateChange` idle to clear playing.
- `src/command-palette-actions.js` — add `onNextTab` / `onPrevTab` / `onCloseTab` commands wired to the controller.
- `src/ui/command-palette.js` — register the three new palette items (label + handler keys) in `buildCommands`.
- `index.html` — add the tab-strip slot (`<div id="tab-strip">`) directly above the editor canvas.
- `package.json` — append `src/tabs.test.js` and `src/editor/build-editor-state.test.js` to the `test` script.

**New (test, created alongside its task):**

- `src/editor/build-editor-state.test.js` — unit tests for `freshTabState` (doc replacement, config inheritance from the template, distinct-object identity, cursor-at-start) using real `@codemirror/state`. (`readLiveCompartments` isn't unit-tested here because its `@strudel/codemirror` import can't load under bare node; the in-app tripwire is its gate.)

---

## Task 1: Store-level open-set fields + migration helpers (TDD)

Add pure helpers that read/write `uiState.openTabs` / `uiState.activeTab` and derive the initial open set from a booting index (migration from `lastOpen`). These live in `src/tabs.js` as standalone exported functions so they're testable without DOM or CodeMirror.

**Files:**

- Create: `src/tabs.js` (initial — pure helpers only)
- Create: `src/tabs.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/tabs.test.js`:

```js
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  readOpenSet,
  writeOpenSet,
  migrateOpenSet,
} from "./tabs.js";

// In-memory store stub matching the createLocalStore interface used by
// readOpenSet/writeOpenSet (only getIndex/setIndex are exercised here).
function makeStore(index = { lastOpen: null, userPatterns: [] }) {
  let idx = structuredClone(index);
  return {
    getIndex: () => structuredClone(idx),
    setIndex: (next) => {
      idx = structuredClone(next);
    },
    _peek: () => idx,
  };
}

describe("readOpenSet", () => {
  test("returns empty open set when uiState is absent", () => {
    const store = makeStore();
    assert.deepEqual(readOpenSet(store), { openTabs: [], activeTab: null });
  });

  test("reads openTabs and activeTab from uiState", () => {
    const store = makeStore({
      lastOpen: "b",
      userPatterns: [],
      uiState: { openTabs: ["a", "b", "c"], activeTab: "b" },
    });
    assert.deepEqual(readOpenSet(store), {
      openTabs: ["a", "b", "c"],
      activeTab: "b",
    });
  });

  test("coerces malformed openTabs to an empty array", () => {
    const store = makeStore({
      lastOpen: null,
      userPatterns: [],
      uiState: { openTabs: "nope", activeTab: 42 },
    });
    assert.deepEqual(readOpenSet(store), { openTabs: [], activeTab: null });
  });
});

describe("writeOpenSet", () => {
  test("persists openTabs + activeTab under uiState, preserving other fields", () => {
    const store = makeStore({
      lastOpen: "a",
      userPatterns: ["x"],
      folders: ["Jazz"],
      uiState: { collapsedFolders: ["Jazz"] },
    });
    writeOpenSet(store, { openTabs: ["a", "b"], activeTab: "b" });
    const idx = store._peek();
    assert.deepEqual(idx.uiState.openTabs, ["a", "b"]);
    assert.equal(idx.uiState.activeTab, "b");
    // Untouched fields survive.
    assert.deepEqual(idx.uiState.collapsedFolders, ["Jazz"]);
    assert.deepEqual(idx.folders, ["Jazz"]);
    assert.deepEqual(idx.userPatterns, ["x"]);
  });

  test("also mirrors activeTab into lastOpen (spec: kept in sync)", () => {
    const store = makeStore({ lastOpen: "a", userPatterns: [] });
    writeOpenSet(store, { openTabs: ["a", "b"], activeTab: "b" });
    assert.equal(store._peek().lastOpen, "b");
  });
});

describe("migrateOpenSet", () => {
  test("seeds open set from existing openTabs/activeTab when present", () => {
    const store = makeStore({
      lastOpen: "b",
      userPatterns: [],
      uiState: { openTabs: ["a", "b"], activeTab: "a" },
    });
    assert.deepEqual(migrateOpenSet(store), { openTabs: ["a", "b"], activeTab: "a" });
  });

  test("legacy boot (only lastOpen) seeds a single tab", () => {
    const store = makeStore({ lastOpen: "05-dub", userPatterns: [] });
    assert.deepEqual(migrateOpenSet(store), {
      openTabs: ["05-dub"],
      activeTab: "05-dub",
    });
  });

  test("empty boot (no lastOpen, no openTabs) seeds an empty open set", () => {
    const store = makeStore({ lastOpen: null, userPatterns: [] });
    assert.deepEqual(migrateOpenSet(store), { openTabs: [], activeTab: null });
  });

  test("lastOpen wins as focus when openTabs exists but disagrees on boot", () => {
    // Older build wrote openTabs but a newer lastOpen; lastOpen is added + focused.
    const store = makeStore({
      lastOpen: "c",
      userPatterns: [],
      uiState: { openTabs: ["a", "b"], activeTab: "a" },
    });
    const r = migrateOpenSet(store);
    assert.equal(r.activeTab, "c");
    assert.ok(r.openTabs.includes("c"));
    // Existing tabs are preserved.
    assert.ok(r.openTabs.includes("a") && r.openTabs.includes("b"));
  });
});
```

- [ ] **Step 2: Add the two new test files to package.json's `test` script**

In `package.json`, append ` src/tabs.test.js src/editor/build-editor-state.test.js` to the end of the space-separated file list in the `test` script. (The second file's tests arrive in Task 2 — adding both now keeps the script edits to one task.)

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm test 2>&1 | tail -30
```

Expected: FAIL — `src/tabs.js` does not export `readOpenSet` (and `build-editor-state.test.js` not found yet — that's expected; it lands in Task 2). To scope this run to the new file:

```bash
node --import ./scripts/test-register.mjs --test src/tabs.test.js 2>&1 | tail -30
```

Expected: FAIL with "module not found" / export missing.

- [ ] **Step 4: Implement the helpers**

Create `src/tabs.js`:

```js
// Open-set controller for pattern tabs. See design/work/26-pattern-tabs.md.
//
// Tabs are a VIEW over the spec-09/24 store — no second code store, no
// second dirtiness model. This module owns the runtime open set and the
// per-tab EditorState cache. Internal naming is deliberately generic
// (openItems / activeItem / "open an item") so spec 06's "open track" maps
// onto the same structure; the persisted keys stay openTabs / activeTab.

/**
 * Read the persisted open set from the store index.
 * @returns {{ openTabs: string[], activeTab: string|null }}
 */
export function readOpenSet(store) {
  const idx = store.getIndex();
  const ui = idx.uiState ?? {};
  const openTabs = Array.isArray(ui.openTabs)
    ? ui.openTabs.filter((n) => typeof n === "string")
    : [];
  const activeTab = typeof ui.activeTab === "string" ? ui.activeTab : null;
  return { openTabs, activeTab };
}

/**
 * Persist the open set under uiState, preserving every other index field.
 * Also mirrors activeTab into lastOpen (spec: kept in sync, lastOpen is the
 * pre-tabs spelling of "the focused pattern").
 */
export function writeOpenSet(store, { openTabs, activeTab }) {
  const idx = store.getIndex();
  idx.uiState = {
    ...(idx.uiState ?? {}),
    openTabs: [...openTabs],
    activeTab: activeTab ?? null,
  };
  idx.lastOpen = activeTab ?? idx.lastOpen ?? null;
  store.setIndex(idx);
}

/**
 * Derive the initial open set at boot, migrating older persistence shapes.
 *
 *   - openTabs present                       → use it as-is.
 *   - only lastOpen present (legacy)         → single tab = [lastOpen].
 *   - neither                                → empty open set.
 *   - openTabs present AND lastOpen disagrees → lastOpen wins as focus and is
 *     appended to openTabs (an older build may have written only lastOpen on
 *     its last switch).
 */
export function migrateOpenSet(store) {
  const idx = store.getIndex();
  const ui = idx.uiState ?? {};
  const hasOpenTabs = Array.isArray(ui.openTabs);

  if (!hasOpenTabs) {
    if (idx.lastOpen) return { openTabs: [idx.lastOpen], activeTab: idx.lastOpen };
    return { openTabs: [], activeTab: null };
  }

  const openTabs = ui.openTabs.filter((n) => typeof n === "string");
  let activeTab = typeof ui.activeTab === "string" ? ui.activeTab : null;

  // lastOpen wins as focus if it disagrees and isn't already open.
  if (idx.lastOpen && idx.lastOpen !== activeTab) {
    activeTab = idx.lastOpen;
    if (!openTabs.includes(idx.lastOpen)) openTabs.push(idx.lastOpen);
  }
  // Guard: if activeTab fell outside openTabs, focus the first tab (or null).
  if (activeTab && !openTabs.includes(activeTab)) {
    activeTab = openTabs[0] ?? null;
  }
  return { openTabs, activeTab };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --import ./scripts/test-register.mjs --test src/tabs.test.js 2>&1 | tail -30
```

Expected: PASS — all `tabs.test.js` assertions green.

- [ ] **Step 6: Stop and report**

Report: Task 1 complete; `readOpenSet`/`writeOpenSet`/`migrateOpenSet` implemented and tested. Suggested commit message:
`feat(tabs): open-set persistence + lastOpen migration helpers`.

---

## Task 2: The EditorState swap mechanism (TDD) — PROVE THIS BEFORE PROCEEDING

This is the spec's "load-bearing mechanism" (§"The EditorState swap"). A swapped-in tab's `EditorState` must carry the **current live configuration** — every settings compartment's runtime value AND the strasbeat overlay compartment — never build-time defaults. Build the mechanism, unit-test the pure part, and **prove the live-config invariant in the running app (acceptance #3) before any UI stacks on it.** Do not move to Task 3 until the tripwire passes.

**Files:**

- Modify: `src/editor-setup.js` (export the module-private overlay compartment)
- Create: `src/editor/build-editor-state.js`
- Create: `src/editor/build-editor-state.test.js`

- [ ] **Step 1: Read the relevant code, confirm the seams**

Read `src/editor-setup.js` in full and confirm:
- `strasbeatOverlayCompartment` is module-private (line 16).
- `dispatchEditorExtensions` appends: `errorMarksExtension`, `Prec.highest(formatExtension)`, `Prec.highest(createUniversalKeymap(...))`, the overlay compartment `.of(...)`, `numericScrubber(...)`, `hoverDocs(...)`, `signatureHint`.

Read `strudel-source/packages/codemirror/codemirror.mjs` lines 30-110 and confirm `compartments` and `extensions` are exported and that `initEditor` builds the state from `compartments[key].of(extensions[key](settings[key]))` plus `basicSetup` (which contains `history()`), `javascript()`, `sliderPlugin`, `widgetPlugin`, `syntaxHighlighting`, the `onChange` updateListener, `drawSelection`, and the `Prec.highest` eval/stop keymap. **Do not modify this file.**

- [ ] **Step 2: Export the overlay compartment from editor-setup.js**

`readLiveCompartments` must read the overlay's live value, so the compartment must be importable. In `src/editor-setup.js`, export the compartment (change the module-private `const` at line 16 to an exported `const`):

```js
// CodeMirror compartment for the strasbeat-side editing overlay
// (createVscodeKeymap). Exported so the per-tab EditorState factory
// (build-editor-state.js) can read its live value and seed swapped-in
// states with it — a swap must never revert the keymap profile to default.
export const strasbeatOverlayCompartment = new Compartment();
```

That single export is the only change to `editor-setup.js` for this task. `readLiveCompartments` (in the factory) reads the overlay's live value via `strasbeatOverlayCompartment.get(state)`, so it must be importable. **Do NOT change `dispatchEditorExtensions` or `reconfigureOverlay`** — the snapshot-and-restore mechanism (Step 3) inherits the live config from the running state, so there is no need to assemble a reusable appended-extension array or a duplicate overlay-extension builder. (The live state IS the single source of config truth.)

> **CRITICAL MECHANISM CONSTRAINT — reuse the module-level compartment singletons, do NOT clone them.** The settings compartments live in `@strudel/codemirror` as `compartments` (module-level singletons); the overlay lives as `strasbeatOverlayCompartment` (module-level). `editor.reconfigureExtension(key, v)` (StrudelMirror) and `reconfigureOverlay(...)` (editor-setup) dispatch `compartments[key].reconfigure(...)` / `strasbeatOverlayCompartment.reconfigure(...)` against **those exact objects**. A per-tab state must therefore install **those same compartment objects** (seeded with the live value) — `compartments[key].of(liveValue)` and `strasbeatOverlayCompartment.of(liveValue)`. If a tab state used *new* `Compartment()` instances, a later `reconfigureExtension`/`reconfigureOverlay` would target compartments the state doesn't contain → silent breakage (exactly the hazard the spec's §"hard constraint" describes). The factory below reuses the singletons; acceptance #3's "subsequent `reconfigureOverlay` still takes effect" check is the tripwire for getting this wrong.

> **PACKAGING REALITY — `@strudel/codemirror` ships a single bundled entry (`dist/index.mjs`), no `exports` map, no subpaths.** So `import { basicSetup } from "@strudel/codemirror/basicSetup.mjs"` will NOT resolve, and `basicSetup`/`sliderPlugin`/`widgetPlugin` are NOT re-exported from the barrel either (they're internal to `codemirror.mjs`). This rules out reconstructing StrudelMirror's private base extension list. The implementable mechanism is therefore **snapshot-and-restore, not rebuild** (the spec's §"chosen approach" authorizes "the implementer must verify against codemirror.mjs whether the swap is cleanest as ..."):
> - **Cache restore (already-opened tab):** `view.setState(cachedState)` where `cachedState` is the real `EditorState` snapshotted from the view on the previous switch-away. It carries the full live config and the tab's own history/cursor/scroll verbatim — nothing to rebuild.
> - **Fresh tab (first open this session):** derive a new state from the **current live `view.state`** by replacing only the document — `liveState.update({ changes: replace-whole-doc }).state`. CM6's `EditorState.create` cannot reuse another state's extensions, but a transaction off the live state produces a new state that **inherits the full live configuration + every live compartment value** while resetting history relative to the new doc. The live state is the template; nothing is captured at boot — see Step 3.

- [ ] **Step 3: Implement the swap helper (`freshTabState` + `readLiveCompartments`)**

Because StrudelMirror's base extensions aren't importable as values, do not reconstruct them. Instead, use the **current live `view.state` as the template** for each fresh tab: a full-document transaction (`liveState.update({ changes: replace-whole-doc })`) yields a new state that inherits the live configuration (all compartments + their live values, basicSetup/history, slider/widget, the onChange listener, every strasbeat-appended extension) but starts the tab with a fresh, empty-relative history. No boot snapshot is stashed — deriving from the live state at switch time is both simpler and always-current (it automatically picks up any setting the user changed since boot).

Implement as follows. Create `src/editor/build-editor-state.js`:

```js
// The per-tab EditorState mechanism — the load-bearing piece for lossless
// tab switching. See design/work/26-pattern-tabs.md §"The EditorState swap".
//
// MECHANISM (see the CRITICAL/PACKAGING notes in Task 2 of the plan):
//   - Already-opened tab → restore its real snapshotted EditorState (carries
//     full live config + that tab's own history/cursor/scroll). No rebuild.
//   - Fresh tab → derive from the LIVE state by replacing the whole document
//     via a transaction, so it inherits the live config + live compartment
//     values but starts with an empty-relative history. The module-level
//     compartment singletons are reused (never cloned), so reconfigureExtension
//     / reconfigureOverlay keep working after a swap.
//
// HARD CONSTRAINT (acceptance #3 tripwire): a swapped-in state must carry the
// CURRENT LIVE configuration — every settings compartment value AND the
// strasbeat overlay — never build-time defaults.

import { compartments } from "@strudel/codemirror";
import { strasbeatOverlayCompartment } from "../editor-setup.js";

// Read the live value of every runtime-mutated compartment from a state, for
// diagnostics / assertions. Returns { settings: {[key]: Extension}, overlay }.
// `Compartment.get(state)` returns the Extension currently installed for that
// compartment in `state` — verified present in @codemirror/state.
export function readLiveCompartments(state) {
  const settings = {};
  for (const key of Object.keys(compartments)) {
    settings[key] = compartments[key].get(state);
  }
  return { settings, overlay: strasbeatOverlayCompartment.get(state) ?? null };
}

// Build a FRESH tab state from the live state by swapping the whole document.
// The returned state keeps the live state's configuration (all compartments,
// basicSetup/history, slider/widget, the onChange listener, every strasbeat
// appended extension) and the live compartment VALUES — because it is derived
// from `liveState` via a full-document transaction, not a from-scratch
// EditorState.create. History resets relative to this new starting doc.
//
// @param {EditorState} liveState  the current view.state (the template)
// @param {string} doc             the new tab's document text
// @returns {EditorState}
export function freshTabState(liveState, doc) {
  const tr = liveState.update({
    changes: { from: 0, to: liveState.doc.length, insert: doc },
    selection: { anchor: 0 },
    // A doc-replacing transaction normally lands as one undo step on the
    // shared history. We want each tab to start clean, so flag this so the
    // host can decide; in practice the cached-state model means this fresh
    // state becomes the tab's baseline and its later edits accrue on top.
    annotations: [],
  });
  return tr.state;
}
```

> **Why this is correct for per-tab undo.** Each open tab is represented by a **distinct `EditorState` object** held in the controller's `stateCache`. Switching away snapshots the live `view.state` into the cache (that object owns its `historyField`). Switching back restores it via `view.setState` — CM6 history is a `StateField` bound to that specific state object, so restoring it restores that tab's undo stack verbatim, and edits made while another tab was focused never touched it. A fresh tab is derived from the live state via `liveState.update(...)` so it inherits config but is a new object; once it's switched-away-and-cached, it owns its own history going forward. This satisfies the spec's "per-tab `EditorState`" requirement using only `view.setState` + `state.update` (both public), with NO unreachable imports and NO cloned compartments. **The acceptance #2 in-app check (Task 3 Step 6) is the proof; if undo bleeds, the cache isn't holding distinct objects.**

- [ ] **Step 4: Write the failing unit tests**

Create `src/editor/build-editor-state.test.js`:

```js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { EditorState, Compartment } from "@codemirror/state";

import { freshTabState, readLiveCompartments } from "./build-editor-state.js";

// NOTE: readLiveCompartments imports `compartments` from @strudel/codemirror,
// whose barrel transitively pulls a browser-only dep that can't load under
// bare node. So we test the parts that DON'T require that import:
// freshTabState (pure @codemirror/state). readLiveCompartments is covered by
// the in-app tripwire (Task 2 Step 6), which is its real gate.

describe("freshTabState", () => {
  test("replaces the whole document, inheriting the template's configuration", () => {
    // A template state with a compartment-held extension (stands in for the
    // live config). The fresh state must keep that compartment.
    const c = new Compartment();
    const live = EditorState.create({
      doc: "OLD CONTENT",
      extensions: [c.of(EditorState.tabSize.of(4))],
    });
    const fresh = freshTabState(live, "new content");
    assert.equal(fresh.doc.toString(), "new content");
    // The compartment is still present in the derived state (config inherited).
    assert.notEqual(c.get(fresh), undefined);
  });

  test("derives a distinct state object (so cached tabs hold independent history)", () => {
    const live = EditorState.create({ doc: "a" });
    const fresh = freshTabState(live, "b");
    assert.notEqual(fresh, live);
    assert.equal(live.doc.toString(), "a"); // template untouched
  });

  test("places the cursor at the document start in the fresh tab", () => {
    const live = EditorState.create({ doc: "xxxxx" });
    const fresh = freshTabState(live, "hello world");
    assert.equal(fresh.selection.main.anchor, 0);
  });
});
```

- [ ] **Step 5: Run unit tests to verify they fail, then pass**

```bash
node --import ./scripts/test-register.mjs --test src/editor/build-editor-state.test.js 2>&1 | tail -30
```

Expected first run: FAIL (`build-editor-state.js` missing / exports missing). After implementing Step 3: PASS for the `freshTabState` suite. Then:

```bash
pnpm build
```

Expected: build succeeds (all imports resolve under Vite — the `@strudel/codemirror` barrel loads fine in the browser bundle even though it can't under bare node).

- [ ] **Step 6: THE TRIPWIRE — wire a temporary swap probe and prove acceptance #3 in the running app**

This proves the mechanism before any UI exists. Add a **temporary** debug probe to `main.js` (removed in Task 3 when the real switch path lands).

After the editor is fully constructed and `dispatchEditorExtensions` + `installCompletions` + the two appended `updateListener`s have run (i.e. near the bottom of the boot sequence), add:

```js
// TEMP TRIPWIRE PROBE — remove in Task 3. Proves the EditorState swap
// carries live config using the REAL mechanism (freshTabState derives from
// the live state, so config is inherited, not rebuilt). window-exposed for
// manual devtools driving.
import { freshTabState, readLiveCompartments } from "./editor/build-editor-state.js";
window.__tabSwapProbe = {
  snapshot() {
    return { state: editor.editor.state, live: readLiveCompartments(editor.editor.state) };
  },
  swapToFreshDocCarryingLiveConfig(doc = "// swapped\nsound(\"bd sd\")\n") {
    // Derive a fresh state from the LIVE state — inherits all compartments,
    // basicSetup/history, slider/widget, onChange, and every strasbeat
    // appended extension, plus the live compartment VALUES.
    const next = freshTabState(editor.editor.state, doc);
    editor.editor.setState(next);
    editor.code = editor.editor.state.doc.toString();
    editor.repl.setCode?.(editor.code);
  },
};
```

Run the app and execute the manual tripwire (this IS acceptance criterion #3):

```bash
pnpm dev
```

In the browser:
1. Switch the keymap profile to **VSCode** (via the transport keymap chip) **and** change the **font size and family** in Settings.
2. In devtools: `window.__tabSwapProbe.swapToFreshDocCarryingLiveConfig()`.
3. Confirm **after the swap**:
   - The **keymap profile persists** — `Cmd+D` still selects next occurrence (the VSCode overlay survived because the overlay compartment singleton + its live value carried over).
   - The **font size/family persist** (verify they look unchanged — font is set on `this.root.style`, not a compartment, so a state swap never touches it; this confirms the spec's note).
   - **Autocomplete still triggers** (type `note(` — tooltip appears) and **bank-detect** still updates (type `.bank("RolandTR909")` → the transport bank chip changes), proving the appended listeners survived.
   - A subsequent **`reconfigureOverlay`** still takes effect: change the profile again via the chip and confirm `Cmd+D` toggles on/off accordingly. (This is the proof the module-level compartment singletons were reused, not cloned.)

If any revert to defaults, the swap is dropping live config or cloned a compartment — fix `freshTabState` (it must derive from the live state, never `EditorState.create` from scratch) until all four hold. **Do not proceed to Task 3 until this passes.** Then remove the temporary probe block.

- [ ] **Step 7: Stop and report**

Report: mechanism implemented; `freshTabState` unit tests green; the tripwire (acceptance #3) passed in-app with evidence for each check (keymap profile, font, autocomplete, bank-detect, reconfigureOverlay). Suggested commit message:
`feat(tabs): per-tab EditorState swap mechanism (acceptance #3 verified)`.

---

## Task 3: The open-set controller + switch flow, replacing onSelect

Now build the controller that owns the open set and per-tab `stateCache`, wire it to the factory, and replace `onSelect`'s hard-cut body with the spec's switch flow. No tab-strip UI yet — focus drives off the controller + the existing rail click. This delivers acceptance #1 (lossless switch) and #2 (per-tab undo) once a second tab can be focused (proven here via the rail + a temporary "open second tab" path; the strip lands in Task 4).

**Files:**

- Modify: `src/tabs.js` (add the controller class/factory)
- Modify: `src/main.js` (build controller; capture `appended`; replace `onSelect`; remove the Task 2 probe)
- Modify: `src/tabs.test.js` (controller logic tests)

- [ ] **Step 1: Append controller tests**

Append to `src/tabs.test.js`:

```js
import { createTabController } from "./tabs.js";

// A stub "EditorState" is just an opaque token; the controller never
// inspects it. buildState returns a fresh token; installState records the
// last installed token.
function makeHarness({ openTabs = [], activeTab = null } = {}) {
  let idx = {
    lastOpen: activeTab,
    userPatterns: [],
    uiState: { openTabs, activeTab },
  };
  const store = {
    getIndex: () => structuredClone(idx),
    setIndex: (n) => { idx = structuredClone(n); },
    get: (name) => ({ code: `code-of-${name}`, isUserPattern: true }),
  };
  const events = { installed: [], flushed: 0, currentName: null, changed: [] };
  const ctl = createTabController({
    store,
    patterns: {},
    buildState: ({ name }) => ({ token: `state-of-${name}` }),
    installState: (token) => { events.installed.push(token); },
    captureState: () => ({ token: "captured" }),
    flushToStore: () => { events.flushed++; },
    setCurrentName: (name) => { events.currentName = name; },
    onChange: () => { events.changed.push(true); },
  });
  return { ctl, events, store, _idx: () => idx };
}

describe("createTabController: open-or-focus", () => {
  test("opening a new item appends it and focuses it", () => {
    const { ctl, events } = makeHarness();
    ctl.openOrFocus("a");
    assert.deepEqual(ctl.getOpenItems(), ["a"]);
    assert.equal(ctl.getActiveItem(), "a");
    assert.equal(events.currentName, "a");
  });

  test("opening an already-open item focuses without duplicating", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    ctl.openOrFocus("b");
    assert.deepEqual(ctl.getOpenItems(), ["a", "b"]);
    assert.equal(ctl.getActiveItem(), "b");
  });

  test("switching flushes the outgoing buffer and installs the incoming state", () => {
    const { ctl, events } = makeHarness();
    ctl.openOrFocus("a");
    ctl.openOrFocus("b");
    assert.ok(events.flushed >= 1, "flushToStore called on switch");
    assert.ok(events.installed.length >= 1, "installState called");
  });

  test("persists openTabs + activeTab after a focus change", () => {
    const { ctl, _idx } = makeHarness();
    ctl.openOrFocus("a");
    ctl.openOrFocus("b");
    assert.deepEqual(_idx().uiState.openTabs, ["a", "b"]);
    assert.equal(_idx().uiState.activeTab, "b");
  });
});

describe("createTabController: close + neighbor focus", () => {
  test("closing the focused tab focuses the right neighbor", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b", "c"], activeTab: "b" });
    ctl.hydrate();
    ctl.close("b");
    assert.deepEqual(ctl.getOpenItems(), ["a", "c"]);
    assert.equal(ctl.getActiveItem(), "c"); // right neighbor
  });

  test("closing the last (rightmost) focused tab focuses the left neighbor", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "b" });
    ctl.hydrate();
    ctl.close("b");
    assert.equal(ctl.getActiveItem(), "a");
  });

  test("closing the only tab leaves an empty open set with null focus", () => {
    const { ctl } = makeHarness({ openTabs: ["a"], activeTab: "a" });
    ctl.hydrate();
    ctl.close("a");
    assert.deepEqual(ctl.getOpenItems(), []);
    assert.equal(ctl.getActiveItem(), null);
  });

  test("closing a non-focused tab leaves focus unchanged", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b", "c"], activeTab: "b" });
    ctl.hydrate();
    ctl.close("a");
    assert.equal(ctl.getActiveItem(), "b");
    assert.deepEqual(ctl.getOpenItems(), ["b", "c"]);
  });
});

describe("createTabController: reorder + reKey", () => {
  test("reorder moves an item to a new index and persists", () => {
    const { ctl, _idx } = makeHarness({ openTabs: ["a", "b", "c"], activeTab: "a" });
    ctl.hydrate();
    ctl.reorder("c", 0); // move c to front
    assert.deepEqual(ctl.getOpenItems(), ["c", "a", "b"]);
    assert.deepEqual(_idx().uiState.openTabs, ["c", "a", "b"]);
  });

  test("reKey renames an open item in place, preserving order and focus", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b", "c"], activeTab: "b" });
    ctl.hydrate();
    ctl.reKey("b", "b2");
    assert.deepEqual(ctl.getOpenItems(), ["a", "b2", "c"]);
    assert.equal(ctl.getActiveItem(), "b2");
  });

  test("reKey updates playingItem and orphanedPlaying when they match", () => {
    const { ctl } = makeHarness({ openTabs: ["a"], activeTab: "a" });
    ctl.hydrate();
    ctl.setPlaying("a");
    ctl.reKey("a", "a2");
    assert.equal(ctl.getPlayingItem(), "a2");
  });
});

describe("createTabController: playing + orphan", () => {
  test("setPlaying records the playing item", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    ctl.setPlaying("a");
    assert.equal(ctl.getPlayingItem(), "a");
    assert.equal(ctl.getOrphanedPlaying(), null);
  });

  test("closing the playing tab orphans playback (audio continues)", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "a" });
    ctl.hydrate();
    ctl.setPlaying("a");
    ctl.close("a");
    assert.equal(ctl.getPlayingItem(), null);
    assert.equal(ctl.getOrphanedPlaying(), "a");
  });

  test("clearPlaying resets both playing and orphan state", () => {
    const { ctl } = makeHarness({ openTabs: ["a"], activeTab: "a" });
    ctl.hydrate();
    ctl.setPlaying("a");
    ctl.close("a");
    ctl.clearPlaying();
    assert.equal(ctl.getPlayingItem(), null);
    assert.equal(ctl.getOrphanedPlaying(), null);
  });

  test("reopening an orphaned playing item via openOrFocus clears orphan into playingItem", () => {
    const { ctl } = makeHarness({ openTabs: ["a", "b"], activeTab: "b" });
    ctl.hydrate();
    ctl.setPlaying("a");
    ctl.close("a");
    assert.equal(ctl.getOrphanedPlaying(), "a");
    ctl.openOrFocus("a"); // jump-to-playing
    assert.equal(ctl.getOrphanedPlaying(), null);
    assert.equal(ctl.getPlayingItem(), "a");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --import ./scripts/test-register.mjs --test src/tabs.test.js 2>&1 | tail -40
```

Expected: FAIL — `createTabController` not exported.

- [ ] **Step 3: Implement the controller**

Append to `src/tabs.js`:

```js
/**
 * Create the open-set controller. DOM-free; the host injects how to build /
 * install / capture editor state and how to flush + relabel.
 *
 * Injected deps:
 *   store          — the persistence store (getIndex/setIndex/get)
 *   patterns       — { [name]: code } shipped patterns (for fresh-state seed)
 *   buildState({ name, code, fresh }) → EditorState   build a tab's state
 *   installState(state)              → void           view.setState(state)
 *   captureState()                   → EditorState     snapshot the live state
 *   flushToStore()                   → void            immediate autosave flush
 *   setCurrentName(name)             → void            wordmark + rail highlight
 *   onChange(update)                 → void            (passed to buildState by host)
 *   onAfterSwitch?(name)             → void            optional UI hook (strip repaint)
 */
export function createTabController(deps) {
  const {
    store,
    patterns,
    buildState,
    installState,
    captureState,
    flushToStore,
    setCurrentName,
    onAfterSwitch = () => {},
  } = deps;

  let openItems = [];
  let activeItem = null;
  let playingItem = null;
  let orphanedPlaying = null;
  /** @type {Map<string, any>} name → cached EditorState */
  const stateCache = new Map();

  function hydrate() {
    const { openTabs, activeTab } = migrateOpenSet(store);
    openItems = [...openTabs];
    activeItem = activeTab;
    persist();
  }

  function persist() {
    writeOpenSet(store, { openTabs: openItems, activeTab: activeItem });
  }

  function codeFor(name) {
    const rec = store.get(name);
    if (rec) return rec.code;
    if (name in patterns) return patterns[name];
    return "";
  }

  // The core switch: cache outgoing, install incoming, relabel, persist.
  function focus(name) {
    if (activeItem === name) return;
    // 1. Flush + cache the outgoing state (preserves undo/cursor/scroll).
    if (activeItem != null) {
      flushToStore();
      stateCache.set(activeItem, captureState());
    }
    // 2. Install B's state — cached if present, else fresh from working copy.
    let state = stateCache.get(name);
    if (!state) {
      state = buildState({ name, code: codeFor(name), fresh: true });
      stateCache.set(name, state);
    }
    installState(state);
    // 3. Relabel + persist focus.
    activeItem = name;
    setCurrentName(name);
    persist();
    onAfterSwitch(name);
  }

  function openOrFocus(name) {
    if (!openItems.includes(name)) openItems.push(name);
    // Reopening the orphaned-playing tab clears the orphan into playingItem.
    if (orphanedPlaying === name) {
      orphanedPlaying = null;
      playingItem = name;
    }
    focus(name);
  }

  function close(name) {
    const idx = openItems.indexOf(name);
    if (idx < 0) return;
    const wasActive = activeItem === name;
    openItems.splice(idx, 1);
    stateCache.delete(name);
    // Orphan playback if the closed tab owned the sound (audio continues).
    if (playingItem === name) {
      playingItem = null;
      orphanedPlaying = name;
    }
    if (wasActive) {
      // Focus the right neighbor, else the left, else empty.
      const next = openItems[idx] ?? openItems[idx - 1] ?? null;
      activeItem = null; // force focus() to run for `next`
      if (next != null) focus(next);
      else {
        setCurrentName(null);
        persist();
        onAfterSwitch(null);
      }
    } else {
      persist();
      onAfterSwitch(activeItem);
    }
  }

  function reorder(name, toIndex) {
    const from = openItems.indexOf(name);
    if (from < 0) return;
    openItems.splice(from, 1);
    openItems.splice(toIndex, 0, name);
    persist();
    onAfterSwitch(activeItem);
  }

  // Rename: re-key in place across openItems, cache, focus, playing, orphan.
  function reKey(oldName, newName) {
    const i = openItems.indexOf(oldName);
    if (i >= 0) openItems[i] = newName;
    if (stateCache.has(oldName)) {
      stateCache.set(newName, stateCache.get(oldName));
      stateCache.delete(oldName);
    }
    if (activeItem === oldName) activeItem = newName;
    if (playingItem === oldName) playingItem = newName;
    if (orphanedPlaying === oldName) orphanedPlaying = newName;
    persist();
    onAfterSwitch(activeItem);
  }

  // Revert/delete-with-fresh-state: drop the cached state so the next focus
  // rebuilds from the (reverted) working copy. Caller updates the store first.
  function evictState(name) {
    stateCache.delete(name);
  }

  function setPlaying(name) {
    playingItem = name;
    orphanedPlaying = null;
  }
  function clearPlaying() {
    playingItem = null;
    orphanedPlaying = null;
  }

  return {
    hydrate,
    openOrFocus,
    close,
    reorder,
    reKey,
    evictState,
    setPlaying,
    clearPlaying,
    persist,
    getOpenItems: () => [...openItems],
    getActiveItem: () => activeItem,
    getPlayingItem: () => playingItem,
    getOrphanedPlaying: () => orphanedPlaying,
  };
}
```

- [ ] **Step 4: Run controller tests to verify they pass**

```bash
node --import ./scripts/test-register.mjs --test src/tabs.test.js 2>&1 | tail -40
```

Expected: PASS — all controller + helper tests green.

- [ ] **Step 5: Wire the controller into main.js and replace onSelect**

In `src/main.js`:

a) Remove the **temporary tripwire probe** added in Task 2 Step 6.

b) Import the controller + the swap helper. Add imports near the top:

```js
import { createTabController } from "./tabs.js";
import { freshTabState } from "./editor/build-editor-state.js";
```

c) **No boot-dispatch refactor is needed.** Because `freshTabState` derives each new tab's state from the **current live state**, the live config — StrudelMirror's settings compartments, the strasbeat overlay compartment, the two appended `updateListener`s (autosave + bank-detect), hover docs, the scrubber, signature hint, AND completions — is inherited automatically. Leave the existing boot sequence intact: keep the `dispatchEditorExtensions(editor, { onOpenReference, onAuditionSelected, onRevealSound, onFocusBrowser })` call, the `installCompletions(...)` call, and the two `editor.editor.dispatch({ effects: StateEffect.appendConfig.of([...updateListener...]) })` blocks (autosave ~L866, bank-detect ~L881) exactly as they are. They build the live state once; the factory copies from it. (This is the payoff of snapshot-and-restore over rebuild: there is no second extension list to keep in sync, so the "single source of config truth" requirement from the spec is satisfied trivially — the live state IS the single source.)

d) Define `buildState` / `installState` / `captureState` for the controller. `buildState` derives a fresh state from the live one; `installState` swaps + keeps the buffer consistent; `captureState` snapshots the live state object (which carries that tab's history/cursor/scroll):

```js
function buildTabState({ code }) {
  // Derive from the live state → inherits the full live config + every
  // runtime-mutated compartment value. Fresh, empty-relative history.
  return freshTabState(editor.editor.state, code);
}
function installTabState(state) {
  editor.editor.setState(state);
  // Keep the live buffer + repl in sync (spec: "keep the buffer consistent").
  // setState fires the inherited onChange listener on a doc difference, but
  // set explicitly so an identical-doc swap (rare) is still consistent.
  editor.code = editor.editor.state.doc.toString();
  editor.repl.setCode?.(editor.code);
}
function captureTabState() {
  // The live state object — owns this tab's historyField, selection, scroll.
  return editor.editor.state;
}
```

(Error/console clearing on switch — `clearError(editor.editor)` + `evalFeedback?.resetRuntimeErrors()` — is global and keyed to the live buffer per the spec's §"Non-goals". The controller does NOT clear errors; keep that responsibility in `main.js`. Add it to the controller's `installState` injection by wrapping: pass `installState: (state) => { installTabState(state); clearError(editor.editor); evalFeedback?.resetRuntimeErrors(); }` so every swap clears the global error state, matching today's `onSelect` behavior.)

e) Build the controller and hydrate it:

```js
const tabs = createTabController({
  store,
  patterns,
  buildState: buildTabState,
  installState: installTabState,
  captureState: captureTabState,
  flushToStore,
  setCurrentName,
  onAfterSwitch: (name) => { /* tab strip repaint wired in Task 4 */ },
});
tabs.hydrate();
```

f) Replace the rail's `onSelect` body (currently L687-699, the hard `editor.setCode` cut) with:

```js
onSelect(name) {
  tabs.openOrFocus(name);
},
```

The flush, error clear, setCurrentName, and `lastOpen` write now live inside the controller (`focus`) + the `installState` wrapper. Remove the now-duplicated logic from `onSelect`. (Status-line copy is deferred to /clarify; drop the `Loaded "X"` string for now or keep a quieter one — final copy is craft.)

g) On boot, focus the migrated active tab so the editor shows it through the swap path (not the raw `initialCode`). After `tabs.hydrate()`, if `tabs.getActiveItem()` is set and differs from the constructor's `initialName`, call `tabs.openOrFocus(tabs.getActiveItem())`. If they match, no swap needed (the constructor already seeded `initialCode`); seed the cache lazily on first switch-away. **Edge case — empty open set:** if `migrateOpenSet` returned an empty set (no `lastOpen`, no `openTabs`), the constructor still built the editor with `initialCode` (the fallback pattern). In that case, call `tabs.openOrFocus(initialName)` once so the boot pattern becomes a real tab (otherwise the strip shows the empty state while the editor shows content — inconsistent). This guarantees the common first-run lands with exactly one tab.

- [ ] **Step 6: Build + verify acceptance #1 and #2 in-app**

```bash
pnpm build
pnpm dev
```

In the browser (using the left rail to switch, since the strip isn't built yet):
- **Acceptance #1 (lossless switch):** Open pattern A from the rail. Scroll down and place the cursor mid-document. Open B from the rail, then A again — A's cursor, scroll, and selection are exactly where they were.
- **Acceptance #2 (per-tab undo):** Edit A. Switch to B. Press `Cmd/Ctrl+Z` — it does nothing to A's text and does not dump A's content into B. Switch back to A; `Cmd+Z` undoes A's last edit.
- Re-confirm acceptance #3 quickly (profile + font survive a rail switch).

If undo bleeds across tabs, the swap is sharing one `EditorState` — confirm `captureTabState`/`installTabState` are doing a real `setState` of distinct states.

- [ ] **Step 7: Stop and report**

Report: controller wired; `onSelect` replaced with open-or-focus; acceptance #1, #2, #3 verified in-app via the rail. Confirm that completions / hover docs / autosave / bank-detect all still work after a rail switch (they are inherited from the live state by `freshTabState`, so they should — call it out explicitly as evidence). Suggested commit message:
`feat(tabs): open-set controller + lossless switch flow, replacing onSelect`.

---

## Task 4: The tab strip UI

Build the visible strip above the editor, wired to the controller. Functional behavior only — visual + motion craft is deferred to /impeccable → /polish → /animate (Task 8).

**Files:**

- Create: `src/ui/tab-strip.js`
- Create: `src/styles/tab-strip.css`
- Modify: `index.html` (add the slot)
- Modify: `src/main.js` (mount the strip; wire `onAfterSwitch` to repaint)
- Modify: the styles entry (import `tab-strip.css`)

- [ ] **Step 1: Add the slot to index.html**

Add a `<div id="tab-strip" class="tab-strip" role="tablist" aria-label="Open patterns"></div>` directly above the editor canvas element (`#editor`). Match the existing shell structure — locate `#editor` in `index.html` and insert the strip as its immediate preceding sibling within the editor canvas region.

- [ ] **Step 2: Implement the tab strip component**

Create `src/ui/tab-strip.js`:

```js
// Pattern tab strip — the working set, above the editor. A view over the
// open-set controller (src/tabs.js); it renders state and routes gestures,
// it does not own state. See design/work/26-pattern-tabs.md §"Tab strip UI".
//
// Functional behavior only; visual + motion craft is deferred to
// /impeccable → /polish → /animate.

import { makeIcon } from "./icons.js";

// Strip leading numeric prefixes for display, mirroring left-rail prettyName.
function prettyName(raw) {
  const stripped = raw.replace(/^[a-zA-Z]*\d+[a-zA-Z]*-/, "");
  const spaced = stripped.replace(/[-_]/g, " ");
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase()).trim() || raw;
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container       the #tab-strip element
 * @param {() => string[]} opts.getOpenItems
 * @param {() => string|null} opts.getActiveItem
 * @param {() => string|null} opts.getPlayingItem
 * @param {() => Set<string>} opts.getDirtySet  shipped names with working copies
 * @param {(name:string)=>boolean} opts.isUser  user pattern (no dirty dot)
 * @param {(name:string)=>void} opts.onFocus
 * @param {(name:string)=>void} opts.onClose
 * @param {(name:string, toIndex:number)=>void} opts.onReorder
 */
export function mountTabStrip(opts) {
  const {
    container,
    getOpenItems,
    getActiveItem,
    getPlayingItem,
    getDirtySet,
    isUser,
    onFocus,
    onClose,
    onReorder,
  } = opts;
  if (!container) throw new Error("tab-strip.mount: container is required");

  container.replaceChildren();

  let dragName = null;

  function render() {
    container.replaceChildren();
    const open = getOpenItems();
    const active = getActiveItem();
    const playing = getPlayingItem();
    const dirty = getDirtySet();

    if (open.length === 0) {
      const empty = el("div", "tab-strip__empty", "No open patterns — open one from the library");
      container.appendChild(empty);
      return;
    }

    open.forEach((name, index) => {
      const tab = el("div", "tab-strip__tab");
      tab.setAttribute("role", "tab");
      tab.setAttribute("tabindex", "0");
      tab.dataset.name = name;
      tab.draggable = true;
      if (name === active) {
        tab.classList.add("is-active");
        tab.setAttribute("aria-selected", "true");
      }
      if (name === playing) tab.classList.add("is-playing");

      // Playing marker (subtle; visual treatment via craft).
      if (name === playing) {
        const mark = el("span", "tab-strip__playing-mark");
        mark.setAttribute("aria-hidden", "true");
        tab.appendChild(mark);
      }

      const label = el("span", "tab-strip__label", prettyName(name));
      tab.appendChild(label);

      // Dirty dot — Demos only (user patterns have no shipped original).
      if (!isUser(name) && dirty.has(name)) {
        const dot = el("span", "tab-strip__dirty-dot");
        dot.title = "Modified";
        dot.setAttribute("aria-hidden", "true");
        tab.appendChild(dot);
      }

      const close = el("button", "tab-strip__close");
      close.type = "button";
      close.setAttribute("aria-label", `Close ${prettyName(name)}`);
      close.appendChild(makeIcon("x", { size: 12 }));
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        onClose(name);
      });
      tab.appendChild(close);

      tab.addEventListener("click", () => onFocus(name));
      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFocus(name); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); onClose(name); }
      });

      // Drag to reorder.
      tab.addEventListener("dragstart", (e) => {
        dragName = name;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", name);
      });
      tab.addEventListener("dragover", (e) => {
        if (dragName == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      tab.addEventListener("drop", (e) => {
        if (dragName == null) return;
        e.preventDefault();
        onReorder(dragName, index);
        dragName = null;
      });
      tab.addEventListener("dragend", () => { dragName = null; });

      container.appendChild(tab);
    });

    // Auto-scroll the focused tab into view (overflow handling; craft picks
    // the exact mechanism, this guarantees reachability).
    requestAnimationFrame(() => {
      const activeTabEl = container.querySelector(".tab-strip__tab.is-active");
      if (activeTabEl) activeTabEl.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  }

  render();
  return { render };
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
```

- [ ] **Step 3: Add structural styling**

Create `src/styles/tab-strip.css` with **token-based structural** rules only — no hex, no easings, no magic pixel craft. Use existing tokens (`--space-*`, `--radius-*`, greyscale + accent, the two elevation levels) and the project's motion grammar variables if present. Structure:

```css
.tab-strip {
  display: flex;
  align-items: stretch;
  gap: var(--space-1, 4px);
  overflow-x: auto;
  scrollbar-width: thin;
  /* full editor width; sits directly above #editor */
}
.tab-strip__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1, 4px);
  padding: var(--space-1, 4px) var(--space-2, 8px);
  border-radius: var(--radius-1, 4px) var(--radius-1, 4px) 0 0;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.tab-strip__tab.is-active { /* focused emphasis — craft refines */ }
.tab-strip__tab.is-playing { /* playing marker visibility — craft refines */ }
.tab-strip__close { display: inline-flex; opacity: 0; }
.tab-strip__tab:hover .tab-strip__close,
.tab-strip__tab.is-active .tab-strip__close { opacity: 1; }
.tab-strip__dirty-dot { width: 6px; height: 6px; border-radius: 50%; }
.tab-strip__empty { padding: var(--space-2, 8px); opacity: 0.6; }
```

Import it from the styles entry (find where `left-rail.css` is imported — add `tab-strip.css` alongside).

- [ ] **Step 4: Mount the strip in main.js + repaint on switch**

In `src/main.js`:

```js
import { mountTabStrip } from "./ui/tab-strip.js";

const tabStrip = mountTabStrip({
  container: document.getElementById("tab-strip"),
  getOpenItems: () => tabs.getOpenItems(),
  getActiveItem: () => tabs.getActiveItem(),
  getPlayingItem: () => tabs.getPlayingItem(),
  getDirtySet: () => computeDirtySet(patternNames, patterns, store),
  isUser: (name) => !(name in patterns),
  onFocus: (name) => tabs.openOrFocus(name),
  onClose: (name) => tabs.close(name),
  onReorder: (name, toIndex) => tabs.reorder(name, toIndex),
});
```

Wire the controller's `onAfterSwitch` to repaint the strip. Update the `createTabController({ ... })` call's `onAfterSwitch` to `() => tabStrip.render()`. (The controller is built before the strip; resolve the order by assigning `onAfterSwitch` via a late-bound closure: pass `onAfterSwitch: () => tabStrip?.render()` and declare `tabStrip` with `let` hoisted, or set the strip's render as a post-construction hook. Simplest: declare `let tabStrip;` before `createTabController`, pass `onAfterSwitch: () => tabStrip?.render()`, then assign `tabStrip = mountTabStrip(...)` after.)

Also repaint the strip after autosave changes the dirty set: in the autosave path, the dirty dot is already pushed to the left rail via `updateDirtySet`; add a `tabStrip?.render()` wherever `leftRail.updateDirtySet(...)` / `refreshRail()` is called so the tab dirty dot stays in sync. (Minimal: call `tabStrip?.render()` inside `refreshRail()` and after the autosave `updateDirtySet`.)

- [ ] **Step 5: Build + verify**

```bash
pnpm build
pnpm dev
```

Verify:
- The strip shows the open tabs; the migrated active tab is focused on load.
- Clicking a tab focuses it (lossless — re-check cursor/scroll on a return).
- Clicking a rail item opens-or-focuses a tab in the strip.
- The close affordance closes a tab; closing the focused tab focuses the neighbor; closing the last tab shows the empty state.
- Dragging a tab reorders it; the order persists across reload.
- A modified Demo shows a dirty dot on its tab; a modified user pattern does not (acceptance #10).

- [ ] **Step 6: Stop and report**

Report: tab strip mounted and wired; open/focus/close/reorder/empty-state/dirty-dot all functional; acceptance #1 (re-verified via strip click) and #10 confirmed. Note the styling is structural-only, craft deferred. Suggested commit message:
`feat(tabs): tab strip UI wired to open-set controller`.

---

## Task 5: Route create / duplicate / import / capture through open-or-focus

Every path that opens a pattern must route through the controller's `openOrFocus`, not a hard `setCode`. The create/duplicate/import/capture helpers currently call `setCurrentName` + `editor.setCode` (via `saveNewPattern`, `showMidiImportDialog`, `handleCaptureClick`). Make them open-or-focus the target instead.

**Files:**

- Modify: `src/main.js` (thread the controller into the helper call sites)

- [ ] **Step 1: Identify the setCode cuts in the open paths**

Run:

```bash
grep -n "editor.setCode\|setCurrentName" /Users/ben/Projects/strasbeat/src/main.js
grep -rn "editor.setCode" /Users/ben/Projects/strasbeat/src/patterns.js /Users/ben/Projects/strasbeat/src/capture.js /Users/ben/Projects/strasbeat/src/ui/midi-import-dialog.js
```

Catalogue the call sites: `saveNewPattern` (in `patterns.js`) does `editor.setCode(code)` after `setCurrentName`; `handleCaptureClick` (`capture.js`) and `showMidiImportDialog` (`midi-import-dialog.js`) follow the same `setCurrentName` + `setCode` shape.

- [ ] **Step 2: Provide an open-or-focus seam these helpers can call**

The cleanest non-invasive approach: after each helper creates a pattern and updates the store + rail, have **main.js** call `tabs.openOrFocus(name)` for the resulting name, instead of relying on the helper's internal `setCode`. Since the helpers are invoked from `main.js` callbacks (`onCreate`, `onDuplicate`, `onImportMidi`, capture button), wrap each so that on success it opens-or-focuses.

For the create path (`onCreate` → `handleNewPatternClick`): `handleNewPatternClick` calls `saveNewPattern` which calls `editor.setCode`. Rather than have it cut, pass a hook. The lowest-risk change that honors "no setCode cut": after `handleNewPatternClick` resolves, the new pattern is the store's `lastOpen`; call `tabs.openOrFocus(store.getIndex().lastOpen)`. Since `handleNewPatternClick` is `async`, await it:

```js
onCreate() {
  handleNewPatternClick({ /* ...existing args... */ }).then(() => {
    const created = store.getIndex().lastOpen;
    if (created) tabs.openOrFocus(created);
  });
},
```

This re-focuses through the swap path; the helper's internal `editor.setCode` becomes a harmless no-op precursor (the subsequent `openOrFocus` swaps to a fresh state seeded from the just-written working copy). **However**, to avoid a double-eval/visual flicker, prefer the cleaner fix: have `saveNewPattern` accept an optional `openPattern(name)` callback and call it INSTEAD of `editor.setCode` when provided. Add `openPattern` to `saveNewPattern`'s args, and in the `setCode` line:

```js
// in saveNewPattern, replace `editor.setCode(code);` with:
if (openPattern) openPattern(name);
else editor.setCode(code);
```

Thread `openPattern: (name) => tabs.openOrFocus(name)` from `main.js` through `handleNewPatternClick`, `handleDuplicateClick`, and `handleBulkDuplicateClick` (they all funnel through `saveNewPattern`). This is a small, surgical edit to `patterns.js` and the call sites. **Note for the agent:** `patterns.js` is fair game (not off-limits). Make this edit; do not add a back-compat shim — replace the behavior.

- [ ] **Step 3: Route MIDI import + capture**

`showMidiImportDialog` (`midi-import-dialog.js`) and `handleCaptureClick` (`capture.js`) also do `setCurrentName` + `setCode`. Apply the same `openPattern` seam: add an optional `openPattern(name)` arg to each, call it instead of `editor.setCode` when provided, and thread `openPattern: (name) => tabs.openOrFocus(name)` from the `openMidiImportDialog` helper and the capture button handler in `main.js`. (Both files are fair game per the spec — the capture *handler* logic and the MIDI *translation* pipeline are untouched; we only change how the resulting pattern is opened.)

**Scope check:** the spec lists "MidiBridge setup + capture handler" as off-limits. The off-limits item is `midi-bridge.js` (the Web MIDI → superdough trigger path) and the capture *handler's recording logic* — NOT the post-save "open the new pattern" UI step. Changing how a freshly-saved capture is *opened* (swap vs hard setCode) is the tab feature's job and is fair game. If the agent finds the only way to route capture is to edit `midi-bridge.js`, STOP — that's a scope error.

- [ ] **Step 4: Build + verify acceptance #8**

```bash
pnpm build
pnpm dev
```

Verify **acceptance #8 (open-or-focus everywhere)**:
- Click a rail item → opens-or-focuses a tab (no hard cut; cursor of an already-open tab is preserved).
- Create a new pattern → a tab opens for it and is focused.
- Duplicate a pattern → a tab opens for the duplicate.
- Import a MIDI file → a tab opens for the imported pattern.
- Save a MIDI capture → a tab opens for the captured pattern.
- In each case, an already-open target focuses its existing tab rather than spawning a duplicate.

- [ ] **Step 5: Stop and report**

Report: create/duplicate/import/capture routed through `openPattern`→`openOrFocus`; acceptance #8 verified. Note exactly which files got the `openPattern` seam. Suggested commit message:
`feat(tabs): route create/duplicate/import/capture through open-or-focus`.

---

## Task 6: The hybrid playing layer — playingItem on evaluate, now-playing chip, orphan-and-reopen

Implement the spec's hybrid model: transport targets the focused tab; evaluating sets `playingItem = activeItem`; a now-playing chip names the playing tab (with a jump when playing ≠ focused, and a "(closed)" orphan state); Stop / scheduler-idle clears it.

**Files:**

- Modify: `src/ui/transport.js` (add the now-playing chip)
- Modify: `src/main.js` (set `playingItem` on every evaluate; wire chip; clear on idle/stop)

- [ ] **Step 1: Add the now-playing chip to the transport**

In `src/ui/transport.js`, add a chip sibling to the bank chip. Inside `mountTransport`, after the bank chip block (L68-73), add:

```js
const nowPlayingChipEl = document.createElement("button");
nowPlayingChipEl.type = "button";
nowPlayingChipEl.className = "transport__now-playing-chip";
nowPlayingChipEl.hidden = true;
nowPlayingChipEl.addEventListener("click", () => onNowPlayingClick?.());
rightGroupEl.insertBefore(nowPlayingChipEl, midiPillEl);
```

Add `onNowPlayingClick = null` to the destructured `mountTransport` params. Add a `setNowPlaying` function and export it in the returned object:

```js
// Show/hide the now-playing chip. When the playing tab IS the focused tab
// (or nothing is playing), the chip is quiet/absent. When they differ, the
// chip names the playing pattern and acts as a one-click jump. When the
// playing pattern was closed, it shows a "(closed)" marker (orphan state).
// Visual treatment is deferred to craft; this owns the text + visibility.
function setNowPlaying(info) {
  // info: null | { name: string, isFocused: boolean, isOrphan: boolean }
  if (!info || info.isFocused) {
    nowPlayingChipEl.hidden = true;
    nowPlayingChipEl.removeAttribute("data-orphan");
    return;
  }
  nowPlayingChipEl.hidden = false;
  nowPlayingChipEl.dataset.orphan = info.isOrphan ? "true" : "false";
  nowPlayingChipEl.textContent = info.isOrphan ? `${info.name} (closed)` : info.name;
  nowPlayingChipEl.title = info.isOrphan
    ? `Still playing "${info.name}" (closed) — click to reopen`
    : `Playing "${info.name}" — click to jump`;
}
```

Add structural CSS to `src/styles/tab-strip.css` (or wherever the bank chip is styled — match it) for `.transport__now-playing-chip` and its `[data-orphan="true"]` variant. Token-based only; craft refines.

- [ ] **Step 2: Set playingItem on every evaluate**

Evaluation happens via three entry points: the Play button (`playBtn` click → `editor.evaluate()`), `Cmd/Ctrl+Enter` (the editor keymap → `editor.evaluate()`), and the `repl-evaluate` custom event (vim/emacs). All converge on `editor.evaluate()`. The reliable hook: set `playingItem` whenever the focused tab is evaluated. Wire it at all convergence points in `main.js`:

a) Play button handler (L1188): after `await editor.evaluate()`, add `tabs.setPlaying(tabs.getActiveItem()); refreshNowPlaying();`.

b) The `repl-evaluate` listener (L1079): `document.addEventListener("repl-evaluate", () => { editor.evaluate(); tabs.setPlaying(tabs.getActiveItem()); refreshNowPlaying(); });`

c) `Cmd/Ctrl+Enter`: this fires through StrudelMirror's own eval keymap → `onEvaluate: () => this.evaluate()`. There's no main.js hook on that path directly. Use the transport's `onPlaybackStateChange` (which fires when the visible state transitions to `playing`) as the catch-all: when state becomes `playing`, set `playingItem = activeItem` if not already set. Wire it in the existing `onPlaybackStateChange` callback passed to `mountTransport` (L813):

```js
onPlaybackStateChange: (s) => {
  bottomModes.setPlaybackState(s);
  beatGrid?.setPlaybackState(s);
  if (s === "playing" && tabs.getPlayingItem() == null && tabs.getOrphanedPlaying() == null) {
    tabs.setPlaying(tabs.getActiveItem());
  }
  if (s === "idle") {
    tabs.clearPlaying();
  }
  refreshNowPlaying();
},
```

This single hook covers Cmd+Enter, Play, and repl-evaluate for *setting* on transition to playing, and *clearing* on idle (Stop). Keep the explicit `setPlaying` calls in (a)/(b) too — they make ownership transfer immediate when switching which tab plays without an idle in between (Play B while A plays: state stays `playing`, so the idle-clear won't fire; the explicit `setPlaying(activeItem)` in the Play handler transfers ownership).

d) Define `refreshNowPlaying()` in `main.js`:

```js
function refreshNowPlaying() {
  const playing = tabs.getPlayingItem();
  const orphan = tabs.getOrphanedPlaying();
  const active = tabs.getActiveItem();
  if (orphan) {
    transport.setNowPlaying({ name: orphan, isFocused: false, isOrphan: true });
  } else if (playing) {
    transport.setNowPlaying({ name: playing, isFocused: playing === active, isOrphan: false });
  } else {
    transport.setNowPlaying(null);
  }
  tabStrip?.render(); // playing marker on the owning tab
}
```

- [ ] **Step 3: Wire the chip's jump-to-playing + reopen**

Pass `onNowPlayingClick` to `mountTransport`:

```js
onNowPlayingClick: () => {
  const target = tabs.getOrphanedPlaying() ?? tabs.getPlayingItem();
  if (target) tabs.openOrFocus(target); // reopens if orphaned, focuses if open
  refreshNowPlaying();
},
```

`openOrFocus` already clears the orphan into `playingItem` when reopening (Task 3 logic) and re-adds it to `openTabs`. After the jump, the chip goes quiet (playing === focused).

e) Call `refreshNowPlaying()` once after the controller + transport + strip are all constructed so the initial state is correct (chip hidden when nothing plays).

- [ ] **Step 4: Build + verify acceptance #4, #5, #6**

```bash
pnpm build
pnpm dev
```

Click the page once to allow audio, then verify:
- **Acceptance #4 (audio never cut by navigation):** Play A. Switch to B — A keeps sounding. The now-playing chip shows A and offers a jump; clicking it focuses A. Press Play on B — ownership transfers, B sounds, A stops.
- **Acceptance #5 (transport targets focused tab):** With A playing and B focused, `Cmd/Ctrl+Enter` evaluates B (not A) and transfers ownership to B.
- **Acceptance #6 (close-while-playing orphan):** Play A, then close A's tab — audio continues, the chip shows `A (closed)`, and clicking the chip reopens A's tab. Stop clears the chip.

- [ ] **Step 5: Stop and report**

Report: hybrid playing layer wired; now-playing chip with jump + orphan; acceptance #4, #5, #6 verified in-app. Suggested commit message:
`feat(tabs): hybrid playing ownership + now-playing chip + orphan-and-reopen`.

---

## Task 7: Reconciliation with rail operations (delete / rename / revert)

The open set must reconcile with the rail's delete/rename/revert. These handlers already exist in `main.js` (`renamePatternHandler`, `deleteMany`/`onDelete`, `onRevert`, `deleteFolderHandler`). Make each one update the controller.

**Files:**

- Modify: `src/main.js` (hook the controller into the existing reconciliation handlers)

- [ ] **Step 1: Delete reconciliation**

Find the deletion handlers: the rail's `onDelete(name)` (L769), `deleteMany(names)` (L605), and `deleteFolderHandler`'s "delete folder and all patterns" branch (L511-525). After each store deletion + index update, for every deleted name that is open: `tabs.close(name)`. Insert after the store/index mutation and before/around the existing `refreshRail()`:

```js
// (onDelete, single)
for (const n of [name]) if (tabs.getOpenItems().includes(n)) tabs.close(n);
```

```js
// (deleteMany)
for (const n of userNames) if (tabs.getOpenItems().includes(n)) tabs.close(n);
```

```js
// (deleteFolderHandler delete-all branch)
for (const n of inFolder) if (tabs.getOpenItems().includes(n)) tabs.close(n);
```

`tabs.close` already: removes from `openTabs`, evicts the cache, focuses the neighbor if it was focused, and orphans playback if it was the playing tab (acceptance #6 already covers the deleted-while-playing case; `orphanedPlaying` holds the name even though it can't be reopened — Stop clears it, matching the spec). Because `tabs.close` re-focuses through the swap path, the existing manual `setCurrentName(fallback) + editor.setCode(patterns[fallback])` fallback logic in these handlers becomes redundant for the open-tab case — **remove that manual fallback** where `tabs.close` now handles focus (the controller focuses a real neighbor or the empty state). Keep the store/index deletion logic intact. After the loop, call `refreshNowPlaying()` and `tabStrip?.render()`.

- [ ] **Step 2: Rename reconciliation**

In `renamePatternHandler(oldName, newName)` (L652): after the successful `store.renamePatternKey` + index update, add `tabs.reKey(oldName, newName);`. `reKey` re-keys the open item in place (preserving order, focus, cached undo state) and updates `playingItem`/`orphanedPlaying` if they matched. The existing `if (currentName === oldName) setCurrentName(newName)` line is now also handled by `reKey` (it updates `activeItem` and the controller's `onAfterSwitch` repaints) — but `setCurrentName` also updates the wordmark + rail highlight, which `reKey` does NOT call. Keep the `setCurrentName(newName)` call. Add `refreshNowPlaying(); tabStrip?.render();` after.

- [ ] **Step 3: Revert reconciliation**

In the rail's `onRevert(name)` (L758): reverting resets the Demo working copy to the shipped original. After `store.delete(name)` + `editor.setCode(patterns[name])`, the open tab must get a **fresh** `EditorState` seeded from the reverted code (the spec: document identity changes wholesale → fresh state with empty undo + cleared dirty dot). Replace the body so that if the pattern is open:

```js
onRevert(name) {
  store.delete(name);
  lastDirtyState.delete(name);
  if (tabs.getOpenItems().includes(name)) {
    tabs.evictState(name);            // drop cached state
    if (tabs.getActiveItem() === name) {
      // Force a fresh state from the reverted working copy by re-focusing.
      // Re-focus path: temporarily clear active so focus() rebuilds.
      clearError(editor.editor);
      evalFeedback?.resetRuntimeErrors();
      tabs.openOrFocus(name);         // rebuilds fresh (cache was evicted)
    }
  } else if (currentName === name) {
    clearError(editor.editor);
    evalFeedback?.resetRuntimeErrors();
    editor.setCode(patterns[name]);
  }
  refreshRail();
  tabStrip?.render();
  transport.setStatus(`reverted "${name}" to original`);
},
```

**Subtlety:** `tabs.openOrFocus(name)` early-returns inside `focus()` if `activeItem === name` (no-op for the same tab). To force a rebuild on revert, after `evictState`, the active tab still equals `name`, so `focus` won't re-run. Handle this in the controller: add a `refresh(name)` method that, for the active item, rebuilds and reinstalls its state from the current working copy (used by revert). Add to `src/tabs.js`'s controller:

```js
// Rebuild + reinstall the active tab's state from its current working copy.
// Used by revert (document identity changed wholesale → fresh, empty undo).
function refresh(name) {
  evictState(name);
  if (activeItem === name) {
    const state = buildState({ name, code: codeFor(name), fresh: true });
    stateCache.set(name, state);
    installState(state);
    onAfterSwitch(name);
  }
}
```

Export `refresh` from the controller and use `tabs.refresh(name)` instead of `tabs.openOrFocus(name)` in the revert handler. Add a controller test for it:

```js
test("refresh rebuilds the active tab state from the working copy", () => {
  const { ctl, events } = makeHarness({ openTabs: ["a"], activeTab: "a" });
  ctl.hydrate();
  const before = events.installed.length;
  ctl.refresh("a");
  assert.ok(events.installed.length > before, "installState called on refresh");
});
```

- [ ] **Step 4: Run controller tests + build + verify acceptance #7**

```bash
node --import ./scripts/test-register.mjs --test src/tabs.test.js 2>&1 | tail -20
pnpm build
pnpm dev
```

Verify **acceptance #7 (reconciliation)** with a pattern open in a tab:
- Deleting it closes the tab and focuses a neighbor.
- Renaming it relabels the tab in place (order, focus, and undo preserved — edit, rename, undo still works on the renamed tab).
- Reverting a Demo keeps the tab open with reverted code and a cleared dirty dot (and a fresh, empty undo stack — Cmd+Z does nothing immediately after revert).
- Moving a pattern between folders has NO effect on its tab (spec: folder is organization, not identity).

- [ ] **Step 5: Stop and report**

Report: delete/rename/revert reconciled with the open set; `refresh` added for revert; acceptance #7 verified. Suggested commit message:
`feat(tabs): reconcile delete/rename/revert with the open set`.

---

## Task 8: Persistence + migration verification, command-palette tab actions, and the craft finishing pass

Close out the remaining Core acceptance items (#9 persistence/migration), add the stretch-adjacent palette actions (next/prev/close tab — these are Core per spec §"Keyboard"), then run the deferred craft skills as the visual-quality gate.

**Files:**

- Modify: `src/command-palette-actions.js`, `src/ui/command-palette.js` (tab nav actions)
- Modify: `src/main.js` (wire palette tab actions)
- No code edits for the craft pass — it's a skill-driven finishing pass on `src/ui/tab-strip.js` + `src/styles/tab-strip.css` + the now-playing chip.

- [ ] **Step 1: Verify persistence + migration (acceptance #9)**

```bash
pnpm dev
```

- Open three patterns, focus the middle one, reload → the same three tabs reopen in order with the middle one focused.
- Simulate a legacy user: in devtools, set the index to have only `lastOpen` and no `uiState.openTabs`:
  ```js
  const k = "strasbeat:pattern-index";
  const idx = JSON.parse(localStorage.getItem(k));
  delete idx.uiState?.openTabs; delete idx.uiState?.activeTab;
  idx.lastOpen = "05-dub";
  localStorage.setItem(k, JSON.stringify(idx));
  location.reload();
  ```
  → boots with exactly one tab open (`05-dub`), focused. (This exercises `migrateOpenSet`.)

If either fails, fix `migrateOpenSet` / `writeOpenSet` wiring (the unit tests in Task 1 should already cover the logic; the failure would be in the boot hydrate path).

- [ ] **Step 2: Add command-palette tab actions**

In `src/command-palette-actions.js`, add three handler keys to the `buildCommands({ ... })` call:

```js
onNextTab: () => onNextTab?.(),
onPrevTab: () => onPrevTab?.(),
onCloseActiveTab: () => onCloseActiveTab?.(),
```

and add `onNextTab`, `onPrevTab`, `onCloseActiveTab` to `buildPaletteCommands`'s destructured params. In `src/ui/command-palette.js`'s `buildCommands`, register three palette items (match the existing item shape — label + the handler key), e.g. labels "Next tab", "Previous tab", "Close tab".

In `src/main.js`, where `buildPaletteCommands({ ... })` is called (L1088), pass:

```js
onNextTab: () => {
  const open = tabs.getOpenItems(); const a = tabs.getActiveItem();
  if (open.length < 2) return;
  const i = open.indexOf(a);
  tabs.openOrFocus(open[(i + 1) % open.length]);
},
onPrevTab: () => {
  const open = tabs.getOpenItems(); const a = tabs.getActiveItem();
  if (open.length < 2) return;
  const i = open.indexOf(a);
  tabs.openOrFocus(open[(i - 1 + open.length) % open.length]);
},
onCloseActiveTab: () => {
  const a = tabs.getActiveItem();
  if (a) tabs.close(a);
},
```

(Dedicated chord bindings are deferred to the keybindings override system — specs 21/23 — per the spec's §"Keyboard". Do NOT hard-code chords here.)

- [ ] **Step 3: Build + verify palette actions**

```bash
pnpm build
pnpm dev
```

- Open `Cmd+Shift+P`, run "Next tab" / "Previous tab" → focus cycles through open tabs (lossless).
- Run "Close tab" → closes the focused tab, focuses the neighbor.

- [ ] **Step 4: Full Core acceptance re-run**

Walk the spec's Core acceptance list 1-10 once more end-to-end in the running app and confirm each holds (lossless switch, per-tab undo, config-survives-swap tripwire, audio-never-cut, transport-targets-focused, close-while-playing orphan, reconciliation, open-or-focus-everywhere, persistence+migration, dirty-dot parity). Note any regressions and fix before the craft pass.

- [ ] **Step 5: Craft finishing pass — /impeccable (visual-quality gate), then /polish, then /animate**

The spec defers ALL concrete visual + motion craft (hexes, easings, pixel heights, tab widths, overflow mechanism look, hover-reveal treatment, focused/playing emphasis, the now-playing chip's exact form). Run the craft skills as the finishing pass on the tab strip + now-playing chip:

1. **`/impeccable craft`** — the primary visual-quality gate. Shape the tab strip, the focused/playing emphasis, the close affordance, the overflow handling, and the now-playing chip against the project design context (SYSTEM.md tokens: greyscale + one accent, `--space-*`, `--radius-*`, two elevation levels; match the right-rail tab bar (spec 08) and bottom-panel mode bar (spec 14) grammar). This is where the "state of the art, refined & polished" bar is met. **Resolve the spec's two open questions here:**
   - Closing the last tab — lean: allow empty with a clean empty state (already implemented in Task 4); confirm the empty state reads well.
   - Now-playing chip placement — lean: transport bar for the chip text + jump (implemented in Task 6), plus the subtle per-tab playing marker in the strip; confirm the division of labor looks right.
2. **`/polish`** — final alignment, spacing, consistency, micro-detail pass before shipping.
3. **`/animate`** — purposeful motion for tab switch, open, close, reorder, and the chip's appearance, within SYSTEM.md's motion grammar (200ms panel `cubic-bezier(0.16,1,0.3,1)`, 120ms hover ease-out, no spring physics, no ambient idle animation, motion explains change).

Optionally **`/clarify`** for the quieter status-line copy (a switch is no longer a "load") and the now-playing chip microcopy.

These skills edit `src/ui/tab-strip.js`, `src/styles/tab-strip.css`, and the now-playing chip styling/markup only — they do not change the open-set logic, the controller, or the factory.

- [ ] **Step 6: Stop and report**

Report: acceptance #9 verified; palette tab actions added; full Core acceptance (1-10) re-confirmed; craft pass complete (note which skills ran and what changed). Suggested commit messages:
`feat(tabs): command-palette next/prev/close tab actions` and a separate `style(tabs): impeccable + polish + animate finishing pass`.

---

## Self-Review (run by the plan author; recorded for the executor)

**Spec coverage** — each Core acceptance criterion maps to a task:

1. Lossless switch → Task 3 (Step 6) + Task 4 (Step 5).
2. Per-tab undo, no cross-bleed → Task 3 (Step 6).
3. Config survives the swap (tripwire) → **Task 2 (Step 6), the gate before any UI**.
4. Audio never cut by navigation → Task 6 (Step 4).
5. Transport targets the focused tab → Task 6 (Step 4).
6. Close-while-playing orphan → Task 6 (Step 4) + controller logic Task 3.
7. Reconciliation (delete/rename/revert) → Task 7.
8. Open-or-focus everywhere → Task 5.
9. Persistence + migration → Task 1 (unit) + Task 8 (Step 1, in-app).
10. Dirty-dot parity → Task 4 (Step 5).

Design-model coverage: `uiState.openTabs`/`activeTab` (Task 1); open-set controller with generic `openItems`/`activeItem` forward-compat seam (Task 3); `stateCache` (Task 3); the single config factory + live-compartment injection (Task 2); switch flow flush→cache→install→relabel→persist (Task 3); hybrid playing model + now-playing chip + orphan (Task 6); no track UI rendered (nothing in any task adds mute/solo/badges).

Stretch items (keyboard reorder, close-others/close-right, middle-click) are intentionally NOT planned — spec marks them "can land later."

**Off-limits guardrails:** No task edits `@strudel/*` source, `boot.js`, `export.js`, `midi-bridge.js`, `share.js` internals, `window.*`, `vite.config.js`, or `strudel-source/`. The factory *imports from* `@strudel/codemirror` (and possibly its subpaths) — imports, not edits. Task 5 explicitly flags the capture/MIDI scope boundary (post-save open is fair game; the bridge/handler recording logic is not).

**Type/name consistency:** controller methods are referenced consistently across tasks — `openOrFocus`, `close`, `reorder`, `reKey`, `evictState`, `refresh`, `setPlaying`, `clearPlaying`, `getOpenItems`, `getActiveItem`, `getPlayingItem`, `getOrphanedPlaying`, `hydrate`, `persist`. Swap-mechanism exports: `freshTabState`, `readLiveCompartments`. editor-setup export added: `strasbeatOverlayCompartment` (made public). Store helpers: `readOpenSet`, `writeOpenSet`, `migrateOpenSet`. Transport: `setNowPlaying` + `onNowPlayingClick`. The controller is mechanism-agnostic — it calls injected `buildState`/`installState`/`captureState`, so the snapshot-and-restore vs. rebuild choice lives entirely in `main.js`'s wiring (Task 3 Step 5) and `build-editor-state.js`.

**Aesthetics:** no hex/easing/pixel craft baked into implementation tasks — structural CSS uses tokens with fallbacks; all concrete visual/motion choices deferred to the Task 8 craft pass with /impeccable named as the gate. The two spec open questions are carried as craft-time notes with their stated leans, not blocking decisions.
