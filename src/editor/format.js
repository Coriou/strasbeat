// Prettier wrapper + a CodeMirror keymap that runs it on demand.
//
// Why dynamic import: prettier/standalone + the babel + estree plugins are
// ~700KB unminified, big enough that pulling them into the main bundle would
// dominate first paint. We `await import()` on first use so they show up as
// a separate Vite chunk and only load when the user actually triggers
// formatting (Cmd/Ctrl+Shift+F).
//
// Why babel + estree: in Prettier v3 the babel parser must be paired with
// the estree printer — the babel package only ships parsers, not printers.
// Forgetting estree gives "no printer for estree" at format time.
//
// Why we post-process Prettier's output: Strudel's transpiler discriminates
// double-quoted strings from single-quoted ones (`node.raw[0] === '"'` in
// strudel-source/packages/transpiler/plugin-mini.mjs). Double-quoted strings
// are treated as mini-notation and wrapped in `mini(...)`; single-quoted
// strings are passed through verbatim. So `s("bd*4")` and `s('bd*4')` are
// NOT equivalent at runtime — the former plays a kick, the latter passes
// the literal string `'bd*4'` into the synth and produces no audible output.
// Prettier has no "preserve quotes" option (singleQuote: true|false flips
// the bug rather than fixing it), so we restore the original quote of every
// string literal in a post-processing pass after Prettier has rewritten the
// JS structure.

import { keymap } from "@codemirror/view";
import { EditorSelection, Facet } from "@codemirror/state";
import { diffChanges } from "./text-diff.js";

let prettierModulesPromise = null;

async function loadPrettier() {
  if (!prettierModulesPromise) {
    prettierModulesPromise = Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]).then(([prettier, babel, estree]) => ({
      prettier,
      plugins: [babel, estree],
    }));
  }
  return prettierModulesPromise;
}

/**
 * Walk a chunk of JS source and yield every string literal as
 * `{ quote, body, start, end }`.
 *
 * - `quote` is the literal opening character (`'`, `"`, or `` ` ``).
 * - `body` is the raw, still-escaped contents between the quotes.
 * - `start`/`end` are absolute byte offsets into `source` covering the
 *   *whole* literal including its delimiters (so `source.slice(start, end)`
 *   round-trips).
 *
 * The walker is hand-written rather than regex-based because regex either
 * misses escapes or false-matches across newlines, and the cost of getting
 * a single literal wrong here is silent corruption of mini-notation.
 *
 * Comment skipping is approximate but sufficient for our use: we don't try
 * to detect regex-literal contexts (Strudel patterns don't use regex).
 *
 * Template literals are yielded whole (body = raw text including any
 * `${...}` interpolations). The string literals *inside* an interpolation
 * are real JS strings that Prettier re-quotes like any other, so the walker
 * descends into `${...}` and yields those too, before the enclosing template.
 *
 * Exported so the round-trip test under scripts/test-format.mjs can use the
 * same walker the formatter does — keeping them in sync prevents drift
 * between what the test asserts and what the formatter restores.
 */
export function* iterateStringLiterals(source) {
  yield* scanCode(source, 0, false);
}

// Scan JS code starting at `i`. With `untilBrace` set we are inside a
// template interpolation and stop after the `}` that closes it (tracking
// nested braces so an object literal or arrow body doesn't end it early).
// Returns the index scanning stopped at.
function* scanCode(source, i, untilBrace) {
  const n = source.length;
  let depth = 0;
  while (i < n) {
    const c = source[i];

    // Line comment.
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    // Block comment.
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n - 1 && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    if (untilBrace) {
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) return i + 1;
        depth--;
      }
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = i;
      i++;
      let body = "";
      while (i < n) {
        const ch = source[i];
        if (ch === "\\") {
          body += ch + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        if (quote === "`" && ch === "$" && source[i + 1] === "{") {
          const exprEnd = yield* scanCode(source, i + 2, true);
          body += source.slice(i, exprEnd);
          i = exprEnd;
          continue;
        }
        body += ch;
        i++;
      }
      yield { quote, body, start, end: i };
      continue;
    }

    i++;
  }
  return i;
}

