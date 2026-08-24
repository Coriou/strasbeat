# 27 — Track mute/solo correctness + the missing-updateListener class of bug

Status: **investigated, root-caused, not yet fixed.** No code has been
changed. This doc is the complete handoff from the debugging session that
found these — everything below was verified against a running app and the
installed `@strudel/core` source, not inferred.

## Where this came from

The user reported, from memory and with low confidence, that "the live
version had bugs with the tracks (mute / unmute / solo actions)." A
systematic-debugging session confirmed **two independent high-severity
bugs**, both of which produce exactly that symptom, plus a data bug and
three minor issues.

Baseline at time of investigation (commit `97cda50`):

- `node_modules` was absent — run `pnpm install` first or every test
  "fails" for the wrong reason.
- After install: **591/591 tests pass**, `pnpm build` clean.
- **Neither BUG-1 nor BUG-2 is caught by the suite.** BUG-1 is actively
  *asserted* by it. Treat green as meaningless here until new tests exist.

## Ground truth you must read before touching anything

`@strudel/core/repl.mjs` — the authoritative mute/solo semantics. Find it
at `node_modules/.pnpm/@strudel+core@*/node_modules/@strudel/core/repl.mjs`
(there is no `strudel-source/` checkout in this working copy; CLAUDE.md
mentions one, but it is gitignored and currently absent).

```js
// repl.mjs:172
Pattern.prototype.p = function (id) {
  if (typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'))) {
    return silence;          // ← returns BEFORE registering
  }
  if (id.includes('$')) { id = `${id}${anonymousIndex}`; anonymousIndex++; }
  pPatterns[id] = this;
  return this;
};

// repl.mjs:240 — solo scan, runs ONLY over Object.entries(pPatterns)
const isSolod = key.length > 1 && key.startsWith('S');
if (isSolod && soloActive === false) { patterns = []; soloActive = true; }
if (!soloActive || (soloActive && isSolod)) { patterns.push(...); }
```

Three facts that follow, and that the fix must respect:

1. Mute is `_` **prefix or suffix** — both are valid, equally.
2. Solo is `S` prefix with `length > 1`.
3. **Mute short-circuits before registration**, so a muted track is
   invisible to the solo scan. Mute and solo are *not* orthogonal.

`src/editor/track-labels.js:1-14` (`getLabelShape`) mirrors rules 1 and 2
exactly. It does not account for rule 3. That is BUG-1.

---

## BUG-1 — combined mute+solo is unrepresentable, and inverts solo

**Severity: high. User-facing, trivially reachable, silently wrong.**

`getLabelShape` models `muted` and `soloed` as independent flags, and both
`toggleMute` and `toggleSolo` will happily emit the combined form
`S<name>_`. Strudel drops that track entirely (rule 3), so `soloActive`
never becomes `true` and **solo filtering is skipped for the whole
pattern**.

Measured in the running app on `patterns/01-hello.js`, with source
`drums, Sbass_, lead, leadrev` (bass marked soloed *and* muted):

```
29 haps → { drums: 14, lead: 11, leadrev: 4 }    // bass: 0
```

Everything *except* the soloed track sounds. The exact inverse of intent,
with the track bar cheerfully displaying "Muted and soloed".

### The gesture that triggers it

Shift-click a track to solo it, then click it again to un-solo — but
forget to hold shift. That second click is a *mute*. The isolated track
goes silent and the others come back at full volume: **mute makes the
pattern louder.** Same path via `Cmd+M` after `Cmd+Shift+S`.

Reachable identically from all three entry points, which all pass
`displayName` into the same two toggles:

- `src/ui/track-bar.js:113` (click / shift-click)
- `src/editor/keymap.js:82,88` (`Cmd+M`, `Cmd+Shift+S`)
- `src/command-palette-actions.js:42,49`

### Decision already made by the user

**Mute and solo are mutually exclusive per track.** Soloing a muted track
clears its mute; muting a soloed track clears its solo. `S<name>_` must
become unwritable, so the UI can never display a state the engine won't
honor. Each click does exactly the thing that was clicked.

The user explicitly rejected the DAW-accurate alternative (muted+soloed
means total silence), because expressing it in Strudel would require
rewriting every *other* track's label — too invasive for the payoff.

### The tests currently assert the bug

`src/editor/track-labels.test.js` contains, among others:

```js
assert.equal(toggleSolo(code, 'lead'), 'Slead_: note("c3").s("sawtooth")');
assert.equal(toggleMute(code, 'lead'), 'Slead_: note("c3").s("sawtooth")');
```

