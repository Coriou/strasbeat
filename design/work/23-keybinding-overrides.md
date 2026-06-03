# 23 — Per-binding overrides (rebindable strasbeat actions)

> Status: design — 2026-05-01. Read `21-keybindings.md` first — that spec
> ships the 5-profile picker and the layered keymap model this spec
> extends. Read `22-intellisense-v2.md` next — it lands new universal
> keybindings (`Tab`-accept, `Alt+↑/↓` audition, `Cmd+Shift+B` reveal,
> `Cmd+J` focus-browser) that this spec's action registry will house. See
> *Coordination with 22-intellisense-v2* near the end of this spec for the
> integration plan. This spec adds **one** new always-on CodeMirror
> compartment, an action registry, and a Settings sub-section that lets
> users rebind any strasbeat-owned action without leaving their chosen
> profile.

## Goal

Let users customize keyboard shortcuts for the actions strasbeat owns
end-to-end, without breaking the strudel.cc-parity guarantee the Strudel
profile makes for new users.

Specifically:

1. **Every strasbeat action has a stable ID, a human-readable label, and
   a default per profile.** All ~22 actions go into one registry — the
   Settings UI iterates over it, the universal/overlay keymaps derive
   their `keymap.of([...])` from it, and the rebind logic resolves keys
   against it.
2. **Overrides are global.** A user binding `Cmd+J` to "select next
   occurrence" gets that binding in every profile (Strudel / VSCode /
   Vim / Emacs / Helix), because the override compartment is always
   loaded. Profile defaults differ; user choices follow the user.
3. **The customization UI lives below the existing Keymap dropdown** in
   the Settings panel — same locality as the profile picker, hidden one
   click deeper than the front-door affordance. Strudel-coming users
   never have to encounter it; power users find it without leaving
   Settings.
4. **`Cmd+S` ships as a real save action**, replacing the toolbar-only
   save flow with a registered action whose default is `Mod-S` and
   whose run wraps the existing save button. (Folds in the follow-up
   flagged in `21-keybindings.md`.)

Visual treatment of the customize sub-section, recording-state chip, and
transfer banner is delegated to `impeccable` at implementation time —
this spec describes interaction and structure. Explicit non-goals are
listed under *Out of scope*.

## Why

`21-keybindings.md` deliberately punted per-binding remap to a follow-up
spec, citing it as "the eventual end-product the user has noted —
strong candidate for a follow-up spec." This is that spec.

The user-facing motivation: the 5-profile dropdown covers ≥95% of the
"my muscle memory matters" value, but it can't help with the long tail.
Three concrete cases the dropdown alone misses:

- **Strudel-default user wants `Cmd+S` for save.** They love Strudel's
  defaults and don't want to switch to VSCode just to gain one shortcut.
- **Vim user wants `Cmd+D` for select-next-occurrence.** They want the
  modal grammar from Vim plus one VSCode-overlay action layered on top —
  no profile delivers this hybrid.
