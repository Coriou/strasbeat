// Static analysis of the editor buffer to find `arrange(...)` calls and the
// `[cycles, expr]` section tuples they contain. Used by the arrangement
// timeline to render a song map (section widths proportional to cycles, a
// playhead that walks through them).
//
// Mirrors the hand-rolled scanner style of track-labels.js — no AST, no
// parser dependency. We tolerate unbalanced buffers gracefully because the
// editor is almost always mid-edit when we run.
//
// Only the canonical shape is recognised:
//
//   arrange(
//     [N, expr],
//     [N, expr],
//     ...
//   )
//
// where N is a bare numeric literal. `expr` can be anything; we recover a
// short display label for the simple cases (bare identifier or string
// literal). Everything else → `label: null`, and the UI falls back to
// "section N".

const IDENT_PART_RE = /[A-Za-z0-9_$]/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?/;
const BARE_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const STRING_LITERAL_RE = /^(['"])((?:\\.|(?!\1).)*)\1$/;

/**
 * @typedef {object} ArrangeSection
 * @property {number} cycles           how many cycles this section plays for
 * @property {string|null} label       short display name, or null when we
 *                                     couldn't recover one (UI falls back to "N")
 * @property {string} rawExpr          original source of the pattern expression, trimmed
 * @property {number} start            offset of '[' in the source buffer
 * @property {number} end              offset of ']' in the source buffer
 * @property {number} line             1-based line number of '['
 */

/**
 * @typedef {object} Arrangement
 * @property {number} callStart        offset of the 'arrange' identifier
 * @property {number} openParen        offset of '('
 * @property {number} closeParen       offset of ')'
 * @property {number} line             1-based line of the 'arrange' identifier
 * @property {ArrangeSection[]} sections
 * @property {number} totalCycles      sum of all section cycles
 */

/**
 * Scan the given source buffer and return every top-level `arrange(...)`
 * call it contains. Top-level here means "not inside a string, comment, or
 * template literal"; it is happy to pick up arranges nested inside other
 * code structures (object literals, stack arguments, etc.) but the tuples
 * inside must be direct children of the arrange call itself.
 *
 * @param {string} code
 * @returns {Arrangement[]}
 */
export function parseArrangements(code) {
  const lineAt = buildLineMap(code);
  const out = [];
  let i = 0;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '/' && next === '/') { i = skipLineComment(code, i); continue; }
    if (ch === '/' && next === '*') { i = skipBlockComment(code, i); continue; }
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(code, i); continue; }

    if (ch === 'a' && code.slice(i, i + 7) === 'arrange') {
      const prev = i > 0 ? code[i - 1] : '';
      const after = i + 7;
      const prevIsBoundary = !IDENT_PART_RE.test(prev) && prev !== '.';
      const nextIsBoundary = !IDENT_PART_RE.test(code[after] || ' ');
      if (prevIsBoundary && nextIsBoundary) {
        let j = after;
        while (j < code.length && /\s/.test(code[j])) j++;
        if (code[j] === '(') {
          const parsed = parseArrangeCall(code, i, j, lineAt);
          if (parsed) {
            out.push(parsed);
            i = parsed.closeParen + 1;
            continue;
          }
        }
      }
    }
    i++;
  }
  return out;
}

function parseArrangeCall(code, callStart, openParen, lineAt) {
  const closeParen = findMatchingClose(code, openParen, '(', ')');
  if (closeParen < 0) return null;

  const sections = [];
  let i = openParen + 1;
  while (i < closeParen) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '/' && next === '/') { i = skipLineComment(code, i); continue; }
    if (ch === '/' && next === '*') { i = skipBlockComment(code, i); continue; }
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(code, i); continue; }

    if (ch === '(') {
      const end = findMatchingClose(code, i, '(', ')');
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === '{') {
      const end = findMatchingClose(code, i, '{', '}');
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === '[') {
      const closeBracket = findMatchingClose(code, i, '[', ']');
      if (closeBracket < 0) break;
      const section = buildSection(code, i, closeBracket, lineAt);
      if (section) sections.push(section);
      i = closeBracket + 1;
      continue;
    }
    i++;
  }

  const totalCycles = sections.reduce((s, x) => s + x.cycles, 0);
  return {
    callStart,
    openParen,
    closeParen,
    line: lineAt(callStart),
    sections,
    totalCycles,
  };
}

