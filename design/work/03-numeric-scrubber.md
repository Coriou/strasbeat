# 03 — Inline numeric scrubber

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. This task is editor-side: a CodeMirror 6 decoration that
> attaches a drag affordance to numeric literals in the editor. The
> editor's CodeMirror `extensions` are fair game per `SYSTEM.md` §11;
> nothing else in `main.js` should be touched.

## Goal

Every numeric literal in the editor source — `0.5` in `.gain(0.5)`,
`0.9` in `.room(0.9)`, `4` in `.fast(4)` — becomes **draggable**.
Click-and-drag horizontally to change the value live. The pattern re-
evaluates as you drag, so you *hear* the change as it happens.

This is the single highest "feels like a real music tool" gesture in
the whole project. It is also entirely contained in the editor — no
shell changes needed, no dependencies on other specs.

## Why

For a tool whose UI is code, dragging numbers turns parameters into
instruments. It also bridges the cultural gap between "code is the
source of truth" (Strudel's ethos) and "tactile, hands-on adjustment"
(what a musician needs). Both are preserved: the source updates as you
drag, so the source stays authoritative — the gesture is just an
ergonomic shortcut for editing the source.

This is **principle 8** from `SYSTEM.md` §2: numerical drag-to-scrub is
a core interaction, not a polish item.

## Approach

### CodeMirror 6 decoration

- Use a `ViewPlugin` to scan visible numeric literals on every doc
  change and viewport change. Attach `Decoration.mark` (for hover
  styling) and a small `Decoration.widget` (for the drag handle) to
  each.
- **Use the parsed AST**, not regex. Get the syntax tree from the
  CodeMirror language extension (`syntaxTree(view.state)`) and walk it
  for `Number` literal nodes. This is the only way to correctly skip:
  - Numbers inside **strings** (mini-notation: `"0 1 2 3"`)
  - Numbers inside **comments** (`// 4 bars`)
  - Numbers inside **template literals** (the entire pattern body in
    pattern files!)
  - Numbers inside expressions like `setcps(160/60/4)` — see below.
- **Only scrub direct-argument numeric literals.** That is: a `Number`
  literal whose immediate parent is the `arguments` of a `CallExpression`.
  - `gain(0.5)` ✓ — `0.5` is a direct argument
  - `room(0.9)` ✓
  - `fast(4)` ✓
  - `setcps(160/60/4)` ✗ — the numbers are inside an arithmetic
    expression, not direct arguments. Dragging them would corrupt the
    formula.
  - `range(0, 0.6)` ✓ for both — both are direct arguments
  - `[0.5, 1.0, 0.7]` — currently out of scope (array literals); add
    later if useful.

### Interaction model

- **Default drag**: change by ~1% of the **current value** per pixel for
  floats, by 1 per pixel for integers. Snap to one decimal place by
  default.
- **Shift-drag**: fine. ~0.1% per pixel; snap to 3 decimals.
- **Cmd / Meta-drag**: coarse. ~10% per pixel; snap to integer if value
  is > 1, else snap to 0.05.
- **Click without drag**: do nothing — let the click fall through to
  CodeMirror so the user can place a cursor in the literal to type-edit.
- The drag affordance is a **1px-wide invisible hit zone immediately to
  the right of the literal**, not on top of it. Cursor changes to
  `ew-resize` on hover. If the hit zone is too narrow to land on
  reliably, widen it to 4–6px but make it visually transparent.
- During drag, the pattern re-evaluates **debounced at one evaluation
  per animation frame max** (use `requestAnimationFrame` for the dispatch).
- Releasing the drag commits the transaction. Undo (`Mod-z`) reverts the
  whole drag as a single step. Use a CodeMirror transaction with
  `userEvent: 'scrub'` and group changes inside a single dispatch where
  possible.

### Visual feedback

- On **hover** (cursor in the hit zone): the literal gets a subtle
  underline in `--accent-wash`.
- During **drag**: the literal switches color to `--accent`, and a tiny
  chip appears just above it showing the live value (e.g. "0.482") so
  the user doesn't have to track tiny digits while scrubbing. The chip
  is a CodeMirror decoration `Widget` rendered with `--surface-2`,
  `--shadow-pop`, `--radius-sm`, and `text-xs` from the design system.

## Files

- `src/editor/numeric-scrubber.js` — the CM6 plugin. Exports a single
  `numericScrubber` extension (likely a `ViewPlugin.fromClass(...)`
  combined with a `Decoration` field).
- `src/main.js` — add `numericScrubber` to the editor's `extensions`
  array. **Only** that line. Same scope rule as before.
- `src/styles/scrubber.css` (or inline in `style.css`) — the underline,
  chip, and cursor styles. All use the design tokens.

## Acceptance

- [ ] Dragging `0.5` in `.gain(0.5)` changes the value smoothly and the
      audio responds in real time.
- [ ] Numbers inside `"..."`, `'...'`, and `` `...` `` (mini-notation,
      template literals, comments) are NOT decorated and NOT draggable.
- [ ] Numbers inside `setcps(...)` (or any nested arithmetic) are NOT
      draggable. Verified specifically against `setcps(160/60/4)` from
      `patterns/05-chords.js`.
- [ ] Numbers that ARE direct arguments (e.g. `range(0, 0.6)`,
      `gain(0.5)`, `room(0.9)`, `fast(4)`) ARE draggable.
- [ ] Shift and Cmd/Meta modifiers change the drag granularity as
      specified.
- [ ] Click without drag does NOT change the value (cursor lands in
      the literal as normal).
- [ ] One drag = one undo step.
- [ ] No console errors during dragging; no editor lag at 60Hz updates.
- [ ] Dragging works correctly when the literal contains a leading
      minus sign (`gain(-0.5)`) — either include the minus in the
      decoration, or document that signed literals aren't yet supported.

## Validation

1. Open `patterns/05-chords.js`, drag the `0.9` in `.room(0.9)`. Audio
   should change in real time.
2. Try to drag the `4` in `setcps(160/60/4)`. It should NOT decorate
   and NOT respond to drag.
3. Try to drag a number inside the chord-string literal `"<C^7 Fo7
   C^7 F#>"`. Same — no decoration.
4. Press undo after a drag. The literal should snap back to its
   original value in one step.

## Out of scope

- Color-picker decorations (we have no color literals in patterns).
- Drag for *non*-literal expressions (variables, function calls,
  template-literal interpolations).
- A property-panel sidebar showing all values — that's the right rail
  in v2.
- Cross-cursor scrubbing (drag one literal, all matching literals
  change). Cute idea, separate ticket.
