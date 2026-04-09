# strasbeat

A version-controlled beat-making workspace built on
[Strudel](https://strudel.cc) — a JavaScript port of TidalCycles.

Patterns are plain `.js` files in [`patterns/`](./patterns). Edit them in
your IDE *or* live in the browser editor; both stay in sync via Vite HMR.
Save → commit → diff → branch — your normal coding workflow, applied to
music.

## Run

```sh
pnpm install   # first time only
pnpm dev       # opens http://localhost:5173
```

Click anywhere on the page once to satisfy the browser autoplay policy,
then **▶ play** (or `Ctrl/Cmd+Enter` inside the editor).

## What's where

```
strasbeat/
├── index.html          # page shell
├── src/
│   ├── main.js         # boots StrudelMirror, wires UI, auto-loads patterns
│   └── style.css
├── patterns/           # ← your music lives here
│   ├── 01-hello.js
│   ├── 02-house.js
│   ├── 03-breakbeat.js
│   └── 04-melody.js
├── vite.config.js      # includes a /api/save endpoint for the ⤓ save button
├── STRUDEL.md          # mini-notation + function cheatsheet
└── strudel-source/     # full upstream repo (gitignored, for reference)
```

## Workflow

1. Pick a pattern from the dropdown — its code loads into the editor.
2. Edit live; press play to hear it. Errors show inline.
3. Either:
   - **⤓ save** writes the editor's current code back to
     `patterns/<name>.js` (prompts for the name), or
   - edit `patterns/<name>.js` directly in your IDE — the page hot-reloads.
4. `git add patterns/02-house.js && git commit -m "tighten the bassline"`.

Drop a new file into `patterns/` (e.g. `patterns/05-dub.js`) and it shows
up in the dropdown automatically.

### Pattern file format

Each file is a tiny JS module that default-exports a string of Strudel
code:

```js
// patterns/05-dub.js
export default `setcps(70/60/4)

stack(
  s("bd ~ ~ ~"),
  s("~ ~ sd ~").room(0.8).delay(0.5),
)
`;
```

Why a string? Strudel's transpiler rewrites things like `"bd sd"` into
mini-notation calls before evaluation, so the *whole* tune needs to be
fed as source text. Wrapping it in `export default \`…\`` keeps the file
a normal JS module that auto-discovery (`import.meta.glob`) can load.

## Learning

- [STRUDEL.md](./STRUDEL.md) — quick cheatsheet (mini-notation, common
  functions, drum machines, soundfonts).
- [Workshop](https://strudel.cc/workshop/getting-started) — official
  step-by-step tutorial.
- [Function reference](https://strudel.cc/learn/) — every function in
  every package, searchable.
- `strudel-source/examples/` — more example projects (locally cloned).
- `strudel-source/packages/` — read the source of any function you're
  curious about.

## License note

Strudel is AGPL-3.0. Code you write *on top* of Strudel that runs in the
same process is generally considered a derivative work; if you ever
distribute strasbeat or anything built on it, the same license applies.
For private/local use, no obligation.
