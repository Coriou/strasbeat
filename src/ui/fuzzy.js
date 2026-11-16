// Accent-folding subsequence fuzzy matcher.
//
// Public:
//   foldAccents(s) -> string         // lowercase + strip diacriticals
//   score(query, target) -> {score, matches: number[]} | null
//
// "matches" are UTF-16 indices into the ORIGINAL target string, so the
// caller can render highlights against it directly. Folding can change a
// string's length (a decomposed "e" + combining accent folds to one unit),
// so matching runs on the folded text and maps positions back.

const DIACRITICAL_RE = /\p{M}/gu;

export function foldAccents(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFD").replace(DIACRITICAL_RE, "").toLowerCase();
}

const WORD_BOUNDARY_RE = /[^a-z0-9]/;

// Fold `target` one character at a time, remembering which original index
// each folded code unit came from.
function foldWithIndexMap(target) {
  let folded = "";
  const map = [];
  let i = 0;
  for (const ch of target) {
    const f = foldAccents(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  return { folded, map };
}

/**
 * Score how well `query` matches `target`. Returns null if any token has no
 * subsequence match. Otherwise returns the best (highest-score) alignment and
 * the union of matched indices.
 */
export function score(query, target) {
  if (typeof query !== "string" || typeof target !== "string") return null;
  const q = foldAccents(query).trim();
  if (!q) return null;
  if (!target) return null;
  const { folded: t, map } = foldWithIndexMap(target);
  if (!t) return null;

  const tokens = q.split(/\s+/);
  const allMatches = new Set();
  let total = 0;

  for (const tok of tokens) {
    if (!tok) continue;
    const r = bestSubsequence(tok, t);
    if (!r) return null;
    total += r.score;
    for (const i of r.matches) allMatches.add(map[i]);
  }

  return {
    score: total,
    matches: Array.from(allMatches).sort((a, b) => a - b),
  };
}

/**
 * Find the highest-scoring subsequence alignment of `tok` in `t` (both
 * already lowercased + accent-folded). Returns {score, matches} or null
 * when `tok` is not a subsequence of `t`.
 *
 * An alignment scores:
 *   + 1 per matched char
 *   + RUN_BONUS for each match directly after the previous one
 *   + WORD_START_BONUS per match at a word boundary
 *   + PREFIX_BONUS once if the first matched index is 0
 *
 * Solved exactly with a small dynamic program over (token char, target
 * position) — O(tok × t). A greedy scan can paint itself into a corner
 * (jumping ahead to a word start and leaving no room for the rest), which
 * would report "no match" for a perfectly good subsequence.
 */
function bestSubsequence(tok, t) {
  const RUN_BONUS = 4;
  const WORD_START_BONUS = 3;
  const PREFIX_BONUS = 6;

  const n = t.length;
  const m = tok.length;
  if (m > n) return null;

  // best[i]: top score with the current token char matched at t[i]
  // (-Infinity when impossible). from[j][i]: where the previous char sat.
  let prev = new Array(n).fill(-Infinity);
  const from = [];

  for (let j = 0; j < m; j++) {
    const cur = new Array(n).fill(-Infinity);
    const back = new Int32Array(n).fill(-1);
    // Best score among prev[0 .. i-2] (a non-adjacent predecessor), and
    // its position; leftmost wins ties so highlights hug the start.
    let gapBest = -Infinity;
    let gapAt = -1;
    for (let i = 0; i < n; i++) {
      if (j > 0 && i >= 2 && prev[i - 2] > gapBest) {
        gapBest = prev[i - 2];
        gapAt = i - 2;
      }
      if (t[i] !== tok[j]) continue;
      let s = 1;
      if (i === 0 || WORD_BOUNDARY_RE.test(t[i - 1])) s += WORD_START_BONUS;
      if (j === 0) {
        cur[i] = s + (i === 0 ? PREFIX_BONUS : 0);
        continue;
      }
      const adjacent = i >= 1 ? prev[i - 1] + RUN_BONUS : -Infinity;
      if (adjacent >= gapBest && adjacent > -Infinity) {
        cur[i] = adjacent + s;
        back[i] = i - 1;
      } else if (gapBest > -Infinity) {
        cur[i] = gapBest + s;
        back[i] = gapAt;
      }
    }
    from.push(back);
    prev = cur;
  }

  let end = -1;
  for (let i = 0; i < n; i++) {
    if (prev[i] > -Infinity && (end < 0 || prev[i] > prev[end])) end = i;
  }
  if (end < 0) return null;

  const matches = new Array(m);
  let at = end;
  for (let j = m - 1; j >= 0; j--) {
    matches[j] = at;
    at = from[j][at];
  }
  return { score: prev[end], matches };
}
