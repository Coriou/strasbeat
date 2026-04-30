# 22 — Intellisense v2 (ranking · ergonomics · sample/bank coherence)

> Status: design — 2026-05-01. Read `../README.md`, `../SYSTEM.md`,
> `../../CLAUDE.md`, `04-intellisense.md` (the v1 it supersedes), and
> `21-keybindings.md` (this spec composes with the keymap-profile
> system shipped there) before starting.

## Goal

Take strasbeat's autocomplete from "useful POC" to "feels like
VS Code IntelliSense." Three movements on one foundation:

1. **Ranking.** Replace the prefix-then-substring chain with a fuzzy
   subsequence kernel + buffer-presence boost + recency boost. The
   right answer is at the top, no scrolling.
2. **Ergonomics.** Tab-to-accept, snippet placeholders, smarter
   auto-trigger, modifier-held audio audition. The keystrokes that work
   in VS Code, JetBrains, and Sublime work here.
3. **Sample/bank coherence.** Variant completion (`bd:N`),
   bank-aware ranking, reveal-in-browser shortcut, audition in the
   popup. The composer's most common ask — "which sound?" — has IDE-grade
   support across every surface.

Phased delivery — each phase is independently shippable. Order is
**1 → 2 → 3 → 4**.

## Non-goals

- No LSP server, no type inference, no multi-file go-to-definition.
- No replacement of Strudel's mini-notation parser.
- No replacement of the keymap-profile system from `21-keybindings.md` —
  this spec plugs into it.
- No replacement of `signature-hint.js` or `hover-docs.js` — phase 2 of
  spec `04-intellisense.md` stays good.
- No new build dependency. The fuzzy kernel is hand-rolled (~150 LOC).

## Background

The current implementation lives in `src/editor/completions/sounds.js`
(monolith) and `src/editor/completions/mini-notation.js`. It is a
combined-handler chain: tree-based mini-notation source, plus regex
handlers for `s()`/`sound()`, `bank()`, `chord()`, `scale()`, `mode()`,
plus a function-name fallback. Filtering is prefix-then-substring.
Ordering is alphabetical with a small `boost: 2` for prefix matches.
There is no buffer-awareness, no recency, no audio preview in the
popup, no snippet expansion, no variant completion, no bank-context
propagation, no auto-trigger on `.`/`(`/space-inside-string.

The Strudel runtime semantics relevant to this design (verified
against `strudel-source/`):

- **`s("bd:N")`** parses the colon as a positional-argument separator;
  `n` ends up as `hap.value.n`. Playback resolves with
  `urls[n % urls.length]` (`webaudio/supradough.mjs:27-35`). For
  array-form sample data we can offer numeric variants `0..n-1`. For
  object-form chromatic soundfonts the lookup still happens but the
  meaning is muddier — skip.
- **`bank("X")`** is a per-event control; playback prepends with `_`:
  `(hap.value.bank ? hap.value.bank + '_' : '') + hap.value.s`
  (`webaudio/supradough.mjs:27`, `core/controls.mjs:749`). It applies
  along the JS expression chain (`.method().method()`), independently
  per chain inside `stack(...)`.
- **`note(...)`** accepts only note names + accidentals + octaves +
  MIDI numbers (`core/controls.mjs:410-431`). No chord symbols.
- **`chord(...)`** accepts only chord symbols (`core/controls.mjs:2298`,
  parser at `tonal/tonleiter.mjs:22`). No plain notes.

These four facts shape the sample/bank phase decisively.

## Mental model: four layers

```
┌────────────────────────────────────────────────────────────────┐
│ providers/                  CompletionSource per category      │
│   sounds.js   bank.js   chord.js   mode.js   functions.js      │
│   mini-notation.js  (covers s/sound/note/n inside-string)      │
│         │           │           │           │                  │
│         ▼           ▼           ▼           ▼                  │
├────────────────────────────────────────────────────────────────┤
│ score.js — fuzzy subsequence kernel (pure)                     │
│   score(query, candidate) → { score, matched } | null          │
├────────────────────────────────────────────────────────────────┤
│ context.js — buffer signal + recency table                     │
│   bufferTokens(state) → Map<category, Set<string>>             │
│   recency.bump(category, label)                                │
│   recency.score(category, label) → 0..1                        │
├────────────────────────────────────────────────────────────────┤
│ install.js — wires CM6 autocompletion compartment              │
│   override: [providers], filter: false, custom render          │
└────────────────────────────────────────────────────────────────┘
```

`filter: false` is set globally — the kernel owns filtering and ranking
end-to-end. CM6's role shrinks to rendering the dropdown, dispatching
`Completion.apply`, and managing keyboard navigation.

