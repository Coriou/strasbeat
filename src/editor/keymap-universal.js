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
