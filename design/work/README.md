# Work specs

One file per piece of work. Each spec starts with a `Status:` line; this
table repeats it. Status is one of: shipped, partly shipped, superseded,
not started, reference.

A shipped spec is a record of intent. The code is the truth about
behaviour; where they disagree, the code wins. Read this index, then only
the spec you were pointed to.

- [`OPEN.md`](OPEN.md) — what is deferred, what the maintainer still has to
  decide, and what nobody has yet checked in a real browser.
- `archive/` — finished implementation plans and the November 2026 audit
  record. Their code listings are out of date; a root `.ignore` keeps
  ripgrep-based search out of it.

Statuses were checked against the tree and `git log` on 2026-11-16. Update
the row and the spec's own line when one changes.

| # | Spec | Status | Note |
|---|---|---|---|
| 01 | [shell](01-shell.md) | shipped | |
| 02 | [format and keybindings](02-format-and-keybindings.md) | shipped | the fixed VSCode keymap became one of the profiles in 21 |
| 03 | [numeric scrubber](03-numeric-scrubber.md) | shipped | |
| 04 | [intellisense](04-intellisense.md) | superseded | by 22; hover docs and signature hints survive |
| 05 | [piano roll](05-piano-roll.md) | shipped | the canvas is now shared with the scope and painters |
| 06 | [future](06-future.md) | reference | long-term direction, nothing to build |
| 07 | [chord progression](07-chord-progression.md) | shipped | all three phases |
| 08 | [feature parity and beyond](08-feature-parity-and-beyond.md) | shipped | the right-rail panels, all five phases |
| 09 | [pattern persistence](09-pattern-persistence.md) | partly shipped | phases 1–2; phase 3 (accounts, cloud) not started |
| 10 | [main refactor](10-main-refactor.md) | shipped | |
| 11 | [UI hardening](11-ui-hardening.md) | shipped | |
| 12 | [track controls](12-track-controls.md) | shipped | semantics corrected by 27 |
| 13 | [MIDI experience](13-midi-experience.md) | shipped | including its "future" phases 2 and 3 |
| 14 | [Strudel learning and extensibility](14-strudel-learning-and-extensibility.md) | shipped | all five phases |
| 15 | [error experience](15-error-experience.md) | shipped | all three phases |
| 16 | [MIDI import](16-midi-import.md) | shipped | phase 1, plus part of phase 2; harmonic uplift not started |
| 17 | [audiomid service](17-audiomid-service.md) | reference | a separate repository; nothing here calls it yet |
| 18 | [arrangement timeline](18-arrangement-timeline.md) | partly shipped | strip, runtime wrapper and section solo; seek, rename, reorder not started |
| 19 | [beat grid](19-beat-grid.md) | shipped | phases 1–4; the v1.5 items not started |
| 20 | [scope upgrades](20-scope-upgrades.md) | shipped | |
| 21 | [keybinding profiles](21-keybindings.md) | shipped | plan in archive |
| 22 | [intellisense v2](22-intellisense-v2.md) | shipped | all four phases; plan in archive |
| 23 | [keybinding overrides](23-keybinding-overrides.md) | not started | [plan](23-keybinding-overrides-plan.md) written, no code |
| 24 | [pattern folders](24-pattern-folders.md) | shipped | plan in archive |
| 25 | [Hydra visuals](25-hydra-visuals.md) | shipped | phases 1, 1.5 and 2; real-GPU check listed in OPEN; plan in archive |
| 26 | [pattern tabs](26-pattern-tabs.md) | shipped | plan in archive |
| 27 | [track and listener bugfix](27-track-and-listener-bugfix.md) | shipped | fixed 2026-08-24 |
| 28 | quality-upgrade session | reference | finished audit; record in `archive/28-upgrade-session.md`; open items in [OPEN.md](OPEN.md) |
| 29 | [performance lane](29-perf-lane.md) | shipped | the rig and its ratchets stay in use; open items in [OPEN.md](OPEN.md) (PL-1…9) |
| — | [research: Strudel visuals](research-strudel-visuals.md) | reference | |