and the `parseLabels` case asserts `Slead_` → `{muted: true, soloed: true}`.
These encode the broken model and **must be rewritten**, not worked around.
Whether `parseLabels` should still *report* both flags for a hand-written
`Slead_` (so the UI can warn about a file someone typed by hand) is a real
design question — decide it deliberately rather than by accident.

---

## BUG-2 — three updateListeners are missing from every tab but one

**Severity: high. This is very likely the bug the user actually remembers,
because it makes the track buttons dead.**

### Root cause

`src/main.js:962` captures `cleanBaseState`:

```js
const cleanBaseState = editor.editor.state;
```

Its own comment (`main.js:956-961`) claims it is captured "after the editor
is fully configured (dispatchEditorExtensions + installCompletions + the
appended updateListeners)". **That claim is false.** Three mounts append
their listeners afterwards:

| line | mount | mechanism |
|---|---|---|
| 1289 | `mountTrackBar` | `StateEffect.appendConfig` + `updateListener` |
| 1294 | `mountArrangeBar` | same (`arrange-bar.js:452`) |
| 1310 | `mountBeatGrid` | same (`beat-grid.js:656`) |

Every fresh tab is built by `freshTabState(cleanBaseState, …)`
(`src/editor/build-editor-state.js`), so it inherits a config that predates
all three. Compounding it, `installTabState` (`main.js:983`) swaps tabs via
`view.setState()`, which does not fire `updateListener`s at all — the code
already flags this hazard at `main.js:984` but only compensates for
`editor.code` / `repl.setCode`.

### Evidence — timer-free, measured live

Counting `view.state.facet(EditorView.updateListener).length` per tab:

| Tab | listener count |
|---|---|
| Mellow (the tab live when the mounts ran) | **8** |
| Hello | **5** |
| Chords | **5** |
| back to Hello | **5** |

Exactly three missing, one per mount.

### User-visible consequence, reproduced

With the document containing tracks `alpha, beta`, the track bar still
displayed `drums, melo, bells, choir` from the previous tab. Clicking a
button was a **dead no-op** (`editor.code` unchanged) and logged:

```
[strasbeat/track-labels] could not find label "drums" for mute toggle
```

Worse case: if the newly-focused pattern happens to share a track name at a
different index, the click toggles the **wrong track** instead of no-oping.

### This already has a workaround in the tree — remove it as part of the fix

`src/ui/beat-grid.js:663-671`:

> "Belt-and-suspenders: the `StateEffect.appendConfig` listener above
> **sometimes stops firing after unrelated CM reconfigurations** —
> reproducible in both beat-grid and arrange-bar during the same session.
> A 100ms interval poll catches every missed doc update."

That is this bug, observed but not root-caused, and papered over with a
permanent `setInterval`. The poll is why beat-grid still works; track-bar
and arrange-bar never got one. **Once the root cause is fixed, delete the
poll** (`beat-grid.js:672-681`) — keeping it would preserve a forever-timer
for a problem that no longer exists.

### Shape of the fix (not prescriptive — verify before committing)

Two things are wrong and both need addressing; fixing only one leaves a
real hole:

1. **Ordering** — `cleanBaseState` must be captured *after* all extensions
   are appended, or the three mounts must install via a mechanism that
   survives into fresh states. Moving the capture below line 1310 is the
   obvious move, but confirm it doesn't drag unwanted history/doc state
   into the base (the whole point of that capture is *empty history* —
   see the reasoning in `build-editor-state.js`'s header comment, which is
   sound and should be preserved).
2. **`setState` doesn't notify** — tab switches must explicitly rebuild the
   track bar / arrange bar / beat grid, the same way `installTabState`
   already explicitly syncs `editor.code`. A listener alone will never fire
   on a `setState` swap even once ordering is fixed.

Beware the measurement trap documented below when verifying.

---

## BUG-3 — `patterns/captainmo.js` is committed with a solo left on

**Severity: data / low-medium.**

The file's first label is `Slead:`. Only the lead sounds — measured 21
haps, with `choirs` and `bass` silent. Almost certainly an audition that
got saved and committed.

Fixing the file is one character. The interesting question is whether
save/export should warn when the buffer contains an active solo or mute,
since source-as-truth makes this trivially easy to do by accident. Treat
that as a genuine design decision, not an obvious yes.

---

## Minor issues, all verified

- **`toggleSolo` rewrites mute style.** On a prefix-muted `_bass` it emits
  `Sbass_`, silently converting prefix-mute to suffix-mute. Both are valid
  to Strudel, so it isn't audible — but it edits source the user didn't ask
  to change. Under the mutual-exclusion rule this may disappear on its own;
  check rather than assume.
