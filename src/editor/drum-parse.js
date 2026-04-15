// Static analysis of the editor buffer to find `$: s("…").chain(…)` drum
// lanes and recover the per-step structure inside the string. Used by the
// beat grid to render one row per lane, one cell per step, with offsets
// it can dispatch back as CodeMirror transactions.
//
// Hand-rolled scanner in the same style as arrange-parse.js and
// track-labels.js — no AST, no parser dependency. Tolerant of unbalanced
// buffers because the editor is almost always mid-edit when we run.
//
// Only `$:` lines are recognised — that's the project-wide drum idiom
// (see design/PATTERN-STYLE.md §3 + §11). Named-label lanes (e.g.
// `drums: s("…")`) are intentionally skipped per design/work/19-beat-grid.md
// §"Canonical lane shape (editable)".
//
// A line is *editable* (round-trippable from clicks back to text) when
// every step token in the string is one of:
//   ~              rest
//   -              rest (alias)
//   ident          a sound name
//   ident:N        a sound name with sample variant
// and the step string contains no richer mini-notation:
//   *N  !N  @N  /N  [...]  <...>  ,
// Anything richer renders read-only with a specific `readOnlyReason`.

const IDENT_PART_RE = /[A-Za-z0-9_$]/;

/**
 * @typedef {object} DrumStep
 * @property {"rest"|"hit"} kind
 * @property {string|null} sound       null for rest, otherwise the bare ident
 * @property {number|null} variant     null = default (== 0), otherwise the integer after `:`
 * @property {number} tokenStart       offset of the first character of this step token
 * @property {number} tokenEnd         offset just past the last character of this step token
 */

/**
 * @typedef {object} DrumLaneBank
 * @property {string} name             value of the .bank("…") string literal
 * @property {number} argStart         offset of the opening `"` of the bank arg
 * @property {number} argEnd           offset just past the closing `"`
 */

/**
 * @typedef {object} DrumLane
 * @property {number} lineStart         offset of the `$` token
 * @property {number} lineEnd           offset of the EOL of the *last* line in the lane block (before next label or EOF)
 * @property {number} line              1-based line number of the `$`
 * @property {string} labelName         "$" for bare `$:`, else the identifier (always "$" for v1)
 * @property {string} rawLabel          the raw label name including any mute/solo decoration (`_$`, `S$`, `$_`)
 * @property {boolean} muted            label decorated with the `_` mute marker
 * @property {boolean} soloed           label decorated with the `S` solo marker
 * @property {"s"|"sound"} callName     which call introduces the step string
 * @property {number} stringStart       offset of the opening `"` of s("…")
 * @property {number} stringEnd         offset just past the closing `"`
 * @property {number} stepStart         offset just after the opening `"` (== first step char)
 * @property {number} stepEnd           offset just before the closing `"` (== last step char + 1)
 * @property {DrumStep[]} steps         parsed step tokens in source order
 * @property {number} stepCount         steps.length
 * @property {string|null} primarySound most-common `sound` across hits, or null when all rests
 * @property {DrumLaneBank|null} bank   parsed `.bank("…")` call, null when absent
 * @property {number} insertBankAt      where to insert `.bank("…")` if `bank` is null (just after `s("…")`)
 * @property {string} otherChain        raw method chain text *excluding* the .bank(...) call (verbatim, may include leading `\n  `)
 * @property {boolean} editable         true iff every step is a hit/rest token and there's no richer mini-notation
 * @property {string|null} readOnlyReason short, user-facing explanation when editable === false; one of the values in READ_ONLY_REASONS
 */

export const READ_ONLY_REASONS = Object.freeze({
  shortcut: "shortcut",                  // *N, !N
  alternation: "alternation",            // <a b c>
  subdivision: "subdivision",            // [a b]
  polyrhythm: "polyrhythm",              // comma operator inside string
  elongation: "elongation",              // @N
  slow: "slow",                          // /N inside string
  struct: "struct",                      // .struct(...) wrapper
  notFlat: "stack/note/chord — not a flat drum lane",
  badStepCount: "non-standard step count — edit as text",
});

