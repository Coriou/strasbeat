# 14 — Strudel learning and extensibility

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. Then read this whole file. Phases are ordered — each one
> ships on its own and the next phase assumes the previous is landed.

## Positioning

strasbeat is already stronger than upstream strudel.cc in several
areas and should keep those opinions:

| Area                  | strasbeat today                                                                | Upstream strudel.cc                            |
| --------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| **Local files**       | `patterns/*.js` on disk, git-tracked, `POST /api/save`                         | Supabase-backed, no local FS                   |
| **Editor ergonomics** | VSCode keymap, Prettier format, numeric scrubber, track labels/mute/solo       | Codemirror/Vim/Emacs, no format, no labels     |
| **Command palette**   | Full `Cmd+Shift+P` with recents, shortcuts                                     | None                                           |
| **Export UX**         | Dedicated panel with range/rate/filename/progress/waveform preview             | Inline form, no preview                        |
| **MIDI capture**      | Live phrase → saved pattern file, MIDI bar with chord detection, mini-keyboard | No MIDI input capture, no visual keyboard      |
| **Sound browser**     | Kit grouping, category pills, instant preview, insert, "in use" highlights     | Flat alphabetical list, mousedown preview only |
| **API reference**     | Categorized, searchable, "Try"/"Insert", deep-link from hover docs             | Category tags, click-to-expand, no "Try"       |
| **Settings**          | Categorized sections, OKLCH accent picker, per-toggle hints                    | Flat checkbox dump, 40+ themes                 |
| **Console**           | Structured levels, eval dividers, filter bar                                   | Basic log lines, repetition count              |
| **Design system**     | Deliberate Figma-grammar, OKLCH tokens, strict grid                            | Tailwind utility classes, no system            |

**We should not chase upstream parity blindly.** The highest-value
gaps are in areas where upstream has real substance that strasbeat
lacks entirely:

1. **In-app learning flow** — upstream has a full workshop, tutorial
   pages, example patterns, and a searchable docs site. strasbeat has
   zero in-app learning beyond hover docs and the reference panel.
2. **User-extensible setup / prebake** — upstream ships a full
   CodeMirror-backed prebake editor where users can register custom
   samples, helpers, `Pattern.prototype` extensions, and opt-in
   packages. strasbeat hardcodes everything in `main.js:prebake`.
3. **Real Strudel MIDI/OSC I/O** — upstream loads `@strudel/midi`
   (Web MIDI pattern output) and `@strudel/osc` (OSC over WebSocket).
   strasbeat's MIDI bridge is input-only and hand-rolled; there's no
   `midi()` output destination and no OSC at all.
4. **Richer sound / user-sample support** — upstream loads wavetables,
   ZZFX, VCSL, user-imported IndexedDB samples, and more sample banks.
   strasbeat loads synths, soundfonts, dirt-samples, and tidal
   drum machines — no user import path, no wavetables.
5. **Visual feedback entry points** — upstream supports `@strudel/draw`
   canvas callbacks, `@strudel/hydra` shader visuals, and the built-in
   pianoroll/scope. strasbeat has one fixed piano roll canvas with no
   user-extensible visual layer.

This spec defines how to close those gaps without turning strasbeat
into a parity clone, while respecting the existing shell layout, design
system, and phased delivery model.

## Cross-cutting constraints

- **Do not modify `strudel-source/`.** Read-only upstream reference.
- **Do not rewrite `src/main.js` broadly.** Additive seams only;
  the refactor in spec 10 already happened.
- **Left rail stays focused** on owned/local patterns. No social/public
  pattern browsing on the left.
- **Right rail hosts learning, exploration, and setup** panels — it
  already has the tabbed panel infrastructure from spec 08.
- **Design system alignment** — all new UI follows `SYSTEM.md` tokens,
  spacing, elevation, and motion. No new visual primitives without
  updating the system doc.
- **Selective package expansion** — prefer opt-in loading of specific
  packages (`@strudel/xen`, `@strudel/edo`, `@strudel/mondo`,
  `@strudel/hydra`, `@strudel/midi`, `@strudel/osc`) over pulling in
  everything upstream loads by default. Keep boot fast.
- **`Learn` is the umbrella** for workshop content, recipes, searchable
  docs, and example/pattern browsing. No separate "community patterns"
  or "social" panel — fold example browsing and metadata into Learn.

---

## Phase 1: Learn panel

### Motivation

A composer who opens strasbeat cold today sees an editor, a sound
browser, and an API reference. There's no guided path from "I'm new"
to "I made a thing." Upstream has a full workshop at strudel.cc/learn
with chapters, playable examples, and a progressive curriculum.
strasbeat should offer an in-app learning surface that leverages
upstream's content without needing to leave the app or maintain a
parallel docs site.

### Scope

A new **Learn** panel in the right rail. It is the single entry point
for:

1. **Workshop chapters** — a curated, progressive list of lessons
   derived from upstream's workshop content (not scraped live — a
   static index with titles, summaries, and playable code blocks
   that load into the editor).
