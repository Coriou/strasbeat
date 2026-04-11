# 15 — Error Experience

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. Then read this whole file. Phases are ordered — each one
> ships on its own and the next phase assumes the previous is landed.

## Motivation

Strudel's error architecture prioritises resilience: playback never
crashes. The cost is that errors are caught and swallowed at five
different layers — `queryArc()`, the Cyclist tick, `getTrigger()`,
superdough internals, and `getSound()` — and the user sees nothing.
The upstream strudel.cc website shows a single red `<div>` below the
editor on eval failure. That's the entire error UX.

strasbeat already does better: a console panel in the right rail
captures `strudel.log` events, `onEvalError` callbacks, and export
failures, with level filtering, search, and hap inspection. But there
are still critical gaps between "errors exist in the console if you
look" and "errors are in your face, actionable, and disappear when
you fix them":

1. **No inline error highlighting.** Eval errors go to the console
   panel. Nothing highlights the offending line in the editor.
2. **No click-to-jump.** Console entries that carry source location
   data aren't clickable.
3. **No silence detection.** A pattern can evaluate without error but
   produce zero haps (e.g. `sound("not_a_real_name")`). The user
   hears nothing and sees no feedback.
4. **No clear lifecycle.** Error state isn't managed — it's just
   appended to the console log. There's no "current error" concept
   that clears when the problem is fixed.

This spec closes those gaps in three phases.

---

## Upstream error sources (reference for the implementer)

Read these files to understand the error flow you're hooking into.
**Do not modify anything under `strudel-source/`.**

### Error objects the REPL produces

The `onEvalError` callback receives the raw `Error` thrown during
`evaluate()`. Three types are common:

| Source                  | Error shape                                                                                                                                                                                                                                                                                                               | Location data                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **acorn JS parse**      | `SyntaxError` with `.loc: { line, column }` (1-based). Acorn is called with `locations: true` in `strudel-source/packages/transpiler/transpiler.mjs:49`.                                                                                                                                                                  | `.loc.line`, `.loc.column`                  |
| **mini-notation parse** | Re-thrown `Error` from `mini2ast()` in `strudel-source/packages/mini/mini.mjs:196`. Message: `"[mini] parse error at line N: ..."`. Original krill `SyntaxError` has `.location.start` / `.location.end` with `offset`, `line`, `column` — but the re-throw loses structured data and bakes line into the message string. | Parse `err.message` for `/at line (\d+)/`   |
| **Runtime eval**        | Plain `Error` or `TypeError` from the transpiled code executing. Has standard `.stack` with line numbers, but they refer to the `eval()`'d blob, not the original.                                                                                                                                                        | `.message` only; no reliable source mapping |

### The `strudel.log` CustomEvent

`strudel-source/packages/core/logger.mjs` dispatches on `document`:

```js
new CustomEvent("strudel.log", {
  detail: { message: string, type: string, data: object },
});
```

- `type` is `"error"`, `"warning"`, or empty (info).
- Messages are debounced at 1000ms (identical messages within the
  window are dropped).
- `errorLogger(e, origin)` in the same file formats the message as
  `"[${origin}] error: ${e.message}"`. The `origin` tag identifies
  the subsystem: `"cyclist"`, `"query"`, `"getTrigger"`,
  `"superdough"`, `"webaudio"`, `"tonal"`.

### The five swallow points

1. **`queryArc()`** — `strudel-source/packages/core/pattern.mjs:420`.
   Catches any error during pattern query. Returns `[]` (silence for
   that cycle). Logs via `errorLogger(err, 'query')`.

2. **Cyclist tick** — `strudel-source/packages/core/cyclist.mjs:79`.
   Catches errors during hap iteration. Logs via `errorLogger(e)`.
   Fires optional `onError` callback.

3. **`getTrigger()`** — `strudel-source/packages/core/repl.mjs:569`.
   Catches audio trigger callback errors. Logs via
   `errorLogger(err, 'getTrigger')`.

4. **superdough internals** — Missing duck targets
   (`strudel-source/packages/superdough/superdoughoutput.mjs:210`),
   missing modulator targets
   (`strudel-source/packages/superdough/modulators.mjs:65`). Each
   logs via `errorLogger` and continues.

5. **`getSound()`** — `strudel-source/packages/superdough/superdough.mjs:165`.
   Returns `undefined` for unknown names. **No warning, no error.**
   Non-string input gets `console.warn` + fallback to `triangle`.

