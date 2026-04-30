// VSCode-style key bindings the Strudel default editor doesn't expose.
//
// `Mod-Enter` (Cmd+Enter on macOS) lives in keymap-universal.js instead
// of here so it stays active regardless of which profile the user selects.
//
// Why this is a factory and not a static export: handlers need to call
// back into the editor instance (e.g. onEvaluate for mute/solo). The
// editor exists *before* we wire keymaps (StrudelMirror builds its own
// EditorView at construction time and we append our extensions afterwards
// via StateEffect.appendConfig), so we just close over `onEvaluate` here
// instead of looking it up through the CodeMirror state.
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
import {
  labelAtLine,
  parseLabels,
  toggleMute,
  toggleSolo,
} from "./track-labels.js";
import { computeNewSelection } from "./format.js";

// Exported so command-palette.js can call mute/solo without simulating
// keypresses. The view and onEvaluate are passed by the caller.
export function toggleLabelAtCursor(view, onEvaluate, toggleLabel, userEvent) {
  const code = view.state.doc.toString();
  const oldSelection = view.state.selection;
  const oldDoc = view.state.doc;
  const cursorLine = view.state.doc.lineAt(
    view.state.selection.main.head,
  ).number;
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

/**
 * Build the VSCode-style keymap extension.
 *
 * `Mod-Enter` is not included here — it lives in createUniversalKeymap so
 * it stays active regardless of which profile is selected.
 *
 * @param {object} options
 * @param {() => void} options.onEvaluate
 *   Called when the user triggers a mute/solo toggle. Should be
 *   `() => editor.evaluate()` for the StrudelMirror instance.
 */
export function createVscodeKeymap({ onEvaluate }) {
  return keymap.of([
    {
      key: "Mod-m",
      preventDefault: true,
      run: (view) =>
        toggleLabelAtCursor(view, onEvaluate, toggleMute, "input.track-mute"),
    },
    {
      key: "Mod-Shift-s",
      preventDefault: true,
      run: (view) =>
        toggleLabelAtCursor(view, onEvaluate, toggleSolo, "input.track-solo"),
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

    // Comments — Mod-/ is the universal binding (QWERTY). On AZERTY macOS,
    // "/" lives on Shift+: so Cmd+/ becomes Cmd+Shift+: → Cmd+?, which
    // macOS intercepts as the Help menu shortcut. Mod-: gives AZERTY
    // users an unshifted alternative that actually reaches CodeMirror.
    { key: "Mod-/", run: toggleComment },
    { key: "Mod-:", run: toggleComment },

    // Select line (Mod-L), matching VSCode's Cmd+L behavior.
    { key: "Mod-l", run: selectLine, preventDefault: true },

    // Indentation
    { key: "Mod-]", run: indentMore },
    { key: "Mod-[", run: indentLess },
  ]);
}
