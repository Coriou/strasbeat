# 10 — Refactor `src/main.js`

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. Then read this whole file. This is a **pure refactor** — no
> features, no API changes, no visual changes. Every behavior the user
> can observe (play, stop, save, export, share, MIDI capture, autosave,
> piano roll resize, settings, console, sound browser, reference panel,
> debug helpers) must work identically after the refactor.

## Where this came from

`src/main.js` is 1,925 lines. It's the boot script, the pattern manager,
the WAV export pipeline, the share codec, the panel wiring hub, the
editor action broker, the piano-roll resize controller, and the debug
API all in one. The concerns are distinct — they share a few pieces of
state but do not need to live in the same file.

The file is hard to navigate, hard to hand to a fresh Claude Code
session for a scoped task, and every spec that touches `main.js` has to
carefully wall off "my section" from "everything else." Splitting it
into focused modules fixes these problems with zero user-visible change.

## Goal

Reduce `src/main.js` to **~500–600 lines** of pure orchestration: imports,
StrudelMirror construction, prebake, panel wiring, toolbar event
listeners, HMR, MIDI bridge init, and the `window.*` exports. All
self-contained logic moves to new modules under `src/`.

## Principles

1. **Extract, don't rewrite.** Every function keeps its current
   signature and logic. Cut, paste, add parameters for closed-over
   state, export. No cleverness.
2. **No new abstractions.** No event bus, no dependency injection
   framework, no app-level state manager. If a function needs the
   editor and the store, pass them as arguments.
3. **No circular dependencies.** Extracted modules import from
   `@strudel/*`, `@codemirror/*`, and each other only if strictly
   needed. They **never** import from `main.js`. `main.js` imports
   from them.
4. **No scope creep.** Don't add types, don't add JSDoc, don't rename
   variables, don't refactor the logic inside the functions, don't
   "improve" the error handling. The diff should be pure moves +
   the minimal parameter-threading to make them work.
5. **Build must pass.** `pnpm build` is the gate. It must succeed with
   zero warnings that weren't already present before the refactor.
6. **Smoke test.** After the refactor, manually verify: play a pattern,
   stop, switch patterns, export a WAV (toolbar + export panel), share
   a link, create a new pattern, preview a sound from the browser,
   insert a sound, open the reference panel, toggle the piano roll,
   resize the piano roll divider, open settings, change theme, check
   the console panel, use `strasbeat.findSounds()` and
   `strasbeat.probeRender()` from devtools.

## Extraction plan

Seven new modules. Each section below gives: the file name, the line
ranges in the current `main.js` (as of the commit this spec lands on),
the functions to extract, what they export, and what they need passed in.

---

### 1. `src/export.js` — WAV render + encode + download