**Final score per candidate.** Match score is universal (0..1 from the
kernel); category bonuses are additive. The cross-category sort emerges
from `categoryBaseBoost`, not from a per-category match weight.

```
finalScore =
    matchScore           // 0..1 from score.js, null = no match → drop
  + bufferBoost          // 0..0.5 if literal appears in the buffer
  + recencyBoost         // 0..0.3 from recency table (linear decay)
  + categoryBaseBoost    // sound > note > function (cross-category)
  - lengthPenalty        // 0.001 × candidate.length, tiebreaker
```

## Files added / modified (across all phases)

```
NEW
src/editor/completions/score.js                    (Phase 1)
src/editor/completions/score.test.js               (Phase 1)
src/editor/completions/context.js                  (Phase 1)
src/editor/completions/context.test.js             (Phase 1)
src/editor/completions/install.js                  (Phase 1, replaces old install)
src/editor/completions/providers/sounds.js         (Phase 1, extended Phase 3)
src/editor/completions/providers/bank.js           (Phase 1)
src/editor/completions/providers/chord.js          (Phase 1)
src/editor/completions/providers/mode.js           (Phase 1)
src/editor/completions/providers/mini-notation.js  (Phase 1, colon-aware Phase 3)
src/editor/completions/providers/functions.js      (Phase 1, snippets Phase 2)

MODIFIED
src/editor/mini-notation-tokens.js                 (colon-aware return shape, Phase 3)
src/editor/keymap-universal.js                     (Alt audition Phase 2; Cmd+Shift+B Phase 3; Cmd+J Phase 4.C)
src/ui/sound-browser.js                            (focusSound() method, Phase 3; drag handle Phase 4.A)
src/ui/transport.js                                (bank chip, Phase 4.B)
src/main.js                                        (install + reveal-event listener)
src/command-palette-actions.js                     (reveal entry Phase 3; focus-browser entry Phase 4.C)
src/editor-actions.js                              (previewSoundName accepts optional `n`, Phase 3)

DELETED
src/editor/completions/sounds.js                   (superseded — split into providers/)
src/editor/completions/mini-notation.js            (superseded — moved to providers/)
```

The current `src/editor/completions/sounds.js` monolith is removed.
There is no transitional shim — strasbeat is a personal tool with no
external consumers (per `CLAUDE.md` "no backwards-compat shims").

---

## Phase 1 — Ranking engine

### What

A pure scoring kernel and a context module that together replace the
current prefix/substring matching. After Phase 1, the popup looks the
same as today (no new UI), but the order and contents of the list are
substantially better.

### The kernel — `score.js`

Public surface, two functions:

```js
/**
 * @param {string} query
 * @param {string} candidate
 * @returns {{ score: number, matched: number[] } | null}
 */
export function score(query, candidate) { … }

/**
 * Highlight render helper — same matched-indices array score() returns.
 * @param {string} candidate
 * @param {number[]} matched
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function segment(candidate, matched) { … }
```

`score(query, candidate)` returns `null` if `query` is not a
case-insensitive subsequence of `candidate`. Otherwise it returns a
score in `[0, 1]` and the indices of `candidate` where each query
character matched (used by the renderer to bold matched chars
contiguously).

**Scoring weights** (named constants, tuned against fixtures, easily
adjustable):

| Signal                          | Weight       | Notes                                  |
| ------------------------------- | ------------ | -------------------------------------- |
| Subsequence base                | 0.30         | Required for any non-null score        |
| Prefix match (cand[0] hit)      | +0.40        | Strongest single bonus                 |
| Word-boundary hit               | +0.15 each   | After `_` / `-` / digit→letter / camelHump |
| Run continuation (per additional char beyond first in a contiguous run) | +0.05 | Prefers `gm_p` over `g_m_p` |
| Length penalty                  | −0.001 × len | Tiebreaker, prefers shorter            |

Scores stay in a comfortable `[0, 1.5]` range typically. They are
*relative*, not calibrated — only ordering matters.

**Worked traces** (these become test fixtures; numbers verified against the implementation outline below):

| Query  | Candidate         | Score    | Components                              |
| ------ | ----------------- | -------- | --------------------------------------- |
| `gmpw` | `gm_pad_warm`     | ~1.19    | base + prefix + 3 boundaries + 1 contig − len |
| `pia`  | `piano`           | ~0.95    | base + prefix + 1 boundary + 2 contig − len |
| `pia`  | `gm_piano`        | ~0.54    | base + 1 boundary + 2 contig − len      |
| `pia`  | `gm_pad_choir`    | `null`   | no `i` after `p` in candidate           |
| `bd`   | `bd_kick`         | ~0.89    | base + prefix + 1 boundary + 1 contig − len |
| `bd`   | `808bd_kick`      | ~0.49    | base + 1 boundary (digit→letter) + 1 contig − len |

