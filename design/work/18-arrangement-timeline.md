# 18 — Arrangement timeline & song-form UX

> Read `../README.md`, `../SYSTEM.md`, `../PATTERN-STYLE.md`, and
> `../../CLAUDE.md` before starting. This task spans **three layers**:
> the design-system strip (landed), a runtime pivot that shadows Strudel's
> `arrange()` from `src/strudel-ext/` (next phase), and a controls layer.
> The runtime pivot touches the same `prebake` / `evalScope` wiring as
> `07-chord-progression.md` — read that spec's "Where this came from"
> section first if you haven't.

## Where this came from

Strudel's `arrange([cycles, section], [cycles, section], …)` is the
idiomatic way a pattern author stitches sections into a song form
(intro / verse / chorus / bridge / …). Upstream at
`strudel-source/packages/core/pattern.mjs:1601`, it's literal sugar over
`stepcat(...).slow(total)` — compact, composable, and already in our
hover-docs index.

But in strasbeat today, writing `arrange(...)` looks no different from
writing any other `Pattern`. You can't see the song form, you can't
tell which section is playing, and you can't loop one section while you
iterate on it. All the DAW-shaped UX a composer expects is missing.

The v0 landed in one session: a static parser
(`src/editor/arrange-parse.js`) and a section strip
(`src/ui/arrange-bar.js`) wired between the transport and the track
bar. It proves the idea is right — the strip earns its keep the moment
you open a pattern that uses `arrange`. But v0 hits a scaling ceiling
(see §5) that the user is explicitly unwilling to accept: *silent
degradation is not acceptable*, and *no new syntax for pattern authors*.

This spec is the pivot that removes both constraints.

## Goal

When a pattern contains an `arrange(...)` call, strasbeat shows a
**song-form strip** that accurately reflects the song being played —
names, proportional durations, active section, playhead — and exposes
**composition controls** (loop a section in isolation, jump the
scheduler to a section, rename/reorder) without the pattern author
changing how they write `arrange()`. When the pattern doesn't use
`arrange`, nothing appears.

Explicit non-goals:

- Multi-track DAW grid. Tracks × sections is a separate spec; this one
  is the horizontal (time) axis only.
- Song-form detection for patterns that don't use `arrange`. Broader
  primitives (`cat`, `stepcat`, `seqPLoop`) are §9.
- Rewriting how Strudel evaluates patterns. We layer on top of the
  existing `evalScope` / `renderPattern` path; no upstream patches.

## Background — how `arrange` actually runs

```js
// strudel-source/packages/core/pattern.mjs:1601
export function arrange(...sections) {
  const total = sections.reduce((sum, [cycles]) => sum + cycles, 0);
  sections = sections.map(([cycles, section]) => [cycles, section.fast(cycles)]);
  return stepcat(...sections).slow(total);
}
```

Three things that matter for our design:

1. It's a **plain function call**. No implicit runtime context; nothing
   memoised. Each call produces a fresh `Pattern`.
2. It accepts **any expression** as the pattern — bare identifier,
   method chain, nested `arrange(...)`, a `stack()` call, whatever.
   The section's identity is the Pattern object it produces; JS
   doesn't preserve the source-level variable name.
3. The total song length is the sum of section cycles, and the result
   is `.slow(total)` so the whole loop takes exactly `total` cycles.

The `setcps` / `setcpm` tempo interacts with this in the obvious way:
cycles are time-scaled, section *proportions* are invariant.

## V0 (landed) — static-parser strip

`src/editor/arrange-parse.js` is a hand-rolled scanner in the style of
`track-labels.js`. It recognises the canonical shape:

```
arrange(
  [NUMBER, expr],
  [NUMBER, expr],
  …
)
```

and extracts `{ cycles, label, rawExpr, start, end, line }` per section
plus `{ callStart, openParen, closeParen, line, sections, totalCycles }`
per arrangement. It tolerates strings, comments, templates, and
unbalanced buffers mid-edit. Tests live at
`src/editor/arrange-parse.test.js` (19 cases, all passing).

