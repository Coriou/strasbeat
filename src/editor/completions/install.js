// src/editor/completions/install.js
//
// Wires the new completion stack into the live editor:
//
//   1. Builds the function name list from live exports + docs.
//   2. Instantiates a shared recency table (one per editor).
//   3. Composes all providers into a single CompletionSource that runs
//      them in order and returns the first non-null result.
//   4. Reconfigures Strudel's `compartments.isAutoCompletionEnabled`
//      compartment with our overrides + the buffer-context plugin.
//   5. Wraps the autocompletion config so accepted completions bump
//      the recency table.
//
// The combined-source ordering matches the spec's category-precedence:
// mini-notation first (string-context), then explicit-quoted-arg
// providers (sound/bank/chord/mode), then bare-identifier function
// fallback. Each provider returns null when its context predicate
// doesn't match, and the chain falls through.

import { autocompletion, pickedCompletion } from "@codemirror/autocomplete";
import { compartments } from "@strudel/codemirror";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createRecency, bufferContextPlugin } from "./context.js";
import { miniNotationProvider } from "./providers/mini-notation.js";
import { soundsProvider } from "./providers/sounds.js";
import { bankProvider } from "./providers/bank.js";
import { chordProvider } from "./providers/chord.js";
import { modeProvider } from "./providers/mode.js";
import { functionsProvider, buildFunctionList } from "./providers/functions.js";

let installedRecency = null;

/**
 * @param {import("@codemirror/view").EditorView} view
 * @param {string[]} liveExports
 * @returns {{ recency: ReturnType<typeof createRecency> }}
 */
export function installCompletions(view, liveExports) {
  if (installedRecency) {
    console.warn("[strasbeat/completions] installCompletions called twice; ignoring");
    return { recency: installedRecency };
  }
  buildFunctionList(liveExports);
  const recency = createRecency();
  installedRecency = recency;

  const providers = [
    miniNotationProvider({ recency }),
    soundsProvider({ recency }),
    bankProvider({ recency }),
    chordProvider({ recency }),
    modeProvider({ recency }),
    functionsProvider({ recency }),
  ];

  const combined = (context) => {
    for (const p of providers) {
      const result = p(context);
      // Truthy result halts the chain (even if options is empty —
      // providers reserve a context that way, e.g. inside chord("…)).
      if (result) return result;
    }
    return null;
  };

  // Listen for cross-tab recency updates.
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === "strasbeat:completions-recency") recency.syncFromStorage();
    });
  }

  // The recency-bump update listener: every accepted completion records
  // its label + category in the recency table.
  const recencyBumpListener = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      const picked = tr.annotation(pickedCompletion);
      if (!picked) continue;
      const cat = mapCmTypeToCategory(picked.type);
      if (cat) recency.bump(cat, picked.label);
    }
  });

  view.dispatch({
    effects: [
      compartments.isAutoCompletionEnabled.reconfigure([
        autocompletion({
          override: [combined],
          closeOnBlur: false,
          activateOnTyping: true,
          activateOnTypingDelay: 80,
        }),
      ]),
      StateEffect.appendConfig.of([bufferContextPlugin, recencyBumpListener]),
    ],
  });

  return { recency };
}

/** Exposes the live recency for the debug helpers (window.strasbeat.completions). */
export function getInstalledRecency() {
  return installedRecency;
}

function mapCmTypeToCategory(cmType) {
  switch (cmType) {
    case "sound":     return "sound";
    case "namespace": return "bank";
    case "type":      return "chord";   // chord-symbol completions are type:"type"
    case "pitch":     return "chord";   // pitch-name completions also bump chord
    case "keyword":   return "mode";
    case "function":  return "function";
    case "constant":  return "note";
    default:          return null;
  }
}