/**
 * Scan the source buffer and return every editable+read-only drum lane it
 * contains. Order matches source order.
 *
 * @param {string} code
 * @returns {DrumLane[]}
 */
export function parseDrumLanes(code) {
  const lineAt = buildLineMap(code);
  const out = [];

  // Walk top-level lines: only consider a `$` that begins a line (modulo
  // optional `_` mute prefix). The label-aware scanner from track-labels.js
  // handles arbitrary nesting; we're stricter here since the spec only
  // recognises `$:` as a drum-lane marker.
  let lineStart = 0;
  for (let i = 0; i <= code.length; i++) {
    if (i === code.length || code[i] === "\n") {
      const lineEnd = i;
      const lane = scanLane(code, lineStart, lineEnd, lineAt);
      if (lane) out.push(lane);
      lineStart = i + 1;
    }
  }
  return out;
}

function scanLane(code, lineStart, lineEnd, lineAt) {
  // Accept optional indent — patterns rarely indent a $: line, but we
  // tolerate it so commented-out/restored lines round-trip cleanly.
  let i = lineStart;
  while (i < lineEnd && (code[i] === " " || code[i] === "\t")) i++;

  // Match the label: `$`, `_$`, `$_`, `S$`, `_S$`, etc. We follow the
  // track-labels.js shape rules (mute prefix/suffix, solo `S` prefix).
  // For drum lanes we still require the body identifier to be `$`.
  const labelStart = i;
  const labelMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(
    code.slice(i, lineEnd),
  );
  if (!labelMatch) return null;
  const rawLabel = labelMatch[1];
  const labelShape = getLabelShape(rawLabel);
  if (labelShape.name !== "$") return null;

  // Past the colon, allow whitespace then expect `s(` or `sound(`.
  i += labelMatch[0].length;
  while (i < lineEnd && (code[i] === " " || code[i] === "\t")) i++;
  let callName;
  if (code.slice(i, i + 2) === "s(") {
    callName = "s";
    i += 1; // skip past `s`, leaving i at `(`
  } else if (code.slice(i, i + 6) === "sound(") {
    callName = "sound";
    i += 5; // skip past `sound`, leaving i at `(`
  } else {
    return null;
  }
  const openParen = i;
  if (code[openParen] !== "(") return null;
  const closeParen = findMatchingClose(code, openParen, "(", ")");
  if (closeParen < 0) return null;

  // Inside the parens we expect *exactly* one string literal. If there's
  // anything else (a Pattern reference, a mini call, multiple args), it's
  // not a drum lane the grid can render — skip silently.
  const argStart = skipWs(code, openParen + 1);
  const argEnd = skipWsBackward(code, closeParen - 1) + 1;
  if (argStart >= argEnd) return null;
  const quote = code[argStart];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const stringClose = scanString(code, argStart);
  if (stringClose < 0) return null;
  if (stringClose + 1 !== argEnd) return null; // trailing junk inside `s(...)`

  const stringStart = argStart;
  const stringEnd = stringClose + 1;
  const stepStart = stringStart + 1;
  const stepEnd = stringEnd - 1;
  const stepText = code.slice(stepStart, stepEnd);

  // Walk the trailing method chain. We capture each `.method(args)` so we
  // can extract `.bank("…")` for the lane header and preserve everything
  // else verbatim under `otherChain`. The chain may span multiple lines
  // (per design/PATTERN-STYLE.md §7) so we read past EOL until the next
  // label or end of buffer.
  const blockEnd = findBlockEnd(code, lineEnd);
  const chain = parseTrailingChain(code, closeParen + 1, blockEnd);

  // Detect a struct() in the chain — it wraps the step string with a
  // separate rhythm vector and supersedes the editable shape.
  const structCall = chain.calls.find((c) => c.method === "struct");
  const bankCall = chain.calls.find((c) => c.method === "bank");
  let bank = null;
  if (bankCall) {
    const recovered = recoverBankArg(code, bankCall);
    if (recovered) bank = recovered;
  }

  // Build `otherChain` = original chain text minus the `.bank(...)` call.
  // We keep it verbatim (newlines, indent, comments) so the editor
  // formatting survives a round trip.
  const otherChain = stripBankFromChain(code, chain, closeParen + 1);

  // Parse the step string. This both produces the token list and decides
  // editability (see READ_ONLY_REASONS).
  const parsed = parseStepString(stepText, stepStart);
  let editable = parsed.editable;
  let readOnlyReason = parsed.readOnlyReason;

  // .struct(...) is itself a structural override. Even if the step string
  // is technically flat, the audible rhythm comes from the struct vector,
  // so toggling cells in the s("…") string would do nothing. Render the
  // step string but mark read-only.
  if (structCall) {
    editable = false;
    readOnlyReason = READ_ONLY_REASONS.struct;
  }

  // v1 only edits 4/8/16-step lanes. Anything else renders read-only with
  // a clear "edit as text" badge so the user knows why.
  if (editable && !STEP_COUNT_OK.has(parsed.steps.length)) {
    editable = false;
    readOnlyReason = READ_ONLY_REASONS.badStepCount;
  }

  const insertBankAt = closeParen + 1;
  const primarySound = pickPrimarySound(parsed.steps);

  return {
    lineStart: labelStart,
    lineEnd: blockEnd,
    line: lineAt(labelStart),
    labelName: labelShape.name,
    rawLabel,
    muted: labelShape.muted,
    soloed: labelShape.soloed,
    callName,
    stringStart,
    stringEnd,
    stepStart,
    stepEnd,
    steps: parsed.steps,
    stepCount: parsed.steps.length,
    primarySound,
    bank,
    insertBankAt,
    otherChain,
    editable,
    readOnlyReason,
  };
}

