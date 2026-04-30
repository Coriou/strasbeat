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
