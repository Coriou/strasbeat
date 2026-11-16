// Pure formatting pipeline shared by the worker and Node tests.
// Never import this module from the page: Prettier must stay off its thread.
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

import * as prettier from "prettier/standalone";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";

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
  const formatted = await prettier.format(code, {
    parser: "babel",
    plugins: [babel, estree],
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