const STEP_COUNT_OK = new Set([4, 8, 16]);

function getLabelShape(rawName) {
  const soloed = rawName.length > 1 && rawName.startsWith("S");
  const body = soloed ? rawName.slice(1) : rawName;
  const muted = rawName.startsWith("_") || rawName.endsWith("_");
  const name = body.replace(/^_+/, "").replace(/_+$/, "");
  return { name, muted, soloed };
}

function pickPrimarySound(steps) {
  const counts = new Map();
  for (const s of steps) {
    if (!s.sound) continue;
    counts.set(s.sound, (counts.get(s.sound) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [sound, count] of counts) {
    if (count > bestCount) {
      best = sound;
      bestCount = count;
    }
  }
  return best;
}

// ─── Step-string tokeniser ────────────────────────────────────────────────

function parseStepString(text, baseOffset) {
  const steps = [];
  // First pass: classify the string. If it contains any structural
  // operator, mark read-only with the most relevant reason and bail.
  // We still try to recover *some* tokens for display (best-effort) by
  // splitting on top-level whitespace and letting non-flat tokens fall
  // through as opaque "hit"-like cells with no sound name — but that
  // would lie about what's audible, so we instead leave the steps array
  // empty and let the UI render the lane as a single explanatory row.

  // Detect structural operators at top level.
  const struct = scanStructural(text);
  if (struct.kind !== "flat") {
    return { steps: [], editable: false, readOnlyReason: struct.reason };
  }

  // Flat: split on whitespace, build tokens, validate each.
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const tokenStart = i;
    while (i < text.length && !/\s/.test(text[i])) i++;
    const tokenEnd = i;
    const raw = text.slice(tokenStart, tokenEnd);
    const step = parseStepToken(raw);
    if (!step) {
      // A token we can't classify (e.g. weird symbol). Mark read-only —
      // we don't want to silently pretend it's a rest.
      return {
        steps: [],
        editable: false,
        readOnlyReason: READ_ONLY_REASONS.notFlat,
      };
    }
    steps.push({
      ...step,
      tokenStart: baseOffset + tokenStart,
      tokenEnd: baseOffset + tokenEnd,
    });
  }
  return { steps, editable: true, readOnlyReason: null };
}

function parseStepToken(raw) {
  if (raw === "~" || raw === "-") {
    return { kind: "rest", sound: null, variant: null };
  }
  // sound or sound:N — N is a non-negative integer.
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*)(?::(\d+))?$/.exec(raw);
  if (!m) return null;
  return {
    kind: "hit",
    sound: m[1],
    variant: m[2] != null ? Number(m[2]) : null,
  };
}