`src/ui/arrange-bar.js` subscribes to `docChanged`, rebuilds the strip
on every edit, renders proportional `flex: <cycles>` segments, animates
the playhead off `sched.now()` via rAF, and dispatches a cursor-jump
to `section.start` on segment click. CSS at
`src/styles/arrange-bar.css`. Grid row `arrangebar` added to
`shell.css`, element mount in `index.html`, wired in `main.js`
alongside `mountTrackBar`.

### V0 limitations

Static parsing breaks silently for every one of these:

| Case | Current behaviour |
| --- | --- |
| `arrange(...sectionsArray)` (dynamic args) | Parser returns 0 sections → strip hides |
| `[VERSE_BARS, verse]` where `VERSE_BARS = 16` | Tuple rejected (non-numeric cycles) → section dropped |
| `arrange([4, verse]).slow(2)` | Strip shows 4 cycles; actual play duration is 8 |
| Nested `arrange([4, arrange([2, deep])])` | Inner not discovered; outer shown |
| `arrange(...)` inside `stack(...)` with muting via track label | Strip keeps animating when the track is muted |
| Multiple `arrange(...)` calls in the same buffer | Only the first is shown |

All of these are "looks right, is wrong" failure modes — exactly the
class the CLAUDE.md "surface silent failures loudly" rule forbids.

## V1 — runtime pivot (the real fix)

### The insight

`src/main.js:188` passes `strudelExt` as the **last** namespace to
`evalScope(...)`. `evalScope` (see
`strudel-source/packages/core/evaluate.mjs:37-55`) assigns properties
to `globalThis` and `strudelScope` in order: **later namespaces
overwrite earlier ones**. A bare `export function arrange(...)` from
`src/strudel-ext/index.js` therefore shadows the core `arrange` for
all pattern-code evaluations, without touching upstream Strudel.

Verified:

- Grep of `strudel-source/packages/` finds **zero non-test internal
  call sites** for `arrange(...)`. User code only.
- The transpiler (`plugin-mini.mjs`) rewrites only quoted strings; bare
  identifiers and array literals pass through unchanged.
- `@strudel/core` still exports the original `arrange`, so we can
  import it by name from inside the wrapper (it's only the
  `evalScope`-injected global that gets shadowed, not the module
  export).

### Shape of the wrapper

```js
// src/strudel-ext/arrange.js  (conceptual — see §11 for final shape)
import * as strudelCore from '@strudel/core';

export function arrange(...sections) {
  const result = strudelCore.arrange(...sections);
  const runtimeSections = sections.map(([cycles]) => ({ cycles }));
  const totalCycles = runtimeSections.reduce((s, x) => s + x.cycles, 0);

  // Pull labels from the parser queue (prepared on each evaluate; see
  // §6.2). If queue is empty or count mismatches, fall back to numbered.
  const parsed = dequeueNextParsedArrange();
  const labels =
    parsed && parsed.sections.length === runtimeSections.length
      ? parsed.sections.map((s) => s.label ?? null)
      : null;

  registerArrangement({
    sections: runtimeSections.map((s, i) => ({
      cycles: s.cycles,
      label: labels?.[i] ?? `Section ${i + 1}`,
      sourceStart: parsed?.sections[i]?.start ?? null,
    })),
    totalCycles,
    sourceLine: parsed?.line ?? null,
    pattern: result,
    wrapperInstanceId: nextInstanceId(),
  });

  return result;
}
```

No API change. The user writes the same `arrange([8, verse], …)` they
always did. The registry is the new signal the UI subscribes to.

### Label recovery — the queue model

Stack traces can't reliably tie a runtime `arrange()` call to a source
line (the transpiler wraps pattern code in an async IIFE, shifting line
numbers). Instead:

1. `src/main.js` hooks the existing patched `editor.evaluate()` (see
   `eval-feedback.js`). Before invoking the original, it calls
   `parseArrangements(editor.code)` and stashes the list as an ordered
   queue in the registry module.
2. On each wrapper call, we `shift()` the next parsed arrangement.
   If its section count matches the runtime arg count, we apply its
   labels. Otherwise we fall back to `Section N`.