/**
 * Re-emit a string literal body using a different quote character. Handles
 * escape pairs both ways: an escaped `from` quote inside the body becomes
 * an unescaped raw quote (no longer reserved); a raw `to` quote inside the
 * body has to gain a backslash escape so the new delimiter still parses.
 *
 * Backslash sequences other than `\\` + the from-quote are passed through
 * unchanged so things like `\n`, `\t`, and `\\` survive verbatim.
 */
function reQuote(body, from, to) {
  if (from === to) return from + body + from;
  let out = "";
  let j = 0;
  while (j < body.length) {
    const ch = body[j];
    if (ch === "\\") {
      const next = body[j + 1];
      if (next === from) {
        // \" → "  when swapping " for '
        out += from;
        j += 2;
        continue;
      }
      // Pass through any other escape sequence verbatim.
      out += ch + (next ?? "");
      j += 2;
      continue;
    }
    if (ch === to) {
      out += "\\" + to;
      j++;
      continue;
    }
    out += ch;
    j++;
  }
  return to + out + to;
}

/**
 * Walk `formatted` and rewrite each non-backtick string literal so its
 * quote character matches the corresponding entry in `originalQuotes`
 * (positional, in source order).
 *
 * Backticks are skipped because Prettier never converts `` ` `` to `'`/`"`
 * (verified empirically against Prettier 3.8 and the babel printer), and
 * because Strudel's mini-notation walker treats untagged backtick strings
 * as mini-notation too — so leaving them alone is both safe and correct.
 *
 * Throws if the count of swappable literals doesn't match what we
 * extracted from the source. That would mean Prettier added or removed a
 * string literal during formatting, which we don't expect and which would
 * make the positional mapping unsafe.
 */
function restoreOriginalQuotes(formatted, originalQuotes) {
  const literals = [];
  for (const lit of iterateStringLiterals(formatted)) {
    if (lit.quote !== "`") literals.push(lit);
  }
  if (literals.length !== originalQuotes.length) {
    throw new Error(
      `[strasbeat/format] string-literal count changed during formatting (${originalQuotes.length} → ${literals.length}); refusing to restore quotes`,
    );
  }

  // Build the result by stitching the formatted text together with rewritten
  // literal slices. Walking literals in order means each splice cursor moves
  // monotonically forward, so the result stays in O(n).
  let result = "";
  let cursor = 0;
  for (let k = 0; k < literals.length; k++) {
    const lit = literals[k];
    const expected = originalQuotes[k];
    if (lit.quote === expected) continue;
    result += formatted.slice(cursor, lit.start);
    result += reQuote(lit.body, lit.quote, expected);
    cursor = lit.end;
  }
  result += formatted.slice(cursor);
  return result;
}

/**
 * Run Prettier over a Strudel pattern source string. Throws on parse error.
 *
 * Config notes:
 * - `semi: false` matches the existing pattern style (no trailing semicolons).
 * - `singleQuote` is intentionally NOT set: Prettier's default (false → all
 *   double) and the alternative (true → all single) both flip half the
 *   patterns into broken mini-notation. We rebuild every literal's quote
 *   from the original via `restoreOriginalQuotes` afterwards.
 * - `printWidth: 80` is wide enough that long method chains keep one method
 *   per line, which is exactly how patterns are already authored.
 */
export async function formatBuffer(code) {
  const { prettier, plugins } = await loadPrettier();
  const formatted = await prettier.format(code, {
    parser: "babel",
    plugins,
    printWidth: 80,
    semi: false,
    trailingComma: "all",
    // Prettier's default ("as-needed") strips the quotes off object keys
    // that are valid identifiers. That removes a string literal, which
    // breaks the positional quote restoration below — and the key's quote
    // style is the author's business anyway.
    quoteProps: "preserve",
  });

  // Snapshot the original quote characters in source order so we can put
  // them back. We extract from `code` (the *input*) rather than re-using a
  // pre-computed list passed in by the caller — keeps the API simple and
  // makes formatBuffer idempotent without external state.
  const originalQuotes = [];
  for (const lit of iterateStringLiterals(code)) {
    if (lit.quote !== "`") originalQuotes.push(lit.quote);
  }
  return restoreOriginalQuotes(formatted, originalQuotes);
}