// Detect *any* structural mini-notation operator at the top level of the
// string. Returns the most-relevant reason so the UI can offer the right
// affordance (e.g. "expand shortcut" for `*N`, "open struct grid" for
// `<...>`). The order of checks matters — `*N` is the most actionable.
function scanStructural(text) {
  if (text.includes("[")) return { kind: "struct", reason: READ_ONLY_REASONS.subdivision };
  if (text.includes("<")) return { kind: "struct", reason: READ_ONLY_REASONS.alternation };
  if (text.includes(",")) return { kind: "struct", reason: READ_ONLY_REASONS.polyrhythm };
  if (text.includes("*")) return { kind: "struct", reason: READ_ONLY_REASONS.shortcut };
  if (text.includes("!")) return { kind: "struct", reason: READ_ONLY_REASONS.shortcut };
  if (text.includes("@")) return { kind: "struct", reason: READ_ONLY_REASONS.elongation };

  // Bare `/` is mini-notation slow. We also see `/` inside numeric tokens
  // (none of our step tokens have it, but hop for tolerance), so only
  // flag it when it appears outside a token context (i.e. preceded or
  // followed by whitespace).
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "/") continue;
    const prev = text[i - 1];
    const next = text[i + 1];
    if (
      (prev === undefined || /\s/.test(prev)) ||
      (next === undefined || /\s/.test(next))
    ) {
      return { kind: "struct", reason: READ_ONLY_REASONS.slow };
    }
  }
  return { kind: "flat" };
}

// ─── Trailing chain parser ────────────────────────────────────────────────

/**
 * Walks `.method(args)` calls starting at `from` until it hits the next
 * top-level label, the end of the buffer, or a token that breaks the chain
 * (semicolon, statement-level identifier, etc.). Whitespace, line comments,
 * and block comments inside the chain are tolerated.
 *
 * Returns the list of calls plus the absolute end offset of the chain.
 */
function parseTrailingChain(code, from, hardEnd) {
  const calls = [];
  let i = from;
  while (i < hardEnd) {
    const wsEnd = skipWsAndComments(code, i, hardEnd);
    if (wsEnd >= hardEnd) {
      i = wsEnd;
      break;
    }
    if (code[wsEnd] !== ".") {
      i = wsEnd;
      break;
    }
    let j = wsEnd + 1;
    j = skipWsAndComments(code, j, hardEnd);
    let nameEnd = j;
    while (nameEnd < hardEnd && IDENT_PART_RE.test(code[nameEnd])) nameEnd++;
    if (nameEnd === j) {
      i = wsEnd;
      break;
    }
    const method = code.slice(j, nameEnd);
    let k = nameEnd;
    k = skipWsAndComments(code, k, hardEnd);
    if (code[k] !== "(") {
      // Method-property access without a call — preserve verbatim and
      // stop walking; we don't try to interpret it.
      i = wsEnd;
      break;
    }
    const callClose = findMatchingClose(code, k, "(", ")");
    if (callClose < 0) {
      // Unbalanced — treat the rest as opaque chain text.
      i = hardEnd;
      break;
    }
    calls.push({
      method,
      callStart: wsEnd, // position of the leading `.`
      argStart: k + 1,
      argEnd: callClose,
      callEnd: callClose + 1,
    });
    i = callClose + 1;
  }
  return { calls, end: i };
}

