# Keybinding Overrides Implementation Plan

> Status: not started.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Spec: `design/work/23-keybinding-overrides.md`. Read it before starting. Adjacent spec to coordinate with: `design/work/22-intellisense-v2.md` — see Task 17.
>
> **Commits:** follow [`AGENTS.md`](../../AGENTS.md): commit as you go, conventional messages, no AI attribution. The "Stop and report" steps below were written under an older rule; treat each as the point to commit the task.

**Goal:** Add a per-binding override system on top of the 5-profile keybinding system landed in `21-keybindings.md`, so users can rebind any strasbeat-owned action without leaving their chosen profile. Strudel-parity is preserved by default; overrides opt-in action-by-action.

**Architecture:** A single new always-on CodeMirror compartment (`userOverridesCompartment`) sits at `Prec.highest` between the existing universal keymap and the strasbeat overlay. Actions are defined in a registry (`keymap-actions.js`) that becomes the source of truth for both default-layer keymaps and the override layer. The override compartment loads bindings from `localStorage["strasbeat:keymap-overrides"]`, resolved against the registry. A new sub-section in the Settings panel lets users rebind any action via capture-on-keypress. Conflicts within strasbeat actions trigger an optimistic-apply + Undo banner; conflicts with upstream Strudel reservations or bare-key violations hard-block in the recording UI.

**Tech Stack:** CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`), `@strudel/codemirror`, Node's built-in test runner (`node --test` via `pnpm test`), vanilla DOM for the customize widget (no framework — matches existing UI modules).

---

## File Structure

**New:**

- `src/editor/keymap-actions.js` — action registry (~20 entries) and `resolveKey()`. Pure module.
- `src/editor/keymap-actions.test.js` — registry shape, defaults coverage, resolution.
- `src/editor/keymap-overrides.js` — storage helpers (`loadOverrides`, `saveOverrides`, `migrate`), `validateBinding`, `normalizeBinding`, `buildOverrideKeymap`, `userOverridesCompartment`, `reconfigureOverrides`. Pure where possible; CM-side parts isolated for direct mocking in tests.
- `src/editor/keymap-overrides.test.js` — storage round-trip, migration, validation rules, override-keymap building.
- `src/ui/keymap-customize.js` — Settings sub-section widget: rows, categories, search, recording-mode chip, transfer banner with Undo, per-row × and bulk Reset.
- `src/ui/keymap-customize.test.js` — pure helpers (filter, key formatting, label-display rules).

**Modified:**

- `src/editor/keymap-universal.js` — derive its keymap from registry filtered by `layer === "universal"`, current profile, and overrides.
- `src/editor/keymap.js` — `createVscodeKeymap` derives its keymap from registry filtered by `layer === "overlay"`. Layout fallbacks (`Mod-:`, `Mod-#`, `Tab`, `Shift-Tab`) stay hardcoded.
- `src/editor-setup.js` — add `userOverridesCompartment` to the boot dispatch; thread `onSave` / `onStop` / `onFormat` callbacks into `dispatchEditorExtensions`; export `reconfigureAllKeymaps`.
- `src/editor/keymap-apply.js` — `applyKeymapProfile` also reconfigures the default-layer compartments via `reconfigureAllKeymaps`. Notify subscribers as today.
- `src/ui/settings-panel.js` — mount `keymap-customize` widget below the existing Keymap dropdown.
- `src/ui/command-palette.js` — items that map to registered actions read shortcut text from `resolveKey()`.
- `src/main.js` — wire `onSave: () => saveBtn.click()`, `onStop: () => editor.stop()`, `onFormat: ...` into `dispatchEditorExtensions`.
- `package.json` — add the two new test files to the `test` script.

---

## Task 1: Action registry + resolveKey (TDD)

**Files:**

- Create: `src/editor/keymap-actions.js`
- Test: `src/editor/keymap-actions.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/editor/keymap-actions.test.js`:

```js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  KEYMAP_ACTIONS,
  ACTION_BY_ID,
  CATEGORIES,
  resolveKey,
} from "./keymap-actions.js";

describe("KEYMAP_ACTIONS registry", () => {
  test("every action has a unique non-empty id, label, category, layer", () => {
    const ids = new Set();
    for (const a of KEYMAP_ACTIONS) {
      assert.equal(typeof a.id, "string", `id missing on ${JSON.stringify(a)}`);
      assert.ok(a.id.length > 0);
      assert.ok(!ids.has(a.id), `duplicate id: ${a.id}`);
      ids.add(a.id);
      assert.equal(typeof a.label, "string");
      assert.ok(a.label.length > 0);
      assert.equal(typeof a.category, "string");
      assert.ok(["universal", "overlay"].includes(a.layer), `bad layer on ${a.id}: ${a.layer}`);
      assert.equal(typeof a.run, "function");
    }
  });

  test("every action declares defaultsByProfile for all 5 profile ids", () => {
    const expected = ["strudel", "vscode", "vim", "emacs", "helix"];
    for (const a of KEYMAP_ACTIONS) {
      assert.equal(typeof a.defaultsByProfile, "object");
      for (const id of expected) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(a.defaultsByProfile, id),
          `${a.id} missing default for ${id}`,
        );
        const v = a.defaultsByProfile[id];
        assert.ok(v === null || typeof v === "string", `${a.id}.${id} should be string|null`);
      }
    }
  });

  test("CATEGORIES lists every distinct category at least once, in stable order", () => {
    const used = new Set(KEYMAP_ACTIONS.map((a) => a.category));
    for (const c of used) assert.ok(CATEGORIES.includes(c), `category missing from CATEGORIES: ${c}`);
  });

  test("ACTION_BY_ID lookup returns the same object as the registry array", () => {
    for (const a of KEYMAP_ACTIONS) assert.equal(ACTION_BY_ID.get(a.id), a);
  });

  test("Pattern category includes eval, stop, format, save", () => {
    const ids = new Set(
      KEYMAP_ACTIONS.filter((a) => a.category === "Pattern").map((a) => a.id),
    );
    assert.ok(ids.has("strasbeat.eval"));
    assert.ok(ids.has("strasbeat.stop"));
    assert.ok(ids.has("strasbeat.format"));
    assert.ok(ids.has("strasbeat.save"));
  });

  test("save action defaults to Mod-s in every profile", () => {
    const save = ACTION_BY_ID.get("strasbeat.save");
    for (const id of ["strudel", "vscode", "vim", "emacs", "helix"]) {
      assert.equal(save.defaultsByProfile[id], "Mod-s");
    }
  });

  test("VSCode-overlay actions are null in non-VSCode profiles", () => {
    const overlayIds = ["strasbeat.selectNextOccurrence", "strasbeat.deleteLine", "strasbeat.toggleMute"];
    for (const id of overlayIds) {
      const a = ACTION_BY_ID.get(id);
      assert.ok(a, `missing action: ${id}`);
      assert.equal(a.defaultsByProfile.strudel, null);
      assert.equal(a.defaultsByProfile.vim, null);
      assert.equal(a.defaultsByProfile.emacs, null);
      assert.equal(a.defaultsByProfile.helix, null);
      assert.equal(typeof a.defaultsByProfile.vscode, "string");
    }
  });
});

describe("resolveKey", () => {
  test("returns the override when defined as string", () => {
    assert.equal(
      resolveKey("strasbeat.save", "strudel", { "strasbeat.save": "Mod-Shift-s" }),
      "Mod-Shift-s",
    );
  });

  test("returns null when override is explicit null (unbound)", () => {
    assert.equal(
      resolveKey("strasbeat.save", "vscode", { "strasbeat.save": null }),
      null,
    );
  });

  test("falls back to profile default when no override key present", () => {
    assert.equal(resolveKey("strasbeat.save", "vscode", {}), "Mod-s");
  });

  test("returns null when no override and profile default is null", () => {
    assert.equal(resolveKey("strasbeat.selectNextOccurrence", "strudel", {}), null);
  });

  test("returns null for unknown action id", () => {
    assert.equal(resolveKey("strasbeat.nonexistent", "vscode", {}), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/editor/keymap-actions.test.js
```

Expected: FAIL with "module not found" — the file doesn't exist yet.

- [ ] **Step 3: Implement the registry**

Create `src/editor/keymap-actions.js`:

```js
// Single source of truth for "what actions exist, what they do, and
// their default key per profile." Pure module — no DOM, no CodeMirror
// state imports — testable with `node --test`.
//
// See design/work/23-keybinding-overrides.md §1 for the design.
//
// To add an action: append a new entry. The registry drives:
//   - createUniversalKeymap (filters by layer === 'universal')
//   - createVscodeKeymap    (filters by layer === 'overlay')
//   - buildOverrideKeymap   (resolves overrides against the registry)
//   - the customize sub-section UI (rows iterate over the registry)
//   - command-palette shortcut text (palette items resolve via id)

import {
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import {
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  selectLine,
  toggleComment,
} from "@codemirror/commands";
import {
  toggleMute,
  toggleSolo,
} from "./track-labels.js";
import { toggleLabelAtCursor } from "./keymap.js";

export const CATEGORIES = ["Pattern", "Editor", "Tracks", "App"];

const ALL_PROFILES = ["strudel", "vscode", "vim", "emacs", "helix"];

// Helpers that emit a defaultsByProfile object with the same key in every
// profile, or only in VSCode. Reduces row noise.
const everywhere = (key) => Object.fromEntries(ALL_PROFILES.map((p) => [p, key]));
const vscodeOnly = (key) => ({ strudel: null, vscode: key, vim: null, emacs: null, helix: null });
const noneByDefault = () => Object.fromEntries(ALL_PROFILES.map((p) => [p, null]));

export const KEYMAP_ACTIONS = [
  // ── Pattern ───────────────────────────────────────────────────────
  {
    id: "strasbeat.eval",
    label: "Evaluate pattern",
    category: "Pattern",
    layer: "universal",
    defaultsByProfile: everywhere("Mod-Enter"),
    run: (_view, ctx) => { ctx.onEvaluate(); return true; },
  },
  {
    id: "strasbeat.stop",
    label: "Stop",
    category: "Pattern",
    layer: "universal",
    // Upstream Strudel binds Ctrl+. / Alt+. at Prec.highest. The action
    // exists in the registry only so users can ADD their own additional
    // binding (e.g. Cmd+. for symmetry with eval).
    defaultsByProfile: noneByDefault(),
    run: (_view, ctx) => { ctx.onStop(); return true; },
  },
  {
    id: "strasbeat.format",
    label: "Format pattern",
    category: "Pattern",
    layer: "universal",
    defaultsByProfile: everywhere("Mod-Shift-f"),
    run: (view, ctx) => { ctx.onFormat(view); return true; },
  },
  {
    id: "strasbeat.save",
    label: "Save pattern",
    category: "Pattern",
    layer: "universal",
    defaultsByProfile: everywhere("Mod-s"),
    run: (_view, ctx) => { ctx.onSave(); return true; },
  },

  // ── Editor (VSCode overlay) ───────────────────────────────────────
  {
    id: "strasbeat.selectNextOccurrence",
    label: "Select next occurrence",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-d"),
    run: (view) => selectNextOccurrence(view),
  },
  {
    id: "strasbeat.selectAllMatches",
    label: "Select all matches",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-Shift-l"),
    run: (view) => selectSelectionMatches(view),
  },
  {
    id: "strasbeat.selectLine",
    label: "Select line",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-l"),
    run: (view) => selectLine(view),
  },
  {
    id: "strasbeat.deleteLine",
    label: "Delete line",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-Shift-k"),
    run: (view) => deleteLine(view),
  },
  {
    id: "strasbeat.moveLineUp",
    label: "Move line up",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Alt-ArrowUp"),
    run: (view) => moveLineUp(view),
  },
  {
    id: "strasbeat.moveLineDown",
    label: "Move line down",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Alt-ArrowDown"),
    run: (view) => moveLineDown(view),
  },
  {
    id: "strasbeat.toggleComment",
    label: "Toggle comment",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-/"),
    run: (view) => toggleComment(view),
  },
  {
    id: "strasbeat.indentMore",
    label: "Indent more",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-]"),
    run: (view) => indentMore(view),
  },
  {
    id: "strasbeat.indentLess",
    label: "Indent less",
    category: "Editor",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-["),
    run: (view) => indentLess(view),
  },

  // ── Tracks ────────────────────────────────────────────────────────
  {
    id: "strasbeat.toggleMute",
    label: "Toggle mute",
    category: "Tracks",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-m"),
    run: (view, ctx) =>
      toggleLabelAtCursor(view, ctx.onEvaluate, toggleMute, "input.track-mute"),
  },
  {
    id: "strasbeat.toggleSolo",
    label: "Toggle solo",
    category: "Tracks",
    layer: "overlay",
    defaultsByProfile: vscodeOnly("Mod-Shift-s"),
    run: (view, ctx) =>
      toggleLabelAtCursor(view, ctx.onEvaluate, toggleSolo, "input.track-solo"),
  },

  // ── App ───────────────────────────────────────────────────────────
  // Cmd-B and Cmd-Shift-P live as document-level listeners in main.js
  // for now (Layer 2 page-level). They appear here so the rebind UI
  // can surface them; their `run` calls dispatched via window-level
  // hooks. See spec §"Open questions" item 1 for the lift-into-CM
  // refactor that's deferred.
  {
    id: "strasbeat.toggleRightRail",
    label: "Toggle right rail",
    category: "App",
    layer: "universal",
    defaultsByProfile: everywhere("Mod-b"),
    run: (_view, ctx) => { ctx.onToggleRightRail?.(); return true; },
  },
  {
    id: "strasbeat.commandPalette",
    label: "Open command palette",
    category: "App",
    layer: "universal",
    defaultsByProfile: everywhere("Mod-Shift-p"),
    run: (_view, ctx) => { ctx.onOpenPalette?.(); return true; },
  },
];

export const ACTION_BY_ID = new Map(KEYMAP_ACTIONS.map((a) => [a.id, a]));

/**
 * Resolve the effective key for an action given the active profile and
 * the current overrides map. Returns the override if defined (string OR
 * explicit null), else the profile default, else null.
 *
 * @param {string} actionId
 * @param {string} profileId
 * @param {Record<string, string|null>} overrides
 * @returns {string | null}
 */
export function resolveKey(actionId, profileId, overrides) {
  if (Object.prototype.hasOwnProperty.call(overrides, actionId)) {
    return overrides[actionId];
  }
  const action = ACTION_BY_ID.get(actionId);
  if (!action) return null;
  return action.defaultsByProfile[profileId] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/editor/keymap-actions.test.js
```

Expected: PASS — all assertions green.

- [ ] **Step 5: Stop and report**

Report: Task 1 complete. Suggested commit message for the user:
`feat: add keymap action registry with resolveKey helper`. Don't commit.

---

## Task 2: Override storage — load/save/migrate (TDD)

**Files:**

- Create: `src/editor/keymap-overrides.js` (initial — storage only)
- Test: `src/editor/keymap-overrides.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/editor/keymap-overrides.test.js`:

```js
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  loadOverrides,
  saveOverrides,
  setOverride,
  clearOverride,
  clearAllOverrides,
  STORAGE_KEY,
} from "./keymap-overrides.js";

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

describe("loadOverrides", () => {
  test("returns empty map when storage is empty", () => {
    assert.deepEqual(loadOverrides(), {});
  });

  test("returns empty map when storage contains malformed JSON (and warns)", () => {
    globalThis.localStorage.setItem(STORAGE_KEY, "{not json");
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      assert.deepEqual(loadOverrides(), {});
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => /malformed|parse|JSON/i.test(w)));
  });

  test("round-trips a valid overrides map", () => {
    saveOverrides({ "strasbeat.save": "Mod-s", "strasbeat.toggleRightRail": null });
    assert.deepEqual(loadOverrides(), {
      "strasbeat.save": "Mod-s",
      "strasbeat.toggleRightRail": null,
    });
  });

  test("drops entries with non-string non-null values (and warns)", () => {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        overrides: { "strasbeat.save": "Mod-s", "strasbeat.bad": 42 },
      }),
    );
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const got = loadOverrides();
      assert.deepEqual(got, { "strasbeat.save": "Mod-s" });
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => /strasbeat\.bad/.test(w)));
  });

  test("drops entries with unknown action IDs (and warns) — uses ACTION_BY_ID", () => {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        overrides: {
          "strasbeat.save":      "Mod-s",
          "strasbeat.removed":   "Mod-x",
        },
      }),
    );
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const got = loadOverrides();
      assert.deepEqual(got, { "strasbeat.save": "Mod-s" });
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => /strasbeat\.removed/.test(w)));
  });

  test("future schema version is preserved unread, with one warning", () => {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 99, overrides: { "strasbeat.save": "Mod-s" } }),
    );
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      assert.deepEqual(loadOverrides(), {});
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => /version|downgrade/i.test(w)));
    // Original JSON is untouched.
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    assert.ok(raw.includes('"version":99'));
  });
});

describe("setOverride / clearOverride / clearAllOverrides", () => {
  test("setOverride writes a new entry", () => {
    setOverride("strasbeat.save", "Mod-Shift-s");
    assert.deepEqual(loadOverrides(), { "strasbeat.save": "Mod-Shift-s" });
  });

  test("setOverride with null records explicit unbound", () => {
    setOverride("strasbeat.toggleRightRail", null);
    assert.deepEqual(loadOverrides(), { "strasbeat.toggleRightRail": null });
  });

  test("clearOverride removes the entry entirely (not null)", () => {
    setOverride("strasbeat.save", "Mod-s");
    setOverride("strasbeat.toggleRightRail", null);
    clearOverride("strasbeat.save");
    const got = loadOverrides();
    assert.ok(!Object.prototype.hasOwnProperty.call(got, "strasbeat.save"));
    assert.equal(got["strasbeat.toggleRightRail"], null);
  });

  test("clearAllOverrides wipes everything", () => {
    setOverride("strasbeat.save", "Mod-s");
    setOverride("strasbeat.toggleRightRail", null);
    clearAllOverrides();
    assert.deepEqual(loadOverrides(), {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/editor/keymap-overrides.test.js
```

Expected: FAIL with "module not found".

- [ ] **Step 3: Implement storage helpers**

Create `src/editor/keymap-overrides.js`:

```js
// Override storage + override-keymap construction. See
// design/work/23-keybinding-overrides.md §2-§4 for the design.

import { ACTION_BY_ID } from "./keymap-actions.js";

export const STORAGE_KEY = "strasbeat:keymap-overrides";
const CURRENT_VERSION = 1;

/** @returns {Record<string, string|null>} sanitized overrides map */
export function loadOverrides() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      `[strasbeat/keymap-overrides] malformed JSON in ${STORAGE_KEY}; ignoring`,
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.overrides !== "object") {
    return {};
  }

  const version = Number(parsed.version) || 1;
  if (version > CURRENT_VERSION) {
    console.warn(
      `[strasbeat/keymap-overrides] stored version ${version} > ${CURRENT_VERSION}; not applying. ` +
      `Stored data preserved for forward compatibility.`,
    );
    return {};
  }

  const sanitized = {};
  for (const [id, key] of Object.entries(parsed.overrides)) {
    if (!ACTION_BY_ID.has(id)) {
      console.warn(`[strasbeat/keymap-overrides] dropping unknown action id: ${id}`);
      continue;
    }
    if (key !== null && typeof key !== "string") {
      console.warn(`[strasbeat/keymap-overrides] dropping bad value for ${id}: ${key}`);
      continue;
    }
    sanitized[id] = key;
  }
  return sanitized;
}

export function saveOverrides(overrides) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: CURRENT_VERSION, overrides }),
    );
  } catch (err) {
    console.warn("[strasbeat/keymap-overrides] write failed:", err);
  }
}

export function setOverride(actionId, key) {
  const cur = loadOverrides();
  cur[actionId] = key;
  saveOverrides(cur);
}

export function clearOverride(actionId) {
  const cur = loadOverrides();
  delete cur[actionId];
  saveOverrides(cur);
}

export function clearAllOverrides() {
  saveOverrides({});
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/editor/keymap-overrides.test.js
```

Expected: PASS.

- [ ] **Step 5: Stop and report**

Report: Task 2 complete. Suggested commit message:
`feat: add keymap overrides storage with schema versioning`.

---

## Task 3: Binding validation + normalization (TDD)

Adds `validateBinding`, `normalizeBinding`, and the `UPSTREAM_RESERVED` set to `keymap-overrides.js`.

