# 21 — Keybinding profiles (Strudel default · VSCode · Vim · Emacs · Helix)

> Status: design — 2026-04-30. Read `../README.md`, `../SYSTEM.md`,
> `../../CLAUDE.md`, and the existing `02-format-and-keybindings.md`
> before starting. This task touches the editor (a CodeMirror compartment
> for the strasbeat overlay), the transport bar (a new keymap chip), the
> settings panel (one dropdown), and `main.js` (three custom-event
> listeners). Do **not** rewrite the existing overlay keymap in
> `src/editor/keymap.js` — extend it.

## Goal

Make strasbeat's editor feel native to whoever's typing into it.
Specifically:

1. **Strudel is the default profile** for new users — what they get
   matches strudel.cc keystroke-for-keystroke. Someone moving from the
   official client opens strasbeat and their muscle memory just works.
2. **Five profiles, picked from the chip in the transport bar or the
   Settings dropdown**: Strudel, VSCode, Vim, Emacs, Helix. Persisted to
   `localStorage`, applied live without reload.
3. **A keymap chip in the transport bar** doubles as status indicator and
   profile switcher: shows which profile is active, opens a polished
   popover on click, displays Vim/Helix mode inline (`Vim · NORMAL`).
4. **Strudel's official `:w` / `:q` / `gc` muscle memory works in every
   modal profile** via the `repl-evaluate`, `repl-stop`,
   `repl-toggle-comment` custom events Strudel already dispatches.
5. **Layout-aware overlay (VSCode profile only)**: every strasbeat
   shortcut that uses a layout-fragile key (`/`, `[`, `]`, `:`) has a
   parallel binding that reaches the same command on AZERTY (mac & win),
   German QWERTZ, and the other common European layouts.

Visual treatment of the chip and popover is delegated to the `impeccable`
skill at implementation time — this spec describes interaction and
structure, not pixels. Explicit non-goals — see *Out of scope*.

## Why

A user asked specifically for vim. The deeper reason is that strasbeat
positions itself as an **IDE-quality** workspace (top of CLAUDE.md), and
"works with my muscle memory" is the single biggest gap between feeling
like an editor and feeling like a webapp.

Today, strasbeat ships a single VSCode-flavoured overlay applied to every
user. That's great if you came from VSCode; it's a surprise if you came
from strudel.cc and pressed `Cmd+D` expecting to add a cursor instead of
selecting the next occurrence. With Strudel as the default, the
strudel.cc audience (which is most first-time users) gets exactly what
they expect, and developers can flip to VSCode (or Vim, Emacs, Helix) in
one click.

We're also picking up two adjacent wins almost for free:

- Strudel ships **Vim, Emacs, VSCode, and Helix modes** through
  `@strudel/codemirror`'s `keybindings` compartment
  (`'codemirror' | 'vim' | 'emacs' | 'vscode' | 'helix'`). The
  `@replit/codemirror-{vim,emacs}` packages are already in our
  `node_modules` via Strudel's transitive deps — no new dependency
  required (we should declare them explicitly anyway, see *Files* below).
- Strudel **already pre-binds** `:w` → eval, `:q` → stop, `gc` →
  toggle-comment by dispatching DOM events for the host to listen to. A
  three-line listener block in `main.js` unlocks all of it.

Most of this spec is plumbing the path that already exists into the
strasbeat UI — not building a keybinding system from scratch. The novel
part is the chip and popover.

## Mental model: three stacked layers

The keymap that ends up in the user's editor is the union of three
independent layers, each with a clear responsibility.

