# 04 — Intellisense (smart autocomplete + hover docs)

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. This task is editor-side: it builds richer autocomplete and
> hover docs on top of CodeMirror 6's autocomplete API, which Strudel
> already enables. The editor's CodeMirror `extensions` are fair game
> per `SYSTEM.md` §11; nothing else in `main.js` should be touched.

## Goal

Bring real IDE-quality completion and documentation to the editor. The
single biggest editor-experience leverage point in the whole project —
it turns "I wrote `gm_acoustic_grand_piano` and got silence" into "I
typed `gm_p` and the editor showed me `gm_piano` with a play preview."

Phased delivery — **each phase is independently shippable** and adds
value on its own. The recommended order is 1 → 2 → 3, but Phase 1 alone
is worth shipping.

## Background

Strudel already has `isAutoCompletionEnabled: true` set in
`src/main.js` (look for the `editor.updateSettings({...})` block). The
question isn't whether autocomplete fires — it's whether the
*completion data* is rich enough to be worth using.

Today: it's not. The user has no help discovering sound names (a
documented foot-gun in `CLAUDE.md` §"Sound names are NOT 1:1 with
General MIDI"), no signature hints when typing inside a function call,
and no hover docs.

This task fixes all three.

---

## Phase 1 — Sound name completion (small, immediate win)

### What

When the cursor is inside a string literal that's a direct argument to
`s(...)`, `sound(...)`, `.s(...)`, or `.sound(...)`, autocomplete the
sound name from the **live registry**: `Object.keys(soundMap.get())`.

### Why

`CLAUDE.md` flags this as a real foot-gun:

> If you write `sound("not_a_real_name")`, the pattern produces **no
> audible events with no error**.

Sound name completion *prevents* the foot-gun from happening in the
first place. There are ~1000 names — the user has no chance of
memorising them.

### Approach

- Build a CodeMirror 6 `CompletionSource` that fires when the cursor is
  inside a string literal whose enclosing expression is a `CallExpression`
  named `s`, `sound`, or a `MemberExpression` ending in `.s` / `.sound`.
- **Use the syntax tree** (`syntaxTree(state)`) to detect the context —
  do not match on regex. You'll get false positives inside comments,
  unrelated strings, and template literals.
- Pull the completion list from `soundMap.get()` at completion time
  (not at module load — the registry is populated asynchronously during
  `prebake`, which runs after the editor mounts). Reading at completion
  time means the list is always current, including any sounds the user
  loads at runtime.
- Cache the keys list and only rebuild when `soundMap` reports a change
  (if it has a change signal — otherwise just rebuild on every fire,
  it's a string array of ~1000 entries, it's fast).

### Optional polish (Phase 1.5)

Each completion entry has a **preview play button** — a small icon next
to the entry (Lucide `play` per SYSTEM.md §10). Click it to call
`superdough({ s: <name>, n: 60 }, ctx.currentTime, 0.5, ...)` and
trigger a one-shot. This is what turns the feature from "useful" into
"delightful." It's also the moment intellisense earns its keep — you
stop *guessing* and start *auditioning*.

If `superdough` isn't easily reachable from the completion render
function, defer this to a follow-up rather than hacking it in.

### Files

- `src/editor/completions/sounds.js` — the completion source.
- `src/main.js` — add to the editor's `extensions` array (only that
  line).

### Acceptance — Phase 1

- [ ] Typing `s("p` shows completions including `piano`, `gm_piano`,
      `gm_pad_warm`, etc.
- [ ] Completions inside unrelated strings (comments, plain string
      literals not inside `s()`/`sound()`, template literals) don't fire.
- [ ] The completion list is the live registry — not a static snapshot.
      Verify by registering an extra soundfont in devtools and
      confirming new completions appear.
- [ ] Pressing Enter on a completion inserts the sound name and closes
      the dropdown.
- [ ] No regression to existing Strudel completions (function names,
      etc.).

---

## Phase 2 — Function signatures + hover docs

### What

- When the cursor enters a function call (e.g. after typing `note(`),
  show a **signature hint** in a thin pill above or below the cursor.
- When **hovering** any Strudel function name in the source, show a
  **tooltip** with its docs and signature.

### Approach

#### Build-time docs index

Write a small Node script (or a Vite plugin) that walks
`strudel-source/packages/*/src/` extracting JSDoc from every exported
function. Output a single JSON file `src/editor/strudel-docs.json` with
shape:

```json
{
  "note": {
    "signature": "note(input: NoteInput)",
    "doc": "Plays the given note(s)…",
    "params": [
      { "name": "input", "type": "NoteInput", "doc": "..." }
    ],
    "examples": ["note(\"c d e f\")"]
  },
  "room": { ... },
  ...
}
```