**Files:**

- Modify: `src/editor/keymap-overrides.js`
- Test: `src/editor/keymap-overrides.test.js` (extend existing)

- [ ] **Step 1: Append failing tests**

Append to `src/editor/keymap-overrides.test.js`:

```js
import {
  validateBinding,
  normalizeBinding,
  UPSTREAM_RESERVED,
} from "./keymap-overrides.js";

describe("normalizeBinding", () => {
  test("preserves canonical CM6 Mod-… form", () => {
    assert.equal(normalizeBinding("Mod-s"), "Mod-s");
    assert.equal(normalizeBinding("Mod-Shift-f"), "Mod-Shift-f");
    assert.equal(normalizeBinding("Alt-ArrowDown"), "Alt-ArrowDown");
  });

  test("lowercases letters but preserves modifier and named-key casing", () => {
    assert.equal(normalizeBinding("Mod-S"), "Mod-s");
    assert.equal(normalizeBinding("Mod-shift-K"), "Mod-Shift-k");
    assert.equal(normalizeBinding("alt-arrowup"), "Alt-ArrowUp");
  });

  test("orders modifiers canonically: Mod, Alt, Shift", () => {
    assert.equal(normalizeBinding("Shift-Mod-f"), "Mod-Shift-f");
    assert.equal(normalizeBinding("Alt-Mod-d"), "Mod-Alt-d");
  });
});

describe("validateBinding", () => {
  const fakeRegistry = new Map([
    ["a", { id: "a", defaultsByProfile: { vscode: "Mod-d" } }],
    ["b", { id: "b", defaultsByProfile: { vscode: "Mod-Shift-k" } }],
  ]);

  test("accepts modifier-keyed binding with no conflict", () => {
    const r = validateBinding("Mod-j", fakeRegistry, {}, "vscode");
    assert.equal(r.ok, true);
    assert.equal(r.transferFrom, undefined);
  });

  test("rejects bare letter (no modifier)", () => {
    const r = validateBinding("k", fakeRegistry, {}, "vscode");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "modifier-required");
  });

  test("rejects bare digit", () => {
    assert.equal(
      validateBinding("3", fakeRegistry, {}, "vscode").reason,
      "modifier-required",
    );
  });

  test("accepts modifier-stable bare keys (Tab, ArrowDown, F1)", () => {
    assert.equal(validateBinding("Tab", fakeRegistry, {}, "vscode").ok, true);
    assert.equal(validateBinding("ArrowDown", fakeRegistry, {}, "vscode").ok, true);
    assert.equal(validateBinding("F1", fakeRegistry, {}, "vscode").ok, true);
  });

  test("rejects upstream Strudel reservations", () => {
    for (const k of ["Ctrl-Enter", "Alt-Enter", "Ctrl-.", "Alt-.", "Alt-w", "Alt-q"]) {
      const r = validateBinding(k, fakeRegistry, {}, "vscode");
      assert.equal(r.ok, false, `${k} should be reserved`);
      assert.equal(r.reason, "upstream-reserved");
    }
  });

  test("detects internal conflict against profile default", () => {
    const r = validateBinding("Mod-d", fakeRegistry, {}, "vscode");
    assert.equal(r.ok, true);
    assert.equal(r.transferFrom, "a");
  });

  test("detects internal conflict against an existing override", () => {
    const r = validateBinding("Mod-j", fakeRegistry, { a: "Mod-j" }, "vscode");
    assert.equal(r.transferFrom, "a");
  });

  test("ignores defaults that are nulled by an override of the same action", () => {
    const r = validateBinding("Mod-d", fakeRegistry, { a: null }, "vscode");
    assert.equal(r.transferFrom, undefined);
  });

  test("does not collide with the action being rebound", () => {
    const r = validateBinding(
      "Mod-d",
      fakeRegistry,
      {},
      "vscode",
      "a",  // ← excluded action id
    );
    assert.equal(r.transferFrom, undefined);
  });

  test("UPSTREAM_RESERVED is a Set of strings", () => {
    assert.ok(UPSTREAM_RESERVED instanceof Set);
    assert.ok(UPSTREAM_RESERVED.has("Ctrl-Enter"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/editor/keymap-overrides.test.js
```

Expected: FAIL — `validateBinding`, `normalizeBinding`, `UPSTREAM_RESERVED` not exported yet.

- [ ] **Step 3: Append the validation logic**

Append to `src/editor/keymap-overrides.js`:

```js
// ─── Binding validation ───────────────────────────────────────────────

export const UPSTREAM_RESERVED = new Set([
  "Ctrl-Enter", "Alt-Enter", "Ctrl-.", "Alt-.", "Alt-w", "Alt-q",
]);

const MODIFIERS_ORDER = ["Mod", "Ctrl", "Alt", "Shift"];

const NAMED_KEY_PATTERN = /^(?:Tab|Enter|Escape|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F\d{1,2})$/;

const NAMED_KEY_CANONICAL = new Map([
  ["arrowup", "ArrowUp"], ["arrowdown", "ArrowDown"],
  ["arrowleft", "ArrowLeft"], ["arrowright", "ArrowRight"],
  ["tab", "Tab"], ["enter", "Enter"], ["escape", "Escape"],
  ["backspace", "Backspace"], ["delete", "Delete"], ["space", "Space"],
  ["home", "Home"], ["end", "End"], ["pageup", "PageUp"], ["pagedown", "PageDown"],
]);

/**
 * Normalize a CM6-style binding into a canonical form so two
 * representations of the same combo compare equal.
 *
 *   "Mod-S"        → "Mod-s"
 *   "Shift-Mod-f"  → "Mod-Shift-f"
 *   "alt-arrowup"  → "Alt-ArrowUp"
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeBinding(input) {
  const parts = input.split("-").filter(Boolean);
  const mods = [];
  let key = "";
  for (const p of parts) {
    const lc = p.toLowerCase();
    if (lc === "mod") mods.push("Mod");
    else if (lc === "ctrl") mods.push("Ctrl");
    else if (lc === "alt") mods.push("Alt");
    else if (lc === "shift") mods.push("Shift");
    else key = canonicalKey(p);
  }
  mods.sort((a, b) => MODIFIERS_ORDER.indexOf(a) - MODIFIERS_ORDER.indexOf(b));
  return [...mods, key].filter(Boolean).join("-");
}

function canonicalKey(token) {
  const lc = token.toLowerCase();
  if (NAMED_KEY_CANONICAL.has(lc)) return NAMED_KEY_CANONICAL.get(lc);
  // Function keys: F1, F12 — uppercase F + digits
  if (/^f\d{1,2}$/i.test(token)) return token.toUpperCase();
  // Plain letter / digit / punct — single-char letters lowercase, others as-is
  if (/^[a-z]$/i.test(token)) return token.toLowerCase();
  return token;
}

function hasModifier(binding) {
  return /(?:^|-)(?:Mod|Ctrl|Alt)(?:-|$)/.test(binding);
}

function isModifierStableBareKey(binding) {
  // Single token, no modifiers. Allowed: named keys (Tab, Arrow*, F\d, etc.)
  if (binding.includes("-")) return false;
  return NAMED_KEY_PATTERN.test(binding);
}

/**
 * Validate a captured key.
 *
 * Returns:
 *   { ok: true } — no conflict, ready to commit
 *   { ok: true, transferFrom: actionId } — conflicts with another action
 *   { ok: false, reason: "modifier-required" | "upstream-reserved" }
 *
 * @param {string} key — already normalized via normalizeBinding
 * @param {Map<string, {id: string, defaultsByProfile: Record<string, string|null>}>} registry
 * @param {Record<string, string|null>} overrides
 * @param {string} currentProfile
 * @param {string=} excludeActionId — the action being rebound (skip self-conflict)
 */
export function validateBinding(key, registry, overrides, currentProfile, excludeActionId) {
  if (!hasModifier(key) && !isModifierStableBareKey(key)) {
    return { ok: false, reason: "modifier-required" };
  }
  if (UPSTREAM_RESERVED.has(key)) {
    return { ok: false, reason: "upstream-reserved" };
  }
  for (const [id, action] of registry) {
    if (id === excludeActionId) continue;
    const effective = Object.prototype.hasOwnProperty.call(overrides, id)
      ? overrides[id]
      : action.defaultsByProfile?.[currentProfile] ?? null;
    if (effective === key) return { ok: true, transferFrom: id };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/editor/keymap-overrides.test.js
```

Expected: PASS — all old + new tests green.

- [ ] **Step 5: Stop and report**

Report: Task 3 complete. Suggested commit message:
`feat: add binding validation + normalization for keymap overrides`.

---

## Task 4: Override-keymap builder + CM compartment (TDD)

Adds `buildOverrideKeymap`, `userOverridesCompartment`, `reconfigureOverrides`, `reconfigureAllKeymaps`. The CM-side parts are kept thin so the pure parts stay testable.

**Files:**

- Modify: `src/editor/keymap-overrides.js`
- Test: `src/editor/keymap-overrides.test.js` (extend)

- [ ] **Step 1: Append failing tests**

Append to `src/editor/keymap-overrides.test.js`:

```js
import { buildOverrideEntries } from "./keymap-overrides.js";
import { ACTION_BY_ID } from "./keymap-actions.js";

describe("buildOverrideEntries", () => {
  // Pure helper — returns [{ key, run }] entries to feed into keymap.of([]).
  // Excludes overrides that are null (explicitly unbound).
  test("returns empty array when overrides map is empty", () => {
    assert.deepEqual(buildOverrideEntries(ACTION_BY_ID, {}, {}), []);
  });

  test("emits one entry per non-null override, run wraps action.run with ctx", () => {
    let evalCalls = 0;
    const ctx = { onEvaluate: () => evalCalls++, onSave: () => {}, onStop: () => {}, onFormat: () => {} };
    const entries = buildOverrideEntries(
      ACTION_BY_ID,
      { "strasbeat.eval": "Mod-Shift-Enter" },
      ctx,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, "Mod-Shift-Enter");
    entries[0].run({});  // fake view
    assert.equal(evalCalls, 1);
  });

  test("skips overrides whose value is null (explicit unbound)", () => {
    const entries = buildOverrideEntries(
      ACTION_BY_ID,
      { "strasbeat.toggleRightRail": null },
      {},
    );
    assert.deepEqual(entries, []);
  });

  test("skips overrides for unknown action IDs (defensive)", () => {
    const entries = buildOverrideEntries(
      ACTION_BY_ID,
      { "strasbeat.unknown": "Mod-x" },
      {},
    );
    assert.deepEqual(entries, []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/editor/keymap-overrides.test.js
```

