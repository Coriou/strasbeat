# 26 — Pattern tabs

> Read `../README.md`, `../SYSTEM.md`, `../../CLAUDE.md`,
> `09-pattern-persistence.md`, `24-pattern-folders.md`, and `06-future.md`
> before starting. This spec extends specs 09 and 24 — autosave, working
> copies, the dirty model, folders, and the open-or-operate-on-the-current-
> pattern discipline are all assumed to be in place. Date: 2026-06-03.
> Phases are ordered; each one ships on its own.

## Where this came from

Switching patterns today is a hard cut. `onSelect` (`src/main.js`) flushes
the buffer to the store, clears errors, then calls `editor.setCode(code)`.
`setCode` is `replaceCode(0, doc.length)` — one transaction that replaces
the whole document. The cost of that single transaction is the entire
pain we're fixing:

- **Cursor and scroll are lost.** You jump back into a pattern and the
  caret is at the top, the viewport reset. The mental "where was I" is
  gone every time.
- **Undo is shared and surprising.** The doc-replace lands as one giant
  step in a single, shared undo stack. Hit Cmd+Z after switching and you
  don't undo your last edit — you undo the entire pattern swap, dumping
  the *other* pattern's text into the *current* buffer. This is a genuine
  data-loss footgun, not just an annoyance.
- **There is no "working set."** The left rail is the whole library —
  "everything that exists." There's no lightweight surface for "the three
  patterns I'm bouncing between right now." Every switch is a full library
  lookup, mentally and visually.

A daily-driver IDE solves all three with tabs: a strip of what's open,
each tab remembering its own cursor, scroll, and undo history, switchable
in one click with zero cost. strasbeat should feel the same — and faster,
because there is nothing to reload. One editor, one document buffer
swapped under it.

## Goal

A full-editor-width **tab strip** sits directly above the editor canvas.
It shows the patterns the user currently has open — the working set —
distinct from the left-rail library, which remains "everything that
exists." Switching tabs is instant and lossless: each tab restores its own
cursor, scroll, undo history, and dirty state. Audio is never cut by a
switch — the single scheduler keeps playing whatever was started, and a
"now playing" affordance keeps the user oriented to which tab owns the
sound. Opening, closing, and reordering tabs feel like first-class IDE
gestures, and every existing pattern operation (create, duplicate, delete,
rename, revert, MIDI import, MIDI capture) reconciles cleanly with the open
set.

This is built so that spec 06's eventual "open track" slots into the same
data model and vocabulary with no refactor — but **only the abstraction is
reserved**, not any visible track affordance.

## Design principles

1. **Tabs are a view, not a store.** Tabs are a presentation over the
   existing persistence layer from spec 09. The working copy, the dirty
   model (`computeDirtySet`), and the localStorage records are unchanged.
   There is no second code store and no second dirtiness model. A tab is a
   reference to a pattern name plus some runtime view state — nothing more.

2. **One editor, one scheduler — always.** strasbeat has exactly one
   `StrudelMirror`, one `repl`, one `repl.scheduler`. `editor.evaluate()`
   always plays `editor.code` (the live buffer). Tabs swap the document
   buffer and per-tab editor state under that single view. We do **not**
   create N editor instances — that would multiply the repl, scheduler,
   drawer, and extension chain and fight the single-scheduler audio model.

3. **The library is "what exists"; tabs are "what's open."** The left rail
   stays the sole owner of create / duplicate / delete / rename / move /
   folders / the modified dot. Clicking a rail item **opens-or-focuses**
   its tab. The rail's current-pattern highlight, the open set's active
   tab, and the top-bar wordmark always agree.

4. **Switching never cuts audio. Closing never cuts audio.** The transport,
   Play/Stop, and Cmd+Enter always target the **focused** tab. Pressing
   Play re-evaluates the focused buffer and transfers playback ownership to
   that tab. But merely switching focus — or even closing the tab that owns
   the sound — does not stop the scheduler. Stopping audio is always an
   explicit gesture (Stop, or playing something else), never a side effect
   of navigation. A "now playing" affordance names the owner and offers a
   one-click jump.

