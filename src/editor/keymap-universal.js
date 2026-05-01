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
 * Read the currently-selected completion's label + type plus an optional
 * `audition` payload that providers stash on the option as `_audition`.
 * Returns null if the popup is closed or nothing is selected. Used by
 * audition handlers.
 *
 * The `audition` field carries everything the audition path needs to
 * fire the right preview: the bare/resolved sound name, the bank prefix
 * (so superdough rewrites `${bank}_${name}` correctly), and a sample
 * variant index `n`. CM6 preserves arbitrary extra fields on Completion
 * options, so we just read it back here.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {{
 *   label: string,
 *   type: string | undefined,
 *   audition: { name: string, bank?: string, n?: number } | null,
 * } | null}
 */
export function readSelectedCompletion(state) {
  if (completionStatus(state) !== "active") return null;
  const idx = selectedCompletionIndex(state);
  if (idx == null || idx < 0) return null;
  const all = currentCompletions(state);
  const c = all[idx];
  if (!c) return null;
  return {
    label: c.label,
    type: c.type,
    audition: c._audition ?? null,
  };
}