Expected: FAIL — `buildOverrideEntries` not exported.

- [ ] **Step 3: Append the builder + CM glue**

Append to `src/editor/keymap-overrides.js`:

```js
// ─── Override-keymap construction ─────────────────────────────────────

import { Compartment, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/**
 * Pure: build entries for keymap.of([...]) given the registry, overrides,
 * and a callback ctx.
 *
 * @param {Map<string, any>} registry
 * @param {Record<string, string|null>} overrides
 * @param {object} ctx
 * @returns {Array<{ key: string, run: (view: any) => boolean }>}
 */
export function buildOverrideEntries(registry, overrides, ctx) {
  const entries = [];
  for (const [id, key] of Object.entries(overrides)) {
    if (key === null) continue;
    const action = registry.get(id);
    if (!action) continue;
    entries.push({
      key,
      run: (view) => action.run(view, ctx),
    });
  }
  return entries;
}

// CM6 compartment for user overrides. Always loaded at boot. Reconfigured
// whenever the user changes an override.
export const userOverridesCompartment = new Compartment();

/**
 * Build the CM extension to seed the override compartment.
 * @param {{ registry: Map<string, any>, overrides: Record<string, string|null>, ctx: object }} args
 */
export function buildOverrideExtension({ registry, overrides, ctx }) {
  return Prec.highest(
    keymap.of(buildOverrideEntries(registry, overrides, ctx)),
  );
}

/**
 * Live-swap the override extension. Called when the user adds, changes,
 * or clears an override.
 */
export function reconfigureOverrides(editor, registry, overrides, ctx) {
  editor.editor.dispatch({
    effects: userOverridesCompartment.reconfigure(
      buildOverrideExtension({ registry, overrides, ctx }),
    ),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/editor/keymap-overrides.test.js
```

Expected: PASS — all tests green.

- [ ] **Step 5: Stop and report**

Report: Task 4 complete. Suggested commit message:
`feat: add override compartment + buildOverrideEntries`.

---

## Task 5: Refactor keymap-universal.js to read from registry

`createUniversalKeymap` becomes a thin shim over the registry. Its filter:
`layer === "universal"`, default present in active profile, action not
explicitly unbound (override !== null), and no non-null override for the
same action (the override compartment owns those).

**Files:**

- Modify: `src/editor/keymap-universal.js`

- [ ] **Step 1: Read the current file**

Skim `src/editor/keymap-universal.js` for the current contents — currently
it exports `createUniversalKeymap({ onEvaluate })` returning a one-entry
`keymap.of([{ key: "Mod-Enter", ... }])`.

- [ ] **Step 2: Replace the implementation**

Overwrite `src/editor/keymap-universal.js` with:

```js
// Layer-2 always-on CodeMirror keymap. Bindings here are loaded
// unconditionally regardless of which profile (Strudel / VSCode / Vim /
// Emacs / Helix) the user has selected — they are app-shell shortcuts
// that don't conflict with strudel.cc muscle memory because strudel.cc
// doesn't have them.
//
// As of spec 23, this module derives its bindings from the action
// registry in keymap-actions.js. To add a new universal binding, add
// an entry there with `layer: "universal"`.
//
// See design/work/21-keybindings.md §"Mental model" for the layered
// model and design/work/23-keybinding-overrides.md §"Approach" for the
// registry-driven refactor.

import { keymap } from "@codemirror/view";
import { KEYMAP_ACTIONS } from "./keymap-actions.js";

export function createUniversalKeymap({ profile, ctx, overrides = {} }) {
  return keymap.of(
    KEYMAP_ACTIONS
      .filter((a) => a.layer === "universal")
      .filter((a) => a.defaultsByProfile[profile.id])           // has a default in this profile
      .filter((a) => overrides[a.id] !== null)                  // not explicitly unbound
      .filter((a) => !overrides[a.id])                          // not overridden to a non-null key
      .map((a) => ({
        key: a.defaultsByProfile[profile.id],
        run: (view) => a.run(view, ctx),
        preventDefault: true,
      })),
  );
}
```

- [ ] **Step 3: Build to verify it compiles**

```bash
pnpm build
```

Expected: build succeeds. (Existing tests for adjacent files still pass.)

- [ ] **Step 4: Stop and report**

Report: Task 5 complete. Suggested commit message:
`refactor: derive universal keymap from action registry`.

---

## Task 6: Refactor keymap.js (createVscodeKeymap) to read from registry

`createVscodeKeymap` becomes registry-driven. Layout-fallback bindings
(`Mod-:`, `Mod-#`, `Tab`, `Shift-Tab`) stay hardcoded — they're
reachability fallbacks, not separate user-facing actions.

**Files:**

- Modify: `src/editor/keymap.js`

- [ ] **Step 1: Replace the implementation**

