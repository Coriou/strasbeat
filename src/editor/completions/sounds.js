/**
 * Sound name completion + combined Strudel autocomplete.
 *
 * Strudel's built-in autocomplete has a soundHandler, but its soundMap
 * import is commented out (let soundMap = undefined), so it always returns
 * an empty completion list for s() / sound() contexts. We can't import
 * `strudelAutocomplete` from `@strudel/codemirror` either — it's not a
 * public export and its source has a relative `../../doc.json` import
 * that doesn't resolve from node_modules. So we build our own chain.
 *
 * Handlers, in order:
 *   1. miniNotationCompletion — tree-based, fires inside s/sound/note/n strings
 *   2. soundHandler            — s("…) / sound("…) — names from live soundMap
 *   3. bankHandler             — bank("…)
 *   4. chordHandler            — chord("…) — pitch names + iReal symbols
 *   5. scaleHandler            — scale("…) — disabled upstream, structure preserved
 *   6. modeHandler             — mode("…) — voicing modes + pitch anchors
 *   7. fallbackHandler         — bare identifier — Strudel function names with
 *                                rich `info` panel from strudel-docs.json
 *
 * Call `installSoundCompletion(view, functionNames)` after
 * `editor.updateSettings()` has been called.
 */
import { autocompletion } from "@codemirror/autocomplete";
import { compartments } from "@strudel/codemirror";
import { soundMap } from "@strudel/webaudio";
import { complex } from "@strudel/tonal";
import { miniNotationCompletion } from "./mini-notation.js";
import docs from "../strudel-docs.json";

// ─── Completion info panel renderer ──────────────────────────────────────
// Returns a DOM element using the class names already styled in
// src/styles/autocomplete.css. Called lazily by CodeMirror when a
// completion is selected (Completion.info: () => Node | null).

/**
 * Build the rich docs panel for a function completion.
 * @param {string} label
 * @param {{signature?: string, doc?: string, params?: Array<{name:string,type?:string,doc?:string}>, examples?: string[]}} entry
 * @returns {HTMLElement}
 */
function renderCompletionInfo(label, entry) {
  const container = document.createElement("div");
  container.className = "autocomplete-info-container";

  const tooltip = document.createElement("div");
  tooltip.className = "autocomplete-info-tooltip";
  container.appendChild(tooltip);

  // Function name (use the signature head when available, fall back to label)
  const name = document.createElement("h3");
  name.className = "autocomplete-info-function-name";
  name.textContent = entry.signature || `${label}()`;
  tooltip.appendChild(name);

  // Description
  if (entry.doc) {
    const desc = document.createElement("div");
    desc.className = "autocomplete-info-function-description";
    desc.textContent = entry.doc;
    tooltip.appendChild(desc);
  }

  // Params
  if (entry.params && entry.params.length > 0) {
    const params = document.createElement("div");
    params.className = "autocomplete-info-params-section";
    for (const p of entry.params) {
      const item = document.createElement("div");
      item.className = "autocomplete-info-param-item";

      const pname = document.createElement("span");
      pname.className = "autocomplete-info-param-name";
      pname.textContent = p.name;
      item.appendChild(pname);

      if (p.type) {
        const ptype = document.createElement("span");
        ptype.className = "autocomplete-info-param-type";
        ptype.textContent = p.type;
        item.appendChild(ptype);
      }

      if (p.doc) {
        const pdesc = document.createElement("div");
        pdesc.className = "autocomplete-info-param-desc";
        pdesc.textContent = p.doc;
        item.appendChild(pdesc);
      }

      params.appendChild(item);
    }
    tooltip.appendChild(params);
  }

  // Examples
  if (entry.examples && entry.examples.length > 0) {
    const ex = document.createElement("div");
    ex.className = "autocomplete-info-examples-section";
    for (const code of entry.examples) {
      const pre = document.createElement("pre");
      pre.className = "autocomplete-info-example-code";
      pre.textContent = code;
      ex.appendChild(pre);
    }
    tooltip.appendChild(ex);
  }

  return container;
}

