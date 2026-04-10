# 11 — UI Hardening (v2)

> Read `../README.md`, `../SYSTEM.md`, and `../../CLAUDE.md` before
> starting. Then read this whole file. This is a **bug-fix + robustness
> pass** — no new features, no new panels, no visual redesign. Every
> behavior the user can observe must work _better or identically_ after
> this lands. The user should never notice a visual regression; they
> should notice that things that were subtly broken now work.

## Where this came from

Full code audit of every UI module, CSS layout file, and event-wiring
path in strasbeat. A first pass (currently staged) addressed the most
obvious issues: ResizeObserver on the canvas, roll toggle debouncing +
persistence, transport rAF race fix, `Cmd+L` → selectLine keybinding,
canvas ARIA attributes, and document-level pointer listeners on the roll
divider drag.

This v2 spec covers **everything the first pass missed** — every
verified bug and robustness gap found in the full audit, grouped into
phases so an agent can land and smoke-test each one independently.

## What the first pass already landed (staged, not yet committed)

For context — don't re-implement these:

1. **Canvas ResizeObserver + fresh DPR** (`src/main.js`): replaced
   `window.addEventListener("resize", resizeCanvas)` + stale `const dpr`
   with a `ResizeObserver` on the canvas that reads `devicePixelRatio`
   fresh every call.
2. **Roll toggle debounce + persistence** (`src/piano-roll-resize.js`):
   200ms debounce on toggleRoll, `localStorage` read/write of collapsed
   state, apply persisted state on mount.
3. **Roll divider drag: document-level listeners**
   (`src/piano-roll-resize.js`): added `pointerup` + `pointercancel` on
   `document` during drag, removed on end.
4. **Transport rAF race** (`src/ui/transport.js`): `raf` is no longer
   nulled at the top of `tick()`, preventing the poll from spawning a
   second rAF chain.
5. **`Cmd+L` → selectLine** (`src/editor/keymap.js`): added
   `{ key: "Mod-l", run: selectLine, preventDefault: true }`.
6. **Canvas accessibility** (`index.html`): `role="img"` and
   `aria-label` on `<canvas id="roll">`.

## Principles

1. **Fix, don't redesign.** Keep every existing API contract. The
   modules' public surfaces (`renderRoll`, `mountTransport`,
   `mountRightRail`, `mountPianoRollResize`, etc.) keep their current
   signatures unless a new parameter is strictly needed.
2. **Minimal diffs.** Fix exactly the bug. Don't add JSDoc, types,
   refactors, or "while I'm here" cleanups.
3. **Build must pass.** `pnpm build` with zero new warnings after each
   phase.
4. **Smoke-test after each phase.** The acceptance criteria at the end
   of every phase section must be manually verified.

---

## Phase 1 — Right-rail resize: document-level pointer listeners

**Problem:** `src/ui/right-rail.js` lines 82–122. The right-rail resize
handle registers `pointerup` and `pointercancel` only on the handle
element itself. If pointer capture is lost during a fast drag (escaping
the element, touch disambiguation), `dragStartX` stays non-null and the
next `pointermove` over the handle resumes a phantom drag. The cursor
also stays stuck on `ew-resize`. This is the same class of bug the first
pass fixed on the roll divider.

**Fix:**

In the `pointerdown` handler, add `pointerup` + `pointercancel` on
`document`. In `endDrag`, remove them. Same one-shot pattern as
`piano-roll-resize.js`.

```js
// In the pointerdown handler, after setPointerCapture:
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

// In endDrag, add:
document.removeEventListener("pointerup", endDrag);
document.removeEventListener("pointercancel", endDrag);
```

**Files touched:** `src/ui/right-rail.js` (≤4 lines added).

**Acceptance:**

- Start dragging the right-rail resize handle, move the pointer far
  outside the window, release → drag ends cleanly, cursor resets.
- `getEventListeners(document)` after multiple drags doesn't accumulate
  stale listeners.

---

## Phase 2 — Right-rail panel create() error resilience

**Problem:** `src/ui/right-rail.js` line 282–289. `doActivate()` wraps
`panel.create(panel.slot)` in try/catch, but sets `panel.mounted = true`
**unconditionally after** the try/catch. If `create()` throws, the panel
is marked mounted and will never be re-created — permanently broken, no
recovery without hard reload.