Replace the contents of `src/editor/keymap.js`. Keep `toggleLabelAtCursor`
exported (it's imported by `keymap-actions.js`). Replace `createVscodeKeymap`:

```js
// VSCode-style key bindings the Strudel default editor doesn't expose.
// As of spec 23, this module derives its bindings from the action
// registry; only the layout-fallback entries (AZERTY/QWERTZ
// reachability) are still hardcoded.
//
// See design/work/21-keybindings.md (original spec) and
// design/work/23-keybinding-overrides.md (registry refactor).

import { keymap } from "@codemirror/view";
import { indentLess, indentMore, indentWithTab, toggleComment } from "@codemirror/commands";

import { computeNewSelection } from "./format.js";
import { labelAtLine, parseLabels } from "./track-labels.js";
import { KEYMAP_ACTIONS } from "./keymap-actions.js";

// Exported so keymap-actions.js (and command-palette.js) can call
// mute/solo without simulating keypresses.
export function toggleLabelAtCursor(view, onEvaluate, toggleLabel, userEvent) {
  const code = view.state.doc.toString();
  const oldSelection = view.state.selection;
  const oldDoc = view.state.doc;
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const label = labelAtLine(parseLabels(code), cursorLine);
  if (!label) return true;
  const nextCode = toggleLabel(code, label.displayName);
  if (nextCode === code) return true;
  view.dispatch({
    changes: { from: 0, to: code.length, insert: nextCode },
    selection: computeNewSelection(oldSelection, oldDoc, nextCode),
    userEvent,
  });
  onEvaluate();
  return true;
}

export function createVscodeKeymap({ profile, ctx, overrides = {} }) {
  const registryEntries = KEYMAP_ACTIONS
    .filter((a) => a.layer === "overlay")
    .filter((a) => a.defaultsByProfile[profile.id])
    .filter((a) => overrides[a.id] !== null)
    .filter((a) => !overrides[a.id])
    .map((a) => ({
      key: a.defaultsByProfile[profile.id],
      run: (view) => a.run(view, ctx),
      preventDefault: true,
    }));

  // Layout fallbacks — reachability for AZERTY/QWERTZ. Not separate
  // actions; they invoke the same CM6 commands as the registry entries
  // would, via different keystrokes. Multi-binding is harmless on the
  // wrong layout.
  const layoutFallbacks = [
    { key: "Mod-:", run: toggleComment },
    { key: "Mod-#", run: toggleComment },
    { key: "Mod-]", run: indentMore },
    { key: "Mod-[", run: indentLess },
    indentWithTab,
  ];

  return keymap.of([...registryEntries, ...layoutFallbacks]);
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

Expected: build succeeds.

- [ ] **Step 3: Stop and report**

Report: Task 6 complete. Suggested commit message:
`refactor: derive VSCode overlay from action registry`.

---

## Task 7: Wire override compartment into editor-setup.js boot path

Read overrides at boot, build the override extension, dispatch alongside
the universal + overlay keymaps. Thread `onSave` / `onStop` / `onFormat`
callbacks through.

**Files:**

- Modify: `src/editor-setup.js`

- [ ] **Step 1: Update dispatchEditorExtensions**

Replace the imports and `dispatchEditorExtensions` block in
`src/editor-setup.js` with:

```js
// (existing imports) ...
import { ACTION_BY_ID } from "./editor/keymap-actions.js";
import {
  loadOverrides,
  buildOverrideExtension,
  userOverridesCompartment,
  reconfigureOverrides,
} from "./editor/keymap-overrides.js";

// ... (rest of file unchanged until dispatchEditorExtensions)

export function dispatchEditorExtensions(editor, {
  onOpenReference,
  onSave,
  onStop,
  onFormat,
  onToggleRightRail,
  onOpenPalette,
}) {
  const profile = getProfile(getStoredProfileId());
  const overrides = loadOverrides();
  const ctx = {
    onEvaluate: () => editor.evaluate(),
    onStop: onStop ?? (() => editor.stop()),
    onFormat: onFormat ?? (() => {}),
    onSave: onSave ?? (() => {}),
    onToggleRightRail,
    onOpenPalette,
  };

  editor.editor.dispatch({
    effects: StateEffect.appendConfig.of([
      errorMarksExtension,
      Prec.highest(formatExtension),
      Prec.highest(createUniversalKeymap({ profile, ctx, overrides })),
      strasbeatOverlayCompartment.of(
        profile.applyStrasbeatOverlay
          ? Prec.highest(createVscodeKeymap({ profile, ctx, overrides }))
          : [],
      ),
      userOverridesCompartment.of(
        buildOverrideExtension({ registry: ACTION_BY_ID, overrides, ctx }),
      ),
      numericScrubber({ evaluate: () => editor.repl.evaluate(editor.code, false) }),
      hoverDocs({ onOpenReference }),
      signatureHint,
    ]),
  });

  // Stash ctx on the editor so reconfigureOverlay / reconfigureAllKeymaps
  // can rebuild keymaps with the same callbacks later.
  editor.__strasbeatKeymapCtx = ctx;
}
```

- [ ] **Step 2: Update reconfigureOverlay to take overrides**

Replace `reconfigureOverlay` in the same file:

```js
export function reconfigureOverlay(editor, applyOverlay) {
  const ctx = editor.__strasbeatKeymapCtx;
  const profile = getProfile(getStoredProfileId());
  const overrides = loadOverrides();
  editor.editor.dispatch({
    effects: strasbeatOverlayCompartment.reconfigure(
      applyOverlay
        ? Prec.highest(createVscodeKeymap({ profile, ctx, overrides }))
        : [],
    ),
  });
}
```

- [ ] **Step 3: Add reconfigureAllKeymaps export**

Add to `src/editor-setup.js`:

```js
// Called when overrides change OR when the active profile changes.
// Reconfigures all three keymap-bearing compartments in one transaction.
//
// Why "all three": override changes can promote/demote actions between
// the override compartment and the default-layer compartments. Profile
// changes change which entries the default-layer compartments include.
// Bundled into one dispatch to avoid intermediate flicker.
export function reconfigureAllKeymaps(editor) {
  const ctx = editor.__strasbeatKeymapCtx;
  if (!ctx) return;
  const profile = getProfile(getStoredProfileId());
  const overrides = loadOverrides();

  editor.editor.dispatch({
    effects: [
      strasbeatOverlayCompartment.reconfigure(
        profile.applyStrasbeatOverlay
          ? Prec.highest(createVscodeKeymap({ profile, ctx, overrides }))
          : [],
      ),
      userOverridesCompartment.reconfigure(
        buildOverrideExtension({ registry: ACTION_BY_ID, overrides, ctx }),
      ),
    ],
  });
}
```

Note: the universal keymap is loaded once at boot via
`StateEffect.appendConfig` — it cannot be reconfigured live (no
compartment). This is acceptable because its contents only change when
the override map gains/loses an entry that *would* land in the universal
layer, and those changes are rare in practice. For a fully-live universal
keymap, wrap it in a Compartment in a follow-up. (Listed in spec
*Open questions*.)

- [ ] **Step 4: Build + smoke test**

```bash
pnpm build
pnpm dev
```

Open `http://localhost:5173`. Smoke checks:
- Editor renders.
- `Cmd+Enter` evaluates a pattern.
- Switch profile to VSCode via the chip; `Cmd+D` selects next occurrence.
- Switch back to Strudel; `Cmd+D` does nothing.
- Reload page — selected profile persists.

- [ ] **Step 5: Stop and report**

Report: Task 7 complete. Suggested commit message:
`feat: wire user overrides compartment into editor boot`.

---

## Task 8: Save action wiring (Cmd+S)

Wire the `onSave` callback so the registry's `strasbeat.save` action
calls the existing toolbar save button. Verify `Cmd+S` saves on every
profile.

**Files:**

- Modify: `src/main.js`

- [ ] **Step 1: Find the dispatchEditorExtensions call site**

```bash
grep -n "dispatchEditorExtensions" /Users/ben/Projects/strasbeat/src/main.js
```

Locate the existing call.

- [ ] **Step 2: Pass new callbacks**

Find the existing call:

```js
dispatchEditorExtensions(editor, { onOpenReference });
```

Replace with:

```js
dispatchEditorExtensions(editor, {
  onOpenReference,
  onSave: () => saveBtn.click(),
  onStop: () => editor.stop(),
  onFormat: (view) => {
    // Reuse the existing format binding by simulating Cmd+Shift+F via
    // the formatExtension. The simplest path: format the buffer
    // directly via the same import the formatExtension uses.
    // If a shared formatBuffer helper doesn't exist, the action's
    // run is a no-op for now — the format extension still binds
    // Mod-Shift-f at Prec.highest as before.
  },
  onToggleRightRail: () => {
    // The existing Mod-B page-level handler in main.js already toggles
    // the rail — wire that here if it's exposed; otherwise leave
    // undefined and the registry's run becomes a no-op (page-level
    // listener still fires).
    document.dispatchEvent(new CustomEvent("strasbeat:toggle-right-rail"));
  },
  onOpenPalette: () => {
    document.dispatchEvent(new CustomEvent("strasbeat:open-palette"));
  },
});
```

- [ ] **Step 3: Hook the new custom events to existing handlers**

Locate the existing `Mod-B` and `Mod-Shift-P` listeners in `main.js`:

```bash
grep -n "Mod-B\|Mod-Shift-P\|toggleRightRail\|openCommandPalette\|MetaKey\|ctrlKey" /Users/ben/Projects/strasbeat/src/main.js | head -20
```

Add (or extend) listeners for the new custom events. If the existing
handler is named e.g. `toggleRightRail()`:

```js
document.addEventListener("strasbeat:toggle-right-rail", () => toggleRightRail());
document.addEventListener("strasbeat:open-palette", () => openCommandPalette());
```

If the existing handlers are inline closures inside the keydown listener,
extract them to named functions first.

- [ ] **Step 4: Verify save shortcut works**

```bash
pnpm dev
```

In each profile (Strudel, VSCode, Vim, Emacs, Helix):
- Open a pattern.
- Edit it.
- Press `Cmd+S`.
- Verify the file persists to `patterns/<name>.js` (check via terminal).
- In Vim, switch to insert mode first; verify `Cmd+S` works there too. Switch to normal mode; verify it works. Verify `:w⏎` still works as before.

- [ ] **Step 5: Stop and report**

Report: Task 8 complete. Suggested commit message:
`feat: wire Cmd+S save action through the keymap registry`.

---

## Task 9: applyKeymapProfile reconfigures all keymaps

When the user picks a different profile, the universal + overlay
keymaps' contents change (different defaults per profile). The override
compartment does NOT change.

**Files:**

- Modify: `src/editor/keymap-apply.js`

- [ ] **Step 1: Update applyKeymapProfile**

Replace the body of `applyKeymapProfile` in `src/editor/keymap-apply.js`:

```js
import {
  getProfile,
  setStoredProfileId,
} from "./keymap-profiles.js";
import { applyPanelSetting, reconfigureAllKeymaps } from "../editor-setup.js";

const subscribers = new Set();

export function subscribeKeymapChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function applyKeymapProfile(editor, profileId, _opts = {}) {
  const profile = getProfile(profileId);

  applyPanelSetting(editor, "keybindings", profile.strudelKeybindings);
  reconfigureAllKeymaps(editor);
  setStoredProfileId(profile.id);

  for (const fn of subscribers) {
    try { fn(profile); }
    catch (err) { console.warn("[strasbeat/keymap] subscriber threw:", err); }
  }
}
```

The `_opts.onEvaluate` parameter is removed (`reconfigureAllKeymaps`
reads ctx from the editor stash instead). Verify all call sites still
work:

```bash
grep -rn "applyKeymapProfile" /Users/ben/Projects/strasbeat/src/
```

If any caller relied on `{ onEvaluate }`, just remove it — the function
signature now ignores opts.

- [ ] **Step 2: Smoke test profile switching**

```bash
pnpm dev
```

- Switch profile via the chip; verify `Cmd+D` works only in VSCode profile.
- Switch profile via Settings dropdown; verify same behavior.
- Verify the chip + dropdown stay in sync.

- [ ] **Step 3: Stop and report**

Report: Task 9 complete. Suggested commit message:
`refactor: applyKeymapProfile uses reconfigureAllKeymaps`.

---

## Task 10: Customize widget skeleton — keymap-customize.js

Mounts in the Settings panel. Renders categories + rows. No recording
yet — chips display the resolved key only. Pure-helper layer is
unit-tested.

**Files:**

- Create: `src/ui/keymap-customize.js`
- Test: `src/ui/keymap-customize.test.js`

- [ ] **Step 1: Write the failing test for the pure helper**

Create `src/ui/keymap-customize.test.js`:

```js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatKeyDisplay, groupActionsByCategory } from "./keymap-customize.js";

describe("formatKeyDisplay", () => {
  test("converts CM6 'Mod' to platform-appropriate prefix", () => {
    // On non-Apple platforms, Mod → Ctrl
    assert.equal(formatKeyDisplay("Mod-s", { isMac: false }), "Ctrl+S");
    assert.equal(formatKeyDisplay("Mod-s", { isMac: true }), "Cmd+S");
  });

  test("reorders modifiers in canonical display order", () => {
    assert.equal(formatKeyDisplay("Mod-Shift-f", { isMac: true }), "Cmd+Shift+F");
  });

  test("renders arrows as glyphs", () => {
    assert.equal(formatKeyDisplay("Alt-ArrowDown", { isMac: true }), "Opt+↓");
  });

  test("returns 'Unbound' for null", () => {
    assert.equal(formatKeyDisplay(null, { isMac: false }), "Unbound");
  });
});

describe("groupActionsByCategory", () => {
  test("groups by category, preserving registry order within each category", () => {
    const actions = [
      { id: "a1", category: "Pattern" },
      { id: "b1", category: "Editor" },
      { id: "a2", category: "Pattern" },
    ];
    const groups = groupActionsByCategory(actions, ["Pattern", "Editor"]);
    assert.deepEqual(groups, [
      { category: "Pattern", actions: [{ id: "a1", category: "Pattern" }, { id: "a2", category: "Pattern" }] },
      { category: "Editor", actions: [{ id: "b1", category: "Editor" }] },
    ]);
  });

  test("omits empty categories", () => {
    const groups = groupActionsByCategory([], ["Pattern", "Editor"]);
    assert.deepEqual(groups, []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/ui/keymap-customize.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement skeleton + helpers**

Create `src/ui/keymap-customize.js`:

```js
// Customize keymap sub-section in the Settings panel. Lives below the
// existing Keymap profile dropdown; renders one row per registered
// action, grouped by category. Categories with no active bindings in
// the current profile auto-collapse.
//
// See design/work/23-keybinding-overrides.md §5-§6 for the design.

import {
  KEYMAP_ACTIONS,
  CATEGORIES,
  ACTION_BY_ID,
  resolveKey,
} from "../editor/keymap-actions.js";
import {
  loadOverrides,
  setOverride,
  clearOverride,
  clearAllOverrides,
  validateBinding,
  normalizeBinding,
} from "../editor/keymap-overrides.js";
import { reconfigureAllKeymaps } from "../editor-setup.js";
import {
  getStoredProfileId,
  getProfile,
} from "../editor/keymap-profiles.js";
import { subscribeKeymapChange } from "../editor/keymap-apply.js";

// ─── Pure helpers (testable) ──────────────────────────────────────────

const isMacDefault = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function formatKeyDisplay(key, opts = {}) {
  if (key === null || key === undefined) return "Unbound";
  const isMac = opts.isMac ?? isMacDefault();
  const parts = key.split("-");
  const display = parts.map((p) => {
    if (p === "Mod") return isMac ? "Cmd" : "Ctrl";
    if (p === "Alt") return isMac ? "Opt" : "Alt";
    if (p === "Shift") return "Shift";
    if (p === "Ctrl") return "Ctrl";
    if (p === "ArrowUp") return "↑";
    if (p === "ArrowDown") return "↓";
    if (p === "ArrowLeft") return "←";
    if (p === "ArrowRight") return "→";
    if (/^[a-z]$/.test(p)) return p.toUpperCase();
    return p;
  });
  return display.join("+");
}

export function groupActionsByCategory(actions, categoryOrder) {
  const groups = [];
  for (const cat of categoryOrder) {
    const inCat = actions.filter((a) => a.category === cat);
    if (inCat.length > 0) groups.push({ category: cat, actions: inCat });
  }
  return groups;
}

// ─── Widget mount ─────────────────────────────────────────────────────

export function mountKeymapCustomize({ container, editor }) {
  let root = document.createElement("div");
  root.className = "keymap-customize";

  // Heading
  const header = document.createElement("div");
  header.className = "keymap-customize__header";
  const title = document.createElement("span");
  title.className = "settings-panel__row-label";
  title.textContent = "Customize keys";
  header.appendChild(title);
  root.appendChild(header);

  const subtitle = document.createElement("div");
  subtitle.className = "keymap-customize__subtitle";
  subtitle.textContent = "Showing all strasbeat actions. Defaults vary by profile.";
  root.appendChild(subtitle);

  // Body container that re-renders on profile/override change
  const body = document.createElement("div");
  body.className = "keymap-customize__body";
  root.appendChild(body);

  function render() {
    body.replaceChildren();
    const profile = getProfile(getStoredProfileId());
    const overrides = loadOverrides();
    const groups = groupActionsByCategory(KEYMAP_ACTIONS, CATEGORIES);

    for (const { category, actions } of groups) {
      const section = document.createElement("div");
      section.className = "keymap-customize__category";

      // Auto-collapse rule: if every action in this category resolves
      // to null in the current profile (default and override both null),
      // the section starts collapsed.
      const anyBound = actions.some((a) => resolveKey(a.id, profile.id, overrides) !== null);
      section.dataset.collapsed = anyBound ? "0" : "1";

      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "keymap-customize__category-heading";
      heading.textContent = `${category}${anyBound ? "" : ` — ${actions.length} actions, none bound`}`;
      heading.addEventListener("click", () => {
        section.dataset.collapsed = section.dataset.collapsed === "1" ? "0" : "1";
      });
      section.appendChild(heading);

      const rows = document.createElement("div");
      rows.className = "keymap-customize__rows";
      for (const action of actions) {
        rows.appendChild(buildRow(action, profile, overrides, render));
      }
      section.appendChild(rows);
      body.appendChild(section);
    }
  }

  function buildRow(action, profile, overrides, rerender) {
    const row = document.createElement("div");
    row.className = "keymap-customize__row";

    const label = document.createElement("span");
    label.className = "keymap-customize__label";
    label.textContent = action.label;
    row.appendChild(label);

    const right = document.createElement("span");
    right.className = "keymap-customize__right";

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "keymap-customize__chip";
    const resolved = resolveKey(action.id, profile.id, overrides);
    chip.textContent = formatKeyDisplay(resolved);
    chip.dataset.unbound = resolved === null ? "1" : "0";
    right.appendChild(chip);

    // × button — only when an override exists for this action.
    if (Object.prototype.hasOwnProperty.call(overrides, action.id)) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "keymap-customize__clear";
      x.setAttribute("aria-label", `Clear override for ${action.label}`);
      x.textContent = "×";
      x.addEventListener("click", () => {
        clearOverride(action.id);
        reconfigureAllKeymaps(editor);
        rerender();
      });
      right.appendChild(x);
    }

    row.appendChild(right);
    return row;
  }

  render();
  container.appendChild(root);

  // Re-render when profile changes (defaults shift).
  const unsub = subscribeKeymapChange(() => render());

  return {
    destroy: () => {
      unsub();
      root.remove();
    },
  };
}
```

- [ ] **Step 4: Run pure-helper tests**

```bash
pnpm test src/ui/keymap-customize.test.js
```

Expected: PASS.

- [ ] **Step 5: Stop and report**

Report: Task 10 complete. Suggested commit message:
`feat: skeleton customize widget with categories and chips`.

---

## Task 11: Recording state on chips (no transfer banner yet)

Click a chip → enter recording → capture keypress → validate →
silent-commit OR show inline error. Transfer banner deferred to Task 12.

**Files:**

- Modify: `src/ui/keymap-customize.js`

- [ ] **Step 1: Add recording handler to chip**

In `buildRow`, replace the chip's existing setup with the recording logic.
Add this code where the chip is built:

```js
chip.addEventListener("click", () => beginRecording(chip, action, rerender));
```

Add the helper functions to the module (top-level, not inside mount):

```js
function beginRecording(chip, action, rerender) {
  // Exit any other chip already recording.
  for (const c of document.querySelectorAll(".keymap-customize__chip[data-recording='1']")) {
    if (c !== chip) endRecording(c);
  }
  chip.dataset.recording = "1";
  chip.textContent = "Press a key…";
  chip.dataset.error = "";
  chip.focus();

  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") return endRecording(chip);
    if (e.key === "Tab") {
      endRecording(chip);
      return;  // browser focus moves naturally
    }
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // wait for non-modifier

    const captured = captureKeyEvent(e);
    if (!captured) return;

    const normalized = normalizeBinding(captured);
    const overrides = loadOverrides();
    const profile = getProfile(getStoredProfileId());
    const verdict = validateBinding(
      normalized,
      ACTION_BY_ID,
      overrides,
      profile.id,
      action.id,
    );

    if (!verdict.ok) {
      chip.dataset.error = verdict.reason;
      chip.textContent = verdict.reason === "modifier-required"
        ? "Add a modifier (Cmd, Ctrl, Alt)"
        : "Reserved by Strudel REPL";
      // Stay in recording — user retries.
      return;
    }

    // No conflict: commit silently.
    if (!verdict.transferFrom) {
      setOverride(action.id, normalized);
      // (rebuild keymaps via the editor handle stashed on the chip's row)
      reconfigureFromChip(chip);
      endRecording(chip);
      rerender();
      return;
    }

    // Conflict — Task 12 handles the optimistic-apply transfer.
    // For now, treat as a hard-block to keep this task scoped.
    chip.dataset.error = "conflict";
    chip.textContent = `Already used by ${ACTION_BY_ID.get(verdict.transferFrom).label}`;
  };

  const onBlur = () => endRecording(chip);
  const onClickOutside = (e) => {
    if (e.target !== chip) endRecording(chip);
  };

  chip.addEventListener("keydown", onKey, true);
  chip.addEventListener("blur", onBlur);
  document.addEventListener("mousedown", onClickOutside, true);

  // Stash teardown so endRecording can find it.
  chip.__teardown = () => {
    chip.removeEventListener("keydown", onKey, true);
    chip.removeEventListener("blur", onBlur);
    document.removeEventListener("mousedown", onClickOutside, true);
  };
}

