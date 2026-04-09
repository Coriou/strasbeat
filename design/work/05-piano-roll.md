# 05 — Real piano roll

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. This task replaces the **renderer** of the existing
> 180px canvas in the bottom panel of the shell with one that fits the
> design system. **Depends on `01-shell.md` being landed** (the bottom
> panel structure is part of the new shell). It does not depend on the
> other editor specs.

## Goal

The current piano roll (drawn by `drawPianoroll` from `@strudel/draw`)
is a default Strudel visualisation — it looks like a generic Strudel
app, not like strasbeat. Replace it with a custom renderer that:

1. Uses the design-system colors and typography (`SYSTEM.md` §4 §5).
2. Shows a proper **grid** (cycles, beats, sub-beats) with subtle
   gridlines.
3. Has a **playhead** that moves smoothly (not stuttering frame-by-
   frame).
4. **Per-line color**: each top-level layer of `stack(...)` in the
   source gets a distinct color, so you can visually identify which
   line of source produced which note.
5. **Click-to-locate**: clicking a note in the roll highlights the line
   in the source editor that produced it. (Just selects the line — full
   bidirectional editing is `06-future.md`.)

## Approach

### Wiring

The existing `onDraw` callback inside the `StrudelMirror` constructor
in `src/main.js` is wired up like this:

```js
onDraw: (haps, time) =>
  drawPianoroll({ haps, time, ctx: drawCtx, drawTime, fold: 0 }),
```

The whole `editor` construction and the `onDraw` callback's *connection*
to it are off-limits per `SYSTEM.md` §11. **What you can change is the
body of the callback**: replace the call to `drawPianoroll(...)` with a
call to your own `renderRoll({ haps, time, ctx: drawCtx, drawTime, view: editor.repl.editorView })`.

That's the *only* edit inside `main.js`. Everything else lives in a new
file.

### Renderer

- A normal Canvas2D function. **No SVG, no DOM elements per note** — at
  high cycle counts there can be hundreds of haps, and per-element DOM
  thrashing kills the framerate.
- HiDPI handling: keep the existing `dpr` resize logic (already in
  `main.js`'s resize block); the renderer should accept a context whose
  scale is already set up.
- Clear the canvas at the start of each frame.

### Reading source locations from haps

Each `hap` from Strudel comes with a `context` field that *should*
include source location info — Strudel uses this to highlight the
currently-playing source line in its own visualisations. **Inspect the
hap shape at runtime** before designing the per-line coloring:

```js
// drop a breakpoint or console.log inside onDraw and look at:
console.log(haps[0]);
console.log(haps[0]?.context);
```

The location info is typically `hap.context.locations` as an array of
`{ start, end }` ranges into the source. Group haps by their first
location (or by which top-level argument of `stack()` they originated
from — that's the more semantic grouping but harder to derive). If
location info isn't present or is hard to map back to source lines,
fall back to coloring by `hap.value.s` (the sound name) so at least
different sounds are visually distinguishable.

### Click-to-locate

- Maintain a hit map of `{ x, y, w, h, sourceRange }` updated each
  frame as notes are drawn.
- On canvas click, find the hit and dispatch a CodeMirror selection
  via `editor.repl.editorView.dispatch({ selection: ... })`. This
  uses the editor's public-ish API; if it doesn't exist on the version
  of CM bundled with Strudel, fall back to the equivalent through the
  existing `editor` instance.
- The hit map should be cheap to query (O(n) over visible haps is fine
  — there's never that many on screen at once).

## Visual spec

- **Background**: `--surface-1` (matches the rest of the bottom panel).
- **Gridlines**:
  - **Beat lines**: 1px solid `--border-soft`.
  - **Cycle lines**: 1px solid `--border` (heavier, every cycle).
- **Note pills**: rounded rect (`--radius-sm`), filled with the per-
  line color at 80% opacity, 1px border at 100%. Per-line colors should
  rotate through a small, design-system-friendly palette derived from
  the accent — e.g. accent / accent-hi / accent-lo / a couple of muted
  greys, ~5–6 colors total. Don't use the rainbow.
- **Playhead**: 1px vertical line in `--accent`, optionally with a
  subtle radial-gradient glow ~6px wide. The playhead position is
  `time` from the callback args, mapped through `drawTime` to canvas
  x-coordinates.
- **Beat / cycle labels**: `text-xs` size, `--text-dim` color, in the
  bottom margin (~12px reserved at the bottom of the canvas). Show
  cycle numbers at every cycle line; hide beat labels at high zoom
  levels to avoid crowding.

## Files

- `src/ui/piano-roll.js` — the renderer. Exports
  `renderRoll({ haps, time, ctx, drawTime, view })`.
- `src/main.js` — *only* the body of the `onDraw` callback. Replace the
  `drawPianoroll(...)` call with `renderRoll(...)`. Do not touch the
  surrounding `editor` construction, the `drawTime` array, the
  `resizeCanvas` logic, or the `dpr` handling.

## Acceptance

- [ ] Looks like part of the new design system, not like a default
      Strudel canvas.
- [ ] Playhead moves smoothly during playback (no jitter, no missed
      frames at 60Hz). Verify on a busy pattern like
      `patterns/05-chords.js` or whichever has the most haps.
- [ ] Multi-layer patterns (e.g. anything using `stack(...)`) show each
      layer in its own color. The mapping from layer to color is
      stable (same layer → same color across redraws).
- [ ] Clicking a note in the roll moves the editor cursor to (and
      highlights) the source line that produced it.
- [ ] Resizing the bottom panel via the divider drag handle (from
      `01-shell.md`) reflows the canvas correctly without distortion.
- [ ] No frame drops at 60Hz with patterns that emit dozens of haps per
      cycle.
- [ ] No regression to existing playback/visualisation — the editor
      still re-evaluates and the audio still plays.

## Out of scope

- **Bidirectional editing** (drag-to-edit notes in the roll). That's
  `06-future.md`.
- **Multi-track timeline** view. That's also future.
- Anything that requires touching `main.js` outside the `onDraw`
  callback body.
- Replacing the canvas with a different rendering technology (WebGL,
  Pixi, etc.). Canvas2D is the right tool for the data volumes we have.
- A separate "minimap" or zoomed-out overview.

## Notes

- Strudel's own `drawPianoroll` source is in
  `strudel-source/packages/draw/`. **Read it for reference** to
  understand the hap shape and the typical layout, but don't copy its
  visual choices — those are exactly the ones we're moving away from.
- If Strudel's hap context doesn't expose source locations cleanly,
  the per-line coloring degrades to per-sound coloring, which is still
  better than monochrome. Document the fallback in a comment.