**Fix:**

Move `panel.mounted = true` **inside** the try block, after
`create()` succeeds. If `create()` throws, the next activate call
retries.

```js
if (!panel.mounted) {
  panel.slot = document.createElement("div");
  panel.slot.className = "right-rail__panel-slot";
  panel.slot.dataset.panelId = id;
  panelContainer.appendChild(panel.slot);
  try {
    panel.create(panel.slot);
    panel.mounted = true;
  } catch (err) {
    console.error(`[right-rail] panel "${id}" create() failed:`, err);
    // Don't set mounted — next activate retries create().
  }
}
```

**Files touched:** `src/ui/right-rail.js` (≤3 lines changed).

**Acceptance:**

- Temporarily make a panel's `create()` throw. Click its tab → error
  logged. Click "sounds" tab, then click the broken tab again → `create()`
  is retried (not permanently stuck).
- Normal panels still mount and activate correctly.

---

## Phase 3 — Left-rail context menu listener hygiene

**Problem:** `src/ui/left-rail.js`. The context menu uses
`requestAnimationFrame(() => document.addEventListener('click',
onDocClickDismiss, true))` to dismiss on outside click. Two issues:

1. **Rapid right-clicks:** If the user right-clicks twice before the
   rAF fires, a second `showContextMenu()` replaces `activeMenu` but
   the first rAF fires and attaches a listener for a now-orphaned menu.

2. **Callback errors:** If `onDelete(name)` or `onRevert(name)` throws
   inside a context-menu click handler, `dismissContextMenu()` may not
   be called — the menu stays visible and listeners remain attached.

**Fix:**

- In `showContextMenu()`, call `dismissContextMenu()` **at the top**
  before building the new menu. This ensures cleanup of any in-flight
  state.
- Wrap context-menu action callbacks in try/finally with a `finally`
  that always calls `dismissContextMenu()`.

**Files touched:** `src/ui/left-rail.js` (≤10 lines changed).

**Acceptance:**

- Right-click a pattern, then immediately right-click another → first
  menu dismissed, second appears cleanly.
- If a callback error is simulated (temporary throw), menu still
  dismisses and listeners are cleaned up.

---

## Phase 4 — Modal focus trap: re-query focusables dynamically

**Problem:** `src/ui/modal.js`. `installListeners()` captures the list
of focusable elements at modal-open time. If a button becomes disabled
during interaction (e.g., confirm button disabled during validation),
the focus trap cycles through the **stale list**, potentially focusing
disabled elements.

Also, `prevFocus` is captured after the DOM has been modified (after
`buildModal()` appends the overlay). Between the Promise constructor
and the rAF, focus may have shifted.

**Fix:**

- Re-query focusables each time the Tab trap fires, not at bind time.
  In the `keydown` handler's Tab-trapping logic, call a fresh
  `root.querySelectorAll(FOCUSABLE_SELECTOR)` filtered by
  `:not(:disabled)` each time.
- Capture `prevFocus` synchronously at the top of `prompt()`/`confirm()`
  before building the DOM.

**Files touched:** `src/ui/modal.js` (≤10 lines changed).

**Acceptance:**

- Open a prompt, Tab cycles through input → Cancel → OK → back to input.
- Disable the confirm button via devtools mid-modal → Tab skips it.
- Close modal → focus returns to the element that was focused before
  the modal opened.

---

## Phase 5 — Sound browser + console panel: debounce timer cleanup

**Problem:** Both `src/ui/sound-browser.js` and `src/ui/console-panel.js`
use a search-input debounce pattern: `clearTimeout(searchTimer);
searchTimer = setTimeout(fn, ms)`. The timer is never cleared in the
panel's `deactivate()` callback. If the panel deactivates while a search
is pending, the timer fires and accesses stale DOM or triggers a
re-render of a hidden panel.

**Fix:**

In each panel's `deactivate()` callback, add
`clearTimeout(searchTimer)`.

**Files touched:** `src/ui/sound-browser.js` (≤3 lines),
`src/ui/console-panel.js` (≤3 lines).

**Acceptance:**

- Type a search query in the sound browser, immediately Cmd+B to
  collapse the right rail → no console errors, no stale DOM updates.
