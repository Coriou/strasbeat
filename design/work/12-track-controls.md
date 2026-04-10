# 12 — Track mute / solo controls

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. Then read this whole file. This adds **interactive track
> control** — mute, solo, and keyboard shortcuts — without introducing
> any runtime state outside the editor text. The source of truth is
> always the code.

## Where this came from

strasbeat patterns use Strudel's label syntax (`lead:`, `drums:`,
`$:`) to register independent layers. The piano roll already groups
haps by source location and color-codes them, which means the app
_visually_ knows about "tracks" — but there's no way to mute, solo,
or interact with them without manually editing the label text.

Strudel already has clean, built-in conventions for this:

| Want | Syntax               | Mechanism                          |
| ---- | -------------------- | ---------------------------------- |
| Mute | `lead_:` or `_lead:` | `.p()` sees underscore → `silence` |
| Solo | `Slead:`             | Only `S`-prefixed patterns play    |

These work today if you type them by hand. This spec adds UI and
keyboard affordances that perform the same text rewrites automatically.

## Non-goals

- **No runtime shadow state.** Mute/solo state lives in the editor text,
  not in a side Map. `git diff` captures it. The WAV exporter picks it up.
  What you see in the code is what you hear.
- **No mixer / gain sliders (yet).** Those require injecting `.gain()`
  calls into the chain, which is a harder text-rewrite problem. Phase 2.
- **No per-track FX.** Same story — phase 2 or later.
- **No changes to Strudel's `.p()`, scheduler, or transpiler.** We work
  entirely through the existing underscore / `S`-prefix conventions.

## Architecture

### Label parsing

A small utility function scans the current editor text and returns an
ordered list of labeled pattern blocks:

```js
// parseLabels(code: string) → Label[]
// Label = { name: string, line: number, col: number, muted: boolean, soloed: boolean }
```

Rules:

- A label is any JavaScript labeled statement at the top level:
  `foo:`, `$:`, `Sfoo:`, `foo_:`, `_foo:`.
- `muted` is true when the name starts or ends with `_` (after
  stripping the `S` prefix if present).
- `soloed` is true when the raw label starts with `S` (and the name
  after `S` doesn't start/end with `_`).
- The `name` field is the clean name: strip leading `S`, strip
  leading/trailing `_`. So `Slead_:` → `{ name: 'lead', muted: true, soloed: true }`.
- `$` labels keep their `$` as the name (they render as `$1`, `$2`, etc.
  in the legend based on order of appearance).

This function is pure (string in → data out) and testable without a
browser.

### Text rewrite helpers

Two functions that take the current editor text and a label name, and
return the new text:

```js
toggleMute(code: string, name: string) → string
toggleSolo(code: string, name: string) → string
```

**`toggleMute`**: finds the label statement for `name` and toggles the
trailing `_`. If it's currently `lead:`, rewrite to `lead_:`. If it's
`lead_:`, rewrite to `lead:`. Also handles the `_lead:` form. If muting
was just the `_` prefix, toggle that. Preserve the `S` prefix if
present (solo + mute is a valid state in Strudel: `Slead_:` → the
pattern is both soloed and muted, meaning it's effectively silent).

**`toggleSolo`**: finds the label statement for `name` and toggles the
`S` prefix. If it's currently `lead:`, rewrite to `Slead:`. If it's
`Slead:`, rewrite to `lead:`. Preserve the trailing `_` if present.

Both functions return the full modified source string. The caller is
responsible for pushing it into the editor and re-evaluating.

### Keyboard shortcuts

| Key                        | Action                             |
| -------------------------- | ---------------------------------- |
| `Cmd+M` (macOS) / `Ctrl+M` | Toggle mute on the label at cursor |
| `Cmd+Shift+S`              | Toggle solo on the label at cursor |

"Label at cursor" means: find the nearest label statement that contains
the cursor line. If the cursor is between two labels, use the one
above (the label "owns" all lines until the next label). If the cursor
is before the first label (e.g. on the `setcpm(...)` line), do nothing.

The keybinding calls `toggleMute` / `toggleSolo`, dispatches the new
text into the editor via CM6's `dispatch` (as a single transaction so
undo works), and re-evaluates. This is the same pattern the formatter
uses — see `src/editor/format.js` for precedent.

Add these to `src/editor/keymap.js` alongside the existing shortcuts.

### Piano roll track legend

A horizontal strip at the **top** of the piano roll canvas (inside the
existing `renderRoll` draw call, not a new DOM element). For each
distinct layer visible in the current haps:

```
┌──────────────────────────────────────────────────────────┐
│ ● lead   ● chorus   ● $1   ● $2                         │  ← legend strip
├──────────────────────────────────────────────────────────┤
│                    (existing piano roll)                  │
└──────────────────────────────────────────────────────────┘
```

Each legend entry:

- **Color dot** matching the layer's palette color.
- **Label name** in `--font-mono` at `--text-xs` size.
- **Muted state**: if the label ends with `_`, render the name with
  `0.35` opacity and a strikethrough.
- **Soloed state**: if the label starts with `S`, render a small `S`
  badge or underline in `--accent`.
- **Click to mute**: single click on a legend entry toggles mute
  (same as `Cmd+M`).
- **Shift+click to solo**: shift-click toggles solo (same as
  `Cmd+Shift+S`).

The legend strip is a fixed height (e.g. 20px) reserved at the top of
the canvas, pushing the existing note content down by the same amount.
When no labeled patterns are active (empty editor, error state), the
legend strip is hidden and the full height goes to notes.

**Deriving the label name from haps**: each hap's `context.locations`
gives us a source char offset. We can match this offset against the
parsed labels (which have line/col → char offset) to find which label
owns each hap group. For `$:` patterns, the auto-index (`$0`, `$1`)
comes from order of appearance.

Alternatively, Strudel's `applyPatternTransforms` already calls
`.withState(state => state.setControls({ id: key }))` on each
registered pattern, so haps may carry their label `id` in the query
state's controls. If this surfaces on the hap object (needs
verification at runtime), that's the cleanest way to derive the name.
If not, the source-location → label mapping is the reliable fallback.

