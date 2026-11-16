// Beat grid — a step-sequencer view over the editor buffer's `$:` drum
// lanes. Renders one row per lane, one cell per step; the editor buffer
// stays the source of truth (clicks dispatch CodeMirror transactions
// against the parsed step token offsets).
//
// Phase 1: parser-driven read-only render.
// Phase 2 (this revision): click / alt-click / right-click / shift-drag
// gestures wire up through the pure helpers in ../editor/drum-write.js.
// Each user action re-parses the buffer just before dispatch so stale
// offsets can't corrupt the source, and every action produces a single
// CodeMirror transaction so one Cmd+Z undoes one gesture.
//
// See design/work/19-beat-grid.md for the full spec, including phasing.

import { EditorView } from "@codemirror/view";
import { parseDrumLanes, READ_ONLY_REASONS } from "../editor/drum-parse.js";
import {
  buildAddLaneText,
  changeForAddLane,
  changeForBankSet,
  changeForCellOff,
  changeForCellOn,
  changeForCycleVariant,
  changeForDeleteLane,
  changeForDuplicateLane,
  changeForMuteToggle,
  changeForMoveLane,
  changeForNormaliseShortcut,
  changeForSoloToggle,
  changeForSoundSwap,
  changeForUpgradeResolution,
  changeForVariant,
  changesForPaint,
  expandShortcut,
  getSampleCount,
  resolveSoundKey,
} from "../editor/drum-write.js";
import { confirm } from "./modal.js";
import { PALETTE } from "./palette.js";

// ─── Pure helpers (exported so they can be unit-tested) ──────────────────

/**
 * Fractional step position within a single cycle, scaled to pixel X offset
 * on a lane of the given width. Used by the playhead rAF loop — separated
 * out so the math is independently testable without spinning up a DOM.
 * Handles fractional cycles, negative values (pre-first-downbeat), and
 * lanes of any pixel width.
 */
export function playheadXForCycle(cycle, laneWidth) {
  if (!Number.isFinite(cycle) || !Number.isFinite(laneWidth) || laneWidth <= 0) {
    return 0;
  }
  const frac = ((cycle % 1) + 1) % 1;
  return frac * laneWidth;
}

/**
 * Compute the next focus target for an arrow-key press on a cell grid with
 * mixed per-lane resolutions.
 *
 * Wraps at row/column ends. Up/Down skip read-only lanes. Home/End move
 * within the current lane; PageUp/PageDown jump to the first/last editable
 * lane while keeping the step index (clamped to the target lane's length).
 *
 * `lanes` is an array of `{ stepCount, editable }`; from is `{ laneIndex,
 * stepIndex }`; `key` is a keyboard key name ("ArrowRight", "Home", etc.).
 * Returns `{ laneIndex, stepIndex }` or `null` when no target exists
 * (e.g. no editable lanes).
 */
export function nextFocusTarget(lanes, from, key) {
  if (!Array.isArray(lanes) || lanes.length === 0) return null;
  const editables = lanes
    .map((l, i) => ({ ...l, index: i }))
    .filter((l) => l.editable && l.stepCount > 0);
  if (editables.length === 0) return null;

  const currentLane = lanes[from.laneIndex];
  const currentIsEditable = !!currentLane && currentLane.editable && currentLane.stepCount > 0;
  const stepIndex = Math.max(0, Math.min(from.stepIndex, (currentLane?.stepCount ?? 1) - 1));

  if (key === "ArrowRight" || key === "ArrowLeft") {
    if (!currentIsEditable) {
      const first = editables[0];
      return { laneIndex: first.index, stepIndex: 0 };
    }
    const delta = key === "ArrowRight" ? 1 : -1;
    const n = currentLane.stepCount;
    const next = ((stepIndex + delta) % n + n) % n;
    return { laneIndex: from.laneIndex, stepIndex: next };
  }

  if (key === "Home" || key === "End") {
    if (!currentIsEditable) {
      const first = editables[0];
      return {
        laneIndex: first.index,
        stepIndex: key === "End" ? first.stepCount - 1 : 0,
      };
    }
    return {
      laneIndex: from.laneIndex,
      stepIndex: key === "End" ? currentLane.stepCount - 1 : 0,
    };
  }

  if (key === "ArrowUp" || key === "ArrowDown") {
    const delta = key === "ArrowDown" ? 1 : -1;
    const editableIndices = editables.map((l) => l.index);
    // Position within the editable-only list; if current isn't editable,
    // treat it as -1 so Down lands on the first and Up lands on the last.
    const pos = editableIndices.indexOf(from.laneIndex);
    const len = editableIndices.length;
    let nextPos;
    if (pos < 0) {
      nextPos = delta > 0 ? 0 : len - 1;
    } else {
      nextPos = ((pos + delta) % len + len) % len;
    }
    const target = editables[nextPos];
    // Preserve the step index; clamp to the new lane's length. Prefer the
    // fraction of the current position when the resolutions differ — a
    // 16-step row's step 8 maps to a 4-step row's step 2 so the visual
    // column stays aligned.
    const srcCount = currentLane?.stepCount ?? target.stepCount;
    const frac = srcCount > 0 ? stepIndex / srcCount : 0;
    const nextStep = Math.max(
      0,
      Math.min(target.stepCount - 1, Math.floor(frac * target.stepCount)),
    );
    return { laneIndex: target.index, stepIndex: nextStep };
  }

  if (key === "PageUp" || key === "PageDown") {
    const target = key === "PageDown" ? editables[editables.length - 1] : editables[0];
    const srcCount = currentLane?.stepCount ?? target.stepCount;
    const frac = srcCount > 0 ? stepIndex / srcCount : 0;
    const nextStep = Math.max(
      0,
      Math.min(target.stepCount - 1, Math.floor(frac * target.stepCount)),
    );
    return { laneIndex: target.index, stepIndex: nextStep };
  }

  return null;
}

/**
 * Everything a lane row renders apart from its individual steps, as one
 * comparable string. Two parses that agree on it can share the row's DOM.
 * Source offsets are left out on purpose — they shift with every edit above
 * the lane without changing a pixel — except where the row prints source
 * text itself (the read-only stripe's line number and snippet).
 */
export function laneFrameSignature(lane, index, code = "") {
  const parts = [
    index,
    lane.editable ? 1 : 0,
    lane.muted ? 1 : 0,
    lane.soloed ? 1 : 0,
    lane.primarySound ?? "",
    lane.bank?.name ?? "",
    lane.stepCount ?? 0,
    lane.steps.length,
  ];
  if (!(lane.editable && lane.steps.length > 0)) {
    parts.push(
      lane.readOnlyReason ?? "",
      lane.line,
      code.slice(lane.stepStart, lane.stepEnd),
    );
  }
  return parts.join("\u0001");
}

/** What one step cell renders. */
export function stepSignature(step) {
  if (!step || step.kind !== "hit") return "";
  return `${step.sound}:${step.variant ?? ""}`;
}

/**
 * Whether a key press inside the grid is aimed at a step cell. The grid's
 * one keydown listener sees presses on every control inside it (mute/solo,
 * bank chip, "+ Add drum" …); those must keep their own meaning rather than
 * act on whichever cell was focused last.
 */
export function isCellTarget(target) {
  return !!target?.classList?.contains("beat-grid__cell");
}

/**
 * Should a grid edit re-evaluate so it is heard at once? Only while the
 * buffer being edited is the one playing: evaluating a stopped buffer would
 * start playback from a click on a cell, and evaluating another tab's
 * buffer would take playback away from the tab that owns it.
 */
export function shouldAutoReplay({ isPlaying, scheduler }) {
  if (typeof isPlaying === "function") return !!isPlaying();
  return !!scheduler?.started;
}

// Common drum-machine banks offered in the bank picker even when the
// current buffer doesn't use them yet. Grep'd from the patterns directory
// so we match what's been authored by hand. Order = rough "most iconic
// first" for scannability.
const COMMON_BANKS = [
  "RolandTR909",
  "RolandTR808",
  "RolandTR707",
  "AkaiLinn",
  "LinnLM1",
  "CasioRZ1",
  "OberheimDMX",
  "DoepferMS404",
  "AkaiMPC60",
  "AkaiMPC1000",
];

// Kit drums offered in the "+ Add drum" picker. Small so scan time is
// nothing; order matches standard drum-machine row layout (kick, snare,
// hat, open-hat, clap, rim, cowbell, cymbal).
const ADD_LANE_KIT = [
  { sound: "bd", label: "Kick (bd)" },
  { sound: "sd", label: "Snare (sd)" },
  { sound: "hh", label: "Closed hat (hh)" },
  { sound: "oh", label: "Open hat (oh)" },
  { sound: "cp", label: "Clap (cp)" },
  { sound: "rim", label: "Rim (rim)" },
  { sound: "cb", label: "Cowbell (cb)" },
  { sound: "cy", label: "Cymbal (cy)" },
];

// Drum-ident prefixes the sound picker narrows to. Mirrors DRUM_ORDER in
// src/ui/sound-browser.js — keep both in sync if you add new roles.
const DRUM_PREFIXES = new Set([
  "bd", "kick",
  "sd", "snare",
  "rim", "cp", "clap",
  "hh", "ch", "oh", "ho",
  "lt", "mt", "ht", "tom",
  "cb", "cy", "cr", "crash",
  "rd", "ride", "sh", "shaker",
  "conga", "bongo", "tabla",
  "perc", "shake",
]);

// Friendly short labels for common drum-machine ident prefixes. Used as a
// secondary line under the sound name. Anything not listed here falls
// back to "" — better empty than wrong.
const SOUND_NICKNAMES = {
  bd: "kick",
  kick: "kick",
  sd: "snare",
  snare: "snare",
  rim: "rim",
  cp: "clap",
  clap: "clap",
  hh: "hat",
  ch: "hat",
  oh: "open hat",
  perc: "perc",
  cb: "cowbell",
  cow: "cowbell",
  cy: "cymbal",
  cym: "cymbal",
  ride: "ride",
  crash: "crash",
  ht: "high tom",
  mt: "mid tom",
  lt: "low tom",
  tom: "tom",
  shake: "shaker",
  shaker: "shaker",
  conga: "conga",
  bongo: "bongo",
  tabla: "tabla",
  ms: "maraca",
};

// Human-readable badge text for each readOnlyReason, plus an optional
// hint about what the user could do next. Keep these short — they're
// rendered as small badges inline with the lane.
const READ_ONLY_BADGES = {
  [READ_ONLY_REASONS.shortcut]:     { text: "shortcut",     hint: "expand to N cells to edit" },
  [READ_ONLY_REASONS.alternation]:  { text: "alternation",  hint: "uses <a b> — edit as text" },
  [READ_ONLY_REASONS.subdivision]:  { text: "subdivision",  hint: "uses [a b] — edit as text" },
  [READ_ONLY_REASONS.polyrhythm]:   { text: "polyrhythm",   hint: "comma-layered — edit as text" },
  [READ_ONLY_REASONS.elongation]:   { text: "elongation",   hint: "uses @N — edit as text" },
  [READ_ONLY_REASONS.slow]:         { text: "slow",         hint: "uses /N — edit as text" },
  [READ_ONLY_REASONS.struct]:       { text: "struct mode",  hint: ".struct() controls rhythm — edit as text" },
  [READ_ONLY_REASONS.notFlat]:      { text: "non-flat",     hint: "edit as text" },
  [READ_ONLY_REASONS.badStepCount]: { text: "non-standard step count", hint: "edit as text" },
};

