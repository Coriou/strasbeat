# 02 — Prettier formatting + VSCode keybindings

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. This task is editor-side only; you'll be extending the
> CodeMirror configuration in `src/main.js`. The
> `editor.updateSettings({...})` block and the editor's `extensions` are
> **fair game**; everything else in `main.js` is off-limits per
> `SYSTEM.md` §11.

## Goal

Two small editor improvements that compound into "this feels like a
real IDE":

1. **Prettier formatting** of the JS structure (not the mini-notation
   strings) on demand, bound to `Cmd+Shift+F` / `Ctrl+Shift+F`.
2. **VSCode-style keybindings** for the operations CodeMirror 6 supports
   natively but the Strudel default editor doesn't expose.

These are both small in scope and do not depend on the new shell
(`work/01-shell.md`). Could be done in parallel.

## Why

- **Format on demand** lets the user write messily and clean up with one
  shortcut. The current method-chain style (each `.method()` on its own
  line) is what Prettier produces by default, so existing patterns
  round-trip cleanly.
- **VSCode bindings** make the editor feel familiar to anyone who's used
  any modern IDE. CodeMirror 6 already supports almost all of them — the
  default Strudel keymap just doesn't bind them. This is **not over-
  engineering** — it's turning on what CM6 already does.

## Approach — Prettier

### Setup

- `pnpm add prettier` (or just the standalone bundle entrypoints —
  `prettier/standalone` and `prettier/parser-babel` — they're shipped
  inside the same package).
- Build a `formatBuffer(code)` function under `src/editor/format.js`:

  ```js
  import * as prettier from 'prettier/standalone';
  import parserBabel from 'prettier/parser-babel';

  export async function formatBuffer(code) {
    return prettier.format(code, {
      parser: 'babel',
      plugins: [parserBabel],
      printWidth: 80,
      singleQuote: true,
      semi: false,         // matches the existing pattern style
      trailingComma: 'all',
    });
  }
  ```

- Verify your import paths against the installed `prettier` version's
  package exports — Prettier v3 changed several entrypoint names. Use
  what's actually exported, not what looked right above.

### Wire it as a CodeMirror command

```js
import { keymap } from '@codemirror/view';

const formatCommand = (view) => {
  const code = view.state.doc.toString();
  formatBuffer(code).then((formatted) => {
    if (formatted === code) return;
    view.dispatch({
      changes: { from: 0, to: code.length, insert: formatted },
      // optionally preserve cursor position via a selection mapping
    });
  });
  return true;
};

export const formatExtension = keymap.of([
  { key: 'Mod-Shift-f', run: formatCommand },
]);
```

Add `formatExtension` to the editor's `extensions` array. This is the
*only* place in `main.js` you should be touching beyond the wiring
section (see SYSTEM.md §11).

### Mini-notation safety

The mini-notation strings inside template literals (`` `...` ``) are
template-literal contents — Prettier won't touch their interior, which
is what we want. **You must verify this.** Prettier *will* reformat the
JS structure *around* the template literal. That's fine, but make sure
nothing inside the backticks gets mangled.

### Critical pre-flight test

Before declaring this task done, run **every existing pattern in
`/patterns/`** through `formatBuffer` and confirm that:

1. The formatted output is still accepted by Strudel's transpiler
   (`editor.evaluate()` doesn't throw and produces audible audio).
2. No characters inside template literal strings have been mangled or
   re-indented.
3. The diff against the original is small and unsurprising (mostly
   whitespace, semicolons stripped, quotes normalised).

Suggested test: a tiny script under `scripts/test-format.mjs` that
imports each pattern, runs it through `formatBuffer`, and either prints
the diff or asserts a list of "must-still-contain" substrings (like
the exact text inside `` `...` ``). **Do not auto-apply the formatter
to disk** as part of this task — manual format-on-demand only.

If any pattern breaks, the formatter is configured wrong. **Fix the
config, don't work around it.** This is the one place where Prettier
could silently corrupt the source.

## Approach — VSCode keybindings

CodeMirror 6 ships these via `@codemirror/commands`. Some may already be
in `defaultKeymap` from the Strudel-supplied editor — check with
`console.log(editor.repl.editorView.state.facet(keymap.facet))` or by
inspecting Strudel's `StrudelMirror` setup before you blindly add
duplicates.

Bindings to ensure are present:

| Binding             | Command (`@codemirror/commands`)        |
| ------------------- | ---------------------------------------- |
| `Mod-d`             | `selectNextOccurrence`                   |
| `Mod-Shift-l`       | `selectAllMatches` (or equivalent in CM6) |
| `Mod-Shift-k`       | `deleteLine`                             |
| `Alt-ArrowUp`       | `moveLineUp`                             |
| `Alt-ArrowDown`     | `moveLineDown`                           |
| `Mod-/`             | `toggleComment`                          |
| `Mod-]`             | `indentMore`                             |
| `Mod-[`             | `indentLess`                             |
| `Mod-Shift-f`       | `formatCommand` (Prettier — see above)   |

`Mod-Enter` (evaluate) and `Mod-.` (stop) are already bound by Strudel.
**Do not override them.** Verify before merging by running both in the
final build.

### Wiring

Put the additions under `src/editor/keymap.js`:

```js
import { keymap } from '@codemirror/view';
import {
  selectNextOccurrence, deleteLine, moveLineUp, moveLineDown,
  toggleComment, indentMore, indentLess,
} from '@codemirror/commands';

export const vscodeKeymap = keymap.of([
  { key: 'Mod-d',           run: selectNextOccurrence },
  { key: 'Mod-Shift-k',     run: deleteLine },
  { key: 'Alt-ArrowUp',     run: moveLineUp },
  { key: 'Alt-ArrowDown',   run: moveLineDown },
  { key: 'Mod-/',           run: toggleComment },
  { key: 'Mod-]',           run: indentMore },
  { key: 'Mod-[',           run: indentLess },
  // Mod-Shift-l: selectAllMatches if it's exported in your CM6 version,
  // else write a tiny custom one with SearchCursor.
]);
```

Add `vscodeKeymap` to the editor's `extensions` array, **after** any
existing keymap so it can override conflicts (CM6 keymaps are
last-wins).

## Files

- `src/editor/format.js` — Prettier wrapper, exports `formatBuffer` and
  `formatExtension`.
- `src/editor/keymap.js` — exports `vscodeKeymap`.
- `src/main.js` — extend the editor's extensions array with both. Do
  not touch any other section.
- `package.json` — add `prettier`. (`@codemirror/commands` is already a
  transitive dep of Strudel; if it isn't, add it explicitly.)
- `scripts/test-format.mjs` — round-trip test.

## Acceptance

- [ ] `Cmd+Shift+F` formats the editor buffer in place; cursor position
      is preserved within the line where possible.
- [ ] All existing patterns under `/patterns/` survive a format → evaluate
      cycle without losing audio or syntax.
- [ ] Every binding in the table above works in the running app.
- [ ] No regression to existing Strudel bindings (`Mod-Enter`, `Mod-.`)
      — verified by manual smoke test.
- [ ] Bundle size impact from Prettier is reasonable. If `prettier`
      bloats the main bundle by more than ~300KB gzipped, **dynamic-
      import it** so it loads only on first format invocation.
- [ ] `scripts/test-format.mjs` runs and reports zero failures.

## Out of scope

- A vim mode or any modal editor.
- Format-on-save as the default (it's allowed as an opt-in via
  `localStorage` toggle, but not required).
- Linting / ESLint integration.
- Anything outside the editor's extensions array.
- A custom command palette (`Cmd+Shift+P`) — that's a v2 primitive.
