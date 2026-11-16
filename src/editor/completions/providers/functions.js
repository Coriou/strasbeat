// src/editor/completions/providers/functions.js
//
// Bare-identifier completion: function names from the union of live
// Strudel exports + docs.json keys, scored against the cursor's word
// fragment. Snippets for known function templates land in Phase 2.

import { snippet } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { getDocs } from "../../docs-store.js";
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

// Syntax nodes whose contents are prose or data, never an identifier being
// typed. This provider is the chain's fallback for every cursor position, so
// without this gate it would pop up over comments and plain strings — and
// Enter (meant as a newline) would replace the word with a function name.
const NON_CODE_NODES = new Set([
  "LineComment",
  "BlockComment",
  "String",
  "TemplateString",
  "RegExp",
]);

// True when `pos` sits inside a comment, string or regex. An interpolation
// inside a template literal is code again, so the walk stops there.
export function isNonCodePosition(state, pos) {
  for (
    let node = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === "Interpolation") return false;
    if (NON_CODE_NODES.has(node.name)) {
      // Just past the closing delimiter of a string/regex/block comment the
      // cursor is back in code. A line comment has no closing delimiter.
      return node.name === "LineComment" || pos < node.to || isUnterminated(state, node);
    }
  }
  return false;
}

// True when `pos` sits inside a comment. No provider has anything to offer
// there — the ones that match on the text before the cursor would otherwise
// take `// try s("b` for a sound argument.
export function isCommentPosition(state, pos) {
  for (
    let node = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === "LineComment") return true;
    if (node.name === "BlockComment") {
      return pos < node.to || isUnterminated(state, node);
    }
  }
  return false;
}

function isUnterminated(state, node) {
  const text = state.sliceDoc(node.from, node.to);
  if (node.name === "BlockComment") return !text.endsWith("*/");
  if (node.name === "RegExp") return false;
  return text.length < 2 || text[text.length - 1] !== text[0];
}

let functionList = [];

/**
 * Build the function list. Names from `liveExports` (the union of all
 * @strudel/* package exports) seed the list; names that also have a docs
 * entry get the rich info panel. Runs at install time and again when the
 * docs index arrives (see install.js) — before that, completions offer the
 * live export names without doc text.
 *
 * @param {string[]} liveExports
 */
export function buildFunctionList(liveExports) {
  const docs = getDocs();
  const seen = new Set();
  const out = [];
  const consider = (name) => {
    if (seen.has(name)) return;
    if (!/^[a-z]/.test(name)) return;
    // `docs` is a plain object: look keys up with hasOwn so inherited names
    // (`constructor`, `toString`, …) don't masquerade as documented
    // functions.
    const entry = Object.hasOwn(docs, name) ? docs[name] : null;
    // One-letter names are noise unless they are real, documented functions
    // (`s`, `n`).
    if (name.length < 2 && !entry) return;
    seen.add(name);
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
    // A fragment that starts with a digit is a number literal being typed
    // (`gain(0.8)`, `range(200, 2000)`), not an identifier.
    if (/^\d/.test(word.text)) return null;
    if (isNonCodePosition(context.state, context.pos)) return null;

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
  if (Object.hasOwn(SNIPPET_TEMPLATES, fn.label)) {
    opt.apply = snippet(SNIPPET_TEMPLATES[fn.label]);
  }
  if (fn.entry) {
    if (fn.entry.doc) {
      const first = fn.entry.doc.split(/[.!?]\s/)[0];
      opt.detail = first.length > 60 ? first.slice(0, 57) + "..." : first;
    }
    opt.info = () => renderCompletionInfo(fn.label, fn.entry);
  }
  return opt;
}