/**
 * Mount the beat grid into a host element (typically the .roll-pane). The
 * grid is hidden by default; show()/hide() toggles visibility, and the
 * grid auto-rebuilds whenever the editor buffer changes.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container  host element (typically .roll-pane)
 * @param {EditorView} opts.view        CodeMirror view
 * @param {{ subscribe: Function }} opts.docSync  shared doc-change signal
 *   (src/editor/doc-sync.js) — fires on buffer edits and on tab swaps
 * @param {() => void} [opts.onLanesChange]
 *   fired when the lane count transitions zero ↔ non-zero
 * @param {() => Record<string, any>} [opts.getSoundMap]
 *   returns the live superdough soundMap for variant counts + preview
 *   resolution. Optional so tests can mount without audio deps.
 * @param {(sound: string, opts?: { bank?: string, variant?: number }) => void} [opts.onPreview]
 *   fires a one-shot audition through superdough. Skipped silently if
 *   absent (e.g. in tests).
 * @param {() => any} [opts.getScheduler]
 *   returns editor.repl.scheduler (or null). Used by the playhead rAF
 *   loop; omit in tests to suppress the sweep.
 * @param {() => void} [opts.onEvaluate]
 *   fired after every buffer-editing action so changes are immediately
 *   audible during playback — mirrors the mute/solo auto-replay in
 *   track-bar. Wired to `editor.evaluate` in main.js; omit in tests.
 * @param {() => boolean} [opts.isPlaying]
 *   true while the buffer this grid edits is the one being played. Gates
 *   the auto-replay; defaults to "the scheduler is running" when omitted.
 */