Ties are broken by length — `bd` < `bd_kick` < `808bd_kick`. With a
buffer-present boost layered on top, `bd_kick` (in buffer) overtakes
`bd` (cold). With recency, a recently-used `bd` retakes the top.

**Implementation outline.**

```js
function score(query, candidate) {
  const q = query.toLowerCase();
  const cLow = candidate.toLowerCase();
  if (!q) return { score: 0, matched: [] };

  const matched = [];
  let qi = 0, ci = 0;
  let lastMatched = -1;
  let runBonus = 0;
  let boundaryBonus = 0;
  let isPrefix = false;

  while (qi < q.length && ci < cLow.length) {
    if (q[qi] === cLow[ci]) {
      matched.push(ci);
      if (qi === 0 && ci === 0) isPrefix = true;
      if (ci === 0 || isWordBoundary(candidate, ci)) boundaryBonus += 0.15;
      if (lastMatched !== -1 && ci - lastMatched === 1) runBonus += 0.05;
      lastMatched = ci;
      qi++;
    }
    ci++;
  }
  if (qi < q.length) return null;

  const score =
    0.30 +
    (isPrefix ? 0.40 : 0) +
    boundaryBonus +
    runBonus -
    candidate.length * 0.001;
  return { score, matched };
}

// `s` is the original-case candidate (camelHump check needs case info).
function isWordBoundary(s, i) {
  if (i === 0) return true;
  const prev = s[i - 1];
  if (prev === '_' || prev === '-') return true;
  // digit → letter boundary (e.g., "808bd")
  if (prev >= '0' && prev <= '9' && /[a-zA-Z]/.test(s[i])) return true;
  // camelHump: lowercase → uppercase
  return prev === prev.toLowerCase() && s[i] !== s[i].toLowerCase();
}
```

Pure, no DOM, no CM6 imports. Tests run under `node --test`.

### The context module — `context.js`

Two responsibilities, kept in one module because they share the
debounced doc-walk.

**Buffer-token extraction.** A CM6 `ViewPlugin` listens for
doc-changes (debounced 150ms — selection changes are ignored). It walks
the syntax tree once, extracting:

| Category | Source                                              |
| -------- | --------------------------------------------------- |
| `sound`  | string contents of `s(…)` / `sound(…)` calls, tokenized by mini-notation separator |
| `bank`   | string arg of `bank(…)`                             |
| `chord`  | string contents of `chord(…)` calls                 |
| `function` | bare identifiers used as function callees         |

Stored as `Map<category, Set<string>>`. Per-keystroke lookup is
`O(1)` via `set.has(label)`. Memory: bounded by buffer size.

The walker reuses the same syntax-tree traversal logic as
`signature-hint.js` and `mini-notation.js` providers — extracted into a
shared helper `findCallsAndArgs(state)` to avoid duplication.

**Recency table.**

```js
recency = {
  sound:    [{ label, t }, …],   // capped 32 entries
  function: [{ label, t }, …],
  bank:     [{ label, t }, …],
  chord:    [{ label, t }, …],
  note:     [{ label, t }, …],
  mode:     [{ label, t }, …],
};
```

`bump(category, label)` adds or updates the entry's `t = Date.now()`,
sorts by `t` descending, drops at index 32. Persisted to
`localStorage("strasbeat:completions-recency")` debounced 1s after the
last bump. On startup, hydrate from localStorage; on a `storage` event
(cross-tab signal), refresh the in-memory copy. Ignore quota errors
silently — recency is best-effort.

`score(category, label)` returns `max(0, 1 − ageDays / 30) × 0.3` — a
30-day linear decay producing `[0, 0.3]`. Unused entries auto-fade out
of relevance.

`bump` is called from `install.js`'s `Completion.apply` wrapper —
every accepted completion records its category + label.

### Per-category boost weights

| Category                                | Buffer boost | Recency boost (max) | Base boost |
| --------------------------------------- | ------------ | ------------------- | ---------- |
| Sound (in `s()`/`sound()` literal)      | +0.50        | +0.30               | +1.0       |
| Bank (in `bank()` literal)              | +0.40        | +0.30               | +0.8       |
| Note (in `note()`/`n()` literal)        | +0.30        | +0.20               | +0.6       |
| Chord symbol (in `chord()` literal)     | +0.30        | +0.20               | +0.5       |
| Mode keyword (in `mode()` literal)      | +0.20        | +0.10               | +0.5       |
| Function name (bare identifier)         | +0.40        | +0.30               | +0.0       |