2. **Recipes** — short, task-oriented "how do I…" entries
   (e.g., "Add a delay", "Make a chord progression", "Import my own
   samples"). Each recipe is a title + 2–3 sentence description +
   a playable example.
3. **Example browser** — a searchable, tagged collection of example
   patterns (upstream examples, strasbeat demo patterns, community
   highlights). Browsing happens here, not in the left rail. Metadata
   (title, author, tags, description) is stored alongside the code.
4. **Docs search** — a search input at the top that queries across
   workshop chapters, recipes, and the existing `strudel-docs.json`
   function reference. Think Spotlight: one box, ranked results across
   content types.

### Non-goals

- Live-fetching content from strudel.cc at runtime (fragile,
  CORS-dependent, stale without notice). All content is static or
  bundled.
- A full docs rendering engine (Markdown → HTML pipeline). Keep it
  simple: structured JSON data with pre-rendered HTML fragments if
  needed.
- Maintaining content parity with every upstream workshop update.
  The index is a curated subset, updated manually when meaningful
  upstream changes land.
- Social features (upvotes, comments, user-submitted patterns).
  Example patterns are editorially curated, not crowd-sourced.
- Replacing the existing API reference panel. Learn and Reference are
  sibling tabs; docs search cross-links into Reference for function
  details.

### UX entry points

- **Right-rail tab** with a `graduation-cap` (or `book-open-text`)
  Lucide icon, labeled "Learn". Registered before the existing
  Sound / Reference / Console / Export / Settings tabs so it appears
  first in the tab strip.
- **Command palette** command: "Open Learn Panel".
- **First-run hint**: if no `strasbeat:learn-visited` localStorage
  key exists, the right rail auto-opens to the Learn panel on first
  boot (after prebake completes). Sets the key on first visit.
- **Deep links from other panels**: the Reference panel's function
  entries can link to the relevant workshop chapter
  (e.g., `note` → "Workshop: Notes and scales"). The sound browser
  can link to the "Working with sounds" recipe.

### Architecture notes

- **Data format**: a single `src/learn/index.json` file (or a small
  set of JSON files) containing the content index. Each entry has
  `{ id, type: 'workshop'|'recipe'|'example', title, summary, tags,
code, chapter?, order? }`. Code examples are stored as string
  literals (same format as `patterns/*.js` — they go through the
  Strudel transpiler when loaded into the editor).
- **Panel implementation**: `src/ui/learn-panel.js`, same factory
  pattern as the other right-rail panels. Pure DOM, no framework.
- **Content authoring**: a `scripts/build-learn-index.mjs` script
  that reads Markdown/JSON source files from `src/learn/content/`
  and produces `src/learn/index.json`. Content authors write in a
  human-friendly format; the build step produces the compact JSON
  the panel consumes. Added to `pnpm gen:learn`.
- **"Try" action**: identical to the Reference panel's — replaces
  the editor buffer with the example code (after dirty-check modal)
  and evaluates it. Reuses the existing `tryReferenceExample` path
  in `editor-actions.js`.
- **"Copy to new pattern"**: creates a new user pattern from the
  example code (via the `patterns.js` `handleNewPatternClick` path)
  so the user can save their modified version without overwriting
  the original example.
- **Search**: client-side, across titles + summaries + tags + code
  content. Debounced 150ms, same as sound browser. Results are
  ranked: title match > tag match > summary match > code match.
  Cross-links into Reference panel for function-name matches.

### Files likely to change

| Action | File                                                                              |
| ------ | --------------------------------------------------------------------------------- |
| Create | `src/ui/learn-panel.js`                                                           |
| Create | `src/styles/learn.css`                                                            |
| Create | `src/learn/index.json` (generated)                                                |
| Create | `src/learn/content/` (source Markdown/JSON)                                       |
| Create | `scripts/build-learn-index.mjs`                                                   |
| Modify | `src/main.js` — register Learn panel with right rail, wire "Try" / "Copy" actions |
| Modify | `src/ui/command-palette.js` — add "Open Learn Panel" command                      |
| Modify | `src/ui/reference-panel.js` — add cross-links to workshop chapters                |
| Modify | `src/style.css` — import learn.css                                                |
| Modify | `package.json` — add `gen:learn` script                                           |

### Acceptance criteria

- [ ] Learn panel opens in right rail with workshop, recipes, and
      example browser sections.
- [ ] Search filters across all content types, ranked results.
- [ ] "Try" loads an example into the editor and evaluates it (after
      dirty-check).
- [ ] "Copy to new pattern" creates a saved user pattern from the
      example.
- [ ] First-run hint auto-opens the Learn panel for new users.
- [ ] Deep links from Reference panel function entries work.
- [ ] No new runtime dependencies (content is static JSON).
- [ ] Workshop content covers at least: mini-notation basics, sounds,
      effects, pattern combinators, tonal functions, and one strasbeat
      extension (progression).
- [ ] Panel follows design system tokens, spacing, and motion.

### Risks / open questions

- **Content volume**: how many workshop chapters and recipes to ship
  in v1? Propose starting with ~8 workshop chapters and ~12 recipes
  — enough to be useful, small enough to curate well. Expand later.
- **Staleness**: upstream workshop content evolves. Accept manual
  curation and version-stamp each chapter so drift is detectable.
  A `// upstream-version: <commit-hash>` comment in each content file
  would make auditing straightforward.
- **Bundle size**: if content grows large, consider lazy-loading
  individual chapter content (fetch from a local JSON file) rather
  than bundling everything into the main chunk. For v1 with ~20
  entries the overhead is negligible.
- **Cross-panel search UX**: one search box querying Learn + Reference
  is powerful but potentially confusing. Consider visual differentiation
  (icon badges per result type: 📖 workshop, 🧪 recipe, 🎵 example,
  `ƒ` function). If too complex for Phase 1, defer unified search and
  keep the Learn panel's search scoped to its own content only.

---

## Phase 2: User setup / prebake layer

### Motivation

strasbeat hardcodes its package loading and sample registration in
`main.js:prebake()`. There's no way for a user to:

- Register custom samples from a URL or local folder.
- Add a `Pattern.prototype` extension (like upstream's `.piano()`).
- Load opt-in packages (`@strudel/xen`, `@strudel/edo`,
  `@strudel/mondo`) without editing source.
- Run initialization code before pattern evaluation.

Upstream solves this with a "prebake" script — a full CodeMirror editor
in the Settings tab where users write arbitrary JS that runs once at
boot. strasbeat should offer the same capability but with a better UX:
structured, guided, and integrated with the existing settings and
sound-browser panels rather than a raw code editor dropped into
settings.

### Scope

1. **Setup panel** — a new right-rail panel (or a section within
   Settings) for managing user initialization code. Two modes:
   - **Guided mode**: structured form for common operations (register
     samples from URL, load optional package, add Pattern.prototype
     method). Each operation is a card with inputs and a "Save"
     button. Zero JS knowledge required.
   - **Script mode**: a CodeMirror editor for freeform setup code
     (same concept as upstream's prebake). For power users.
     Script mode code is stored in localStorage under
     `strasbeat:setup-script` and executed during the `prebake()`
     phase of boot, after the core packages load but before patterns
     evaluate.

2. **Package loader** — a curated list of opt-in Strudel packages
   with descriptions and toggle switches:
   - `@strudel/xen` — xenharmonic / microtonal utilities
   - `@strudel/edo` — equal division of the octave
   - `@strudel/mondo` — Monome grid integration
   - `@strudel/hydra` — Hydra shader visuals (see Phase 5)
   - `@strudel/midi` — MIDI pattern output (see Phase 4)
   - `@strudel/osc` — OSC output over WebSocket (see Phase 4)
   - `@strudel/csound` — Csound synthesis
   - `@strudel/serial` — serial port communication
     Each toggle adds the package to the `evalScope()` call. Packages
     are loaded dynamically (`import()`) so they don't bloat the default
     bundle. Enabled packages are persisted to localStorage
     (`strasbeat:enabled-packages`).

3. **User sample registration** — an "Import sounds" flow accessible
   from both the Setup panel and the Sound Browser's "User" category:
   - Upload a folder of WAV/MP3/OGG files → stored in IndexedDB →
     registered as a sound bank → appears in the sound browser and
     autocomplete.
   - Provide a URL to a samples JSON manifest (same format as
     `samples()` accepts) → fetched and registered at boot.
   - Imported samples survive across sessions (IndexedDB-backed).
   - "Delete all user samples" action with confirmation.

4. **Helper registration** — a path for users to register custom
   functions into `evalScope()` without editing `src/strudel-ext/`.
   The setup script can `export` functions and they'll be available
   in pattern code. This is the user-land equivalent of what
   `strudel-ext/index.js` does for strasbeat's own helpers.

### Non-goals

- A package manager or npm resolver. Packages are the ones strasbeat
  bundles (or can dynamically import from a CDN); users don't pick
  arbitrary npm packages.
- Server-side file storage for samples. IndexedDB only for now.
- Executing the setup script in a sandboxed context. It runs in the
  same scope as pattern code — same trust model as upstream.
- Migrating strasbeat's own prebake logic into the user setup panel.
  The hardcoded `main.js:prebake()` stays as the foundation; user
  setup code runs _after_ it.

### UX entry points

- **Right-rail tab**: `wrench` icon, labeled "Setup". Positioned after
  Settings in the tab strip (or as a sub-tab within Settings — decide
  during implementation based on tab-bar crowding).
- **Sound browser**: "Import sounds" action at the top of the "User"
  category (currently shows "no sounds loaded yet" when empty).
- **Command palette**: "Open Setup" and "Import Sounds" commands.
- **Settings panel → About section**: "Loaded packages" list showing
  which opt-in packages are active.

### Architecture notes

- **Boot sequence change in `main.js`**: after the existing `prebake()`
  resolves, a new `runUserSetup()` step loads enabled packages and
  executes the stored setup script. This is the only `main.js` change
  — a single additive call in the `prebake` callback, after the
  existing sample loading.
- **Dynamic package loading**: `import('@strudel/xen')` is a standard
  Vite dynamic import. **The opt-in packages are NOT currently
  installed** — they must be added to `package.json` as dependencies
  before they can be dynamically imported. (They exist in
  `strudel-source/packages/` and on npm but are not transitive deps
  of the packages strasbeat already uses.) Once installed, Vite will
  code-split them into separate chunks automatically. We add them to
  `evalScope()` after the dynamic import resolves.
- **`evalScope()` additivity**: strasbeat currently calls
  `evalScope()` **once** at boot (main.js ~line 242). Dynamically
  loaded packages need a second `evalScope()` call after import.
  **Before implementing, verify that `evalScope()` is additive** by
  reading `strudel-source/packages/core/evaluate.mjs`. Upstream's
  prebake passes all packages (including `@strudel/midi`,
  `@strudel/hydra`) into a single `evalScope()` call — it never
  calls it twice. If `evalScope()` replaces rather than merges, the
  architecture must change to pass all packages (core + opt-in) into
  one call, gated by config. Note: some packages (like
  `@strudel/midi`) work via `Pattern.prototype` mutation on import
  and don't strictly need `evalScope()` for their `.midi()` method
  — but their standalone functions (`enableWebMidi`, `midin`, etc.)
  do need it to be available as globals in pattern code.
- **User sample IndexedDB**: follow upstream's pattern in
  `website/src/repl/idbutils.mjs` — store decoded AudioBuffers in
  IndexedDB, register them via `samples()` during setup. Consider
  extracting upstream's IDB utilities into strasbeat rather than
  reimplementing.
- **Setup panel state**: two localStorage keys —
  `strasbeat:enabled-packages` (JSON array of package ids) and
  `strasbeat:setup-script` (string). The guided mode operations
  compile down to setup script lines when saved (so script mode always
  shows the full picture).

### Files likely to change

| Action | File                                                                                      |
| ------ | ----------------------------------------------------------------------------------------- |
| Create | `src/ui/setup-panel.js`                                                                   |
| Create | `src/styles/setup.css`                                                                    |
| Create | `src/user-setup.js` — `runUserSetup()` logic, package loader, IDB sample registration     |
| Modify | `src/main.js` — call `runUserSetup()` in prebake, register Setup panel                    |
| Modify | `src/ui/sound-browser.js` — "Import sounds" action in User category, refresh after import |
| Modify | `src/ui/settings-panel.js` — "Loaded packages" in About section                           |
| Modify | `src/ui/command-palette.js` — "Open Setup" / "Import Sounds" commands                     |
| Modify | `src/style.css` — import setup.css                                                        |
| Modify | `package.json` — add opt-in packages to dependencies                                      |

### Acceptance criteria

- [ ] Setup panel opens in right rail with guided mode and script mode.
- [ ] Package toggles enable/disable opt-in packages; changes take
      effect on next page reload (with confirmation dialog).
- [ ] User sample import flow works: folder upload → IndexedDB →
      sound browser shows them under "User" category → autocomplete
      includes them.
- [ ] Setup script executes during boot, after core prebake.
- [ ] Functions exported from the setup script are available in pattern
      code.
- [ ] All persisted state survives across sessions.
- [ ] Boot time does not regress when no opt-in packages are enabled
      and no setup script exists.
- [ ] "Delete all user samples" works with confirmation.

### Risks / open questions

- **Tab-bar crowding**: the right rail now has 7 tabs (Learn, Sounds,
  Reference, Console, Export, Settings, Setup). That's a lot of icons
  in a 36px-wide vertical strip. Options: (a) group Setup as a sub-tab
  inside Settings (upstream does this), (b) add a "more" overflow
  chevron, (c) accept 7 tabs and verify they fit in typical viewport
  heights. Propose (a) — Setup as a Settings sub-tab — unless the CEO
  prefers a standalone tab.
- **Dynamic import reliability**: packages imported via `import()` need
  to be installed at build time. If a toggled package isn't in
  `node_modules`, the import fails at runtime. Solution: install all
  opt-in packages as dependencies but only load them dynamically when
  the user enables them.
- **Setup script security**: the script has the same power as pattern
  code (it runs in the page context). This is fine for a personal tool.
  Document it explicitly: "Your setup script runs with the same
  permissions as your patterns."
- **IndexedDB storage limits**: browsers typically allow 50MB+ per
  origin. Large sample libraries could approach this. Surface a
  "storage used" indicator in the Setup panel if feasible. Defer
  quota-exceeded handling to a console warning for now.

---

## Phase 3: Sound-browser expansion

### Motivation

strasbeat's sound browser already beats upstream on UX (kit grouping,
"in use" highlights, insert action). But the underlying sound coverage
is narrower: no wavetables, no ZZFX, no VCSL, no user-imported
samples, no uzu-drumkit. Phase 2 opens the door to user samples;
this phase expands the _built-in_ coverage and makes the browser richer.

### Scope

1. **Additional sample banks** — register the sample sets that upstream
   loads but strasbeat currently skips:
   - VCSL (orchestral, CC0, ~60MB) — behind an opt-in toggle in
     Setup (too large for mandatory boot loading).
   - uzu-drumkit (small, can be added to default prebake).
   - uzu-wavetables (wavetable synthesis, medium).
   - ZZFX (procedural sound effects via `registerZZFXSounds()`).
   - Casio, jazz, metal, east, space, wind, insect, crow, numbers
     (small curated Dirt-Samples subsets upstream loads inline).
     **Note:** strasbeat already loads `github:tidalcycles/dirt-samples`
     which is the full Dirt-Samples repo. These subsets may already be
     available. **Verify by running `strasbeat.findSounds('casio')`
     in devtools before adding redundant registrations.** If the full
     repo load covers them, this line item is a no-op.
     Default-on: ZZFX, uzu-drumkit (and any dirt-samples subsets not
     already covered by the existing `samples()` call).
     Opt-in via Setup panel: VCSL, uzu-wavetables (large).

2. **Sound browser "User" category** — wired to the IndexedDB-backed
   user samples from Phase 2. Shows imported sound banks with a
   delete action per bank. Empty state links to the Import flow.

3. **Wavetable category** — new pill in the sound browser for
   wavetable sounds (if uzu-wavetables or user wavetables are loaded).

4. **Sound metadata enrichment** — where available, show additional
   info in the browser: license, author, sample rate, duration.
   For built-in banks, metadata is baked into the build. For user
   samples, metadata is extracted at import time (from WAV headers
   or user-supplied JSON).

5. **Sample count in settings** — the Settings panel's About section
   already shows total sound count. Expand it to show a breakdown:
   `Synths: 12 · Kits: 340 · GM: 128 · User: 24 · Total: 504`.

### Non-goals

- Drag-and-drop from the OS into the sound browser. Nice but complex;
  defer.
- Waveform previews for individual samples. Too heavy for the browser
  panel.
- A sample editor (trim, normalize, pitch-shift). Out of scope.

### UX entry points

- **Sound browser** — new "Wavetable" pill, enriched "User" category.
- **Setup panel** — toggles for VCSL, uzu-wavetables, ZZFX.
- **Settings → About** — enriched sound count breakdown.

### Architecture notes

- Additional sample registrations are added to `main.js:prebake()` for
  default-on banks, and to `user-setup.js:runUserSetup()` for opt-in
  banks (gated by the `strasbeat:enabled-packages` / setup config).
- The sound browser's `collectSounds()` function already reads
  `soundMap()` generically. New banks appear automatically once
  registered. The only change needed is a new category pill and
  potentially a new `type` detection branch for wavetables.
- ZZFX sounds are registered via `registerZZFXSounds()` from
  `@strudel/webaudio` — a one-line call in prebake.

### Files likely to change

| Action | File                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| Modify | `src/main.js` — add ZZFX, uzu-drumkit, curated dirt-samples to prebake                 |
| Modify | `src/user-setup.js` — opt-in loading for VCSL, uzu-wavetables                          |
| Modify | `src/ui/sound-browser.js` — "Wavetable" pill, "User" category wiring, metadata display |
| Modify | `src/ui/settings-panel.js` — enriched sound count breakdown                            |
| Modify | `src/styles/sound-browser.css` — metadata display styling                              |

### Acceptance criteria

- [ ] ZZFX sounds appear in the sound browser under Synth category.
- [ ] uzu-drumkit appears under Kits.
- [ ] Curated dirt-samples subsets (casio, jazz, etc.) appear under
      appropriate categories.
- [ ] VCSL and uzu-wavetables are available as opt-in toggles in
      Setup; when enabled, they appear in the browser after reload.
- [ ] User-imported samples appear under the "User" category with
      per-bank delete.
- [ ] "Wavetable" category pill appears when wavetable sounds are
      loaded.
- [ ] Settings → About shows breakdown of sound counts by type.
- [ ] Boot time does not regress for users who don't enable opt-in
      banks. Default-on additions (ZZFX, uzu-drumkit, curated sets)
      add < 500ms to boot under normal network conditions.

### Risks / open questions

- **CDN dependency**: the curated dirt-samples subsets upstream loads
  are served from `strudel.b-cdn.net`. strasbeat currently proxies
  strudel.cc via `vite.config.js`. Verify whether the CDN has CORS
  headers or whether we need to proxy it too. If proxying is needed,
  add it to `vite.config.js` and to `vercel.json` for production.
- **Bundle impact of ZZFX**: `registerZZFXSounds()` is small (no
  network fetches — it's procedural). Safe to add to default prebake.
- **Category pill overflow**: adding "Wavetable" to the existing
  `[All] [Kits] [GM] [Synth]` set is fine. If User is also added,
  that's 6 pills in a ~280px-wide panel. Verify they wrap gracefully
  or use a horizontal scroll region.

---

## Phase 4: Real Strudel MIDI/OSC routing

### Motivation

strasbeat's MIDI bridge (`src/midi-bridge.js`) is a hand-rolled
input-only system: it listens on Web MIDI, routes noteons through
`superdough()`, and supports capture. It does _not_ provide the
Strudel pattern-language `midi()` output destination or OSC routing
that upstream's `@strudel/midi` and `@strudel/osc` packages offer.

A composer writing `note("c e g").midi()` in upstream Strudel sends
MIDI to an external device. In strasbeat today, that pattern silently
produces no sound (the `midi` output isn't registered). Similarly,
`osc()` routes pattern events over WebSocket to SuperCollider or any
OSC-capable tool — strasbeat has no such path.

This is not just a panel — it's a **runtime-and-routing project** that
touches the audio/MIDI infrastructure, the evalScope, and the UI for
device selection and monitoring.

### Scope

1. **`@strudel/midi` integration** — load the package (opt-in via
   Setup panel, Phase 2) and register it with `evalScope()` so
   `midi()` and `.midi(output?)` work in pattern code. This gives
   strasbeat MIDI _output_ alongside its existing MIDI _input_. MIDI
   file import and capture-to-pattern translation belong to
   `16-midi-import.md`, not this scope.

2. **MIDI output device selector** — UI for choosing which MIDI
   output device receives pattern events. Options:
   - A dropdown/popover in the MIDI bar (most discoverable).
   - A section in the Setup panel (less intrusive).
   - Both: Setup for persistent default, MIDI bar for quick switching.
     Device list comes from `navigator.requestMIDIAccess()` outputs.

3. **`@strudel/osc` integration** — load the package (opt-in) and
   register with `evalScope()` so `osc()` works. OSC routes events
   over WebSocket to a local bridge (e.g., `strudel-osc-bridge` or
   SuperCollider's built-in WS server).

4. **OSC target configuration** — UI in Setup panel: WebSocket URL
   (default `ws://localhost:57120`), connection status indicator,
   test-send button.

5. **Coexistence with the MIDI bridge** — the existing MIDI bridge
   handles _input_ (keyboard → superdough). `@strudel/midi` handles
   _output_ (pattern → external synth). They must coexist without
   conflicts on the same MIDI ports. Document the routing model:
   - Input: Web MIDI input device → MidiBridge → superdough (live play)
   - Output: pattern → `midi()` → `@strudel/midi` → Web MIDI output device
   - The same physical device can be both input (for live play) and
     output (for pattern playback) simultaneously. `@strudel/midi`
     manages its own output ports independently of MidiBridge's input
     ports.

### Non-goals

- MIDI learn / CC mapping from `@strudel/midi` to internal parameters.
  Phase 3+ of the MIDI experience (spec 13).
- A SuperCollider integration guide. Out of scope for this spec.
- Replacing the MIDI bridge's input path with `@strudel/midi`'s input.
  The bridge's trigger-and-decay model is strasbeat-specific and superior
  for live play. Keep both.
- MIDI file import, MIDI seed-library ingestion, or MIDI-to-Strudel
  code generation. Those belong to `16-midi-import.md`.
- Latency compensation for MIDI/OSC output. Accept browser-native
  latency for now.

### UX entry points

- **Setup panel** — package toggles for `@strudel/midi` and
  `@strudel/osc`. When enabled, the relevant configuration UI appears.
- **MIDI bar** — output device selector (when `@strudel/midi` is
  enabled). Visual indicator showing output activity (small LED-style
  dot that flashes on outgoing MIDI events).
- **Console panel** — MIDI/OSC connection status messages.
- **Command palette** — "Toggle MIDI Output" / "Configure OSC" commands.

### Architecture notes

- **`@strudel/midi` and `@strudel/osc` are already present in
  `package.json`, and `src/user-setup.js` already contains opt-in loader
  entries for both.** The remaining work is runtime registration,
  device/config UI, and validating the published package behavior in the
  app's real browser path.
- `@strudel/midi` registers `.midi()` via a **side-effect
  `Pattern.prototype.midi` mutation** on import — the import alone
  makes `.midi()` available on patterns without needing `evalScope()`.
  However, its standalone exports (`enableWebMidi`, `WebMidi`,
  `midin`, `midikeys`, `defaultmidimap`) need `evalScope()` to
  become globals. The default output device is configured via the
  `webmidi` library's `WebMidi.outputs` API (check upstream source
  at `strudel-source/packages/midi/util.mjs:getDevice()`).
- **Important:** package installation alone is not proof that the runtime
  path is healthy. A current Node ESM smoke test in this repo fails while
  resolving the installed Strudel graph (`@kabelsalat/web` export mismatch
  under `@strudel/core`). Treat that as a real packaging/runtime risk and
  verify the browser-side dynamic import path before building UI on top of
  it.
- `@strudel/osc` similarly exports an `osc` function. It requires a
  running WebSocket bridge on the target machine. strasbeat's role is
  limited to loading the package and providing the target URL config.
- The MIDI bar's mini-keyboard and note display continue to reflect
  _input_ activity. A new small section or indicator reflects _output_
  activity when `@strudel/midi` is active.

### Files likely to change

| Action | File                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------ |
| Modify | `src/user-setup.js` — extend the existing dynamic import entries with output-device / OSC config |
| Modify | `src/ui/setup-panel.js` — MIDI output device selector, OSC target config                         |
| Modify | `src/ui/midi-bar.js` — output device dropdown + activity indicator                               |
| Modify | `src/main.js` — ensure evalScope receives the dynamically loaded modules                         |
| Modify | `package.json` — only if version alignment is needed; both packages are already present          |
| Create | `src/osc-config.js` — optional, if OSC config logic is non-trivial                               |
| Modify | `src/styles/midi-bar.css` — output indicator styling                                             |

### Acceptance criteria

- [ ] With `@strudel/midi` enabled, `note("c e g").midi()` sends MIDI
      note events to the selected output device.
- [ ] MIDI output device selector shows all available output ports.
- [ ] Default output device persists across sessions.
- [ ] With `@strudel/osc` enabled, `note("c e g").osc()` sends events
      over WebSocket to the configured URL.
- [ ] OSC connection status is visible in the Setup panel.
- [ ] MIDI input (bridge) and MIDI output (`@strudel/midi`) coexist
      without port conflicts.
- [ ] When neither package is enabled, there's zero runtime overhead
      — no imports, no UI, no event listeners.
- [ ] Console panel shows connection/disconnection events for MIDI
      output and OSC.

### Risks / open questions

- **`@strudel/midi` API stability**: check whether the package's
  output device selection API is public and stable, or whether it
  relies on internal Strudel wiring that only works inside the
  upstream REPL. Read `strudel-source/packages/midi/` before
  implementing. The package depends on the third-party `webmidi`
  library (not just the browser's native Web MIDI API) — verify
  that `webmidi` doesn't conflict with MidiBridge's direct
  `navigator.requestMIDIAccess()` usage.
- **Web MIDI permissions**: `requestMIDIAccess({ sysex: false })` is
  gated behind a user gesture in most browsers. strasbeat already
  requests MIDI access for input (MidiBridge). Verify that a single
  `requestMIDIAccess` call can serve both input and output, or whether
  `@strudel/midi` requests its own access separately.
- **OSC browser support**: `@strudel/osc` uses WebSocket, which works
  in browsers. But the user needs a running WS↔OSC bridge on their
  machine. This is inherently a power-user feature. Document the
  requirement clearly in the Setup panel.
- **evalScope timing**: dynamically loaded modules need to be in
  `evalScope()` before the user's pattern code is evaluated. The
  current boot sequence evaluates the initial pattern _after_ prebake
  completes. If the user setup script runs after prebake but before
  initial eval, the timing is correct. Verify this order.

---

## Phase 5: Visual feedback entry points

### Motivation

strasbeat has one fixed piano roll at the bottom of the shell. Upstream
Strudel supports multiple visual feedback modes:

- `.pianoroll()` — configurable piano roll drawn on a canvas.
- `.scope()` — oscilloscope / waveform display.
- Hydra integration (`@strudel/hydra`) — full-screen shader visuals
  driven by pattern events.
- Custom `.onPaint()` callbacks — user-defined canvas drawing.

strasbeat's piano roll is good (per-layer color, click-to-locate from
spec 05) but it's the _only_ visual feedback and it's always a piano
roll. A composer using strasbeat for percussion has a piano roll
showing drum hits on pitched rows — functional but not helpful.

This phase defines how to support richer visual feedback without
duplicating the existing roll or requiring a giant shell rewrite.

### Scope

1. **Bottom-panel mode switcher** — the bottom panel (currently always
   "piano roll") gains a small tab bar or mode selector to switch
   between visualization modes:
   - **Piano Roll** (default, existing implementation)
   - **Scope** (oscilloscope — waveform of the live audio output)
   - **Custom** (user's `.onPaint()` callback renders to the same
     canvas)
     Only one mode is active at a time. The canvas element is shared;
     the draw callback switches based on the selected mode.

2. **Scope visualization** — a real-time waveform display using an
   `AnalyserNode` from the Web Audio API. Renders to the same
   bottom-panel canvas. Simple, performant, useful for debugging
   audio output and verifying that sound is actually playing.
   Styling: accent-colored waveform on `--surface-1` background,
   matching the piano roll's visual language.

3. **User `onPaint` / draw callback** — when a pattern includes
   `.onPaint(fn)` or `.draw(fn)`, the bottom panel switches to
   "Custom" mode and calls the user's function with the canvas
   context and hap data. This is the same mechanism upstream's
   `@strudel/draw` provides but routed through strasbeat's
   single bottom canvas.

4. **Hydra visual layer (opt-in)** — when `@strudel/hydra` is enabled
   (via Setup panel, Phase 2), Hydra's shader output renders as a
   background layer behind the editor (full-bleed, low opacity) or
   in the bottom panel in a dedicated "Hydra" mode. This is a
   stretch goal for Phase 5 — the core deliverable is modes 1–3.

5. **Coexistence** — the existing piano roll continues to work exactly
   as it does today when "Piano Roll" mode is selected. The mode
   switcher is purely additive — no regression to the default
   experience.

### Non-goals

- A multi-canvas system where different visualizations run
  simultaneously in different panels. One bottom panel, one active
  visualization.
- A visual programming environment (connecting nodes, drawing
  patterns). Code is the source of truth.
- Replacing the piano roll with a drum grid / step sequencer view.
  That's a future spec (likely part of the multi-track DAW vision in
  spec 06).
- Real-time FFT / spectrum analyzer. The scope is a waveform display.
  FFT can be added later if there's demand.
- Full Hydra documentation or tutorial. Defer to upstream docs.

### UX entry points

- **Bottom-panel tab bar** — a thin strip (24px) at the top of the
  bottom panel with mode buttons: `Roll` / `Scope` / `Custom`.
  The strip only appears when there's more than one mode available
  (i.e., when a custom draw callback is registered or when the user
  has manually switched at least once). When only the default piano
  roll is active, the strip is hidden — zero visual noise for the
  common case.
- **Command palette** — "Switch to Piano Roll" / "Switch to Scope" /
  "Switch to Custom Visualization" commands.
- **Pattern code** — `.scope()` in a pattern automatically switches
  the bottom panel to scope mode. `.onPaint(fn)` switches to custom
  mode. This matches upstream behavior where the pattern drives the
  visualization.

### Architecture notes

- **Mode state**: a simple string (`'roll' | 'scope' | 'custom'`)
  stored in module-level state (not localStorage — visualization mode
  is session-ephemeral, driven by the pattern being played).
- **Canvas sharing**: the existing `<canvas id="roll">` is reused.
  The `onDraw` callback in `main.js` checks the current mode and
  dispatches to the appropriate renderer:
  - `'roll'` → existing `renderRoll()` in `src/ui/piano-roll.js`
  - `'scope'` → new `renderScope()` in `src/ui/scope.js`
  - `'custom'` → user's callback, called with `(ctx, haps, time)`
    This dispatch is a small change in `main.js`'s `onDraw` handler.
- **AnalyserNode for scope**: create an `AnalyserNode` connected to
  the audio context's destination. `renderScope()` reads
  `getByteTimeDomainData()` on each animation frame and draws the
  waveform. The AnalyserNode is created lazily on first switch to
  scope mode.
- **Hydra integration**: `@strudel/hydra` expects a `<canvas>` element
  to render into. If we go the "background behind editor" route, it's
  a separate full-bleed canvas with CSS `position: fixed; z-index: -1;
opacity: 0.15`. If we go the "bottom panel mode" route, Hydra
  renders into the shared bottom canvas. The former is more dramatic;
  the latter is simpler. Defer the decision to implementation time.
- **Pattern-driven mode switching**: `@strudel/draw`'s `.pianoroll()`
  and `.scope()` methods currently set draw parameters on the pattern.
  strasbeat intercepts these in the `onDraw` callback. For `.scope()`,
  detect its presence and switch mode. For `.onPaint()`, capture the
  callback and switch to custom mode. This is a small extension to the
  existing `onDraw` dispatcher.

### Files likely to change

| Action | File                                                                           |
| ------ | ------------------------------------------------------------------------------ |
| Create | `src/ui/scope.js` — `renderScope()` using AnalyserNode                         |
| Create | `src/ui/bottom-panel-modes.js` — mode state, tab bar, dispatch                 |
| Create | `src/styles/bottom-panel.css` — mode tab bar styling                           |
| Modify | `src/main.js` — `onDraw` dispatch by mode, AnalyserNode setup                  |
| Modify | `src/ui/piano-roll.js` — extract renderRoll to be callable from the dispatcher |
| Modify | `index.html` — mode tab bar markup in the bottom panel                         |
| Modify | `src/styles/roll.css` — adjust for tab bar above the canvas                    |
| Modify | `src/ui/command-palette.js` — visualization mode commands                      |
| Modify | `src/style.css` — import bottom-panel.css                                      |

### Acceptance criteria

- [ ] Bottom panel has a mode switcher that toggles between Roll and
      Scope.
- [ ] Piano Roll mode works identically to today (no regression).
- [ ] Scope mode shows a real-time waveform of the audio output.
- [ ] Custom mode renders user's `.onPaint()` callback.
- [ ] Pattern code containing `.scope()` auto-switches the bottom
      panel to scope mode.
- [ ] Mode tab bar is hidden when only the default Roll is available.
- [ ] Mode switching is instant (no flicker, no re-layout).
- [ ] AnalyserNode is created lazily and doesn't add overhead when
      scope mode is never used.
- [ ] The canvas `ResizeObserver` and HiDPI scaling (existing in
      `main.js`) continues to work for all modes.

### Risks / open questions

- **`@strudel/draw` integration depth**: strasbeat currently uses
  `@strudel/draw` for the piano roll's `onDraw` callback. `Scope`
  and `onPaint` may require understanding how upstream's Drawer class
  dispatches. Read `strudel-source/packages/draw/` before implementing.
- **Performance of scope + pattern evaluation**: the scope's
  `getByteTimeDomainData()` runs at animation-frame rate (~60fps).
  This is standard and lightweight. Verify it doesn't conflict with
  the existing `onDraw` scheduler.
- **Hydra feasibility**: `@strudel/hydra` depends on `hydra-synth`,
  which is a large dependency. If bundle size is a concern, defer
  Hydra to a future phase entirely. The core Phase 5 deliverable
  (mode switcher + scope + custom) doesn't depend on Hydra.
- **Bottom panel height**: the mode tab bar adds 24px to the bottom
  panel's chrome. With the existing ~160px roll, this leaves ~136px
  for the chart. Acceptable, but verify the piano roll still looks
  good at the reduced height. The tab bar hides when only Roll is
  active, so the default experience is unaffected.
- **Custom draw callback API**: what arguments does `.onPaint(fn)`
  receive? Read upstream source. If the API is unstable, wrap it in
  a strasbeat-specific adapter so user code doesn't break on upstream
  updates.

---

## Recommended execution order

```
Phase 1: Learn panel
Phase 2: User setup / prebake layer
Phase 3: Sound-browser expansion
Phase 4: Real Strudel MIDI/OSC routing
Phase 5: Visual feedback entry points
```

**Phase 1** is independent and highest-leverage for onboarding. It
requires no changes to the audio/MIDI stack and builds on the existing
right-rail panel infrastructure.

**Phase 2** is the foundation for Phases 3 and 4 — both depend on the
dynamic package loader and user setup script infrastructure. It also
unblocks user sample import, which is a frequent request.

**Phase 3** builds on Phase 2's package loading and user sample
infrastructure. It's primarily additive sample registration and sound
browser wiring — low risk, moderate value.

**Phase 4** depends on Phase 2's package loader for the `@strudel/midi`
and `@strudel/osc` dynamic imports. It's the most architecturally
complex phase (runtime routing, device management, coexistence with
the MIDI bridge) and benefits from the infrastructure being stable.

**Phase 5** is the most independent — it primarily touches the bottom
panel and `onDraw` dispatch. It could theoretically be done in parallel
with Phase 3 or 4, but it's lower priority than sound coverage and
MIDI/OSC routing for the daily-driver use case.

Within each phase, the spec is designed so a fresh Claude Code agent
can pick it up cold. Each phase ships on its own. Later phases assume
earlier ones are landed but don't require them to be in-flight
simultaneously.

**Quick win (no phase dependency):** adding `registerZZFXSounds()`
and the uzu-drumkit `samples()` call to the existing `prebake()` in
`main.js` is a ~10-line change that adds ~7 ZZFX synth sounds and a
drumkit with zero boot-time regression (ZZFX is procedural, no network
fetch; uzu-drumkit is a small JSON manifest). This can ship
independently of any phase.

---

## Cross-cutting implementation notes

These apply across all phases and should be addressed as each phase
lands:

1. **`CLAUDE.md` must be updated after each phase.** The "Where things
   live" tree, the architecture description, and the "Key gotchas"
   section should reflect new files, new panels, and new concepts
   (e.g., dynamic package loading, user setup scripts, visualization
   modes). Each phase's PR should include the `CLAUDE.md` diff.

2. **`STRUDEL.md` may need updates.** If ZZFX sounds, new banks,
   `.midi()`, `.osc()`, `.scope()`, or `.onPaint()` become available
   in strasbeat, the cheatsheet should mention them. Currently it
   covers none of these.

3. **Deliberate divergence from upstream prebake.** Upstream's
   `prebake.mjs` loads `@strudel/hydra` and `@strudel/midi` by
   default. strasbeat's opt-in model is a deliberate choice for boot
   speed. Document this in `CLAUDE.md` so future sessions don't
   "fix" it by loading everything upstream loads.

4. **Test coverage.** The existing test infrastructure
   (`progression.test.js`, `roman.test.js`, `track-labels.test.js`)
   sets the expectation that new features ship with tests. Each phase
   should include tests for at least: Phase 1 — content schema
   validation, search ranking; Phase 2 — setup script execution,
   package enable/disable persistence; Phase 3 — ZZFX registration
   verification; Phase 4 — MIDI output routing, device enumeration;
   Phase 5 — mode switching, scope renderer.

5. **Right-rail tab capacity.** With all five phases landed, the tab
   strip potentially holds 7 tabs (Learn, Sounds, Reference, Console,
   Export, Settings, Setup). At 32×32px per tab + 8px gap = ~280px
   total, this fits on most viewports but is tight on short screens.
   If Setup becomes a sub-tab of Settings (as the Phase 2 risk section
   proposes), it's 6 tabs — comfortable. Decide before Phase 2 ships.

6. **Content format decision for Phase 1.** The spec proposes a
   `scripts/build-learn-index.mjs` pipeline reading from
   `src/learn/content/`. The source format (Markdown vs JSON) is left
   open. Recommendation: use plain JSON with embedded code strings
   (same format as `patterns/*.js` exports). This avoids needing a
   Markdown parser at build time and keeps the pipeline trivial. If
   richer formatting is needed later, add Markdown support as an
   enhancement.

7. **Pattern creation entry point.** The spec references
   `handleNewPatternClick` for "Copy to new pattern" in the Learn
   panel. Verify the actual function name and signature in
   `src/patterns.js` before implementing — the name may have changed
   since the spec was drafted.