```
┌────────────────────────────────────────────────┐
│ Layer 3 — Profile editing keymap               │  user-selected, swaps live
│   Strudel (none)                               │
│   VSCode (createVscodeKeymap + layout fallbacks)│
│   Vim    (Strudel's vim compartment)           │
│   Emacs  (Strudel's emacs compartment)         │
│   Helix  (Strudel's helix compartment)         │
├────────────────────────────────────────────────┤
│ Layer 2 — Always-on app shortcuts              │  unconflicting with strudel.cc,
│   Cmd+B toggle right rail (page-level)         │  always loaded
│   Cmd+Shift+P command palette (page-level)     │
│   Cmd+Enter eval (CM, mac parity for Ctrl+Enter)│
├────────────────────────────────────────────────┤
│ Layer 1 — Strudel upstream                     │  Prec.highest, untouchable
│   Ctrl+Enter / Alt+Enter eval                  │
│   Ctrl+. / Alt+. stop                          │
│   Alt+w / Alt+q jump-to-`$`                    │
└────────────────────────────────────────────────┘
```

Layer 1 is upstream Strudel at `Prec.highest`. We never override these.
Layer 2 is strasbeat's app shell — by definition these don't exist on
strudel.cc, so they can't surprise anyone with strudel.cc muscle memory.
Layer 3 is the *editing* keymap. The "Strudel" profile contributes
nothing to Layer 3 — the editor behaves as plain Strudel-codemirror.

Note on Cmd+S: a save keyboard shortcut is conspicuously absent today —
saving happens via the toolbar button or the palette entry only. That's
out of scope for this spec; it's flagged in *Open questions* for a
follow-up.

## Profile catalog

| Profile     | Strudel `keybindings` value | Strasbeat overlay applied? | Modal? | Layout fallbacks |
| ----------- | --------------------------- | -------------------------- | ------ | ---------------- |
| **Strudel** | `'codemirror'`              | No                         | No     | Not needed       |
| **VSCode**  | `'vscode'`                  | Yes (`createVscodeKeymap`) | No     | `Cmd+:`, `Tab`/`Shift+Tab` |
| **Vim**     | `'vim'`                     | No (would clash with modal)| Yes    | None             |
| **Emacs**   | `'emacs'`                   | No                         | No     | None             |
| **Helix**   | `'helix'`                   | No (would clash with modal)| Yes    | None             |

Two notes:

1. **Strudel default is strict** — no strasbeat overlay. A user with
   strudel.cc muscle memory presses `Ctrl+Enter` and it works (Layer 1).
   They press `Cmd+D` and nothing happens (intentional — that's a VSCode
   convention, not a Strudel one). They get `Cmd+B`/`Cmd+Shift+P`/`Cmd+Enter`
   because those are app-level conveniences that don't exist on
   strudel.cc and can't conflict.
2. **VSCode profile uses both Strudel's `'vscode'` value and our
   overlay**. They're complementary — Strudel's value wires upstream
   VSCode-flavoured CM features (search bindings etc.); strasbeat's
   overlay adds the VSCode-specific commands (`Cmd+D`, `Cmd+Shift+K`,
   `Cmd+L`, `Alt+↓`, `Cmd+/`, etc.) the upstream set doesn't include.
   Read `strudel-source/packages/codemirror/keybindings.mjs` during
   implementation to confirm there's no overlap that produces
   double-bindings.
3. **Vim/Emacs/Helix do NOT layer the strasbeat overlay**. Modal editors
   interpret bare letter keys as commands; layering a `Cmd+`-prefixed
   overlay on top works *technically* (different key event), but it
   bifurcates the user's mental model ("am I in modal land or shortcut
   land?"). Modal profiles stay pure.

## Background — what's wired today

Three independent shortcut layers, each at its own precedence tier:

1. **Strudel upstream**, at `Prec.highest` inside `@strudel/codemirror`
   (`codemirror.mjs` lines ~105–155 of the bundled file): `Ctrl-Enter` /
   `Alt-Enter` (eval), `Ctrl-.` / `Alt-.` (stop), `Alt-w` / `Alt-q`
   (jump `$` label).