3. On evaluate completion (or any error), drain-and-discard remaining
   parsed entries. The registry is the source of truth for the UI
   until the next evaluate.

This works cleanly for the common cases — one arrange, or sibling
arranges in source order. For nested and truly-dynamic arranges the
labels fall back to numbered sections; a `console.warn` is emitted so
the failure is visible, not silent.

### UI data-source swap

`arrange-bar.js` flips from parser-output to registry-output:

- Default: subscribe to the registry.
- Fallback: when the registry is empty (pre-first-evaluate) **and** the
  parser finds at least one arrange, render the parser output with a
  subtle "parsed (not yet played)" meta hint. This avoids the bar
  appearing to disappear between edit and play.

When the registry holds **multiple** arrangements (sibling top-level
calls), the strip renders them stacked with a small header showing each
one's source line. A v1 constraint: we show them all; we don't try to
detect "which one is live". If the user has dead-code arrange calls the
strip shows them too. Acceptable — dead code is a user problem, and
the registry only collects arranges that actually ran, so dead code
never populates the registry in the first place.

### Track-mute interaction

The existing `track-bar` parses `$:` / `name:` labels and flips them
to `_name` / `name_` on mute. Strudel drops muted tracks before the
pattern evaluates, so our wrapper **doesn't fire** for an arrange
inside a muted track — the registry omits it, the strip hides (or
fades) for that arrange.

Refinement: compute "arrangement N is inside muted track M" by
cross-referencing the parser's arrange-call offsets with
`parseLabels(code)`'s block ranges. When an arrange is inside a
muted block, render its strip dimmed even before the next evaluate,
so the UI isn't lying during an edit.

## V2 — controls

The runtime pivot earns us a safe place to hang controls. Priority
order, by composer value:

### V2.1 — Loop this section

*The single highest-value control.* During composition, you want to
hear just the chorus on loop while you tweak its contents. Today you
either comment out the rest of the arrange or rewrite the call — both
disrupt your train of thought.

Mechanism: the wrapper's registry entry keeps a reference to the
**original `sections` array** (not just `{cycles, label}` derivatives).
Clicking "loop section N" calls:

```js
const soloed = strudelCore.arrange([totalCycles, originalSections[N][1]]);
editor.repl.scheduler.setPattern(soloed); // or equivalent public API
```

The visual state (a "SOLO" pill on the section, rest dimmed) is
transient — it's not written back to the buffer. Clicking again
restores the full arrangement. Evaluating the buffer (Cmd+Enter) also
clears it.

Open question to resolve during implementation: whether Strudel's
scheduler exposes a clean "swap the live pattern without stopping"
path. If not, the fallback is a full `evaluate()` with a one-shot
override flag the wrapper checks.

### V2.2 — Seek to section

Jump the scheduler's cycle to the start of section N so playback
resumes from there. Strudel's scheduler tracks absolute cycles
(`sched.now()` is monotonic); seeking backward is a matter of
adjusting the scheduler's internal cycle offset. If that's not a
public API, the fallback is: stop, evaluate with a `.rotL(startCycle)`
applied to the arrangement, play. Acceptable UX cost — it mirrors how
Strudel's web UI handles `setcps()` changes.

### V2.3 — Rename in place

Double-click a section name → inline text input → on enter, rewrite
the buffer using the parser's `section.start`/`section.end` offsets
to replace the identifier with the new name. If the section was
inline (not a reference to a `const`), surface the rename as a diff
preview so the user can confirm it.

### V2.4 — Drag to reorder

Pointer-drag a segment across others → on drop, splice the buffer's
arrange-tuple array into the new order via CodeMirror dispatches. The
pattern auto-re-evaluates (HMR or autosave), registry rebuilds, strip
animates to the new layout.

### V2.5 — Duplicate / insert / delete

Small menu on each segment (or shift-click actions): add a copy after,
remove. All are buffer edits bounded by the parser's known offsets.

## V3 — Beyond `arrange`

`arrange` is one song-form primitive. Others users reach for:

- `cat(a, b, c)` — one section per cycle, unbounded.
- `stepcat([2, a], [4, b])` — the primitive `arrange` sugars over.
- `seqPLoop([0, 4, a], [4, 12, b])` — start/stop tuples; overlaps allowed.
- `<a b c>` in mini-notation — micro-arrangement inside a string.

A later spec should detect any of these and feed the same registry, so
the strip is "song map" rather than "arrange map". Out of scope here,
but the registry API should be designed so adding a detector for a new
primitive doesn't require UI changes.

## Edge cases

### Multiple top-level arranges

Two `arrange(...)` calls that both run: stacked strips, each with
its own header showing the source line and a small color-coded dot
(re-use `PALETTE` from `src/ui/palette.js`). The tracks bar already
has colour-coding precedent.

### Arrange wrapped in transforms

`arrange([4, a], [4, b]).slow(2).every(4, fast(2))` — the wrapper
captures the **post-arrange / pre-transform** state. The transforms
alter the audible duration but not the song form. The strip shows the
author-intended structure (8 cycles / 2 sections) and a meta badge
when any chained transform affects duration (`.slow(N)`, `.fast(N)`,
etc.) so the user isn't surprised.

Detection: parser walks the call chain following the arrange's close
paren and flags any of `slow|fast|stretch|segment` etc. Not
authoritative (users can do arbitrary things) but catches the common
cases.

### Nested arranges

Inner evaluates first; registry gets both entries in that order.
Source order is opposite. When the queue-consumer sees a mismatch
between runtime-section-count and parsed-section-count for the first
event, it falls back to numbered labels and continues. A
`console.warn` notes: "nested arrange at line X; labels fell back to
numbers". User can flatten manually or accept numbered sections.

### Dynamic section list

`arrange(...buildSections(key))` — parser finds 0 sections, queue is
empty, runtime wrapper still fires and registers real cycle counts
with numbered labels. Strip works correctly; it just lacks identifier
names. Warn once: "arrange on line X has dynamically-built sections;
labels are numbered".

### Evaluation failure mid-pattern

If evaluate throws after some `arrange` wrappers have fired, the
registry holds partial state. The UI subscribes to the registry and
shows what ran. Next evaluate clears and rebuilds. (The parser-only
fallback covers the zero-ran case.)

### Pattern code that defines but doesn't use `arrange`

`const draft = arrange([8, verse], [8, chorus]); draft.hush()` — the
wrapper still fires and registers it. That's a false positive ("this
won't actually play"). Acceptable for v1; v2 can gate the registry on
"was this Pattern ever emitted to the scheduler" via an onTrigger hook.

### User mutes a track containing an arrange

Covered in §6.5. Cross-reference parser arrange offsets with
track-label block ranges; render dimmed.

### User evaluates twice without stopping

The registry resets at the start of each evaluate. The strip briefly
shows the previous arrangement until the new one populates
(single-frame window at worst). Acceptable.

### Browser tab unfocus

`requestAnimationFrame` pauses when the tab is hidden. The playhead
freezes. On refocus, it resumes at the current `sched.now()`. Same
behaviour as the main transport.

## Architecture recap

```
     pattern source (editor buffer)
                │
                │  on docChange
                ▼
    parseArrangements(code)  →  parser output (labels, offsets)
                │
                │  on evaluate() start
                ▼
        labels queue  ─────────────┐
                                   │
                                   ▼
    arrange() wrapper  ←──  strudelExt evalScope shadow
        │      │
        │      └─►  registerArrangement({ cycles, labels, pattern, … })
        │                    │
        ▼                    ▼
   strudelCore.arrange    registry (in-memory)
        │                    │
        │                    │  subscribe
        ▼                    ▼
   Pattern (returned)   arrange-bar.js  →  DOM strip + playhead
                                    │
                                    ├─► loop-section action
                                    ├─► seek action
                                    └─► buffer-edit actions
```

## Files affected