Run the extraction at build time (via `vite-plugin-...` or a `prebuild`
script in `package.json`). Commit the generated JSON — it's small
(probably <100KB) and committing it means the build doesn't depend on
`strudel-source/` being present (it's gitignored — see
`../../CLAUDE.md`).

If `strudel-source/` is missing at build time, the script should fall
back to a stub (empty object) without breaking the build, and log a
warning.

#### Hover docs

A CM6 `hoverTooltip` extension that, on hover over an `Identifier`
node, looks it up in the index and renders the docs in a popover. The
popover should use the design system: `--surface-2` background,
`--shadow-pop` elevation, `--radius-md` corners, `text-sm` for body
text, `code-sm` for code-formatted parts (signature, examples).

#### Signature hints

A CM6 `EditorView.updateListener` that watches the cursor position;
when inside the `arguments` of a `CallExpression` whose callee is a
known function, shows the signature in a thin pill above the cursor
line. Hide on cursor leave.

(There may be an existing CM6 community extension for signature hints
— `@codemirror/lsp`-style — but it's overkill for our needs. A
hand-rolled ~80-line plugin is fine.)

### Files

- `scripts/build-strudel-docs.mjs` — extracts JSDoc from
  `strudel-source/`.
- `src/editor/strudel-docs.json` — generated, committed.
- `src/editor/hover-docs.js` — the CM6 hoverTooltip extension.
- `src/editor/signature-hint.js` — the signature hint extension.
- `package.json` — wire the extraction script into a `prebuild` or
  custom script. (Don't run it on every `dev` start unless it's fast;
  if it's slow, make it explicit: `pnpm gen:docs`.)

### Acceptance — Phase 2

- [ ] Hovering `room` in the editor shows its docs in a popover styled
      per the design system.
- [ ] Typing `note(` shows the signature hint in a pill.
- [ ] The docs index regenerates cleanly when run against the current
      `strudel-source/` checkout.
- [ ] Generation script doesn't break the build if `strudel-source/`
      is missing — falls back to a stub with a warning.
- [ ] Popovers don't crash or show empty bubbles for unknown
      identifiers.
- [ ] Hover docs disappear when the cursor leaves the identifier.

---

## Phase 3 — Mini-notation completion

### What

Inside mini-notation strings like `s("bd ~ ...")` and `note("c d e ...")`,
suggest valid sounds / valid notes / valid chord names as you type.

### Why

This is where intellisense becomes magical: you can author a pattern
*entirely* by autocomplete, never having to remember if it's `bd` or
`bass_drum` or `808_kick`.

### Approach

- Tiny mini-notation tokeniser that knows how to find the cursor's
  "current token" inside the string. We don't need a full mini-notation
  parser — we only need to identify whitespace-delimited tokens and
  the context (`s` vs `note` vs `n` vs others).
- Reuse the Phase 1 sound completion source but trigger inside the
  string on word boundaries (after a space or at the start of the
  string).
- For `note(...)` and `n(...)`, complete on note names (`c`, `d`, `e`,
  ...), accidentals (`c#`, `bb`, ...), octave numbers (`c4`, `c5`),
  and common chord shapes (`C^7`, `Fm7`, `Bbo7`).

### Out of scope (for this phase)

- The full Strudel mini-notation grammar with all its operators
  (`<...>`, `[...]`, `*N`, `/N`, `:`, etc.). Strudel's actual parser
  is in `strudel-source/packages/mini/`; we don't need to replicate it
  to do completion. We only need to find tokens, not parse them.

### Files

- `src/editor/completions/mini-notation.js` — the completion source
  for inside-string contexts.
- `src/editor/mini-notation-tokens.js` — the tiny tokeniser helper.

### Acceptance — Phase 3

- [ ] Typing `s("p` *inside the string* shows sound completions.
- [ ] Typing `note("c` *inside the string* shows note completions.
- [ ] Tokens like `~` (rest), `*4`, `[c d]` are not corrupted by
      autocomplete (the tokeniser correctly identifies what part is the
      "current token" being completed).

---

## Phase ordering

Recommended: **Phase 1 → Phase 2 → Phase 3.** They compound — each
phase makes the next one feel smoother. But Phase 1 is fine to ship
alone (it's small, solves a concrete foot-gun, and unlocks experiment-
ation with the rest).

If you only have time for one phase, ship Phase 1.

## Files (across all phases)

- `src/editor/completions/sounds.js`
- `src/editor/completions/mini-notation.js`
- `src/editor/mini-notation-tokens.js`
- `src/editor/hover-docs.js`
- `src/editor/signature-hint.js`
- `src/editor/strudel-docs.json` (generated)
- `scripts/build-strudel-docs.mjs`
- `src/main.js` — extend the editor's extensions array (only that
  block).
- `package.json` — add the docs-build script if needed.