### Editor gutter markers (lightweight visual)

Optional but nice: a CM6 line decoration on each label line showing
the layer's color as a small dot in the gutter. This makes the
color-coding visible in the editor, not just the piano roll. Use CM6's
`lineDecorationsForRange` or `gutterLineClass` — the numeric scrubber
(`src/editor/numeric-scrubber.js`) is precedent for per-line CM6
decorations.

Keep this simple: a 6px colored circle in the line-number gutter,
matching the piano roll palette. No buttons, no interactivity — the
keyboard shortcuts handle that. The gutter dot just says "this label
is teal" so the user can correlate editor lines with piano roll layers
at a glance.

## Files to touch

| File                              | What                                               |
| --------------------------------- | -------------------------------------------------- |
| `src/editor/keymap.js`            | Add `Mod-m` and `Mod-Shift-s` bindings             |
| `src/editor/track-labels.js`      | **New.** `parseLabels`, `toggleMute`, `toggleSolo` |
| `src/ui/piano-roll.js`            | Add legend strip to `renderRoll`                   |
| `src/editor/track-labels.test.js` | **New.** Tests for parse/toggle helpers            |

Optional (gutter dots):

| File                         | What                                         |
| ---------------------------- | -------------------------------------------- |
| `src/editor/track-gutter.js` | **New.** CM6 gutter extension for label dots |
| `src/editor-setup.js`        | Wire the gutter extension                    |

## Phases

### Phase 1 — Parse + keyboard mute/solo

1. Write `src/editor/track-labels.js` with `parseLabels`,
   `toggleMute`, `toggleSolo`.
2. Write tests in `src/editor/track-labels.test.js`. Cover:
   - Basic labels: `$:`, `lead:`, `drums:`
   - Muted labels: `lead_:`, `_lead:`
   - Soloed labels: `Slead:`
   - Combined: `Slead_:`
   - Multi-line patterns (label owns lines until next label)
   - Edge: cursor on `setcpm(...)` line → no label found
3. Add `Mod-m` and `Mod-Shift-s` to `src/editor/keymap.js`. The
   handler reads the editor text, finds the label at the cursor
   line, calls the toggle function, dispatches the new text, and
   re-evaluates.
4. `pnpm build` clean. Manual smoke-test: open a pattern with named
   labels, place cursor inside a label block, press `Cmd+M` → the
   label text changes and the layer goes silent. Press again → it
   comes back. `Cmd+Shift+S` → solo. Undo (`Cmd+Z`) restores.

### Phase 2 — Piano roll legend

1. Add the legend strip to `renderRoll` in `src/ui/piano-roll.js`.
   Derive label names from hap data (source-location mapping or
   controls `id` — verify which is available at runtime).
2. Wire click-to-mute and shift+click-to-solo on legend entries.
   The click handler calls the same `toggleMute` / `toggleSolo`
   helpers, dispatches into the editor, and re-evaluates.
3. Visual states: muted entries at 0.35 opacity + strikethrough,
   soloed entries with accent underline.
4. Smoke-test: click a legend entry → the label text changes, the
   layer goes silent, the legend updates on the next draw frame.

### Phase 3 — Editor gutter dots (optional)

1. CM6 gutter decoration showing a colored dot on each label line.
2. Colors match the piano roll palette (reuse `PALETTE` and the
   same key → index logic).
3. Smoke-test: gutter dots match piano roll layer colors.

## Acceptance

- [ ] `Cmd+M` toggles mute on the label at cursor. The `_` suffix
      appears/disappears in the source text. Undo works.
- [ ] `Cmd+Shift+S` toggles solo. The `S` prefix appears/disappears.
- [ ] Piano roll legend shows label names with correct colors.
- [ ] Clicking a legend entry toggles mute. Shift+click toggles solo.
- [ ] Muted layers in the legend appear dimmed. Soloed layers are
      accented.
- [ ] No runtime state outside the editor text. Reloading the page
      preserves mute/solo state because it's in the saved pattern file.
- [ ] `pnpm build` clean, no new warnings.
- [ ] WAV export respects mute/solo because it re-evaluates the
      editor text (which now contains the `_` / `S` markers).

## Design-system alignment

- Legend text uses `--font-mono` at `--text-xs`.
- Color dots use the existing 10-step OKLCH palette from
  `piano-roll.js`.
- Muted opacity: 0.35 (same as `--text-dim` relative to `--text-1`).
- Soloed accent: `--accent`.
- Legend background: `--surface-1` (same as the piano roll background).
- Click targets: minimum 24px hit area for accessibility.
- No new CSS file needed — all rendering is canvas-based (legend) or
  inline CM6 decorations (gutter dots).
