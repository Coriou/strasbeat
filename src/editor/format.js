// CodeMirror formatting glue. Only the worker may load or run Prettier;
// its pipeline preserves Strudel's meaningful single/double quote distinction.
// The document identity check remains the authority for applying any reply.

import { keymap } from "@codemirror/view";
import { EditorSelection, Facet } from "@codemirror/state";
import { diffChanges } from "./text-diff.js";
import { createFormatClient, FormatSupersededError } from "./format-client.js";

// First format intent starts loading immediately, never during launch. Keep
// Vite's default classic/IIFE worker output: an old window's retired asset
// lease covers this request, but not chunk requests originating in a worker.
const formatClient = createFormatClient({
  createWorker: () => {
    // Dev serves unbundled ES modules and unregisters the service worker,
    // so it needs module semantics and has no retired-cache lease to keep.
    if (import.meta.env.DEV) {
      return new Worker(new URL("./format-worker.js", import.meta.url), {
        type: "module",
      });
    }
    return new Worker(new URL("./format-worker.js", import.meta.url));
  },
});

export async function formatBuffer(code) {
  return formatClient(code);
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
  const first = String(err?.message ?? err)
    .split("\n")[0]
    .trim();
  return first.replace(/^\[strasbeat\/format\]\s*/, "");
}

/**
 * Format the view's buffer and apply the result. Resolves to `true` when the
 * buffer was (or already is) formatted, `false` when the result was dropped
 * or the formatter failed.
 *
 * Formatting is async (the first run also starts the worker), so the
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
    if (err instanceof FormatSupersededError) return false;
    // Surface failures loudly per CLAUDE.md "Surface silent failures
    // loudly" — a parser error here means the formatter saw something it
    // doesn't expect, which the user should know about.
    console.warn("[strasbeat/format] prettier failed:", err);
    reportFormatStatus(view, `format failed: ${describeFormatError(err)}`);
    return false;
  }

  if (view.state.doc !== startDoc) {
    reportFormatStatus(
      view,
      "format skipped — the code changed while formatting",
    );
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