export function mountBeatGrid({
  container,
  view,
  docSync,
  onLanesChange,
  getSoundMap = () => ({}),
  onPreview = null,
  getScheduler = () => null,
  onEvaluate = null,
  isPlaying: isBufferPlaying = null,
}) {
  // Outer wrapper sits as a sibling of the canvas inside the roll pane.
  const root = document.createElement("div");
  root.className = "beat-grid";
  root.hidden = true;

  // Hidden live region — announces cell toggles, mute/solo, bank/sound
  // changes to screen readers. One per grid root is enough; per-lane
  // regions would compete. `polite` so announcements don't preempt the
  // user's own typing.
  const liveRegion = document.createElement("div");
  liveRegion.className = "beat-grid__sr-only";
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  liveRegion.setAttribute("aria-atomic", "true");
  root.appendChild(liveRegion);

  function announce(message) {
    if (!message) return;
    // Toggling textContent forces screen readers to re-read even identical
    // strings — set to empty first so repeated toggles ("bd on", "bd off",
    // "bd on") all announce instead of being coalesced.
    liveRegion.textContent = "";
    liveRegion.textContent = message;
  }

  const empty = document.createElement("div");
  empty.className = "beat-grid__empty";
  empty.hidden = true;
  const emptyLead = document.createElement("div");
  emptyLead.className = "beat-grid__empty-lead";
  emptyLead.textContent = "No drum lanes yet";
  const emptyHint = document.createElement("div");
  emptyHint.className = "beat-grid__empty-hint";
  emptyHint.appendChild(document.createTextNode("Add a "));
  const emptyCode = document.createElement("code");
  emptyCode.className = "beat-grid__empty-code";
  emptyCode.textContent = '$: s("bd ~ sd ~")';
  emptyHint.appendChild(emptyCode);
  emptyHint.appendChild(document.createTextNode(" line to your pattern."));
  empty.appendChild(emptyLead);
  empty.appendChild(emptyHint);
  root.appendChild(empty);

  // The grid proper: one row per lane, each a row header (the rail), a cell
  // holding the lane's step buttons (or its read-only stripe) and a cell
  // holding its controls. Only rows live in here — the live region, the
  // empty state and the "+ Add drum" row are siblings, not grid children.
  const lanesEl = document.createElement("div");
  lanesEl.className = "beat-grid__lanes";
  lanesEl.setAttribute("role", "grid");
  lanesEl.setAttribute("aria-label", "Beat grid");
  lanesEl.setAttribute("aria-colcount", "3");
  root.appendChild(lanesEl);

  // "+ Add drum" action below the lane stack. Mirrors the spec's
  // "+ Add drum (bottom of the rail)" affordance. Built once; its button is
  // added below, once the interaction context exists.
  const addRow = document.createElement("div");
  addRow.className = "beat-grid__add-row";
  addRow.hidden = true;
  root.appendChild(addRow);

  container.appendChild(root);

  let lastHadLanes = false;

  // ─── Render bookkeeping ──────────────────────────────────────────────
  // One entry per rendered lane row, in lane order: its element, the
  // signatures it was built from (see laneFrameSignature / stepSignature)
  // and, for editable lanes, its step cells and playhead.
  /** @type {Array<{ el: HTMLElement, frame: string, steps: string[] | null, cellEls: HTMLElement[], cellsEl: HTMLElement | null, playhead: { el: HTMLElement, width: number, lastX: number } | null }>} */
  let laneEntries = [];
  // The parse the DOM currently shows. The parser returns the same array
  // for the same text, so identity is the "nothing changed" test.
  let renderedLanes = null;
  // The buffer changed while the grid could not be seen. Nothing is built
  // until it can: show(), or the pane expanding, picks this up.
  let dirty = false;
  // The roll pane this grid lives in is collapsed to (almost) nothing.
  let paneCollapsed = false;
  const isShown = () => !root.hidden && !paneCollapsed;

  // ─── Paint-drag state (shift+pointerdown … document pointerup) ──────────
  /**
   * @type {null | {
   *   laneIndex: number,
   *   targetAction: "on" | "off",
   *   sound: string | null,
   *   touched: Map<number, HTMLElement>,
   * }}
   */
  let paintDrag = null;

  // ─── Context menu (right-click variant picker) ──────────────────────────
  /** @type {null | { el: HTMLElement, teardown: () => void }} */
  let openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.teardown();
    openMenu = null;
  }

  // ─── Drag-reorder state (pointerdown on lane dot … pointerup) ──────────
  /**
   * @type {null | {
   *   laneIndex: number,
   *   rowEl: HTMLElement,
   *   pointerId: number,
   *   startY: number,
   *   targetIndex: number | null,
   *   dropIndicatorEl: HTMLElement | null,
   * }}
   */
  let reorderDrag = null;

  // ─── Playhead sweep ──────────────────────────────────────────────────
  // Each editable lane entry carries a playhead (see laneEntries). Its
  // width comes from the one ResizeObserver below, which reports the cells
  // strip's size when it is first observed and whenever it changes — so
  // neither a rebuild nor the rAF tick ever has to read layout.
  let raf = null;
  let isPlaying = false;
  const playheadByCells = new WeakMap();
  const sizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.target === container) {
              // A collapsed pane keeps a pixel or two of border.
              const collapsed = entry.contentRect.height < 8;
              if (collapsed === paneCollapsed) continue;
              paneCollapsed = collapsed;
              if (isShown() && dirty) rebuild();
              updatePlayheadVisibility();
              continue;
            }
            const ph = playheadByCells.get(entry.target);
            if (!ph) continue;
            ph.width = entry.contentRect.width || 0;
            ph.lastX = -1;
          }
        })
      : null;
  sizeObserver?.observe(container);

  // ─── Keyboard focus + selection state ─────────────────────────────────
  // Roving tabindex: at any time one cell in the grid has tabindex=0, all
  // others have tabindex=-1. Arrow keys move focus by updating this pair
  // and calling .focus() on the target DOM element.
  /** @type {{ laneIndex: number, stepIndex: number } | null} */
  let focusedCell = null;
  // Shift+Arrow selection: anchor is the cell the user first shift-moved
  // from; head is the live end. Enter on a selection commits a flip
  // transaction spanning every cell in the range.
  /** @type {{ laneIndex: number, from: number, to: number } | null} */
  let selection = null;

  // ─── Shared interaction context passed into each renderLane call ────────
  const ctx = {
    view,
    getSoundMap,
    onPreview,
    dispatchChange,
    dispatchChanges,
    dispatchRawChanges,
    previewStep,
    startPaintDrag,
    extendPaintDrag,
    openVariantMenu,
    openBankMenu,
    openSoundMenu,
    openLaneContextMenu,
    openAddLaneMenu,
    startReorderDrag,
    closeMenu,
    setOpenMenu,
    announce,
    getFocusedCell: () => focusedCell,
    getPaintDrag: () => paintDrag,
    getReorderDrag: () => reorderDrag,
  };

  function setOpenMenu(entry) {
    // Called by helpers that build their own menus (lane-context, add-lane)
    // so they route through the same close/outside-click path as the
    // variant menu.
    closeMenu();
    openMenu = entry;
  }

  // Even with no lanes, let the user add one via the "+ Add drum" button
  // inside the empty-state layout so they don't have to open the command
  // palette to start drumming.
  empty.appendChild(buildAddLaneButton(ctx, { variant: "primary" }));
  addRow.appendChild(buildAddLaneButton(ctx, { variant: "ghost" }));

  function noteLaneCount(count) {
    const hasLanes = count > 0;
    if (hasLanes === lastHadLanes) return;
    lastHadLanes = hasLanes;
    onLanesChange?.(count);
  }

  function dropLaneEntry(entry) {
    if (entry.cellsEl) sizeObserver?.unobserve(entry.cellsEl);
    entry.el.remove();
  }

  // Build a lane row and register its playhead for the rAF sweep.
  function createLaneEntry(lane, index, code, frame) {
    const el = renderLane(lane, index, code, ctx);
    const editable = lane.editable && lane.steps.length > 0;
    const cellsEl = editable ? el.querySelector(".beat-grid__cells") : null;
    const playheadEl = cellsEl?.querySelector(".beat-grid__playhead") ?? null;
    const entry = {
      el,
      frame,
      steps: editable ? lane.steps.map(stepSignature) : null,
      cellEls: cellsEl ? Array.from(cellsEl.querySelectorAll(".beat-grid__cell")) : [],
      cellsEl,
      playhead: playheadEl ? { el: playheadEl, width: 0, lastX: -1 } : null,
    };
    if (entry.playhead) {
      playheadByCells.set(cellsEl, entry.playhead);
      sizeObserver?.observe(cellsEl);
    }
    return entry;
  }

  function rebuild() {
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);

    if (!isShown()) {
      // Nobody can see the grid: remember that it is stale and build
      // nothing. Whether the buffer has drum lanes at all still matters —
      // it decides if the "Beat grid" view is offered.
      dirty = true;
      noteLaneCount(lanes.length);
      return;
    }
    dirty = false;
    if (lanes === renderedLanes) return; // same parse as what is on screen
    renderedLanes = lanes;

    // Capture focus state BEFORE touching the DOM — once a focused cell is
    // replaced the browser retargets activeElement to <body>, so a later
    // check can't tell whether focus used to live inside the grid.
    const hadFocusInside =
      document.activeElement != null && root.contains(document.activeElement);

    // Capture scroll position too: removing rows can shrink the scroll
    // container's content height, which clamps root.scrollTop.
    const scrollTop = root.scrollTop;

    lanesEl.setAttribute("aria-rowcount", String(lanes.length));

    if (lanes.length === 0) {
      for (const entry of laneEntries) dropLaneEntry(entry);
      laneEntries = [];
      empty.hidden = false;
      addRow.hidden = true;
      noteLaneCount(0);
      focusedCell = null;
      selection = null;
      tabStopEl = null;
      return;
    }

    empty.hidden = true;
    addRow.hidden = false;

    // Bring the rows in line with the parse, touching only what changed:
    // a lane whose frame is the same keeps its row and has just the step
    // cells that differ swapped; anything else gets a fresh row. Typing in
    // the editor usually changes no lane at all, and a click on a cell
    // changes exactly one cell.
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i];
      const frame = laneFrameSignature(lane, i, code);
      const prev = laneEntries[i];
      if (prev && prev.frame === frame) {
        if (prev.steps) {
          for (let j = 0; j < lane.steps.length; j++) {
            const sig = stepSignature(lane.steps[j]);
            if (prev.steps[j] === sig) continue;
            const cell = buildCell(lane, i, j, ctx);
            prev.cellsEl.replaceChild(cell, prev.cellEls[j]);
            prev.cellEls[j] = cell;
            prev.steps[j] = sig;
          }
        }
        continue;
      }
      const entry = createLaneEntry(lane, i, code, frame);
      if (prev) {
        if (prev.cellsEl) sizeObserver?.unobserve(prev.cellsEl);
        lanesEl.replaceChild(entry.el, prev.el);
      } else {
        lanesEl.appendChild(entry.el);
      }
      laneEntries[i] = entry;
    }
    for (let i = lanes.length; i < laneEntries.length; i++) {
      dropLaneEntry(laneEntries[i]);
    }
    laneEntries.length = lanes.length;

    noteLaneCount(lanes.length);

    // Keep exactly one cell in the Tab order. That is the cell the user was
    // on — snapped to the nearest surviving one if the buffer changed under
    // it — or, before any cell was ever focused, the first editable one.
    const target = focusedCell ? clampFocus(focusedCell, lanes) : null;
    if (focusedCell) focusedCell = target;
    updateRovingTabindex(target ?? seedFocus(lanes));
    // Only restore browser focus if focus was already inside the grid.
    // Don't steal it when the user has moved on to the editor.
    // preventScroll: true so the focus call doesn't undo our scrollTop
    // restore below — the cell the user just clicked is, by definition,
    // the cell they were looking at; preserving the prior viewport beats
    // snapping it to the browser's nearest-edge default.
    if (target && hadFocusInside && !root.contains(document.activeElement)) {
      focusCell(target, { preventScroll: true });
    }
    // Selection is discarded on any external rebuild — step offsets just
    // shifted and painting onto stale indices would corrupt the buffer.
    selection = null;
    repaintSelection();
    updatePlayheadVisibility();

    // Restore scroll position, clamped to the new maxScroll so a shrinking
    // pattern (lane deleted) doesn't leave us past the end. Only when rows
    // actually went away — otherwise nothing moved and reading the scroll
    // geometry would force a layout for no reason. The focusCell above
    // uses preventScroll:true so this restore wins; keyboard nav scrolls
    // happen through the keydown handler's own focusCell call (which still
    // uses preventScroll:false), not through this rebuild path.
    if (scrollTop > 0 && root.scrollTop !== scrollTop) {
      const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
      root.scrollTop = Math.min(scrollTop, maxScroll);
    }
  }

  // Snap a focus pair to an existing editable cell. Returns null when no
  // editable lanes remain.
  function clampFocus({ laneIndex, stepIndex }, lanes) {
    if (!lanes || lanes.length === 0) return null;
    const editables = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].editable && lanes[i].stepCount > 0) editables.push(i);
    }
    if (editables.length === 0) return null;
    const targetLane = lanes[laneIndex];
    if (targetLane && targetLane.editable && targetLane.stepCount > 0) {
      return {
        laneIndex,
        stepIndex: Math.max(0, Math.min(targetLane.stepCount - 1, stepIndex)),
      };
    }
    // Find the nearest editable lane by index distance.
    let best = editables[0];
    let bestDist = Math.abs(best - laneIndex);
    for (const i of editables) {
      const d = Math.abs(i - laneIndex);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return {
      laneIndex: best,
      stepIndex: Math.max(0, Math.min(lanes[best].stepCount - 1, stepIndex)),
    };
  }

  function cellFor({ laneIndex, stepIndex }) {
    return laneEntries[laneIndex]?.cellEls[stepIndex] ?? null;
  }

  // The one cell currently in the Tab order (every cell is built with
  // tabindex=-1).
  let tabStopEl = null;
  function updateRovingTabindex(target) {
    const el = target ? cellFor(target) : null;
    if (el === tabStopEl && (!el || el.tabIndex === 0)) return;
    if (tabStopEl) tabStopEl.setAttribute("tabindex", "-1");
    tabStopEl = el;
    if (el) el.setAttribute("tabindex", "0");
  }

  function focusCell(target, { preventScroll = false } = {}) {
    const el = cellFor(target);
    if (!el) return;
    el.focus({ preventScroll });
  }

  function repaintSelection() {
    for (const cell of lanesEl.querySelectorAll(".beat-grid__cell--selected")) {
      cell.classList.remove("beat-grid__cell--selected");
    }
    if (!selection) return;
    const { laneIndex, from, to } = selection;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let i = lo; i <= hi; i++) {
      const el = cellFor({ laneIndex, stepIndex: i });
      if (el) el.classList.add("beat-grid__cell--selected");
    }
  }

  // Initial render and live updates on doc change.
  rebuild();

  // scheduleRebuild runs the next tick via a microtask — fast enough
  // that multiple dispatches inside the same stack collapse into one
  // rebuild, robust against rAF throttling in background tabs
  // (which would leave the `scheduled` flag stuck).
  let scheduled = false;
  function scheduleRebuild() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      rebuild();
    });
  }

  // Doc changes and tab swaps, both via docSync — see src/editor/doc-sync.js.
  //
  // This used to be a per-mount StateEffect.appendConfig listener plus a
  // permanent 100ms setInterval poll, added because that listener "sometimes
  // stopped firing after unrelated CM reconfigurations". The real cause was
  // BUG-2 in design/work/27: the listener was appended after main.js captured
  // the clean base EditorState, so it was missing from every tab built later,
  // and the poll was what kept the grid alive. Root cause fixed, poll gone.
  docSync.subscribe(({ immediate }) => {
    if (immediate) rebuild();
    else scheduleRebuild();
  });

  // ─── Playhead rAF loop ──────────────────────────────────────────────
  // One loop for the whole grid. Gates itself on visibility + playback so
  // switching to Roll/Scope (or stopping) releases the frame budget.
  function tick() {
    if (!isShown() || !isPlaying) {
      raf = null;
      return;
    }
    const sched = getScheduler?.();
    const cycle =
      sched && sched.started && typeof sched.now === "function"
        ? sched.now()
        : 0;
    for (const entry of laneEntries) {
      const ph = entry.playhead;
      if (!ph) continue;
      const x = playheadXForCycle(cycle, ph.width);
      if (x !== ph.lastX) {
        ph.lastX = x;
        ph.el.style.transform = `translateX(${x}px)`;
      }
    }
    raf = requestAnimationFrame(tick);
  }

  function startPlayhead() {
    for (const entry of laneEntries) {
      const ph = entry.playhead;
      if (ph && ph.el.hidden) ph.el.hidden = false;
    }
    if (raf == null) raf = requestAnimationFrame(tick);
  }

  function stopPlayhead() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
    // Park at step 0 and hide — stopped state shouldn't leave a stale
    // line hovering mid-lane.
    for (const entry of laneEntries) {
      const ph = entry.playhead;
      if (!ph || ph.el.hidden) continue;
      ph.lastX = -1;
      ph.el.style.transform = "translateX(0)";
      ph.el.hidden = true;
    }
  }

  function updatePlayheadVisibility() {
    if (isPlaying && isShown()) startPlayhead();
    else stopPlayhead();
  }

  function setPlaybackState(state) {
    const nextPlaying = state === "playing";
    if (nextPlaying === isPlaying) return;
    isPlaying = nextPlaying;
    // A replay still pending from the last edit must not outlive playback:
    // it would start the transport again right after Stop.
    if (!isPlaying) cancelAutoReplay();
    updatePlayheadVisibility();
  }

  // ─── Keyboard handling (root-level) ─────────────────────────────────
  // Arrow keys, Home/End, PageUp/PageDown, Space/Enter, Alt+Space/Enter,
  // v, m/s, Escape, Shift+Arrow selection. Single listener on the grid
  // root so we don't have to rebind on every rebuild.
  root.addEventListener("keydown", (e) => {
    // Never hijack menu keys — the open menu owns them.
    if (openMenu) return;
    // Let typing in inputs (e.g. the sound-menu search field) pass through.
    const target = e.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    const key = e.key;

    if (
      key === "ArrowLeft" ||
      key === "ArrowRight" ||
      key === "ArrowUp" ||
      key === "ArrowDown" ||
      key === "Home" ||
      key === "End" ||
      key === "PageUp" ||
      key === "PageDown"
    ) {
      const code = view.state.doc.toString();
      const lanes = parseDrumLanes(code);
      if (lanes.length === 0) return;
      // If no cell is focused yet, the arrow press seeds focus on the
      // first editable cell; extends from there on subsequent presses.
      const from = focusedCell ?? seedFocus(lanes);
      if (!from) return;
      const next = nextFocusTarget(lanes, from, key);
      if (!next) return;
      e.preventDefault();
      focusedCell = next;
      // Shift+Arrow extends a within-lane selection. Cross-lane selection
      // is out of scope for v1 (see §"Out of scope"); arrow keys across
      // lanes drop the selection.
      if (
        e.shiftKey &&
        (key === "ArrowLeft" || key === "ArrowRight") &&
        next.laneIndex === from.laneIndex
      ) {
        if (!selection || selection.laneIndex !== from.laneIndex) {
          selection = {
            laneIndex: from.laneIndex,
            from: from.stepIndex,
            to: next.stepIndex,
          };
        } else {
          selection.to = next.stepIndex;
        }
      } else if (!e.shiftKey) {
        selection = null;
      }
      updateRovingTabindex(next);
      focusCell(next);
      repaintSelection();
      return;
    }

    if (key === "Escape") {
      if (selection) {
        e.preventDefault();
        selection = null;
        repaintSelection();
      }
      return;
    }

    if (!focusedCell) return;
    // Everything below acts on the focused cell, so it only applies when a
    // cell is what the key was pressed on. Enter or Space on the mute
    // button, the bank chip or "+ Add drum" belongs to that button.
    if (!isCellTarget(target)) return;

    if (key === " " || key === "Enter") {
      e.preventDefault();
      if (e.altKey) {
        // Alt+Space / Alt+Enter cycles variant on the focused hit cell —
        // keyboard equivalent of the alt-click gesture. handleAltCycle
        // announces internally.
        handleAltCycle(focusedCell.laneIndex, focusedCell.stepIndex, ctx);
        return;
      }
      if (selection) {
        commitSelectionFlip();
        return;
      }
      // handleToggle announces the new cell state internally.
      handleToggle(focusedCell.laneIndex, focusedCell.stepIndex, ctx);
      return;
    }

    if (key === "v" || key === "V") {
      e.preventDefault();
      const el = cellFor(focusedCell);
      if (el) openVariantMenu(focusedCell.laneIndex, focusedCell.stepIndex, el);
      return;
    }

    if (key === "m" || key === "M") {
      e.preventDefault();
      const laneIdx = focusedCell.laneIndex;
      const ok = dispatchRawChanges(
        (_code, lanes) => {
          const l = lanes[laneIdx];
          if (!l) return null;
          return changeForMuteToggle(l);
        },
        "input.beat-grid.mute",
      );
      if (ok) announceLaneState(laneIdx, "mute");
      return;
    }

    if (key === "s" || key === "S") {
      e.preventDefault();
      const laneIdx = focusedCell.laneIndex;
      const ok = dispatchRawChanges(
        (_code, lanes) => {
          const l = lanes[laneIdx];
          if (!l) return null;
          return changeForSoloToggle(l);
        },
        "input.beat-grid.solo",
      );
      if (ok) announceLaneState(laneIdx, "solo");
      return;
    }
  });

  function seedFocus(lanes) {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].editable && lanes[i].stepCount > 0) {
        return { laneIndex: i, stepIndex: 0 };
      }
    }
    return null;
  }

  function commitSelectionFlip() {
    const sel = selection;
    if (!sel) return;
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[sel.laneIndex];
    if (!lane || !lane.editable) return;
    const lo = Math.min(sel.from, sel.to);
    const hi = Math.max(sel.from, sel.to);
    // Flip each cell in the selection: hits → off, rests → on (with lane
    // primary sound). Mirrors shift-drag paint semantics — one transaction,
    // one Cmd+Z reverts the whole stroke.
    const primary = lane.primarySound;
    const ops = [];
    for (let i = lo; i <= hi; i++) {
      const step = lane.steps[i];
      if (!step) continue;
      if (step.kind === "hit") {
        ops.push({ stepIndex: i, action: "off" });
      } else if (primary) {
        ops.push({ stepIndex: i, action: "on", sound: primary });
      }
    }
    if (ops.length === 0) return;
    dispatchChanges(sel.laneIndex, (freshLane) =>
      changesForPaint(freshLane, ops),
    );
    announce(
      `Flipped ${ops.length} cell${ops.length === 1 ? "" : "s"} on lane ${sel.laneIndex + 1}`,
    );
    selection = null;
    // The dispatch triggers rebuild() via docChanged; repaintSelection()
    // there will clear the outlines.
  }

  function announceCell(target, action) {
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[target.laneIndex];
    if (!lane) return;
    const step = lane.steps[target.stepIndex];
    if (!step) return;
    const stepNo = target.stepIndex + 1;
    const soundLabel = step.kind === "hit"
      ? (step.variant != null ? `${step.sound}:${step.variant}` : step.sound)
      : "rest";
    if (action === "variant") {
      announce(`Step ${stepNo}: ${soundLabel}`);
    } else {
      announce(
        step.kind === "hit"
          ? `Step ${stepNo} on: ${soundLabel}`
          : `Step ${stepNo} off`,
      );
    }
  }

  function announceLaneState(laneIndex, kind) {
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[laneIndex];
    if (!lane) return;
    const label = lane.primarySound || `lane ${laneIndex + 1}`;
    if (kind === "mute") {
      announce(`${label} ${lane.muted ? "muted" : "unmuted"}`);
    } else if (kind === "solo") {
      announce(`${label} ${lane.soloed ? "soloed" : "unsoloed"}`);
    }
  }

  // Expose helpers on the interaction context so cell wiring can trigger
  // announcements and focus-tracking without re-reading closures piecemeal.
  ctx.setFocusedCell = (target) => {
    focusedCell = target;
    updateRovingTabindex(target);
  };
  ctx.announceCell = announceCell;
  ctx.announceLaneState = announceLaneState;
  ctx.clearSelection = () => {
    if (!selection) return;
    selection = null;
    repaintSelection();
  };

  // ─── Global listeners for drag-paint + menu dismissal ──────────────────
  // Pointerup anywhere ends a drag. We commit via a single CM transaction
  // so one Cmd+Z reverts the whole stroke.
  const onDocPointerUp = () => {
    if (reorderDrag) {
      finishReorderDrag();
    }
    if (!paintDrag) return;
    commitPaintDrag();
  };
  document.addEventListener("pointerup", onDocPointerUp);

  // Pointermove drives the reorder-drag ghost + drop-target highlight.
  const onDocPointerMove = (e) => {
    if (!reorderDrag) return;
    handleReorderPointerMove(e);
  };
  document.addEventListener("pointermove", onDocPointerMove);

  // Dismiss the variant menu on outside click or Escape. We catch these at
  // the document level so the menu closes cleanly regardless of what the
  // user clicked.
  const onDocPointerDown = (e) => {
    if (!openMenu) return;
    if (openMenu.el.contains(e.target)) return;
    closeMenu();
  };
  const onDocKey = (e) => {
    if (e.key !== "Escape") return;
    if (openMenu) {
      e.preventDefault();
      closeMenu();
    }
    if (paintDrag) {
      cancelPaintDrag();
    }
    if (reorderDrag) {
      cancelReorderDrag();
    }
  };
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKey);

  // ─── Helpers that close over `view` / `paintDrag` / `openMenu` ─────────

  /**
   * Re-parse the buffer and run `compute(lane)` to produce a single CM
   * change. Returns true when a change was dispatched. Always re-parses
   * at call time so stale offsets can't corrupt the buffer.
   */
  function dispatchChange(laneIndex, compute) {
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[laneIndex];
    if (!lane || !lane.editable) return false;
    const change = compute(lane);
    if (!change) return false;
    view.dispatch({
      changes: change,
      userEvent: "input.beat-grid",
    });
    scheduleAutoReplay();
    return true;
  }

  /**
   * Same as dispatchChange but for a list of changes — used by drag-paint
   * so one pointerup produces one transaction.
   */
  function dispatchChanges(laneIndex, computeMany) {
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[laneIndex];
    if (!lane || !lane.editable) return false;
    const changes = computeMany(lane);
    if (!changes || changes.length === 0) return false;
    view.dispatch({
      changes,
      userEvent: "input.beat-grid",
    });
    scheduleAutoReplay();
    return true;
  }

  /**
   * Fire a one-shot audition via the caller-supplied previewer. Wrapped
   * so any consumer error is caught and logged — preview must never take
   * down the interaction loop.
   */
  function previewStep(lane, step) {
    if (!onPreview || !step || step.kind !== "hit" || !step.sound) return;
    const soundMap = getSoundMap?.() ?? {};
    const bank = lane?.bank?.name ?? null;
    const resolved = resolveSoundKey(soundMap, bank, step.sound);
    if (!resolved || !soundMap[resolved]) {
      console.warn(
        `[beat-grid] sound "${step.sound}"${bank ? ` in bank "${bank}"` : ""} is not in the loaded soundMap — skipping preview`,
      );
      return;
    }
    try {
      onPreview(step.sound, {
        bank: bank ?? undefined,
        variant: step.variant ?? 0,
      });
    } catch (err) {
      console.warn("[beat-grid] preview failed:", err);
    }
  }

  function startPaintDrag(laneIndex, startStepIndex, startCellEl) {
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[laneIndex];
    if (!lane || !lane.editable) return;
    const firstStep = lane.steps[startStepIndex];
    if (!firstStep) return;

    // Target state = opposite of the cell the user started on.
    const targetAction = firstStep.kind === "hit" ? "off" : "on";
    // For the paint-on stroke, fall back to "bd" (universal drum-kit
    // kick) when the lane has no existing hit to source a sound from.
    // Same fallback the single-cell click uses — keeps the two paths
    // consistent and makes shift-drag work on brand-new empty lanes.
    const sound = targetAction === "on"
      ? (lane.primarySound
        ?? firstStep.sound
        ?? (lane.steps.find((s) => s.kind === "hit")?.sound ?? "bd"))
      : null;

    paintDrag = {
      laneIndex,
      targetAction,
      sound,
      touched: new Map(),
    };
    extendPaintDrag(laneIndex, startStepIndex, startCellEl);
  }

  function extendPaintDrag(laneIndex, stepIndex, cellEl) {
    if (!paintDrag) return;
    if (paintDrag.laneIndex !== laneIndex) return;
    if (paintDrag.touched.has(stepIndex)) return;
    paintDrag.touched.set(stepIndex, cellEl);
    if (cellEl) {
      cellEl.classList.add("beat-grid__cell--painting");
      // Direction-aware preview class so the user sees whether the stroke
      // will *turn on* or *turn off* the cells it touches. CSS handles the
      // visual treatment — here we only pick the class.
      cellEl.classList.add(
        paintDrag.targetAction === "on"
          ? "beat-grid__cell--painting-on"
          : "beat-grid__cell--painting-off",
      );
    }
  }

  function cancelPaintDrag() {
    if (!paintDrag) return;
    for (const cell of paintDrag.touched.values()) {
      cell?.classList.remove(
        "beat-grid__cell--painting",
        "beat-grid__cell--painting-on",
        "beat-grid__cell--painting-off",
      );
    }
    paintDrag = null;
  }

  function commitPaintDrag() {
    const state = paintDrag;
    paintDrag = null;
    if (!state || state.touched.size === 0) return;

    // Clear the preview class before dispatch — the CM docChange will
    // rebuild anyway, but stripping it here keeps things clean if the
    // dispatch ends up being a no-op.
    for (const cell of state.touched.values()) {
      cell?.classList.remove(
        "beat-grid__cell--painting",
        "beat-grid__cell--painting-on",
        "beat-grid__cell--painting-off",
      );
    }

    // Single-tap (no drag) behaves like a normal click: one cell toggled.
    if (state.touched.size === 1) {
      const [stepIndex] = state.touched.keys();
      const change = state.targetAction === "on"
        ? (lane) => changeForCellOn(lane, stepIndex, { sound: state.sound })
        : (lane) => changeForCellOff(lane, stepIndex);
      dispatchChange(state.laneIndex, change);
      if (state.targetAction === "on") {
        const code = view.state.doc.toString();
        const freshLane = parseDrumLanes(code)[state.laneIndex];
        const freshStep = freshLane?.steps?.[stepIndex];
        previewStep(freshLane, freshStep);
      }
      return;
    }

    // Multi-cell drag — build one combined changes array.
    const ops = [];
    for (const stepIndex of state.touched.keys()) {
      ops.push({
        stepIndex,
        action: state.targetAction,
        sound: state.sound,
      });
    }
    dispatchChanges(state.laneIndex, (lane) => changesForPaint(lane, ops));
    // No per-step preview on a drag — it'd be a cacophony. The user
    // hears the result on next play.
  }

  // ─── Raw changes dispatch (no lane-editable guard) ─────────────────────
  // Used by lane-authoring actions — add/delete/duplicate/reorder work on
  // any lane (editable or not). Takes a `compute(code, lanes)` callback
  // that returns either a single change or an array of changes; dispatches
  // the result as one CM transaction.
  function dispatchRawChanges(compute, userEvent = "input.beat-grid") {
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const res = compute(code, lanes);
    const changes = Array.isArray(res) ? res.filter(Boolean) : res ? [res] : [];
    if (changes.length === 0) return false;
    view.dispatch({
      changes,
      userEvent,
    });
    scheduleAutoReplay();
    return true;
  }

  // Debounce auto-replay so a burst of edits (shift-drag paint, rapid
  // keyboard toggles) coalesces into one re-evaluation. Grid edits can
  // come in at keystroke speed so a small debounce keeps the scheduler
  // from thrashing.
  //
  // Only fire when playback is already running: a user building a
  // pattern while stopped is still composing — they'd be surprised by a
  // click starting the scheduler. When they hit Play, every subsequent
  // grid edit becomes audible live, mirroring the composer experience
  // every DAW's step sequencer provides. On Play itself, Strudel
  // re-evaluates fresh, so any pending edits land automatically.
  //
  // "Running" means this buffer is the one playing (see shouldAutoReplay):
  // an edit in a tab that is not playing must not take playback over. The
  // check is repeated when the timer fires, since Stop or a tab switch can
  // land inside the debounce.
  let replayTimer = null;
  const canAutoReplay = () =>
    shouldAutoReplay({ isPlaying: isBufferPlaying, scheduler: getScheduler?.() });
  function cancelAutoReplay() {
    if (replayTimer == null) return;
    clearTimeout(replayTimer);
    replayTimer = null;
  }
  function scheduleAutoReplay() {
    if (!onEvaluate) return;
    if (!canAutoReplay()) return;
    cancelAutoReplay();
    replayTimer = setTimeout(() => {
      replayTimer = null;
      if (!canAutoReplay()) return;
      try {
        const result = onEvaluate();
        if (result && typeof result.catch === "function") {
          result.catch((err) =>
            console.warn("[beat-grid] auto-replay failed:", err),
          );
        }
      } catch (err) {
        console.warn("[beat-grid] auto-replay failed:", err);
      }
    }, 120);
  }

  // ─── Reorder drag ──────────────────────────────────────────────────────
  function startReorderDrag(laneIndex, rowEl, event) {
    if (reorderDrag) return;
    event.preventDefault();
    rowEl.setPointerCapture?.(event.pointerId);
    reorderDrag = {
      laneIndex,
      rowEl,
      pointerId: event.pointerId,
      startY: event.clientY,
      targetIndex: laneIndex,
      dropIndicatorEl: null,
    };
    rowEl.classList.add("beat-grid__lane--dragging");
    document.body.classList.add("beat-grid-dragging");
  }

  function handleReorderPointerMove(e) {
    if (!reorderDrag) return;
    const { rowEl } = reorderDrag;
    const dy = e.clientY - reorderDrag.startY;
    rowEl.style.transform = `translateY(${dy}px)`;

    // Find the lane under the pointer. elementFromPoint skips the dragged
    // row's content because we apply transform translateY, but the row's
    // hitbox may still register — so we temporarily hide it from
    // pointer-events before probing.
    rowEl.style.pointerEvents = "none";
    const hovered = document.elementFromPoint(e.clientX, e.clientY);
    rowEl.style.pointerEvents = "";

    const targetRow = hovered?.closest(".beat-grid__lane");
    const targetIdxRaw = targetRow?.dataset?.laneIndex;
    const nextTarget =
      targetIdxRaw != null ? parseInt(targetIdxRaw, 10) : reorderDrag.laneIndex;
    if (
      Number.isFinite(nextTarget) &&
      nextTarget !== reorderDrag.targetIndex
    ) {
      reorderDrag.targetIndex = nextTarget;
      // Paint indicator on the target row.
      for (const l of lanesEl.querySelectorAll(".beat-grid__lane--drop-target")) {
        l.classList.remove("beat-grid__lane--drop-target");
      }
      if (
        targetRow &&
        nextTarget !== reorderDrag.laneIndex
      ) {
        targetRow.classList.add("beat-grid__lane--drop-target");
      }
    }
  }

  function finishReorderDrag() {
    const state = reorderDrag;
    reorderDrag = null;
    if (!state) return;
    const { rowEl, laneIndex, targetIndex } = state;
    rowEl.style.transform = "";
    rowEl.style.pointerEvents = "";
    rowEl.classList.remove("beat-grid__lane--dragging");
    document.body.classList.remove("beat-grid-dragging");
    for (const l of lanesEl.querySelectorAll(".beat-grid__lane--drop-target")) {
      l.classList.remove("beat-grid__lane--drop-target");
    }
    if (
      targetIndex == null ||
      targetIndex === laneIndex ||
      !Number.isFinite(targetIndex)
    ) {
      return; // no-op drop
    }
    dispatchRawChanges(
      (code, lanes) => {
        const a = lanes[laneIndex];
        const b = lanes[targetIndex];
        if (!a || !b) return null;
        return changeForMoveLane(code, a, b);
      },
      "input.beat-grid.reorder",
    );
  }

  function cancelReorderDrag() {
    const state = reorderDrag;
    reorderDrag = null;
    if (!state) return;
    state.rowEl.style.transform = "";
    state.rowEl.style.pointerEvents = "";
    state.rowEl.classList.remove("beat-grid__lane--dragging");
    document.body.classList.remove("beat-grid-dragging");
    for (const l of lanesEl.querySelectorAll(".beat-grid__lane--drop-target")) {
      l.classList.remove("beat-grid__lane--drop-target");
    }
  }

  // ─── Bank picker menu ──────────────────────────────────────────────────
  function openBankMenu(laneIndex, anchorEl) {
    closeMenu();
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[laneIndex];
    if (!lane) return;

    // Gather "banks already in use in this buffer" so the menu promotes
    // what the user is already working with.
    const inUse = [];
    const seen = new Set();
    for (const l of lanes) {
      const name = l.bank?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      inUse.push(name);
    }
    // Common banks minus those already in `inUse`.
    const commonExtras = COMMON_BANKS.filter((b) => !seen.has(b));

    const menu = buildListMenu({
      ariaLabel: `Bank for ${lane.primarySound || "lane"}`,
      header: lane.bank ? `bank: ${lane.bank.name}` : "no bank set",
      sections: [
        {
          heading: null,
          items: [
            {
              label: "No bank",
              current: !lane.bank,
              onPick: () => setBankAndPreview(laneIndex, null),
            },
          ],
        },
        ...(inUse.length > 0
          ? [
              {
                heading: "In this pattern",
                items: inUse.map((name) => ({
                  label: name,
                  current: lane.bank?.name === name,
                  onPick: () => setBankAndPreview(laneIndex, name),
                })),
              },
            ]
          : []),
        {
          heading: "Common drum machines",
          items: commonExtras.map((name) => ({
            label: name,
            current: lane.bank?.name === name,
            onPick: () => setBankAndPreview(laneIndex, name),
          })),
        },
      ],
    });
    document.body.appendChild(menu);
    positionMenu(menu, anchorEl);
    setOpenMenu({
      el: menu,
      teardown: () => menu.parentNode?.removeChild(menu),
    });
    focusFirstMenuItem(menu);
  }

  // Menu opened from the "+ Add drum" button at the bottom of the lane
  // list. Uses the same closure-owned `openMenu` slot as every other menu
  // so Escape and outside-click dismiss cleanly.
  function openAddLaneMenu(anchorEl) {
    closeMenu();
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    let lastBank = null;
    for (let i = lanes.length - 1; i >= 0; i--) {
      if (lanes[i].bank?.name) {
        lastBank = lanes[i].bank.name;
        break;
      }
    }
    const items = ADD_LANE_KIT.map((entry) => ({
      label: entry.label,
      onPick: () => {
        closeMenu();
        addLane(ctx, entry.sound, lastBank);
      },
    }));
    const menu = buildListMenu({
      ariaLabel: "Add drum lane",
      header: lastBank ? `new lane in ${lastBank}` : "new lane",
      sections: [{ heading: null, items }],
    });
    document.body.appendChild(menu);
    positionMenu(menu, anchorEl);
    setOpenMenu({
      el: menu,
      teardown: () => menu.parentNode?.removeChild(menu),
    });
    focusFirstMenuItem(menu);
  }

  function setBankAndPreview(laneIndex, bankName) {
    dispatchRawChanges(
      (code, lanes) => {
        const lane = lanes[laneIndex];
        if (!lane) return null;
        return changeForBankSet(lane, bankName, code);
      },
      "input.beat-grid.bank",
    );
    // Preview the lane's primary sound through the new bank so the user
    // hears the change.
    const freshLane = parseDrumLanes(view.state.doc.toString())[laneIndex];
    if (freshLane?.primarySound) {
      previewStep(freshLane, {
        kind: "hit",
        sound: freshLane.primarySound,
        variant: 0,
      });
    }
    announce(
      bankName
        ? `Lane ${laneIndex + 1} bank: ${bankName}`
        : `Lane ${laneIndex + 1} bank cleared`,
    );
    closeMenu();
  }

  // ─── Sound picker menu (lane sound chip) ───────────────────────────────
  function openSoundMenu(laneIndex, anchorEl) {
    closeMenu();
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[laneIndex];
    if (!lane) return;

    const soundMap = getSoundMap?.() ?? {};
    const bank = lane.bank?.name ?? null;
    // Sounds the user is currently authoring with (every distinct hit in
    // this lane) — fastest path to "swap sd→cp" on a mixed-sound row.
    const inLane = [];
    const seenInLane = new Set();
    for (const step of lane.steps) {
      if (step.kind !== "hit" || !step.sound) continue;
      if (seenInLane.has(step.sound)) continue;
      seenInLane.add(step.sound);
      inLane.push(step.sound);
    }
    // All drum sounds available (filtered to known drum prefixes). Prefer
    // banked variants when a bank is set so the picker reflects what the
    // lane will actually play. When the soundMap isn't ready yet (pre-
    // prebake), fall back to the hardcoded kit list so the picker still
    // has something useful to show.
    let drumSounds = gatherDrumSounds(soundMap, bank);
    if (drumSounds.length === 0) {
      drumSounds = ADD_LANE_KIT.map(({ sound }) => ({
        sound,
        displayName: sound,
        sampleCount: 1,
      }));
    }

    const fromSound = lane.primarySound;
    const sections = [];
    if (inLane.length > 1) {
      sections.push({
        heading: "Sounds on this lane",
        items: inLane.map((s) => ({
          label: s,
          current: s === fromSound,
          onPick: () => pickNewLaneSound(laneIndex, s, fromSound),
        })),
      });
    }
    sections.push({
      heading: bank ? `${bank} kit` : "All drums",
      items: drumSounds.map((s) => ({
        label: s.displayName,
        hint: s.sampleCount > 1 ? String(s.sampleCount) : "",
        current: s.sound === fromSound,
        onPick: () => pickNewLaneSound(laneIndex, s.sound, fromSound),
      })),
    });

    const menu = buildListMenu({
      ariaLabel: `Change sound (currently ${fromSound || "—"})`,
      header: fromSound ? `current: ${fromSound}` : "no sound yet",
      sections,
      searchable: true,
    });
    document.body.appendChild(menu);
    positionMenu(menu, anchorEl);
    setOpenMenu({
      el: menu,
      teardown: () => menu.parentNode?.removeChild(menu),
    });
    focusFirstMenuItem(menu);
  }

  function pickNewLaneSound(laneIndex, newSound, fromSound) {
    if (!newSound) return;
    closeMenu();
    // If the lane has no primary sound (all rests), just warn — caller
    // should use the add-lane flow to seed a sound. Unlikely since the
    // picker's trigger is disabled when primarySound is null.
    if (!fromSound) {
      console.warn(
        "[beat-grid] lane has no primary sound to swap — add a hit first",
      );
      return;
    }
    dispatchRawChanges(
      (code, lanes) => {
        const lane = lanes[laneIndex];
        if (!lane) return null;
        return changeForSoundSwap(lane, fromSound, newSound);
      },
      "input.beat-grid.sound",
    );
    // Preview the new sound so the user hears the swap immediately.
    const freshLane = parseDrumLanes(view.state.doc.toString())[laneIndex];
    previewStep(freshLane, {
      kind: "hit",
      sound: newSound,
      variant: 0,
    });
    announce(`Lane ${laneIndex + 1} sound: ${newSound}`);
  }

  // ─── Lane context menu (right-click on a lane row) ─────────────────────
  function openLaneContextMenu(laneIndex, anchorEl, clientPos) {
    closeMenu();
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[laneIndex];
    if (!lane) return;

    const items = [];
    items.push({
      label: "Duplicate lane",
      onPick: () => {
        dispatchRawChanges(
          (code, lanes) => {
            const lane = lanes[laneIndex];
            if (!lane) return null;
            return changeForDuplicateLane(code, lane);
          },
          "input.beat-grid.duplicate",
        );
        closeMenu();
      },
    });

    if (lane.editable && lane.stepCount < 16) {
      const target = lane.stepCount < 8 ? 8 : 16;
      items.push({
        label: `Upgrade to ${target} cells`,
        hint: `×${lane.stepCount} → ×${target}`,
        onPick: () => {
          dispatchRawChanges(
            (code, lanes) => {
              const lane = lanes[laneIndex];
              if (!lane) return null;
              return changeForUpgradeResolution(lane, target);
            },
            "input.beat-grid.upgrade",
          );
          closeMenu();
        },
      });
    }

    if (
      !lane.editable &&
      lane.readOnlyReason === READ_ONLY_REASONS.shortcut
    ) {
      const body = code.slice(lane.stepStart, lane.stepEnd).trim();
      const expanded = expandShortcut(body);
      if (expanded) {
        const count = expanded.split(/\s+/).length;
        items.push({
          label: `Expand to ${count} cells`,
          onPick: () => {
            dispatchRawChanges(
              (code, lanes) => {
                const lane = lanes[laneIndex];
                if (!lane) return null;
                return changeForNormaliseShortcut(lane, code);
              },
              "input.beat-grid.normalise",
            );
            closeMenu();
          },
        });
      }
    }

    items.push({
      label: "Delete lane",
      destructive: true,
      onPick: async () => {
        closeMenu();
        const label = lane.primarySound
          ? `"${lane.primarySound}" lane`
          : "this lane";
        const ok = await confirm({
          title: `Delete ${label}?`,
          message: "This removes the entire $: line from the pattern.",
          confirmLabel: "Delete",
          destructive: true,
        });
        if (!ok) return;
        dispatchRawChanges(
          (code, lanes) => {
            const lane = lanes[laneIndex];
            if (!lane) return null;
            return changeForDeleteLane(code, lane);
          },
          "input.beat-grid.delete",
        );
      },
    });

    const menu = buildListMenu({
      ariaLabel: `Lane actions (${lane.primarySound || "lane"})`,
      header: lane.primarySound ? `lane: ${lane.primarySound}` : "lane",
      sections: [{ heading: null, items }],
    });
    document.body.appendChild(menu);
    if (clientPos) {
      positionMenuAt(menu, clientPos.x, clientPos.y);
    } else {
      positionMenu(menu, anchorEl);
    }
    setOpenMenu({
      el: menu,
      teardown: () => menu.parentNode?.removeChild(menu),
    });
    focusFirstMenuItem(menu);
  }

  function openVariantMenu(laneIndex, stepIndex, anchorEl) {
    closeMenu();
    const code = view.state.doc.toString();
    const lanes = parseDrumLanes(code);
    const lane = lanes[laneIndex];
    if (!lane || !lane.editable) return;
    const step = lane.steps[stepIndex];
    if (!step || step.kind !== "hit" || !step.sound) return;

    const soundMap = getSoundMap?.() ?? {};
    const bank = lane.bank?.name ?? null;
    const count = getSampleCount(soundMap, bank, step.sound);
    const resolvedKey = resolveSoundKey(soundMap, bank, step.sound);

    const menu = document.createElement("div");
    menu.className = "beat-grid__menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Variants for ${step.sound}`);

    const header = document.createElement("div");
    header.className = "beat-grid__menu-header";
    header.textContent = bank
      ? `${step.sound} · ${bank} · ${count} sample${count === 1 ? "" : "s"}`
      : `${step.sound} · ${count} sample${count === 1 ? "" : "s"}`;
    menu.appendChild(header);

    if (!resolvedKey || !soundMap[resolvedKey]) {
      const note = document.createElement("div");
      note.className = "beat-grid__menu-empty";
      note.textContent = "sound not in loaded soundMap";
      menu.appendChild(note);
    } else if (count <= 1) {
      const note = document.createElement("div");
      note.className = "beat-grid__menu-empty";
      note.textContent = "no variants to choose";
      menu.appendChild(note);
    } else {
      for (let n = 0; n < count; n++) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "beat-grid__menu-item";
        item.setAttribute("role", "menuitem");
        const label = n === 0 ? `${step.sound} (0)` : `${step.sound}:${n}`;
        item.textContent = label;
        const currentVariant = step.variant ?? 0;
        if (n === currentVariant) {
          item.classList.add("is-current");
          item.setAttribute("aria-current", "true");
        }
        const auditionN = () => {
          previewStep(lane, { kind: "hit", sound: step.sound, variant: n });
        };
        item.addEventListener("pointerenter", auditionN);
        // Keyboard users get the same audition on focus — so arrow-up/down
        // through the list plays each sample exactly like hover does.
        item.addEventListener("focus", auditionN);
        item.addEventListener("click", (e) => {
          e.preventDefault();
          closeMenu();
          dispatchChange(laneIndex, (freshLane) =>
            changeForVariant(freshLane, stepIndex, n),
          );
          // The dispatched transaction triggers rebuild(); the freshly-
          // parsed step then previews on the audio path (click feedback).
          const freshLane = parseDrumLanes(view.state.doc.toString())[laneIndex];
          previewStep(freshLane, { kind: "hit", sound: step.sound, variant: n });
        });
        menu.appendChild(item);
      }
    }

    document.body.appendChild(menu);
    positionMenu(menu, anchorEl);

    // Keyboard navigation — arrow keys move focus, Enter commits, Home/End
    // jump. The current variant is focused on open so a single Enter
    // re-picks it (harmless) and a single ArrowDown/Up moves from there.
    const items = Array.from(
      menu.querySelectorAll(".beat-grid__menu-item"),
    );
    if (items.length > 0) {
      const currentIdx = items.findIndex((el) =>
        el.classList.contains("is-current"),
      );
      const initialIdx = currentIdx >= 0 ? currentIdx : 0;
      items[initialIdx].focus({ preventScroll: true });
      items[initialIdx].scrollIntoView({ block: "nearest" });
    }

    const onMenuKey = (e) => {
      if (!openMenu || openMenu.el !== menu) return;
      const focused = document.activeElement;
      const idx = items.indexOf(focused);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
        items[next]?.focus({ preventScroll: true });
        items[next]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = idx <= 0 ? items.length - 1 : idx - 1;
        items[next]?.focus({ preventScroll: true });
        items[next]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus({ preventScroll: true });
        items[0]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus({ preventScroll: true });
        items[items.length - 1]?.scrollIntoView({ block: "nearest" });
      }
    };
    menu.addEventListener("keydown", onMenuKey);

    const teardown = () => {
      menu.removeEventListener("keydown", onMenuKey);
      if (menu.parentNode) menu.parentNode.removeChild(menu);
    };
    openMenu = { el: menu, teardown };
  }

  return {
    show() {
      root.hidden = false;
      // Catch up on whatever was typed while the grid was out of sight.
      if (dirty && isShown()) rebuild();
      updatePlayheadVisibility();
    },
    hide() {
      root.hidden = true;
      closeMenu();
      cancelPaintDrag();
      stopPlayhead();
      if (selection) {
        selection = null;
        repaintSelection();
      }
    },
    isVisible() {
      return !root.hidden;
    },
    setPlaybackState,
    rebuild() {
      renderedLanes = null;
      rebuild();
    },
    /** Number of $: drum lanes currently in the buffer (any kind). */
    getLaneCount() {
      return parseDrumLanes(view.state.doc.toString()).length;
    },
  };
}