5. **Reconcile, don't orphan.** Any rail operation on a pattern that is
   open in a tab reconciles the open set: delete closes the tab, rename
   re-keys it, revert keeps it open with reverted code. This mirrors spec
   24's "operate on the currently-open pattern" discipline.

6. **Forward-compat is vocabulary, not chrome.** The open-set abstraction
   is named and shaped so "open pattern" can become "open track" later
   (spec 06). We reserve the seam in the data model and naming — and render
   **zero** speculative track UI. No per-tab mute/solo, no inert controls.

7. **Surface silent failures.** Per CLAUDE.md, anywhere we swap editor
   state we must not silently drop runtime configuration (keymap profile,
   font, appended listeners). If a swap can't preserve them, it warns
   loudly rather than degrading quietly.

## Concepts

| Term            | Meaning                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Open set**    | The ordered list of patterns the user currently has open. Persisted by name in `uiState.openTabs`. The model-level name is deliberately generic (see Data model).   |
| **Tab**         | The UI element for one entry in the open set. Renders the pattern name, a dirty dot (Demos only), and a close affordance.                                            |
| **Focused tab** | The one active tab. Its buffer is the live `editor.code`. Persisted as `uiState.activeTab`. The wordmark and rail highlight reflect it.                              |
| **Playing tab** | The pattern that currently owns scheduler audio — the one whose buffer was last evaluated via Play/Cmd+Enter. May differ from the focused tab. Runtime-only.         |
| **Now-playing chip** | A transport affordance naming the playing tab. When playing ≠ focused, it offers one-click "jump to playing." Sibling in spirit to the existing bank chip.      |
| **Tab view state** | Per-tab cursor, scroll, selection, and undo history. Held in a runtime `EditorState` instance per open tab. **Not persisted** — cross-session undo is out of scope. |
| **Orphaned playback** | The state after the playing tab is closed while still sounding: audio continues, the chip shows the closed pattern's name with a "(closed)" marker.            |

## Data model

### Persisted state — `uiState`

Spec 09 / 24 already established `index.uiState` as a free-form object for
UI state (`collapsedFolders`, `lastNewPatternFolder`). Tabs add two fields:

```ts
interface StoreIndex {
  lastOpen: string | null;        // unchanged (spec 09)
  userPatterns: string[];         // unchanged
  folders?: string[];             // spec 24
  uiState?: {
    collapsedFolders?: string[];      // spec 24
    lastNewPatternFolder?: string | null; // spec 24
    openTabs?: string[];          // NEW — ordered open set, by pattern name
    activeTab?: string | null;    // NEW — the focused tab's pattern name
  };
}
```

- **`openTabs`** is the working set and the tab order — an ordered array of
  pattern names. No IDs: name is identity throughout spec 09/24, and tabs
  inherit that. Rename re-keys the entry in place (see Reconciliation).
- **`activeTab`** is the focused tab. It is kept in sync with `lastOpen`
  (which spec 09 already writes on switch); `activeTab` is the
  tab-aware spelling and the authoritative source for restoring focus on
  reload. If the two ever disagree on boot (e.g. an older build wrote only
  `lastOpen`), `lastOpen` wins as the focus and is added to `openTabs`.
- **No per-tab view state is persisted.** Cursor / scroll / undo live only
  in runtime `EditorState` instances. On reload, tabs reopen from
  `openTabs` with fresh state seeded from each pattern's working copy.
  (Cross-session undo is explicitly out of scope per spec 09.)

**Migration:** an existing user boots with no `openTabs`. Seed it from
`[lastOpen]` (or empty if none), set `activeTab = lastOpen`. They land with
exactly one tab open — their last pattern — and accrue more as they work.

### Runtime state — the open-set controller

