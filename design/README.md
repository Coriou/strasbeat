# strasbeat design

This directory holds the design system and the work specs that came out of
the first UI/UX design session for strasbeat. It exists so that work on
different features can be picked up by **separate Claude Code agents in
fresh contexts**, without needing to relive the conversation that produced
these decisions.

## How to use this directory

If you're an agent picking up a task here:

1. **Read `../AGENTS.md`** for the project's rules and the list of traps
   if you haven't already; `../docs/architecture.md` has the invariants of
   each subsystem.
2. **Read `SYSTEM.md`.** It's the design system — type, color, spacing,
   layout grammar, principles. Every other doc in this directory assumes
   you've internalised it.
3. **Then read your task spec under `work/`.** `work/README.md` is the
   index: every spec with its status. Read the index, then only the spec
   you were pointed to. Each spec lists what to build, what's out of scope,
   which files to touch, and what acceptance looks like.

## Where the work is

- `work/README.md` — the index of specs and what state each is in.
- `work/OPEN.md` — what is deferred, undecided, or waiting for a person to
  check in a real browser.
- `work/archive/` — finished implementation plans and the November 2026
  audit record. Their code listings are out of date; the code is the truth.

A shipped spec is a record of intent. Where it disagrees with the code,
the code wins. The early specs (01–10) describe `src/main.js` as holding
the Strudel boot, WAV export and share code; spec 10 moved those into
`src/boot.js`, `src/export.js`, `src/share.js` and others.

## Launching an agent on a task

From a fresh agent session in this repo:

> Read `AGENTS.md`, then `design/SYSTEM.md`, then
> `design/work/<spec>.md`. Implement the spec. Stop and ask if anything
> seems out of scope or unclear.

That's it. Each spec is written to be picked up cold.

## What's not in this directory

Things deliberately _not_ in scope for this design pass:

- Server-side or build-pipeline changes beyond what a feature explicitly
  needs.
- Anything in `strudel-source/` — that's a read-only upstream reference.
- A full vim mode, an in-app theme editor, multi-user collaboration —
  none of these are on the roadmap today, no spec for them here.