**Current lines:** ~1345–1650 (everything from `EXPORT_SAMPLE_RATE` through
`runExport`'s closing brace).

**Extract:**

| Function                                                                          | Export? |
| --------------------------------------------------------------------------------- | ------- |
| `renderPatternToBuffer(pattern, cps, cycles, sampleRate)`                         | yes     |
| `renderPatternToBufferWithProgress(pattern, cps, cycles, sampleRate, onProgress)` | yes     |
| `audioBufferToWav16(buffer)`                                                      | yes     |
| `downloadWav(arrayBuf, filename)`                                                 | yes     |
| `computeBufferStats(buffer)`                                                      | yes     |
| `EXPORT_SAMPLE_RATE`                                                              | yes     |
| `EXPORT_MAX_POLYPHONY`                                                            | yes     |

**Also extract `runExport`**, but it has many dependencies. Give it a
context object:

```js
export async function runExport(options, ctx) {
  // ctx = {
  //   editor, consolePanel, exportPanel, exportBtn, status,
  //   currentName, setLogger, getAudioContext, setAudioContext,
  //   setSuperdoughAudioController, resetGlobalEffects, initAudio,
  //   superdough,
  // }
}
```

`main.js` calls it as `runExport(options, exportCtx)` where `exportCtx`
is assembled once after all panels are constructed.

**Imports the module needs:** only `@strudel/webaudio` symbols (which it
receives via `ctx` — no direct import needed).

**Notes:**

- `renderPatternToBuffer` and `renderPatternToBufferWithProgress` are
  near-duplicate. That's intentional (see CLAUDE.md). Leave both as-is.
- Keep them as two separate exported functions, not a shared helper.

---

### 2. `src/share.js` — URL share codec

**Current lines:** ~155–190 (helpers) + ~1293–1340 (`shareCurrent`).

**Extract:**

| Function                | Export? |
| ----------------------- | ------- |
| `encodeShareCode(code)` | yes     |
| `decodeShareCode(s)`    | yes     |
| `readSharedFromHash()`  | yes     |
| `SHARE_MAX_ENCODED`     | yes     |

**Also extract `shareCurrent`**, parameterised:

```js
export async function shareCurrent({ getCode, getName, setStatus })
```

`main.js` wires the share button as:

```js
shareBtn.addEventListener("click", () =>
  shareCurrent({
    getCode: () => editor.code ?? "",
    getName: () => currentName,
    setStatus: (s) => {
      status.textContent = s;
    },
  }),
);
```

**Imports:** none (pure functions + `navigator.clipboard`).

---

### 3. `src/patterns.js` — pattern discovery + persistence bridge

**Current lines:** ~82–98 (glob + map) + ~496–665 (dirty set, user
patterns, `flushToStore`, autosave timer) + ~1188–1250
(`handleNewPatternClick`).

**Extract:**

| Function / const                                                                   | Export?                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| `discoverPatterns(patternModules)`                                                 | yes — returns `{ patterns, patternNames }`         |
| `computeDirtySet(patternNames, patterns, store)`                                   | yes                                                |
| `getUserPatternNames(store)`                                                       | yes                                                |
| `createAutosave({ editor, store, patterns, getPatternName, leftRail, transport })` | yes — returns `{ flushToStore, scheduleAutosave }` |
| `handleNewPatternClick(ctx)`                                                       | yes                                                |

`discoverPatterns` is a two-line pure function:

```js
export function discoverPatterns(patternModules) {
  const patterns = {};
  for (const [filePath, mod] of Object.entries(patternModules)) {
    const name = filePath.split("/").pop().replace(/\.js$/, "");
    patterns[name] = mod.default;
  }
  return { patterns, patternNames: Object.keys(patterns).sort() };
}
```

`createAutosave` returns a pair so the timer state stays private:

```js
export function createAutosave({
  editor,
  store,
  patterns,
  getCurrentName,
  leftRail,
  transport,
}) {
  let timer = null;
  const lastDirtyState = new Map();
  function flushToStore() {
    /* ... */
  }
  function scheduleAutosave() {
    /* ... */
  }
  return { flushToStore, scheduleAutosave };
}
```

`handleNewPatternClick` needs: `store`, `patterns`, `editor`,
`leftRail`, `transport`, `setCurrentName`, `flushToStore`, `prompt`,
`fetch` (for dev API save). Pass a context object.

---

### 4. `src/editor-actions.js` — sound preview, insert, try example, insert template

**Current lines:** ~995–1135.

**Extract:**

| Function                                       | Export? |
| ---------------------------------------------- | ------- |
| `previewSoundName(name, ctx)`                  | yes     |
| `insertSoundName(name, view)`                  | yes     |
| `tryReferenceExample(code, ctx)`               | yes     |
| `insertFunctionTemplate(name, template, view)` | yes     |

`previewSoundName` context:

```js
// ctx = { getAudioContext, getSound, superdough, setStatus }
```

`insertSoundName` and `insertFunctionTemplate` only need the CM
`EditorView` — pass it directly, no context object.

`tryReferenceExample` context:

```js
// ctx = { editor, patterns, currentName, confirm }
```

---

### 5. `src/editor-setup.js` — CM settings merge + extension dispatch

**Current lines:** ~243–490 (from `readStoredCmSettingsFromLocalStorage`
through the `installSoundCompletion` call).

**Extract:**

| Function / const                                                                                                                        | Export? |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `readStoredCmSettingsFromLocalStorage()`                                                                                                | yes     |
| `STRASBEAT_REQUIRED_ON`                                                                                                                 | yes     |
| `STRASBEAT_DEFAULT_PREFERENCES`                                                                                                         | yes     |
| `GEIST_MONO_STACK`                                                                                                                      | yes     |
| `applyInitialSettings(editor, storedSettings)`                                                                                          | yes     |
| `dispatchEditorExtensions(editor, { formatExtension, createVscodeKeymap, numericScrubber, hoverDocs, signatureHint, onOpenReference })` | yes     |

`applyInitialSettings` wraps the merge logic:

```js
export function applyInitialSettings(editor, storedSettings) {
  editor.updateSettings({
    ...defaultSettings,
    ...STRASBEAT_DEFAULT_PREFERENCES,
    ...(storedSettings ?? {}),
    ...STRASBEAT_REQUIRED_ON,
  });
}
```

`dispatchEditorExtensions` wraps the `StateEffect.appendConfig` dispatch.

**Imports:** `@codemirror/state` (`Prec`, `StateEffect`),
`@strudel/codemirror` (`defaultSettings`). Already used by `main.js` —
they move here.

---

### 6. `src/piano-roll-resize.js` — roll toggle + divider drag

**Current lines:** ~1137–1185.

**Extract:**

```js
export function mountPianoRollResize({
  shellEl,
  rollToggleBtn,
  rollDivider,
  resizeCanvas,
}) {
  // returns { toggleRoll }
}
```

All the pointer event handlers, `rollCollapsed`, `rollExpandedPx`,
`ROLL_MIN_PX`, `ROLL_MAX_PX` become local state inside the factory.
The only thing `main.js` still needs is `toggleRoll` (returned).

---

### 7. `src/debug.js` — `window.strasbeat` helpers

**Current lines:** ~1842–1920.

**Extract:**

```js
export function mountDebugHelpers({ soundMap, getSound, editor, renderPatternToBuffer, consolePanel, ... }) {
  // returns the object assigned to window.strasbeat
}
```

`main.js` does:

```js
window.strasbeat = mountDebugHelpers({ ... });
```

`echoHelper` moves here too (it's private to this module).

---

## What stays in `main.js`

After all extractions, `main.js` contains:

1. **Imports** — `@strudel/*`, `@codemirror/*`, all `src/` modules,
   all `src/ui/` modules, all `src/editor/` modules.
2. **Pattern discovery** — one-liner call to `discoverPatterns()`.
3. **Store init** — `createLocalStore()`.
4. **DOM refs** — `getElementById` / `querySelector` block.
5. **Icon hydration + accent restore + dev-mode class.**
6. **HiDPI canvas setup** — `resizeCanvas`, DPR.
7. **Boot sequence** — `readSharedFromHash()`, store index read,
   initial name/code selection.
8. **`StrudelMirror` construction** — constructor call with `prebake`,
   `onDraw`, `onEvalError`. Drawer `drawTime` monkey-patch.
9. **Editor setup** — call `applyInitialSettings()`, call
   `dispatchEditorExtensions()`, call `installSoundCompletion()`.
10. **Left rail mount** — `mountLeftRail(...)` with inline callbacks
    that call the extracted functions.
11. **Transport mount.**
12. **`setCurrentName` helper** (stays — it mutates `currentName` +
    DOM, too small to extract).
13. **Autosave init** — call `createAutosave()`, wire CM update
    listener, `beforeunload`.
14. **Top bar wiring** — pattern menu click, settings click.
15. **Right rail mount + all five panel registrations** (sound browser,
    reference, console, export, settings). The inline callbacks call
    extracted functions.
16. **`strudel.log` listener.**
17. **soundMap poll interval** (seed sound browser).
18. **`editor.evaluate` wrapper** (fires divider + in-use scans).
19. **Cmd+B handler.**
20. **Piano roll resize** — one-liner call to `mountPianoRollResize()`.
21. **`handleNewPatternClick` wiring** (already extracted, just called).
22. **Toolbar: play / stop / save / share / export** button listeners.
23. **HMR block.**
24. **MIDI bridge init + capture button handler.**
25. **Debug helpers** — one-liner call to `mountDebugHelpers()`.
26. **`window.editor = editor`** etc.

That's roughly 500–600 lines of pure wiring. Each section is 5–30 lines.

## Execution order

Do the extractions in this order — each one is independently buildable:

1. `src/share.js` — simplest, pure functions, no dependencies.
2. `src/export.js` — largest chunk, self-contained, biggest line-count win.
3. `src/editor-actions.js` — four small functions, easy to parameterise.
4. `src/piano-roll-resize.js` — tiny, self-contained.
5. `src/debug.js` — tiny, depends on `export.js` for `renderPatternToBuffer`.
6. `src/patterns.js` — more dependency threading (store, left rail).
7. `src/editor-setup.js` — last because it touches the StrudelMirror
   constructor adjacently and needs the most care to not break the
   settings merge boot order.

After each extraction: `pnpm build`. If it fails, fix before moving on.

## After the refactor: update `CLAUDE.md`

The "Where things live" tree and the "Architecture in one breath"
paragraph in `CLAUDE.md` need to reflect the new modules. Draft the
diff and present it for approval — do not commit it directly (per the
conventions in `CLAUDE.md` itself and `.github/copilot-instructions.md`).

## Out of scope

- **No TypeScript.** This refactor stays in JS.
- **No new features.** No new UI, no new helpers, no new CSS.
- **No logic changes.** If a function has a bug, leave it. File an issue
  or note it in a comment — don't fix it in this diff.
- **No renaming.** Variables, functions, CSS classes, DOM IDs — all keep
  their current names. The only new names are the module filenames and
  the `ctx` parameter objects.
- **No test changes.** `progression.test.js` and `roman.test.js` are
  untouched (they don't import from `main.js`).
- **No changes to `index.html`, `vite.config.js`, `vercel.json`,
  `patterns/*.js`, `src/ui/*.js`, `src/editor/*.js`,
  `src/strudel-ext/*.js`, `src/midi-bridge.js`, `src/store.js`,
  `src/style.css`, or any CSS file.**

## Acceptance

1. `pnpm build` succeeds with no new warnings.
2. `main.js` is ≤ 650 lines.
3. Seven new files exist under `src/`: `share.js`, `export.js`,
   `editor-actions.js`, `piano-roll-resize.js`, `debug.js`,
   `patterns.js`, `editor-setup.js`.
4. No file under `src/` other than `main.js` and the seven new files
   has been modified.
5. `git diff --stat` shows only additions to the new files and removals
   from `main.js` (plus this spec file). No other files touched.
6. Full smoke test passes (see Principles §6 above).