// ─── Per-lane render ─────────────────────────────────────────────────────

function renderLane(lane, index, code, ctx) {
  const row = document.createElement("div");
  row.className = "beat-grid__lane";
  row.dataset.laneIndex = String(index);
  row.setAttribute("role", "row");
  row.setAttribute("aria-rowindex", String(index + 1));
  if (!lane.editable) row.classList.add("beat-grid__lane--readonly");
  if (lane.muted) row.classList.add("beat-grid__lane--muted");
  if (lane.soloed) row.classList.add("beat-grid__lane--soloed");

  // Right-click anywhere on the lane (outside a button/cell) opens the
  // lane actions menu. Individual cells already capture contextmenu for
  // the variant picker, so this only fires for rail / controls / empty
  // gaps — exactly the UX the spec describes.
  row.addEventListener("contextmenu", (e) => {
    // Let the cells keep their variant menu. But the button-level stopPropagation
    // isn't reliable across browsers, so we explicitly exclude cells here.
    if (e.target.closest(".beat-grid__cell")) return;
    e.preventDefault();
    ctx.openLaneContextMenu(index, row, { x: e.clientX, y: e.clientY });
  });

  // Lane rail: drag handle + sound chip + nickname + step-count chip.
  const rail = document.createElement("div");
  rail.className = "beat-grid__rail";
  rail.setAttribute("role", "rowheader");

  const accent = PALETTE[index % PALETTE.length];
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "beat-grid__lane-dot";
  dot.style.backgroundColor = accent;
  dot.setAttribute("aria-label", `Reorder lane ${index + 1}`);
  dot.title = "Drag to reorder lane";
  dot.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    ctx.startReorderDrag(index, row, e);
  });
  rail.appendChild(dot);

  const railText = document.createElement("div");
  railText.className = "beat-grid__rail-text";

  // Sound chip (click → sound picker). Rendered as a button so keyboard
  // users can tab to it. When the lane has no primary sound (all rests),
  // the trigger stays disabled — there's nothing to swap to/from.
  const soundEl = document.createElement("button");
  soundEl.type = "button";
  soundEl.className = "beat-grid__sound beat-grid__sound--button";
  soundEl.textContent = lane.primarySound || "—";
  soundEl.title = lane.primarySound
    ? `Change sound (currently ${lane.primarySound})`
    : "Lane has no hits — add one first";
  if (!lane.primarySound) soundEl.disabled = true;
  soundEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.openSoundMenu(index, soundEl);
  });
  railText.appendChild(soundEl);

  const nick = nicknameFor(lane.primarySound);
  if (nick) {
    const nickEl = document.createElement("div");
    nickEl.className = "beat-grid__nickname";
    nickEl.textContent = nick;
    railText.appendChild(nickEl);
  }

  rail.appendChild(railText);

  // The step-count chip is only meaningful for editable lanes — on a struct
  // lane the s("…") string usually has 1 token (the sound) and the rhythm
  // lives in `.struct(...)`, so showing "×1" misleads. Same for any other
  // read-only shape where the parsed-step count doesn't reflect the audible
  // rhythm.
  if (
    lane.editable &&
    lane.stepCount &&
    lane.stepCount !== 16 &&
    lane.stepCount > 0
  ) {
    const chip = document.createElement("span");
    chip.className = "beat-grid__step-chip";
    chip.textContent = `×${lane.stepCount}`;
    rail.appendChild(chip);
  }

  row.appendChild(rail);

  // Step grid: editable lanes show interactive cells; read-only lanes
  // show a badge spanning the same horizontal real estate so the visual
  // rhythm of the page stays intact.
  if (lane.editable && lane.steps.length > 0) {
    const grid = document.createElement("div");
    grid.className = "beat-grid__cells";
    grid.style.gridTemplateColumns = `repeat(${lane.stepCount}, 1fr)`;
    // One grid cell holding the lane's steps; each step is a toggle button.
    grid.setAttribute("role", "gridcell");
    grid.setAttribute("aria-label", `${lane.steps.length} steps`);

    // Playhead overlay — hidden until playback starts; tick loop in the
    // mount closure translates it. Appended last so it sits above the
    // cells in the paint order.
    const playhead = document.createElement("div");
    playhead.className = "beat-grid__playhead";
    playhead.setAttribute("aria-hidden", "true");
    playhead.hidden = true;

    for (let i = 0; i < lane.steps.length; i++) {
      grid.appendChild(buildCell(lane, index, i, ctx));
    }
    grid.appendChild(playhead);
    row.appendChild(grid);
  } else {
    // Read-only stripe doubles as a "jump to text" affordance — clicking
    // anywhere on it puts the CM cursor inside the `s("…")` string on
    // that line and focuses the editor. For shortcut lanes we also
    // offer a direct "Expand to N cells" action that normalises the
    // mini-notation in place — the parser then picks up the flat form
    // on the next rebuild and the lane becomes editable.
    const stripe = document.createElement("button");
    stripe.type = "button";
    stripe.className = "beat-grid__stripe";
    stripe.setAttribute(
      "aria-label",
      `Jump to line ${lane.line} to edit as text`,
    );
    stripe.addEventListener("click", () => {
      const view = ctx?.view;
      if (!view) return;
      // The row can outlive the parse it was built from (unchanged rows are
      // kept across edits), so look the lane's offset up now.
      const current = parseDrumLanes(view.state.doc.toString())[index];
      if (!current) return;
      view.dispatch({
        selection: { anchor: current.stepStart, head: current.stepStart },
        scrollIntoView: true,
      });
      view.focus();
    });

    const badgeText = lane.readOnlyReason
      ? READ_ONLY_BADGES[lane.readOnlyReason]?.text || lane.readOnlyReason
      : "read-only";
    const badgeHint = lane.readOnlyReason
      ? READ_ONLY_BADGES[lane.readOnlyReason]?.hint || "edit as text"
      : "edit as text";

    const badge = document.createElement("span");
    badge.className = "beat-grid__badge";
    badge.textContent = badgeText;
    stripe.appendChild(badge);

    // For shortcut lanes (`s("hh*8")`), the actionable next step isn't
    // "open the editor and rewrite this" — it's "expand to N cells and
    // let me click". Offer that as a dedicated action next to the badge
    // so it's discoverable without hunting through a context menu.
    if (lane.readOnlyReason === READ_ONLY_REASONS.shortcut) {
      const body = code.slice(lane.stepStart, lane.stepEnd).trim();
      const expanded = expandShortcut(body);
      if (expanded) {
        const count = expanded.split(/\s+/).length;
        const expandBtn = document.createElement("button");
        expandBtn.type = "button";
        expandBtn.className = "beat-grid__stripe-action";
        expandBtn.textContent = `Expand to ${count} cells`;
        expandBtn.title =
          `Rewrite s("${body}") → s("${expanded.slice(0, 20)}${expanded.length > 20 ? "…" : ""}") so you can toggle cells`;
        expandBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          ctx.dispatchRawChanges(
            (code, lanes) => {
              const l = lanes[index];
              if (!l) return null;
              return changeForNormaliseShortcut(l, code);
            },
            "input.beat-grid.normalise",
          );
        });
        stripe.appendChild(expandBtn);
      }
    }

    const hint = document.createElement("span");
    hint.className = "beat-grid__stripe-hint";
    hint.textContent = badgeHint;
    stripe.appendChild(hint);

    // For read-only lanes that still parsed steps (struct, badStepCount),
    // render a muted preview so the user sees the rhythm without
    // pretending it's editable. Below 3 parsed steps there's no rhythm to
    // preview — a 1-pip stretched across half the stripe reads as a
    // meaningless bar, so we fall through to the code snippet instead.
    // Lanes whose step string is too structurally rich to parse
    // (alternation, subdivision, shortcut) also land in the snippet
    // branch.
    if (lane.steps.length > 0 && lane.stepCount >= 3) {
      const previewWrap = document.createElement("div");
      previewWrap.className = "beat-grid__preview";
      const totalCols = Math.max(lane.stepCount, 1);
      previewWrap.style.gridTemplateColumns = `repeat(${totalCols}, 1fr)`;
      for (let i = 0; i < lane.steps.length; i++) {
        const step = lane.steps[i];
        const cell = document.createElement("span");
        cell.className = "beat-grid__preview-cell";
        if (step.kind === "hit") {
          cell.classList.add("beat-grid__preview-cell--on");
        }
        previewWrap.appendChild(cell);
      }
      stripe.appendChild(previewWrap);
    } else if (code) {
      const raw = code.slice(lane.stepStart, lane.stepEnd).trim();
      if (raw) {
        const snippet = document.createElement("code");
        snippet.className = "beat-grid__snippet";
        snippet.textContent = `"${raw}"`;
        snippet.title = raw;
        stripe.appendChild(snippet);
      }
    }
    // The stripe is a button, and a row may only own cells: give it a
    // cell to sit in. `display: contents` (beat-grid.css) keeps the stripe
    // itself as the lane's grid item, so the layout is unchanged.
    const stripeCell = document.createElement("div");
    stripeCell.className = "beat-grid__stripe-cell";
    stripeCell.setAttribute("role", "gridcell");
    stripeCell.appendChild(stripe);
    row.appendChild(stripeCell);
  }

  // Controls column: bank picker + M/S toggles. All clickable in Phase 3.
  const controls = document.createElement("div");
  controls.className = "beat-grid__controls";
  controls.setAttribute("role", "gridcell");

  const bankChip = document.createElement("button");
  bankChip.type = "button";
  bankChip.className = "beat-grid__bank beat-grid__bank--button";
  bankChip.textContent = lane.bank ? shortenBank(lane.bank.name) : "—";
  bankChip.title = lane.bank
    ? `bank("${lane.bank.name}") — click to change`
    : "no bank — click to pick a drum machine";
  if (!lane.bank) bankChip.classList.add("beat-grid__bank--empty");
  bankChip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.openBankMenu(index, bankChip);
  });
  controls.appendChild(bankChip);

  const states = document.createElement("span");
  states.className = "beat-grid__states";
  const muteBtn = buildLabelStateButton(
    "M",
    lane.muted,
    "muted",
    `${lane.muted ? "Unmute" : "Mute"} lane`,
    () => {
      const ok = ctx.dispatchRawChanges(
        (code, lanes) => {
          const l = lanes[index];
          if (!l) return null;
          return changeForMuteToggle(l);
        },
        "input.beat-grid.mute",
      );
      if (ok) ctx.announceLaneState?.(index, "mute");
    },
  );
  states.appendChild(muteBtn);
  const soloBtn = buildLabelStateButton(
    "S",
    lane.soloed,
    "soloed",
    `${lane.soloed ? "Unsolo" : "Solo"} lane`,
    () => {
      const ok = ctx.dispatchRawChanges(
        (code, lanes) => {
          const l = lanes[index];
          if (!l) return null;
          return changeForSoloToggle(l);
        },
        "input.beat-grid.solo",
      );
      if (ok) ctx.announceLaneState?.(index, "solo");
    },
  );
  states.appendChild(soloBtn);
  controls.appendChild(states);

  row.appendChild(controls);

  return row;
}

