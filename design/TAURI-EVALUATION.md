# Tauri Desktop Evaluation

> Status: research only. This is not build approval.
>
> If we ever do this, the target should be the latest stable Tauri 2.x line,
> not a cargo-cult copy of upstream Strudel's current desktop shell.

Related reading:

- `../CLAUDE.md`
- `../STRUDEL.md`
- `work/16-midi-import.md`

## Why this doc exists

strasbeat already works as a web app and PWA, but part of the product ambition
is a daily-driver, desktop-grade composing tool rather than "a nice site that
happens to play audio". Tauri is the obvious candidate if we want a native app
shell without paying the full Electron tax.

This document exists to answer four questions before any implementation starts:

1. Would Tauri materially elevate strasbeat, or just repackage the current app?
2. What can we learn from upstream Strudel's own Tauri work?
3. Does the MIDI import / translation work in `work/16-midi-import.md` conflict
   with a future Tauri direction?
4. What would have to be true for this to be worth the cost?

## Short answer

Current recommendation: **worth a bounded spike, not worth committing to a full
desktop product yet**.

The upside is real if the goal is a proper local music tool:

- real file open/save instead of browser-only fallbacks
- native menus, windowing, app associations, updater, shortcuts, tray, deep links
- a shell that feels like a desktop tool instead of a browser tab
- a path to native bridges where browser APIs are weak or inconsistent

The downside is also real:

- the audio engine remains Web Audio, so this is not a free "native DAW" upgrade
- desktop packaging, signing, updater, release engineering, and platform QA all
  become our problem
- the current live MIDI path is the main risk, especially on macOS

So the right framing is not "should we wrap the app?" but:

> Are we ready to make strasbeat meaningfully more desktop-first?

If yes, Tauri is a serious option. If no, it is easy to waste time polishing the
container while the musical workflow stays basically the same.

## Where Tauri would genuinely improve strasbeat

### 1. Real file workflow

Today, strasbeat's disk-backed save path is a dev-server trick:

- `vite.config.js` exposes `POST /api/save`
- `src/main.js` and `src/patterns.js` call that endpoint
- production falls back to browser storage and share URLs rather than real files

That is fine for a web build, but it is not a credible long-term story for a
desktop composing tool.

Tauri would let us move to a real document workflow:

- open existing pattern files from disk
- save new patterns anywhere the user chooses
- keep "recent files" or a user-selected project folder
- watch folders for external edits
- associate custom pattern files and `.mid` files with the app

This is the strongest argument for Tauri.

### 2. Desktop shell and native affordances

Tauri adds the things users expect from a real app:

- native window state restore
- single-instance behavior
- global shortcuts if we choose to use them
- native menu bar
- native open/save dialogs
- tray / status integration if ever useful
- updater pipeline
- deep links and app links
- a custom or transparent title bar that can stop the app from reading as a
  generic Chromium window

This matters because strasbeat is trying to feel IDE-grade and DAW-adjacent.

### 3. A path to native bridges where the browser is weak

The web version is bound by browser API support. Tauri does not remove that
constraint by itself, but it gives us an escape hatch: when a browser API is not
good enough, we can bridge to native code instead of abandoning the feature.

This is especially relevant for:

- MIDI on platforms with poor Web MIDI support
- file system workflows
- local sample directories
- possibly OSC or other device bridges in the future

## Where Tauri would not help much

### 1. It does not make the audio engine native

strasbeat's sound engine is still Web Audio and Strudel's runtime. Export still
depends on `OfflineAudioContext`. Playback still depends on the webview's audio
stack.

So Tauri is not a substitute for a native audio engine. It improves the shell,
I/O, and system integration, not the core synthesis model.

### 2. It is not a guaranteed performance upgrade

It is reasonable to expect a smaller package and a leaner shell than Electron,
but that does **not** mean the app logic itself becomes dramatically faster.

If the desired win is:

- real file workflow
- native system features
- desktop feel

then Tauri is well aligned.

If the desired win is:

- magically better Strudel evaluation speed
- magically better Web Audio behavior
- magically fewer front-end bugs

then Tauri is the wrong lever.

### 3. It does not replace good product decisions

If the app still behaves like a browser app with a desktop wrapper, users will
feel that immediately. Tauri only pays off if we actually use the native shell to
improve the workflow.

## Current strasbeat seams a Tauri build would touch