### What strasbeat currently hooks

- `onEvalError` callback on `StrudelMirror` → routes to
  `consolePanel.error()` (see `src/main.js:222`).
- `document` listener for `strudel.log` → routes to console panel
  by type (see `src/main.js:636`).
- `strudel-logger.js` installs a custom `setLogger()` that filters
  benign deprecation warnings.

### The console panel

`src/ui/console-panel.js` already has:

- `log(msg, data)`, `warn(msg, data)`, `error(msg, data)` API.
- `extractSourceLocation(hap, rawData)` that tries to pull `{ line,
column }` from entry data (lines 576–590).
- Level filtering (log / warn / error toggle buttons).
- Hap inspection for structured data.
- `divider(name)` separating evaluation runs.

---

## Phase 1: Inline editor error decoration

**The highest-impact change.** When an eval error fires, highlight the
offending line in the editor with a red background, a gutter marker,
and an inline error message widget. Clear on next successful eval.

### Design

```
  1 │   setcps(70/60/4)
  2 │
▸ 3 │   s("bd ~ ~ ~").fast(       ← red line background, red gutter dot
  ╰── SyntaxError: Unexpected    ← inline error widget below line 3
       end of input
  4 │
  5 │   s("hh*8")
```

- **Line background:** Full-width red wash using CM6
  `Decoration.line()`. Color: `oklch(0.35 0.08 25)` — barely visible
  in the dark editor, but enough to say "something's wrong here".
  Use the `--rec` token (`oklch(0.65 0.22 25)`) at 15% opacity as a
  starting point and tune by eye.

- **Gutter marker:** A red dot (●) in the line-number gutter on the
  error line. Color: `--rec`. Implemented as a CM6 `gutterMarker`.

- **Inline error widget:** A CM6 `Decoration.widget()` rendered as a
  `<div>` below the error line. Shows the error message (first line
  only — truncate at 120 chars). Styled as monospace, `--rec` color,
  `--text-xs` size, left-padded to align with code indent. A `✕`
  dismiss button clears the decoration (same as clicking in the
  gutter). The widget is `block: true` so it sits on its own line
  below the error.

- **Clear lifecycle:**
  - Cleared on next successful `editor.evaluate()`.
  - Cleared when the user edits the error line (any keystroke that
    changes content on that line).
  - Cleared by clicking the gutter marker or the dismiss button.
  - Cleared on `editor.stop()`.
  - Cleared on pattern switch (left rail selection).
  - **Not** cleared on saves — a saved file can have errors.

### Error → line mapping

Create a utility function `extractErrorLine(err)` that returns
`{ line: number, column?: number, message: string } | null`:

1. If `err.loc` exists and `err.loc.line` is a number (acorn
   `SyntaxError`), return `{ line: err.loc.line, column: err.loc.column, message: err.message }`.
2. If `err.message` matches `/\[mini\] parse error at line (\d+):\s*(.+)/`,
   return `{ line: parseInt($1), message: $2 }`.
3. If `err.message` matches `/line (\d+)/i` (generic fallback),
   return `{ line: parseInt($1), message: err.message }`.