// Map each old cursor to (lineNumber, columnInLine), then re-resolve those
// against the formatted text. Lines may shift in absolute offset due to
// whitespace normalisation, but staying on the same line + column-within-line
// is what "preserve cursor position within the line where possible" means in
// the spec. Multi-cursor selections are handled too — each range maps
// independently and we collapse to single cursors (selections inside the
// formatted region rarely make sense after a reformat anyway).
export function computeNewSelection(oldSelection, oldDoc, formatted) {
  const newLines = formatted.split("\n");
  // Pre-compute line start offsets in the new doc for O(1) lookup per range.
  const lineStarts = new Array(newLines.length);
  lineStarts[0] = 0;
  for (let i = 1; i < newLines.length; i++) {
    lineStarts[i] = lineStarts[i - 1] + newLines[i - 1].length + 1;
  }

  const newRanges = oldSelection.ranges.map((range) => {
    const line = oldDoc.lineAt(range.head);
    const lineIdx = Math.min(line.number - 1, newLines.length - 1);
    const col = range.head - line.from;
    const newCol = Math.min(col, newLines[lineIdx].length);
    return EditorSelection.cursor(lineStarts[lineIdx] + newCol);
  });
  return EditorSelection.create(newRanges);
}

/**
 * Where format outcomes the user should see are reported: a formatter error
 * (usually a syntax error in the buffer) or a result dropped because the
 * buffer changed underneath it. The host provides `(message) => void` — in
 * strasbeat that is the transport status line. Without a sink the outcome
 * still reaches the devtools console.
 */
export const formatStatus = Facet.define();

function reportFormatStatus(view, message) {
  for (const sink of view.state.facet(formatStatus)) {
    try {
      sink(message);
    } catch (err) {
      console.warn("[strasbeat/format] status sink failed:", err);
    }
  }
}

// Prettier's syntax errors carry a multi-line code frame; the status line
// only has room for the headline.
function describeFormatError(err) {
  const first = String(err?.message ?? err).split("\n")[0].trim();
  return first.replace(/^\[strasbeat\/format\]\s*/, "");
}

/**
 * Format the view's buffer and apply the result. Resolves to `true` when the
 * buffer was (or already is) formatted, `false` when the result was dropped
 * or the formatter failed.
 *
 * Formatting is async (the first run also lazy-loads Prettier), so the
 * document can change while it is in flight: the user keeps typing, or
 * switches tab and the view now holds a different pattern entirely. The
 * formatted text only describes the document it was computed from, so it is
 * applied only if that exact document is still the live one.
 *
 * `format` is injectable for tests.
 */
export async function runFormat(view, format = formatBuffer) {
  const startDoc = view.state.doc;
  const code = startDoc.toString();

  let formatted;
  try {
    formatted = await format(code);
  } catch (err) {
    // Surface failures loudly per CLAUDE.md "Surface silent failures
    // loudly" — a parser error here means the formatter saw something it
    // doesn't expect, which the user should know about.
    console.warn("[strasbeat/format] prettier failed:", err);
    reportFormatStatus(view, `format failed: ${describeFormatError(err)}`);
    return false;
  }

  if (view.state.doc !== startDoc) {
    reportFormatStatus(view, "format skipped — the code changed while formatting");
    return false;
  }
  if (formatted === code) return true;

  // Dispatch only the characters that differ (see text-diff.js). The
  // selection, scroll position and Strudel's highlight/slider decorations
  // all map through the changes, so there is nothing to restore by hand.
  view.dispatch({
    changes: diffChanges(code, formatted),
    userEvent: "input.format",
  });
  return true;
}

export const formatCommand = (view) => {
  // Returning true claims the binding even though the actual format runs
  // async — otherwise CM6 would let the keystroke fall through to the
  // browser, and on most platforms Cmd-Shift-F triggers full-text search.
  runFormat(view);
  return true;
};

export const formatExtension = keymap.of([
  { key: "Mod-Shift-f", run: formatCommand, preventDefault: true },
]);