A new module owns the open set and the per-tab editor state. Working name:
`src/ui/tab-strip.js` for the UI, with the open-set logic either alongside
it or in a small sibling (`src/tabs.js`) if `main.js` wiring reads cleaner
that way — the implementer picks based on how the switch path factors. It
holds:

```ts
// Generic on purpose — see "Forward-compat seam".
openItems: string[]              // mirror of uiState.openTabs (names)
activeItem: string | null        // mirror of uiState.activeTab
stateCache: Map<string, EditorState>  // name → its live EditorState
playingItem: string | null       // runtime only; null when stopped/idle
orphanedPlaying: string | null    // set when the playing tab is closed
```

`stateCache` is the heart of lossless switching: each open tab's full
`EditorState` (doc + selection + scroll + undo history) is cached by name.
Switching is "cache the outgoing state, install the incoming one."

### Forward-compat seam (vocabulary only)

The open-set abstraction is modeled as an array of opaque **item
identifiers** (today: pattern names) with generic internal naming
(`openItems` / `activeItem` / "open an item" / "focus an item"), so spec
06's "open a track" maps onto the exact same structure. The persisted keys
stay `openTabs` / `activeTab` (concrete and readable in localStorage; a
future build can widen them without a migration headache).

**We render no track UI.** No per-tab mute/solo, no instrument badge, no
routing control, nothing inert. The seam is the data shape and the verbs —
not pixels. Per principle 6 and CLAUDE.md's "defer features the user didn't
ask for."

## The EditorState swap (the load-bearing mechanism)

This is the one genuinely risky part of the design. It must be specified
precisely and verified, because getting it wrong degrades silently.

### Why per-tab undo requires per-tab `EditorState`

The undo history is a CodeMirror `StateField` contributed by `history()`,
which lives inside `basicSetup` (`strudel-source/.../basicSetup.mjs:29`) —
i.e. it is part of the editor's per-`EditorState` configuration. There is
no way to give each tab an independent undo stack while sharing one
`EditorState`: mutating a single persistent state with transactions just
appends to its one shared history (that is exactly today's bug). Therefore
**each open tab must own a distinct `EditorState` instance**, and switching
tabs is a full state swap on the one `EditorView` via `view.setState(...)`.

This also delivers per-tab cursor, scroll, and selection for free — they
are all part of the swapped state.

### The hard constraint: a swapped-in state must carry the CURRENT LIVE configuration

`view.setState(newState)` replaces the editor's **entire** configuration,
not just the document. strasbeat layers configuration onto the live editor
in several places *after* StrudelMirror builds its initial state:

1. **StrudelMirror's own initial config** (`codemirror.mjs:86`): `basicSetup`
   (incl. `history()`), the JS language, slider/widget plugins, syntax
   highlighting, the `onChange` updateListener that writes `this.code` +
   `repl.setCode`, `drawSelection`, the eval/stop keymap, and the settings
   **compartments** (`codemirror.mjs:52`).
2. **`dispatchEditorExtensions`** (`src/editor-setup.js`): error marks,
   the Prettier formatter, the universal keymap, the **`strasbeatOverlay`
   compartment** (the active keymap profile), the numeric scrubber, hover
   docs, the signature hint — all via `StateEffect.appendConfig`.
3. **Two appended `updateListener`s in `main.js`** (≈ lines 866 and 881):
   the **autosave** listener (`scheduleAutosave` on doc change) and the
   **bank-detect** listener (updates the transport bank chip).
4. **`installCompletions`** (the autocomplete sources) and any
   arrange/eval-feedback wiring attached to the view.

A naive fresh `EditorState.create({ doc, extensions: STATIC_ARRAY })` for a
tab drops every one of these that isn't in the static array, and — worse —
**resets the live compartment values to their build-time defaults**:

- The **`strasbeatOverlay` compartment** holds the user's current keymap
  profile and is reconfigured at runtime by `reconfigureOverlay`
  (`editor-setup.js`) when they change profiles. A fresh state built from
  the static initial value silently reverts the keymap profile — and a
  later `reconfigureOverlay` dispatch targets a compartment instance the
  new state may not even contain. Silent breakage on two axes.
- The **settings compartments** (`codemirror.mjs:52`) hold theme, line
  wrapping, line numbers, bracket matching, autocomplete-enabled, etc.,
  reconfigured by `updateSettings` / `reconfigureExtension`. Same hazard.

(Font size/family are **not** a hazard: `setFontSize`/`setFontFamily`,
`codemirror.mjs:378`, set `this.root.style` on the shared DOM root directly,
not via a compartment — so a state swap never touches font. Verify this
holds; do not rely on it for the compartments above.)

So the HARD CONSTRAINT, which the acceptance test gates:

> **A swapped-in tab's `EditorState` must carry the CURRENT LIVE
> configuration — every appended extension AND every compartment's current
> runtime value — never static build-time defaults.**

### Chosen approach: full `setState` seeded from the live config

Two approaches were weighed:

- **(A) Full `setState`, config rebuilt with live values injected.** Build
  each tab's state from the complete extension set, reading the current
  value of every runtime-mutated compartment from the *outgoing* live state
  and seeding it into the new state's config.
- **(B) Lighter restore — swap only doc + selection + scroll WITHOUT a full
  reconfigure**, leaving the single state's config (and thus all
  compartments) untouched.

