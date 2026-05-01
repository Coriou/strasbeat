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
import { syntaxTree } from "@codemirror/language";
import { soundMap } from "@strudel/webaudio";
import { tokenAtOffset } from "./mini-notation-tokens.js";
import { findBankInScope } from "./completions/bank-detect.js";

export function createUniversalKeymap({ onEvaluate, onAuditionSelected, onRevealSound }) {
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
    // Cmd+Shift+B — reveal the sound under cursor in the right-rail
    // browser. Resolves the cursor's token through three paths:
    //   1. Inside `s("…")` / `sound("…")` — mini-notation tokenizer +
    //      bank-context lookup, so `bd` under a `bank("RolandTR909")`
    //      chain resolves to `RolandTR909_bd`.
    //   2. Bare identifier whose text matches a registered sound name.
    //   3. No resolvable token — the keybinding still consumes the event
    //      (returns true) so the platform's own Cmd+Shift+B doesn't fire.
    // See spec design/work/22-intellisense-v2.md §3.C.
    {
      key: "Mod-Shift-b",
      preventDefault: true,
      run: (view) => {
        if (!onRevealSound) return false;
        const name = resolveSoundUnderCursor(view.state);
        onRevealSound(name); // pass null when not resolvable — caller decides UX
        return true;
      },
    },
  ]);
}

/**
 * Resolve the sound name at the cursor — used by the Cmd+Shift+B reveal
 * binding above. Returns the resolved (bank-prefixed if applicable) name
 * or null. Mirrors the mini-notation provider's resolution logic so the
 * popup and the reveal action agree on what counts as a "sound".
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {string | null}
 */
function resolveSoundUnderCursor(state) {
  const pos = state.selection.main.head;
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);

  // Inside a String? Use the mini-notation tokenizer to find the token
  // and apply bank context if any.
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name === "String" || cur.name === "TemplateString") {
      const raw = state.sliceDoc(cur.from, cur.to);
      if (!(raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`"))) continue;
      const contentFrom = cur.from + 1;
      const contentTo = cur.to - 1;
      if (pos < contentFrom || pos > contentTo) continue;
      const content = state.sliceDoc(contentFrom, contentTo);
      const tok = tokenAtOffset(content, pos - contentFrom);
      if (!tok) return null;
      const bank = findBankInScope(state, cur);
      const all = soundMap.get();
      const candidate = bank ? `${bank}_${tok.token}` : tok.token;
      if (all[candidate.toLowerCase()]) return candidate;
      if (all[tok.token.toLowerCase()]) return tok.token;
      return null;
    }
  }

  // Bare identifier check — covers `s` and other short names that might
  // be both a function and a registered sound (rare but possible).
  if (node.name === "VariableName" || node.name === "Identifier") {
    const text = state.sliceDoc(node.from, node.to);
    if (soundMap.get()[text.toLowerCase()]) return text;
  }
  return null;
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