// One step of an editable lane: a toggle button. Built on its own so a
// single flipped step can be swapped without re-rendering its lane.
function buildCell(lane, laneIndex, i, ctx) {
  const step = lane.steps[i];
  const quarterEvery = lane.stepCount / 4; // 1, 2, or 4
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "beat-grid__cell";
  cell.dataset.stepIndex = String(i);
  // Roving tabindex — the mount closure flips exactly one cell to
  // tabindex=0 after render, so the grid is a single Tab stop and the arrow
  // keys move within it.
  cell.setAttribute("tabindex", "-1");
  cell.setAttribute("aria-pressed", step.kind === "hit" ? "true" : "false");
  cell.style.setProperty("--cell-accent", PALETTE[laneIndex % PALETTE.length]);

  if (step.kind === "hit") {
    cell.classList.add("beat-grid__cell--on");

    // When the cell's sound differs from the lane's primary sound (a
    // mixed-sound row like `bd:2 sd:1 bd:2 sd:1 …`), show the actual
    // sound name in the cell so the visual rhythm reflects what's
    // audible. Otherwise the cell silently looks "the same as the
    // others" — silent failure of the kind CLAUDE.md flags.
    const isOff = lane.primarySound && step.sound !== lane.primarySound;
    if (isOff) {
      cell.classList.add("beat-grid__cell--off-sound");
      cell.dataset.sound = step.sound;
      const soundLabel = document.createElement("span");
      soundLabel.className = "beat-grid__cell-sound";
      soundLabel.textContent = step.sound;
      cell.appendChild(soundLabel);
    }

    if (step.variant != null && step.variant > 0) {
      cell.classList.add("beat-grid__cell--variant");
      cell.dataset.variant = String(step.variant);
      const tag = document.createElement("span");
      tag.className = "beat-grid__variant-tag";
      tag.textContent = String(step.variant);
      cell.appendChild(tag);
    }
    const variantSuffix = step.variant != null ? `:${step.variant}` : "";
    cell.setAttribute(
      "aria-label",
      `Step ${i + 1}: ${step.sound}${variantSuffix}`,
    );
  } else {
    cell.setAttribute("aria-label", `Step ${i + 1}: rest`);
  }
  if ((i + 1) % quarterEvery === 0 && i < lane.steps.length - 1) {
    cell.classList.add("beat-grid__cell--quarter-end");
  }
  if (i % quarterEvery === 0 && i > 0) {
    cell.classList.add("beat-grid__cell--quarter-start");
  }

  wireCellInteractions(cell, laneIndex, i, ctx);
  return cell;
}

