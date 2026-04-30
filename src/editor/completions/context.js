// src/editor/completions/context.js
//
// Two responsibilities, one module (they share the doc-walk debounce in
// production):
//
//   1. extractBufferTokens — pure regex walker over a buffer string.
//      Recovers the categories the ranker uses for buffer-presence boost.
//      The CM6 ViewPlugin (createBufferContextPlugin, below) wraps this
//      and uses syntaxTree() when available, falling back to the regex
//      walker if the tree isn't ready (rare — only at first paint).
//
//   2. Recency table — LRU per category, persisted to localStorage,
//      cross-tab sync via the storage event. Implemented in Task 5.

const CATEGORIES = ["sound", "bank", "chord", "function"];

const SOUND_CALL_RE = /\b(?:s|sound)\(\s*['"`]([^'"`]*)['"`]/g;
const BANK_CALL_RE  = /\bbank\(\s*['"`]([^'"`]*)['"`]/g;
const CHORD_CALL_RE = /\bchord\(\s*['"`]([^'"`]*)['"`]/g;
const FN_CALL_RE    = /\b([a-z][a-zA-Z0-9_]*)\s*\(/g;

const MINI_SEPARATOR_RE = /[\s[\]<>{},|!@?*/~]+/;

/**
 * Extract buffer-presence tokens for each ranker category from a JS source
 * string. Pure — used directly in tests; the production CM6 ViewPlugin
 * (see createBufferContextPlugin) calls this as its fallback.
 *
 * @param {string} text
 * @returns {Map<"sound" | "bank" | "chord" | "function", Set<string>>}
 */
export function extractBufferTokens(text) {
  const out = new Map();
  for (const cat of CATEGORIES) out.set(cat, new Set());
  if (!text) return out;

  collectInsideQuotes(text, SOUND_CALL_RE, out.get("sound"), splitMiniTokens);
  collectInsideQuotes(text, BANK_CALL_RE,  out.get("bank"),  (s) => [s.trim()]);
  collectInsideQuotes(text, CHORD_CALL_RE, out.get("chord"), splitMiniTokens);

  let m;
  FN_CALL_RE.lastIndex = 0;
  while ((m = FN_CALL_RE.exec(text)) !== null) {
    out.get("function").add(m[1]);
  }
  return out;
}

function collectInsideQuotes(text, re, dest, splitFn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const tok of splitFn(m[1])) {
      if (!tok || tok === "~") continue;
      if (/^\d+$/.test(tok)) continue; // pure-numeric (e.g. "4" from "hh*4")
      dest.add(stripVariantSuffix(tok));
    }
  }
}

function splitMiniTokens(content) {
  return content.split(MINI_SEPARATOR_RE).filter(Boolean);
}

function stripVariantSuffix(tok) {
  const i = tok.indexOf(":");
  return i > 0 ? tok.slice(0, i) : tok;
}
