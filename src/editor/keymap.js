// VSCode-style key bindings the Strudel default editor doesn't expose,
// plus a `Mod-Enter` binding that makes Cmd+Enter actually evaluate on
// macOS.
//
// Why this is a factory and not a static export: the `Mod-Enter` handler
// needs to call back into the editor instance to trigger evaluate(). The
// editor exists *before* we wire keymaps (StrudelMirror builds its own
// EditorView at construction time and we append our extensions afterwards
// via StateEffect.appendConfig), so we just close over `onEvaluate` here
// instead of looking it up through the CodeMirror state.
//
// Why Mod-Enter is needed in the first place: Strudel upstream only binds
// `Ctrl-Enter` and `Alt-Enter` (see node_modules/@strudel/codemirror/
// codemirror.mjs in the Prec.highest block). On macOS, Ctrl-Enter is
// literally Control+Enter — *not* Cmd+Enter. CM6 uses `Mod-` for the
// platform-aware modifier (Cmd on macOS, Ctrl elsewhere). Without a
// Mod-Enter binding, Cmd+Enter on macOS falls through to the browser,
// which inserts a newline instead of evaluating the pattern. Adding
// Mod-Enter here gives macOS users the muscle-memory shortcut they
// expect from every modern editor; Ctrl-Enter still works on every OS
// because Strudel's binding sits at Prec.highest and we don't touch it.
//
// Order/precedence: this keymap is appended *after* the existing Strudel
// keymap via StateEffect.appendConfig (see main.js). CM6 keymaps are
// last-wins for the same key, so any conflict resolves in our favour. The
// Strudel `Ctrl-Enter` / `Alt-Enter` / `Ctrl-.` / `Alt-.` bindings are
// wrapped in Prec.highest() upstream, so we can't override them by
// accident — and we don't bind any of those keys here regardless.

import { keymap } from "@codemirror/view";
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
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";

/**
 * Build the VSCode-style keymap extension.
 *
 * @param {object} options
 * @param {() => void} options.onEvaluate
 *   Called when the user presses Mod-Enter (Cmd+Enter on macOS, Ctrl+Enter
 *   elsewhere). Should be `() => editor.evaluate()` for the StrudelMirror
 *   instance.
 */
export function createVscodeKeymap({ onEvaluate }) {
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

    // Multi-cursor / selection
    { key: "Mod-d", run: selectNextOccurrence },
    // VSCode's Ctrl/Cmd+Shift+L is "select all occurrences of current
    // selection" — CM6's selectSelectionMatches is the equivalent.
    { key: "Mod-Shift-l", run: selectSelectionMatches },

    // Line manipulation
    { key: "Mod-Shift-k", run: deleteLine },
    { key: "Alt-ArrowUp", run: moveLineUp },
    { key: "Alt-ArrowDown", run: moveLineDown },

    // Comments
    { key: "Mod-/", run: toggleComment },

    // Select line (Mod-L), matching VSCode's Cmd+L behavior.
    { key: "Mod-l", run: selectLine, preventDefault: true },

    // Indentation
    { key: "Mod-]", run: indentMore },
    { key: "Mod-[", run: indentLess },
  ]);
}