- **VSCode user wants `Cmd+;` instead of `Cmd+/` for comment toggle**
  (or any personal idiosyncrasy a profile preset can't anticipate).

The architectural motivation: the existing layer cake leaves a clean
surface to add a Layer 2.5 compartment between Layer 2 (always-on
universal keymap) and Layer 3 (profile editing keymap). Overrides loaded
at higher precedence than both layers naturally implement the global
"my choice wins" semantics — without refactoring anything that just
shipped.

The cost is small: one new file (the override compartment + storage), a
second new file (the registry), thin shims over the existing
`createUniversalKeymap` and `createVscodeKeymap` to derive their bindings
from the registry, and a Settings sub-section. ~22 actions, ~12 acceptance
criteria. The customize UI is GUI-only for v1 — JSON view / import-export
deferred until anyone asks.

## Mental model: the layer cake gets one new layer

```
┌─────────────────────────────────────────────────┐
│ Layer 2.5 — User overrides (NEW)                │  always loaded, Prec.highest
│   resolved from { actionId → key } map          │  user choices win
├─────────────────────────────────────────────────┤
│ Layer 3 — Profile editing keymap                │  user-selected, swaps live
│   Strudel (none)                                │  derived from registry
│   VSCode (overlay actions, layout fallbacks)    │  filtered by profile
│   Vim/Emacs/Helix (Strudel's compartment)       │
├─────────────────────────────────────────────────┤
│ Layer 2 — Always-on app shortcuts               │  derived from registry
│   Mod-Enter (eval, mac parity)                  │  filtered by profile
│   Mod-B / Mod-Shift-P (page-level, in main.js)  │
├─────────────────────────────────────────────────┤
│ Layer 1 — Strudel upstream                      │  Prec.highest, untouchable
│   Ctrl+Enter / Alt+Enter / Ctrl+. / Alt+.       │
└─────────────────────────────────────────────────┘
```

Layer 1 and Layer 3 are unchanged from `21-keybindings.md`. Layer 2's
contents now flow through the registry instead of being inline arrays in
`keymap-universal.js` and `keymap.js`. **Layer 2.5 is new.** It always
loads at `Prec.highest` (above the strasbeat overlay; *below* upstream
Strudel's `Prec.highest` because CM6 last-wins for same-key-same-precedence,
and the new compartment is appended after upstream). The override
compartment's contents are reconfigured whenever the user rebinds; profile
switching does NOT touch it.

The net effect: a user override **promotes** an action to always-on. A
Strudel-profile user who binds `Cmd+J` → `selectNextOccurrence` gets that
single VSCode-overlay action active in Strudel profile too. Strict parity
remains the *default*, opt-out-able action by action.

## Approach

### 1. Action registry

Single source of truth for "what actions exist, what they do, and what
their defaults are per profile." Pure module — no DOM, no CodeMirror
state imports — testable with `node --test`, mirrors the
`keymap-profiles.js` pattern.

```js
// src/editor/keymap-actions.js
export const KEYMAP_ACTIONS = [
  // ── Pattern ───────────────────────────────────────────────────────
  {
    id: "strasbeat.eval",
    label: "Evaluate pattern",
    category: "Pattern",
    layer: "universal",            // → loaded by createUniversalKeymap
    defaultsByProfile: {
      strudel: "Mod-Enter", vscode: "Mod-Enter", vim: "Mod-Enter",
      emacs:   "Mod-Enter", helix:  "Mod-Enter",
    },
    run: (_view, ctx) => { ctx.onEvaluate(); return true; },
  },
  {
    id: "strasbeat.stop",
    label: "Stop",
    category: "Pattern",
    layer: "universal",
    // All-null defaults: upstream Strudel binds Ctrl+. / Alt+. at Prec.highest.
    // Strasbeat's stop action exists in the registry only so users can ADD
    // their own additional binding (e.g. Cmd+. on mac for symmetry with eval).
    defaultsByProfile: {
      strudel: null, vscode: null, vim: null, emacs: null, helix: null,
    },
    run: (_view, ctx) => { ctx.onStop(); return true; },
  },
  {
    id: "strasbeat.format",
    label: "Format pattern",
    category: "Pattern",
    layer: "universal",
    defaultsByProfile: {
      strudel: "Mod-Shift-f", vscode: "Mod-Shift-f", vim: "Mod-Shift-f",
      emacs:   "Mod-Shift-f", helix:  "Mod-Shift-f",
    },
    run: (view, ctx) => { ctx.onFormat(view); return true; },
  },
  {
    id: "strasbeat.save",
    label: "Save pattern",
    category: "Pattern",
    layer: "universal",
    defaultsByProfile: {
      strudel: "Mod-s", vscode: "Mod-s", vim: "Mod-s",
      emacs:   "Mod-s", helix:  "Mod-s",
    },
    run: (_view, ctx) => { ctx.onSave(); return true; },
  },

  // ── Editor (VSCode overlay actions) ───────────────────────────────
  {
    id: "strasbeat.selectNextOccurrence",
    label: "Select next occurrence",
    category: "Editor",
    layer: "overlay",              // → loaded by createVscodeKeymap
    defaultsByProfile: {
      strudel: null, vscode: "Mod-d", vim: null, emacs: null, helix: null,
    },
    run: (view) => selectNextOccurrence(view),
  },
  // … selectAllMatches, deleteLine, selectLine, moveLineUp, moveLineDown,
  //   toggleComment, indentMore, indentLess

  // ── Tracks ────────────────────────────────────────────────────────
  {
    id: "strasbeat.toggleMute",
    label: "Toggle mute",
    category: "Tracks",
    layer: "overlay",
    defaultsByProfile: {
      strudel: null, vscode: "Mod-m", vim: null, emacs: null, helix: null,
    },
    run: (view, ctx) => toggleLabelAtCursor(view, ctx.onEvaluate, toggleMute, "input.track-mute"),
  },
  // … toggleSolo

  // ── App ───────────────────────────────────────────────────────────
  // toggleRightRail, commandPalette stay as page-level listeners in main.js
  // for now (not CM-bound). The registry includes them so the rebind UI can
  // surface them — their `run` calls the existing handlers via window-level
  // hooks. (Alternative: lift them into a CM keymap. See "Open questions".)
];

export const ACTION_BY_ID = new Map(KEYMAP_ACTIONS.map((a) => [a.id, a]));

/** Resolve the effective key for an action given the active profile and
 *  the current overrides map. Returns the override if defined-and-not-null,
 *  else the profile default, else null (unbound). */
export function resolveKey(actionId, profileId, overrides) {
  if (Object.prototype.hasOwnProperty.call(overrides, actionId)) {
    return overrides[actionId]; // string OR null (explicit unbound)
  }
  const action = ACTION_BY_ID.get(actionId);
  return action?.defaultsByProfile?.[profileId] ?? null;
}
```

The layout-fallback bindings from `21-keybindings.md` §11 (`Mod-:`,
`Mod-#`, `Tab`, `Shift-Tab`) stay hardcoded in `keymap.js` — those are
AZERTY/QWERTZ reachability for actions whose primary binding is fragile,
not separate user-facing actions, so they don't belong in the registry.

### 2. Override storage

`localStorage["strasbeat:keymap-overrides"]`:

```json
{
  "version": 1,
  "overrides": {
    "strasbeat.save":            "Mod-s",
    "strasbeat.toggleRightRail": null
  }
}
```

Three states per action:

- **Key absent** → no override; use default.
- **`null`** → explicit unbound; emerges from optimistic-transfer flows
  where another action steals the key.
- **String** → custom binding in CM6's `Mod-…` syntax.

Helpers in a new `src/editor/keymap-overrides.js`:

```js
export function loadOverrides() { /* read, parse, validate, migrate */ }
export function saveOverrides(map) { /* write JSON */ }
export function setOverride(actionId, key) { /* mutate + save + reconfigure compartment */ }
export function clearOverride(actionId) { /* delete entry, save, reconfigure */ }
export function clearAllOverrides() { /* wipe map, save, reconfigure */ }

/** Validation hierarchy for a captured key. */
export function validateBinding(key, registry, overrides, currentProfile) {
  // 1. Modifier required
  if (!hasModifier(key) && !isModifierStableBareKey(key)) {
    return { ok: false, reason: "modifier-required" };
  }
  // 2. Upstream Strudel reservation
  if (UPSTREAM_RESERVED.has(key)) {
    return { ok: false, reason: "upstream-reserved" };
  }
  // 3. Internal conflict (warning, not block — caller handles transfer)
  const conflictId = findActionUsingKey(key, registry, overrides, currentProfile);
  if (conflictId) return { ok: true, transferFrom: conflictId };
  return { ok: true };
}

const UPSTREAM_RESERVED = new Set([
  "Ctrl-Enter", "Alt-Enter", "Ctrl-.", "Alt-.", "Alt-w", "Alt-q",
]);
```

Migration is a small `migrate(stored)` that handles `version: N → N+1`.
v1 → v1 is a no-op. If stored `version > 1` (downgrade), keep JSON intact
but skip applying with `console.warn` once.

### 3. Override compartment

`src/editor-setup.js` gains one CM6 `Compartment`:

```js
import { Compartment } from "@codemirror/state";
const userOverridesCompartment = new Compartment();

export function dispatchEditorExtensions(editor, { onOpenReference, onSave }) {
  const profile = getProfile(getStoredProfileId());
  const overrides = loadOverrides();
  const onEvaluate = () => editor.evaluate();
  const onStop     = () => editor.stop();
  const onFormat   = (view) => formatBuffer(view); // existing helper

  editor.editor.dispatch({
    effects: StateEffect.appendConfig.of([
      errorMarksExtension,
      Prec.highest(formatExtension),
      Prec.highest(createUniversalKeymap({ profile, ctx: { onEvaluate, onStop, onFormat, onSave } })),
      strasbeatOverlayCompartment.of(
        profile.applyStrasbeatOverlay
          ? Prec.highest(createVscodeKeymap({ profile, ctx: { onEvaluate } }))
          : [],
      ),
      Prec.highest(userOverridesCompartment.of(
        buildOverrideKeymap({ overrides, ctx: { onEvaluate, onStop, onFormat, onSave } })
      )),
      numericScrubber({ /* ... */ }),
      hoverDocs({ onOpenReference }),
      signatureHint,
    ]),
  });
}

export function reconfigureOverrides(editor, overrides, ctx) {
  editor.editor.dispatch({
    effects: userOverridesCompartment.reconfigure(
      Prec.highest(buildOverrideKeymap({ overrides, ctx })),
    ),
  });
}
```

`buildOverrideKeymap({ overrides, ctx })` iterates the registry, resolves
each action's key against the overrides (no profile parameter — overrides
are global), and emits one `keymap.of([...])` entry per overridden action.
Actions whose override is `null` emit nothing (they're explicitly
unbound, which means their default-source-layer's binding is also
suppressed by the same mechanism: see §4).

