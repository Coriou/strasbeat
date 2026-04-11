import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  lineNumberMarkers,
} from "@codemirror/view";

const MAX_INLINE_MESSAGE_LENGTH = 120;

const setErrorEffect = StateEffect.define();
const clearErrorEffect = StateEffect.define();

class ErrorLineMarker extends GutterMarker {
  get elementClass() {
    return "cm-error-gutter-marker";
  }
}

class ErrorWidget extends WidgetType {
  constructor(message, indent) {
    super();
    this.message = message;
    this.indent = indent;
  }

  eq(other) {
    return (
      other instanceof ErrorWidget &&
      other.message === this.message &&
      other.indent === this.indent
    );
  }

  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = "cm-error-widget";

    if (this.indent) {
      const indent = document.createElement("span");
      indent.className = "cm-error-widget__indent";
      indent.textContent = this.indent;
      wrap.appendChild(indent);
    }

    const message = document.createElement("span");
    message.className = "cm-error-widget__message";
    message.textContent = truncateInlineMessage(this.message);
    wrap.appendChild(message);

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "cm-error-widget__dismiss";
    dismiss.setAttribute("aria-label", "Dismiss error");
    dismiss.title = "Dismiss error";
    dismiss.textContent = "✕";
    dismiss.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearError(view);
      view.focus();
    });
    wrap.appendChild(dismiss);

    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

const errorLineMarker = new ErrorLineMarker();

const errorStateField = StateField.define({
  create() {
    return null;
  },

  update(value, tr) {
    let next = value;

    if (next && tr.docChanged) {
      next = remapErrorState(next, tr);
    }

    for (const effect of tr.effects) {
      if (effect.is(setErrorEffect)) {
        next = effect.value;
      }
      if (effect.is(clearErrorEffect)) {
        next = null;
      }
    }

    return next;
  },

  provide: (field) => [
    EditorView.decorations.from(field, buildDecorations),
    lineNumberMarkers.from(field, buildLineNumberMarkers),
  ],
});

export const errorMarksExtension = [
  errorStateField,
  EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const errorState = update.startState.field(errorStateField, false);
    if (!errorState) return;
    if (!didTouchErrorLine(update, errorState)) return;
    clearError(update.view);
  }),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target;
      if (!(target instanceof Element)) return false;
      if (!target.closest(".cm-error-gutter-marker")) return false;
      event.preventDefault();
      clearError(view);
      view.focus();
      return true;
    },
  }),
];

export function extractErrorLine(err) {
  if (!err || typeof err !== "object") return null;

  const message = errorMessage(err);
  const loc = err.loc;
  if (loc && typeof loc.line === "number") {
    const line = positiveLine(loc.line);
    if (line) {
      const result = { line, message };
      if (typeof loc.column === "number") {
        result.column = loc.column;
      }
      return result;
    }
  }

  if (!message) return null;

  const miniMatch = message.match(/\[mini\] parse error at line (\d+):\s*(.+)/);
  if (miniMatch) {
    const line = positiveLine(miniMatch[1]);
    if (line) {
      return {
        line,
        message: miniMatch[2].trim() || message,
      };
    }
  }

  const genericMatch = message.match(/\bline (\d+)\b/i);
  if (genericMatch) {
    const line = positiveLine(genericMatch[1]);
    if (line) {
      return { line, message };
    }
  }

  return null;
}

export function setError(view, err) {
  if (!view) return null;
  let extracted = extractErrorLine(err);
  // Fallback: if no line number in the error, try to locate the crashing
  // identifier in the editor content (handles runtime TypeErrors etc.).
  if (!extracted) {
    extracted = findErrorLineInSource(err, view.state.doc);
  }
  if (!extracted) return null;
  const next = buildErrorState(view.state.doc, extracted);
  if (!next) return null;
  view.dispatch({ effects: setErrorEffect.of(next) });
  return extracted;
}

export function clearError(view) {
  if (!view) return;
  view.dispatch({ effects: clearErrorEffect.of(null) });
}

function buildDecorations(value) {
  if (!value) return Decoration.none;
  return Decoration.set(
    [
      Decoration.line({ class: "cm-error-line" }).range(value.from),
      Decoration.widget({
        widget: new ErrorWidget(value.message, value.indent),
        block: true,
        side: 1,
      }).range(value.to),
    ],
    true,
  );
}

