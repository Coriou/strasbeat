# 01 — New shell

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. This task assumes you've internalised the design system,
> especially §3 (layout grammar), §4 (type), §5 (color), §6 (spacing),
> and §11 (off-limits).

## Goal

Replace the current single-toolbar layout with the shell described in
`SYSTEM.md` §3:

- Slim **top bar** (40px): brand wordmark "Strasbeat", current pattern
  name (clickable → opens the patterns library / left rail focus),
  `share` button, settings/menu drawer (placeholder OK for v1 — can be a
  no-op icon button).
- **Left rail**: patterns library, replacing the current `<select>`
  dropdown. Searchable text input at the top, scrollable list of
  patterns below, "+" button to create a new pattern (dev-only — hide it
  in prod the same way the existing `save` button is hidden via the
  `dev-only` CSS class).
- **Editor** in the center, full bleed, no horizontal chrome, no status
  spans crowding it.
- **Right rail**: structurally reserved but **hidden by default in v1**.
  Render the column with width 0 so the grid is ready for content
  later, OR omit the column entirely and use a `auto 1fr` grid that's
  trivially extensible to `auto 1fr auto`. Either is fine; pick the
  simpler one.
- **Transport bar** (32px) below the editor: `play`, `stop`, `capture`,
  the centred **cps/bpm readout**, the **cycle/beat readout**, a thin
  **playhead** showing position within the current cycle, MIDI status
  pill, current status message (replaces both today's status spans in
  the top bar — they get truncated and need to live somewhere with more
  room).
- **Collapsible piano roll** below the transport bar (~160px when
  expanded; a divider drag handle to collapse/expand). The roll itself
  stays the existing `<canvas id="roll">` for this task — replacing the
  *renderer* is a separate spec (`05-piano-roll.md`).

**No new features** in this task. The functional surface area must be
exactly the same as today: every existing button works, every existing
status update lands somewhere visible, MIDI capture still toggles, share
still copies, WAV export still runs, HMR still reloads on pattern file
changes.

## Out of scope

- Numeric scrubbing (separate spec — `03-numeric-scrubber.md`).
- Prettier / VSCode keybindings (separate spec — `02-format-and-keybindings.md`).
- Intellisense / sound name completion (separate spec — `04-intellisense.md`).
- A new piano roll renderer (separate spec — `05-piano-roll.md`).
- Replacing `window.prompt()` calls — leave them for now; an in-app
  modal system is its own follow-up. (You may file a TODO comment near
  each `window.prompt` call pointing at this fact.)
- Touching `src/main.js` core plumbing (see SYSTEM.md §11 for the exact
  table). The `editor.updateSettings({...})` block and the editor's
  CodeMirror `extensions` are fair game; the rest is not.

## Files you'll touch

- **`index.html`** — restructure the body. New shell HTML, new IDs/
  classes. The existing IDs (`pattern-picker`, `play`, `stop`, `save`,
  `export-wav`, `share`, `preset-picker`, `capture`, `midi-status`,
  `status`, `editor`, `roll`) need to either survive (so the existing
  `getElementById` calls in `main.js` keep working) **or** be renamed
  with a corresponding update to the small wiring section at the bottom
  of `main.js`. Pick whichever is cleaner; I lean towards keeping the
  IDs so `main.js` only changes in the rewiring section.
- **`src/style.css`** — gut the existing CSS, replace with the design-
  system tokens from `SYSTEM.md` §5–§9. The current file is ~140 lines
  and small enough to delete and rewrite from scratch — don't try to
  preserve any of it.
- **Optional: split CSS into modules** under `src/styles/` (e.g.
  `tokens.css`, `shell.css`, `top-bar.css`, `left-rail.css`,
  `transport.css`, `roll.css`, `editor.css`) and import them from
  `style.css`. The bar is "readable", not "split for the sake of it" —
  if one file is clearer, keep one file.
- **`src/main.js`** — *only* the small DOM-wiring section near the
  bottom (the `getElementById` block, the toolbar event listeners, the
  pattern picker rebuild, the capture button handler). Update IDs /
  selectors / event targets to match the new shell. Do **not** touch
  imports, `prebake`, `renderPatternToBuffer`, the WAV export handler,
  the `MidiBridge` construction, or `window.strasbeat`. See SYSTEM.md
  §11.
- **New: `src/ui/left-rail.js`** — small custom component for the
  patterns library list (replaces the native `<select id="pattern-
  picker">`). Pure DOM + event listeners; no framework. Exports a
  `mount({ container, patterns, onSelect, currentName })` function.
- **New: `src/ui/transport.js`** — small component that owns the
  cps/cycle/playhead readouts. It needs to read from
  `editor.repl.scheduler` on a `requestAnimationFrame` loop. The exact
  property names — `cps`, current cycle position, etc. — should be
  inspected at runtime; do not guess. Stop the rAF loop when not
  playing to save CPU.