**(B) cannot satisfy the per-tab-undo requirement.** As established above,
undo history is a `StateField` bound to a specific `EditorState`; you
cannot restore a *separate* undo stack by dispatching transactions into one
persistent state — you only ever extend its single shared history. (B)
would re-introduce exactly the cross-pattern-undo footgun this spec exists
to kill. So (B) is rejected for the undo requirement.

**We choose (A), with a disciplined config-construction rule** so it isn't
fragile:

1. **One source of config truth.** The full extension set (StrudelMirror's
   initial extensions + everything strasbeat appends in editor-setup.js and
   main.js + completions) is assembled by a single factory the implementer
   defines, so "what a complete editor state contains" lives in exactly one
   place. Both the initial editor construction and every per-tab state are
   built through it. There is no second, drifting copy of the extension
   list.
2. **Live compartment values are injected, never defaulted.** The factory
   takes the set of current compartment values and seeds each compartment's
   `.of(...)` with the live value. At swap time these are read from the
   outgoing state with `Compartment.get(state)` (CM6 `@codemirror/state`,
   verified present). The compartments covered are at minimum:
   StrudelMirror's settings compartments (`codemirror.mjs` `compartments`)
   and the `strasbeatOverlay` compartment (`editor-setup.js`). If a future
   feature adds a runtime-mutated compartment, it must be added here — and
   the acceptance test below is the tripwire that catches an omission.
3. **Appended listeners are part of the factory.** The autosave listener,
   the bank-detect listener, error marks, formatter, keymaps, scrubber,
   hover docs, signature hint, and completions are included in the factory
   output (not re-appended after the swap). They are referentially stable
   module-level functions, so reusing them across states is safe.

The implementer must verify against `codemirror.mjs` whether the swap is
cleanest as `view.setState(factory(doc, selection, liveCompartments))`
followed by re-establishing scroll, or whether StrudelMirror exposes a hook
that must be respected. Whatever the exact call, it must leave the live
configuration intact and the appended listeners firing. **Do not touch
`StrudelMirror` internals or any off-limits Strudel plumbing** (SYSTEM.md
§11) — the swap is implemented in strasbeat's editor wiring, which is fair
game.

### After the swap, keep the buffer consistent

`editor.evaluate()` plays `editor.code`, and the `onChange` listener keeps
`editor.code` + `repl.setCode` in sync on every doc change. After a state
swap the new document is in place, so `editor.code` must equal the new
buffer and `repl.setCode` must reflect it before any evaluate. The
implementer confirms `onChange` fires from the swap (it should, as the doc
content differs); if `setState` does not run the change pipeline, set
`editor.code` and call `repl.setCode` explicitly as part of the swap.

