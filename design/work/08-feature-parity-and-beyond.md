# 08 — Feature parity (and beyond)

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. Then read this whole file. Phases are ordered — each one
> ships on its own and the next phase assumes the previous is landed.

## Motivation

The upstream Strudel REPL at strudel.cc ships a set of panels that
composers rely on daily: a visual sound bank, an in-app API reference,
a console, an export panel, and a settings panel — all inside a tabbed
sidebar. strasbeat currently has _none of these_ as browseable panels.
We have autocomplete (which is great), hover docs (which are great),
and a left rail (which is great) — but a composer who opens strasbeat
cold has no way to _browse_ or _explore_. They have to already know what
they're looking for.

The goal of this spec is to close the exploration gap — and then exceed
it. The upstream versions are functional but plain: flat lists, no
previewing, no contextual awareness, no connection to the editor. Ours
should feel like the difference between a file picker and Spotlight.

## What the upstream REPL ships (for reference)

| Panel         | What it does                                                                                                                                       | Where it falls short                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sounds**    | Flat alphabetical list of all ~1000 sounds, category tabs (samples, drum-machines, synths, wavetables, user, import), search, mousedown to preview | No grouping by kit. No waveform previews. No "insert into editor". Preview requires clicking each one individually. No indication of which sounds the current pattern uses. |
| **Reference** | Alphabetical function list, category tag filters (amplitude, combiners, envelope, …), click to see JSDoc description/params/examples               | No search ranking. No "try it" button. No connection to what's in the editor. Long flat list, hard to browse for beginners.                                                 |
| **Console**   | Log lines with repetition count, error highlighting, clickable URLs                                                                                | Basic. No structured log levels, no filtering, no hap inspector.                                                                                                            |
| **Export**    | Start/end cycle, sample rate, polyphony, filename, progress bar                                                                                    | Functional but minimal. No preview, no waveform, no normalization options.                                                                                                  |
| **Settings**  | 40+ themes, 4 keybinding modes, 15+ fonts, audio device picker, editor toggles                                                                     | Kitchen-sink dump of every option. No hierarchy, no explanation of what things do.                                                                                          |
| **Patterns**  | Pattern library with search, tags, pagination, public/featured patterns                                                                            | Social feature, not applicable to strasbeat's local-file model.                                                                                                             |
| **Welcome**   | Intro text + links                                                                                                                                 | Static page.                                                                                                                                                                |

## What strasbeat already has

These are **not in scope** for this spec — they already exist and work:

- Left-rail pattern library with search + keyboard nav
- Autocomplete for sounds, banks, chords, scales, modes, functions,
  mini-notation
- Hover docs with signature, description, params, examples
- Signature hint pill above cursor
- Piano roll with click-to-locate
- Settings drawer with OKLCH accent picker
- Transport with BPM/cycle/playhead/MIDI pill/status
- WAV export (toolbar button → download)
- Console helpers on `window.strasbeat`

## The plan: a right-rail panel system

The shell layout (`design/SYSTEM.md` §3, `01-shell.md`) already reserves
a **right rail** — currently hidden with width 0. This spec activates
it as a **tabbed panel host**, mirroring the left rail's position but
holding browsable content panels instead of the pattern library.

The right rail is **collapsible** (same as the piano roll bottom panel)
and **remembers its state** in localStorage. When collapsed, only the
tab icons are visible as a thin vertical strip (~36px). When expanded,
it's 320px wide (resizable via drag, 240–480px range, stored in
localStorage).

Tab bar: vertical icon strip on the inner edge (closest to the editor),
tabs stack top-to-bottom. Each tab is a 36×36 icon button. Active tab
has accent-wash background + accent border-left 2px.

---

## Phase 1: Sound Browser

**The highest-value panel.** A composer needs to browse sounds the way a
DAW user browses a sample library — by category, with instant preview,
and with a one-action path to insert into the editor.

### Data source

`soundMap` from `@strudel/webaudio` (same source autocomplete uses).
On boot, strasbeat already calls `registerSynthSounds()`,
`registerSoundfonts()`, `samples(...)` for dirt-samples and tidal
drum machines. The soundMap is populated by the time the UI is
interactive.

### Layout