4. Otherwise return `null` (error is real but we can't locate it —
   show it in the console only, no inline decoration; don't guess).

Place this in the new file (`src/editor/error-marks.js`) alongside
the CM6 extension code.

### Implementation

Create a new CodeMirror 6 extension module:

**File: `src/editor/error-marks.js`**

```
Exports:
  - errorMarksExtension   — array of CM6 extensions to include in the editor
  - setError(view, err)   — dispatches error decoration for the given error
  - clearError(view)      — removes all error decorations

Internal:
  - StateField<{ line, column, message } | null> — holds current error
  - StateEffect for set / clear
  - Decoration.line for the red background
  - gutterMarker for the red dot
  - Decoration.widget for the inline message
  - EditorView.updateListener that clears on content changes to the error line
```

The extension must be added to the `StrudelMirror` configuration.
`StrudelMirror` accepts an `extensions` array — add
`errorMarksExtension` there. Check `src/editor-setup.js` for how
existing CM6 extensions are passed.

**Wiring in `src/main.js`:**

In the `onEvalError` callback (currently at line 222), after routing
to the console panel, also call `setError(editor.editor, err)` to
apply the decoration. `editor.editor` is the CM6 `EditorView`.

In the patched `editor.evaluate` (currently at line 672), on
successful eval (after `_editorEvaluate` resolves without throwing),
call `clearError(editor.editor)`.

On pattern switch (left rail `onSelect`), call
`clearError(editor.editor)`.

On `editor.stop()`, call `clearError(editor.editor)`.

### Files to create

- `src/editor/error-marks.js` — the CM6 extension, `setError`,
  `clearError`, and `extractErrorLine`.
- `src/styles/error-marks.css` — styles for the line background,
  gutter marker, and inline widget.

### Files to modify

- `src/main.js` — wire `setError` / `clearError` into `onEvalError`,
  the patched evaluate, pattern switch, and stop.
- `src/editor-setup.js` — include `errorMarksExtension` in the
  extensions array passed to `StrudelMirror`.
- `index.html` — add the CSS import if not using Vite's `?inline`
  import pattern (check how other editor CSS is loaded).

### Acceptance

- Type a syntax error → Ctrl+Enter → the error line gets a red
  background, a red dot in the gutter, and an inline message widget.
- Fix the error → Ctrl+Enter → decorations clear.
- Edit the error line → decorations clear immediately (before eval).
- Click the ✕ on the widget → decorations clear.
- Error also appears in the console panel (existing behavior,
  unchanged).
- No decoration when the error has no extractable line number (e.g.
  generic runtime errors) — console-only in that case.
- Decoration doesn't break mini-notation highlighting, the numeric
  scrubber, hover docs, or any existing CM6 extension.
- Performance: setting/clearing error is O(1) — no full document
  scan.

---

## Phase 2: Console click-to-jump

When a console panel entry carries source location data (line number),
make it clickable. Clicking jumps the editor cursor to that line and
scrolls it into view.

### Design

Error entries that have a parseable line number get a clickable
location badge:

```
12:34:56  ● [eval] error: Unexpected token    [line 3]
                                                ^^^^^^^ clickable
```

The `[line N]` badge is styled as a subtle pill (monospace,
`--surface-2` background, `--text-xs`). On hover, underline +
pointer cursor. On click, the editor scrolls to line N, places the
cursor at the start of that line, and focuses the editor.

### Data flow

The console panel already calls `extractSourceLocation()` internally
for hap cards. Extend that to also run on `error`-level entries:

1. When `consolePanel.error(message, data)` is called, try to
   extract a line number using the same `extractErrorLine` utility
   from Phase 1. The `data` object may carry the original `Error`
   (the `onEvalError` callback passes `{ error: err }`).
2. Also try to parse the message string for `"at line N"` or
   `"line N"` patterns.
3. Store the extracted `{ line, column }` on the entry.
4. When rendering the entry DOM, if a line is present, append the
   clickable badge.

### Callback mechanism

The console panel is a pure-DOM component that doesn't know about the
editor. Add an `onJumpToLine` callback to its constructor options:

```js
const panel = createConsolePanel({
  onFocusEditor,
  onJumpToLine: ({ line, column }) => { ... },
});
```

The host (`src/main.js`) provides the implementation:

```js
onJumpToLine: ({ line, column }) => {
  const view = editor.editor;  // CM6 EditorView
  const lineInfo = view.state.doc.line(line);
  const pos = lineInfo.from + (column ?? 0);
  view.dispatch({
    selection: { anchor: pos },
    scrollIntoView: true,
  });
  view.focus();
},
```

### Files to modify

- `src/ui/console-panel.js` — accept `onJumpToLine` callback; on
  `error()` calls, extract line from the error data; render clickable
  badge on entries with a line; wire click to `onJumpToLine`.
- `src/main.js` — pass `onJumpToLine` when constructing the console
  panel.
- `src/styles/console.css` — style for the line badge (pill, hover
  state).

### Acceptance

- Eval error with a line number → console entry shows `[line N]`
  badge.
- Click badge → editor scrolls to line N, cursor placed, editor
  focused.
- Entries without line data → no badge, no change.
- Works for all three error types: acorn `SyntaxError`, mini-notation
  parse error, and `strudel.log` errors that contain a line reference.

---

## Phase 3: Silence detection + sound validation

The most insidious failure mode: a pattern evaluates without error but
produces no sound. This happens with unknown sound names, broken
chaining, or empty patterns.

### 3a: Post-eval hap probe

After every successful `editor.evaluate()`, run a quick diagnostic:
query the pattern for one cycle and check if it produces any onset
haps.

```js
const pattern = editor.repl?.state?.pattern;
if (pattern) {
  try {
    const haps = pattern.queryArc(0, 1, { _cps: editor.repl.scheduler.cps });
    const onsets = haps.filter((h) => h.hasOnset());
    if (onsets.length === 0) {
      consolePanel.warn(
        "Pattern evaluated but produced no sound events in cycle 0–1. " +
          "Check your sound names and pattern structure.",
      );
    }
  } catch (e) {
    // queryArc itself may throw — that's fine, the cyclist will
    // also catch it and log via errorLogger.
  }
}
```

**Important:** This is a _warning_, not an error. Some patterns
legitimately produce no events in cycle 0 (e.g. patterns that start
with rests, or patterns with very slow tempos). The warning should be
informational and non-blocking — console panel only, no inline
editor decoration. If the pattern is producing events in later
cycles, the scheduler will play them and the user will hear sound
regardless.

**Cost:** One `queryArc` call for a single cycle. This is cheap — the
pattern is already compiled, and querying one cycle is what the
scheduler does on every tick. No audio rendering involved.

### 3b: Sound name validation

After a successful eval, extract sound names from the hap values and
check each against `soundMap`. Warn about unknown sounds with
suggestions.

```js
const soundMapObj = soundMap.get() ?? {};
const unknownSounds = new Set();
for (const hap of onsets) {
  const s = hap.value?.s;
  if (typeof s === "string" && !soundMapObj[s.toLowerCase()]) {
    unknownSounds.add(s);
  }
}
if (unknownSounds.size > 0) {
  for (const name of unknownSounds) {
    const suggestions = strasbeat.findSounds(name).slice(0, 5);
    const msg = suggestions.length
      ? `Sound "${name}" not found. Did you mean: ${suggestions.join(", ")}?`
      : `Sound "${name}" not found. Use strasbeat.findSounds('${name}') in the console to search.`;
    consolePanel.warn(msg);
  }
}
```

**Where to do this:** In the patched `editor.evaluate` in
`src/main.js`, after the successful eval path, after the prewarm
step. The soundMap is populated by then.

**Guard against spam:** If the same unknown sound was warned about in
the previous eval, don't repeat the warning (track a
`Set<string>` of last-warned unknown sounds, reset on eval).

