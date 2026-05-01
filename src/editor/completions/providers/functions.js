// src/editor/completions/providers/functions.js
//
// Bare-identifier completion: function names from the union of live
// Strudel exports + docs.json keys, scored against the cursor's word
// fragment. Snippets for known function templates land in Phase 2.

import { snippet } from "@codemirror/autocomplete";
import docs from "../../strudel-docs.json";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";
import { renderCompletionInfo } from "../info.js";

const CATEGORY_BASE = 0.0;
const BUFFER_BOOST = 0.4;
const RECENCY_BOOST_MAX = 0.3;
const MAX_RESULTS = 60;

const SNIPPET_TEMPLATES = {
  s: 's("${1}")',
  sound: 'sound("${1}")',
  note: 'note("${1}")',
  n: 'n("${1}")',
  bank: 'bank("${1}")',
  chord: 'chord("${1}")',
  stack: "stack(${1})",
  setcpm: "setcpm(${1})",
  cat: "cat(${1})",
};

let functionList = [];

/**
 * Build the function list once at install time. Names from `liveExports`
 * (the union of all @strudel/* package exports) seed the list; names that
 * also have a docs entry get the rich info panel.
 *
 * @param {string[]} liveExports
 */
export function buildFunctionList(liveExports) {
  const seen = new Set();
  const out = [];
  const consider = (name) => {
    if (seen.has(name)) return;
    if (!/^[a-z]/.test(name) || name.length < 2) return;
    seen.add(name);
    const entry = docs[name];
    if (entry) {
      out.push({ label: name, type: "function", entry });
    } else {
      out.push({ label: name, type: "function", entry: null });
    }
  };
  for (const name of liveExports) consider(name);
  for (const name of Object.keys(docs)) consider(name);
  functionList = out;
}

export function functionsProvider({ recency }) {
  return function provider(context) {
    const word = context.matchBefore(/\w*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    const fragment = word.text;
    const buffer = getBufferTokens().get("function");
    const ranked = [];
    for (const fn of functionList) {
      const m = score(fragment, fn.label);
      if (!m) continue;
      const finalScore =
        m.score +
        (buffer.has(fn.label) ? BUFFER_BOOST : 0) +
        recency.score("function", fn.label) +
        CATEGORY_BASE;
      ranked.push({ fn, finalScore });
    }
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    const top = ranked.slice(0, MAX_RESULTS);

    return {
      from: word.from,
      to: word.to,
      filter: false,
      options: top.map(({ fn, finalScore }) => completionFor(fn, finalScore)),
    };
  };
}

function completionFor(fn, finalScore) {
  const opt = {
    label: fn.label,
    type: "function",
    boost: finalScore,
  };
  const tpl = SNIPPET_TEMPLATES[fn.label];
  if (tpl) opt.apply = snippet(tpl);
  if (fn.entry) {
    if (fn.entry.doc) {
      const first = fn.entry.doc.split(/[.!?]\s/)[0];
      opt.detail = first.length > 60 ? first.slice(0, 57) + "..." : first;
    }
    opt.info = () => renderCompletionInfo(fn.label, fn.entry);
  }
  return opt;
}