```
┌─────────────────────────────────┐
│ 🔍 Search                      │
├─────────────────────────────────┤
│ [All] [Kits] [GM] [Synth] [User]│  ← category filter pills
├─────────────────────────────────┤
│ ┌─ 808 ──────────────────────┐ │
│ │  808_bd(4)  808_cb(1) …    │ │  ← collapsible kit group
│ └────────────────────────────┘ │
│ ┌─ 909 ──────────────────────┐ │
│ │  909_bd(3)  909_hh(2) …    │ │
│ └────────────────────────────┘ │
│ ┌─ piano ────────────────────┐ │
│ │  steinway(42)              │ │
│ │  gm_piano(1)               │ │
│ └────────────────────────────┘ │
│ …                               │
└─────────────────────────────────┘
```

### Features

1. **Search** — filters across all sounds, debounced 150ms, highlights
   matches. Same search-first UX as the left rail.

2. **Category pills** — derived from sound name prefixes and the
   registration source:
   - **Kits**: groups with a common prefix before `_` that have 3+
     members (e.g., `808_bd`, `808_hh`, `808_sd` → kit "808").
     Display as collapsible sections.
   - **GM**: names starting with `gm_`.
   - **Synth**: names registered by `registerSynthSounds()` (sine,
     saw, square, triangle, supersaw, etc.).
   - **User**: any sounds added via future import-samples feature.
   - **All**: unfiltered, flat alphabetical.

3. **Kit grouping** — sounds sharing a prefix are grouped under a
   collapsible header showing the kit name and total sample count.
   Inside the group, individual sounds show name + sample count
   (e.g., `bd(4)` means 4 variations). Groups sorted alphabetically.
   Within groups, sounds sorted by conventional drum order
   (bd → sd → hh → oh → cp → cb → …) if recognisable, else alpha.

4. **Instant preview** — mousedown on a sound name triggers a one-shot
   `superdough()` call (same mechanism as the MIDI bridge) through
   the live audio context. The sound plays for ~500ms or its natural
   decay, whichever is shorter. Visual feedback: the item gets an
   accent-wash highlight for the duration. **No preview on hover** —
   that's annoying when scrolling. Mousedown only.

5. **Insert into editor** — double-click or press Enter on a focused
   sound inserts `s("soundname")` at cursor position (or replaces the
   current selection). If the cursor is inside an `s("...")` call,
   insert just the sound name. Context-aware insertion.

6. **"In use" indicator** — sounds that appear in the current editor
   buffer get a subtle dot or highlight. Requires a lightweight scan
   of the buffer text (not AST — just string matching) on every
   evaluate. This is cheap for ~1000 sound names against a ~2KB
   buffer.

7. **Keyboard navigation** — same pattern as the left rail:
   arrow keys, Enter to preview, Shift+Enter to insert, Escape
   returns focus to editor.

### What's explicitly NOT in scope for Phase 1

- Waveform preview (requires decoding every sample — too heavy).
- Drag-and-drop from sound browser into the editor.
- Importing user samples.
- Sound favoriting / recent sounds.

### Files to create

- `src/ui/sound-browser.js` — the panel component (pure DOM, no
  framework, same style as `left-rail.js`).
- `src/styles/sound-browser.css` — styles for the sound browser.

### Files to modify

- `index.html` — add the right rail structure and tab bar. The right
  rail grid column goes from 0 to its real width.
- `src/styles/shell.css` — right rail layout, tab bar, collapse/expand.
- `src/main.js` — wire up the sound browser: pass it the soundMap
  after prebake, wire preview to superdough, wire insert to editor.

### Acceptance

- Sound browser opens in right rail, shows all registered sounds
  grouped by kit.
- Search filters instantly.
- Category pills filter correctly.
- Mousedown previews the sound audibly.
- Double-click inserts into the editor.
- Sounds used in the current buffer are marked.
- Panel collapses to icon strip and remembers state.
- No new dependencies.

---

## Phase 2: API Reference Panel

An in-editor function reference that's actually _useful_ — not a wall
of 700 functions in alphabetical order, but a searchable, categorized,
example-rich browser that connects to the editor.

### Data source

`strudel-docs.json` (generated by `pnpm gen:docs` /
`scripts/build-strudel-docs.mjs`). Already used by hover docs and
completions. May need to be extended with category tags — check what
fields it currently has vs what we need.

### Layout

```
┌────────────────────────────────┐
│ 🔍 Search                     │
├────────────────────────────────┤
│ [Popular] [Sound] [Pattern]    │
│ [Effects] [Tonal] [Mini] [All] │  ← category pills
├────────────────────────────────┤
│ ▸ note(value)                  │  ← collapsed entry
│ ▾ s(value) ─────────────────── │  ← expanded entry
│   Select a sound by name.      │
│   Params: value : string       │
│   Ex: s("bd sd hh cp")        │
│   [▶ Try] [Insert]            │
│ ▸ stack(…patterns)             │
│ ▸ cat(…patterns)               │
│ …                              │
└────────────────────────────────┘
```