2. **strasbeat's overlay** at `Prec.highest` via
   `StateEffect.appendConfig` (see `src/editor/keymap.js` and
   `src/editor-setup.js#dispatchEditorExtensions`): `Mod-Enter` (eval —
   the macOS `Cmd+Enter` muscle-memory binding), `Mod-M` (mute),
   `Mod-Shift-S` (solo), `Mod-D` (selectNext), `Mod-Shift-L`
   (selectAllMatches), `Mod-L` (selectLine), `Mod-Shift-K` (deleteLine),
   `Alt-↑` / `Alt-↓` (moveLine), `Mod-/` + `Mod-:` (toggleComment, the
   `:` is the AZERTY fallback), `Mod-]` / `Mod-[` (indent). **Currently
   loaded unconditionally** — this spec's biggest mechanical change is
   making it profile-conditional.
3. **Page-level** `document.addEventListener('keydown')` in `main.js`:
   `Mod-B` (toggle right rail), `Mod-Shift-P` (command palette). These
   are effectively Layer 2 already. (Save has no keyboard shortcut
   today — see *Open questions*.)

Strudel's `keybindings` compartment is the lever we haven't pulled. Its
default value is `'codemirror'`. Setting it to `'vim'` activates
`@replit/codemirror-vim` plus the Strudel-side `Vim.defineEx` /
`Vim.mapCommand` block that maps `:w` `:q` `gc` to dispatched DOM events.
The host listening for those events is what makes the binding actually
*do* something — and we're not listening yet.

CM6 keymap precedence is **last-wins for the same key**. That means our
Layer-2 keys (`Mod-B`, `Mod-Shift-P`, `Mod-Enter`) and Layer-1 Strudel
upstream keys will continue to win over any non-`Prec.highest` modal
binding. Vim's
modal commands (`hjkl`, `:`, `i`, `Esc`, etc.) are non-modifier — they
don't conflict with anything we bind.

## Approach

### 1. Profile registry

Single source of truth for what profiles exist, what they do, and how
they render in the chip popover.

```js
// src/editor/keymap-profiles.js
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

export function getStoredProfileId() { /* read localStorage, validate, fall back to DEFAULT_PROFILE_ID */ }
export function setStoredProfileId(id) { /* write localStorage */ }
export function getProfile(id) { /* lookup, fall back to default */ }
export function hasSeenTooltip() { /* read TOOLTIP_SEEN_KEY */ }
export function markTooltipSeen() { /* write TOOLTIP_SEEN_KEY */ }
```

### 2. Universal keymap (Layer 2, always-on)

`src/editor/keymap-universal.js` (new). Holds the bindings that must work
regardless of profile but are CM-side rather than page-level.

```js
import { keymap } from "@codemirror/view";

export function createUniversalKeymap({ onEvaluate }) {
  return keymap.of([
    {
      key: "Mod-Enter",
      preventDefault: true,
      run: () => { onEvaluate(); return true; },
    },
  ]);
}
```

Today `Mod-Enter` lives inside `createVscodeKeymap`. After this spec it
moves to the universal keymap so macOS `Cmd+Enter` continues to evaluate
in the Strudel/Vim/Emacs/Helix profiles too. It's the only Layer-2 CM
binding for now; the page-level shortcuts (`Cmd+B`, `Cmd+Shift+P`) stay
as `document.addEventListener` in `main.js`.

### 3. CM compartment for the strasbeat overlay

The existing `dispatchEditorExtensions` in `src/editor-setup.js` calls
`Prec.highest(createVscodeKeymap(...))` *unconditionally*. We wrap it in
a `Compartment` so it can be turned on/off live without remounting the
editor.

