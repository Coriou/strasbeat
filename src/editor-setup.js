import { Prec, StateEffect } from "@codemirror/state";
import { codemirrorSettings, defaultSettings } from "@strudel/codemirror";
import { formatExtension } from "./editor/format.js";
import { createVscodeKeymap } from "./editor/keymap.js";
import { numericScrubber } from "./editor/numeric-scrubber.js";
import { hoverDocs } from "./editor/hover-docs.js";
import { signatureHint } from "./editor/signature-hint.js";

export function readStoredCmSettingsFromLocalStorage() {
  try {
    const raw = localStorage.getItem("codemirror-settings");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    console.warn(
      "[strasbeat/settings] could not read stored CM settings:",
      err,
    );
    return null;
  }
}

// ─── IDE-quality editor settings ─────────────────────────────────────────
// Strudel ships autocomplete, hover tooltips, bracket matching, multi-cursor
// etc. but defaults all of them OFF. We turn on the ones that make the
// editor feel like a real IDE: typing `note(` shows a doc tooltip,
// hovering a Strudel function shows its signature, () [] {} balance
// highlights, Cmd-click adds a cursor.
//
// GOTCHA 1: `updateSettings` iterates ALL extension keys and
// reconfigures them — any key absent from the passed object gets
// `undefined` → treated as falsy → disabled. So the merged object below
// must always include every key we care about.
//
// GOTCHA 2: the right-rail settings panel writes user-flipped booleans
// to StrudelMirror's persistent atom via `editor.changeSetting`, but a
// naive hardcoded `updateSettings` call at boot would clobber those on
// every page load. We fix this by merging in four layers (lowest wins):
//
//   1. Upstream defaults (every extension key present, correct types).
//   2. strasbeat's preferred defaults — what we turn on if the user has
//      no stored preference. These are the "IDE feel" bonuses
//      (bracket matching, active line highlight, multi-cursor, etc.).
//   3. The user's stored preferences from the persistent atom
//      (`codemirrorSettings`). Includes anything the settings panel
//      persisted on a previous run. Wins over strasbeat defaults so a
//      user who disabled bracket matching in the panel doesn't get it
//      re-enabled on reload.
//   4. Required-on settings — the two keys we never let the user turn
//      off because they are core to the IDE feel (autocompletion,
//      tooltips). Win over everything.
//
// See design/work/08-feature-parity-and-beyond.md "Phase 5" for the
// rationale and strudel-source/packages/codemirror/codemirror.mjs
// (defaultSettings, updateSettings, codemirrorSettings) for the API.

export const STRASBEAT_REQUIRED_ON = {
  isAutoCompletionEnabled: true,
  isTooltipEnabled: true,
};

// Geist Mono stack — kept in sync with `--font-mono` in
// src/styles/tokens.css. The editor.css rules used to hardcode the same
// stack on .cm-content, but that blocked the settings panel's font
// family picker from having any effect; now the CSS rule is gone and
// the stack flows through StrudelMirror's inline-style path instead.
// See design/work/08-feature-parity-and-beyond.md "Phase 5" and the
// rationale in src/styles/editor.css.
export const GEIST_MONO_STACK =
  '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const STRASBEAT_DEFAULT_PREFERENCES = {
  isBracketMatchingEnabled: true,
  isMultiCursorEnabled: true,
  isActiveLineHighlighted: true,
  isTabIndentationEnabled: true,
  isPatternHighlightingEnabled: true,
  fontFamily: GEIST_MONO_STACK,
  fontSize: 18,
};

// The merge uses the stored settings captured BEFORE the StrudelMirror
// constructor ran. See the long comment in main.js for why —
// nanostores' persistentAtom writes defaultSettings to localStorage on
// its first touch, so reading localStorage here (after the constructor)
// would round-trip defaults as if they were the user's stored
// preferences.
export function applyInitialSettings(editor, storedSettings) {
  editor.updateSettings({
    ...defaultSettings,
    ...STRASBEAT_DEFAULT_PREFERENCES,
    ...(storedSettings ?? {}),
    ...STRASBEAT_REQUIRED_ON,
  });
}