### Features

1. **Search** — fuzzy-ish matching across function name, description,
   synonyms/aliases. Ranked: exact name match > prefix match >
   substring in description. Same debounced input as sound browser.

2. **Category grouping** — leverage the `tags` field from the upstream
   JSDoc (if present in `strudel-docs.json`) or derive from the
   package origin. Curated groups:
   - **Popular**: hand-picked top ~20 functions a beginner reaches for
     first (`note`, `s`, `sound`, `stack`, `cat`, `n`, `gain`, `lpf`,
     `delay`, `room`, `speed`, `pan`, `rev`, `arp`, `chord`, `scale`,
     `voicing`, `setcps`, `setcpm`, `silence`).
   - **Sound**: `s`, `sound`, `bank`, `n`, `gain`, `pan`, `orbit`, …
   - **Pattern**: `stack`, `cat`, `seq`, `fastcat`, `slowcat`,
     `arrange`, `rev`, `fast`, `slow`, `every`, `when`, …
   - **Effects**: `lpf`, `hpf`, `bpf`, `delay`, `room`, `shape`,
     `crush`, `coarse`, `phaser`, `vibrato`, …
   - **Tonal**: `note`, `chord`, `scale`, `voicing`, `transpose`, …
   - **Mini**: mini-notation operators reference (not functions, but a
     separate section explaining `*`, `/`, `<>`, `[]`, `~`, `!`, `@`,
     `?`, `{}`, `,`).
   - **All**: flat alphabetical.

3. **Expandable entries** — click to expand. Shows: signature,
   description, parameters (name + type + doc), examples (syntax-
   highlighted, monospace), synonyms/aliases.

4. **"Try" button** — replaces the editor buffer with a minimal
   example pattern using that function, then evaluates it. Confirms
   via modal if the current buffer has unsaved changes. This is the
   "hear what it does" fast path.

5. **"Insert" button** — inserts the function call template at cursor
   (e.g., `note()` with cursor placed inside the parens). If there's
   a common default argument in the docs, pre-fill it.

6. **Context highlight** — functions that appear in the current editor
   buffer get a subtle accent indicator (same pattern as "in use"
   sounds). Helps answer "what functions am I already using?"

7. **Deep link from hover docs** — when the user sees a hover tooltip
   for a function, there's a small "→ Reference" link at the bottom
   that opens the right rail to that function's expanded entry.

### What's explicitly NOT in scope for Phase 2

- Live examples that evaluate inline in the panel.
- Community-contributed examples.
- Strasbeat-specific extensions in the reference panel (progression()
  etc. should be in a separate "Extensions" section if added later).
- Editing `strudel-docs.json`'s build script — use whatever fields
  exist. If categories don't exist, hardcode the category map in the
  panel code.

### Files to create

- `src/ui/reference-panel.js` — the panel component.
- `src/styles/reference.css` — styles.

### Files to modify

- `index.html` — add Reference tab to the right-rail tab bar.
- `src/main.js` — wire panel, provide docs data, wire "Try"/"Insert"
  actions.
- `src/editor/hover-docs.js` — add "→ Reference" deep link to hover
  tooltips.

### Acceptance

- Reference panel opens in right rail with all functions from
  strudel-docs.json.
- Search filters and ranks results.
- Category pills work.
- Expanding an entry shows full docs.
- "Try" replaces buffer and evaluates.
- "Insert" inserts function template at cursor.
- Hover doc "→ Reference" link opens the panel and scrolls to the
  entry.
- No new dependencies.

---

## Phase 3: Console Panel

A real console that replaces relying on browser devtools. The upstream
REPL has one; ours should be better — structured, filterable, connected
to the pattern engine.

### Features

1. **Log capture** — intercept `console.log`, `console.warn`,
   `console.error` (scoped to Strudel evaluation, not all page
   console calls). Strudel's `logger` callback in the repl config
   is the clean hook — check whether `StrudelMirror` exposes a
   `logger` option. If not, use the `errorLogger` path that already
   exists.

2. **Structured entries** — each log line is an object with:
   `{ level: 'log'|'warn'|'error', message: string, timestamp: number, source?: string }`.
   Rendered in the panel as time-stamped lines with level-appropriate
   color coding (error: red, warn: amber, log: text-mut).