```js
// editor-setup.js
import { Compartment } from "@codemirror/state";

const strasbeatOverlayCompartment = new Compartment();

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
      numericScrubber({ /* ... */ }),
      hoverDocs({ onOpenReference }),
      signatureHint,
    ]),
  });
}

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

### 4. Profile change flow

A single canonical handler is what both the chip popover and the
settings dropdown call:

```js
// src/editor/keymap-apply.js (new) or co-located in editor-setup.js
function applyKeymapProfile(editor, profileId, { onEvaluate }) {
  const profile = getProfile(profileId);

  // Strudel-side: reconfigure its keybindings compartment + persist to atom.
  applyPanelSetting(editor, "keybindings", profile.strudelKeybindings);

  // Strasbeat-side: turn the overlay on/off via our compartment.
  reconfigureOverlay(editor, profile.applyStrasbeatOverlay, onEvaluate);

  // Persist canonical profile id (Strudel atom mirrors the string value;
  // strasbeat profile id is the source of truth so we can map back to
  // the chip's selection on reload).
  setStoredProfileId(profile.id);

  // Notify subscribers (chip relabels, tooltip closes, settings dropdown updates).
  notifyKeymapChange(profile);
}
```

### 5. Initial load (no flash)

Same pattern as the existing settings flow — read the profile id from
localStorage **before** the StrudelMirror constructor runs, merge
`keybindings: profile.strudelKeybindings` into the initial
`editor.updateSettings()` call, and pass the same profile id to
`dispatchEditorExtensions` so the overlay compartment is initialised
with the correct contents. No first-paint flash.

```js
// editor-setup.js#applyInitialSettings
const profile = getProfile(getStoredProfileId());
editor.updateSettings({
  ...defaultSettings,
  ...STRASBEAT_DEFAULT_PREFERENCES,
  ...(storedSettings ?? {}),
  ...STRASBEAT_REQUIRED_ON,
  keybindings: profile.strudelKeybindings, // last so we win
});
```

### 6. Custom-event listeners (Strudel-canonical commands)

In `main.js`, alongside the existing `Mod-B` and `Mod-Shift-P` document
listeners. These are how Strudel's vim/emacs/helix integrations deliver
`:w`, `:q`, and `gc`:

```js
// Strudel's modal keymaps dispatch these custom events instead of
// running CM commands directly — the host wires them to whatever the
// app considers "evaluate" / "stop" / "toggle comment". See
// node_modules/@strudel/codemirror/keybindings.mjs (Vim.defineEx blocks).
document.addEventListener("repl-evaluate", () => editor.evaluate());
document.addEventListener("repl-stop", () => editor.stop());
document.addEventListener("repl-toggle-comment", () => {
  editor.editor.focus();
  toggleComment(editor.editor);
});
```

Three lines. Harmless when the profile is Strudel/VSCode (no event ever
fires). Load-bearing when the profile is Vim/Emacs/Helix.

### 7. Keymap chip + popover

The user-visible piece. Mounted in the transport bar to the left of the
MIDI pill, in `src/ui/transport.js` via a new `src/ui/keymap-chip.js`
module.

**Chip label by profile:**

| Profile  | Label                                                    |
| -------- | -------------------------------------------------------- |
| Strudel  | `Strudel ▾`                                              |
| VSCode   | `VSCode ▾`                                               |
| Vim      | `Vim · NORMAL ▾` / `Vim · INSERT ▾` / `Vim · VISUAL ▾` / `Vim · REPLACE ▾` |
| Emacs    | `Emacs ▾`                                                |
| Helix    | `Helix · NORMAL ▾` / `Helix · INSERT ▾` / `Helix · SELECT ▾` |

For modal profiles the mode word is what flips on input. The label
container must be fixed-width with the mode word right-aligned within
it, **no transition on change** — rapid `i`/`Esc` cycling must not
visibly jump anything to the right of the chip.

**Popover (on click), anchored above the chip:**

Each row contains:

- **Profile name** (primary text)
- **Description** (secondary, ~12px, muted, single line — the same
  description string from `KEYMAP_PROFILES`)
- **Active checkmark** left of the name, only on the active profile
- **`default` tag** on the right side, only on the Strudel row

```
✓ Strudel                                         default
  Matches strudel.cc · Ctrl+⏎ play, Ctrl+. stop

  VSCode
  Cmd+D selectNext, Cmd+Shift+K delete line, Alt+↓ move

  Vim
  Modal · :w eval, :q stop, gc comment

  Emacs
  C-x C-s save, C-/ comment, M-w yank

  Helix
  Modal · select-then-act, gc comment