- Same for the console panel's filter input.

---

## Phase 6 — Canvas resize: skip zero-size on collapse

**Problem:** When the roll is collapsed, `roll.css` applies
`.shell--roll-collapsed .roll-canvas { display: none; }`. The
ResizeObserver fires with `{width: 0, height: 0}`, and `resizeCanvas()`
sets `canvas.width = 0; canvas.height = 0`, destroying the backing
store. On re-expand, there's a brief flash before the observer fires
and rebuilds the backing store.

**Fix:**

In `resizeCanvas()`, skip if both dimensions would be zero. This
preserves the backing store while collapsed, so the canvas is ready
to render immediately on expand.

```js
const resizeCanvas = () => {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (w === 0 && h === 0) return; // collapsed — keep the old backing store
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
};
```

**Files touched:** `src/main.js` (1 line added).

**Acceptance:**

- Collapse the roll → canvas backing store preserved (check via
  `document.getElementById("roll").width` in devtools).
- Expand the roll → canvas renders immediately, no flicker.

---

## Phase 7 — Canvas resize: debounce during grid transitions

**Problem:** The CSS transition on `grid-template-rows` runs for 200ms
(`--t-panel`). During that transition, the ResizeObserver fires
repeatedly with intermediate sizes, causing multiple backing-store
reallocations per collapse/expand. Pure waste — only the final size
matters.

**Fix:**

Wrap the actual canvas resize in a short debounce (50ms). The visual
mismatch at 50ms is imperceptible.

```js
let resizeTimer = null;
const resizeCanvas = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(doResize, 50);
};
const doResize = () => {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (w === 0 && h === 0) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
};
```

**Files touched:** `src/main.js` (≤8 lines changed, replaces Phase 6 code).

**Acceptance:**

- Toggle the roll collapse/expand → only **one** `canvas.width` write
  per transition (verify with temporary `console.count('resize')`).
- Right-rail drag resize → canvas tracks smoothly.
- Window resize → canvas resizes correctly.

---

## Phase 8 — Roll height persistence

**Problem:** `src/piano-roll-resize.js`. `rollExpandedPx` is initialized
to `180` (the CSS default) and only updated during drags. If the user
drags the roll to a custom height, collapses, and reloads — the roll
expands to 180px, not their preferred height.

**Fix:**

Persist `rollExpandedPx` to localStorage alongside the collapsed state.

```js
const HEIGHT_KEY = "strasbeat:roll-height";

// On mount:
let rollExpandedPx = Number(localStorage.getItem(HEIGHT_KEY)) || 180;

// After drag-end and after toggle-expand:
localStorage.setItem(HEIGHT_KEY, String(rollExpandedPx));
```

**Files touched:** `src/piano-roll-resize.js` (≤5 lines).

**Acceptance:**

- Drag the roll to a custom height. Collapse. Reload. Expand → roll
  returns to the custom height.
- Default (never dragged) → 180px.

---

## Phase 9 — Export panel: commit inputs before export

**Problem:** `src/ui/export-panel.js`. The cycles/filename/sampleRate
inputs commit values to localStorage on `change` (blur/Enter). If the
user types a value and immediately clicks Export without blurring, the
value is used for the export but not persisted to storage for next time.

**Fix:**

Add a `commitInputs()` helper that reads all input `.value` fields and
writes them. Call it at the top of the export action.

**Files touched:** `src/ui/export-panel.js` (≤8 lines).

**Acceptance:**

- Type a new filename, immediately click Export (no blur) → export works.
- Reload the page → the export panel shows the filename you typed.

---

## Phase 10 — Transport playhead: guard against NaN

**Problem:** `src/ui/transport.js`. The playhead position is computed
from `cycle`. If `cycle` is `NaN` or `Infinity` (briefly possible
between scheduler teardown and re-init), `playheadEl.style.left` is
set to `NaN%` — an invalid CSS value. The browser ignores it, but it's
a correctness hole.

**Fix:**

```js
const pos = Number.isFinite(cycle) ? ((cycle % 1) + 1) % 1 : 0;
```

**Files touched:** `src/ui/transport.js` (1 line changed).

**Acceptance:**

- Start/stop playback rapidly → no `NaN%` in devtools styles.

