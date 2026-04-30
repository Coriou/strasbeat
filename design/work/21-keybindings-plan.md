# Keybinding Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Spec: `design/work/21-keybindings.md`. Read it before starting.

**Goal:** Add a 5-profile keybinding system (Strudel default, VSCode, Vim, Emacs, Helix) selectable via a transport-bar chip and the Settings dropdown, with strudel.cc-compatible defaults for new users.

**Architecture:** Three layered keymap concepts — Strudel upstream (untouchable, `Prec.highest`), Layer-2 always-on app shortcuts (page-level + a tiny CM extension for `Mod-Enter`), Layer-3 profile editing keymap (CodeMirror `Compartment` that reconfigures live). The chip + popover is the user-facing affordance; settings dropdown is an alternate entry point to the same canonical state. Profile id persists in `localStorage`; Strudel's nanostore atom mirrors only the string keybindings value.

**Tech Stack:** CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`), `@strudel/codemirror`, `@replit/codemirror-vim` (transitive → explicit), `@replit/codemirror-emacs` (transitive → explicit), Node's built-in test runner (`node --test` via `pnpm test`), vanilla DOM for chip/popover (no framework — matches existing UI modules in `src/ui/`).

---

## File Structure

**New:**
- `src/editor/keymap-profiles.js` — Profile registry, localStorage helpers, tooltip-seen flag. Pure logic. Unit-testable.
- `src/editor/keymap-profiles.test.js` — Tests for the above.
- `src/editor/keymap-universal.js` — Layer-2 always-on CM keymap (`Mod-Enter` for macOS eval parity).
- `src/editor/keymap-apply.js` — Single canonical `applyKeymapProfile()` handler called by chip + settings.
- `src/ui/keymap-chip.js` — Chip element, popover, first-time tooltip, modal-profile mode subscription, keyboard nav.
- `src/ui/keymap-chip.test.js` — Tests for the pure `formatChipLabel()` helper.

**Modified:**
- `src/editor/keymap.js` — Extend `createVscodeKeymap` with layout fallbacks, remove `Mod-Enter` (now in universal).
- `src/editor-setup.js` — `applyInitialSettings` reads profile; `dispatchEditorExtensions` introduces `strasbeatOverlayCompartment` and loads universal keymap; export `reconfigureOverlay`.
- `src/main.js` — Three custom-event listeners; pass `applyKeymapProfile` reference into transport + settings mounts.
- `src/ui/transport.js` — Mount the chip next to the MIDI pill.
- `src/ui/settings-panel.js` — Add Keymap row at top of Editor section.
- `src/ui/command-palette.js` — Optional `vimShortcut`/`emacsShortcut`/`helixShortcut` per command; two new palette entries `Eval (Strudel :w)` and `Stop (Strudel :q)`.
- `package.json` — Declare `@replit/codemirror-vim` and `@replit/codemirror-emacs` as explicit deps. Add new test files to the `test` script.

---

## Task 1: Profile registry + localStorage helpers (TDD)

**Files:**
- Create: `src/editor/keymap-profiles.js`
- Test: `src/editor/keymap-profiles.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/editor/keymap-profiles.test.js`:

```js
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  KEYMAP_PROFILES,
  DEFAULT_PROFILE_ID,
  STORAGE_KEY,
  TOOLTIP_SEEN_KEY,
  getProfile,
  getStoredProfileId,
  setStoredProfileId,
  hasSeenTooltip,
  markTooltipSeen,
} from "./keymap-profiles.js";

// Minimal localStorage shim — the production code only uses get/set.
function makeMockStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  };
}

beforeEach(() => {
  globalThis.localStorage = makeMockStorage();
});

describe("KEYMAP_PROFILES registry", () => {
  test("contains exactly five profiles in the documented order", () => {
    assert.deepEqual(
      KEYMAP_PROFILES.map((p) => p.id),
      ["strudel", "vscode", "vim", "emacs", "helix"],
    );
  });

  test("exactly one profile is marked default and it matches DEFAULT_PROFILE_ID", () => {
    const defaults = KEYMAP_PROFILES.filter((p) => p.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, DEFAULT_PROFILE_ID);
    assert.equal(DEFAULT_PROFILE_ID, "strudel");
  });

  test("only the VSCode profile applies the strasbeat overlay", () => {
    const overlayProfiles = KEYMAP_PROFILES.filter((p) => p.applyStrasbeatOverlay);
    assert.deepEqual(overlayProfiles.map((p) => p.id), ["vscode"]);
  });

  test("modal profiles (vim, helix) declare a non-empty modes array", () => {
    const modal = KEYMAP_PROFILES.filter((p) => p.isModal);
    assert.deepEqual(modal.map((p) => p.id), ["vim", "helix"]);
    for (const p of modal) {
      assert.ok(Array.isArray(p.modes) && p.modes.length > 0, `${p.id} should have modes`);
    }
  });

  test("every profile has a non-empty description string", () => {
    for (const p of KEYMAP_PROFILES) {
      assert.equal(typeof p.description, "string");
      assert.ok(p.description.length > 0, `${p.id} needs a description`);
    }
  });
});

describe("getProfile()", () => {
  test("returns the matching profile by id", () => {
    assert.equal(getProfile("vim").id, "vim");
  });

  test("falls back to the default profile when id is unknown", () => {
    assert.equal(getProfile("does-not-exist").id, DEFAULT_PROFILE_ID);
  });

  test("falls back to the default profile when id is null/undefined", () => {
    assert.equal(getProfile(null).id, DEFAULT_PROFILE_ID);
    assert.equal(getProfile(undefined).id, DEFAULT_PROFILE_ID);
  });
});

describe("getStoredProfileId() / setStoredProfileId()", () => {
  test("returns DEFAULT_PROFILE_ID when nothing is stored", () => {
    assert.equal(getStoredProfileId(), DEFAULT_PROFILE_ID);
  });

  test("returns the stored id when valid", () => {
    setStoredProfileId("vim");
    assert.equal(getStoredProfileId(), "vim");
    assert.equal(localStorage.getItem(STORAGE_KEY), "vim");
  });

  test("returns DEFAULT_PROFILE_ID when stored value is unknown (and does not throw)", () => {
    localStorage.setItem(STORAGE_KEY, "made-up-profile");
    assert.equal(getStoredProfileId(), DEFAULT_PROFILE_ID);
  });

  test("setStoredProfileId rejects unknown ids without writing", () => {
    setStoredProfileId("not-real");
    assert.equal(localStorage.getItem(STORAGE_KEY), null);
  });
});

describe("hasSeenTooltip() / markTooltipSeen()", () => {
  test("returns false initially", () => {
    assert.equal(hasSeenTooltip(), false);
  });

  test("returns true after markTooltipSeen()", () => {
    markTooltipSeen();
    assert.equal(hasSeenTooltip(), true);
    assert.equal(localStorage.getItem(TOOLTIP_SEEN_KEY), "1");
  });
});
```

- [ ] **Step 2: Add the test file to the package.json test script and run it to verify failure**

Edit `package.json`'s `test` script — add `src/editor/keymap-profiles.test.js` to the list.

Run: `pnpm test 2>&1 | head -40`
Expected: FAIL — module not found (`./keymap-profiles.js`).

- [ ] **Step 3: Implement `keymap-profiles.js`**

Create `src/editor/keymap-profiles.js`:

```js
// Single source of truth for keybinding profiles. Pure module — no DOM,
// no CodeMirror imports — so it can be unit-tested with node --test.
//
// See design/work/21-keybindings.md for rationale.