These are the areas that would stop being "just web deployment" and become
desktop architecture work.

### Pattern persistence

Current model:

- shipped patterns are bundled via `import.meta.glob("../patterns/*.js")`
- save-to-disk is implemented via `/api/save`
- production persistence uses local store + share URLs

Desktop implication:

- we would need a runtime file model, not just compile-time discovery
- pattern creation, save, rename, and open should move to native file APIs
- HMR-centric assumptions would need a desktop equivalent

### Sample manifest loading

Current model:

- sample banks include remote manifests
- `/strudel-cc/*` is proxied in dev and Vercel because of missing CORS headers

Desktop implication:

- we cannot assume the Vite/Vercel proxy exists inside a packaged app
- either bundle the necessary manifests/resources, or use a native HTTP path
  with explicit allowlists and offline expectations

### MIDI input

Current model:

- live MIDI input uses `navigator.requestMIDIAccess`
- this is browser capability territory, not app capability territory

Desktop implication:

- Tauri will only inherit whatever the platform webview supports
- on macOS, that is the danger zone

### Share and PWA flows

Current model:

- share URLs are part of the production story
- the app has PWA affordances and web deployment support

Desktop implication:

- the PWA should probably stay
- desktop should add stronger local workflow, not replace the shareable web story

## What upstream Strudel teaches us

## Yes, upstream Strudel does use Tauri

There is a real desktop shell under `strudel-source/src-tauri/`.

That matters because it proves two things:

1. The Strudel authors themselves saw value in a native desktop wrapper.
2. The motivating use cases were not cosmetic. They added native bridges where
   browser APIs were limiting.

## What upstream actually built

The useful parts are architectural, not visual.

### Native MIDI and OSC bridges

Upstream does not just rely on Web MIDI inside Tauri. It ships Rust bridge code:

- `src-tauri/src/main.rs`
- `src-tauri/src/midibridge.rs`
- `src-tauri/src/oscbridge.rs`

The MIDI bridge uses `midir` on the Rust side and exposes a `sendmidi` Tauri
command. On the JS side, `packages/desktopbridge/midibridge.mjs` extends pattern
triggering so MIDI messages are sent through `invoke()` instead of the browser's
Web MIDI path.

That is a strong signal: upstream also hit the limit where a desktop shell is
most valuable when it provides native bridges, not just packaging.

### Runtime Tauri detection in the site code

Upstream website code checks `isTauri()` and loads desktop-only modules when the
app is running in the native shell.

In `website/src/repl/util.mjs`, upstream loads:

- `@strudel/desktopbridge/loggerbridge.mjs`
- `@strudel/desktopbridge/midibridge.mjs`
- `@strudel/desktopbridge/oscbridge.mjs`

instead of the plain browser `@strudel/midi` / `@strudel/osc` path.

The lesson is important:

> upstream did not treat Tauri as a transparent wrapper. They treated it as a
> different runtime with different capabilities.

### Native file-system access for local sample folders

`website/src/repl/files.mjs` uses Tauri fs APIs to read local audio directories,
generate `strudel.json`, and resolve local sample files into playable URLs.

This is directly relevant to strasbeat because local sample workflow is exactly
the kind of feature that gets cleaner in a desktop shell.

## What upstream does **not** give us

Upstream is useful as precedent, but not as a template to copy blindly.

Reasons:

- the shell appears historically layered rather than freshly designed for modern
  Tauri 2 conventions
- `src-tauri/` still looks like an older Tauri 1-era Rust/config setup
- the README is thin and does not explain product-level trade-offs
- upstream's desktop shell is solving different problems than strasbeat's
  current roadmap

So the correct stance is:

- **use upstream as proof and reference**
- **do not use upstream as a migration recipe**

## Interaction with `work/16-midi-import.md`

The good news: **the Tauri idea and the MIDI import work are compatible**.

The important condition: **the translation core must stay platform-agnostic**.

`work/16-midi-import.md` is already pushing in the right direction. The spec wants:

- adapters at the edges
- a shared normalized `TranslationInput`
- a pure analyze + codegen core
- UI and entry points kept thin

That is exactly the shape we want if desktop is ever added later.

## Positive interaction

Tauri could make MIDI import better by improving the edges:

- native file picker for `.mid`
- drag/drop of files from Finder / Explorer
- file associations so opening a `.mid` can launch strasbeat
- better write destinations for generated pattern drafts