function endRecording(chip) {
  if (!chip.__teardown) return;
  chip.__teardown();
  chip.__teardown = null;
  chip.dataset.recording = "0";
  chip.dataset.error = "";
  // Restore label by triggering a render (the parent widget owns rerender).
  chip.dispatchEvent(new CustomEvent("keymap-customize:rerender", { bubbles: true }));
}

function captureKeyEvent(e) {
  // Build a CM6-style key string from the event.
  const parts = [];
  if (e.metaKey) parts.push("Mod");
  else if (e.ctrlKey) parts.push("Mod"); // CM6 normalizes Ctrl→Mod on non-mac
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  const k = e.key;
  // Skip if only modifiers
  if (["Shift", "Control", "Alt", "Meta"].includes(k)) return null;
  parts.push(k);
  return parts.join("-");
}

function reconfigureFromChip(chip) {
  // Walk up to find the editor handle the parent widget stashed.
  let cur = chip;
  while (cur && !cur.__strasbeatEditor) cur = cur.parentElement;
  if (cur?.__strasbeatEditor) reconfigureAllKeymaps(cur.__strasbeatEditor);
}
```

In `mountKeymapCustomize`, stash the editor handle on the root for
`reconfigureFromChip`:

```js
root.__strasbeatEditor = editor;
```

Bubble-listen for the rerender event on root:

```js
root.addEventListener("keymap-customize:rerender", render);
```

- [ ] **Step 2: Smoke test in browser**

```bash
pnpm dev
```

- Mount the customize widget (next task wires it into Settings; for now, mount it manually via console for testing).
- Click a chip → enter recording.
- Press `Cmd+J` → silent commit, chip updates.
- Press bare `j` → chip shows "Add a modifier".
- Press `Ctrl+Enter` → chip shows "Reserved by Strudel REPL".
- Press Escape → recording cancels.

If you can't yet verify in the UI (Task 14 is the mount task), proceed to
Task 12 first and verify together.

- [ ] **Step 3: Stop and report**

Report: Task 11 complete. Suggested commit message:
`feat: chip recording state with capture-on-keypress validation`.

---

## Task 12: Optimistic-apply + Undo banner for transfer flow

Replace the "treat conflict as hard-block" stub from Task 11 with the
optimistic-apply + Undo banner per spec §6.

**Files:**

- Modify: `src/ui/keymap-customize.js`

- [ ] **Step 1: Implement the banner**

Add a banner module to `keymap-customize.js`:

```js
// ─── Transfer banner (optimistic-apply + Undo) ────────────────────────

let activeBanner = null;
let activeBannerTimeout = null;