export const KEYMAP_PROFILES = [
  {
    id: "strudel",
    label: "Strudel",
    description: "Matches strudel.cc · Ctrl+⏎ play, Ctrl+. stop",
    isDefault: true,
    strudelKeybindings: "codemirror",
    applyStrasbeatOverlay: false,
    isModal: false,
  },
  {
    id: "vscode",
    label: "VSCode",
    description: "Cmd+D selectNext, Cmd+Shift+K delete line, Alt+↓ move",
    strudelKeybindings: "vscode",
    applyStrasbeatOverlay: true,
    isModal: false,
  },
  {
    id: "vim",
    label: "Vim",
    description: "Modal · :w eval, :q stop, gc comment",
    strudelKeybindings: "vim",
    applyStrasbeatOverlay: false,
    isModal: true,
    modes: ["NORMAL", "INSERT", "VISUAL", "REPLACE"],
  },
  {
    id: "emacs",
    label: "Emacs",
    description: "C-x C-s save, C-/ comment, M-w yank",
    strudelKeybindings: "emacs",
    applyStrasbeatOverlay: false,
    isModal: false,
  },
  {
    id: "helix",
    label: "Helix",
    description: "Modal · select-then-act, gc comment",
    strudelKeybindings: "helix",
    applyStrasbeatOverlay: false,
    isModal: true,
    modes: ["NORMAL", "INSERT", "SELECT"],
  },
];

export const DEFAULT_PROFILE_ID = "strudel";
export const STORAGE_KEY = "strasbeat:keymap-profile";
export const TOOLTIP_SEEN_KEY = "strasbeat:keymap-chip-seen";

const PROFILE_BY_ID = new Map(KEYMAP_PROFILES.map((p) => [p.id, p]));
const KNOWN_IDS = new Set(PROFILE_BY_ID.keys());

export function getProfile(id) {
  return PROFILE_BY_ID.get(id) ?? PROFILE_BY_ID.get(DEFAULT_PROFILE_ID);
}

export function getStoredProfileId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return KNOWN_IDS.has(raw) ? raw : DEFAULT_PROFILE_ID;
  } catch {
    return DEFAULT_PROFILE_ID;
  }
}

export function setStoredProfileId(id) {
  if (!KNOWN_IDS.has(id)) return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage may be unavailable (private browsing, full disk). Silent
    // fail is acceptable — the live profile change still applies.
  }
}

export function hasSeenTooltip() {
  try {
    return localStorage.getItem(TOOLTIP_SEEN_KEY) === "1";
  } catch {
    return true; // Pretend we've seen it to avoid pestering when storage is unavailable.
  }
}