Those are shell wins. They do not require the translation core to know anything
about Tauri.

## The key rule

Do **not** let Tauri concerns leak into the translation engine.

Good boundary:

- browser file picker or Tauri open dialog reads the file
- adapter turns parsed MIDI into the normalized translation model
- shared codegen emits readable Strudel source
- browser or desktop save flow decides where the generated file goes

Bad boundary:

- `midi-to-strudel` imports Tauri APIs directly
- the translation model changes shape depending on platform
- desktop-only assumptions get baked into the import core

If we keep the seam clean, `16-midi-import.md` becomes a reason **for** Tauri,
not against it.

## The real risk: live MIDI, not MIDI file import

The main collision is not file import. It is live MIDI input.

Today, strasbeat's live MIDI path is browser-Web-MIDI-based. If we later move to
desktop, especially on macOS, we may need a native bridge for live device input.

That is a separate problem from MIDI file import and should stay separate.

In other words:

- MIDI **file import** should remain shared and platform-neutral
- live MIDI **device support** may need platform-specific native integration

That separation is healthy.

## Cost / risk / maintenance

| Area                                             | Value if done well | Cost / risk   |
| ------------------------------------------------ | ------------------ | ------------- |
| Native save/open workflow                        | High               | Medium        |
| Native menus / window polish / updater           | Medium to high     | Medium        |
| File associations / deep links / single instance | Medium             | Low to medium |
| Local sample folders                             | Medium to high     | Medium        |
| Live MIDI on macOS                               | High               | High          |
| Generic performance uplift                       | Low to medium      | Uncertain     |
| Cross-platform packaging QA                      | Medium             | High          |

## Platform notes

### macOS

Best candidate for product value, but the hardest place to be naive.

- strong shell benefits
- best alignment with the "proper app" goal
- main MIDI risk because webview support is the weak point
- codesigning / notarization / distribution become real work

### Windows

Probably the most straightforward Tauri desktop target technically.

- WebView2 is well supported
- native shell features are strong
- updater and installer story are mature
- still requires release engineering, but the browser-runtime story is easier

### Linux

Useful eventually, but not the first platform to optimize around.

- WebKitGTK variability increases QA burden
- packaging fragmentation is real
- should be treated as a later confidence target, not the first success bar

## When this would be worth it

Tauri is probably worth it if the product direction becomes:

- desktop-first daily-driver composition workflow
- real local files and folders, not just browser buffers
- stronger MIDI / OSC / sample-library integration
- a shell that should feel closer to an IDE or music tool than a website

Tauri is probably **not** worth it if the real motivation is mostly:

- "make it look less like Chrome"
- "maybe it will be faster"
- "it would be cool to have an app icon"

Those are not strong enough reasons on their own.

## Recommended decision rule

Do **not** decide this at the level of framework preference.

Decide it at the level of user-facing wins.

Green-light a Tauri spike only if we believe all of these are true:

1. Desktop file workflow is strategically important to strasbeat.
2. Native shell affordances would noticeably improve daily use.
3. We are willing to own desktop packaging and release complexity.
4. We have a credible answer for live MIDI on macOS.

If any of those are false, the PWA/web path should remain primary.

## Recommended next step if we revisit this

Do a short, explicit spike. Not a migration.

Spike goals:

1. Boot the current app inside stable Tauri 2.
2. Replace `/api/save` with native open/save and prove the pattern workflow is
   better, not just different.
3. Replace the sample-manifest proxy story with a desktop-safe approach.
4. Verify live playback and WAV export still behave correctly.
5. Prove or disprove a viable macOS live MIDI story.

Go / no-go after the spike:

- **Go** if the app materially improves and live MIDI has a clean answer.
- **No-go** if the shell is nicer but the musical workflow is basically unchanged,
  or if MIDI becomes fragile enough that the desktop build fights the product.

## Bottom line

Tauri is not obviously a waste of resources.

It becomes worthwhile the moment strasbeat wants to be a real local composition
tool with native file workflow and stronger system integration.

It becomes wasteful if we use it only as aesthetic packaging.

The upstream Strudel project is a useful proof that Tauri can add real value,
especially through native bridges. It is also a warning that the value comes from
owning those bridges and workflow decisions, not from wrapping the site and
calling it done.