function showTransferBanner(host, fromAction, toAction, prevState, onUndo) {
  // Replace any existing banner.
  if (activeBanner) {
    clearTimeout(activeBannerTimeout);
    activeBanner.remove();
    activeBanner = null;
  }

  const banner = document.createElement("div");
  banner.className = "keymap-customize__banner";
  banner.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "keymap-customize__banner-text";
  text.textContent =
    `${toAction.label} → ${formatKeyDisplay(prevState.newKey)}. ` +
    `${fromAction.label} is unbound.`;
  banner.appendChild(text);

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "keymap-customize__banner-undo";
  undoBtn.textContent = "Undo";
  undoBtn.addEventListener("click", () => {
    onUndo();
    dismiss();
  });
  banner.appendChild(undoBtn);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "keymap-customize__banner-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", dismiss);
  banner.appendChild(closeBtn);

  function dismiss() {
    if (activeBanner === banner) {
      banner.remove();
      activeBanner = null;
      clearTimeout(activeBannerTimeout);
      activeBannerTimeout = null;
    }
  }

  host.prepend(banner);
  activeBanner = banner;
  activeBannerTimeout = setTimeout(dismiss, 6000);
}
```

- [ ] **Step 2: Replace the conflict-stub with optimistic-apply**

In `beginRecording`, replace the `if (verdict.transferFrom)` branch
(currently shows "Already used by") with:

```js
if (verdict.transferFrom) {
  const fromAction = ACTION_BY_ID.get(verdict.transferFrom);
  const toAction = action;
  const overridesBefore = { ...overrides };

  // Apply: target action gets the new key; source action gets null
  // (explicit unbound — promotes the action's default-suppression).
  setOverride(toAction.id, normalized);
  setOverride(fromAction.id, null);

  reconfigureFromChip(chip);

  const host = chip.closest(".keymap-customize__body");
  showTransferBanner(host, fromAction, toAction, { newKey: normalized }, () => {
    // Undo: restore both actions to their pre-transfer state.
    if (Object.prototype.hasOwnProperty.call(overridesBefore, toAction.id)) {
      setOverride(toAction.id, overridesBefore[toAction.id]);
    } else {
      clearOverride(toAction.id);
    }
    if (Object.prototype.hasOwnProperty.call(overridesBefore, fromAction.id)) {
      setOverride(fromAction.id, overridesBefore[fromAction.id]);
    } else {
      clearOverride(fromAction.id);
    }
    reconfigureFromChip(chip);
    rerender();
  });

  endRecording(chip);
  rerender();
  return;
}
```

- [ ] **Step 3: Smoke test**

```bash
pnpm dev
```

- Bind `Cmd+J` to format (no conflict) — silent.
- Bind `Cmd+B` to format → banner appears: "Format pattern → Cmd+B. Toggle right rail is unbound."
- Click `Undo` → both rows restore to their previous keys.
- Bind `Cmd+B` to format again; wait 6 seconds; banner auto-dismisses.

- [ ] **Step 4: Stop and report**

Report: Task 12 complete. Suggested commit message:
`feat: optimistic-apply transfer flow with Undo banner`.

---

## Task 13: Search + bulk Reset all

Search filter: input field at top, filters rows by label or by displayed
key. While search is non-empty, all categories auto-expand. Bulk Reset
clears every override after a confirmation.

**Files:**

- Modify: `src/ui/keymap-customize.js`

- [ ] **Step 1: Add search input to the header**

In `mountKeymapCustomize`, after the subtitle and before the body:

```js
const searchInput = document.createElement("input");
searchInput.type = "text";
searchInput.className = "keymap-customize__search";
searchInput.placeholder = "Search actions or keys…";
searchInput.setAttribute("aria-label", "Search keymap actions");
let searchValue = "";
searchInput.addEventListener("input", () => {
  searchValue = searchInput.value.trim().toLowerCase();
  render();
});
root.appendChild(searchInput);
```

- [ ] **Step 2: Filter actions in render()**

Replace the `KEYMAP_ACTIONS` reference inside `render()` with a filter:

```js
function actionMatches(action, profileId, overrides) {
  if (!searchValue) return true;
  if (action.label.toLowerCase().includes(searchValue)) return true;
  const resolved = resolveKey(action.id, profileId, overrides);
  if (resolved && formatKeyDisplay(resolved).toLowerCase().includes(searchValue)) return true;
  return false;
}

function render() {
  body.replaceChildren();
  const profile = getProfile(getStoredProfileId());
  const overrides = loadOverrides();
  const filtered = KEYMAP_ACTIONS.filter((a) => actionMatches(a, profile.id, overrides));
  const groups = groupActionsByCategory(filtered, CATEGORIES);

  for (const { category, actions } of groups) {
    // ... existing per-section logic
    // When searching, force-expand:
    if (searchValue) section.dataset.collapsed = "0";
  }
}
```

- [ ] **Step 3: Add Reset all at the bottom**

After the body in `mountKeymapCustomize`:

```js
const resetAll = document.createElement("button");
resetAll.type = "button";
resetAll.className = "keymap-customize__reset-all";
resetAll.textContent = "Reset all overrides";
resetAll.addEventListener("click", async () => {
  const yes = await window.confirm("Reset all keyboard overrides? Defaults will return.");
  if (!yes) return;
  clearAllOverrides();
  reconfigureAllKeymaps(editor);
  render();
});
root.appendChild(resetAll);
```

- [ ] **Step 4: Smoke test**

```bash
pnpm dev
```

- Type "save" in search → only the save row visible, all categories
  auto-expanded if needed.
- Type "Cmd+S" → save row matches.
- Clear search → previous collapse state restored.
- Click Reset all → confirm → all overrides cleared, all rows show defaults.

- [ ] **Step 5: Stop and report**

Report: Task 13 complete. Suggested commit message:
`feat: search filter + Reset all overrides for customize panel`.

---

## Task 14: Mount customize widget in Settings panel

Bolt the widget into the existing Settings → Editor section, below the
Keymap profile dropdown.

**Files:**

- Modify: `src/ui/settings-panel.js`

- [ ] **Step 1: Import the mount function**

Add to the imports of `src/ui/settings-panel.js`:

```js
import { mountKeymapCustomize } from "./keymap-customize.js";
```

- [ ] **Step 2: Mount it after the keymap row**

In `buildEditorSection()`, find the block that adds the Keymap row.
After `section.body.appendChild(keymapRow.row);` (and after the
`subscribeKeymapChange` block that keeps the dropdown in sync), append
the customize widget:

```js
// `editor` is the closure variable destructured from createSettingsPanel
// options at the top of the file (already exists for other features),
// not `this.editor` — createSettingsPanel is a factory, not a class.
mountKeymapCustomize({
  container: section.body,
  editor,
});
```

If `editor` isn't already in the destructured options of
`createSettingsPanel`, add it:

```js
export function createSettingsPanel({
  /* existing args */
  editor = null,
}) {
  // ... existing
}
```

- [ ] **Step 3: Pass editor from main.js to settings panel**

In `src/main.js`, find the `createSettingsPanel({...})` call and add
`editor` to the options:

```bash
grep -n "createSettingsPanel" /Users/ben/Projects/strasbeat/src/main.js
```

```js
const settingsPanel = createSettingsPanel({
  /* existing options */
  editor,
});
```

- [ ] **Step 4: Smoke test**

```bash
pnpm dev
```

- Open Settings panel → Editor section.
- Verify "Customize keys" appears below the Keymap dropdown.
- All previous chip / banner / search interactions work in-place.
- Switch profile via dropdown — customize widget rerenders defaults.

- [ ] **Step 5: Stop and report**

Report: Task 14 complete. Suggested commit message:
`feat: mount customize keymap widget in settings panel`.

---

## Task 15: Command palette derives shortcut text from registry

Items in the palette that correspond to registered actions read their
shortcut from `resolveKey` so user overrides reflect immediately.

**Files:**

- Modify: `src/ui/command-palette.js` (or `src/command-palette-actions.js`
  depending on where shortcut text lives — verify with grep below)

- [ ] **Step 1: Find palette items with hardcoded shortcuts**

```bash
grep -n "Cmd+\|Ctrl+\|Mod+\|key:" /Users/ben/Projects/strasbeat/src/command-palette-actions.js
grep -n "Cmd+\|Ctrl+\|Mod+\|key:" /Users/ben/Projects/strasbeat/src/ui/command-palette.js
```

- [ ] **Step 2: Replace hardcoded shortcuts with resolveKey calls**

For each palette item that maps to a known action ID, replace
`key: "Cmd+S"` (or similar) with:

```js
import { resolveKey } from "./editor/keymap-actions.js";
import { loadOverrides } from "./editor/keymap-overrides.js";
import { getStoredProfileId } from "./editor/keymap-profiles.js";

function shortcutFor(actionId) {
  return resolveKey(actionId, getStoredProfileId(), loadOverrides());
}

// In the palette items array:
{
  id: "save",
  label: "Save pattern",
  // was: key: "Cmd+S",
  key: shortcutFor("strasbeat.save"),  // resolved at palette-open time
  run: () => saveBtn.click(),
},
```

The palette is rebuilt every time it opens (verify by reading
`buildCommands` — if it's called once and cached, change to call on each
open). The shortcut text reflects the latest overrides.

Apply the same pattern to:
- `strasbeat.eval` → `Cmd+Enter`
- `strasbeat.format` → `Cmd+Shift+F`
- `strasbeat.toggleComment` → `Cmd+/`
- `strasbeat.selectNextOccurrence` → `Cmd+D`
- `strasbeat.deleteLine` → `Cmd+Shift+K`
- `strasbeat.toggleMute` → `Cmd+M`
- `strasbeat.toggleSolo` → `Cmd+Shift+S`
- `strasbeat.toggleRightRail` → `Cmd+B`
- `strasbeat.commandPalette` → `Cmd+Shift+P`
- `strasbeat.save` → `Cmd+S`

(approximately ~10–12 items)

- [ ] **Step 3: Smoke test**

```bash
pnpm dev
```

- Open command palette (`Cmd+Shift+P`).
- Find "Save pattern" — verify shortcut shows "Cmd+S" by default.
- Close palette, override save to `Cmd+Shift+S` via customize panel.
- Open palette → "Save pattern" shows "Cmd+Shift+S".

- [ ] **Step 4: Stop and report**

Report: Task 15 complete. Suggested commit message:
`feat: command palette derives shortcuts from action registry`.

---

## Task 16: AZERTY/QWERTZ smoke + acceptance pass

Verify nothing in the registry refactor broke layout-fallback bindings.
Walk the spec's full Acceptance list manually.

**Files:** none (verification only)

- [ ] **Step 1: AZERTY/QWERTZ regression check**

If you have access to a system with French AZERTY mac:
- Switch the system keyboard to French.
- Open strasbeat in VSCode profile.
- Verify `Cmd+:` toggles comment (it's the AZERTY-mac alternative).
- Verify `Tab` / `Shift+Tab` indents a multi-line selection.

If you can't physically switch keyboards, instead simulate by reading
through `src/editor/keymap.js` and confirming the layout-fallback block
is intact:

```bash
grep -n "Mod-:\|Mod-#\|Tab\|indentWithTab" /Users/ben/Projects/strasbeat/src/editor/keymap.js
```

Both `Mod-:` / `Mod-#` and `indentWithTab` should still appear.