3. **Filter bar** — toggle buttons for log/warn/error levels. Search
   input filters by message content.

4. **Hap inspector** — when a log line contains a serialised hap
   (Strudel errors often include the hap that failed), render it as a
   structured card: value, time span, source location. Clicking the
   source location jumps to that position in the editor.

5. **Clear button** — clears the log.

6. **Auto-scroll** — newest entries at the bottom, auto-scroll unless
   the user has scrolled up (standard terminal behavior).

7. **Evaluation echo** — on every `evaluate`, echo a `---` divider
   with the pattern name and timestamp, so the user can see where one
   evaluation's output ends and the next begins.

8. **strasbeat helpers in-panel** — the output of
   `strasbeat.findSounds()`, `strasbeat.probeRender()`, etc. is
   rendered in this console panel (not just browser devtools).

### Files to create

- `src/ui/console-panel.js`
- `src/styles/console.css`

### Files to modify

- `index.html` — Console tab in right rail.
- `src/main.js` — wire logger, hook evaluation events.

### Acceptance

- Console panel captures Strudel log/warn/error output.
- Level filtering works.
- Search filtering works.
- Auto-scroll behaves correctly.
- Evaluation dividers appear.
- Clear button clears.
- No performance degradation with 1000+ log entries (virtualise if
  needed, but probably not at typical volumes).

---

## Phase 4: Enhanced Export Panel

Move WAV export from a toolbar button into a proper panel with
controls, progress, and feedback.

### Features

1. **Cycle range** — start/end cycle inputs (default: 0 to
   `total cycles in pattern`, which requires counting — if that's not
   feasible, default to 0–8 cycles).

2. **Sample rate** — dropdown: 44100, 48000, 96000 (default 48000).

3. **Filename** — text input, defaults to pattern name.

4. **Progress bar** — real-time progress during offline render. The
   existing export code in main.js already has cycle-counting progress;
   surface it in the panel.

5. **Post-export info** — after export: duration, file size, peak
   amplitude, percent non-zero (from `probeRender`-like stats).
   If peak is very low or zero, show a warning: "This export may be
   silent — check your pattern."

6. **Waveform preview** — render the exported buffer as a simple
   waveform (reuse the Canvas approach from piano roll). This is
   post-export, so it's just drawing the buffer, not real-time.

7. The toolbar WAV button should remain as a quick-export shortcut
   (same as today, uses sensible defaults), but now _also_ opens the
   export panel briefly to show progress.

### Files to create

- `src/ui/export-panel.js`
- `src/styles/export.css`

### Files to modify

- `index.html` — Export tab in right rail.
- `src/main.js` — refactor WAV export to expose progress callback and
  return buffer for the panel to display.

### Acceptance

- Export panel allows configuring cycle range, sample rate, filename.
- Progress bar updates during render.
- Post-export stats and silent-export warning work.
- Waveform preview renders the exported buffer.
- Quick-export toolbar button still works.

---

## Phase 5: Enhanced Settings Panel

Replace the accent-only settings drawer with a proper settings panel
in the right rail. Organized by category, not a flat dump.

### Layout

```
┌────────────────────────────────┐
│ ⚙ Settings                    │
├────────────────────────────────┤
│ APPEARANCE                     │
│   Accent color: [hue] [light] │
│   Font size: [14px ▾]         │
│   Line numbers: [toggle]      │
│                                │
│ EDITOR                         │
│   Bracket matching: [toggle]  │
│   Auto-close brackets: [toggle]│
│   Active line highlight: [on] │
│   Pattern highlight: [toggle] │
│   Line wrapping: [toggle]     │
│   Tab indentation: [toggle]   │
│                                │
│ AUDIO                          │
│   [future: output device]     │
│   [future: max polyphony]     │
│                                │
│ ABOUT                          │
│   strasbeat v0.x               │
│   Strudel v0.x                 │
│   Sounds loaded: 1042          │
│   [links: repo, strudel.cc]   │
└────────────────────────────────┘
```

### Features

1. **Appearance section** — accent color (migrate existing OKLCH
   picker from settings-drawer.js), font size (12–24px, stored in
   localStorage, applied to CodeMirror), line numbers toggle.

2. **Editor section** — toggles for the settings already passed to
   StrudelMirror: bracket matching, auto-close, active line highlight,
   pattern highlight, line wrapping, tab indent. Each toggle updates
   `editor.updateSettings()` and persists to localStorage.

