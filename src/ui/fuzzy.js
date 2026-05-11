// Accent-folding subsequence fuzzy matcher.
//
// Public:
//   foldAccents(s) -> string         // lowercase + strip diacriticals
//   score(query, target) -> {score, matches: number[]} | null
//
// "matches" indices are into the ORIGINAL target string (post-fold, same length).
// Caller renders highlights against the original target using these indices.

const DIACRITICAL_RE = /\p{M}/gu;

export function foldAccents(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFD").replace(DIACRITICAL_RE, "").toLowerCase();
}

const WORD_BOUNDARY_RE = /[^a-z0-9]/;

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
  const t = foldAccents(target);
  if (!t) return null;

  const tokens = q.split(/\s+/);
  const allMatches = new Set();
  let total = 0;

  for (const tok of tokens) {
    if (!tok) continue;
    const r = bestSubsequence(tok, t);
    if (!r) return null;
    total += r.score;
    for (const i of r.matches) allMatches.add(i);
  }

  return {
    score: total,
    matches: Array.from(allMatches).sort((a, b) => a - b),
  };
}

/**
 * Find the highest-scoring subsequence alignment of `tok` in `t` (both
 * already lowercased + accent-folded). Returns {score, matches} or null.
 *
 * Strategy: greedy left-to-right scan, but with a small look-ahead to prefer
 * consecutive runs and word-start positions. This is intentionally simple —
 * good enough for the small libraries we expect. If we ever need to handle
 * pathological cases, swap for a proper dp.
 */
function bestSubsequence(tok, t) {
  // First check feasibility: subsequence must exist at all.
  let j = 0;
  for (let i = 0; i < t.length && j < tok.length; i++) {
    if (t[i] === tok[j]) j++;
  }
  if (j < tok.length) return null;

  // Now find the alignment that maximizes a score combining:
  //   + 1 per matched char
  //   + (run-length - 1) * RUN_BONUS for each consecutive run beyond length 1
  //   + WORD_START_BONUS per match at a word boundary
  //   + PREFIX_BONUS once if the first matched index is 0
  //
  // We use a simple iterative search: anchor on each viable starting index,
  // greedily extend, score, keep the best. With small targets (<80 chars)
  // this is fast.
  const RUN_BONUS = 4;
  const WORD_START_BONUS = 3;
  const PREFIX_BONUS = 6;

  let best = null;

  for (let start = 0; start < t.length; start++) {
    if (t[start] !== tok[0]) continue;
    // Match greedily from `start`, but at each subsequent step, prefer the
    // immediately-next char if it matches, otherwise prefer the next
    // word-boundary occurrence, else the next occurrence.
    const matches = [start];
    let cursor = start + 1;
    let tokIdx = 1;
    while (tokIdx < tok.length) {
      const target = tok[tokIdx];
      let pick = -1;
      // Immediate next char?
      if (cursor < t.length && t[cursor] === target) {
        pick = cursor;
      } else {
        // Prefer word-boundary match, else first occurrence.
        let wbPick = -1;
        for (let k = cursor; k < t.length; k++) {
          if (t[k] !== target) continue;
          if (k === 0 || WORD_BOUNDARY_RE.test(t[k - 1])) {
            wbPick = k;
            break;
          }
        }
        if (wbPick >= 0) {
          pick = wbPick;
        } else {
          for (let k = cursor; k < t.length; k++) {
            if (t[k] === target) { pick = k; break; }
          }
        }
      }
      if (pick < 0) break;
      matches.push(pick);
      cursor = pick + 1;
      tokIdx++;
    }
    if (matches.length < tok.length) continue;

    // Score this alignment.
    let s = tok.length; // base: one point per matched char
    let runLen = 1;
    for (let k = 1; k < matches.length; k++) {
      if (matches[k] === matches[k - 1] + 1) {
        runLen++;
        s += RUN_BONUS;
      } else {
        runLen = 1;
      }
    }
    for (const i of matches) {
      if (i === 0 || WORD_BOUNDARY_RE.test(t[i - 1])) s += WORD_START_BONUS;
    }
    if (matches[0] === 0) s += PREFIX_BONUS;

    if (best == null || s > best.score) best = { score: s, matches };
  }

  return best;
}