---

## Phase 11 — Left-rail CSS: `overflow-x: hidden`

**Problem:** `src/styles/left-rail.css`. The pattern list has
`overflow-y: auto` but no `overflow-x: hidden`. Long pattern names can
produce a horizontal scrollbar.

**Fix:**

Add `overflow-x: hidden` to the list container (or use
`overflow: hidden auto`).

**Files touched:** `src/styles/left-rail.css` (1 line).

**Acceptance:**

- Pattern with very long name → no horizontal scrollbar in the left rail.

---

## Phase 12 — Accent slider: debounce localStorage persistence

**Problem:** `src/ui/settings-panel.js` / `src/main.js`. The accent
hue and lightness sliders fire `onAccentChange()` on every `input`
event — potentially 60+/sec during a drag. Each call writes to
`localStorage` (synchronous I/O).

**Fix:**

In `main.js`'s settings panel wiring, split visual update (immediate)
from persistence (debounced 100ms):

```js
let accentSaveTimer;
onAccentChange: (hue, lightness) => {
  applyAccent(hue, lightness);
  clearTimeout(accentSaveTimer);
  accentSaveTimer = setTimeout(() => saveStoredAccent(hue, lightness), 100);
},
```

**Files touched:** `src/main.js` (≤4 lines changed).

**Acceptance:**

- Drag the accent slider → color updates real-time, no stutter.
- `localStorage` writes batched (not one per input event).

---

## Full smoke test (after all phases)

Run through the following manually:

1. Open the app in a normal browser window.
2. Press play (or Cmd+Enter) → pattern plays, piano roll renders,
   transport shows BPM and cycling.
3. Stop (Cmd+.) → roll freezes, transport parks.
4. Toggle the roll collapsed → canvas hides, transport toggle button
   updates.
5. Toggle the roll expanded → canvas reappears immediately at correct
   size, no flicker.
6. Double-click the roll toggle rapidly → no stuck partial state.
7. Drag the roll divider up/down → roll resizes smoothly, canvas tracks.
8. Collapse the roll, reload → roll stays collapsed.
9. Expand the roll, reload → roll stays expanded **at the height you
   dragged it to** (not the default 180px).
10. Open the right rail (Cmd+B or click a tab) → editor and roll narrow,
    piano roll bitmap stays crisp.
11. Drag the right-rail resize handle → roll tracks live, no stretch.
12. Drag the right-rail resize handle → move pointer far outside the
    window, release → drag ends cleanly, cursor resets.
13. Collapse the right rail → roll fills the width.
14. In the editor, press Cmd+L → line selected. Cmd+L again → next line
    added. Cmd+/ → commented.
15. Right-click a pattern in the left rail → context menu. Right-click
    another → first dismisses, second appears.
16. Open a modal (save, new pattern), press Tab → focus cycles through
    inputs and buttons, skipping disabled ones.
17. Type in the export panel's filename input, immediately click Export
    → export works. Reload → filename is persisted.
18. Open the sound browser, type a search, immediately Cmd+B → no
    console errors.
19. Start/stop playback rapidly 10 times → no doubled ticking, no
    console errors, no `NaN%` in playhead styles.
20. Drag the accent hue slider → smooth, no stutter.
21. Export a WAV from the export panel → file downloads, no console
    errors.
22. Switch patterns in the left rail → editor updates, roll renders the
    new pattern on play.
23. Check `strasbeat.findSounds('piano')` in devtools → works.
24. `pnpm build` → zero warnings.

---

## Non-goals (explicitly out of scope)

- **Full left-rail rebuild / virtual scrolling.** n < 100, O(n) re-render
  is fine.
- **Piano roll rendering optimizations.** Full-canvas-redraw per frame is
  within rAF budget.
- **Sound browser group collapse persistence.** Minor polish, not a bug.
- **Console panel ring buffer DOM optimization.** 500-entry cap is fine.
- **New features (multi-track, mixer, sequencer, etc.).** This spec is
  purely about making the existing UI bulletproof.
- **`main.js` extraction.** That's spec 10. This spec intentionally
  limits diffs to the bug-fix scope so the two efforts don't conflict.
- **Quote style normalization.** Agents should match the surrounding
  file's convention and not bulk-reformat.