```

**Interactions:**

- Hover a row → highlight (`--surface-2`).
- Click a row → apply profile, persist, close popover. No "save"
  button. Picking IS committing.
- Escape → close without changing.
- Click outside → close without changing.
- Arrow keys + Enter for keyboard nav. (We're a dev tool — required.)
- Live-applies. No reload, no editor remount, no scroll jump, no cursor
  reset.

**Visual treatment:** owned by the `impeccable` skill at implementation
time. The brief: "the chip should disappear into the chrome — it's
status, not action-bait. The popover, when open, should feel like
VSCode's status-bar pickers: tight, fast, polished, dismissible."

### 8. First-time tooltip

When `localStorage["strasbeat:keymap-chip-seen"]` is falsy, a one-shot
tooltip appears anchored to the chip on first load:

> Click to change your editor keymap

Dismissal:

- On any chip click → tooltip vanishes, flag set, popover opens normally.
- On any other interaction (typing in editor, clicking elsewhere) →
  tooltip vanishes, flag set.
- No "X" button. No auto-hide timer. No reappearance, ever.

### 9. Vim/Helix mode subscription

Modal profiles need to push mode changes into the chip. The exact API
surfaces of `@replit/codemirror-vim@6.x` and Strudel's helix integration
need to be verified against the installed packages — read
`node_modules/@replit/codemirror-vim/dist/index.cjs` and the
helix-related code under `node_modules/@strudel/codemirror/` before
writing the subscription.

If neither package exposes a public mode-change hook, fall back to a CM6
`ViewPlugin` that polls `view.state.vim?.mode` (or the helix equivalent)
on each `update()` and calls a registered listener if the value
changed. Polling on every editor update is cheap; mode flips happen on
user input only.

The chip subscribes only when the active profile is modal; in
non-modal profiles the subscription is torn down so we don't pay any
cost.

### 10. Settings panel — alternate entry point

Add a single row at the top of the Editor section in
`src/ui/settings-panel.js` (above `EDITOR_TOGGLES`). Reuse the existing
`buildRow` + `<select>` pattern used for Theme / Font:

```
Editor
  Keymap          [ Strudel        ▾ ]   ← new
  Line numbers    [• on  ]
  Line wrapping   [○ off ]
  …
```

The `<select>` lists all 5 profiles. Its `onChange` calls the same
`applyKeymapProfile()` function the chip popover uses. Both UIs are
alternate entry points to the same canonical state — picking a profile
in one updates the other in the same tick.

### 11. Layout-aware overlay (VSCode profile only)

CM6 normalises keys via `event.key` (the *produced character*), not
`event.code` (the physical key). On AZERTY mac, `/` is `Shift+:` —
typing the `Mod-/` shortcut becomes `Mod-Shift-:` → `Mod-?`, which macOS
intercepts as the Help menu shortcut and never reaches CodeMirror. The
existing `Mod-:` fallback in `keymap.js` handles this for comment
toggle. We extend the same pattern to every fragile binding in the
VSCode overlay.

`src/editor/keymap.js#createVscodeKeymap` gains a small
layout-fallback table:

| Action          | Primary (QWERTY) | Fallback bindings (added)                   |
| --------------- | ---------------- | ------------------------------------------- |
| Toggle comment  | `Mod-/`          | `Mod-:` (AZERTY mac), `Mod-#` (QWERTZ DE)   |
| Indent more     | `Mod-]`          | `Tab` *(when selection ≥ 1 line)*           |
| Indent less     | `Mod-[`          | `Shift-Tab` *(when selection ≥ 1 line)*     |
| Delete line     | `Mod-Shift-K`    | (letter — no fallback needed)               |
| Move line up    | `Alt-↑`          | (arrow — layout-stable)                     |
| Move line down  | `Alt-↓`          | (arrow — layout-stable)                     |

Letter keys (`d`, `m`, `s`, `l`, `k`, `b`, `p`) are layout-stable in
practice — they sit at different physical locations on AZERTY but
produce the same `event.key`, which is what CM6 matches on. Number keys
would be a problem (AZERTY needs Shift to produce digits) but we don't
bind any. Arrow keys, `Tab`, `Enter`, `Escape` are universal.

`Tab` / `Shift-Tab` for indent are partially handled by `indentWithTab`
(a separate `@codemirror/commands` extension) — verify whether Strudel
includes it (it does ship `defaultKeymap` which sometimes does, depending
on version) and add it explicitly if not. The guard "when selection ≥ 1
line" matters because plain `Tab` in the middle of a line should still
insert a tab character; CM6's `indentWithTab` handles this correctly out
of the box.

Strudel and Vim/Emacs/Helix profiles don't bind `Cmd+/`, `Cmd+]`,
`Cmd+[` at all (those are VSCode-overlay commands), so they don't need
fallbacks. Layer 2 `Cmd+B`/`Cmd+Shift+P`/`Cmd+Enter` use letters and
`Enter` which are layout-stable.

### 12. Cheatsheet alignment (palette searchability)

The command palette (`src/ui/command-palette.js#buildCommands`) is our
de-facto cheatsheet. Two small updates so it stays honest:

1. The shortcut column in palette items reads from the active profile.
   In Vim profile, the comment row shows `gc`; in Emacs profile, `C-/`;
   in VSCode/Strudel, `Cmd+/` (VSCode only — not bound in Strudel).
   Implement by adding optional `vimShortcut` / `emacsShortcut` /
   `helixShortcut` fields to each command and rendering whichever
   matches the active profile.
2. Two **new** palette entries (no global keys — palette-only) for the
   Strudel-canonical commands surfaced through modal profiles:
   - `Eval (Strudel :w)` — same `run` as Play, listed for discoverability
   - `Stop (Strudel :q)` — same `run` as Stop

These are not new shortcuts. They're existing commands gaining a second
label so users searching `:w` find evaluate.

### 13. Persistence + reload behavior

The single source of truth for "which profile is active" is
`localStorage["strasbeat:keymap-profile"]`. On boot:

1. Read the profile id (defaults to `"strudel"`).
2. Resolve to its `strudelKeybindings` value and `applyStrasbeatOverlay`
   flag.
3. Pass through `applyInitialSettings` so it lands in the very first
   `editor.updateSettings({...})` call, *before* the editor renders.
4. Pass through `dispatchEditorExtensions` so the overlay compartment
   initialises with the correct contents.

On runtime change via chip or settings dropdown:

1. `applyPanelSetting(editor, 'keybindings', value)` — Strudel
   reconfigures its own compartment.
2. `reconfigureOverlay(editor, applyOverlay, onEvaluate)` — strasbeat
   reconfigures its compartment.
3. `setStoredProfileId(id)` — persist for next boot.
4. `notifyKeymapChange(profile)` — chip relabels, mode subscription
   reattaches if modal, settings dropdown updates if open.

The Strudel-side nanostore atom (`codemirrorSettings`) ends up holding
`keybindings: 'vim'` etc. as a side effect of `applyPanelSetting`. That's
fine but it's not the source of truth — the strasbeat profile id beats
it on reload by being merged last.

## Files

- `src/editor/keymap-profiles.js` — **new**. Profile registry,
  localStorage helpers, tooltip-seen flag.