Numbers are first cuts. They are tuned against the fixture set during
implementation; final values get committed alongside the fixtures.

The function category gets `+0.0` base so when the user is inside a
`s("…")` literal, sounds always outrank function names that happen to
match the same fragment.

### Empty-query starter shelf

When `Ctrl+Space` is pressed with no fragment:

1. Each provider returns its top 20 candidates ranked purely by
   `bufferBoost + recencyBoost + baseBoost`.
2. Cold case (no buffer presence, no recency, e.g. fresh pattern,
   first session): the sounds provider falls back to a hand-curated
   "popular defaults" list of 12 — `bd`, `sd`, `hh`, `oh`, `cp`,
   `ride`, `gm_piano`, `gm_pad_warm`, `gm_strings`, `sine`, `saw`,
   `tri`. Lives in `providers/sounds.js` as a constant.

Other providers (chord, mode) have small enough universes that
returning the entire list is fine — the sound provider is the only one
that needs a starter shelf.

### Files

- `src/editor/completions/score.js` (+ test)
- `src/editor/completions/context.js` (+ test)
- `src/editor/completions/install.js`
- `src/editor/completions/providers/{sounds,bank,chord,mode,mini-notation,functions}.js`
- `src/main.js` (one-line change to call new install)

### Acceptance — Phase 1

- `gmpw` returns `gm_pad_warm` in the top 3 for `s("…")`
- `pian` returns `piano` first, `gm_piano` second (or vice versa,
  tie broken by recency)
- A sound used elsewhere in the buffer ranks above an unused sibling
  on the same query (verified for `bd` already in buffer)
- After accepting `gm_piano` once, it ranks higher on the next pattern
  reload than untouched alternatives
- Empty `Ctrl+Space` inside `s("…")` shows up to 20 contextually-relevant
  items (or the curated 12 in the cold case)