### 4. Suppressing default bindings on `null` overrides

When a user transfers `Cmd+B` away from `toggleRightRail` (override = `null`)
and gives it to `format`, both of these must be true:

1. `format` is now bound to `Cmd+B` (via the override compartment).
2. `toggleRightRail` is NOT bound to `Cmd+B` (its default in the universal
   keymap must be suppressed).

The cleanest implementation is to make `createUniversalKeymap` and
`createVscodeKeymap` filter out actions whose `overrides[id] === null`:

```js
export function createUniversalKeymap({ profile, ctx, overrides = {} }) {
  return keymap.of(
    KEYMAP_ACTIONS
      .filter((a) => a.layer === "universal")
      .filter((a) => a.defaultsByProfile[profile.id])  // has a default in this profile
      .filter((a) => overrides[a.id] !== null)          // not explicitly unbound
      .filter((a) => !overrides[a.id])                  // not overridden to a non-null key (override compartment owns those)
      .map((a) => ({ key: a.defaultsByProfile[profile.id], run: (v) => a.run(v, ctx) })),
  );
}
```

Same shape for `createVscodeKeymap`. The override compartment then owns
exactly the "non-null overridden" set; the default-layer compartments
own the rest.

When overrides change at runtime, both the default-layer compartments
AND the override compartment need to reconfigure (because removing an
override may need to restore the default; adding a non-null override
may need to remove the default to avoid double-binding). `keymap-apply.js`
gains a small `reconfigureAll(editor, profile, overrides, ctx)` that
dispatches both reconfigure effects in one transaction.

