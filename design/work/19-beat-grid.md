# 19 — Beat grid (step-sequencer view for drum lines)

> Read `../README.md`, `../SYSTEM.md`, `../PATTERN-STYLE.md`, and
> `../../CLAUDE.md` before starting. This task touches three layers:
> a new parser (`src/editor/drum-parse.js`), a new bottom-panel mode in
> `src/ui/bottom-panel-modes.js`, and a CM6 transaction writer that
> round-trips grid edits back into the editor buffer. Read
> `src/editor/arrange-parse.js` and `src/editor/track-labels.js` first —
> the scanner discipline here is the same.

## Where this came from

Alexandru Postolache's step-sequencer-on-Strudel
(<https://github.com/alexandru-postolache/step-sequencer>) is a classic
drum-machine UI: 10 fixed sounds × 16 cells, click to toggle, Strudel
runs under the hood. It's not a fit for strasbeat **as it stands** —
the grid *is* the source of truth there; no editor, no files, no
round-trip. That violates strasbeat's whole "code is the source of
truth" ethos and throws away the IDE we've built.

But the idea — **build drums fast, with your eyes, on a grid** — is
worth having. And we can have it without giving up the code, because
Strudel's mini-notation already contains native step-grid syntax:

```js
$: s("bd:0 ~ bd:0 ~ bd:2 ~ bd:0 ~").bank("RolandTR909")
$: s("~ ~ sd ~ ~ ~ sd ~").bank("RolandTR909")
$: s("hh hh hh hh hh hh oh hh").bank("RolandTR909")
```

Every `$:` line above already describes a drum lane on a 8-step grid.
The user's hand-written patterns
(`patterns/pattern-market-2.js`, `patterns/ben-ez.js`,
`patterns/beatgueules.js`) are *full* of this shape. A grid view is
therefore a **visual twin** of what the code already says, not a
replacement for it.

The reference project also had two audible flaws the user flagged:

1. **Downbeat pile-up** — editing during playback re-fires the `1` in
   every cycle. Root cause (inferred from its `export.js`): it
   re-evaluates without tearing down scheduler state on each click.
2. **Single drum kit, single variant per sound** — can't mix a TR-909
   kick with a TR-808 cowbell; can't use `bd:0` vs `bd:2` per cell.

strasbeat has both solved already. Our existing `editor.evaluate()`
path (patched in `eval-feedback.js`) handles reschedule cleanly; and
`.bank(...)` per line plus `sound:N` per step is already the idiom.
The grid just needs to respect it.

## Goal

When a pattern contains drum lanes written in the **flat positional**
shape (`$: s("STEP STEP STEP …").bank(...)…`), strasbeat shows a
**beat grid** in the bottom panel — one row per lane, one cell per
step, per-lane bank picker, per-cell sample-variant picker, playhead
sweeping in time with the scheduler. Clicking cells writes back to
the editor buffer. Lanes written in any richer form
(`*N`, `[...]`, `<...>`, `.struct(...)`) are shown **read-only** with
a clear badge explaining why. The editor buffer stays the source of
truth.

Explicit non-goals:

- **Melodic sequencing.** Piano roll owns `note(...)` and `chord(...)`;
  this is drums only. Spec 05 covers the roll; spec 18 covers the
  timeline. This is the horizontal-rhythm-per-lane surface.
- **Replacing mini-notation with the grid.** Users who prefer typing
  `s("hh*8")` keep typing it — we leave that line alone and show it
  read-only.
- **Generalised "which drum machine" abstraction.** A lane's sound
  comes from the source text (`bd`, `sd`, `hh`, etc.), not from a
  strasbeat-specific enum. No new vocabulary for pattern authors.
- **Time-signature awareness beyond 4/4.** v1 assumes 16 steps = 1
  cycle at 16th-note resolution, which matches the vast majority of
  patterns in `patterns/`. Triplets and 12/8 are §10 Open questions.
- **Project-wide drum patches or velocity layers.** Velocity lives in
  `.gain(...)`; if we need per-cell gain later it's a v1.5 feature.

## Background — the subset the grid understands

### Canonical lane shape (editable)

```ebnf
laneLine    := "$:" ws* "s(" string ")" (method)* EOL?
string      := '"' STEPS '"'
STEPS       := STEP (ws+ STEP)*
STEP        := "~" | "-" | ident (":" int)?
method      := "." ident "(" balanced ")"
```

Where `ident` is a sound name (`bd`, `sd`, `hh`, …) and `int` is a
sample-variant index. `balanced` is anything with matched brackets —
we preserve it verbatim on write.

An editable lane has:

- A `$:` prefix (our project-wide drum idiom — see `PATTERN-STYLE.md
  §3`). Lines without `$:` are skipped.
- A single `s("…")` or `sound("…")` call as the head. No `stack(...)`,
  no comma-operator polymeter.
- A step string that is **flat**: whitespace-separated tokens, each
  a sound, a sound-with-variant, or a rest. No `[nested]`, no
  `<alternations>`, no `*N`, no `!N`, no `@N`.
- Any trailing method chain (`.bank("…")`, `.gain(0.9)`,
  `.room(0.4)`, `.pan(…)`, user-authored FX) — we parse it but don't
  touch it when writing cell toggles. Exception: `.bank("…")` is
  owned by the lane header (change it → we rewrite that call).

### Non-editable lanes (read-only, visible, explained)

Anything that doesn't match the above. Specifically:

| Shape | Verdict | UI badge |
| --- | --- | --- |
| `s("hh*8")` | read-only | "shortcut — expand to 8 cells?" |
| `s("bd:6").struct("x - x - x x - x")` | read-only | "struct mode — open struct grid?" *(v1.5)* |
| `s("bd <sd sd:1> bd sd")` | read-only | "alternation" |
| `s("bd [~ sd] bd sd")` | read-only | "subdivision" |
| `stack(s("bd"), s("sd"))` | skipped | (not a `$:` drum lane) |
| `note(...)`, `chord(...)`, `progression(...)` | skipped | (not drums) |

The read-only lanes still **render** in the grid at the right vertical
position so the user sees every drum in the pattern, just with cells
greyed and the chip explaining why. Silent failures are not acceptable
(CLAUDE.md §"Surface silent failures loudly").

The "expand to 8 cells?" / "expand to 16 cells?" affordance is a
one-click normaliser:

- `s("hh*8")` → `s("hh hh hh hh hh hh hh hh")` (expanded in place)
- `s("bd ~ sd ~")` → `s("bd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~")` when
  upgrading 4-step → 16-step (opt-in, per-lane).

After normalisation the lane becomes editable.

### Per-lane step count

Not every lane is 16 steps. In `patterns/pattern-market-2.js` a
single pattern mixes 4-step kicks with 16-step hats. The grid
**adapts per lane** — a 4-step lane renders as 4 wide cells, a
16-step lane as 16 narrow cells, aligned to the same cycle
boundary. Quarter-beat gridlines span the full width so the lanes
are visually synchronised despite differing densities.

v1 supports lanes of 4, 8, or 16 steps. Anything else (odd counts,
very high resolution) shows read-only with a "non-standard step
count — edit as text" badge. Cycles-per-loop stays 1 for v1; see §10
for multi-cycle patterns.

### Why not `.struct(...)` as the canonical form

The user's two concrete requirements — **mix drum machines** and
**per-cell sample variants** — can't be expressed by `struct("x - x
x")` alone. `struct` is binary. Positional mini-notation naturally
carries both (`.bank(...)` per-line for the machine, `sound:N` per
token for the variant), so that's what we write.

Existing `struct` lines in patterns/ are preserved as read-only. v1.5
can add a second editor mode for them (toggles without variants).

## UX

### Where it lives

Third mode in the existing bottom-panel mode switcher:

```
Roll ▎ Scope ▎ Beat grid ▎ (Custom)
```

`src/ui/bottom-panel-modes.js` already supports adding modes; we wire
a new one (`id: "beats"`). When the active pattern has **zero** drum
lanes (editable or read-only), the tab is hidden — same discipline as
the Custom tab. When the user has drum lanes but all are read-only,
the tab is visible and opens into a grid with every lane badged.

The grid draws into the same `#roll` canvas real estate the roll and
scope use, swapped on mode change via `onDraw`. Because the grid is
interactive (clickable cells), it can't be a pure canvas —
§6 discusses the DOM-over-canvas approach.

### Layout

```
┌─ lane rail ─┬──── step grid (16 cells) ────────────────┬── controls ─┐
│ [●] bd      │ [●][ ][●][ ][ ][ ][●][ ][●][ ][●][ ][ ][ ][●][ ]      │ 909▾ │
│ kick        │                                                        │ M S  │
├─────────────┼────────────────────────────────────────────────────────┼──────┤
│ [●] sd      │ [ ][ ][●][ ][ ][ ][●][ ][ ][ ][●][ ][ ][ ][●][ ]      │ 808▾ │
│ snare       │                                                        │ M S  │
├─────────────┼────────────────────────────────────────────────────────┼──────┤
│ [●] hh      │ [●][●][●][●][●][●][○][●][●][●][●][●][●][●][○][●]      │ 909▾ │
│ hat ×16     │                                                        │ M S  │
├─────────────┼────────────────────────────────────────────────────────┼──────┤
│  + Add drum │                                                        │      │
└─────────────┴────────────────────────────────────────────────────────┴──────┘
                ▲ quarter-beat markers                  ▲ playhead (sweeps)
```

- **Lane rail** (left): sound name (clickable → sound picker), short
  label ("kick"/"snare"/…) auto-derived from sound name,
  step-count chip when non-16 (`×4`, `×8`).
- **Step grid** (middle): one cell per step. Cells are filled (on) or
  empty (off); variant cells (`bd:2`) show a tiny numeric badge or a
  hue shift so variants are visually distinct without being noisy.
- **Controls** (right): bank selector (abbreviated pill, e.g. "909"),
  Mute/Solo — we reuse the existing `$:`/`_name:` label-flip
  mechanism from `src/editor/track-labels.js` and `src/ui/track-bar.js`
  so beat-grid mute/solo is the *same state* as track-bar mute/solo.
  No new state.
- **+ Add drum** (bottom of the rail): inserts a new `$:` line with
  the user's most-recently-picked sound and bank, 16 empty steps.

The controls column intentionally repeats the track-bar's M/S —
**not** because we're duplicating state, but because the user's eyes
are on the grid when they want to mute a lane, and routing them back
up to the track bar (above the roll) is UX friction. Both surfaces
write to the same CM range.

### Cell interactions

| Gesture | Effect |
| --- | --- |
| Click empty cell | Turn on at lane's default variant (`sound:0` or just `sound`). Plays the sample once at lane's default gain (audio feedback). |
| Click filled cell | Turn off. No playback. |
| Shift+drag across cells | Paint — all touched cells take the state of the first cell. |
| Right-click cell | Variant menu: "bd (0) • bd:1 • bd:2 • …" with hover preview. Each variant shows sample count (from `getSoundMap()`). |
| Alt+click filled cell | Cycle to next variant (0 → 1 → 2 → … → 0). Fast variant iteration without the menu. |
| Cmd/Ctrl+click | Isolate — solo this cell (temporarily mute rest of lane) for audition. Release reverts. |

### Lane-header interactions

| Gesture | Effect |
| --- | --- |
| Click sound name | Open mini sound picker (same component as `sound-browser.js`, filtered to drum kit suffixes — see `DRUM_ORDER` in `src/ui/sound-browser.js:40`). Selection swaps the sound ident across every on-cell of the lane. |
| Click bank pill | Dropdown of banks registered in the current buffer + common banks (`RolandTR909`, `RolandTR808`, `akailinn`, etc.). Selection rewrites or inserts `.bank("…")`. |
| M / S | Toggle mute / solo. Writes the `$:` → `_name:` flip via the same path `track-bar` uses. |
| Drag handle (far left of rail) | Reorder lane. Rewrites the order of `$:` lines in the buffer. |
| Right-click | Duplicate lane, delete lane, expand (4→8, 8→16). |

### Playhead

A thin vertical line sweeps from left to right across the grid,
synced to `editor.repl.scheduler.now()` folded to 1 cycle = 16 steps.
Same rAF driver as `arrange-bar.js` and `piano-roll.js`. The current
step column is also subtly highlighted so you can see "we're on
step 7 right now" at a glance. When stopped, the playhead parks at
step 0.

### Audio feedback on edit

Every cell-on toggle previews the sample through `superdough()` at
the lane's default gain. Same code path as `sound-browser.js`
preview. During playback this is layered on top of the live
scheduler output — the user hears their edit instantly without
waiting for the next downbeat. The scheduler isn't disturbed.

### Empty-state

Pattern with no drum lines at all: the Beat grid tab is hidden. If
the user wants to start a pattern from the grid, the path is
*Command Palette → "Add drum lane"* which inserts a `setcpm(120/4)`
header (if missing) plus one `$: s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~")`
starter line, which reveals the tab.

### The duplicate-downbeat bug — why we don't have it

The reference project's main loop evaluates fresh Strudel code on
every click. strasbeat doesn't. Cell toggles dispatch **a CM
transaction** that mutates the buffer; the transaction triggers the
autosave debounce (1s) and the user-driven evaluate (Cmd+Enter).
The scheduler is only reset on explicit evaluate. So there is no
"re-fire the 1 beat on every click" surface.

During active playback, the edit is **inaudible until next evaluate**
— the scheduler is still running the old pattern. This is the
Strudel default and matches how typing in the editor behaves. The
per-cell audio preview (above) compensates so the user still gets
immediate tactile feedback without the rhythmic glitch.

(Optional: a "live evaluate" toggle that auto-runs `editor.evaluate()`
debounced by ~500ms after cell edits. Off by default. v1.5.)

## Architecture & data flow

```
          CM buffer  ◄── writes via EditorView.dispatch({changes})
             │
             │  docChange
             ▼
     parseDrumLanes(code)           ── shared between grid + future uses
             │
             ▼
      lanes: DrumLane[]              ── one per `$:` s("…") line
             │
             ▼
      beat-grid/render(lanes)       ── DOM table of rows × cells
             │
             │  click / drag / menu
             ▼
      beat-grid/edit → cellChange    ── computed new step string
             │
             ▼
   EditorView.dispatch({ changes })  ── replace the s("…") argument range
             │
             ▼
          CM buffer                  ── triggers docChange → re-parse (idempotent)
```

The loop is self-consistent: a cell toggle edits the buffer, the
buffer change re-parses, the re-parse produces the same lanes (because
the edit is a stable fixed-point), the grid re-renders to the same
state. No feedback loop, no extra bookkeeping.

### Why DOM, not canvas

The grid is intrinsically interactive — cells are per-pixel targets
with hover, focus, context menus, drag paint, keyboard
accessibility. Canvas makes every one of these harder. Roll and
scope are passive visualisations; the grid is an input surface. It
belongs in the DOM.

We do still render inside the `#roll` canvas's parent element
(`<section class="roll-pane">`) — just as a sibling DOM layer the
mode switcher shows/hides. The canvas keeps its size; the grid
absolutely-positions over it.

## Parse / write contract

### Parser (`src/editor/drum-parse.js`)

Mirrors the scanner style of `arrange-parse.js` and
`track-labels.js` — hand-rolled, tolerant of unbalanced buffers,
string/comment aware.

Shape returned:

```ts
type DrumLane = {
  // Source offsets — every edit dispatches changes in these ranges.
  lineStart: number;    // start of the `$:` token
  lineEnd: number;      // end of the line (EOL or EOF)
  labelName: string;    // "$" for bare `$:`, else the name
  muted: boolean;       // label prefix `_` form
  callName: "s" | "sound";
  stringStart: number;  // offset of opening `"` of s("…")
  stringEnd: number;    // offset of closing `"`
  stepStart: number;    // offset just after opening `"`
  stepEnd: number;      // offset just before closing `"`
  // Parsed step tokens.
  steps: Array<{
    kind: "rest" | "hit";
    sound: string | null;     // null for rest
    variant: number | null;   // null = default (same as 0)
    tokenStart: number;
    tokenEnd: number;
  }>;
  stepCount: number;          // steps.length
  primarySound: string | null;// most-common sound on the line
  // Chain parsing.
  bank: { name: string, argStart: number, argEnd: number } | null;
  otherChain: string;          // verbatim tail after bank (or full tail)
  // Why-not-editable.
  editable: boolean;
  readOnlyReason: string | null;
};