function buildLabelStateButton(letter, active, stateClass, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "beat-grid__state beat-grid__state--button";
  btn.textContent = letter;
  btn.title = title;
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  if (active) btn.classList.add(`beat-grid__state--${stateClass}`);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// ─── Cell interaction wiring ──────────────────────────────────────────────

function wireCellInteractions(cell, laneIndex, stepIndex, ctx) {
  // Focus tracking — any focus-in (mouse, arrow key, Tab) updates the
  // mount closure's focusedCell so keyboard actions and announcements
  // know which cell is active.
  cell.addEventListener("focus", () => {
    ctx.setFocusedCell?.({ laneIndex, stepIndex });
  });

  // Plain click → toggle. Alt → cycle variant. Shift is handled through
  // pointer events so drag-paint captures pointerenter moves before click
  // fires on pointerup.
  cell.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    if (e.shiftKey) return; // paint committed on document pointerup
    if (e.altKey) {
      handleAltCycle(laneIndex, stepIndex, ctx);
      return;
    }
    handleToggle(laneIndex, stepIndex, ctx);
  });

  cell.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ctx.openVariantMenu(laneIndex, stepIndex, cell);
  });

  // Shift+pointerdown starts a drag-paint session; subsequent pointerenter
  // events over sibling cells accumulate into the stroke. The stroke
  // commits on document pointerup.
  cell.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!e.shiftKey) return;
    e.preventDefault(); // prevent focus ring + text selection during drag
    ctx.startPaintDrag(laneIndex, stepIndex, cell);
  });
  cell.addEventListener("pointerenter", () => {
    const drag = ctx.getPaintDrag();
    if (!drag) return;
    ctx.extendPaintDrag(laneIndex, stepIndex, cell);
  });
}