### 5. Customize sub-section UI

Lives in the Settings panel, below the Keymap dropdown, inside a new
`buildCustomizeKeymap()` block in `settings-panel.js` that mounts a
widget defined in `src/ui/keymap-customize.js`.

**Layout:**

```
Editor

  Keymap            [ Strudel (default)  ▾ ]    ← existing dropdown

  Customize keys   [ search… ]                  ← new
    Showing all strasbeat actions. Defaults vary by profile.

    Pattern                              ▾   4 actions
      Evaluate pattern        [Cmd+Enter]
      Stop                    [Ctrl+.]
      Format pattern          [Cmd+Shift+F]
      Save pattern            [Cmd+S]

    Editor                               ▸   10 actions, none bound
    Tracks                               ▸   2 actions, none bound

    App                                  ▾   4 actions
      Toggle right rail       [Cmd+B]
      Command palette         [Cmd+Shift+P]
      ...

  [ Reset all overrides ]
```

**Auto-collapse rule.** Categories whose actions are entirely unbound
in the active profile (default OR override) start collapsed. The
collapsed header reads `<category> ▸  <N> actions, none bound` so the
absence is informative, not mysterious. Categories with at least one
binding start expanded.

Search auto-expands all categories on focus; clearing search restores
collapse state.

**Row anatomy.** Label (left), key chip (right), `×` button.

- Chip shows resolved key. Override matches default → neutral chip,
  no `×`. Override differs from default → subtle accent dot on the
  chip, `×` visible, hover/focus shows `(default: <key>)`.