function recoverBankArg(code, call) {
  const argInner = code.slice(call.argStart, call.argEnd);
  const m = /^\s*(['"`])((?:\\.|(?!\1).)*)\1\s*$/.exec(argInner);
  if (!m) return null;
  const innerStart =
    call.argStart + argInner.indexOf(m[1]); // offset of opening quote
  const innerEnd = innerStart + m[1].length + m[2].length + m[1].length;
  return {
    name: m[2],
    argStart: innerStart,
    argEnd: innerEnd,
  };
}

function stripBankFromChain(code, chain, chainStart) {
  if (chain.calls.length === 0) {
    // Capture trailing whitespace too — usually empty for chainless lanes.
    return code.slice(chainStart, chain.end);
  }
  const bank = chain.calls.find((c) => c.method === "bank");
  if (!bank) return code.slice(chainStart, chain.end);
  // Cut the .bank(...) call out, preserving everything else.
  return (
    code.slice(chainStart, bank.callStart) +
    code.slice(bank.callEnd, chain.end)
  );
}

// ─── Block / line bounds ──────────────────────────────────────────────────

// A `$:` lane's chained methods often span multiple lines. The block ends
// at the start of the next top-level label (`name:`), or at end of buffer.
// We look at the start of each subsequent line and stop when we hit
// either a top-level label OR a line that doesn't start with whitespace
// AND doesn't begin with `.` — i.e. a statement-level boundary.
function findBlockEnd(code, lineEnd) {
  let i = lineEnd; // points at '\n' or code.length
  if (i >= code.length) return code.length;
  // Move past current EOL.
  i++;
  while (i <= code.length) {
    const nextEol = indexOfEolOrEnd(code, i);
    const lineText = code.slice(i, nextEol);
    if (!lineText.trim()) {
      // Blank line: tentatively continue (chains often have blank gaps,
      // but very rarely — most patterns are dense). Stop at second blank.
      const followingStart = nextEol + 1;
      if (followingStart >= code.length) return nextEol;
      const nextNextEol = indexOfEolOrEnd(code, followingStart);
      if (!code.slice(followingStart, nextNextEol).trim()) {
        // Two blank lines in a row → end the block at the first blank's EOL.
        return nextEol;
      }
      i = nextEol + 1;
      continue;
    }
    // First non-whitespace character on this line.
    const trimmed = lineText.trimStart();
    const ch = trimmed[0];
    // Continuation-style chain line: starts with `.` after indent, or is
    // an interior comment that the chain wraps around.
    if (ch === "." || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      i = nextEol + 1;
      continue;
    }
    // A new label line starts the next block — stop here.
    if (/^[A-Za-z_$][A-Za-z0-9_$]*\s*:/.test(trimmed)) {
      // End the previous block at the EOL just before this label line.
      return Math.max(0, i - 1);
    }
    // Anything else at column 0 is a statement boundary too (a `var`,
    // `const`, `setcpm(...)` etc.). End the block here.
    return Math.max(0, i - 1);
  }
  return code.length;
}

function indexOfEolOrEnd(code, from) {
  const j = code.indexOf("\n", from);
  return j < 0 ? code.length : j;
}

// ─── Generic scanner helpers ──────────────────────────────────────────────

function skipWs(code, from) {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

function skipWsBackward(code, from) {
  let i = from;
  while (i >= 0 && /\s/.test(code[i])) i--;
  return i;
}

function skipWsAndComments(code, from, hardEnd) {
  let i = from;
  while (i < hardEnd) {
    const ch = code[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      while (i < hardEnd && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < hardEnd - 1 && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(i + 2, hardEnd);
      continue;
    }
    break;
  }
  return i;
}

function findMatchingClose(code, openOffset, openCh, closeCh) {
  let depth = 1;
  let i = openOffset + 1;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < code.length - 1 && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(i + 2, code.length);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = scanString(code, i);
      i = close < 0 ? code.length : close + 1;
      continue;
    }

    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function scanString(code, openOffset) {
  const quote = code[openOffset];
  let i = openOffset + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    i++;
  }
  return -1;
}

function buildLineMap(code) {
  const newlines = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") newlines.push(i);
  }
  return (offset) => {
    let lo = 0,
      hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}