function buildLineNumberMarkers(value) {
  if (!value) return RangeSet.empty;
  return RangeSet.of([errorLineMarker.range(value.from)]);
}

function didTouchErrorLine(update, errorState) {
  let touched = false;
  update.changes.iterChangedRanges((fromA, toA) => {
    if (touched) return;
    if (fromA <= errorState.to && toA >= errorState.from) {
      touched = true;
    }
  });
  return touched;
}

function remapErrorState(value, tr) {
  const mappedFrom = tr.changes.mapPos(value.from, -1);
  const clampedFrom = clampDocPos(tr.newDoc, mappedFrom);
  const line = tr.newDoc.lineAt(clampedFrom);
  return {
    ...value,
    line: line.number,
    from: line.from,
    to: line.to,
    indent: leadingWhitespace(line.text),
  };
}

function buildErrorState(doc, info) {
  const line = positiveLine(info.line);
  if (!line || line > doc.lines) return null;

  const lineInfo = doc.line(line);
  const message = info.message || "Unknown error";

  const state = {
    line: lineInfo.number,
    message,
    from: lineInfo.from,
    to: lineInfo.to,
    indent: leadingWhitespace(lineInfo.text),
  };

  if (typeof info.column === "number") {
    state.column = info.column;
  }

  return state;
}

function leadingWhitespace(text) {
  const match = text.match(/^\s*/);
  return match?.[0] ?? "";
}

function truncateInlineMessage(message) {
  const firstLine = errorMessage({ message });
  if (firstLine.length <= MAX_INLINE_MESSAGE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_INLINE_MESSAGE_LENGTH - 3)}...`;
}

function errorMessage(err) {
  const raw =
    typeof err?.message === "string" ? err.message : String(err ?? "");
  let msg = raw.split(/\r?\n/, 1)[0].trim();
  // Strip Strudel's errorLogger "[origin] error: " prefix for cleaner display.
  // Preserves "[mini] parse error at line N" which extractErrorLine needs.
  const prefix = msg.match(
    /^\[(?:eval|query|cyclist|getTrigger|superdough|webaudio|tonal)\]\s*error:\s*/i,
  );
  if (prefix) msg = msg.slice(prefix[0].length);
  return msg;
}

// ─── Content-based heuristic ─────────────────────────────────────────────
// For runtime errors with no line numbers (TypeErrors, ReferenceErrors),
// try to find the crashing identifier in the editor content. Only returns
// a result when the match is unambiguous (exactly one line).

function findErrorLineInSource(err, doc) {
  const message = errorMessage(err);
  if (!message) return null;
  const needle = extractCrashingIdentifier(message);
  if (!needle || needle.length < 2) return null;

  // Use word-boundary matching so "sin" doesn't match inside "sine".
  // Needles that start with "." (property access like ".foo(") are
  // already precise — test them with plain includes.
  const re = needle.startsWith(".") ? null : safeWordBoundaryRe(needle);

  let foundLine = null;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    const hit = re ? re.test(text) : text.includes(needle);
    if (hit) {
      if (foundLine !== null) return null; // ambiguous — bail
      foundLine = i;
    }
  }
  return foundLine ? { line: foundLine, message } : null;
}

function safeWordBoundaryRe(word) {
  // Escape regex metacharacters, then wrap in \b.
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`\\b${escaped}(?=[^\\w]|$)`);
  } catch {
    return null; // degenerate input — caller falls back to includes
  }
}

function extractCrashingIdentifier(message) {
  // "foo.bar.baz is not a function" → ".baz("
  let match = message.match(/\.(\w+)\s+is not a function/i);
  if (match) return `.${match[1]}(`;

  // "baz is not a function" (standalone) → "baz("
  match = message.match(/^(\w+)\s+is not a function/i);
  if (match) return `${match[1]}(`;

  // "baz is not defined" → "baz"
  match = message.match(/(\w+)\s+is not defined/i);
  if (match) return match[1];

  // "Cannot read properties of X (reading 'foo')" → ".foo"
  match = message.match(/Cannot read propert\w* of \w+ \(reading '(\w+)'\)/i);
  if (match) return `.${match[1]}`;

  return null;
}

function positiveLine(value) {
  const line = Number.parseInt(value, 10);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function clampDocPos(doc, pos) {
  if (pos <= 0) return 0;
  if (pos >= doc.length) return doc.length;
  return pos;
}