- Function fallback never outranks a contextual category match
- All scoring functions covered by unit tests with named fixtures
- Cross-tab recency sync works (open two tabs, accept in one,
  the other tab's table updates)

---

## Phase 2 — Editor ergonomics

### What

The keystrokes and visual affordances that make the popup feel native
to a VS Code / IntelliJ user.

### Tab-to-accept

CM6's stock `completionKeymap` does **not** bind Tab to
`acceptCompletion` — only `Enter` (verified by reading
`node_modules/@codemirror/autocomplete/dist/index.cjs:2060-2070`). The
only Tab binding the autocomplete extension contributes is
`Tab → nextSnippetField`, active during snippet expansion.

So we add an explicit Tab → accept binding at `Prec.highest`, gated on
"popup open AND no active snippet", in `install.js`:

```js
keymap.of([
  {
    key: "Tab",
    run: (view) => {
      if (completionStatus(view.state) !== "active") return false;
      if (hasNextSnippetField(view.state)) return false;  // CM6 keeps Tab
      return acceptCompletion(view);
    },
  },
])
```

Precedence:

- Popup open + no snippet → our Tab binding fires (accept)
- Popup open + snippet active → CM6's stock Tab → next field
- Popup closed + insert mode → existing VSCode-overlay Tab indent
  (per `21-keybindings.md` Layer 3)
- Popup closed + Vim normal mode → Vim's Tab handling (default no-op)

Precedence is enforced by `Prec.highest` on our binding so it wins
over the VSCode overlay's Tab indent when the gate-condition matches.

### Snippet placeholders

Use `@codemirror/autocomplete`'s `snippet()` apply function. Each
function-name completion gets an explicit template:

| Trigger              | Snippet inserted   | Cursor lands  |
| -------------------- | ------------------ | ------------- |
| `s` (bare)           | `s("${1}")`        | inside quotes |
| `sound` (bare)       | `sound("${1}")`    | inside quotes |
| `note` (bare)        | `note("${1}")`     | inside quotes |
| `n` (bare)           | `n("${1}")`        | inside quotes |
| `bank` (bare)        | `bank("${1}")`     | inside quotes |
| `chord` (bare)       | `chord("${1}")`    | inside quotes |
| `stack` (bare)       | `stack(${1})`      | inside parens |
| `setcpm` (bare)      | `setcpm(${1})`     | inside parens |
| `cat` (bare)         | `cat(${1})`        | inside parens |
| Sound name inside `s("…")` | bare label   | end of label  |

Templates live in a single map in `providers/functions.js`. We don't
chain placeholders (`stack(\n  s("$1"),\n  s("$2"),\n)`) — keeps the
inserted text predictable. Tab during snippet active state moves to
the next placeholder if any; CM6 handles this.

**Format-while-snippet-active edge.** The Prettier formatter from
`src/editor/format.js` does a wholesale doc replace, which cancels the
active snippet (markers don't survive the replace). Acceptable
behavior — document it. Acceptance: format-during-snippet doesn't
crash and produces well-formed output.

### Auto-trigger characters

CM6's autocompletion has `activateOnTyping: true` (default). It fires
on word characters out of the box. We **add** explicit triggers via a
short list passed to the autocomplete config:

```js
autocompletion({
  override: [combinedSource],
  filter: false,
  closeOnBlur: false,
  activateOnTyping: true,
  activateOnTypingDelay: 80,    // CM6 default
})
```

For non-word triggers (`.`, `(`, `"`, `'`, ` ` inside mini-notation),
each provider returns non-null when the cursor's preceding character
matches and the position is meaningful (e.g., space-inside-string returns
top-20 contextual sounds). Since `activateOnTyping: true` calls
providers on every keystroke, we just need our providers to be smart
about the empty-fragment case.

### Modifier-held audition (Alt / Option + arrows)

A new CM6 plugin in `install.js` watches the autocomplete state.
When all four conditions hold:

1. Popup is open (`completionStatus(state) !== null`)
2. `Alt` / `Option` is held
3. The user pressed `ArrowDown` or `ArrowUp`
4. The newly selected completion is auditionable (sound, mini-notation
   sound)

…then it calls `previewSoundName(label, ctx)` (existing function from
`editor-actions.js` — `ctx` is the same `{ getAudioContext, getSound,
superdough, setStatus }` shape the sound browser passes). Releasing Alt
does nothing — the envelope decays naturally. Non-auditionable
completions (functions, chord symbols) just move selection silently.

**Implementation.** A `keymap.of([...])` with `Prec.high()`:

```js
{ key: "Alt-ArrowDown", run: (view) => {
    moveCompletionSelection(true)(view);
    auditionSelected(view);
    return true;
  }
},
{ key: "Alt-ArrowUp", run: (view) => {
    moveCompletionSelection(false)(view);
    auditionSelected(view);
    return true;
  }
}
```

`auditionSelected` reads the currently-selected completion via
`currentCompletions(state)`, finds its label, dispatches
`previewSoundName` if the type is `sound` or `variable` (mini-notation
sound).

### ▶ icon in completion rows

For sound-typed completions, the row's `Completion.info` returns a DOM
node containing a small ▶ button. Click → `previewSoundName(label)`.
The icon is a click-only overlay (`mousedown` + `e.preventDefault()`
to avoid blurring the popup).

This complements the modifier-held audition — the icon is for users
who prefer the mouse; the modifier is for keyboard-first users. Both
share the same audio path.

The icon is wired even when the popup row isn't selected — clicking
selects-and-auditions in one gesture.

### Info panel

The info panel renders automatically beside the popup when the
selected completion has an `info` callback (current behavior). No new
keybinding — keeps the popup quiet by default. Hover docs (the
existing `hover-docs.js`) covers the "I want to read about this token"
flow outside the completion popup.

### Keyboard ergonomics summary

| Key                | Popup open                      | Popup closed                            |
| ------------------ | ------------------------------- | --------------------------------------- |
| Tab                | Accept selected (or next snippet field) | Indent (insert mode) / Vim handling |
| Enter              | Accept selected                 | Newline                                 |
| Esc                | Close popup                     | Vim: enter normal mode                  |
| Ctrl+Space         | (already open, no-op)           | Open popup (incl. starter shelf)        |
| ArrowDown / ArrowUp| Move selection                  | (default cursor movement)               |
| Alt + ArrowDown/Up | Move + audition selected        | (free for Vim/profile use)              |
| `.` `(` `"` `'`    | (already open, refines)         | Auto-trigger popup                      |

### Vim / keymap-profile interface

Per `21-keybindings.md`'s three-layer model:

- **Auto-trigger respects insert mode automatically.** CM6 +
  `@replit/codemirror-vim` only forwards keystrokes to the editor
  while in insert mode; in normal/visual/replace, autocomplete sees
  nothing. No special wiring needed.
- **All new keybindings live at Layer 2** (`keymap-universal.js`):
  `Tab` accept-completion (with snippet-aware gate), `Alt+ArrowDown/Up`
  audition, `Cmd+Shift+B` reveal-in-browser (Phase 3),
  `Cmd+J` focus-browser-with-token (Phase 4.C). Every profile inherits
  these.
- **No collision with `:w` / `:q` / `gc`.** None of our new bindings
  use modal Vim shortcuts. Verified against the keybinding catalog in
  spec 21.
- **Audition modifier is Alt/Option** specifically because Vim insert
  mode does not claim it.
- **Tab-to-accept precedence** is enforced by `Prec.highest` on our
  Tab binding, which gates on "popup open + no active snippet" and
  delegates to the next handler otherwise (existing VSCode-overlay
  Tab indent in insert mode, Vim handling in normal mode).

### Acceptance — Phase 2

- Tab accepts when popup open; falls through to indent / Vim default
  when closed
- `s` + Tab inserts `s("|")` with cursor inside the quotes (snippet
  placeholder)
- Auto-trigger fires on `.`, `(`, `"`, `'`, and space inside known
  mini-notation literals
- `Alt+↓` moves selection AND auditions the sound
- `Alt+↓` on a non-audible completion moves selection silently
- ▶ click previews without closing the popup
- All five profiles (Strudel / VSCode / Vim / Emacs / Helix) produce
  the same popup behavior in insert mode
- Vim normal-mode `j` / `k` movement does not fire the popup
- Format-during-snippet-active doesn't crash; snippet cancels gracefully

---

## Phase 3 — Sample/bank coherence

### What

Three features that make sample workflows feel first-class:

- **3.A** — variant completion `s("bd:N")`
- **3.B** — bank-aware ranking
- **3.C** — `Cmd+Shift+B` reveal-in-browser

All three reuse Phase 1's ranker and Phase 2's audition mechanism. No
new UX primitives.

### 3.A — Sample variant completion

When the cursor sits after a colon inside an `s()` / `sound()`
mini-notation token (e.g. `s("bd:|")`), the popup switches to numeric
variant completion.

**Tokenizer change.** `mini-notation-tokens.js:tokenAtOffset` already
treats `:` as a separator. Extend to return:

```js
{ token: string, from: number, to: number, prevSeparator: ':' | null }
```

`prevSeparator` is the character immediately before `from` if it's a
mini-notation separator. Lets the provider distinguish "fresh token"
from "after-colon variant fragment".

**Provider change.** In `providers/mini-notation.js`, when
`prevSeparator === ':'`:

1. Walk back past the `:` to find the prior token (the sound name).
   E.g. `bd:` → prior token is `bd`.
2. Apply bank context (Phase 3.B): if a `.bank("X")` is in the same
   chain, look up `X_<token>`. Otherwise look up `<token>` directly.
3. Read `data.samples` from `soundMap.get(resolvedName)`:
   - **Array form** (`["bd_001.wav", "bd_002.wav", …]`): emit
     completions `0`, `1`, …, `n-1` with `detail` showing the file
     name (`bd_002.wav` for variant `1`, etc.).
   - **Object form** (chromatic soundfont, keys are MIDI numbers):
     skip — emit no completions. The colon's meaning here is too
     muddy for autocomplete to be helpful.
   - Missing or empty: skip.

Each variant is auditionable via the Phase 2 modifier (Alt+arrow). The
audition uses an extended `previewSoundName(resolvedName, ctx, { n })`
signature — `editor-actions.js:previewSoundName` is updated in Phase 3
to accept an optional third arg merged into the superdough value
object. Calls without the third arg keep their existing behavior
(no `n` field set).

### 3.B — Bank-aware ranking

When the editor cursor sits inside an `s("…")` literal that is part of
a JS expression chain containing a `bank(...)` call, the sound provider
re-scores prefix-matched candidates *against their suffix* and adds an
"in-bank" boost.

**Detection algorithm.** Given the `s()` CallExpression that wraps
the cursor's String:

1. **Walk down the callee chain.** `callee.firstChild` is either an
   Identifier (top-level call — chain ends here) or a MemberExpression.
   For each MemberExpression, its `firstChild` is the prior
   CallExpression in the chain. Recurse until Identifier.
2. **Walk up the parent chain.** The `s()` call's parent is either
   the enclosing statement (chain ends) or a MemberExpression whose
   parent is the next CallExpression. Recurse until non-MemberExpression
   parent.
3. For each CallExpression visited (down or up), check its callee:
   - Identifier `bank` (top of chain `bank("X").s(…)` shape) — capture
     args.
   - MemberExpression with `PropertyName === "bank"` (mid-chain shape
     `…s(…).bank("X")…`) — capture args.
4. If multiple `bank()` calls are found, the LAST in the chain
   (rightmost in source order) wins.

**Suffix scoring.** When a bank `X` is in scope, candidates whose names
start with `X_` get scored against their *suffix* (the part after `X_`)
rather than the full name. This matches how composers think — typing
`bd` inside `bank("RolandTR909").s("…")` is asking for the kit's `bd`,
not "any sound containing `bd` somewhere." Add a small `+0.2` in-bank
flat boost on top so a bank candidate with an equal suffix-match score
still beats an out-of-bank candidate with the same full-match score.

**Ranking surface.** For a query `bd` inside
`bank("RolandTR909").s("…")`:

| Candidate          | Match (rescored)         | Buffer | In-bank | Base | Total |
| ------------------ | ------------------------ | ------ | ------- | ---- | ----- |
| `RolandTR909_bd`   | 0.89 (vs suffix `bd`)    | +0     | +0.2    | +1.0 | 2.09  |
| `bd_kick`          | 0.89 (vs full `bd_kick`) | +0     | +0      | +1.0 | 1.89  |
| `808_bd`           | 0.49 (vs full)           | +0     | +0      | +1.0 | 1.49  |

The bank candidate wins by the in-bank boost. Out-of-bank candidates
are not penalized — the user can still type `808_bd` and reach it.

**Display behavior**:

- Show short suffix as the **label** (`bd`).
- Show resolved full name as the **detail** (`RolandTR909_bd`).
- Insert the **short suffix** literally on accept.

This matches how composers think when working in a bank context:
"give me the bd of this kit." If they want a different bank's `bd`,
they type the full prefix and the provider pivots to full-name
completions naturally.

**Edge — typo'd bank.** If `bank("Typo909")` is in scope but no
sounds match `Typo909_*`, the bank-context boost contributes nothing
and the provider falls back to no-bank ranking. We don't surface a
warning here — the soundMap warning system in `midi-bridge.js` covers
the runtime failure.

**Edge — multiple banks in one chain.** Rare but possible:
`s("…").bank("A").bank("B")`. Last wins (`B`). Strudel runtime
agrees (later controls override earlier).

**Edge — bank inside `stack()`.** Per Q5 in the Strudel research,
each chain inside `stack()` has independent bank scope. The detection
algorithm walks only the local chain (not into `stack` siblings) — so
behavior is correct by construction.

### 3.C — Reveal in browser (`Cmd+Shift+B`)

A new keybinding registered in **Layer 2**
(`src/editor/keymap-universal.js`). When pressed:

1. Identify the sound name under the cursor:
   - Cursor inside `s("…")` / `sound("…")` mini-notation → grab the
     current token via `tokenAtOffset`. Apply bank context to resolve
     to the full name.
   - Cursor on a bare identifier whose text is in `soundMap` → use
     it directly.
   - No resolvable token → status bar logs "no sound under cursor",
     no-op.
2. Dispatch a CustomEvent `strasbeat:reveal-sound` with `{ name }`
   detail.
3. `main.js` listens for the event:
   - `rightRail.activate("sounds")` — opens the sound browser.
   - `soundBrowserPanel.focusSound(name)` — scrolls the named sound
     into view, expands its kit group if collapsed, highlights with
     the existing `is-active` class.

**New method on the sound browser.** `focusSound(name)`:

```js
function focusSound(name) {
  // Expand the containing kit if collapsed.
  const sound = allSounds.find((s) => s.name === name);
  if (sound?.kit && collapsedGroups.has(sound.kit)) {
    collapsedGroups.delete(sound.kit);
    render();
  }
  activeIndex = flatVisible.findIndex((s) => s.name === name);
  paintActive();        // existing — scrolls and highlights
}
```

**Esc returns focus to editor** (existing behavior in `sound-browser.js`).
Round trip: cursor on `bd` → `Cmd+Shift+B` → `↓` → `Enter` swaps to
sibling. Reuses `editor-actions.js:insertSoundName` for the swap.

**Discoverability.** Add a command-palette entry "Reveal sound in
browser" with the `Cmd+Shift+B` shortcut shown
(`src/command-palette-actions.js`).

### Acceptance — Phase 3

- Typing `s("bd:")` shows numeric variants `0..n-1` with sample-filename
  detail
- Each variant auditionable via `Alt+↓` with the correct `n` value
- Object-form sounds (`gm_piano`) emit no variant completions
- `bank("RolandTR909").s("…")` popup shows `bd`, `sd`, `hh` (short
  suffixes) at top with `RolandTR909_bd` shown as detail
- Accepting a short suffix inserts literally `bd`, not the prefixed form
- `s("…").bank("X")` (suffix bank) works the same as
  `bank("X").s("…")` (prefix bank)
- `bank()` typo gracefully falls back to no-bank ranking
- Sibling chains in `stack(...)` have independent bank scope (verified
  via fixture)
- `Cmd+Shift+B` on a sound name opens the browser and highlights it
- The shortcut appears in the command palette
- Round trip `Cmd+Shift+B → ↓ → Enter` swaps the cursor's sound

---

## Phase 4 — Nice-to-haves

### 4.A — Drag-from-browser → editor

Sound rows in the right-rail browser become drag sources
(`draggable="true"`, `dataTransfer.setData('text/x-strasbeat-sound', name)`).
The CodeMirror DOM listens for `drop`. If the payload matches and the
drop position is inside an `s("…")` literal, replace the inner string;
otherwise insert `s("name")` at the drop position. Reuses
`editor-actions.js:insertSoundName`. ~40 lines.

### 4.B — Bank chip in transport

A small chip in the transport bar shows the active bank when the
buffer's primary chain contains `bank("X")`. Clicking opens the sound
browser pre-filtered to that bank. Re-renders on doc-change debounced
(reuses Phase 1's buffer-token cache). If multiple banks are in
multiple chains, show the most-recently-edited one. Reuses the chip
styling pattern established in spec 21 for the keymap chip.

### 4.C — Focus browser with token (`Cmd+J`)

Opens the right-rail sound browser, focuses the search field, fills it
with the word under cursor, selects-all so a single keystroke replaces
it. Differs from `Cmd+Shift+B` (3.C):

- 3.C **highlights** the exact resolved sound — for swapping siblings.
- 4.C **searches** for the cursor's word — for exploring alternatives.

Both useful, complementary. Layer 2 binding.

### 4.D (deferred) — `note()` colon-variant completion

Same colon-positional mechanism (per Q1 of the Strudel research,
`note()` is registered as `['note', 'n']`). For multi-sample melodic
instruments, `note("c4:3")` picks variant 3 of the c4 sample.
Lower priority — defer until requested.

---

## Testing strategy

**Unit-tested as pure functions (Node `--test`):**

- `score.js` — fixture table of `(query, candidate, expectedScore)` and
  `(query, [candidates], expectedTopK)` for ordering. Includes:
  - prefix > word-boundary > scattered
  - length tiebreaker
  - no-match returns null
  - Unicode safety (`café` etc. — Strudel sound names are ASCII but be
    defensive)
- `context.js` — buffer-token extraction from a known input string,
  recency LRU eviction at 32, recency time-decay math
- `mini-notation-tokens.js` — colon-aware fragment, `prevSeparator`
  detection
- Each provider's score-and-rank given mock soundMap + buffer +
  recency states

**Integration tests** (manual checklist run in dev server):

- Each acceptance criterion verified in the browser
- No CM6 e2e harness introduced for this — too much yak-shaving for a
  personal tool

**Browser console helpers** added to `window.strasbeat.completions`:

```js
strasbeat.completions.score("gmpw", "gm_pad_warm")  // → { score, matched }
strasbeat.completions.recency()                      // → { sound: [...], … }
strasbeat.completions.bufferTokens()                 // → Map<category, Set<string>>
strasbeat.completions.rank("gmp", "sound")           // → top 20 sounds for "gmp"
```

Useful for debugging weight-tuning and reasoning about ranking
behavior live.

**Regression watch:**

- The `filter: false` switch could re-introduce alphabetical noise if
  any provider forgets to score. Each provider has a smoke test
  asserting an empty-query result is bounded (≤ 30 items).
- Snippet placeholders + Prettier formatter interaction — format
  during active snippet cancels the snippet gracefully (acceptance
  criterion in Phase 2).

## Performance budget

- **Per-keystroke completion fire**: < 5ms median for ~1000 sounds.
  Kernel is `O(query.length × candidate.length)` ≈ 12k char comparisons
  for 1000 candidates × 12-char avg. Trivially fast.
- **Buffer-token cache**: extracted once per doc-change, debounced
  150ms. `O(buffer-length)` syntax-tree walk, ~5ms for typical patterns.
- **Recency lookup**: `O(1)` Map gets per scoring call.
- **Total per-keystroke worst case**: < 10ms even with all categories
  scoring.

If we drift past 10ms in practice, the next lever is to score lazily
per-page via CM6's `Completion.score` callback (returns score on
demand instead of pre-computing all) — not eager up-front scoring.
Don't optimize until we hit the wall.

## Open questions (final)

1. **`note()` colon-variant completion** — deferred (4.D). Implement
   if anyone asks; the mechanism is parallel to 3.A.

That's it. Everything else was settled by the Strudel-source research
or by user input during the brainstorming session.

## Phase ordering

**Recommended: 1 → 2 → 3 → 4.** Phase 1 is foundational — it changes
no UI but every subsequent phase depends on its scoring kernel and
context module. Phase 2 is high-visibility (snippets, audition,
trigger characters) and amplifies Phase 1's ranking quality. Phase 3
builds on both — variant completion needs Phase 1's scoring and Phase
2's audition. Phase 4 is icing.

If only one phase ships, ship Phase 1.

## License note

No new dependencies. Kernel is hand-rolled. No license implications
beyond strasbeat's existing AGPL inheritance from Strudel.
