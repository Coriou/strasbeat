// Layer-2 always-on CodeMirror keymap. Bindings here are loaded
// unconditionally regardless of which profile (Strudel / VSCode / Vim /
// Emacs / Helix) the user has selected — they are app-shell shortcuts
// that don't conflict with strudel.cc muscle memory because strudel.cc
// doesn't have them.
//
// See design/work/21-keybindings.md §"Mental model" for the layered model
// and design/work/22-intellisense-v2.md §"Editor ergonomics" for the
// completion-related bindings.

import { keymap } from "@codemirror/view";
import {
  acceptCompletion,
  completionStatus,
  hasNextSnippetField,
  moveCompletionSelection,
  currentCompletions,
  selectedCompletionIndex,
} from "@codemirror/autocomplete";

export function createUniversalKeymap({ onEvaluate, onAuditionSelected }) {
  return keymap.of([
    {
      key: "Mod-Enter",
      preventDefault: true,
      run: () => {
        onEvaluate();
        return true;
      },
    },
    {
      key: "Tab",
      run: (view) => {
        if (completionStatus(view.state) !== "active") return false;
        if (hasNextSnippetField(view.state)) return false;
        return acceptCompletion(view);
      },
    },
    {
      key: "Alt-ArrowDown",
      run: (view) => {
        if (completionStatus(view.state) !== "active") return false;
        moveCompletionSelection(true)(view);
        if (onAuditionSelected) onAuditionSelected(view);
        return true;
      },
    },
    {
      key: "Alt-ArrowUp",
      run: (view) => {
        if (completionStatus(view.state) !== "active") return false;
        moveCompletionSelection(false)(view);
        if (onAuditionSelected) onAuditionSelected(view);
        return true;
      },
    },
  ]);
}

/**
 * Read the currently-selected completion's label + type. Returns null if
 * the popup is closed or nothing is selected. Used by audition handlers.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {{ label: string, type: string | undefined } | null}
 */
export function readSelectedCompletion(state) {
  if (completionStatus(state) !== "active") return null;
  const idx = selectedCompletionIndex(state);
  if (idx == null || idx < 0) return null;
  const all = currentCompletions(state);
  const c = all[idx];
  if (!c) return null;
  return { label: c.label, type: c.type };
}