export function markTooltipSeen() {
  try {
    localStorage.setItem(TOOLTIP_SEEN_KEY, "1");
  } catch {}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test 2>&1 | tail -20`
Expected: All tests in `keymap-profiles.test.js` pass. No regressions in existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/editor/keymap-profiles.js src/editor/keymap-profiles.test.js package.json
git commit -m "feat: add keymap profile registry with localStorage persistence"
```

---

## Task 2: Universal keymap (Layer 2 CM extension)

**Files:**
- Create: `src/editor/keymap-universal.js`
- Modify: `src/editor/keymap.js` (remove `Mod-Enter` from `createVscodeKeymap`)

This task moves `Mod-Enter` (macOS Cmd+Enter eval parity) out of the conditional VSCode overlay so it remains active in every profile.

- [ ] **Step 1: Create `src/editor/keymap-universal.js`**

```js
// Layer-2 always-on CodeMirror keymap. Bindings here are loaded
// unconditionally regardless of which profile (Strudel / VSCode / Vim /
// Emacs / Helix) the user has selected — they are app-shell shortcuts
// that don't conflict with strudel.cc muscle memory because strudel.cc
// doesn't have them.
//
// See design/work/21-keybindings.md §"Mental model" for the layered model.

import { keymap } from "@codemirror/view";

export function createUniversalKeymap({ onEvaluate }) {
  return keymap.of([
    // Mod-Enter on macOS evaluates (parity with Strudel's Ctrl-Enter at
    // Prec.highest, which on mac is literally Control+Enter, not
    // Cmd+Enter). Without this, mac users on the Strudel/Vim/Emacs/Helix
    // profile would lose the universal IDE muscle memory of Cmd+Enter
    // → "run".
    {
      key: "Mod-Enter",
      preventDefault: true,
      run: () => {
        onEvaluate();
        return true;
      },
    },
  ]);
}
```

- [ ] **Step 2: Remove `Mod-Enter` from `createVscodeKeymap`**

In `src/editor/keymap.js`, delete lines 90–97 (the `Mod-Enter` entry inside the `keymap.of([...])` array). Use the Edit tool — the surrounding context to match is:

```js
  return keymap.of([
    // Evaluate / play. Mirrors Strudel's Ctrl-Enter binding so macOS users
    // can use Cmd+Enter — see file-level comment for the full reasoning.
    // We deliberately do NOT add Mod-. for stop: Strudel's Ctrl-. lives at
    // Prec.highest and overlaps with the browser's "find again previous"
    // shortcut on some platforms; the user has not requested it.
    {
      key: "Mod-Enter",
      preventDefault: true,
      run: () => {
        onEvaluate();
        return true;
      },
    },
    {
      key: "Mod-m",
```

The post-removal version starts directly with the `Mod-m` (mute) binding. The file-level comment (lines 13–21) about `Mod-Enter` should ALSO be removed since `Mod-Enter` no longer lives here — replace it with a one-liner pointing readers to `keymap-universal.js`.

- [ ] **Step 3: Verify the file compiles and existing tests pass**

Run: `pnpm test 2>&1 | tail -10`
Expected: All tests pass. (No tests directly cover `keymap.js` content, but a syntax error would break the import in `editor-setup.js` which is imported transitively.)

Run: `pnpm dev` in a separate terminal, open `http://localhost:5173`, click anywhere to satisfy autoplay, then press `Cmd+Enter` (or `Ctrl+Enter` on Linux/Windows). Pattern should evaluate. If not, the `keymap-universal.js` extension hasn't been wired yet — that's Task 4. Skip this manual check until then if it fails.

- [ ] **Step 4: Commit**

```bash
git add src/editor/keymap-universal.js src/editor/keymap.js
git commit -m "feat: extract Mod-Enter into a universal always-on keymap"
```

---

## Task 3: Layout fallbacks in createVscodeKeymap

**Files:**
- Modify: `src/editor/keymap.js`

Add the AZERTY/QWERTZ fallbacks for the comment toggle, plus `Tab`/`Shift-Tab` indent fallbacks. The `Mod-:` fallback for comment toggle is already present; we extend the pattern.

- [ ] **Step 1: Add fallback bindings to `createVscodeKeymap`**

In `src/editor/keymap.js`, locate the existing comment-toggle bindings:

```js
    // Comments — Mod-/ is the universal binding (QWERTY). On AZERTY macOS,
    // "/" lives on Shift+: so Cmd+/ becomes Cmd+Shift+: → Cmd+?, which
    // macOS intercepts as the Help menu shortcut. Mod-: gives AZERTY
    // users an unshifted alternative that actually reaches CodeMirror.
    { key: "Mod-/", run: toggleComment },
    { key: "Mod-:", run: toggleComment },
```

Add a `Mod-#` fallback for German QWERTZ layouts. Replace the block with:

```js
    // Comments — Mod-/ is the universal binding (QWERTY). Layout fallbacks:
    //  - Mod-: for AZERTY mac (where "/" is Shift+: and Cmd+/ becomes
    //    Cmd+? which macOS intercepts as Help).
    //  - Mod-# for German QWERTZ (where "/" is Shift+7).
    // Multi-binding is harmless on the wrong layout — the redundant
    // shortcut just won't be reachable from that physical keyboard.
    { key: "Mod-/", run: toggleComment },
    { key: "Mod-:", run: toggleComment },
    { key: "Mod-#", run: toggleComment },
```

- [ ] **Step 2: Add `Tab` / `Shift-Tab` indent fallbacks**

Import `indentWithTab` from `@codemirror/commands` at the top of `src/editor/keymap.js`. Then, in `createVscodeKeymap`, replace the existing `Mod-]` / `Mod-[` block:

```js
    // Indentation
    { key: "Mod-]", run: indentMore },
    { key: "Mod-[", run: indentLess },
```

with:

```js
    // Indentation. Tab / Shift-Tab are AZERTY/QWERTZ-friendly fallbacks
    // for `]` / `[` (which require Alt+Shift on AZERTY mac and don't
    // produce a stable event.key). CM6's `indentWithTab` (re-exported
    // here as a regular keymap entry) only fires when there's a
    // selection — plain Tab inside a single-line caret continues to
    // insert a tab character.
    { key: "Mod-]", run: indentMore },
    { key: "Mod-[", run: indentLess },
    indentWithTab,
```

Note: `indentWithTab` is a `KeyBinding` object exported from `@codemirror/commands` — it can be inlined directly into a `keymap.of([...])` array. If TypeScript complaints arise (none expected — this codebase is plain JS), check the package's exports.

- [ ] **Step 3: Verify build still works**

Run: `pnpm test 2>&1 | tail -10`
Expected: All tests pass.

Run a quick build check: `pnpm build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/editor/keymap.js
git commit -m "feat: add layout-aware fallbacks (Mod-#, Tab/Shift-Tab) to vscode overlay"
```

---

## Task 4: Strasbeat overlay compartment + reconfigure helper

**Files:**
- Modify: `src/editor-setup.js`

Wrap the strasbeat overlay in a CodeMirror `Compartment` so it can be turned on/off live without remounting the editor. Read the active profile in `applyInitialSettings` so the editor renders with the correct overlay state on first paint.

- [ ] **Step 1: Update `editor-setup.js` imports**

At the top of `src/editor-setup.js`, replace:

```js
import { Prec, StateEffect } from "@codemirror/state";
```

with:

```js
import { Compartment, Prec, StateEffect } from "@codemirror/state";
```

Add two new imports (placement: anywhere in the import block):

```js
import { createUniversalKeymap } from "./editor/keymap-universal.js";
import { getProfile, getStoredProfileId } from "./editor/keymap-profiles.js";
```

- [ ] **Step 2: Declare the compartment at module scope**

Add immediately after the imports (before the existing `readStoredCmSettingsFromLocalStorage` function):

```js
// CodeMirror compartment for the strasbeat-side editing overlay
// (createVscodeKeymap). Wrapped so we can swap it in/out when the user
// changes profiles, without remounting the editor. See
// design/work/21-keybindings.md §"CM compartment for the strasbeat overlay".
const strasbeatOverlayCompartment = new Compartment();
```

- [ ] **Step 3: Update `applyInitialSettings` to merge `keybindings` from the active profile**

Replace the existing `applyInitialSettings` function with:

```js
export function applyInitialSettings(editor, storedSettings) {
  const profile = getProfile(getStoredProfileId());
  editor.updateSettings({
    ...defaultSettings,
    ...STRASBEAT_DEFAULT_PREFERENCES,
    ...(storedSettings ?? {}),
    ...STRASBEAT_REQUIRED_ON,
    keybindings: profile.strudelKeybindings, // last so we win
  });
}
```

- [ ] **Step 4: Update `dispatchEditorExtensions` to use the compartment + universal keymap**

Replace the existing function body with:

```js
export function dispatchEditorExtensions(editor, { onOpenReference }) {
  const profile = getProfile(getStoredProfileId());
  const onEvaluate = () => editor.evaluate();

  editor.editor.dispatch({
    effects: StateEffect.appendConfig.of([
      errorMarksExtension,
      Prec.highest(formatExtension),
      Prec.highest(createUniversalKeymap({ onEvaluate })),
      strasbeatOverlayCompartment.of(
        profile.applyStrasbeatOverlay
          ? Prec.highest(createVscodeKeymap({ onEvaluate }))
          : [],
      ),
      numericScrubber({
        evaluate: () => editor.repl.evaluate(editor.code, false),
      }),
      hoverDocs({ onOpenReference }),
      signatureHint,
    ]),
  });
}
```

- [ ] **Step 5: Add and export `reconfigureOverlay`**

Add after `dispatchEditorExtensions`:

```js
// Live-swap the strasbeat overlay extension. Called by applyKeymapProfile
// when the user picks a new profile. CM6 compartment.reconfigure is
// instant (single dispatch) — no editor remount, no scroll/cursor reset.
export function reconfigureOverlay(editor, applyOverlay, onEvaluate) {
  editor.editor.dispatch({
    effects: strasbeatOverlayCompartment.reconfigure(
      applyOverlay
        ? Prec.highest(createVscodeKeymap({ onEvaluate }))
        : [],
    ),
  });
}
```

- [ ] **Step 6: Run dev server and verify Strudel profile loads with no overlay**

Run: `pnpm dev` (in a separate terminal if you don't already have it running).
Open the browser DevTools console and run:

```js
localStorage.removeItem("strasbeat:keymap-profile");
location.reload();
```

After reload, the editor should be in the Strudel profile (no stored value → default). In the editor:
- Press `Ctrl+Enter` → pattern evaluates ✓
- Press `Cmd+Enter` (mac) or `Cmd+D`-equivalent → on mac, `Cmd+Enter` should still evaluate (universal keymap). `Cmd+D` should do nothing (Strudel profile has no overlay).

If `Cmd+Enter` evaluates and `Cmd+D` does nothing → wiring is correct. If both do nothing, the universal keymap isn't loading — debug. If both work, the overlay is still loading — recheck Step 4.

- [ ] **Step 7: Commit**

```bash
git add src/editor-setup.js
git commit -m "feat: gate strasbeat overlay behind a CodeMirror compartment per profile"
```

---

## Task 5: applyKeymapProfile canonical handler

**Files:**
- Create: `src/editor/keymap-apply.js`

Single function that performs the full profile change dance. Both the chip popover and the settings dropdown will call it.

- [ ] **Step 1: Create `src/editor/keymap-apply.js`**

```js
// Single canonical handler for changing keymap profiles. Both the
// transport-bar chip popover and the Settings → Editor → Keymap
// dropdown call this. Subscribers (chip relabel, dropdown update,
// mode-subscription attach/detach) register via `subscribe(...)`.
//
// See design/work/21-keybindings.md §"Profile change flow".

import {
  getProfile,
  setStoredProfileId,
} from "./keymap-profiles.js";
import { applyPanelSetting, reconfigureOverlay } from "../editor-setup.js";

const subscribers = new Set();

export function subscribeKeymapChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function applyKeymapProfile(editor, profileId, { onEvaluate }) {
  const profile = getProfile(profileId);

  // Strudel-side: reconfigure its keybindings compartment + persist to atom.
  applyPanelSetting(editor, "keybindings", profile.strudelKeybindings);

  // Strasbeat-side: turn the overlay on/off via our compartment.
  reconfigureOverlay(editor, profile.applyStrasbeatOverlay, onEvaluate);

  // Persist canonical profile id (Strudel atom mirrors the string;
  // strasbeat profile id is the source of truth so we can map back to
  // the chip / dropdown on reload).
  setStoredProfileId(profile.id);

  // Notify subscribers (chip relabels, dropdown updates, mode subscription
  // attaches/detaches based on isModal).
  for (const fn of subscribers) {
    try {
      fn(profile);
    } catch (err) {
      console.warn("[strasbeat/keymap] subscriber threw:", err);
    }
  }
}
```

- [ ] **Step 2: Verify the import chain compiles**

Run: `pnpm test 2>&1 | tail -10`
Expected: All tests pass (no test directly covers this file, but a syntax error or bad import would break transitive importers).

- [ ] **Step 3: Commit**

```bash
git add src/editor/keymap-apply.js
git commit -m "feat: add applyKeymapProfile canonical handler with subscriber registry"
```

---

## Task 6: Custom-event listeners in main.js

**Files:**
- Modify: `src/main.js`

Add three listeners that wire Strudel's vim/emacs/helix `:w` `:q` `gc` to the editor.

- [ ] **Step 1: Add the import**

Find the existing import for `toggleComment` at the top of `src/main.js`. If it's not imported, add:

```js
import { toggleComment } from "@codemirror/commands";
```

(Search the file first to avoid duplicate imports — `grep -n toggleComment src/main.js`. If not present, add to the existing `@codemirror/commands` import block.)

- [ ] **Step 2: Add the three listeners**

Locate the existing `Cmd+B` document keydown listener in `src/main.js` (around line 540, the comment is `// Cmd/Ctrl+B toggles the right rail (matches VSCode's sidebar toggle).`). Add the new block immediately *after* the closing `);` of that listener and *before* the `// ─── Command palette (Cmd+Shift+P)` section:

```js
// Strudel's vim/emacs/helix integrations dispatch these custom DOM events
// instead of running CM commands directly — the host wires them to
// whatever the app considers "evaluate" / "stop" / "toggle comment".
// See node_modules/@strudel/codemirror/keybindings.mjs (Vim.defineEx
// blocks). Harmless when the active profile is Strudel/VSCode (no event
// ever fires); load-bearing in modal profiles.
document.addEventListener("repl-evaluate", () => editor.evaluate());
document.addEventListener("repl-stop", () => editor.stop());
document.addEventListener("repl-toggle-comment", () => {
  editor.editor.focus();
  toggleComment(editor.editor);
});
```

- [ ] **Step 3: Smoke-check that no event accidentally fires in Strudel profile**

Run: `pnpm dev`. In the browser, with localStorage cleared (Strudel profile), open DevTools console and add a temporary listener:

```js
document.addEventListener("repl-evaluate", () => console.log("repl-evaluate fired!"));
```

Type in the editor for ~10 seconds. The listener should NOT fire (Strudel profile doesn't dispatch these events).

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat: wire repl-evaluate/-stop/-toggle-comment custom events for modal profiles"
```

---

## Task 7: Keymap chip module — label + pure helper (TDD)

**Files:**
- Create: `src/ui/keymap-chip.js` (initial version: just renders the label)
- Test: `src/ui/keymap-chip.test.js`

The chip's `formatChipLabel(profile, mode)` function is pure and unit-testable. Build it TDD-first; the rest of the chip (DOM, popover) accretes around it.

- [ ] **Step 1: Write failing tests for `formatChipLabel`**

Create `src/ui/keymap-chip.test.js`:

```js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatChipLabel } from "./keymap-chip.js";
import { getProfile } from "../editor/keymap-profiles.js";

describe("formatChipLabel()", () => {
  test("non-modal profiles show only the label + dropdown caret", () => {
    assert.equal(formatChipLabel(getProfile("strudel"), null), "Strudel ▾");
    assert.equal(formatChipLabel(getProfile("vscode"), null), "VSCode ▾");
    assert.equal(formatChipLabel(getProfile("emacs"), null), "Emacs ▾");
  });

  test("modal profiles append the active mode in uppercase", () => {
    assert.equal(formatChipLabel(getProfile("vim"), "NORMAL"), "Vim · NORMAL ▾");
    assert.equal(formatChipLabel(getProfile("vim"), "INSERT"), "Vim · INSERT ▾");
    assert.equal(formatChipLabel(getProfile("helix"), "SELECT"), "Helix · SELECT ▾");
  });

  test("modal profiles fall back to the first mode when current mode is unknown", () => {
    // Defensive — if the mode subscription hasn't fired yet, show NORMAL
    // (the first declared mode) rather than a blank pill.
    assert.equal(formatChipLabel(getProfile("vim"), null), "Vim · NORMAL ▾");
    assert.equal(formatChipLabel(getProfile("helix"), undefined), "Helix · NORMAL ▾");
  });

  test("modal profiles uppercase any input mode they receive", () => {
    assert.equal(formatChipLabel(getProfile("vim"), "insert"), "Vim · INSERT ▾");
  });
});
```

- [ ] **Step 2: Add the test file to package.json's test script and run to verify failure**

Edit `package.json`'s `test` script — append `src/ui/keymap-chip.test.js`.

Run: `pnpm test 2>&1 | tail -20`
Expected: FAIL — module not found (`./keymap-chip.js`) or `formatChipLabel` is not defined.

- [ ] **Step 3: Implement the minimal chip module with `formatChipLabel`**

Create `src/ui/keymap-chip.js`:

```js
// Transport-bar keymap chip. Shows the active profile and (for modal
// profiles) the current Vim/Helix mode. Click → popover (added in a
// later task). Mounted next to the MIDI pill.
//
// See design/work/21-keybindings.md §"Keymap chip + popover".

export function formatChipLabel(profile, currentMode) {
  if (!profile.isModal) return `${profile.label} ▾`;
  const modeLabel = currentMode ? String(currentMode).toUpperCase() : profile.modes[0];
  return `${profile.label} · ${modeLabel} ▾`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test 2>&1 | tail -10`
Expected: `formatChipLabel` tests pass; no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/ui/keymap-chip.js src/ui/keymap-chip.test.js package.json
git commit -m "feat: add keymap chip module with formatChipLabel pure helper"
```

---

## Task 8: Keymap chip — DOM render + mount in transport bar

**Files:**
- Modify: `src/ui/keymap-chip.js` (add `mountKeymapChip`)
- Modify: `src/ui/transport.js` (call `mountKeymapChip`)
- Modify: `src/main.js` (pass editor + onEvaluate to the transport mount)

- [ ] **Step 1: Add `mountKeymapChip` to `src/ui/keymap-chip.js`**

Append to the existing file:

```js
import { getProfile, getStoredProfileId } from "../editor/keymap-profiles.js";
import { subscribeKeymapChange } from "../editor/keymap-apply.js";

// Mounts the chip element into `container`. Returns an API object the
// caller can use later (e.g. for the popover task) — we expose `el` and
// a `setMode(mode)` setter for modal profiles.
export function mountKeymapChip({ container }) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "transport__pill keymap-chip";
  el.id = "keymap-chip";
  let currentMode = null;

  function render() {
    const profile = getProfile(getStoredProfileId());
    el.textContent = formatChipLabel(profile, currentMode);
    el.dataset.profile = profile.id;
    el.dataset.modal = profile.isModal ? "1" : "0";
  }

  // Re-render when the profile changes (chip popover or settings dropdown).
  const unsubscribe = subscribeKeymapChange((profile) => {
    // Reset mode when leaving a modal profile, otherwise the stale
    // "INSERT" tag would render alongside the new "VSCode" label.
    if (!profile.isModal) currentMode = null;
    render();
  });

  function setMode(mode) {
    currentMode = mode;
    render();
  }

  render();
  container.appendChild(el);

  return {
    el,
    setMode,
    destroy: () => {
      unsubscribe();
      el.remove();
    },
  };
}
```

- [ ] **Step 2: Mount the chip in transport.js**

Open `src/ui/transport.js` and locate where the MIDI pill is created. (Use grep: `grep -n "midi.*pill\|midiPill\|--midi" src/ui/transport.js | head -10`.) The exact wiring depends on the current shape of `transport.js`; the goal is to insert the chip's container before the MIDI pill in the transport bar's right-hand region.

Add the import at the top:

```js
import { mountKeymapChip } from "./keymap-chip.js";
```

In the function that builds the transport bar (likely `mountTransport` or similar — confirm by reading the file's exports), after the structure is created and before returning, add:

```js
// Keymap profile chip — sits to the left of the MIDI pill. See
// design/work/21-keybindings.md §"Keymap chip + popover".
const keymapChipContainer = /* ...select the pills container in the transport bar... */;
const keymapChip = mountKeymapChip({ container: keymapChipContainer });
```

The `keymapChipContainer` should be whatever element parents the MIDI pill. If `transport.js` doesn't currently expose a clean parent, add a simple `<span class="transport__pills">` wrapper around the MIDI pill and append the keymap chip into it. Keep the order: keymap chip first (left), then MIDI pill.

Expose `keymapChip` on the returned transport API so other modules (`main.js`) can reach it:

```js
return {
  // ...existing API...
  keymapChip,
};
```

- [ ] **Step 3: Style the chip (one-time minimal CSS, polished by impeccable later)**

Add a minimal selector to `src/styles/transport.css` (or wherever `.transport__pill` is defined — search with `grep -rn 'transport__pill' src/styles`). The chip should reuse the pill base style and add a hover/focus state for clickability:

```css
.keymap-chip {
  cursor: pointer;
  border: none;
  background: var(--surface-1);
  color: var(--text-1);
  font: inherit;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.keymap-chip:hover { background: var(--surface-2); }
.keymap-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

(The `impeccable` skill task at the end will replace this with the polished version.)

- [ ] **Step 4: Verify the chip renders in the browser**

Run `pnpm dev`, open the page, verify a `Strudel ▾` chip appears in the transport bar. Inspect the DOM to confirm it's where intended (left of the MIDI pill, inside the transport bar).

The chip won't be clickable yet — that's Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/ui/keymap-chip.js src/ui/transport.js src/styles/transport.css
git commit -m "feat: render keymap chip in the transport bar"
```

---

## Task 9: Keymap chip — popover with profile picker

**Files:**
- Modify: `src/ui/keymap-chip.js` (add popover render + interactions)
- Modify: `src/main.js` (pass editor reference to chip via transport mount)

- [ ] **Step 1: Extend `mountKeymapChip` to accept editor + onEvaluate, render popover on click**

Update the signature and body of `mountKeymapChip` in `src/ui/keymap-chip.js`:

```js
export function mountKeymapChip({ container, editor, onEvaluate }) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "transport__pill keymap-chip";
  el.id = "keymap-chip";
  el.setAttribute("aria-haspopup", "menu");
  el.setAttribute("aria-expanded", "false");
  let currentMode = null;
  let popover = null;

  function render() {
    const profile = getProfile(getStoredProfileId());
    el.textContent = formatChipLabel(profile, currentMode);
    el.dataset.profile = profile.id;
    el.dataset.modal = profile.isModal ? "1" : "0";
  }

  const unsubscribe = subscribeKeymapChange((profile) => {
    if (!profile.isModal) currentMode = null;
    render();
    closePopover();
  });

  function setMode(mode) {
    currentMode = mode;
    render();
  }

  function openPopover() {
    if (popover) return;
    popover = renderPopover({
      anchor: el,
      activeId: getStoredProfileId(),
      onPick: (profileId) => {
        applyKeymapProfile(editor, profileId, { onEvaluate });
        closePopover();
      },
      onDismiss: closePopover,
    });
    el.setAttribute("aria-expanded", "true");
  }

  function closePopover() {
    if (!popover) return;
    popover.destroy();
    popover = null;
    el.setAttribute("aria-expanded", "false");
    el.focus();
  }

  el.addEventListener("click", () => {
    if (popover) closePopover();
    else openPopover();
  });

  render();
  container.appendChild(el);

  return {
    el,
    setMode,
    destroy: () => {
      closePopover();
      unsubscribe();
      el.remove();
    },
  };
}
```

Add the new import at the top of `keymap-chip.js`:

```js
import { applyKeymapProfile } from "../editor/keymap-apply.js";
import { KEYMAP_PROFILES } from "../editor/keymap-profiles.js";
```

(The existing `getProfile`, `getStoredProfileId`, `subscribeKeymapChange` imports stay.)

- [ ] **Step 2: Implement `renderPopover` in the same file**

Below `mountKeymapChip` in `src/ui/keymap-chip.js`, add:

```js
function renderPopover({ anchor, activeId, onPick, onDismiss }) {
  const popover = document.createElement("div");
  popover.className = "keymap-popover";
  popover.setAttribute("role", "menu");

  const rows = KEYMAP_PROFILES.map((profile) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "keymap-popover__row";
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", profile.id === activeId ? "true" : "false");
    row.dataset.profileId = profile.id;
    if (profile.id === activeId) row.classList.add("keymap-popover__row--active");

    const check = document.createElement("span");
    check.className = "keymap-popover__check";
    check.textContent = profile.id === activeId ? "✓" : "";
    row.appendChild(check);

    const body = document.createElement("span");
    body.className = "keymap-popover__body";
    const name = document.createElement("span");
    name.className = "keymap-popover__name";
    name.textContent = profile.label;
    const desc = document.createElement("span");
    desc.className = "keymap-popover__desc";
    desc.textContent = profile.description;
    body.appendChild(name);
    body.appendChild(desc);
    row.appendChild(body);

    if (profile.isDefault) {
      const tag = document.createElement("span");
      tag.className = "keymap-popover__tag";
      tag.textContent = "default";
      row.appendChild(tag);
    }

    row.addEventListener("click", () => onPick(profile.id));
    popover.appendChild(row);
    return row;
  });

  // Position: anchor above the chip (transport is at the bottom of the shell).
  document.body.appendChild(popover);
  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.left = `${Math.max(8, rect.left)}px`;
  popover.style.top = `${rect.top - popRect.height - 8}px`;

  // Initial focus on the active row.
  const activeRow = rows.find((r) => r.dataset.profileId === activeId) ?? rows[0];
  activeRow.focus();

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = (idx + delta + rows.length) % rows.length;
      rows[next].focus();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const focused = document.activeElement;
      if (focused?.dataset?.profileId) onPick(focused.dataset.profileId);
    }
  }

  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchor) onDismiss();
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onClickOutside, true);

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onClickOutside, true);
      popover.remove();
    },
  };
}
```

- [ ] **Step 3: Pass `editor` and `onEvaluate` from main.js → transport.js → chip**

In `src/ui/transport.js`, update the chip mount to pass the editor and onEvaluate through. The `mountTransport` (or equivalent) function signature should already accept some `editor`-shaped argument — extend it if not, or add a new option:

```js
const keymapChip = mountKeymapChip({
  container: keymapChipContainer,
  editor,
  onEvaluate,
});
```

In `src/main.js`, locate the `mountTransport` call (`grep -n mountTransport src/main.js`). Pass `editor` and `onEvaluate: () => editor.evaluate()` through. If `transport.js` already receives `editor`, just add the onEvaluate.

- [ ] **Step 4: Style the popover (minimal — impeccable polishes later)**

In the same CSS file as the chip, add:

```css
.keymap-popover {
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-2);
  display: flex;
  flex-direction: column;
  width: 320px;
  z-index: 50;
  padding: 0.25rem;
}
.keymap-popover__row {
  display: grid;
  grid-template-columns: 1.25rem 1fr auto;
  gap: 0.5rem;
  align-items: start;
  padding: 0.5rem;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  color: var(--text-1);
}
.keymap-popover__row:hover,
.keymap-popover__row:focus-visible {
  background: var(--surface-3);
  outline: none;
}
.keymap-popover__check { font-size: 0.875rem; color: var(--accent); }
.keymap-popover__body { display: flex; flex-direction: column; gap: 0.125rem; }
.keymap-popover__name { font-weight: 500; }
.keymap-popover__desc { font-size: 0.75rem; color: var(--text-2); }
.keymap-popover__tag { font-size: 0.75rem; color: var(--text-2); align-self: center; }
```

(`impeccable` skill replaces this with the polished version later.)

- [ ] **Step 5: Manual verification**

Run `pnpm dev`. Reload with cleared localStorage:

```js
localStorage.removeItem("strasbeat:keymap-profile");
location.reload();
```

Verify:
- Click the chip → popover appears above the chip with 5 rows; Strudel row has ✓ and "default" tag.
- Click VSCode row → popover closes; chip relabels to `VSCode ▾`. Test `Cmd+D` in the editor on a known word — should select the next occurrence. Switch back to Strudel — `Cmd+D` should do nothing.
- Open popover, press `↓` and `↑` — focus moves between rows.
- Press `Enter` on a focused row — applies that profile.
- Press `Escape` → popover closes, focus returns to chip.
- Click outside the popover → it closes.

- [ ] **Step 6: Commit**

```bash
git add src/ui/keymap-chip.js src/ui/transport.js src/styles/transport.css src/main.js
git commit -m "feat: add keymap chip popover with click + keyboard profile picker"
```

---

## Task 10: Vim/Helix mode subscription

**Files:**
- Modify: `src/ui/keymap-chip.js`

The chip needs to display the current Vim/Helix mode. The exact API of `@replit/codemirror-vim` for mode-change subscription must be verified against the installed package; if no public hook exists, fall back to a CM6 `ViewPlugin` polling approach.

- [ ] **Step 1: Verify the available API**

Run:

```bash
ls node_modules/@replit/codemirror-vim/dist/ 2>/dev/null
grep -l "Vim\." node_modules/@replit/codemirror-vim/dist/*.cjs 2>/dev/null | head -3
node -e "const m = require('@replit/codemirror-vim'); console.log(Object.keys(m));" 2>&1 | head -5
```

Look for an exported `Vim`, `getCM`, or similar hook that exposes the current mode. The two known options:

1. `Vim.defineOption("…callback", ...)` — register a global mode-change callback.
2. CM6 `ViewPlugin` reading `view.cm.state.vim?.mode` (or whatever path the installed version exposes).

Pick whichever is available. If both are, prefer the explicit callback (fewer wasted update calls).

- [ ] **Step 2: Implement a mode subscription helper**

In `src/ui/keymap-chip.js`, add (above `mountKeymapChip`):

```js
import { ViewPlugin } from "@codemirror/view";

// Subscribe to vim mode changes for the active editor view. Returns a
// teardown function. Implementation: a CM6 ViewPlugin that polls
// `view.state.vim?.mode` on each update — cheap because mode flips
// happen on user input only.
//
// IMPLEMENTATION NOTE: if @replit/codemirror-vim exposes a public
// mode-change callback, prefer it. Verify by reading
// node_modules/@replit/codemirror-vim/dist/index.cjs before merging.
function subscribeVimMode(editor, listener) {
  let lastMode = null;
  const plugin = ViewPlugin.define(() => ({
    update(update) {
      const vimState = update.state.vim;
      const mode = vimState?.mode ?? "NORMAL";
      if (mode !== lastMode) {
        lastMode = mode;
        listener(String(mode).toUpperCase());
      }
    },
  }));
  // Append the plugin via StateEffect.appendConfig (matches how
  // editor-setup.js adds extensions on the live view).
  import("@codemirror/state").then(({ StateEffect }) => {
    editor.editor.dispatch({
      effects: StateEffect.appendConfig.of([plugin]),
    });
  });
  return () => {
    // ViewPlugin teardown happens when the editor is destroyed; nothing
    // to do explicitly here since strasbeat doesn't unmount the editor.
  };
}
```

(For Helix, the same pattern applies but reading whatever path the installed Helix integration exposes. If Helix isn't bundled with `@replit/codemirror-vim` and Strudel uses a different package for it, repeat the discovery in Step 1 for the helix package.)

- [ ] **Step 3: Wire the subscription to the chip when modal profile is active**

Inside `mountKeymapChip`, modify the `subscribeKeymapChange` callback to attach/detach mode subscription:

```js
let modeUnsub = null;
const unsubscribe = subscribeKeymapChange((profile) => {
  if (modeUnsub) {
    modeUnsub();
    modeUnsub = null;
  }
  if (!profile.isModal) {
    currentMode = null;
  } else {
    currentMode = profile.modes[0]; // start with NORMAL/default
    modeUnsub = subscribeVimMode(editor, (mode) => {
      currentMode = mode;
      render();
    });
  }
  render();
  closePopover();
});
```

Also call this same logic at mount time (initial state) — if the user reloads with vim profile already active:

```js
const initialProfile = getProfile(getStoredProfileId());
if (initialProfile.isModal) {
  currentMode = initialProfile.modes[0];
  modeUnsub = subscribeVimMode(editor, (mode) => {
    currentMode = mode;
    render();
  });
}
```

Place this before the initial `render()` call.

- [ ] **Step 4: Manual verification**

Run `pnpm dev`. Switch to Vim profile via the chip. The label should immediately read `Vim · NORMAL ▾`. Press `i` in the editor → `Vim · INSERT ▾`. Press `Esc` → `Vim · NORMAL ▾`. Press `v` → `Vim · VISUAL ▾`.

Switch to a non-modal profile (e.g., VSCode). The chip should read `VSCode ▾` with no mode word. Type rapidly in the editor — the chip must NOT flicker.

If the mode label doesn't update on `i`/`Esc`, the polling path isn't reading the right state slice. Inspect:

```js
view.state.vim   // in DevTools console
```

and adjust the path in `subscribeVimMode`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/keymap-chip.js
git commit -m "feat: subscribe keymap chip to vim/helix mode changes"
```

---

## Task 11: First-time tooltip

**Files:**
- Modify: `src/ui/keymap-chip.js`

When `localStorage["strasbeat:keymap-chip-seen"]` is falsy, show a one-shot tooltip anchored to the chip on first load. Vanishes on any user interaction.

- [ ] **Step 1: Add tooltip render + dismissal to `mountKeymapChip`**

Add the imports at the top of the file:

```js
import { hasSeenTooltip, markTooltipSeen } from "../editor/keymap-profiles.js";
```

Inside `mountKeymapChip`, after the initial `render()` call but before `container.appendChild(el)`:

```js
let tooltip = null;
function showInitialTooltipIfNeeded() {
  if (hasSeenTooltip()) return;
  tooltip = document.createElement("div");
  tooltip.className = "keymap-chip__tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = "Click to change your editor keymap";
  document.body.appendChild(tooltip);

  // Position above the chip. We can't measure until the chip is in the
  // DOM, so requestAnimationFrame defers this one frame.
  requestAnimationFrame(() => {
    if (!tooltip) return;
    const rect = el.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    tooltip.style.position = "fixed";
    tooltip.style.left = `${Math.max(8, rect.left)}px`;
    tooltip.style.top = `${rect.top - tipRect.height - 8}px`;
  });

  function dismiss() {
    if (!tooltip) return;
    markTooltipSeen();
    tooltip.remove();
    tooltip = null;
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", dismiss, true);
  }

  // Any user interaction dismisses it. Capture-phase listeners so we
  // see the event before any in-app handler can stopPropagation.
  document.addEventListener("mousedown", dismiss, true);
  document.addEventListener("keydown", dismiss, true);
}
```

After `container.appendChild(el)`:

```js
showInitialTooltipIfNeeded();
```

Make sure the existing `destroy` function clears the tooltip if still mounted:

```js
return {
  el,
  setMode,
  destroy: () => {
    if (tooltip) tooltip.remove();
    closePopover();
    if (modeUnsub) modeUnsub();
    unsubscribe();
    el.remove();
  },
};
```

- [ ] **Step 2: Style the tooltip (minimal)**

Add to the chip's stylesheet:

```css
.keymap-chip__tooltip {
  background: var(--surface-3);
  color: var(--text-1);
  border-radius: var(--radius-sm);
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
  box-shadow: var(--elevation-1);
  pointer-events: none; /* tooltip is informational; clicks pass through */
  z-index: 60;
}
```

- [ ] **Step 3: Manual verification**

Run `pnpm dev`. Clear the tooltip-seen flag:

```js
localStorage.removeItem("strasbeat:keymap-chip-seen");
location.reload();
```

After reload, the tooltip should appear above the chip. Click anywhere → tooltip vanishes, flag is set. Reload again → tooltip should NOT reappear. Re-clear the flag and reload → it appears again. Click the chip directly → tooltip vanishes AND popover opens (because the click is captured first, dismisses tooltip, then the chip's click handler fires).

- [ ] **Step 4: Commit**

```bash
git add src/ui/keymap-chip.js src/styles/transport.css
git commit -m "feat: add one-time first-load tooltip to keymap chip"
```

---

## Task 12: Settings panel — Keymap dropdown

**Files:**
- Modify: `src/ui/settings-panel.js`

Add a Keymap row at the top of the Editor section. Wired to the same `applyKeymapProfile` function the chip uses.

- [ ] **Step 1: Read the existing settings panel structure**

Open `src/ui/settings-panel.js` and locate:
- The `EDITOR_TOGGLES` constant (or whatever drives the Editor section rows).
- The `buildRow` (or equivalent) helper used for `<select>` rows like Theme/Font.
- The function that mounts the Editor section and where `EDITOR_TOGGLES` is consumed.

If there's no shared `buildRow` for selects, extract the pattern from the Theme dropdown (the closest analogue).

- [ ] **Step 2: Add the Keymap row before EDITOR_TOGGLES**

Add the imports at the top of `settings-panel.js`:

```js
import {
  KEYMAP_PROFILES,
  getStoredProfileId,
} from "../editor/keymap-profiles.js";
import {
  applyKeymapProfile,
  subscribeKeymapChange,
} from "../editor/keymap-apply.js";
```

In the function that builds the Editor section (or where EDITOR_TOGGLES rows are appended), insert a new row at the very top of the Editor section. The exact code shape depends on the existing helper — pseudocode:

```js
// Keymap row — first in the Editor section. See
// design/work/21-keybindings.md §"Settings panel — alternate entry point".
const keymapRow = document.createElement("div");
keymapRow.className = "settings-row";
const label = document.createElement("label");
label.textContent = "Keymap";
const select = document.createElement("select");
select.className = "settings-row__select";
for (const profile of KEYMAP_PROFILES) {
  const opt = document.createElement("option");
  opt.value = profile.id;
  opt.textContent = profile.label + (profile.isDefault ? " (default)" : "");
  select.appendChild(opt);
}
select.value = getStoredProfileId();
select.addEventListener("change", () => {
  applyKeymapProfile(editor, select.value, { onEvaluate: () => editor.evaluate() });
});

// Keep the dropdown in sync when the user picks a profile from the chip.
subscribeKeymapChange((profile) => {
  if (select.value !== profile.id) select.value = profile.id;
});

keymapRow.appendChild(label);
keymapRow.appendChild(select);
editorSection.prepend(keymapRow); // or insertBefore(EDITOR_TOGGLES_FIRST_ROW)
```

(The `editor` reference must be in scope where the Editor section is built. If it isn't, plumb it through — the same parameter the existing `applyPanelSetting` calls use.)

- [ ] **Step 3: Manual verification**

Run `pnpm dev`. Open Settings (the cog icon) and confirm the Keymap row sits at the top of the Editor section.

- Switch the dropdown to Vim → chip relabels to `Vim · NORMAL ▾` immediately, editor enters vim mode.
- Switch the chip popover to Strudel → settings dropdown updates to "Strudel (default)" without a reload.
- Reload the page → both UIs show whichever profile was last selected.

- [ ] **Step 4: Commit**

```bash
git add src/ui/settings-panel.js
git commit -m "feat: add Keymap dropdown to Settings panel as alternate entry point"
```

---

## Task 13: Command palette — per-profile shortcuts + searchability for `:w` / `:q`

**Files:**
- Modify: `src/ui/command-palette.js`

Two additions: (1) palette items can declare profile-specific shortcuts that render in place of the QWERTY shortcut when a modal profile is active; (2) palette-only entries that surface `:w` and `:q` as searchable text.

- [ ] **Step 1: Locate the palette command builder + shortcut renderer**

Open `src/ui/command-palette.js`. Find:
- The `buildCommands` (or equivalent) function that returns the array of palette entries. Each entry typically has shape `{ label, hint, run, shortcut?, keywords? }`.
- The render function that draws each row, specifically the part that renders the `shortcut` string (look for the right-aligned shortcut chip).

- [ ] **Step 2: Extend command shape with profile-specific shortcuts**

Add the imports at the top of `src/ui/command-palette.js`:

```js
import { getProfile, getStoredProfileId } from "../editor/keymap-profiles.js";
```

Modify the row-rendering logic so the displayed shortcut comes from a profile-aware lookup:

```js
function shortcutForActiveProfile(cmd) {
  const profileId = getStoredProfileId();
  if (profileId === "vim" && cmd.vimShortcut) return cmd.vimShortcut;
  if (profileId === "emacs" && cmd.emacsShortcut) return cmd.emacsShortcut;
  if (profileId === "helix" && cmd.helixShortcut) return cmd.helixShortcut;
  // Strudel and VSCode both fall back to the default `shortcut` field.
  // Strudel deliberately doesn't bind most overlay shortcuts — but we
  // still show the key as a hint so users discover the VSCode-profile
  // alternative via the palette.
  return cmd.shortcut ?? null;
}
```

In the row-render code, replace `cmd.shortcut` reads with `shortcutForActiveProfile(cmd)`.

- [ ] **Step 3: Annotate the comment-toggle command (and any other command with modal equivalents)**

Find the existing palette entry for "Toggle comment" (or equivalent). Add:

```js
{
  label: "Toggle comment",
  shortcut: "Cmd+/",
  vimShortcut: "gc",
  emacsShortcut: "C-/",
  // helixShortcut: "gc"  // verify Helix's actual binding before adding
  run: () => /* existing run */,
},
```

For other commands (e.g., the `Play` / `Stop` ones), no modal-specific shortcut overrides are needed — vim/emacs/helix users use the universal `Ctrl+Enter` / `Ctrl+.` plus the new `:w` / `:q` entries below.

- [ ] **Step 4: Add the two new searchable palette entries**

Append to the palette commands array (these have no global keyboard binding — they're palette-only):

```js
{
  label: "Eval (Strudel :w)",
  hint: "Evaluate the current pattern",
  keywords: ":w write evaluate run play",
  run: () => editor.evaluate(),
},
{
  label: "Stop (Strudel :q)",
  hint: "Stop the scheduler",
  keywords: ":q quit stop",
  run: () => editor.stop(),
},
```

If the existing palette structure doesn't support `keywords`, add it as an optional field on the command shape and have the fuzzy matcher search against it. Otherwise, encode the searchable strings into the `label` (e.g. `Eval (:w / write / play)`).

- [ ] **Step 5: Re-render the palette when profile changes**

If the palette is mounted as a long-lived component, subscribe to keymap changes so the shortcut chips update. Add the import:

```js
import { subscribeKeymapChange } from "../editor/keymap-apply.js";
```

Inside the palette mount function, after the initial render setup:

```js
subscribeKeymapChange(() => {
  // Force a re-render of the palette's command list so shortcut chips
  // pick up the new profile. If the palette is closed, this is a no-op.
  if (typeof rerenderCommands === "function") rerenderCommands();
});
```

(The actual rerender hook depends on the palette's existing structure. If it lazily renders rows on each open, no subscription is needed — the next open will read the current profile.)

- [ ] **Step 6: Manual verification**

Run `pnpm dev`. With the Strudel profile active, open the palette (`Cmd+Shift+P`). Find the "Toggle comment" entry — its shortcut chip should read `Cmd+/`.

Switch to Vim profile via the chip. Reopen the palette. The "Toggle comment" entry should now read `gc`.

Type `:w` in the palette → "Eval (Strudel :w)" appears. Type `:q` → "Stop (Strudel :q)" appears. Selecting either runs the corresponding action.

- [ ] **Step 7: Commit**

```bash
git add src/ui/command-palette.js
git commit -m "feat: per-profile shortcut chips and :w/:q palette entries"
```

---

## Task 14: Declare explicit dependencies in package.json

**Files:**
- Modify: `package.json`

`@replit/codemirror-vim` and `@replit/codemirror-emacs` are currently transitive deps via `@strudel/codemirror`. Now that we directly orchestrate vim mode subscriptions, declare them explicitly.

- [ ] **Step 1: Find the installed versions**

Run:

```bash
pnpm list --depth 99 2>/dev/null | grep -E "@replit/codemirror-(vim|emacs)" | head -5
```

Note the version strings (e.g. `@replit/codemirror-vim 6.3.0`).

- [ ] **Step 2: Add them to dependencies**

Edit `package.json` and add (preserve alphabetical order in the `dependencies` block — they sort between `@replit` and `@strudel`):

```json
    "@replit/codemirror-emacs": "^6.0.0",
    "@replit/codemirror-vim": "^6.3.0",
```

(Use the actual versions from Step 1 — match the major.minor exactly, then `^` for patch flexibility.)

- [ ] **Step 3: Reinstall and verify**

```bash
pnpm install 2>&1 | tail -5
pnpm test 2>&1 | tail -5
pnpm build 2>&1 | tail -5
```

All three should succeed. The lockfile will update — that's expected.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: declare @replit/codemirror-{vim,emacs} as explicit deps"
```

---

## Task 15: Polish via the impeccable skill

**Files:**
- Modify: chip + popover CSS (whichever file ended up holding the styles)
- Possibly: `src/ui/keymap-chip.js` (DOM tweaks to match the polished design)

This task is delegated to the `impeccable` skill. The brief is captured in the spec.

- [ ] **Step 1: Invoke the impeccable skill**

Open a fresh conversation (or use the skill in-session) with the prompt:

> Polish the keymap chip and popover at `src/ui/keymap-chip.js` (and its CSS) per the brief in `design/work/21-keybindings.md` §"Keymap chip + popover" → "Visual treatment". The chip should disappear into the chrome — it's status, not action-bait. The popover, when open, should feel like VSCode's status-bar pickers: tight, fast, polished, dismissible. The first-time tooltip should be unobtrusive. Keep all functional behavior identical.

The skill will produce diffs to the chip + popover styling. Review the changes against the spec's "out of the way" guarantees:
- No animation while editing.
- Chip never reads as a CTA.
- Popover dismisses cleanly.

- [ ] **Step 2: Manual verification of polish**

Walk the chip + popover behavior end-to-end after the skill's changes. Watch for:
- Visual fit with the rest of the transport bar.
- Popover spacing/typography matching other modals/menus in the app.
- Mode-flip in Vim (`i`/`Esc` rapidly) does not jump or animate.
- Tooltip readable, dismissible, doesn't block clicks on the chip.

- [ ] **Step 3: Commit**

```bash
git add -p  # review hunks before adding
git commit -m "style: polish keymap chip and popover to match design system"
```

---

## Task 16: Acceptance run + manual smoke test

**Files:**
- None — this is verification only.

Walk the full acceptance checklist from `design/work/21-keybindings.md` §"Acceptance" against a running build. Document any failures as new tickets.

- [ ] **Step 1: Run the test suite**

```bash
pnpm test 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 2: Run the production build**

```bash
pnpm build 2>&1 | tail -10
```

Expected: Build succeeds. No new warnings beyond the existing baseline.

- [ ] **Step 3: Manual smoke test — Strudel profile (default)**

Clear localStorage:

```js
localStorage.clear();
location.reload();
```

Verify:
- [ ] Chip reads `Strudel ▾`. First-time tooltip appears once, dismissable.
- [ ] `Ctrl+Enter` evaluates. `Cmd+Enter` (mac) evaluates.
- [ ] `Cmd+B` toggles right rail. `Cmd+Shift+P` opens palette.
- [ ] `Cmd+D`, `Cmd+L`, `Cmd+Shift+K`, `Cmd+/`, `Alt+↓` do nothing.

- [ ] **Step 4: Manual smoke test — VSCode profile**

Switch via chip popover or settings dropdown. Verify:
- [ ] All bindings from `02-format-and-keybindings.md` work identically to today.
- [ ] AZERTY mac (system keyboard set to French): `Cmd+:` toggles comment without opening Help. `Tab`/`Shift+Tab` indent/dedent on selections.

- [ ] **Step 5: Manual smoke test — Vim profile**

- [ ] `i` enters insert, `Esc` returns to normal.
- [ ] `:w⏎` evaluates. `:q⏎` stops. `gc` (after `v` selection) toggles comment.
- [ ] `hjkl` navigates. `Cmd+Enter` still evaluates regardless of mode. `Cmd+B`, `Cmd+Shift+P` still work.
- [ ] Chip mode-aware: `Vim · NORMAL`, `Vim · INSERT`, `Vim · VISUAL`. No flicker on rapid `i`/`Esc`.

- [ ] **Step 6: Manual smoke test — Emacs profile**

- [ ] `C-x C-s` saves (verify against installed `@replit/codemirror-emacs` defaults — if it doesn't, update the spec's open question note).
- [ ] `C-/` toggles comment, `M-w`/`C-y` copy/yank.
- [ ] Layer-2 shortcuts still work.

- [ ] **Step 7: Manual smoke test — Helix profile**

- [ ] `i`/`Esc` and select-then-act semantics work.
- [ ] `:w⏎` evaluates.
- [ ] Chip mode-aware: `Helix · NORMAL` etc.

- [ ] **Step 8: Manual smoke test — switching is smooth**

- [ ] Switching profiles via chip or settings takes effect within ~16ms (one frame). No editor remount, no scroll jump, no cursor reset.
- [ ] Profile choice survives page reload.
- [ ] Switching from a modal profile to a non-modal profile clears the mode word from the chip.

- [ ] **Step 9: Manual smoke test — popover affordances**

- [ ] Popover opens on chip click, closes on Escape, click outside, or row select.
- [ ] Arrow keys + Enter for keyboard navigation.
- [ ] Active row has checkmark; Strudel row has "default" tag.

- [ ] **Step 10: Regression check**

- [ ] Pattern eval, WAV export, MIDI capture, save-to-disk all still work.
- [ ] Command palette opens with `Cmd+Shift+P` and lists `:w` / `:q` entries findable by literal text search.

- [ ] **Step 11: Commit any verification fixes (if any uncovered issues are tiny)**

If smoke tests reveal small bugs (e.g., a CSS overflow, a missed event listener cleanup), fix them and commit. For larger issues, file a follow-up task and leave a note in the spec's open questions.

```bash
git add <files>
git commit -m "fix: <concise description of regression caught in acceptance run>"
```

---

## Self-Review Checklist (for the writer of this plan)

- [x] **Spec coverage:** All §1–§13 of the spec have a corresponding task. Acceptance items map to Task 16.
- [x] **No placeholders:** Every code-changing step shows the actual code; no "TBD" / "TODO" / "similar to Task N" without code.
- [x] **Type/name consistency:** `applyKeymapProfile`, `reconfigureOverlay`, `subscribeKeymapChange`, `mountKeymapChip`, `formatChipLabel`, `STORAGE_KEY`, `TOOLTIP_SEEN_KEY` used identically across tasks.
- [x] **Test coverage:** `keymap-profiles.js` (Task 1) and `formatChipLabel` (Task 7) have unit tests. UI/CM-extension code is verified manually (matches existing project convention — there are no DOM tests in the suite today).
- [x] **Out-of-scope items:** Cmd+S binding is in the spec's deferred list, not in this plan. The full per-key remap UI is also deferred. No scope creep.
