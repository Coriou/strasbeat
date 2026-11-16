# strasbeat

A browser IDE for making music with [Strudel](https://strudel.cc) (TidalCycles
in JavaScript): pattern files on disk, IDE-grade editing, MIDI in and out, WAV
export. Public, AGPL-3.0, one maintainer. Vite, vanilla JS, CodeMirror 6, pnpm.
No framework, no TypeScript.

Direction: a DAW-adjacent tool on top of Strudel, not a clone of it. Code stays
the source of truth. It should be useful without encyclopedic Strudel knowledge.

## Commands

```sh
pnpm install
pnpm dev          # http://localhost:5173 (click once before audio can start)
pnpm build
pnpm test         # node:test, every file named in package.json "test"
node --import ./scripts/test-register.mjs --test src/path/file.test.js   # one file
pnpm gen:docs     # regenerate src/editor/strudel-docs.json
```

## Rules

- Never edit `strudel-source/`. It is a gitignored, read-only clone of upstream
  Strudel. Read it to learn how a Strudel function behaves instead of guessing.
- You may commit and push, under the git identity already configured in the
  repo and the `Coriou` GitHub account (`gh auth status`; never another
  logged-in account). Do not change the identity or pass `--author`.
  Conventional messages (`fix(scope): …`) that say what changed and why.
- No AI attribution anywhere: no `Co-Authored-By`, no "Generated with" line, no
  mention of an AI or agent as author, in commits, PRs, comments or code. Some
  old commits have a trailer; do not copy them.
- A push to `main` deploys to production at once. Push `main` only when
  shipping is the task and CI is green on a runner for that commit. Do not
  open a PR or deploy unless asked.
- Fix what was asked. No drive-by refactors, type annotations or compatibility
  shims; there are no downstream consumers.
- Surface silent failures loudly. Strudel swallows errors; where strasbeat
  wraps a Strudel API, warn or throw instead of degrading silently.
- Pattern edits are a matter of taste. Change one thing at a time so the
  maintainer can compare, and read `design/PATTERN-STYLE.md` first.
- Keep this file, `docs/architecture.md` and the README true when a change
  makes them wrong.
- Strudel is AGPL-3.0 and strasbeat extends it in-process, so strasbeat is
  AGPL-3.0 too. Do not add dependencies with incompatible licences.

## Verify

The maintainer's machine must stay lightly loaded.

- Locally: run the one test file you touched. No browsers, dev or preview
  servers, or performance runs, and no repeated full `pnpm test` / `pnpm build`.
- Full check on GitHub runners, through a throwaway branch. `ci/**` runs
  `pnpm test` and `pnpm build`; `ci/smoke-*` also runs the browser smoke test
  (`.github/smoke/smoke.mjs`, plus `sw.mjs` across three deploy variants,
  headless Chromium against production builds):

  ```sh
  git push origin HEAD:refs/heads/ci/<name>         # tests + build
  git push origin HEAD:refs/heads/ci/smoke-<name>   # tests + build + smoke
  gh run list --branch ci/<name>
  gh run view <id> --log-failed
  git push origin --delete ci/<name>                # once the run has been read
  ```

  `ci/**` branches never deploy. Delete every one you push; `origin` should
  end with only `main`.
- A new `*.test.js` does not run until it is added to the `test` script in
  `package.json`. A browser-visible fix gets a check in the smoke script.
- You cannot hear audio or see the app. What needs ears or eyes (sound,
  layout, focus, visuals) goes in your report as a short list for the
  maintainer to check. Do not claim it works.

## Four traps that fail silently

1. **The single-quote rule.** Strudel's transpiler rewrites every
   double-quoted string in pattern code into a `mini()` call. That is right for
   `s("bd sd")` and wrong for a helper that wants a real string:
   `progression("Cm7 F7")` receives a Pattern and plays nothing. Use single
   quotes for such arguments and their option values. A new helper that takes a
   literal string needs a Pattern-input guard and a note in its docs.
2. **Sound names are not General MIDI names**, and an unknown one plays
   nothing with no error: `gm_piano`, not `gm_acoustic_grand_piano`. Check GM
   names in `node_modules/@strudel/soundfonts/gm.mjs`. Sample names come from
   manifests fetched at runtime; if you cannot confirm one, say so. In the
   browser: `strasbeat.hasSound(name)`, `strasbeat.findSounds(query)`.
3. **Evaluate through `editor.evaluate()`**, never `editor.repl.evaluate()`.
   It resolves to `{ status, started, owner }` with status `ok`, `error`,
   `empty`, `blocked`, `superseded` or `cancelled`, because the repl swallows
   errors. Check the status before acting on the result.
4. **Do not replace `renderPatternToBuffer` (`src/export.js`) with upstream's
   `renderPatternAudio`.** Upstream renders a valid WAV of pure silence.

## Where things are

`index.html` → `src/main.js` (wiring only). List `src/` for the rest; file
names say what they hold: `src/editor/` is CodeMirror extensions, `src/ui/`
panels and chrome. The parts that are not obvious:

- `src/boot.js` loads Strudel and the default sounds; `src/eval-feedback.js`
  and `src/eval-state.js` own evaluate and stop.
- `src/strudel-ext/` holds strasbeat's own pattern functions. Anything exported
  from its `index.js` is a global in pattern code.
- `patterns/*.js` are compositions. Each default-exports a template string of
  Strudel code; it is a string because the transpiler needs the source text.

## Read before you touch

`docs/architecture.md` holds each subsystem's invariants. Read the named
section first; most were learned from bugs that produced no error.

| If you touch | Read section |
|---|---|
| `src/export.js`, anything swapping audio contexts, `initAudio` | WAV export |
| `src/boot.js`, `src/default-samples.js`, `src/drum-kit.js`, sample maps | Boot and sound names |
| any `import()`, `vite.config.js`, `@strudel/*` imports or upgrades | Bundle and lazy loading |
| `src/strudel-ext/`, a new pattern function, `scripts/build-strudel-docs.mjs` | Strudel extensions and the docs index |
| `#roll` canvas, piano roll, scope, a view that renders the buffer | Bottom canvas and docSync |
| Hydra, shader, a new visual layer | Visuals lifecycle |
| `src/store.js`, `src/patterns.js`, autosave, tabs, share links | Persistence |
| `src/midi-bridge.js`, MIDI or OSC output, MIDI permission | MIDI |
| layout CSS, breakpoints, left rail, tab strip, focus | Responsive layout and keyboard models |
| workflows, `.github/smoke/`, `vercel.json` | CI and the smoke test |
| `src/sw/`, `src/app-update.js`, `src/flags.js`, PWA/offline or update notices | Service worker, updates and offline |

Other references:

- `STRUDEL.md`: Strudel syntax cheatsheet. Read it before writing Strudel code;
  for anything it lacks, <https://strudel.cc/learn/> is the reference.
- `design/SYSTEM.md`: tokens, type, spacing, motion. Read it before adding or
  changing a visual element. `PRODUCT.md`: who the tool is for and how it
  should feel.
- `design/work/README.md`: index of specs with their status. Read the index,
  then only the spec you were pointed to. `design/work/OPEN.md` lists what is
  deferred, undecided or waiting for a person to check.
- `design/work/archive/` holds finished plans and the November 2026 audit
  record, with out-of-date code listings. Do not read or search it unless
  asked, and never read the audit record whole.