function handleToggle(laneIndex, stepIndex, ctx) {
  const code = ctx.view.state.doc.toString();
  const lanes = parseDrumLanes(code);
  const lane = lanes[laneIndex];
  if (!lane || !lane.editable) return;
  const step = lane.steps[stepIndex];
  if (!step) return;

  if (step.kind === "hit") {
    ctx.dispatchChange(laneIndex, (l) => changeForCellOff(l, stepIndex));
    ctx.announce?.(`Step ${stepIndex + 1} off`);
    return;
  }
  // Turning on: prefer the lane's primary sound (existing hits). For an
  // all-rest lane we seed with "bd" — universal drum-kit kick, present
  // in every bank shipped by Strudel (TR-*, AkaiLinn, CasioRZ1, etc.)
  // so the first click always produces an audible hit. The user can
  // swap the sound afterwards via the lane's sound chip (now enabled
  // because the lane has a primarySound).
  const fallbackSound = lane.primarySound ? undefined : "bd";
  const ok = ctx.dispatchChange(laneIndex, (l) =>
    changeForCellOn(l, stepIndex, fallbackSound ? { sound: fallbackSound } : {}),
  );
  if (!ok) return; // shouldn't reach — fallbackSound always resolves
  // Preview the sample now that the buffer has been updated.
  const freshLane = parseDrumLanes(ctx.view.state.doc.toString())[laneIndex];
  const freshStep = freshLane?.steps?.[stepIndex];
  ctx.previewStep(freshLane, freshStep);
  if (freshStep?.kind === "hit") {
    ctx.announce?.(`Step ${stepIndex + 1} on: ${freshStep.sound}`);
  }
}