## Switch flow

Tab switching keeps spec 09's existing flush-then-load discipline and adds
the open-set + state-swap on top. On focusing tab `B` while tab `A` is
focused:

1. **`flushToStore()`** — immediate, cancels the pending autosave debounce
   (`src/patterns.js` `createAutosave`). Unchanged from today.
2. **Cache the outgoing state.** `stateCache.set(A, view.state)` — preserves
   A's undo history, cursor, scroll, selection.
3. **`clearError(editor.editor)` + `evalFeedback.resetRuntimeErrors()`** —
   error/console state is global and keyed to the live buffer, not per-tab
   (see Non-goals). Unchanged from today.
4. **Install B's state.** If `stateCache` has B, swap it in (full config
   rebuilt with live compartment values per the mechanism above). If not
   (first open this session), build a fresh state seeded from B's working
   copy via the same factory.
5. **Sync the buffer.** Ensure `editor.code` and `repl.setCode` reflect B's
   document (per "keep the buffer consistent").
6. **`setCurrentName(B)`** — updates the top-bar wordmark and the left-rail
   highlight. Unchanged helper.
7. **Persist focus.** Set `uiState.activeTab = B` and `lastOpen = B`; write
   the index.
8. Status line: optional, quieter than today's `Loaded "X"` (a switch is no
   longer a load). Final copy deferred to /clarify + /polish.

The existing `onSelect` in `main.js` is **replaced** by this flow (no
back-compat shim — personal tool, per CLAUDE.md). `onSelect` becomes
"open-or-focus the item," which is also what the rail, create, duplicate,
import, and capture paths call.

## Playing vs. focused: ownership and the now-playing chip

This implements the user-confirmed **hybrid** model.

- **One owner at a time.** There is one scheduler; at most one pattern owns
  its audio. No simultaneous multi-pattern playback.
- **`playingItem`** is set to the focused tab's name whenever the user
  evaluates (Play button, Cmd/Ctrl+Enter, `repl-evaluate`). It is cleared
  to `null` on Stop / scheduler idle. This rides on the existing single
  eval pipeline (`playbackRequestId` in `src/eval-feedback.js`) and the
  transport's `playbackState` (`src/ui/transport.js`) — we read those, we
  do not add a parallel playback tracker.
- **Transport targets the focused tab, always.** Play re-evaluates the live
  (focused) buffer and transfers ownership: `playingItem = activeItem`.
  Stop stops the scheduler and clears `playingItem`.
- **Now-playing chip.** A transport affordance — sibling in spirit to the
  existing bank chip (`transport.setBank`) — names `playingItem`. Behavior:
  - When `playingItem === activeItem` (or nothing is playing): the chip is
    quiet / absent. The common case shows no extra chrome.
  - When `playingItem !== activeItem`: the chip is visible, names the
    playing pattern, and is a **one-click jump** that focuses the playing
    tab. This is the "where is that sound coming from" answer.
  - The chip indicates the playing tab in the tab strip too (a subtle
    per-tab "playing" marker on the owning tab), so the strip itself
    answers the question. Exact visual treatment deferred to /impeccable.

### Closing the playing tab while it is still sounding (orphaned playback)

The user-confirmed behavior. Closing a tab is a stronger gesture than
switching, but it still must not silently kill audio (principle 4):

- **Audio continues.** The scheduler is untouched — one scheduler,
  public-API only, surface-don't-degrade.
- **Ownership detaches into `orphanedPlaying`.** `playingItem` becomes
  `null` for tab purposes (the tab is gone), and `orphanedPlaying` holds
  the closed pattern's name.
- **The chip stays visible**, naming the closed pattern with a subtle
  **"(closed)"** marker so the state is legible rather than mysterious.
- **"Jump to playing" reopens the tab.** Clicking the chip re-adds the
  pattern to `openTabs`, focuses it (fresh state seeded from its working
  copy), and clears `orphanedPlaying` back into normal `playingItem`. The
  user never dead-ends.
