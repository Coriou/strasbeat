// Minimal text diff → CodeMirror change specs.
//
// Whole-buffer rewrites (format, mute/solo) used to dispatch a single
// `{ from: 0, to: doc.length, insert }` change. That is correct text-wise but
// it tells CodeMirror every character was replaced, so everything that maps
// positions through changes — Strudel's mini-notation highlight marks and
// inline slider widgets, the cursor, the scroll anchor, other tabs' undo
// history joins — collapses to the start of the document. Dispatching only the
// characters that actually differ lets all of those map through untouched.
//
// The diff is Myers' O(ND) greedy algorithm over UTF-16 code units, run on the
// region left after trimming the common prefix and suffix. Formatter output
// differs from its input by whitespace and the odd comma, so D stays small in
// practice; MAX_EDIT_DISTANCE bounds the worst case (a wildly unformatted
// buffer), where we fall back to one change covering the trimmed region.

const MAX_EDIT_DISTANCE = 1500;

/**
 * Compute the changes that turn `a` into `b`.
 *
 * Returned ranges are in `a` coordinates, sorted and non-overlapping — the
 * shape `view.dispatch({ changes })` accepts.
 *
 * @param {string} a
 * @param {string} b
 * @param {{ maxEditDistance?: number }} [opts]
 * @returns {Array<{ from: number, to: number, insert: string }>}
 */
export function diffChanges(a, b, { maxEditDistance = MAX_EDIT_DISTANCE } = {}) {
  if (a === b) return [];

  const minLen = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < minLen && a.charCodeAt(prefix) === b.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix++;
  }

  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const n = aEnd - prefix;
  const m = bEnd - prefix;
  const whole = [{ from: prefix, to: aEnd, insert: b.slice(prefix, bEnd) }];
  if (n === 0 || m === 0) return whole;

  const trace = shortestEditTrace(a, b, prefix, n, m, maxEditDistance);
  if (!trace) return whole;
  return changesFromTrace(trace, a, b, prefix, n, m);
}

// Forward pass of Myers' algorithm. `v[k + offset]` is the furthest x reached
// on diagonal k (k = x - y). Returns the per-step snapshots of `v` needed to
// walk the path back, or null when the edit distance exceeds `maxD`.
function shortestEditTrace(a, b, base, n, m, maxD) {
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    // Only diagonals -d..d are touched at step d, so that slice is all the
    // backtrack needs — keeps memory at O(D²) instead of O(D·(N+M)).
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (
        x < n &&
        y < m &&
        a.charCodeAt(base + x) === b.charCodeAt(base + y)
      ) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return trace;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return null;
}

// Walk the snapshots backwards, collecting single-character inserts/deletes,
// then merge runs that touch into one change each.
function changesFromTrace(trace, a, b, base, n, m) {
  // Each edit: [aPos, deleteCount, bPos, insertCount] in trimmed coordinates.
  const edits = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    // Snapshot d-1 holds diagonals -(d-1)..(d-1) at indices 0..2(d-1).
    const prev = trace[d - 1];
    const at = (k) => prev[k + (d - 1)];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    // Undo the diagonal run, then the single edit that led onto diagonal k.
    if (prevK === k + 1) edits.push([prevX, 0, prevY, 1]); // insert b[prevY]
    else edits.push([prevX, 1, prevY, 0]); // delete a[prevX]
    x = prevX;
    y = prevY;
  }
  edits.reverse();

  const out = [];
  let cur = null;
  for (const [aPos, del, bPos, ins] of edits) {
    if (cur && aPos === cur.aTo && bPos === cur.bTo) {
      cur.aTo += del;
      cur.bTo += ins;
    } else {
      if (cur) out.push(toChange(cur, b, base));
      cur = { aFrom: aPos, aTo: aPos + del, bFrom: bPos, bTo: bPos + ins };
    }
  }
  if (cur) out.push(toChange(cur, b, base));
  return out;
}

function toChange(run, b, base) {
  return {
    from: base + run.aFrom,
    to: base + run.aTo,
    insert: b.slice(base + run.bFrom, base + run.bTo),
  };
}