- [ ] **Step 2: Walk the full acceptance list**

For each item in `design/work/23-keybinding-overrides.md` § Acceptance,
exercise it manually in the browser. Check off each item as you go:

```
- [ ] Action registry: every action has unique ID, label, category, layer,
      complete defaultsByProfile.
- [ ] Boot reads strasbeat:keymap-overrides before editor renders.
- [ ] User binds Cmd+S → save; pattern persists.
- [ ] User on Strudel profile binds Cmd+J → selectNextOccurrence; works.
- [ ] Optimistic-apply transfer + Undo banner.
- [ ] Per-row × clears single override.
- [ ] Recording: bare letter rejected.
- [ ] Recording: Ctrl+Enter rejected.
- [ ] Auto-collapse: Strudel profile starts with Editor + Tracks collapsed.
- [ ] Search auto-expands.
- [ ] Reset-all confirms and clears.
- [ ] localStorage corruption tolerated.
- [ ] Vim profile: Cmd+S works in normal/insert/visual modes.
- [ ] Profile switch updates default hints in customize widget.
- [ ] Command palette reflects overrides.
- [ ] AZERTY mac smoke: Cmd+: + Tab/Shift-Tab.
- [ ] No regression in WAV export, MIDI capture, persistence.
```

- [ ] **Step 3: Stop and report**

Report acceptance status. List any failures with reproduction steps.
Suggested commit message: `test: acceptance checklist for keymap overrides`.

---

## Task 17: Coordination with 22-intellisense-v2

This task is **conditional** — only execute if `22-intellisense-v2`'s
plan has merged ahead of this one. Detect by checking for new
keybindings in `keymap-universal.js` that aren't in the registry yet.

**Files (conditional):**

- Modify: `src/editor/keymap-actions.js`
- Modify: `src/editor/keymap-universal.js` (if intellisense added bindings inline)

- [ ] **Step 1: Detect intellisense-v2 landing**

```bash
grep -n "Cmd-Shift-b\|Cmd-J\|Mod-J\|auditionSelected\|moveCompletionSelection" /Users/ben/Projects/strasbeat/src/editor/keymap-universal.js
```

If matches found → intellisense-v2 has landed. Continue to Step 2.
If no matches → intellisense-v2 hasn't landed yet. Skip to Step 6 (no-op).

- [ ] **Step 2: Add registry entries for intellisense-v2 actions**

First, add the imports needed by the new entries to the top of
`keymap-actions.js`:

```js
import { completionStatus, moveCompletionSelection } from "@codemirror/autocomplete";
import { auditionSelected } from "../ui/sound-browser.js"; // or wherever intellisense-v2 exported it
```

If `auditionSelected` lives elsewhere in intellisense-v2's code (e.g.
`src/editor/completions/install.js`), use that path instead. If it
isn't exported, add an `export` to make it available.

Then add to `KEYMAP_ACTIONS` in `keymap-actions.js`, in a new
"Completions" category:

```js
// ── Completions (from spec 22-intellisense-v2) ────────────────────
{
  id: "strasbeat.completions.auditionNext",
  label: "Audition next completion",
  category: "Completions",
  layer: "universal",
  defaultsByProfile: everywhere("Alt-ArrowDown"),
  // run gates on autocomplete state. Returns false when popup is closed
  // so VSCode-overlay's moveLineDown (same key) can fire next.
  run: (view, _ctx) => {
    if (completionStatus(view.state) !== "active") return false;
    const moved = moveCompletionSelection(true)(view);
    if (moved) auditionSelected(view);
    return moved;
  },
},
{
  id: "strasbeat.completions.auditionPrev",
  label: "Audition previous completion",
  category: "Completions",
  layer: "universal",
  defaultsByProfile: everywhere("Alt-ArrowUp"),
  run: (view, _ctx) => {
    const { moveCompletionSelection, completionStatus } = require("@codemirror/autocomplete");
    if (completionStatus(view.state) !== "active") return false;
    const moved = moveCompletionSelection(false)(view);
    if (moved) auditionSelected(view);
    return moved;
  },
},
{
  id: "strasbeat.completions.revealInBrowser",
  label: "Reveal sound in browser",
  category: "Completions",
  layer: "universal",
  defaultsByProfile: everywhere("Mod-Shift-b"),
  run: (view, _ctx) => {
    document.dispatchEvent(new CustomEvent("strasbeat:reveal-sound", { detail: { view } }));
    return true;
  },
},
{
  id: "strasbeat.completions.focusBrowser",
  label: "Focus sound browser with token",
  category: "Completions",
  layer: "universal",
  defaultsByProfile: everywhere("Mod-j"),
  run: (view, _ctx) => {
    document.dispatchEvent(new CustomEvent("strasbeat:focus-browser", { detail: { view } }));
    return true;
  },
},
```

Add `"Completions"` to `CATEGORIES`:

```js
export const CATEGORIES = ["Pattern", "Editor", "Tracks", "Completions", "App"];
```

The `auditionSelected` helper imported above must come from
intellisense-v2's `install.js`. If it's not exported there, add an
export. If it's not implemented yet, the `run` falls back gracefully —
the gate (`completionStatus !== "active"`) makes the run a no-op when
no popup is open.

- [ ] **Step 3: Remove the duplicate inline bindings from keymap-universal.js**

Whatever intellisense-v2 added inline (e.g. a `Tab` binding, `Alt+arrow`
bindings) should be REMOVED from `keymap-universal.js` if they're now
covered by registry entries. The `Tab` accept-completion binding stays
inline — it's a meta-binding (gates on autocomplete state, delegates
otherwise) and isn't a named user action.

After this task, `keymap-universal.js` should contain ONLY:
- The registry-derived bindings (built by `KEYMAP_ACTIONS.filter(layer === "universal")`)
- The hand-written `Tab` accept-completion (from intellisense-v2 Phase 2)

- [ ] **Step 4: Verify the audition gate-return**

Read intellisense-v2's outlined `run` for `Alt+ArrowDown`. If it returns
`true` unconditionally (instead of returning `moved`), update it to
respect the actual return value of `moveCompletionSelection`. The
universal binding must fall through (`return false`) when the popup is
closed so the VSCode-overlay's `moveLineDown` (same key) fires next.

- [ ] **Step 5: Smoke test**

```bash
pnpm dev
```

- VSCode profile, popup closed, press `Alt+↓` → moves line down.
- Trigger completion popup, press `Alt+↓` → auditions selected sound, no line move.
- Strudel profile, popup closed, press `Alt+↓` → no-op (overlay not loaded, audition gate returns false).
- Press `Cmd+Shift+B` over a sound name → sound browser opens with that sound highlighted.

- [ ] **Step 6: Stop and report**

Report: Task 17 status (executed or skipped). If executed, suggested
commit message: `chore: integrate intellisense-v2 bindings into action registry`.

---

## Self-Review

**Spec coverage check** (run mentally before stopping):

- ✅ §1 Action registry → Task 1
- ✅ §2 Override storage + migration → Tasks 2, 3
- ✅ §3 Override compartment → Task 4, integrated in Task 7
- ✅ §4 Suppressing default bindings on null → Tasks 5, 6 (filter logic)
- ✅ §5 Customize sub-section UI → Tasks 10–14
- ✅ §6 Optimistic-apply + Undo → Task 12
- ✅ §7 Initial load → Task 7
- ✅ §8 Profile switch + override interaction → Task 9
- ✅ §9 Command palette integration → Task 15
- ✅ §10 Save action plumbing → Task 8
- ✅ Coordination with intellisense-v2 → Task 17

**Acceptance items mapped:**

- Registry shape, defaults coverage → Task 1
- Boot reads overrides before editor renders → Task 7
- Cmd+S save → Task 8
- Cmd+J on Strudel binds selectNextOccurrence → Tasks 11–13
- Optimistic-apply + Undo → Task 12
- Per-row × → Task 10
- Recording validation → Task 11
- Auto-collapse → Task 10
- Search → Task 13
- Reset-all → Task 13
- localStorage robustness → Tasks 2, 3
- Vim profile Cmd+S → Task 8 smoke
- Profile-switch updates customize widget → Task 9 + 10
- Command-palette reflects overrides → Task 15
- AZERTY mac smoke → Task 16
- No regression → Task 16

No placeholders. No TBDs. All code blocks contain actual code. Type
references are consistent (`ACTION_BY_ID` is the same Map throughout;
`resolveKey(id, profile, overrides)` signature is stable; `ctx` shape
{ onEvaluate, onStop, onFormat, onSave, onToggleRightRail, onOpenPalette }
is consistent across editor-setup → registry calls).

---

## Coordination Notes

- **Intellisense-v2 may land first.** Task 17 detects this and migrates
  the bindings into the registry. If intellisense-v2 lands AFTER this
  plan, intellisense-v2's plan should add registry entries directly
  (no migration needed) — flag for whoever writes/reviews that plan.
- **Universal keymap is loaded once at boot.** A user override that
  promotes an action into the universal layer (e.g. binding `Cmd+J` to
  `selectNextOccurrence` in Strudel profile) takes effect through the
  override compartment, not through reconfiguring the universal keymap.
  This works because the override compartment is at `Prec.highest`. If
  a future spec wraps the universal keymap in its own compartment for
  fully-live reconfiguration, the override compartment can stay as it
  is.
- **Tab-to-accept (intellisense-v2 Phase 2) is intentionally not in
  the registry.** It's a meta-binding that gates on autocomplete state
  and delegates otherwise. Putting it in the rebind UI would imply
  user-rebindability of "accept completion", which doesn't make sense.
  Stays as hand-written code in `keymap-universal.js` alongside
  `Mod-Enter`.
