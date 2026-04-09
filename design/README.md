# strasbeat design

This directory holds the design system and the work specs that came out of
the first UI/UX design session for strasbeat. It exists so that work on
different features can be picked up by **separate Claude Code agents in
fresh contexts**, without needing to relive the conversation that produced
these decisions.

## How to use this directory

If you're an agent picking up a task here:

1. **Read `SYSTEM.md` first.** It's the design system — type, color,
   spacing, layout grammar, principles, off-limits zones. Every other doc
   in this directory assumes you've internalised it.
2. **Read `../CLAUDE.md`** for the broader project context if you haven't
   already (vision, architecture, gotchas).
3. **Then read your task spec under `work/`.** Each work spec is
   self-contained and lists exactly what to build, what's out of scope,
   which files to touch, and what acceptance looks like.
4. **Stay in your lane.** SYSTEM.md §11 lists what's off-limits — most
   importantly, the core Strudel plumbing in `src/main.js`. The design
   pass is DOM/CSS/CodeMirror-extensions only.

## Order of operations

Tasks should be tackled in roughly this order, because later ones build
on earlier ones:

1. **`work/01-shell.md`** — the new layout (top bar + left rail +
   editor + transport + collapsible roll). **Everything else builds on
   this.** Land it first.
2. **`work/02-format-and-keybindings.md`** — Prettier on demand + VSCode-
   style keybindings. Independent of the shell — could be done in
   parallel.
3. **`work/03-numeric-scrubber.md`** — drag-to-scrub numeric literals in
   the editor. Highest "feels like a real music tool" payoff per line of
   code.
4. **`work/04-intellisense.md`** — smart autocomplete + hover docs.
   Phased; the first phase (sound name completion) is small and high-
   leverage on its own.
5. **`work/05-piano-roll.md`** — replace the existing 180px canvas with
   a real piano roll, in the design-system style. Depends on `01-shell.md`
   being landed (it lives in the new bottom panel).
6. **`work/07-chord-progression.md`** — `progression("ii V I")` runtime
   helper: a one-line API on top of Strudel's existing `.voicing()` for
   sketching tunes from chord charts. Phased; Phase 1 (absolute chord
   symbols + rhythm presets) is small and shippable on its own.
   **Not a design-pass feature** — runtime only, touches `evalScope` in
   `main.js` minimally and additively. Independent of 1–5.
7. **`work/08-feature-parity-and-beyond.md`** — right-rail panel system:
   sound browser, API reference, console, export panel, enhanced
   settings. Phased; Phase 1 (right rail + sound browser) is the
   highest-value delivery and builds the infrastructure all other
   panels depend on. Depends on `01-shell.md` being landed.
8. **`work/09-pattern-persistence.md`** — localStorage-backed autosave,
   working copies, user-created patterns, revert-to-original, dirty
   indicators. Phased; Phase 1 (autosave + store abstraction) solves the
   "lose work" problem. Phase 3 sketches migration to API-backed user
   accounts. Independent of 1–7 (touches `main.js` boot + left rail).
9. **`work/10-main-refactor.md`** — pure refactor of `src/main.js`
   (1,925 → ~600 lines). Extracts seven focused modules (`share.js`,
   `export.js`, `editor-actions.js`, `piano-roll-resize.js`, `debug.js`,
   `patterns.js`, `editor-setup.js`). No features, no logic changes, no
   visual changes. Independent of 1–8 (but best done after 08 and 09 are
   landed, since those are the last specs that add code to `main.js`).
10. **`work/06-future.md`** — vision for Phase N+ (bidirectional editing,
    multi-track DAW). **Not actionable yet** — read for context only when
    working on the actionable specs above, so you don't paint us into a
    corner.

## Launching an agent on a task

From a fresh Claude Code session in this repo:

> Read `design/README.md`, then `design/SYSTEM.md`, then
> `design/work/01-shell.md`. Implement the spec. Stop and ask if anything
> seems out of scope or unclear.

That's it. Each spec is written to be picked up cold.

## What's not in this directory

Things deliberately _not_ in scope for this design pass:

- Refactoring `src/main.js` plumbing (Strudel boot, prebake, WAV export,
  MIDI bridge wiring, share encode/decode). The editor _settings_ block
  in `main.js` and the editor's CodeMirror extensions are fair game; the
  rest is off-limits. See `SYSTEM.md` §11 for the exact table.
- Server-side or build-pipeline changes beyond what a feature explicitly
  needs.
- Anything in `strudel-source/` — that's a read-only upstream reference.
- A full vim mode, an in-app theme editor, multi-user collaboration —
  none of these are on the roadmap today, no spec for them here.