### 3c: Runtime error badge

During playback, `queryArc` and `getTrigger` errors fire as
`strudel.log` events with type `"error"`. These are already routed to
the console panel. Add a small persistent badge to the transport bar
that shows the count of runtime errors since last eval:

```
▶ 120 BPM  ·  cycle 4.2  ·  ⚠ 3 errors
                               ^^^^^^^^^^^ clickable → opens console,
                                            scrolls to first error
```

- Badge appears only when error count > 0.
- Resets to 0 on each successful eval.
- Clicking it activates the console panel in the right rail and
  scrolls to the first error entry.
- Badge color: `--rec` (the error/recording red token).
- Badge disappears on stop.

This requires the console panel to expose a method like
`getErrorCount()` or for `main.js` to maintain the counter directly
(simpler).

### Files to create

(None — all changes are in existing files.)

### Files to modify

- `src/main.js` — add hap probe + sound validation in the patched
  `evaluate()`; add runtime error counter; wire badge.
- `src/ui/transport.js` — add the error badge element and
  `setErrorCount(n)` / `clearErrorCount()` API.
- `src/ui/console-panel.js` — possibly add `scrollToFirstError()`
  method.
- `src/styles/transport.css` — style for the error badge.

### Acceptance

- Evaluate `sound("totally_fake_name")` → console warns with
  "Sound not found" + suggestions.
- Evaluate a pattern that produces no events → console warns about
  empty cycle.
- During playback, if `queryArc` or `getTrigger` errors fire → the
  transport badge shows count.
- Click badge → right rail opens console, scrolls to the first error.
- Badge resets on successful re-eval.
- No false positives for patterns that legitimately start silent
  (e.g. `silence` pattern, rest-heavy patterns).

---

## Out of scope (for this spec)

These are all real and worth doing, but each is a separate spec:

- **Mini-notation lint-as-you-type.** Parsing mini-notation strings
  during editing (before eval) using the krill parser and showing
  squiggly underlines. Requires hooking CM6's lint infrastructure
  into the transpiler's string detection. High complexity.
- **"Did you mean?" for function names.** Fuzzy-matching misspelled
  Strudel functions against the `strudel-docs.json` index.
- **Structured "Problems" panel.** A VS Code-style dedicated error
  panel with severity, categorization, and source location.
  Currently the console panel handles this adequately.
- **Source-mapped runtime errors.** Mapping error line numbers from
  the `eval()`'d transpiled code back to the original pattern source.
  Would require generating source maps in the transpiler.
- **Error recovery hints.** A lookup table of known error patterns
  with fix suggestions (e.g. "did you use double quotes with
  `progression()`?").
- **Per-track error isolation.** When using `$:` block syntax,
  showing errors scoped to the specific track that failed rather than
  the whole pattern.

---

## Implementation notes

### CM6 extension architecture

Use `StateField` + `StateEffect` for managing error state, not
`ViewPlugin`. The error is set/cleared by external code (main.js),
not by editor events, so a `StateField` is the right primitive.

The field holds `{ line, column, message } | null`.

Derive three decoration sources from the field:

1. `EditorView.decorations` — the line background via
   `Decoration.line()`.
2. `gutter()` — the red dot marker.
3. `EditorView.decorations` — the widget via
   `Decoration.widget({ block: true, side: 1 })`.

Use `EditorView.updateListener` to watch for content changes: if the
user edits the error line, dispatch a clear effect.

### CSS strategy

Add a new `src/styles/error-marks.css` with these classes:

- `.cm-error-line` — the line background (applied by CM6 decoration).
- `.cm-error-gutter-marker` — the gutter dot.
- `.cm-error-widget` — the inline message block.
- `.cm-error-widget__message` — the error text.
- `.cm-error-widget__dismiss` — the ✕ button.

Import it in the same way the other editor styles are loaded. Check
`src/styles/editor.css` and `index.html` for the pattern.

### Color tokens

Use the existing `--rec` token for error red. For the line background,
use `--rec` at low opacity (try `oklch(0.35 0.08 25 / 0.15)` or
calculate from `--rec` with alpha).

### Testing

Error extraction is the most logic-dense part. Add a test file
`src/editor/error-marks.test.js` with cases for:

- acorn `SyntaxError` with `.loc` → correct line extraction.
- Mini-notation `"[mini] parse error at line 5: ..."` → line 5.
- Generic error with no line data → returns `null`.
- Message with `"line"` in a non-location context (e.g.
  `"timeline not found"`) → doesn't false-match. Use a tight regex
  like `/\bline (\d+)\b/i` and reject if the number is 0.

### Performance notes

- `setError` and `clearError` dispatch CM6 transactions — these are
  O(size of decorations), which is O(1) since we only ever have 0 or
  1 error at a time.
- The hap probe in Phase 3 calls `queryArc(0, 1)` once per eval.
  This is the same work the scheduler does every tick — negligible.
- Sound name validation iterates the haps from one cycle against the
  soundMap (a plain object lookup). Negligible.
- The runtime error counter in Phase 3c increments on each
  `strudel.log` error event — O(1) per event.

---

## Reading list for the implementer

Before starting, read (in this order):

1. `CLAUDE.md` — project conventions, architecture, gotchas.
2. `design/SYSTEM.md` — color tokens (especially `--rec`), spacing,
   type scale.
3. `src/main.js` lines 210–240 (the `StrudelMirror` construction and
   `onEvalError`) and lines 636–660 (the `strudel.log` listener) and
   lines 670–740 (the patched `evaluate()`).
4. `src/editor-setup.js` — how CM6 extensions are configured.
5. `src/ui/console-panel.js` — the existing console panel API.
6. `src/ui/transport.js` — the transport bar API.
7. `src/styles/tokens.css` — the `--rec` token.
8. `strudel-source/packages/core/logger.mjs` — the error event flow
   (read only, do not modify).
9. `strudel-source/packages/core/pattern.mjs:420` — the
   `queryArc()` swallow point (read only).
10. `strudel-source/packages/mini/mini.mjs:193` — the mini-notation
    error re-throw (read only).
11. `strudel-source/packages/transpiler/transpiler.mjs:46` — acorn
    parse with `locations: true` (read only).
