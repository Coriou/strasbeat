// src/editor/completions/context.js
//
// Three responsibilities, one module:
//
//   1. extractBufferTokens — pure regex walker over a buffer string.
//      Recovers the categories the ranker uses for buffer-presence boost.
//      Used as the fallback when the syntax tree isn't ready.
//
//   2. Recency table — LRU per category, persisted to localStorage,
//      cross-tab sync via the storage event.
//
//   3. bufferContextPlugin — CM6 ViewPlugin that maintains a debounced
//      cache of buffer tokens for the current document. Prefers the
//      syntax tree (skips comments and string-literal contents
//      naturally); falls back to the regex walker on first paint or
//      tree-walk failure. Providers read the cache via getBufferTokens().

const CATEGORIES = ["sound", "bank", "chord", "function"];

const SOUND_CALL_RE = /\b(?:s|sound)\(\s*['"`]([^'"`]*)['"`]/g;
const BANK_CALL_RE  = /\bbank\(\s*['"`]([^'"`]*)['"`]/g;
const CHORD_CALL_RE = /\bchord\(\s*['"`]([^'"`]*)['"`]/g;
const FN_CALL_RE    = /\b([a-z][a-zA-Z0-9_]*)\s*\(/g;

const MINI_SEPARATOR_RE = /[\s[\]<>{},|!@?*/~]+/;

/**
 * Extract buffer-presence tokens for each ranker category from a JS source
 * string. Pure — used directly in tests; the CM6 `bufferContextPlugin`
 * (below) calls this as its fallback when the syntax tree isn't ready.
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

const RECENCY_KEY = "strasbeat:completions-recency";
const RECENCY_CAP = 32;
const RECENCY_DECAY_DAYS = 30;
const RECENCY_MAX_BOOST = 0.3;
const RECENCY_DAY_MS = 86400 * 1000;
const RECENCY_CATEGORIES = ["sound", "bank", "chord", "function", "note", "mode"];

/**
 * Create a recency table with linear time-decay scoring and localStorage
 * persistence. Each category caps at 32 entries (LRU eviction).
 *
 * @param {{ now?: () => number, debounceMs?: number }} [opts]
 *   - now: clock injection for tests (default Date.now)
 *   - debounceMs: write delay for localStorage (default 1000)
 */
export function createRecency({ now = Date.now, debounceMs = 1000 } = {}) {
  const tables = hydrate();
  let writeTimer = null;

  function bump(category, label) {
    if (!RECENCY_CATEGORIES.includes(category)) return;
    if (!label || typeof label !== "string") return;
    const list = tables[category];
    const existing = list.findIndex((e) => e.label === label);
    if (existing >= 0) list.splice(existing, 1);
    list.unshift({ label, t: now() });
    if (list.length > RECENCY_CAP) list.length = RECENCY_CAP;
    scheduleWrite();
  }

  function score(category, label, { now: nowOpt } = {}) {
    const list = tables[category];
    if (!list) return 0;
    const entry = list.find((e) => e.label === label);
    if (!entry) return 0;
    const age = (nowOpt ?? now()) - entry.t;
    const days = age / RECENCY_DAY_MS;
    if (days >= RECENCY_DECAY_DAYS) return 0;
    return Math.max(0, (1 - days / RECENCY_DECAY_DAYS) * RECENCY_MAX_BOOST);
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(tables));
  }

  function flush() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    write();
  }

  function scheduleWrite() {
    if (debounceMs <= 0) {
      write();
      return;
    }
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      write();
    }, debounceMs);
  }

  function write() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(RECENCY_KEY, JSON.stringify(tables));
    } catch (err) {
      console.warn("[strasbeat/completions] recency write failed:", err);
    }
  }

  function syncFromStorage() {
    const fresh = hydrate();
    for (const cat of RECENCY_CATEGORIES) tables[cat] = fresh[cat];
  }

  return { bump, score, snapshot, flush, syncFromStorage };
}

function hydrate() {
  const empty = Object.fromEntries(RECENCY_CATEGORIES.map((c) => [c, []]));
  if (typeof localStorage === "undefined") return empty;
  let raw;
  try {
    raw = localStorage.getItem(RECENCY_KEY);
  } catch {
    return empty;
  }
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return empty;
    for (const cat of RECENCY_CATEGORIES) {
      if (!Array.isArray(parsed[cat])) parsed[cat] = [];
    }
    return parsed;
  } catch {
    console.warn("[strasbeat/completions] recency parse failed, resetting");
    return empty;
  }
}

// ─── CM6 buffer-context view plugin ──────────────────────────────────────
//
// Maintains a debounced cache of buffer tokens for the current document.
// Providers call getBufferTokens() during completion fire to add a small
// buffer-presence boost to candidates already used in the user's buffer.
//
// Multiple editors aren't supported (strasbeat has one); the cache holds
// whatever the last update wrote.
//
// Implementation: prefer the syntax tree (skips comments and string-literal
// contents naturally — only descends into real CallExpressions). Falls back
// to the regex walker on first paint or any tree-walk failure.

import { ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

const BUFFER_DEBOUNCE_MS = 150;

let activeTokens = emptyTokenMap();

/**
 * Return the latest cached buffer-token map. Always returns a Map shaped
 * like `extractBufferTokens(text)` (every category present, value is a Set).
 *
 * @returns {Map<"sound" | "bank" | "chord" | "function", Set<string>>}
 */
export function getBufferTokens() {
  return activeTokens;
}

/**
 * CM6 ViewPlugin: re-extracts buffer tokens on debounced doc-change and
 * updates the module-level `activeTokens` cache. Mount this once per
 * editor; getBufferTokens() reads its output.
 */
export const bufferContextPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.timer = null;
      this.refresh(view);
    }
    update(update) {
      if (!update.docChanged) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.refresh(update.view);
      }, BUFFER_DEBOUNCE_MS);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
    refresh(view) {
      activeTokens = extractFromState(view.state);
    }
  },
);

/**
 * Extract buffer tokens from a CM6 EditorState. Tries the syntax tree first
 * (correctly skips comments and string-literal contents); falls back to the
 * regex walker if the tree is incomplete or any parse error escapes.
 *
 * Exported for tests (`refresh(view)` shells through this).
 *
 * @param {import('@codemirror/state').EditorState} state
 * @returns {Map<"sound" | "bank" | "chord" | "function", Set<string>>}
 */
export function extractFromState(state) {
  const text = state.doc.toString();
  try {
    const tree = syntaxTree(state);
    // If the parser hasn't produced a real tree yet (first paint, or the
    // language extension wasn't installed), fall back to the regex walker.
    if (!tree || tree.length < text.length) {
      return extractBufferTokens(text);
    }
    return extractFromTree(tree, (from, to) => state.sliceDoc(from, to));
  } catch (err) {
    console.warn(
      "[strasbeat/completions] syntax-tree buffer extract failed; using regex fallback:",
      err,
    );
    return extractBufferTokens(text);
  }
}

/**
 * Pure tree-walker: visits every CallExpression, pulls callee name + first
 * string arg, and bins tokens by category. Comments and unrelated string
 * literals are skipped automatically because the parser doesn't emit
 * CallExpression nodes inside them.
 *
 * @param {import('@lezer/common').Tree} tree
 * @param {(from: number, to: number) => string} sliceDoc
 * @returns {Map<"sound" | "bank" | "chord" | "function", Set<string>>}
 */
export function extractFromTree(tree, sliceDoc) {
  const out = emptyTokenMap();
  const sounds = out.get("sound");
  const banks = out.get("bank");
  const chords = out.get("chord");
  const fns = out.get("function");

  tree.iterate({
    enter(node) {
      // Belt-and-braces: even though comments don't contain CallExpressions,
      // returning false here means we never descend into their interior.
      if (node.name === "LineComment" || node.name === "BlockComment") {
        return false;
      }
      if (node.name !== "CallExpression") return;

      const callee = calleeNameOf(node.node, sliceDoc);
      if (callee) fns.add(callee);
      if (!callee) return;

      // Find the first String / TemplateString inside the ArgList.
      const argList = firstChildOfName(node.node, "ArgList") ||
        firstChildOfName(node.node, "ArgumentList");
      if (!argList) return;
      const arg = firstStringChild(argList);
      if (!arg) return;
      const content = stripQuotes(sliceDoc(arg.from, arg.to));

      if (callee === "s" || callee === "sound") {
        addAll(sounds, splitMiniTokens(content));
      } else if (callee === "bank") {
        const t = content.trim();
        if (t) addAll(banks, [t]);
      } else if (callee === "chord") {
        addAll(chords, splitMiniTokens(content));
      }
    },
  });

  return out;
}

function emptyTokenMap() {
  const out = new Map();
  for (const cat of CATEGORIES) out.set(cat, new Set());
  return out;
}

function addAll(set, tokens) {
  for (const tok of tokens) {
    if (!tok || tok === "~") continue;
    if (/^\d+$/.test(tok)) continue;
    set.add(stripVariantSuffix(tok));
  }
}

function calleeNameOf(callNode, sliceDoc) {
  const first = callNode.firstChild;
  if (!first) return null;
  if (first.name === "VariableName" || first.name === "Identifier") {
    return sliceDoc(first.from, first.to);
  }
  if (first.name === "MemberExpression" || first.name === "MemberAccess") {
    // Property name is the last child after the dot.
    let prop = first.lastChild;
    if (prop && prop.name === ".") prop = prop.nextSibling;
    if (prop &&
        (prop.name === "PropertyName" ||
         prop.name === "PropertyDefinition" ||
         prop.name === "Identifier")) {
      return sliceDoc(prop.from, prop.to);
    }
  }
  return null;
}

function firstChildOfName(node, name) {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === name) return c;
  }
  return null;
}

function firstStringChild(argList) {
  for (let c = argList.firstChild; c; c = c.nextSibling) {
    if (c.name === "String" || c.name === "TemplateString") return c;
  }
  return null;
}

function stripQuotes(raw) {
  if (raw.length < 2) return raw;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' || first === "'" || first === "`") && first === last) {
    return raw.slice(1, -1);
  }
  return raw;
}