- Override === `null` (explicit unbound) → chip reads `Unbound`, `×`
  visible (clicking restores default behavior).
- No default and no override → chip reads `Unbound`, no `×`.

**Recording state.** Click chip → enters recording.

- Chip text: `Press a key…` and below: `current: Cmd+Shift+F`.
- Esc / blur / click-outside / Tab → exit without saving.
- Capture `keydown`, normalize to CM6 `Mod-…` syntax (Cmd-on-mac/Ctrl-on-others
  → `Mod-`).
- On capture, run `validateBinding`:
  - **Bare key (modifier-required failure)** → red shake, inline error
    `Add a modifier (Cmd, Ctrl, Alt).` Recording stays open.
  - **Upstream Strudel reservation** → red shake, inline error
    `Reserved by Strudel REPL.` Recording stays open.
  - **No conflict** → silent commit. Save override, reconfigure, exit
    recording, focus next chip.
  - **Internal conflict** → optimistic-apply (see §6).

**Reset.** Per-row `×` clears single override. Bottom button **Reset all
overrides** confirms (`Reset all keyboard overrides? Defaults will return.`)
and wipes the entire `overrides` map.

### 6. Optimistic-apply + Undo banner

When a user binds `Cmd+B` to `format` while `toggleRightRail` already
holds `Cmd+B`:

1. Write `overrides.format = "Mod-b"` AND `overrides.toggleRightRail = null`.
2. Reconfigure both default-layer compartments and the overrides compartment.
3. Mount a banner above the customize sub-section:

   ```
   ┌──────────────────────────────────────────────────────────┐
   │  Format pattern → Cmd+B.                                 │
   │  Toggle right rail is unbound.        [Undo]   ×         │
   └──────────────────────────────────────────────────────────┘
   ```

4. Briefly highlight the two affected rows (~600 ms tint).
5. After ~6 s, banner auto-dismisses. If a *new* transfer happens before
   the timer expires, the old banner is replaced (no queue).

`Undo` restores both `overrides.format` and `overrides.toggleRightRail`
to their pre-transfer state (`format` reverts to default `Mod-Shift-f`,
`toggleRightRail` reverts to default `Mod-b`).

The banner is **local** (within the Settings panel sub-section), not a
global toast — the user's attention is already on the keymap UI; pulling
focus into a corner of the screen would be jarring.

### 7. Initial load (no flash)

Mirroring `21-keybindings.md` §"Initial load":

```js
// editor-setup.js#applyInitialSettings
const profile = getProfile(getStoredProfileId());
const overrides = loadOverrides();   // ← read both before editor renders
editor.updateSettings({ /* ... */ });

// dispatchEditorExtensions then receives both `profile` and `overrides`.
```

The override compartment is initialized with the resolved set on its
first dispatch. No first-paint flash. `Cmd+S` works on the first
keystroke after page load.

### 8. Profile switch + override interaction

When the user picks a new profile via chip or dropdown:

1. `applyKeymapProfile()` reconfigures Strudel's `keybindings`
   compartment and the strasbeat overlay compartment (existing flow
   from `21-keybindings.md`).
2. The default-layer compartments (`createUniversalKeymap`,
   `createVscodeKeymap`) re-derive their bindings from the registry
   filtered by the new profile.
3. The **override compartment is NOT reconfigured** — overrides are
   global and follow the user across profiles.
4. The customize sub-section's "default" hints DO update to reflect
   the new profile's defaults (a row currently showing
   `(default: Cmd+D)` may switch to `(default: unbound)` when the
   user moves to Strudel profile).

The customize widget subscribes to `subscribeKeymapChange` — same
channel the chip and dropdown already use — and re-renders rows on
profile change.

### 9. Command palette integration

`src/ui/command-palette.js`'s `buildCommands` currently hardcodes a
`key` string per item. Items whose `run` corresponds to a registered
action read their displayed shortcut from `resolveKey(id, profileId,
overrides)`:

```js
{
  id: "format",
  label: "Format pattern",
  key: resolveKey("strasbeat.format", profileId, overrides), // ← was hardcoded
  run: (view) => formatBuffer(view),
}
```

The palette opens fresh each time (no persistent listener), so the
"latest values" question doesn't arise — the next palette open reflects
the latest overrides. ~12 items affected.

### 10. Save action plumbing

`Cmd+S` save needs an `onSave` callback wired through:

- `src/main.js` constructs `onSave = () => saveBtn.click()` and passes
  it into `dispatchEditorExtensions`.
- `dispatchEditorExtensions` threads it into the registry's `ctx` so
  the save action's `run` can call it.
- The toolbar save button is unchanged — it's the canonical "I clicked
  save" entry point; the keyboard shortcut just simulates that click.

A future spec can refactor save out of the toolbar button into a shared
`save(editor)` helper, but for v1 the click-simulation is fine and
keeps the diff small.

## Files

**New**

- `src/editor/keymap-actions.js` — action registry (~22 entries),
  `resolveKey()` helper. Pure module.
- `src/editor/keymap-overrides.js` — storage helpers (`loadOverrides`,
  `saveOverrides`, `setOverride`, `clearOverride`, `clearAllOverrides`,
  `migrate`), the `userOverridesCompartment`, `validateBinding`,
  `buildOverrideKeymap`, `reconfigureOverrides`, `reconfigureAll`.
- `src/ui/keymap-customize.js` — customize sub-section widget. Mounts
  rows, manages collapse state, owns recording state, owns the transfer
  banner with Undo, owns search.
- `src/editor/keymap-actions.test.js` — registry shape, defaults
  coverage, no duplicate IDs, `resolveKey` correctness.
- `src/editor/keymap-overrides.test.js` — load/save round-trip, migrate
  v1→v1 no-op, drop unknown action IDs with warning, drop malformed
  keys, validateBinding rejects bare letters and upstream reservations,
  detects internal conflicts.

**Modified**

- `src/editor/keymap-universal.js` — derive its keymap from the registry
  filtered by `layer: "universal"` and current profile + overrides. The
  current `Mod-Enter` entry is replaced by `KEYMAP_ACTIONS["strasbeat.eval"]`
  resolution.
- `src/editor/keymap.js` — `createVscodeKeymap` derives its keymap from
  the registry filtered by `layer: "overlay"`. The layout-fallback
  bindings (`Mod-:`, `Mod-#`, `Tab`, `Shift-Tab`) stay hardcoded — they
  are reachability fallbacks for the `toggleComment` / `indentMore` /
  `indentLess` actions, not separate actions.
- `src/editor-setup.js` — add `userOverridesCompartment` to the boot
  dispatch (after universal, after overlay). Thread `onSave`,
  `onStop`, `onFormat` callbacks through `dispatchEditorExtensions`.
  Read overrides via `loadOverrides()` at boot.
- `src/editor/keymap-apply.js` — `applyKeymapProfile` also reconfigures
  the default-layer compartments (because their contents now depend on
  profile + overrides). Add `reconfigureAll()` for the override-change
  path. Notify subscribers as today.
- `src/ui/settings-panel.js` — mount `keymap-customize.js` widget below
  the existing Keymap dropdown.
- `src/ui/command-palette.js` — items that map to registered actions
  read their shortcut text from `resolveKey()`.
- `src/main.js` — wire `onSave: () => saveBtn.click()` into
  `dispatchEditorExtensions`. Same for `onStop`, `onFormat`.
- `src/styles/...` — new CSS for the customize sub-section, recording
  state, transfer banner. Delegated to `impeccable` at implementation.

## Acceptance

- [ ] Action registry: every action has a unique ID, a non-empty label,
      a category, a `layer` (`universal` or `overlay`), and a
      `defaultsByProfile` object covering all 5 profile IDs (values may
      be `null`). `pnpm test` passes for `keymap-actions.test.js`.
- [ ] Boot reads `strasbeat:keymap-overrides` before the StrudelMirror
      constructor runs. A user with `{ "strasbeat.save": "Mod-s" }`
      stored sees `Cmd+S` work on first paint, no flash.
- [ ] User on Strudel profile binds `Cmd+S` to save: pattern persists
      to disk via the toolbar save flow.
- [ ] User on Strudel profile binds `Cmd+J` to `selectNextOccurrence`:
      works despite the VSCode overlay being inactive (override
      compartment promotes it).
- [ ] Optimistic-apply transfer: user binds `Cmd+B` to format. Format
      gains the binding, `toggleRightRail` row becomes Unbound. Banner
      appears with `Undo`. Both rows briefly highlight. `Undo` within
      6 s restores both states; outside 6 s the banner is gone.
