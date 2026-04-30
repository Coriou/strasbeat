// src/editor/completions/score.js
//
// Pure fuzzy-subsequence scoring kernel. Returns null when query is not a
// case-insensitive subsequence of candidate; otherwise returns a score in
// [0, ~1.5] plus the matched character indices for highlight rendering.
//
// Weights are tuned against the fixture table in score.test.js — adjust
// both together.

const W_BASE       = 0.30;  // floor for any subsequence match
const W_PREFIX     = 0.40;  // first query char hit candidate[0]
const W_BOUNDARY   = 0.15;  // each hit landing on a word boundary
const W_RUN        = 0.05;  // each additional contiguous-run char beyond the first
const W_LEN_PEN    = 0.001; // per-character length penalty (tiebreaker)

/**
 * @param {string} query
 * @param {string} candidate
 * @returns {{ score: number, matched: number[] } | null}
 */
export function score(query, candidate) {
  const q = query.toLowerCase();
  if (!q) return { score: 0, matched: [] };

  const cLow = candidate.toLowerCase();
  const matched = [];
  let qi = 0;
  let ci = 0;
  let lastMatched = -1;
  let runBonus = 0;
  let boundaryBonus = 0;
  let isPrefix = false;

  while (qi < q.length && ci < cLow.length) {
    if (q[qi] === cLow[ci]) {
      matched.push(ci);
      if (qi === 0 && ci === 0) isPrefix = true;
      // Spec line 230: count ci === 0 as a boundary too. The fixture
      // ranges in score.test.js were derived from this form.
      if (ci === 0 || isWordBoundary(candidate, ci)) boundaryBonus += W_BOUNDARY;
      if (lastMatched !== -1 && ci - lastMatched === 1) runBonus += W_RUN;
      lastMatched = ci;
      qi++;
    }
    ci++;
  }
  if (qi < q.length) return null;

  const total =
    W_BASE +
    (isPrefix ? W_PREFIX : 0) +
    boundaryBonus +
    runBonus -
    candidate.length * W_LEN_PEN;

  return { score: total, matched };
}

/**
 * Split candidate into alternating hit / non-hit runs for highlighting.
 * @param {string} candidate
 * @param {number[]} matched
 * @returns {Array<{ text: string, hit: boolean }>}
 */
export function segment(candidate, matched) {
  if (!matched || matched.length === 0) {
    return [{ text: candidate, hit: false }];
  }
  const out = [];
  let cursor = 0;
  let i = 0;
  while (i < matched.length) {
    const runStart = matched[i];
    let runEnd = runStart + 1;
    while (i + 1 < matched.length && matched[i + 1] === runEnd) {
      runEnd++;
      i++;
    }
    if (cursor < runStart) {
      out.push({ text: candidate.slice(cursor, runStart), hit: false });
    }
    out.push({ text: candidate.slice(runStart, runEnd), hit: true });
    cursor = runEnd;
    i++;
  }
  if (cursor < candidate.length) {
    out.push({ text: candidate.slice(cursor), hit: false });
  }
  return out;
}

/**
 * @param {string} s — original-case candidate
 * @param {number} i — index inside s (i > 0 caller-guaranteed)
 */
function isWordBoundary(s, i) {
  const prev = s[i - 1];
  if (prev === "_" || prev === "-") return true;
  if (prev >= "0" && prev <= "9" && /[a-zA-Z]/.test(s[i])) return true;
  return prev === prev.toLowerCase() && s[i] !== s[i].toLowerCase();
}