function handleAltCycle(laneIndex, stepIndex, ctx) {
  const code = ctx.view.state.doc.toString();
  const lanes = parseDrumLanes(code);
  const lane = lanes[laneIndex];
  if (!lane || !lane.editable) return;
  const step = lane.steps[stepIndex];
  if (!step || step.kind !== "hit" || !step.sound) return;

  const soundMap = ctx.getSoundMap?.() ?? {};
  const bank = lane.bank?.name ?? null;
  const count = getSampleCount(soundMap, bank, step.sound);
  const maxVariant = Math.max(0, count - 1);

  ctx.dispatchChange(laneIndex, (l) =>
    changeForCycleVariant(l, stepIndex, maxVariant),
  );
  const freshLane = parseDrumLanes(ctx.view.state.doc.toString())[laneIndex];
  const freshStep = freshLane?.steps?.[stepIndex];
  ctx.previewStep(freshLane, freshStep);
  if (freshStep?.kind === "hit") {
    const label = freshStep.variant != null
      ? `${freshStep.sound}:${freshStep.variant}`
      : freshStep.sound;
    ctx.announce?.(`Step ${stepIndex + 1} variant: ${label}`);
  }
}

// ─── Menu positioning ─────────────────────────────────────────────────────

function positionMenu(menu, anchor) {
  // Rendered off-screen first so we can read its measured size.
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 4;

  // Prefer below-left; flip to above when there's no headroom below.
  let left = rect.left;
  let top = rect.bottom + gap;
  if (top + menuRect.height > vh) {
    top = Math.max(gap, rect.top - menuRect.height - gap);
  }
  if (left + menuRect.width > vw) {
    left = Math.max(gap, vw - menuRect.width - gap);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = "";
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function nicknameFor(sound) {
  if (!sound) return "";
  if (SOUND_NICKNAMES[sound]) return SOUND_NICKNAMES[sound];
  // Try common prefixes — e.g. "bd_acoustic" → "kick".
  for (const key of Object.keys(SOUND_NICKNAMES)) {
    if (sound.startsWith(`${key}_`)) return SOUND_NICKNAMES[key];
  }
  return "";
}

// Drum-bank names tend to have a brand prefix the user already knows
// (RolandTR909, RolandTR808, …). Show the model number when we recognise
// one; otherwise the first six chars so the chip stays compact.
function shortenBank(name) {
  if (!name) return "—";
  const m = /(?:Roland|Korg|Akai|Casio|Linn|Doepfer|EMU|Yamaha)([A-Za-z0-9]+)/i.exec(name);
  if (m) return m[1].toUpperCase().replace(/^TR/, "");
  return name.length <= 8 ? name : name.slice(0, 7) + "…";
}

// ─── Shared menu builder ─────────────────────────────────────────────────
// Renders a section-grouped list menu with header, optional search box,
// and click-to-pick items. Shared by the bank picker, sound picker, and
// lane context menu so their look/feel stays consistent without each
// caller re-implementing keyboard navigation and hover styles.

function buildListMenu({ ariaLabel, header, sections, searchable = false }) {
  const menu = document.createElement("div");
  menu.className = "beat-grid__menu beat-grid__menu--list";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", ariaLabel || "Menu");

  if (header) {
    const headerEl = document.createElement("div");
    headerEl.className = "beat-grid__menu-header";
    headerEl.textContent = header;
    menu.appendChild(headerEl);
  }

  /** @type {HTMLInputElement | null} */
  let searchEl = null;
  if (searchable) {
    searchEl = document.createElement("input");
    searchEl.type = "text";
    searchEl.className = "beat-grid__menu-search";
    searchEl.placeholder = "Search…";
    searchEl.spellcheck = false;
    searchEl.autocomplete = "off";
    menu.appendChild(searchEl);
  }

  const body = document.createElement("div");
  body.className = "beat-grid__menu-body";
  menu.appendChild(body);

  const itemEls = [];
  for (const section of sections) {
    if (section.heading) {
      const heading = document.createElement("div");
      heading.className = "beat-grid__menu-heading";
      heading.textContent = section.heading;
      body.appendChild(heading);
    }
    for (const item of section.items) {
      if (!item) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "beat-grid__menu-item";
      if (item.current) {
        btn.classList.add("is-current");
        btn.setAttribute("aria-current", "true");
      }
      if (item.destructive) {
        btn.classList.add("beat-grid__menu-item--destructive");
      }
      btn.setAttribute("role", "menuitem");
      const labelEl = document.createElement("span");
      labelEl.className = "beat-grid__menu-item-label";
      labelEl.textContent = item.label;
      btn.appendChild(labelEl);
      if (item.hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "beat-grid__menu-item-hint";
        hintEl.textContent = item.hint;
        btn.appendChild(hintEl);
      }
      btn.dataset.menuLabel = (item.label || "").toLowerCase();
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        item.onPick?.();
      });
      body.appendChild(btn);
      itemEls.push(btn);
    }
  }

  // Keyboard nav: Arrow up/down move focus, Enter commits the focused
  // item, Escape bubbles up to the document listener (which closes).
  const focusables = () =>
    Array.from(body.querySelectorAll(".beat-grid__menu-item"))
      .filter((el) => !el.hidden);
  const moveFocus = (delta) => {
    const list = focusables();
    if (list.length === 0) return;
    const cur = document.activeElement;
    const idx = list.indexOf(cur);
    const next =
      idx < 0
        ? delta > 0 ? 0 : list.length - 1
        : (idx + delta + list.length) % list.length;
    list[next]?.focus({ preventScroll: true });
    list[next]?.scrollIntoView({ block: "nearest" });
  };
  menu.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(+1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "Enter" && document.activeElement?.click) {
      // Default button behaviour; we just ensure focus stays on the menu.
    }
  });

  // Search filter — hide items whose label doesn't contain the query.
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      const q = searchEl.value.trim().toLowerCase();
      for (const el of itemEls) {
        const label = el.dataset.menuLabel || "";
        el.hidden = q ? !label.includes(q) : false;
      }
    });
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveFocus(+1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const list = focusables();
        list[0]?.click();
      }
    });
  }

  return menu;
}

function positionMenuAt(menu, clientX, clientY) {
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const menuRect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 4;

  let left = clientX;
  let top = clientY;
  if (left + menuRect.width > vw) left = Math.max(gap, vw - menuRect.width - gap);
  if (top + menuRect.height > vh) top = Math.max(gap, vh - menuRect.height - gap);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = "";
}

function focusFirstMenuItem(menu) {
  // Prefer the search input when the menu has one — keeps typing-first
  // UX. Otherwise focus the first/current item.
  const search = menu.querySelector(".beat-grid__menu-search");
  if (search) {
    search.focus({ preventScroll: true });
    return;
  }
  const current = menu.querySelector(".beat-grid__menu-item.is-current");
  const first = current || menu.querySelector(".beat-grid__menu-item");
  first?.focus({ preventScroll: true });
  first?.scrollIntoView({ block: "nearest" });
}

// ─── Drum-sound harvesting for the sound picker ──────────────────────────

function gatherDrumSounds(soundMap, bank) {
  if (!soundMap) return [];
  const acc = new Map(); // sound (suffix) → { sound, displayName, sampleCount }
  for (const [key, entry] of Object.entries(soundMap)) {
    const suffix = splitBankSuffix(key);
    if (!suffix) continue;
    if (!isDrumIdent(suffix)) continue;
    // Prefer the banked entry when a bank is set. In the unbanked case
    // we rank "kit-free" keys highest so `bd` beats `RolandTR909_bd`.
    const thisBank = key.slice(0, key.length - suffix.length - 1) || null;
    const score = scoreSoundForBank(thisBank, bank);
    const existing = acc.get(suffix);
    if (existing && existing.score >= score) continue;
    const data = entry?.data ?? {};
    const sampleCount = Array.isArray(data.samples)
      ? data.samples.length
      : typeof data.samples === "object" && data.samples != null
        ? Object.values(data.samples).reduce(
            (n, v) => n + (Array.isArray(v) ? v.length : 1),
            0,
          )
        : 1;
    acc.set(suffix, {
      sound: suffix,
      displayName: suffix,
      sampleCount,
      score,
    });
  }
  const out = [...acc.values()];
  out.sort((a, b) => {
    // Prefer the standard DRUM_ORDER-ish sort: kick, snare, hat, etc.
    const ia = DRUM_PRIORITY.indexOf(a.sound);
    const ib = DRUM_PRIORITY.indexOf(b.sound);
    if (ia !== ib) {
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    }
    return a.sound.localeCompare(b.sound);
  });
  return out;
}

function splitBankSuffix(key) {
  // Either a bare sound ("bd") or `bank_suffix` ("RolandTR909_bd"). We
  // treat the portion after the last `_` as the suffix when it matches a
  // drum ident; otherwise the full key is the ident.
  if (typeof key !== "string" || !key) return null;
  const idx = key.lastIndexOf("_");
  if (idx <= 0) return key;
  const suffix = key.slice(idx + 1);
  return suffix || null;
}

function isDrumIdent(name) {
  if (!name) return false;
  if (DRUM_PREFIXES.has(name)) return true;
  // Fuzzy tail-match: names like `bd_acoustic` still count as a kick.
  for (const p of DRUM_PREFIXES) {
    if (name.startsWith(`${p}_`)) return true;
  }
  return false;
}

function scoreSoundForBank(thisBank, pickedBank) {
  // Higher is better.
  if (pickedBank && thisBank === pickedBank) return 3;
  if (!pickedBank && !thisBank) return 3;
  if (!thisBank) return 2; // bare sound always usable
  return 1;
}

const DRUM_PRIORITY = [
  "bd", "kick",
  "sd", "snare",
  "rim",
  "cp", "clap",
  "hh", "ch", "oh", "ho",
  "cy", "cr", "crash", "rd", "ride",
  "cb",
  "lt", "mt", "ht", "tom",
  "perc", "shake", "shaker", "sh",
  "conga", "bongo", "tabla",
];

// ─── "+ Add drum" button builder ─────────────────────────────────────────

function buildAddLaneButton(ctx, { variant = "ghost" } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `beat-grid__add-btn beat-grid__add-btn--${variant}`;
  btn.textContent = "+ Add drum";
  btn.setAttribute("aria-label", "Add a drum lane");
  btn.title = "Insert a new $: drum lane";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.openAddLaneMenu(btn);
  });
  return btn;
}

function addLane(ctx, sound, bank) {
  const text = buildAddLaneText(sound, bank);
  if (!text) return;
  ctx.dispatchRawChanges(
    (code, lanes) => changeForAddLane(code, lanes, text),
    "input.beat-grid.add-lane",
  );
}