- **Stop, or playing a different tab, clears the orphan.** `orphanedPlaying`
  resets to `null`; the chip returns to its quiet state.

Rejected alternatives, recorded so they aren't relitigated:
**stop-on-close** (contradicts "switching/closing never cuts audio" and
makes close destructive) and a **confirm-modal on close-while-playing**
(adds a speed bump that fights the "absolute smoothest UX" brief).

## Reconciliation with rail operations

The open set must reconcile with every pattern operation the rail owns
(spec 24). This mirrors spec 24's "operate on the currently-open pattern"
discipline.

- **Open / focus (rail click, or any path that opens a pattern).** If the
  pattern is already open, focus its tab. If not, append it to `openTabs`
  and focus it. New-pattern, duplicate, MIDI-import, and MIDI-capture —
  which already call `setCurrentName` + `setCode` today — route through
  this same open-or-focus path. No special-casing per source.
- **Delete an open pattern.** Close its tab: remove from `openTabs`, evict
  its `stateCache` entry. If it was the focused tab, focus the neighbor
  (the tab to its right; else the left; else the empty state). If it was
  the playing tab, apply the orphaned-playback rule (audio continues;
  chip shows "(closed)"; the deleted name is still in `orphanedPlaying`
  even though it can no longer be reopened — Stop clears it).
- **Rename an open pattern.** Re-key in place: replace the name in
  `openTabs`, re-key its `stateCache` entry, preserve tab order, focus, and
  undo history. If it was `activeTab` or `playingItem`/`orphanedPlaying`,
  update those to the new name. The tab visibly relabels; nothing reloads.
- **Revert an open pattern (Demo working copy → shipped original).** Keep
  the tab open and focused as-is. Replace its buffer with the reverted
  code. Because the document identity changes wholesale, build a **fresh
  `EditorState`** for that tab (seeded from the reverted code) rather than
  splicing — and clear its dirty dot. (Reverting resets the working copy to
  the shipped original; a fresh state with empty undo is the honest result.)
- **Move between folders (spec 24).** No effect on the open set — folder is
  organization, not identity (spec 24 principle 1). The tab is unchanged.

## Tab strip UI

The strip lives directly above the editor canvas, full editor width, per
SYSTEM.md §3's layout grammar. There is existing tab-bar grammar to match:
the right-rail tab bar (spec 08) and the bottom-panel mode bar (spec 14).
Honor SYSTEM.md tokens (greyscale + one accent, `--space-*`, `--radius-*`,
two elevation levels) and the motion grammar (200ms panel
cubic-bezier(0.16,1,0.3,1), 120ms hover ease-out, no spring physics, no
ambient idle animation).

This spec fixes **functional behavior only**. All concrete visual and
motion craft is deferred (see "Deferred to craft skills").

Behavior the implementer must deliver:

- **Each tab shows** the pattern name, a **dirty dot for Demos only**
  (reusing `computeDirtySet`; user patterns have no shipped original to
  diff, matching the rail — no dot), and a **close affordance revealed on
  hover** (a hover-revealed close control on each tab; the focused tab may
  show it persistently). Exact reveal treatment deferred to craft.
- **The focused tab is emphasized** relative to the rest. Treatment
  deferred to craft; the requirement is that focus is unambiguous at a
  glance.
- **The playing tab carries a subtle "playing" marker** (see the
  now-playing section). Treatment deferred to craft.
- **Click a tab** → focus it (the switch flow above). **Click its close
  affordance** → close it (reconciliation: drop from `openTabs`, evict
  state; if focused, focus the neighbor; if playing, orphan).
- **Reorder by drag.** Tabs can be dragged to reorder within the strip,
  updating `openTabs` order. (Spec 24 already establishes drag-and-drop
  grammar in the rail; match its feel.) Keyboard reorder is a stretch item.