- **`muteStyle` is dead.** Computed in `getLabelShape`
  (`track-labels.js:6-10`), never read anywhere in the codebase. Either use
  it to preserve the author's chosen mute style, or delete it.
- **Duplicate track names.** Two `lead:` labels both get `displayName`
  `lead`; `findTargetLabel` always returns the first, so clicking the second
  toggles the first. Note Strudel itself clobbers duplicate ids in
  `pPatterns`, so such a file is already semi-broken upstream — low
  priority, and arguably better solved by surfacing a warning than by
  disambiguating.

## Ruled out — do not re-investigate these

Each was suspected and then disproven with evidence:

- **Piano-roll vs track-bar colors disagreeing.** They agree. Both use
  `PALETTE[labels.indexOf(label) % PALETTE.length]`
  (`piano-roll.js:411`, `track-bar.js:57`). `colorForKey`'s
  insertion-order Map is only a fallback for *unlabeled* haps. The comment
  at `track-bar.js:13-15` describing the two as merely coincidentally
  aligned is **stale and misleading** — worth correcting while nearby.
- **A track named `Snare` parsing as soloed `nare`.** Real, but upstream
  applies the identical `length > 1 && startsWith('S')` rule, so strasbeat
  matches Strudel exactly. Not our bug. Document it, don't "fix" it into a
  divergence.
- **Track-bar rAF debounce being too slow / broken.** It is correct; it
  caught up within two frames when properly foregrounded.
- **Boot-time console errors.** Switching through all 17 patterns produced
  zero errors or warnings.

## Measurement trap — this cost real time, don't repeat it

The automation browser's event loop **freezes between tool calls**. A probe
scheduled inside one `preview_evaluate` and read in the next showed
`rafFired: false` *and* `timeoutFired: false` after 5.7 s of wall time.

Anything rAF- or timer-driven — which includes every one of these bars'
`scheduleRebuild` paths — will therefore look broken whether or not it is.
The first read of BUG-2 was confounded exactly this way.

**Use synchronous, timer-free assertions instead**, e.g. counting
`view.state.facet(EditorView.updateListener).length`, or driving a doc
change and reading `editor.code` in the *same* evaluate. That is what
produced the 8-vs-5 table.

## Files in scope

```
src/editor/track-labels.js        # BUG-1 root — getLabelShape + both toggles
src/editor/track-labels.test.js   # asserts the bug today; must be rewritten
src/main.js:962, 983-997, 1289-1310  # BUG-2 root — capture order + setState swap
src/ui/track-bar.js               # dead listener victim; stale comment at 13-15
src/ui/arrange-bar.js:452         # dead listener victim, no mitigation
src/ui/beat-grid.js:656-681       # has the poll workaround — delete once fixed
src/editor/build-editor-state.js  # freshTabState; header reasoning is sound, keep it
patterns/captainmo.js             # BUG-3
```

Entry points that must all stay consistent (they share the toggles):
`src/ui/track-bar.js`, `src/editor/keymap.js`,
`src/command-palette-actions.js`.

## Acceptance

**BUG-1**
- `S<name>_` can never be produced by any toggle from any entry point.
- Soloing a muted track clears the mute; muting a soloed track clears the
  solo; each is verified through the real repl semantics, not just string
  equality on the label.
- Round-trip: every toggle applied twice returns the source to byte-identical
  original, for named, anonymous (`$:`), prefix-muted and suffix-muted forms.
- A test asserts the *audible* outcome, not just the emitted text —
  simulating `p()` + the solo scan is enough and needs no browser. The
  session used exactly such a harness; rebuild it as a real test rather
  than a throwaway script.

**BUG-2**
- Every tab reports the same `updateListener` count; no tab is special.
- Switching tabs updates track bar, arrange bar and beat grid immediately,
  without relying on a subsequent doc edit.
- Track buttons act on the focused document in every tab — never a no-op,
  never the wrong track.
- `beat-grid.js`'s 100ms poll is deleted and beat-grid still updates.
- Verified with timer-free assertions (see the trap above).

**General**
- `pnpm test` green *and* the new tests demonstrably fail against the
  current code before the fix lands. Green today proves nothing here.

## Out of scope

Not investigated in that session, and explicitly **not** part of this task —
raise separately if you find something:

- share codec, WAV export, MIDI import, store reconciliation paths
- any redesign of the tracks UI beyond what these fixes require
- upstream Strudel patches (`p()` / the solo scan live in `@strudel/core`;
  changing them belongs upstream, per CLAUDE.md)
