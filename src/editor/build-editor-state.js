// The per-tab EditorState mechanism — the load-bearing piece for lossless tab
// switching. See design/work/26-pattern-tabs.md §"The EditorState swap".
//
// MECHANISM:
//   - Already-opened tab → restore its real snapshotted EditorState (carries
//     full live config + that tab's own history/cursor/scroll). No rebuild.
//   - Fresh tab → freshTabState(): derive from a CLEAN BASE state (captured at
//     boot: full config, EMPTY history), replacing the doc WITHOUT recording it
//     in history, and reconfigure the runtime compartments to their current live
//     values. This yields undoDepth 0 — so the first Cmd+Z in a fresh tab does
//     NOT revert into another tab's content (acceptance #2) — while still
//     inheriting the live keymap profile / theme / settings (acceptance #3).
//
// Why not derive from the outgoing live state: a CM6 transaction APPENDS to the
// history field, it never resets it, so the new tab would carry the previous
// tab's undo stack + a poison step → cross-tab undo bleed. Deriving from a
// clean (empty-history) base + addToHistory:false avoids that. (A from-scratch
// EditorState.create isn't an option: StrudelMirror's base extensions —
// basicSetup/history/sliders/etc. — aren't importable as values.)

import { Transaction } from "@codemirror/state";
import { compartments } from "@strudel/codemirror";

// Read the live value of every runtime-mutated compartment from `liveState`,
// returned as [compartment, value] pairs ready to reconfigure onto a fresh tab.
// The strasbeat overlay compartment is INJECTED (not imported) so this module
// stays loadable under bare `node --test` — importing editor-setup.js would pull
// src/editor/strudel-docs.json (a JSON import bare node rejects).
export function liveCompartmentValues(liveState, overlayCompartment = null) {
  const pairs = [];
  for (const key of Object.keys(compartments)) {
    pairs.push([compartments[key], compartments[key].get(liveState)]);
  }
  if (overlayCompartment) {
    const v = overlayCompartment.get(liveState);
    if (v !== undefined) pairs.push([overlayCompartment, v]);
  }
  return pairs;
}

// Build a FRESH tab state: the new doc, the clean base's full config, the given
// live compartment values, and EMPTY undo history (undoDepth 0 — verified).
//
// @param {EditorState} cleanBase   boot state: full editor config, empty history
// @param {string} doc              the new tab's document text
// @param {Array<[Compartment, Extension]>} compartmentValues  live values to reconfigure
// @returns {EditorState}
export function freshTabState(cleanBase, doc, compartmentValues = []) {
  return cleanBase.update({
    changes: { from: 0, to: cleanBase.doc.length, insert: doc },
    selection: { anchor: 0 },
    effects: compartmentValues.map(([comp, val]) => comp.reconfigure(val)),
    annotations: [Transaction.addToHistory.of(false)],
  }).state;
}