- **Overflow when many tabs are open.** The strip must degrade gracefully
  past the point where tabs fit the editor width. The *mechanism* (scroll
  the strip, or an overflow menu, or shrink-to-fit with a minimum) is a
  craft decision deferred to /impeccable + /polish; the *requirement* is
  that no tab becomes unreachable and the focused tab is always visible
  (auto-scroll the focused tab into view on switch).
- **Empty state.** When `openTabs` is empty (e.g. the user closed the last
  tab), the editor shows a quiet empty state and the transport reflects
  nothing focused. Opening any pattern from the rail restores a tab.
  (Whether closing the very last tab is even allowed, vs. always keeping
  one open, is an open question below.)
- **Keyboard.** At minimum, the command palette (`Cmd+Shift+P`) gains
  open-set actions (next/previous tab, close tab). Dedicated chord
  bindings are deferred to the keybindings system (specs 21/23) rather than
  hard-coded here, to avoid colliding with the override model.

No native dropdowns / `<select>` / `window.prompt` anywhere in this UI —
use the in-app `modal.js` family if a prompt is ever needed (SYSTEM.md).

## Files touched

- **`src/main.js`** — replace `onSelect`'s switch body with the open-or-
  focus + state-swap flow; wire the tab strip; route create / duplicate /
  import / capture through open-or-focus; set `playingItem` on evaluate.
  The two appended `updateListener`s (autosave, bank-detect) move into the
  single config factory so they survive state swaps.
- **`src/editor-setup.js`** — `dispatchEditorExtensions` /
  `reconfigureOverlay` participate in the config factory so the
  `strasbeatOverlay` compartment's live value is carried across swaps.
- **`src/ui/tab-strip.js`** (NEW) — the tab strip component and the
  open-set controller (or a sibling `src/tabs.js` if the switch wiring
  reads cleaner split out).
- **`src/store.js`** — no interface change; `openTabs` / `activeTab` are
  written under the existing `uiState` object via `getIndex`/`setIndex`.
- **`src/ui/transport.js`** — the now-playing chip (sibling to the existing
  bank chip); read `playbackState` to clear `playingItem` on idle.
- **`src/ui/left-rail.js`** — rail click calls open-or-focus; the rail's
  current-highlight stays driven by `setCurrentName`.
- **`index.html` / `src/styles/`** — the tab strip's slot above the editor
  and its tokens-based styling (visual treatment via craft skills).

### Files NOT touched (off-limits — SYSTEM.md §11)

`@strudel/*` imports, `prebake`/audio init, `renderPatternToBuffer` / WAV
export, `MidiBridge` setup + capture handler, `import.meta.glob` of
`/patterns`, share-link encode/decode internals, `window.strasbeat` /
`window.editor` / `window.midi` exports, `vite.config.js` middleware, and
anything in `strudel-source/` (including `codemirror.mjs` and
`basicSetup.mjs` — we read them to understand the swap, we do not modify
them). If the implementation appears to require editing any of these, STOP:
the scope is wrong, not the rule.

## Out of scope

- **Multiple simultaneous playback.** One scheduler, one owner. Not now.
- **Per-tab error / console state.** Errors and the console are global and
  keyed to the live buffer (`src/eval-feedback.js`). We do not persist or
  restore per-tab error marks. The console panel stays global.
- **Cross-session undo.** Tab undo history is runtime-only and resets on
  reload (consistent with spec 09's stance). We do not serialize the
  `historyField`.
- **Any track UI.** Per-tab mute/solo, instrument badges, routing — the
  tracks horizon (spec 06) is reserved as vocabulary only. No inert chrome.
- **A second code store or a second dirtiness model.** Reuse the spec 09
  store and `computeDirtySet`.
- **Final visual + motion design.** See below.

## Deferred to craft skills

Per the user's documented preference (specs describe functional UX; visual
choices belong to the polish skills), this spec deliberately does **not**
pick hexes, easings, pixel heights, tab widths, the overflow mechanism's
look, hover-reveal treatments, or the now-playing chip's exact form. The
brief asks for an interface "crafted with impeccable" — that names the
visual-quality gate:

1. **/impeccable (`craft`)** — the primary visual-quality gate. Shape the
   tab strip, the focused/playing emphasis, the close affordance, the
   overflow handling, and the now-playing chip against the project's design
   context. This is where the "state of the art, refined & polished" bar is
   met.
2. **/polish** — final alignment, spacing, consistency, micro-detail pass
   before shipping.
3. **/animate** — purposeful motion for tab switch, open, close, reorder,
   and the chip's appearance, within SYSTEM.md's motion grammar (no spring
   physics, motion explains change).

Optionally /clarify for the (quieter) status-line and chip microcopy.

## Acceptance

### Core (must ship together)

1. **Lossless switch.** Open two patterns. Scroll and place the cursor mid-
   document in A. Switch to B, then back to A: A's cursor, scroll, and
   selection are exactly where they were.
2. **Per-tab undo, no cross-bleed.** Edit A. Switch to B. Press Cmd/Ctrl+Z:
   it does nothing to A's text and does not dump A's content into B. Switch
   back to A; Cmd+Z undoes A's last edit. (This is the bug from "Where this
   came from," proven fixed.)
3. **Config survives the swap — the tripwire.** Change the keymap profile
   (e.g. to the VSCode overlay) **and** change the font size/family in
   settings. Open a second tab and switch to it: **both the keymap profile
   and the font persist** — neither reverts to defaults. Then verify on the
   swapped-in tab that autosave still fires (edit → working copy updates),
   the bank-detect chip still updates (`.bank("...")` → chip changes),
   autocomplete still triggers, and a subsequent `reconfigureOverlay`
   (change profile again) still takes effect. This single test gates the
   whole swap mechanism.
4. **Audio is never cut by navigation.** Play A. Switch to B: A keeps
   sounding. The now-playing chip shows A and offers a jump; clicking it
   focuses A. Press Play on B: ownership transfers, B sounds, A stops.
5. **Transport targets the focused tab.** With A playing and B focused,
   Cmd/Ctrl+Enter evaluates B (not A) and transfers ownership to B.
6. **Close-while-playing orphan.** Play A, then close A's tab: audio
   continues, the chip shows A with "(closed)," and clicking the chip
   reopens A's tab. Stop clears the chip.
7. **Reconciliation.** With a pattern open in a tab: deleting it closes the
   tab and focuses a neighbor; renaming it relabels the tab in place
   (order, focus, and undo preserved); reverting a Demo keeps the tab open
   with reverted code and a cleared dirty dot.
8. **Open-or-focus everywhere.** Clicking a rail item, creating, duplicating,
   importing a MIDI file, and saving a capture each open-or-focus a tab for
   the target pattern — never a hard `setCode` cut.
9. **Persistence + migration.** Open three patterns, focus the middle one,
   reload: the same three tabs reopen in order with the middle one focused.
   A user with only legacy `lastOpen` boots with exactly that one tab open.
10. **Dirty dot parity.** A modified Demo shows a dirty dot on its tab; a
    modified user pattern does not (matching the rail).

### Stretch (can land later)

- Keyboard reorder of tabs; dedicated next/prev/close chords via the
  keybindings override system (specs 21/23).
- "Close others" / "close to the right" context-menu actions on a tab.
- Middle-click to close.

## Open questions

1. **Closing the last tab.** Is an empty open set allowed (quiet editor
   empty state), or do we always keep at least one tab open (closing the
   last tab is a no-op, or it falls back to `lastOpen`)? Lean: allow empty
   with a clean empty state — it's the honest IDE behavior and the rail is
   one click away. Confirm during craft.
2. **Tab strip vs. transport placement of the now-playing chip.** The chip
   could live in the transport bar (next to the bank chip) or anchored to
   the tab strip. Lean: transport bar for the chip text + jump, plus a
   subtle per-tab marker in the strip. Resolve during /impeccable.