- `src/editor/keymap-universal.js` — **new**. Layer-2 always-on CM
  bindings (currently just `Mod-Enter` for macOS eval parity).
- `src/editor/keymap.js` — extend `createVscodeKeymap()` with the
  layout-fallback bindings from §11. Remove `Mod-Enter` (now lives in
  `keymap-universal.js`). Do **not** restructure the existing function
  beyond that; add to its keymap array.
- `src/editor-setup.js` — `applyInitialSettings` reads the profile and
  merges `keybindings`. `dispatchEditorExtensions` introduces
  `strasbeatOverlayCompartment` and loads the universal keymap
  unconditionally. Export `reconfigureOverlay`.
- `src/editor/keymap-apply.js` — **new** (or co-located in
  `editor-setup.js`). Single `applyKeymapProfile()` function called by
  both chip and settings dropdown.
- `src/ui/keymap-chip.js` — **new**. Chip element, popover, first-time
  tooltip, modal-profile mode subscription, keyboard navigation.
- `src/ui/transport.js` — mount the chip next to the MIDI pill.
- `src/ui/settings-panel.js` — add Keymap row at top of Editor section,
  wire `onChange` to `applyKeymapProfile`.
- `src/main.js` — three `document.addEventListener` lines for
  `repl-evaluate` / `repl-stop` / `repl-toggle-comment`. Pass
  `applyKeymapProfile` reference into transport + settings mounts.
- `src/ui/command-palette.js` — optional `vimShortcut` / `emacsShortcut`
  / `helixShortcut` fields, two new palette-only entries for `:w` / `:q`
  searchability.
- `src/styles/...` — chip + popover styling. The `impeccable` skill owns
  the visual treatment at implementation time.
- `package.json` — add `@replit/codemirror-vim` and
  `@replit/codemirror-emacs` as explicit dependencies. They're currently
  transitive deps of `@strudel/codemirror` and work today, but the
  moment we `import` them ourselves we should declare the deps directly
  so `pnpm` doesn't break us if Strudel ever drops them.

## Acceptance

- [ ] **Strudel profile (default for new users):** `Ctrl+Enter` plays,
      `Ctrl+.` stops, `Alt+w`/`Alt+q` jump-to-`$`. `Cmd+B` toggles right
      rail, `Cmd+Shift+P` opens palette, `Cmd+Enter` plays on macOS.
      None of `Cmd+D`, `Cmd+L`, `Cmd+Shift+K`, `Cmd+/`, `Alt+↓` do
      anything (overlay not loaded).
- [ ] **VSCode profile:** every existing strasbeat overlay shortcut
      behaves identically to today. Smoke-test the full set in
      `02-format-and-keybindings.md`.
- [ ] **Vim profile:** `i` enters insert, `Esc` returns to normal,
      `:w⏎` evaluates, `:q⏎` stops, `gc` (visual or normal + motion)
      toggles comment, `hjkl` navigates. `Cmd+Enter` (mac) /
      `Ctrl+Enter` still evaluates regardless of mode. `Cmd+B` and
      `Cmd+Shift+P` still work.
- [ ] **Emacs profile:** `C-x C-s` saves (verify against installed
      `@replit/codemirror-emacs` defaults), `C-/` toggles comment,
      `M-w` / `C-y` copy/yank. Layer-2 shortcuts still work.
- [ ] **Helix profile:** `i`/`Esc`/select-then-act semantics work.
      `:w⏎` evaluates. Layer-2 shortcuts still work.
- [ ] **Profile switching** via chip popover or settings dropdown takes
      effect within ~16ms with no editor remount, no scroll jump, no
      cursor reset.
- [ ] **Persistence:** profile choice survives page reloads. New users
      with no stored profile start on Strudel.
- [ ] **Chip display:** correct label for each profile. In Vim/Helix,
      label updates within one frame of mode changes. No animation on
      mode change. Fixed-width container so the mode word doesn't push
      neighbouring elements.