function buildSection(code, openBracket, closeBracket, lineAt) {
  const inner = code.slice(openBracket + 1, closeBracket).trim();
  if (!inner) return null;

  const numMatch = inner.match(NUMBER_RE);
  if (!numMatch) return null;

  const cycles = Number(numMatch[0]);
  if (!Number.isFinite(cycles) || cycles <= 0) return null;

  let rest = inner.slice(numMatch[0].length).trimStart();
  if (rest[0] !== ',') return null;
  rest = rest.slice(1).trim();
  if (!rest) return null;

  const rawExpr = rest;
  let label = null;
  if (BARE_IDENT_RE.test(rawExpr)) {
    label = rawExpr;
  } else {
    const strMatch = rawExpr.match(STRING_LITERAL_RE);
    if (strMatch) label = strMatch[2].replace(/\\(.)/g, '$1');
  }

  return {
    cycles,
    label,
    rawExpr,
    start: openBracket,
    end: closeBracket,
    line: lineAt(openBracket),
  };
}

function findMatchingClose(code, openOffset, openCh, closeCh) {
  let depth = 1;
  let i = openOffset + 1;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '/' && next === '/') { i = skipLineComment(code, i); continue; }
    if (ch === '/' && next === '*') { i = skipBlockComment(code, i); continue; }
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(code, i); continue; }

    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipLineComment(code, start) {
  let i = start;
  while (i < code.length && code[i] !== '\n') i++;
  return i;
}

function skipBlockComment(code, start) {
  let i = start + 2;
  while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
  return Math.min(i + 2, code.length);
}

function skipString(code, start) {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    i++;
  }
  return code.length;
}

function buildLineMap(code) {
  const newlines = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') newlines.push(i);
  }
  return (offset) => {
    let lo = 0, hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

// Method names that, chained after `arrange(...)`, change how long the
// arrangement audibly takes per loop. We don't enumerate *every* such
// method — the goal is to flag the footguns so the UI can explain "your
// strip shows 32 cycles but playback takes 16" rather than silently lying.
const DURATION_AFFECTING_METHODS = new Set([
  'slow',
  'fast',
  'stretch',
  'segment',
  'cps',
  'cpm',
  'setcps',
  'setcpm',
  'hurry',
]);

/**
 * Scan the immediate method chain following an arrange call for duration-
 * affecting transforms like `.slow(2)` or `.fast(0.5)`. Returns the first
 * match found — the UI only needs to know whether to show a warning badge,
 * not the full transform tree.
 *
 * Walks only the top-level chain (`arrange(...).slow(2)`), not nested
 * calls inside the body. Comments, strings, and balanced brackets are
 * skipped using the same tolerant scanner as parseArrangements.
 *
 * @param {string} code
 * @param {Arrangement} arrangement
 * @returns {{ method: string, argStart: number, argEnd: number } | null}
 */
export function findTrailingDurationTransform(code, arrangement) {
  if (!arrangement) return null;
  let i = arrangement.closeParen + 1;

  while (i < code.length) {
    const ch = code[i];

    // Skip whitespace & line comments between method calls.
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      i = skipLineComment(code, i);
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      i = skipBlockComment(code, i);
      continue;
    }

    // A method chain continues only with '.'. Anything else terminates it.
    if (ch !== '.') return null;

    i++;
    while (i < code.length && /\s/.test(code[i])) i++;

    let end = i;
    while (end < code.length && IDENT_PART_RE.test(code[end])) end++;
    if (end === i) return null;

    const method = code.slice(i, end);
    i = end;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] !== '(') return null;

    const callClose = findMatchingClose(code, i, '(', ')');
    if (callClose < 0) return null;

    if (DURATION_AFFECTING_METHODS.has(method)) {
      return { method, argStart: i + 1, argEnd: callClose };
    }
    i = callClose + 1;
  }
  return null;
}

/**
 * Given a cycle position and an arrangement, return the index of the
 * section currently playing and its local progress in [0, 1).
 *
 * The arrangement loops every `totalCycles` cycles; we fold the scheduler's
 * cycle into that range first.
 *
 * @param {Arrangement} arrangement
 * @param {number} cycle                cycle number from sched.now()
 * @returns {{ index: number, sectionProgress: number, totalProgress: number } | null}
 */
export function locatePlayhead(arrangement, cycle) {
  if (!arrangement || !arrangement.sections.length) return null;
  const total = arrangement.totalCycles;
  if (!(total > 0)) return null;

  const pos = ((cycle % total) + total) % total;
  let acc = 0;
  for (let i = 0; i < arrangement.sections.length; i++) {
    const s = arrangement.sections[i];
    if (pos < acc + s.cycles) {
      const sectionProgress = (pos - acc) / s.cycles;
      return { index: i, sectionProgress, totalProgress: pos / total };
    }
    acc += s.cycles;
  }
  const last = arrangement.sections.length - 1;
  return { index: last, sectionProgress: 1, totalProgress: 1 };
}