function parseDrumLanes(code: string): DrumLane[]
```

Tests at `src/editor/drum-parse.test.js` — minimum 20 cases covering
the shapes in §"Non-editable lanes", edge cases from existing
`patterns/` files, mid-edit unbalanced buffers, weird whitespace,
comments inside the string.

### Writer

All writes are CM transactions against the `EditorView` the grid
holds a reference to. No file I/O from the grid — autosave and
`/api/save` take over downstream, exactly as for keyboard edits.

| Action | Range replaced | New text |
| --- | --- | --- |
| Toggle cell (N) | `steps[N].tokenStart…tokenEnd` | `"~"` or `"{sound}[:{variant}]"` |
| Change variant | same | updated `:{variant}` |
| Change primary sound | every hit's `sound` part in the step string | new sound name |
| Change bank | `bank.argStart…bank.argEnd` or insert `.bank("…")` after `s("…")` | new bank |
| Mute/solo | `$` ↔ `_$` at `lineStart` | — |
| Add lane | insert at end of last lane block | full line |
| Delete lane | `lineStart…lineEnd` (+ trailing `\n`) | empty |
| Reorder | compose two range swaps | — |
| Normalise ×N | `stringStart+1…stringEnd-1` | expanded token string |

All ranges are re-read via `parseDrumLanes(view.state.doc.toString())`
immediately before dispatch, so stale offsets can't corrupt the
buffer if the user typed between the grid's last render and the
click.

Single transaction per user action, so CM's undo coalesces
correctly — one Ctrl+Z undoes one cell toggle.

## Files affected

| File | Change |
| --- | --- |
| `src/editor/drum-parse.js` | **New.** Scanner + shape above. |
| `src/editor/drum-parse.test.js` | **New.** Unit coverage. |
| `src/ui/beat-grid.js` | **New.** DOM render + interaction layer. |
| `src/styles/beat-grid.css` | **New.** Per SYSTEM.md tokens. |
| `src/ui/bottom-panel-modes.js` | Add `"beats"` mode alongside roll/scope/custom. |
| `src/main.js` | Mount beat-grid into `.roll-pane` sibling layer; wire `onDraw` branch / mode toggle. |
| `src/command-palette-actions.js` | "Add drum lane" action. |
| `src/ui/track-bar.js` | Cross-wire mute/solo so beat-grid's M/S reflects here (and vice versa). Read-only change — the state authority is still CM text via `parseLabels`. |
| `STRUDEL.md` | Note under "Strasbeat extensions": the beat grid is a view over standard positional mini-notation; no new syntax. |
| `design/work/19-beat-grid.md` | This file. |

No changes to `vite.config.js`, no new dependencies, no
strudel-source patches.

## Test plan

### Unit (node test-runner)

`drum-parse.test.js`:

- Canonical editable lines: bare `$:`, named label, with/without
  bank, with/without trailing chain (gain, room, pan).
- Step tokens: bare sound, sound with variant, rest (`~` and `-`),
  mixed resolutions (4, 8, 16).
- Label mute flip (`_name:`) is recognised and surfaces as `muted:
  true`.
- Non-editable shapes each emit `editable: false` with a specific
  `readOnlyReason` string:
  - `*N`, `!N`, `@N`, `/N`
  - `[subdivisions]`
  - `<alternations>`
  - `.struct(...)` — still parse the step string but mark read-only
- Bank recovery: `.bank("RolandTR909")` extracted with offsets;
  missing bank → `null`, offsets for *insertion* point provided.
- Unbalanced buffers (missing `)`, unterminated string, mid-edit):
  parser returns a best-effort list, doesn't throw.
- Comments inside the step string are tolerated (no one writes them
  there but the scanner should be robust).
- Multiple lanes in one buffer, some editable, some not.
- Ignored lines: `note(...)`, `chord(...)`, `progression(...)`,
  `$: stack(...)`.

### Integration (browser, manual)

Golden path:

1. Open `patterns/beatgueules.js` → Beat grid tab is visible →
   click it → see 4 lanes with cells laid out.
2. Toggle a cell on lane 1 → buffer updates → ⏎ play → new hit is
   audible.
3. Right-click a cell → variant menu → pick `bd:1` → step text
   updates to `bd:1`.
4. Change bank on lane 1 from "casiorz1" to "RolandTR909" → buffer's
   `.bank("…")` argument rewritten → ⏎ play → different sound.
5. Shift+drag across 4 hat cells → all 4 flip in a single transaction
   → Ctrl+Z reverts all 4.
6. Click "+ Add drum" → new `$:` line inserted at end of last lane
   block → grid re-renders with the new lane.
7. M on lane 2 → `$:` becomes `_$:`; lane dims; track-bar also
   shows it muted. Play — lane 2 silent.
8. Delete lane 3 → `$:` line removed from buffer.

Regression:

9. Open `patterns/pattern-market-2.js` → lanes using `.struct(...)`
   render as read-only with "struct mode" badge; editable lanes
   (if any) work; grid scrolls cleanly with mixed resolutions.
10. Open a pattern with `s("hh*8")` → lane shows "shortcut" badge
    and offers "expand to 8 cells" → click → cells appear → toggle
    works.
11. Pattern with no drum lanes (`patterns/02-chords.js`) → Beat
    grid tab hidden.
12. Pattern with only non-editable drum lanes → tab visible, grid
    shows every lane with its read-only badge.
13. Mid-edit: type into the editor while the grid is open → grid
    re-renders live on every keystroke (within docChange budget);
    no flicker on self-edits.

Behavioural / perf:

14. Drag paint across 16 cells in <100ms → single transaction; CM
    undo works cleanly.
15. Playback at cps=2 → playhead sweep stays visually smooth at
    60fps; no dropped frames on the roll-canvas side.
16. WAV export after a grid edit → exported audio matches the edit.
    Confirms autosave + renderPatternToBuffer path is untouched.
17. Patterns with `<$: …>` track-label mute: editing in the grid
    while the lane is muted writes correctly; M button respects
    the `_` prefix.

## Phasing / landing order

1. **Phase 1 — parser + read-only grid.** Ship
   `drum-parse.js` with tests, mount the bottom-panel mode, render
   lanes with cells but no click handler. Read-only grid proves the
   parse is right and the visual lands. *No behaviour change for
   pattern code.*
2. **Phase 2 — cell toggles.** Add click-to-toggle + shift-drag +
   variant menu + audio feedback. Round-trip through CM transactions.
   This is the "beats in 30 seconds" unlock.
3. **Phase 3 — lane chrome.** Bank picker, sound picker, M/S, add /
   delete / reorder / duplicate / normalise. The UI stops feeling
   like "read-only plus toggles" and starts feeling like a drum
   machine.
4. **Phase 4 — a11y + keyboard.** Arrow-key cell navigation, space
   to toggle, tab order, focus management, ARIA roles. Functional
   accessibility — *not* visual polish.
5. **Phase 5 — polish passes.** Run `/polish`, `/critique`, and
   whichever motion / typography / layout skills are relevant at
   the time to refine aesthetics. Deliberately last so the
   functional surface is settled before visual decisions are made.
6. **v1.5 (deferred)** — `.struct(...)` edit mode, live-evaluate
   toggle, per-cell gain, cross-lane copy/paste.

Each phase is independently mergeable and independently valuable.
If Phase 3 never lands, Phase 2 is still a very usable feature.

## Open questions (resolve with user before implementation)

1. **Step-count mixing discipline.** Is it OK for the same pattern
   to have a 4-step kick row next to a 16-step hat row? Musically
   yes (they align on the cycle). Visually: does the 4-step lane
   render as 4 cells spanning the full width (wide cells), or as 4
   filled cells inside a 16-slot grid (narrow cells, 12 empty)?
   Recommendation: 4 wide cells, because that's what the source
   text says; it visually teaches "resolution".
2. **Solo semantics.** Track-bar solo is "this `$:` lane only".
   When the user solos a beat-grid lane, do we piggyback on that,
   or introduce grid-local solo? Recommendation: piggyback — one
   state, less confusion, M/S visually consistent across surfaces.
3. **Multi-cycle patterns.** `s("bd ~ sd ~").slow(2)` is 4 steps
   over 2 cycles. v1 assumes 1 cycle per lane; we could parse
   `.slow(N)` and scale the grid, but that quickly generalises to
   arbitrary time transforms. Recommendation: v1 treats `.slow/.fast`
   chain as opaque (preserved but ignored for grid display); badge
   the lane with "×slow(2)" so the user knows. True multi-cycle
   grids are v1.5.
4. **Mobile / tablet ergonomics.** Cells at 16×1 resolution on a
   touch screen are borderline too small for reliable tapping. Do
   we ship a compact variant for narrow viewports? Defer to `/adapt`
   skill pass after Phase 2 lands; desktop-first for v1.

*Visual treatment — cell shape, variant-indicator style, colour
palette, motion, typography, micro-spacing — is intentionally
unspecified here. Ship Phase 1/2 with sensible defaults from
`SYSTEM.md`, then run `/polish` + `/critique` passes for the
refinement work. The functional UX above should survive any
aesthetic direction those skills land on.*

## Prior art / cross-references

- `design/work/05-piano-roll.md` — the melodic analogue; beat grid is
  its rhythm-focused complement. The grid and roll should never
  overlap responsibilities.
- `design/work/12-track-controls.md` — track-bar mute/solo is the
  authority; beat-grid M/S cross-wires to the same CM range rather
  than introducing a second source of truth.
- `design/work/18-arrangement-timeline.md` — same parser discipline
  (hand-rolled scanner, tolerant of mid-edit state, offset-based
  edits via CM transactions). Read its §V0 and §V1 before writing
  `drum-parse.js`.
- `design/PATTERN-STYLE.md §3` — the `$:` idiom the grid depends on.
- `src/editor/track-labels.js` — reference implementation for
  buffer-edit actions (mute/solo by label-name rewriting). Beat-grid
  M/S reuses this path rather than re-implementing it.
- `src/editor/arrange-parse.js` — closest structural analogue for
  `drum-parse.js`. Same comment-aware, string-aware scanner; same
  line-map / offset-based output; same "null when unrecoverable,
  don't throw" discipline.
- `src/ui/sound-browser.js` — supplies the sound-picker component
  and the `DRUM_ORDER` convention we reuse for sorting drums in the
  add-lane menu.
- CLAUDE.md §"Surface silent failures loudly" — the rule that turns
  "lines we can't parse disappear" into "lines we can't parse
  appear with a reason". Non-negotiable.