// ─── Sound completion handler ────────────────────────────────────────────
const SOUND_NO_QUOTES = /(s|sound)\(\s*$/;
const SOUND_WITH_QUOTES = /(s|sound)\(\s*['"][^'"]*$/;
const SOUND_FRAGMENT = /(?:[\s[{(<])([\w]*)$/;

let cachedKeys = [];
let cachedSnapshot = null;

function getSoundKeys() {
  const current = soundMap.get();
  if (current !== cachedSnapshot) {
    cachedSnapshot = current;
    cachedKeys = Object.keys(current).sort();
  }
  return cachedKeys;
}

function soundHandler(context) {
  const noQuotes = context.matchBefore(SOUND_NO_QUOTES);
  if (noQuotes) return { from: noQuotes.to, options: [] };

  const soundCtx = context.matchBefore(SOUND_WITH_QUOTES);
  if (!soundCtx) return null;

  const text = soundCtx.text;
  const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
  if (quoteIdx === -1) return null;

  const inside = text.slice(quoteIdx + 1);
  const fragMatch = inside.match(SOUND_FRAGMENT);
  const fragment = fragMatch ? fragMatch[1] : inside;

  const keys = getSoundKeys();
  const lowerFrag = fragment.toLowerCase();
  const options = [];
  for (const name of keys) {
    const lower = name.toLowerCase();
    if (lower.startsWith(lowerFrag)) {
      // Prefix match — highest priority
      const bank =
        name.indexOf("_") > 0 ? name.slice(0, name.indexOf("_")) : "";
      options.push({ label: name, type: "sound", boost: 2, detail: bank });
    } else if (lower.includes(lowerFrag)) {
      const bank =
        name.indexOf("_") > 0 ? name.slice(0, name.indexOf("_")) : "";
      options.push({ label: name, type: "sound", boost: 0, detail: bank });
    }
  }

  return { from: soundCtx.to - fragment.length, options, filter: false };
}

// ─── Bank completion handler ─────────────────────────────────────────────
const BANK_NO_QUOTES = /bank\(\s*$/;
const BANK_WITH_QUOTES = /bank\(\s*['"][^'"]*$/;

function bankHandler(context) {
  const noQuotes = context.matchBefore(BANK_NO_QUOTES);
  if (noQuotes) return { from: noQuotes.to, options: [] };

  const bankCtx = context.matchBefore(BANK_WITH_QUOTES);
  if (!bankCtx) return null;

  const text = bankCtx.text;
  const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
  if (quoteIdx === -1) return null;

  const fragment = text.slice(quoteIdx + 1);
  const soundDict = soundMap.get();
  const banks = new Set();
  for (const key of Object.keys(soundDict)) {
    const idx = key.indexOf("_");
    if (idx > 0) banks.add(key.slice(0, idx));
  }
  const sorted = Array.from(banks).sort();
  const filtered = sorted.filter((b) => b.startsWith(fragment));
  const options = filtered.map((name) => ({
    label: name,
    type: "namespace",
    detail: "bank",
  }));

  return { from: bankCtx.to - fragment.length, options };
}

// ─── Pitch / chord / mode completion data ────────────────────────────────
// 21 entries: natural + sharp + flat for each pitch class.
const pitchNames = [
  "C",
  "C#",
  "Db",
  "D",
  "D#",
  "Eb",
  "E",
  "E#",
  "Fb",
  "F",
  "F#",
  "Gb",
  "G",
  "G#",
  "Ab",
  "A",
  "A#",
  "Bb",
  "B",
  "B#",
  "Cb",
];

// Valid chord symbols from the iReal complex dictionary, plus '' for major
// triads. Mirrors upstream autocomplete.mjs lines 113–128.
const chordSymbols = ["", ...Object.keys(complex)].sort();
const chordSymbolCompletions = chordSymbols.map((symbol) => {
  if (symbol === "") {
    return { label: "major", apply: "", type: "type", detail: "chord quality" };
  }
  return {
    label: symbol,
    apply: symbol,
    type: "type",
    detail: "chord quality",
  };
});

// Valid mode values for `voicing()` — hardcoded upstream.
const modeCompletions = [
  { label: "below", type: "keyword", detail: "voice below anchor" },
  { label: "above", type: "keyword", detail: "voice above anchor" },
  { label: "duck", type: "keyword", detail: "avoid root note" },
  { label: "root", type: "keyword", detail: "root position" },
];

// TODO: Strudel's scale completions are disabled upstream because the Tonal
// import was commented out (autocomplete.mjs:5). Restore once a working
// scale name source is available — could be `@tonaljs/tonal`'s `Scale.names()`
// or a precomputed list at build time.
const scaleCompletions = [];

// ─── Chord handler ───────────────────────────────────────────────────────
const CHORD_NO_QUOTES = /chord\(\s*$/;
const CHORD_WITH_QUOTES = /chord\(\s*['"][^'"]*$/;
const CHORD_FRAGMENT = /(?:[\s[{(<])([\w#b+^:-]*)$/;

function chordHandler(context) {
  const noQuotes = context.matchBefore(CHORD_NO_QUOTES);
  if (noQuotes) return { from: noQuotes.to, options: [] };

  const chordCtx = context.matchBefore(CHORD_WITH_QUOTES);
  if (!chordCtx) return null;

  const text = chordCtx.text;
  const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
  if (quoteIdx === -1) return null;
  const inside = text.slice(quoteIdx + 1);

  // Same fragment matching as sound — handles "<G Am>" expressions where
  // we want to complete the token after the last separator.
  const fragMatch = inside.match(CHORD_FRAGMENT);
  const fragment = fragMatch ? fragMatch[1] : inside;

  // Does the fragment start with a pitch name? Walk longest-first so "C#"
  // matches before "C".
  let rootMatch = null;
  let symbolFragment = fragment;
  for (const pitch of pitchNames) {
    if (fragment.toLowerCase().startsWith(pitch.toLowerCase())) {
      if (!rootMatch || pitch.length > rootMatch.length) {
        rootMatch = pitch;
        symbolFragment = fragment.slice(pitch.length);
      }
    }
  }

  if (rootMatch) {
    // Have a root → complete chord symbols. The replacement range is just
    // the symbol portion so the root pitch is preserved.
    const filtered = chordSymbolCompletions.filter((s) =>
      s.label.toLowerCase().startsWith(symbolFragment.toLowerCase()),
    );
    return { from: chordCtx.to - symbolFragment.length, options: filtered };
  }

  // No root yet → complete with pitch names.
  const filteredPitches = pitchNames.filter((p) =>
    p.toLowerCase().startsWith(fragment.toLowerCase()),
  );
  const options = filteredPitches.map((p) => ({ label: p, type: "pitch" }));
  return { from: chordCtx.to - fragment.length, options };
}

// ─── Scale handler ───────────────────────────────────────────────────────
// Structure mirrors upstream so we're ready when scaleCompletions gets a
// real source. Currently emits pitch names before the colon and an empty
// list after the colon (where scale names would go).
const SCALE_NO_QUOTES = /scale\(\s*$/;
const SCALE_AFTER_COLON = /scale\(\s*['"][^'"]*:[^'"]*$/;
const SCALE_PRE_COLON = /scale\(\s*['"][^'"]*$/;
const SCALE_PITCH_MATCH = /([A-Ga-g][#b]*)?$/;
const SCALE_SPACES_TO_COLON = /\s+/g;

function scaleHandler(context) {
  const noQuotes = context.matchBefore(SCALE_NO_QUOTES);
  if (noQuotes) return { from: noQuotes.to, options: [] };

  // After-colon: scale name. Disabled until scaleCompletions has data.
  const afterColon = context.matchBefore(SCALE_AFTER_COLON);
  if (afterColon) {
    const text = afterColon.text;
    const colonIdx = text.lastIndexOf(":");
    if (colonIdx !== -1) {
      const fragment = text.slice(colonIdx + 1);
      const filtered = scaleCompletions.filter((s) =>
        s.label.startsWith(fragment),
      );
      const options = filtered.map((s) => ({
        ...s,
        apply: s.label.replace(SCALE_SPACES_TO_COLON, ":"),
      }));
      return { from: afterColon.from + colonIdx + 1, options };
    }
  }

  // Pre-colon: pitch root.
  const preColon = context.matchBefore(SCALE_PRE_COLON);
  if (preColon && !preColon.text.includes(":")) {
    if (context.explicit) {
      const match = preColon.text.match(SCALE_PITCH_MATCH);
      const fragment = match ? match[0] : "";
      const filtered = pitchNames.filter((p) =>
        p.toLowerCase().startsWith(fragment.toLowerCase()),
      );
      const options = filtered.map((p) => ({ label: p, type: "pitch" }));
      return { from: preColon.to - fragment.length, options };
    }
    return { from: preColon.to, options: [] };
  }

  return null;
}

// ─── Mode handler ────────────────────────────────────────────────────────
const MODE_NO_QUOTES = /mode\(\s*$/;
const MODE_AFTER_COLON = /mode\(\s*['"][^'"]*:[^'"]*$/;
const MODE_PRE_COLON = /mode\(\s*['"][^'"]*$/;
const MODE_FRAGMENT = /(?:[\s[{(<])([\w:]*)$/;

function modeHandler(context) {
  const noQuotes = context.matchBefore(MODE_NO_QUOTES);
  if (noQuotes) return { from: noQuotes.to, options: [] };

  // After-colon: pitch anchor (e.g. "below:C4").
  const afterColon = context.matchBefore(MODE_AFTER_COLON);
  if (afterColon) {
    const text = afterColon.text;
    const colonIdx = text.lastIndexOf(":");
    if (colonIdx !== -1) {
      const fragment = text.slice(colonIdx + 1);
      const filtered = pitchNames.filter((p) =>
        p.toLowerCase().startsWith(fragment.toLowerCase()),
      );
      const options = filtered.map((p) => ({ label: p, type: "pitch" }));
      return { from: afterColon.from + colonIdx + 1, options };
    }
  }

  // Pre-colon: voicing mode keyword.
  const modeCtx = context.matchBefore(MODE_PRE_COLON);
  if (!modeCtx) return null;

  const text = modeCtx.text;
  const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
  if (quoteIdx === -1) return null;
  const inside = text.slice(quoteIdx + 1);
  const fragMatch = inside.match(MODE_FRAGMENT);
  const fragment = fragMatch ? fragMatch[1] : inside;
  const filtered = modeCompletions.filter((m) => m.label.startsWith(fragment));
  return { from: modeCtx.to - fragment.length, options: filtered };
}

// ─── Function name fallback handler ──────────────────────────────────────
const WORD = /\w*/;
let fnCompletions = [];

function fallbackHandler(context) {
  const word = context.matchBefore(WORD);
  if (word && word.from === word.to && !context.explicit) return null;
  if (!word) return null;
  return { from: word.from, options: fnCompletions };
}

// ─── Combined handler ────────────────────────────────────────────────────
// Order matters:
//   - mini-notation first (tree-based, only fires inside known string args)
//   - then context-specific regex handlers (sound/bank/chord/scale/mode)
//   - finally the function-name fallback (must be last — matches any word)
const handlers = [
  miniNotationCompletion,
  soundHandler,
  bankHandler,
  chordHandler,
  scaleHandler,
  modeHandler,
  fallbackHandler,
];

function combinedAutocomplete(context) {
  for (const handler of handlers) {
    const result = handler(context);
    if (result) return result;
  }
  return null;
}

// ─── Install ─────────────────────────────────────────────────────────────

/**
 * Reconfigure Strudel's autocompletion compartment with our combined
 * handler that fixes the broken soundMap + adds function name completions
 * with rich docs panels.
 *
 * Function completions are built eagerly here from the union of:
 *   - the passed `functionNames` (live exports from the Strudel package)
 *   - the keys of strudel-docs.json (so docs-only synonyms still surface)
 *
 * Names with a docs entry get an `info` callback that renders the rich
 * panel; names without docs get a bare completion (no panel).
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {string[]} functionNames - Strudel function/export names
 */
export function installSoundCompletion(view, functionNames) {
  const seen = new Set();
  const out = [];

  const consider = (name) => {
    if (seen.has(name)) return;
    if (!/^[a-z]/.test(name) || name.length < 2) return;
    seen.add(name);
    const entry = docs[name];
    if (entry) {
      // Extract a short summary: first sentence of the doc, max 60 chars
      let detail = "";
      if (entry.doc) {
        const first = entry.doc.split(/[.!?]\s/)[0];
        detail = first.length > 60 ? first.slice(0, 57) + "..." : first;
      }
      out.push({
        label: name,
        type: "function",
        detail,
        boost: 1,
        info: () => renderCompletionInfo(name, entry),
      });
    } else {
      out.push({ label: name, type: "function", boost: -1 });
    }
  };

  for (const name of functionNames) consider(name);
  for (const name of Object.keys(docs)) consider(name);

  fnCompletions = out;

  view.dispatch({
    effects: compartments.isAutoCompletionEnabled.reconfigure([
      autocompletion({
        override: [combinedAutocomplete],
        closeOnBlur: false,
      }),
    ]),
  });
}