// Inject our editor extensions (Prettier formatter + VSCode-style keymap +
// numeric scrubber) into the live EditorView via StateEffect.appendConfig.
//
// Prec.highest on the keymaps: Strudel loads defaultKeymap at Prec.high
// which binds Mod-Enter to insertBlankLine. Without explicit precedence,
// our Mod-Enter → evaluate would lose to insertBlankLine.
export function dispatchEditorExtensions(editor, { onOpenReference }) {
  editor.editor.dispatch({
    effects: StateEffect.appendConfig.of([
      Prec.highest(formatExtension),
      Prec.highest(createVscodeKeymap({ onEvaluate: () => editor.evaluate() })),
      numericScrubber({
        evaluate: () => editor.repl.evaluate(editor.code, false),
      }),
      hoverDocs({ onOpenReference }),
      signatureHint,
    ]),
  });
}

// prettier-ignore
export const THEME_OPTIONS = [
  { key: "strudelTheme", label: "Strudel (default)" }, { key: "dracula", label: "Dracula" }, { key: "nord", label: "Nord" },
  { key: "vscodeDark", label: "VS Code Dark" }, { key: "vscodeLight", label: "VS Code Light" }, { key: "monokai", label: "Monokai" },
  { key: "gruvboxDark", label: "Gruvbox Dark" }, { key: "gruvboxLight", label: "Gruvbox Light" },
  { key: "solarizedDark", label: "Solarized Dark" }, { key: "solarizedLight", label: "Solarized Light" },
  { key: "tokyoNight", label: "Tokyo Night" }, { key: "tokyoNightStorm", label: "Tokyo Night Storm" }, { key: "tokyoNightDay", label: "Tokyo Night Day" },
  { key: "githubDark", label: "GitHub Dark" }, { key: "githubLight", label: "GitHub Light" },
  { key: "materialDark", label: "Material Dark" }, { key: "materialLight", label: "Material Light" },
  { key: "sublime", label: "Sublime" }, { key: "atomone", label: "Atom One" }, { key: "aura", label: "Aura" },
  { key: "darcula", label: "Darcula (JetBrains)" }, { key: "duotoneDark", label: "Duotone Dark" },
  { key: "noctisLilac", label: "Noctis Lilac" }, { key: "eclipse", label: "Eclipse" }, { key: "bbedit", label: "BBEdit" },
  { key: "bluescreen", label: "Blue Screen" }, { key: "bluescreenlight", label: "Blue Screen Light" },
  { key: "blackscreen", label: "Black Screen" }, { key: "whitescreen", label: "White Screen" },
  { key: "teletext", label: "Teletext" }, { key: "algoboy", label: "Algo Boy" }, { key: "archBtw", label: "Arch BTW" },
  { key: "androidstudio", label: "Android Studio" }, { key: "CutiePi", label: "Cutie Pi" },
  { key: "sonicPink", label: "Sonic Pink" }, { key: "fruitDaw", label: "Fruit DAW" },
  { key: "greenText", label: "Green Text" }, { key: "redText", label: "Red Text" }, { key: "xcodeLight", label: "Xcode Light" },
];

// Applies a setting live AND persists to StrudelMirror's atom — upstream's
// `changeSetting` only touches the compartment, not the atom, so without
// this mirror the panel's toggles would reset on every page load.
export function applyPanelSetting(editor, key, value) {
  if (
    (key === "isAutoCompletionEnabled" || key === "isTooltipEnabled") &&
    value === false
  ) {
    console.warn(
      `[strasbeat/settings] refusing to disable required-on setting "${key}"`,
    );
    return;
  }
  try {
    editor.changeSetting(key, value);
  } catch (err) {
    console.warn(`[strasbeat/settings] changeSetting("${key}") failed:`, err);
    return;
  }
  try {
    const current = codemirrorSettings.get?.() ?? {};
    codemirrorSettings.set({ ...current, [key]: value });
  } catch (err) {
    console.warn(
      `[strasbeat/settings] persisting "${key}" to atom failed:`,
      err,
    );
  }
}