- [ ] Per-row `×` clears a single override. If override was a string,
      row reverts to default. If override was `null`, row reverts to
      default (which may now conflict with a different action's
      override at higher precedence — this is correct, see §6).
- [ ] Recording state: bare letter rejected with inline error
      `Add a modifier (Cmd, Ctrl, Alt).` Recording stays open. Esc /
      blur / click-outside / Tab exit without saving.
- [ ] Recording state: pressing `Ctrl+Enter` → inline error
      `Reserved by Strudel REPL.`
- [ ] Auto-collapse: on Strudel profile, *Editor* and *Tracks* start
      collapsed; *Pattern* and *App* start expanded. On VSCode profile
      all four expanded.
- [ ] Search input on focus auto-expands all categories; clearing
      search restores collapse state.
- [ ] Reset-all confirms and clears the entire overrides map.
- [ ] localStorage robustness: corrupted JSON → ignore + warn; unknown
      action IDs → drop + warn; malformed keys → drop + warn. App
      boots cleanly in all cases.
- [ ] Vim profile: `Cmd+S` works in NORMAL, INSERT, VISUAL modes. Same
      for `Cmd+B`, `Cmd+Shift+P`, `Cmd+Enter`.
- [ ] Profile switch via chip or dropdown does NOT reconfigure the
      override compartment. The customize widget's "default" hints
      DO update for the newly active profile.
- [ ] Command palette items that correspond to registered actions
      reflect the user's overrides — open palette after rebinding,
      shortcut column shows the new key.
- [ ] AZERTY mac smoke (VSCode profile): `Cmd+:` still toggles comment,
      `Tab` / `Shift+Tab` still indent on selection. (Layout fallbacks
      survive the registry refactor.)
- [ ] No regression in WAV export, MIDI capture, or pattern persistence.

## Coordination with 22-intellisense-v2

`22-intellisense-v2.md` is in writing-plans concurrently with this spec
and lands four new universal-layer keybindings (per its §"Keyboard
ergonomics summary"):

| intellisense-v2 binding | Phase | Action surface                         | Conflict surface                          |
| ----------------------- | ----- | -------------------------------------- | ----------------------------------------- |
| `Tab` accept-completion | 2     | gated meta-binding (popup-aware)       | falls through to existing Tab indent      |
| `Alt+↓` / `Alt+↑` audition | 2  | gated on popup state + completion type | overlaps VSCode-overlay `moveLineUp/Down` |
| `Cmd+Shift+B` reveal in browser | 3 | named user action                  | new keys, no overlap                      |
| `Cmd+J` focus browser   | 4.C   | named user action                      | new keys, no overlap                      |

### Resolution by binding

**`Tab` accept-completion is NOT a registry entry.** It's a meta-binding
that gates on autocomplete state and delegates otherwise. Putting it in
the registry would imply user-rebindability, which doesn't make sense
for "accept the highlighted completion" — that's editor behavior,
not a named user action. It stays in `keymap-universal.js` as a
hand-written CM6 keymap entry, alongside `Mod-Enter`. The registry
refactor leaves it intact.

**`Alt+↓` / `Alt+↑` audition** has a real overlap with the existing
VSCode overlay's `moveLineUp/Down`. Resolution:

1. The audition action becomes a **registry entry**:
   `strasbeat.completions.auditionNext` / `…auditionPrev`,
   `layer: "universal"`, default key `Alt-ArrowDown` / `Alt-ArrowUp`,
   default for *all 5 profiles* (intellisense-v2 wants it always-on).
2. The audition `run` returns the **actual return value** of
   `moveCompletionSelection(forward)(view)` — so when the popup is
   closed, the universal binding *falls through* (returns false), and
   the VSCode overlay's `moveLineUp/Down` (also a registry entry,
   `layer: "overlay"`, default key same) fires next. Same key, two
   different layers, gated by autocomplete state. CM6 keymap precedence
   handles the rest.
3. The intellisense-v2 spec's outlined `run` — which returns `true`
   unconditionally — would break this. The plan that emerges from
   intellisense-v2 needs to use `return moved` (or equivalent
   short-circuit) so the universal binding is well-mannered. **This
   coordination point is flagged here for whichever plan lands first to
   adopt the gated-return pattern.** If intellisense-v2's plan ships
   with `return true` and lands first, this spec's implementation plan
   inserts a one-line fix as a coordination task.