- [ ] **Popover:** opens on chip click, closes on Escape / click
      outside / row select. Arrow-keys + Enter for keyboard nav. Each
      row shows name + description; active row has checkmark; Strudel
      row has "default" tag.
- [ ] **First-time tooltip:** appears once per browser; vanishes on any
      user interaction; never reappears; persists the seen flag through
      reloads.
- [ ] **AZERTY mac smoke test (VSCode profile):** `Cmd+:` toggles
      comment without opening the Help menu. `Tab` and `Shift+Tab`
      indent / dedent the current line(s) when there's a selection.
      (Switch your system keyboard to French to verify.)
- [ ] **Settings panel dropdown:** mirrors chip popover state. Editing
      in one updates the other in the same tick.
- [ ] **Command palette** (`Cmd+Shift+P`) lists all bindings; modal
      profiles show `:w` / `:q` entries findable by literal text search.
- [ ] **No regression in WAV export, MIDI capture, or pattern
      persistence.** None of them touch the editor's keymap, but the
      smoke test is cheap.

## Open questions / deferred

In rough priority order — when someone asks:

1. **Cmd+S keyboard shortcut for save.** Today, save is only triggered
   via the toolbar button or the palette `Save` action. For a dev
   audience that's a glaring IDE-feel gap. Adding `Mod-S` to the Layer-2
   page-level listeners in `main.js` is a 3-line follow-up (call
   `saveBtn.click()` and `e.preventDefault()`). Deliberately *not*
   bundled into this spec to keep its scope tight, but should be the
   immediate next ticket.
2. **Per-binding remap UI.** A real "rebind any shortcut" panel needs
   key-capture widgets, conflict detection, JSON config import/export.
   The 5-profile dropdown covers ≥95% of the value; the remap UI is the
   long-tail catch-all. *This is the eventual end-product the user has
   noted — strong candidate for a follow-up spec.*
3. **Auto-detect keyboard layout** via `navigator.keyboard.getLayoutMap()`
   — could let us hide AZERTY fallbacks from the cheatsheet on QWERTY
   systems. Multi-binding is harmless on the wrong layout, so this is
   purely an aesthetic improvement.
4. **JetBrains / Sublime profiles** — not built into Strudel, would
   require us to hand-roll the keymap. Wait for explicit user request.
5. **Cheatsheet modal (`?` to open)** — palette already lists every
   shortcut. Nice-to-have, not load-bearing.
6. **"Strudel-canonical only, no app shortcuts" hyper-strict mode** —
   for the user who wants strudel.cc *exactly*, even without `Cmd+B`.
   No demand signal yet.
7. **Format shortcut in modal profiles.** Today `Mod-Shift-F` formats.
   Vim's `=` (re-indent) is a near-miss but not equivalent. Leave
   `Mod-Shift-F` as-is across all profiles.
8. **Recording mode / "tell me what key you want" capture.** Standard
   remap-UI affordance. Pairs with item 2.

## Out of scope

- Any change to `src/main.js` beyond the three event listeners and the
  pass-through wiring for `applyKeymapProfile`.
- New keyboard shortcuts beyond what's listed above. This spec is about
  *how* shortcuts are configured, not *which* shortcuts exist.
- Touching the existing overlay logic (`toggleLabelAtCursor`, etc.) —
  extend, don't refactor.
- Changing Strudel's upstream bindings (`Ctrl-Enter`, `Ctrl-.`,
  `Alt-w`, `Alt-q`). They sit at `Prec.highest` and we have no reason
  to override them.
- Custom theme tokens for vim modes (NORMAL highlighted in green, etc.).
  Single look — accent color or `--surface-1` — chosen by `impeccable`
  at implementation time.
- Plugin-side or pattern-side keybindings. Pattern code doesn't see
  keys; this is editor chrome only.
- Mobile / touch shortcut alternatives. The user has a keyboard.