- **New (optional): `src/ui/top-bar.js`** — same shape as left-rail and
  transport components if you find the wiring cleaner factored out.
- **`package.json`** — add font and icon dependencies (see "Fonts" and
  "Icons" below).

## Fonts

Self-host **Geist Sans + Geist Mono** per SYSTEM.md §4. Two acceptable
approaches:

1. `pnpm add @fontsource-variable/geist-sans @fontsource-variable/geist-mono`
   then `import '@fontsource-variable/geist-sans'` and similar in
   `main.js` (or in a small `src/styles/fonts.js`).
2. If the `-variable` packages aren't on npm under those exact names,
   fall back to the closest equivalent (`geist-font` package, or
   `@fontsource/geist-sans` non-variable). Inspect what's available; do
   not guess.

Fonts must be loaded **before** the editor mounts so the editor doesn't
flash a fallback monospace.

## Icons

Replace the Unicode glyphs in the toolbar (▶, ■, ⤓, ↗, ●, etc.) with
Lucide icons per SYSTEM.md §10. `pnpm add lucide` then import only the
icons you need (`Play`, `Square`, `Download`, `Share2`, `Disc`, `Circle`,
etc.). Render them as inline SVGs sized per SYSTEM.md §10.

Keep the text label *next* to icons in the top bar (so it's clear what
each button does); transport buttons can be icon-only with a `title=`
attribute for the native tooltip — until we ship a custom tooltip
system, the native one is acceptable here only.

## Acceptance

Functional (must all pass):

- [ ] All existing controls work: pattern picker (now in left rail),
      play, stop, save (dev), wav, share, preset picker, capture.
- [ ] WAV export still produces audio (not silent). Verify with
      `await strasbeat.probeRender(4)` from devtools — must return a
      non-zero `absMax`.
- [ ] MIDI bridge still connects (status pill shows ready/connected).
- [ ] Share link still round-trips (share → reload → editor restored).
- [ ] HMR still picks up new pattern files and reloads.
- [ ] Capture flow still works end-to-end (start capture → play notes →
      stop capture → save / load).

Visual (subjective, but checkable):

- [ ] Layout matches `SYSTEM.md` §3 sketch.
- [ ] All accent uses go through `--accent*` tokens — `grep -ri 'cf418d\|842b54' src/`
      should return nothing (the only mentions of those hex values
      should be in `design/SYSTEM.md`).
- [ ] Geist Sans + Geist Mono are loaded and applied correctly (UI uses
      sans, editor uses mono — verify by inspecting computed styles).
- [ ] No native `<select>` dropdowns visible anywhere for the pattern
      picker. The preset picker (`#preset-picker`) is allowed to remain
      a `<select>` for this task — replacing it cleanly is a small
      follow-up.
- [ ] No truncated status text. The cps/cycle readout updates while
      playing.
- [ ] The roll panel is collapsible, and when collapsed the editor
      reclaims the space.
- [ ] No CSS contains hard-coded greys outside the token file.

## Validation

Before declaring done:

1. `pnpm dev`, click play on every existing pattern in `/patterns/` —
   none should fall over, all should produce audio.
2. `pnpm build` succeeds with no warnings about new chunks (or if there
   are warnings, they're explicable and not regressions).
3. Open the prod preview (`pnpm preview`), confirm dev-only chrome (the
   save button, the "+" pattern button) is hidden.
4. Resize the window to a narrow width (~900px) and a wide one (~2000px)
   — layout must hold up at both.
5. Check no `console.error`s during normal use.

## Notes for the implementer

- The current `style.css` is intentionally small and not load-bearing —
  feel free to delete and start fresh.
- The "patterns library" search input doesn't need to be fancy: a
  one-line filter over `Object.keys(patterns)` is enough. Highlight the
  matching substring if you want a small polish.
- For the cps/cycle readout: `editor.repl.scheduler.cps` is the cps. The
  current cycle position is something like
  `editor.repl.scheduler.now() * cps` or
  `editor.repl.scheduler.getPhase()` — inspect at runtime; the API
  shape isn't documented and shouldn't be guessed. Try `console.log(editor.repl.scheduler)`
  with a pattern playing.
- The Strasbeat brand is **just the wordmark** for v1 — no glyph, no
  logo design. Use Geist Sans 600 or 700 with letter-spacing tightened
  slightly. The accent color can pick out one letter or character if
  you want a small flourish, but keep it restrained.
- If you find yourself needing a custom tooltip / popover / modal
  primitive that doesn't exist yet, **stop and ask** — that's a v1
  primitive that should be designed alongside, not invented mid-task.