3. **Audio section** — placeholder for future settings (output device
   picker, max polyphony). For now, just show current audio context
   sample rate and state.

4. **About section** — strasbeat version (from package.json if
   available), Strudel version (from @strudel/core), total registered
   sounds count, links to repo and strudel.cc.

5. The top-bar settings button now toggles the right rail open to the
   Settings tab (instead of opening the current popover). The popover
   code in `settings-drawer.js` can be removed or kept as a fallback.

### Files to create

- `src/ui/settings-panel.js`
- `src/styles/settings-panel.css`

### Files to modify

- `index.html` — Settings tab in right rail.
- `src/main.js` — wire settings panel, persist/restore editor settings.
- `src/styles/settings.css` — may be replaced by settings-panel.css.

### Acceptance

- Settings panel in right rail with categorized sections.
- Accent color picker works (migrated from existing drawer).
- Editor toggles update live and persist.
- About section shows version info and sound count.
- Top-bar settings button opens the right-rail settings tab.

---

## Cross-cutting implementation notes

### Right rail architecture

The right rail is a generic **panel host** with a tab bar. Each panel
is a self-contained module that exports:

```js
export function create(container) {
  /* build DOM into container */
}
export function activate() {
  /* called when tab is selected */
}
export function deactivate() {
  /* called when tab is deselected */
}
export function destroy() {
  /* cleanup if needed */
}
```

The rail manager handles tab switching, remembers the active tab in
localStorage, and handles collapse/expand.

A shared module `src/ui/right-rail.js` owns the tab bar, the
collapse/expand behavior, the resize drag handle, and the panel
lifecycle. Individual panels don't know about each other.

### Design system compliance

All panels follow `SYSTEM.md`:

- Surface colors: `--surface-1` for panel background, `--surface-2`
  for cards/entries, `--surface-3` for hover states.
- Text: `--text` for primary, `--text-mut` for secondary,
  `--text-dim` for tertiary.
- Spacing: `--space-*` tokens.
- Radius: `--radius-sm` for pills, `--radius-md` for cards.
- Transitions: `--motion-fast` for hover, `--motion-default` for
  expand/collapse.
- Font: `--font-mono` for code, `--font-sans` for UI text.

### No framework

Same as the rest of strasbeat: pure DOM, no React, no Lit, no Svelte.
Each panel builds its DOM imperatively. This keeps bundle size zero-
overhead and aligns with the existing `left-rail.js`, `transport.js`,
`modal.js` patterns.

### Performance

- Sound browser: the full soundMap is ~1000–1500 entries. Flat DOM is
  fine — no need for virtualisation. But _do_ use a document fragment
  for the initial build.
- Reference panel: ~700 function entries. Same — flat DOM is fine
  when most are collapsed (only showing the name line). The expanded
  view is one entry at a time.
- Console panel: ring buffer of ~500 entries max. Oldest entries
  evicted. No virtualisation needed.

### Keyboard

The right rail should be fully keyboard-navigable:

- `Ctrl/Cmd+B` (or another binding) toggles the right rail.
- Tab key within the panel cycles through interactive elements.
- Escape from within a panel returns focus to the editor.
- Inside the sound browser / reference, arrow keys navigate the list.

---

## What this spec explicitly does NOT cover

- **Themes** — the upstream REPL has 40+ editor themes. strasbeat has
  the design system. Adding theme selection is a separate effort that
  touches the CodeMirror theme layer, not the panel system.
- **Multiple keybinding modes** (Vim, Emacs) — separate effort.
- **Pattern sharing / social features** — strasbeat is a local tool.
- **Sound import** — loading user samples from disk is a separate spec.
- **Hydra / CSound / OSC / gamepad / serial** — out of scope for
  strasbeat's current vision.
- **Mobile / responsive** — strasbeat is a desktop-first tool.
- **Left rail changes** — the left rail stays as-is.

---

## Order of operations

1. **Right rail infrastructure** + **Sound Browser** (Phase 1) — this
   is the highest-value panel and also forces building the rail system.
   Ship these together.
2. **API Reference** (Phase 2) — second-highest value for exploration.
3. **Console** (Phase 3) — important for debugging, but composers can
   use browser devtools as a stopgap.
4. **Export Panel** (Phase 4) — enhances an existing feature.
5. **Settings Panel** (Phase 5) — enhances an existing feature.

Each phase is independently shippable. An agent can pick up any phase
after Phase 1 is landed (Phase 1 builds the rail infrastructure that
all others depend on).