| File | Change |
| --- | --- |
| `src/strudel-ext/arrange.js` | New: shadow wrapper + registry |
| `src/strudel-ext/index.js` | Export `arrange` from new file |
| `src/editor/arrange-parse.js` | Landed; unchanged (registry uses it) |
| `src/ui/arrange-bar.js` | Swap data source: registry-first, parser-fallback; add controls |
| `src/ui/arrange-bar.css` | Add solo-section and muted-track states |
| `src/main.js` | Hook `editor.evaluate` pre-call to prime the labels queue |
| `src/eval-feedback.js` | Possibly coordinate reset here instead (already patches evaluate) |
| `STRUDEL.md` | Note under "Strasbeat extensions" that `arrange` is locally instrumented — behaviourally identical |
| `patterns/` | Add `ben-random`-style demo pattern if none exists |

## Test plan

### Unit (node test-runner)

- `src/strudel-ext/arrange.test.js` — new.
  - Wrapper returns the same Pattern `strudelCore.arrange` would
    (bit-exact via Pattern.equals or hap-rendering parity for a few cycles).
  - Wrapper registers metadata with correct cycle counts.
  - Label merge: matching parsed count → uses labels; mismatched → numbered fallback + warning.
  - Queue drains correctly across multiple wrappers in one evaluate.

- `src/editor/arrange-parse.test.js` — landed; no changes.

### Integration (browser, manual)

Golden paths:
1. Open a fresh pattern, type `arrange([8, a], [8, b])`, see strip appear.
2. Play; playhead animates through both segments.
3. Click "loop" on segment B; only B plays on loop, A is dimmed.
4. Click segment; editor cursor jumps to the tuple.
5. Mute the `$1` track containing the arrange; strip fades.

Regression paths:
6. Pattern with no `arrange` → no strip.
7. Pattern with `arrange(...dynamicSections)` → strip shows with numbered labels + console warning.
8. Two top-level `arrange` calls → both render, stacked.
9. `arrange().slow(2)` → strip shows authored proportions + duration-badge.

### Behavioural

- Wrapper does not break `renderPatternToBuffer` (WAV export). The
  export goes through the same `evaluate` path, so the wrapper fires;
  ensure the registry-reset doesn't race with the export's
  scheduler swap (see CLAUDE.md "WAV export" gotcha).

## Phasing / landing order

V0 is landed. This spec covers V1 + V2.

1. **Phase 1** — runtime pivot. Ship the wrapper, the registry,
   and swap `arrange-bar.js`'s data source. **No behaviour change
   for users**; this is pure plumbing. Close out `v0 silent
   failure` cases via console warnings.
2. **Phase 2** — controls. Start with loop-this-section (the highest
   value, hardest to build). Ship seek / rename / reorder as
   follow-ups. Each lands independently.
3. **Phase 3** — defer. Broader song-form primitives (§9) and
   tracks × sections grid go into a future spec.

Each phase is independently mergeable. The v0 strip keeps working the
whole time.

## Open questions (surface to the user before implementation)

1. **Control surface visual**: segment-level loop/solo buttons
   (compact, discoverable) vs. segment right-click menu (cleaner,
   less discoverable) vs. a mini-toolbar that appears on hover
   (middle ground). Recommendation: hover toolbar for v1 controls;
   right-click for advanced ones.
2. **Scope of rename**: for `const chorus = stack(...)` used as
   `[8, chorus]`, should renaming rewrite just the tuple, or also
   the `const`? Recommendation: tuple only in v1; ask in v2.
3. **Loop-section UX on WAV export**: if a user has a section
   soloed and hits "export WAV", do we export the soloed section
   or the full song? Recommendation: full song (WAV is always the
   committed buffer); show a toast clarifying.

## Prior art / cross-references

- `design/work/07-chord-progression.md` — parallel runtime-helper
  pattern. Read it first; this spec assumes you've seen the evalScope
  / strudelExt mechanism it documents.
- `design/work/12-track-controls.md` — complementary track-bar
  surface. Our strip is the horizontal axis; track-bar is vertical.
- `src/editor/track-labels.js` — reference implementation for
  buffer-edit actions (mute/solo by label-name rewriting). Reorder
  / rename controls should follow the same dispatch discipline.
- CLAUDE.md §"Key gotchas" — the WAV export, `progression()`
  single-quote rule, and MIDI bridge notes are directly relevant to
  the wrapper's failure modes.
