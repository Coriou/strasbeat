# 06 — Future (not actionable yet)

> Read `../README.md` and `../SYSTEM.md` before starting any of the
> actionable specs in this directory. **This file is not a work spec.**
> It's a sketch of the long-term direction so today's work can be aimed
> at the right horizon. Nothing here should be implemented today.

## The Strudel-shaped DAW

The vision for strasbeat (see `../../CLAUDE.md` § "Vision the user is
steering toward"):

> A web-based, dev-grade music tool **on top of** Strudel — not a clone
> of it. […] Eventually grow into something DAW-shaped (multi-track,
> mixer-like affordances) without losing Strudel's "code is the source
> of truth" ethos.

This document sketches what that means for the layout, the editor, and
the visualisations — and, more importantly, what choices today's work
must avoid so we don't paint ourselves into a corner.

## Bidirectional editing

The piano roll spec (`05-piano-roll.md`) lands one direction:
**source → visualisation**. The complete loop is **visualisation →
source**: drag a note in the piano roll, the editor buffer updates to
match.

For arbitrary patterns this is hard (Strudel patterns can be
*generative* — the source is a *function*, not a fixed list of notes).
For *static* note-list patterns like `note("c d e f").s("piano")`,
it's tractable: parse the source, identify the note string, edit the
visual, regenerate the string.

The phased approach when this becomes a real spec:

1. **Detection.** A pattern is "statically editable" if the AST contains
   exactly one `note("...")` (or similar) call and the string is a
   flat sequence of literals — no `<...>`, no `[...]`, no `*N`, etc.
2. **Edit affordance.** When the user clicks-and-drags a note in the
   piano roll, the renderer commits a CodeMirror transaction that
   rewrites the corresponding character range in the source.
3. **Pitch correction.** Drag a note up to change its pitch; the source
   string is regenerated with the new note name.
4. **Add / remove.** Click an empty grid cell to add a note; click a
   note to remove it.

The hard parts are at the edges (rests, mini-notation operators,
nested groups), but the *interior* — flat note sequences — is the 80%
case for casual composition. That's where this would land first.

## Multi-track / DAW layout

The shell layout from `SYSTEM.md` §3 is **DAW-ready by design**. To
grow into a multi-track tool, the only structural changes needed:

- **Left rail** evolves from "patterns library" to "track list":
  - Each track is a small Strudel snippet, plus its own mute/solo
    state, its own instrument, its own MIDI routing.
  - The current "load a pattern from disk" model becomes "open a
    track."
  - The patterns library moves *up*, into a project-level panel — or
    becomes a flat folder structure inside the project.
- **Right rail** (currently reserved + hidden in v1) starts hosting:
  - Properties of the **selected track**.
  - Inline mixer-like controls (gain, pan, send levels) — these
    should map to numeric scrubber gestures (`work/03-numeric-scrubber.md`)
    on the underlying source numbers, *not* be a separate state store.
  - Per-track sound-bank picker.
- **Bottom panel** evolves from "single piano roll" to **arrangement
  view**: multiple stacked rolls, one per track, with a shared
  timeline.
- **Top bar** picks up project-level affordances: project name, master
  BPM, time signature, master transport.

None of this requires moving the existing controls — it's strictly
**additive on the existing grammar**. That's the whole point of
`SYSTEM.md` §3's layout choice.

## Editor-as-source-of-truth questions

The design tensions we have to resolve before going DAW-shaped — these
should not block today's work, but should inform any decision about
file structure or evaluation scope:

- **Is a "track" a file?** (`tracks/01-bass.js`,
  `tracks/02-drums.js`)
  Probably yes — keeps the "code on disk, version-controllable" ethos
  intact and means a track is grep-able, diff-able, and reviewable.
- **Is the project a directory?** Probably yes. A project becomes a
  folder of pattern/track files plus a small `project.json` for non-
  code state (mute/solo, mixer values, master BPM if not set in code).
- **Where does the master tempo live?** A project-level `setcps()`
  call in a `project.js` that gets prepended to every track's
  evaluation? Or a `project.json` field that the runtime injects? This
  needs design.
- **How do tracks share state?** Strudel evaluates each pattern in its
  own scope. Cross-track sync — a chord progression that drives both
  a bass and a piano line — needs a shared module the user `import`s.
  We may need a `lib/` folder convention.
- **How does live capture map to tracks?** Today, capture saves a new
  pattern file. In the multi-track world, does it append to the
  selected track? Replace it? Always go to a new "scratch" track?

These questions are not blocking today, but **any feature that touches
the file system or the evaluation scope should bear them in mind** so
it doesn't paint us into a corner.

## What this means for *today's* work

Concretely: when implementing one of the actionable specs in this
directory, **prefer choices that leave room** for the future:

- Don't hard-code "there's exactly one editor."
- Don't assume "patterns" are the only thing in the left rail. The
  rail's structure should support multiple sections (collections) even
  if v1 only has one.
- Don't assume the bottom panel always shows one piano roll. Today
  it's one canvas; tomorrow it might be a stacked column of canvases.
- Don't assume the top bar will stay this minimal forever. Reserve
  the right side for project-level affordances later.
- Don't store pattern state in browser memory only. The current "code
  on disk" model is load-bearing — **keep it**.
- Don't introduce client-side abstractions over the Strudel runtime
  that obscure the source. The source is the truth.

The shell from `01-shell.md` is built on these assumptions explicitly.
As long as you stay within its grammar, you're aimed at the right
horizon — even when the spec you're working on doesn't mention any of
this directly.