**`Cmd+Shift+B` reveal in browser** and **`Cmd+J` focus browser** are
clean adds. They become registry entries with `layer: "universal"` and
non-null defaults across all profiles. Their `run` calls into the
existing `revealSoundInBrowser` / `focusSoundBrowserWithToken` helpers
that intellisense-v2 introduces. Listed in *Open questions* item 1
below as part of the page-level migration story.

### Sequencing

Either order works. If **22-intellisense-v2 lands first** (likely given
it's further along in writing-plans), this spec's implementation plan
absorbs whatever bindings landed inline in `keymap-universal.js`,
migrates them into the registry as part of the refactor, and adds the
three rebindable entries (`auditionNext`, `auditionPrev`,
`revealInBrowser`, `focusBrowser`). If **23-keybinding-overrides lands
first**, the registry exists when intellisense-v2's plan runs and that
plan adds entries to the registry directly instead of editing
`keymap-universal.js`.

The spec writes its plan assuming intellisense-v2 lands first. The
plan's coordination task (Task #N) reads the post-intellisense state
of `keymap-universal.js` and migrates the bindings into the registry
in one clean step.

### No conflict in other surfaces

- **Settings panel** — intellisense-v2 doesn't touch it.
- **Command palette** — intellisense-v2 adds new entries (reveal-sound,
  focus-browser); this spec changes how shortcut text is *derived*.
  Additive, no conflict.
- **localStorage keys** — `strasbeat:keymap-overrides` (this spec) and
  `strasbeat:completions-recency` (intellisense-v2) don't collide.
- **Layer 1 (Strudel upstream)** — neither spec touches it.

## Open questions / deferred

In rough priority order:

1. **Page-level `Cmd+B` / `Cmd+Shift+P` migration.** They live as
   `document.addEventListener("keydown")` in `main.js` today. Their
   registry entries currently have `layer: "page"` and a custom run
   path that calls the existing handlers via window-level hooks. A
   cleaner v2 lifts them into a CM keymap so they go through the same
   override compartment as everything else — but that's a separate
   refactor and out of scope here. Today: the rebind UI surfaces them
   read-only-on-page-shortcuts (override the binding via overrides
   map, the page-level listener checks the override before firing the
   default), so they ARE rebindable; just plumbed differently.
2. **JSON view / import-export.** VSCode-style raw JSON editor for
   power users. Not v1. Add when someone asks.
3. **Per-profile overrides.** Settled in brainstorming as global only.
   If demand emerges (probably won't), we can add a per-action
   "scope: profile-id" toggle later without breaking the existing
   storage shape.
4. **Sharing keymap configs via URL.** Alongside the existing pattern
   share. Not v1.
5. **Conditional / contextual bindings** ("when cursor in
   mini-notation, Cmd+L does X"). Setup-script territory.
6. **Modal-grammar customization** (rebinding Vim's `:w` action's
   ex-command, remapping `j`/`k`). `Vim.defineEx` in setup script.
7. **Bulk preset import** ("load Sublime profile"). No demand signal.
8. **Auto-detect keyboard layout** to hide AZERTY fallbacks. Aesthetic.
9. **Banner copy pluralization.** Currently no scenario produces
   multiple unbinding consequences from a single rebind, but if one
   ever does, copy needs to handle plurals.

## Out of scope

- **Refactoring the upstream Strudel `keybindings` compartment.** It
  remains the gatekeeper of profile bindings; we don't try to
  participate in it.
- **Mobile / touch alternatives.** Inherited from `21-keybindings.md`.
- **New keyboard shortcuts beyond what's listed.** This spec is about
  *how* shortcuts are configured, not *which* shortcuts exist (with
  the single exception of `Cmd+S` for save, which folds in the
  flagged follow-up from `21-keybindings.md`).
- **Touching the existing modal-profile mode subscription** in
  `keymap-chip.js` — the chip's mode display is unrelated to overrides.
- **Visual tokens / motion design** for the customize sub-section,
  recording chip, transfer banner — owned by `impeccable` /
  `polish` / `animate` skills at implementation time.
- **Custom action authoring** ("let users add their own actions
  pointing at custom JS"). Setup-script territory; the action
  registry is intentionally a closed set.
