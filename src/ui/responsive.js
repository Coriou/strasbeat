// Responsive layout decisions shared by the two rails. The breakpoints mirror
// the media queries in src/styles/shell.css — change them together.
//
//   docked   ≥ 900px   rails are grid columns beside the editor
//   overlay  600–899   rails collapse to their 36px strips; an opened rail
//                      floats over the editor instead of squeezing it
//   compact  < 600px   as overlay, and the collapsed left strip is hidden
//                      (the top bar's pattern button opens the library)
//
// The persisted "rail open" flag is a docked-layout preference. A narrow
// viewport never reads it (a rail left open on a desktop must not cover the
// editor on a phone) and never writes it (closing an overlay on a phone must
// not close the rail on the desktop).

export const OVERLAY_MAX_WIDTH = 900;
export const COMPACT_MAX_WIDTH = 600;
export const NARROW_QUERY = `(max-width: ${OVERLAY_MAX_WIDTH - 0.02}px)`;

/** @returns {"docked" | "overlay" | "compact"} */
export function layoutMode(width) {
  if (!(width >= COMPACT_MAX_WIDTH)) return "compact";
  if (width < OVERLAY_MAX_WIDTH) return "overlay";
  return "docked";
}

/** Whether a rail should be open, given the stored preference and viewport. */
export function resolveRailExpanded({ storedExpanded, narrow }) {
  if (narrow) return false;
  return storedExpanded === true;
}

/**
 * The value to persist for "rail open" after a change. On a narrow viewport
 * the stored (docked) preference is carried through untouched.
 */
export function expandedToPersist({ expanded, narrow, storedExpanded }) {
  return narrow ? storedExpanded === true : expanded === true;
}

/**
 * Track the narrow-viewport media query. `onChange(narrow)` fires when the
 * viewport crosses the breakpoint. Without matchMedia (tests, very old
 * browsers) the layout is treated as docked.
 */
export function watchNarrow(onChange = () => {}) {
  const mq =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_QUERY)
      : null;
  const listener = (e) => onChange(e.matches);
  mq?.addEventListener?.("change", listener);
  return {
    isNarrow: () => mq?.matches === true,
    dispose: () => mq?.removeEventListener?.("change", listener),
  };
}

// ─── Right-rail width cap ────────────────────────────────────────────────
// The same arithmetic as the right rail's track in shell.css: docked, the
// editor keeps --editor-min-w; floating, a strip of canvas stays visible
// beside the rail (--target-min + --space-1). Change them together.
export const EDITOR_MIN_WIDTH = 360;
export const OVERLAY_GUTTER = 44;

/**
 * The widest the right rail's panel (the part beside its tab strip) can be
 * drawn at this viewport, whatever width is stored.
 */
export function rightRailMaxPanelWidth({
  viewportWidth,
  leftRailWidth,
  tabsWidth,
}) {
  const room =
    layoutMode(viewportWidth) === "docked"
      ? viewportWidth - leftRailWidth - EDITOR_MIN_WIDTH
      : viewportWidth - OVERLAY_GUTTER;
  return Math.max(0, room - tabsWidth);
}

/**
 * The panel width a resize drag produces. It starts from the width that is
 * actually on screen (the stored one may be wider than this viewport
 * allows) and stops at the same cap, so the handle never moves without the
 * panel following. A press with no movement keeps the stored width.
 */
export function resizedRailWidth({ stored, dx, min, max, cap }) {
  if (dx === 0) return stored;
  const ceiling = Math.max(min, Math.min(max, cap));
  const next = Math.round(Math.min(stored, cap) + dx);
  return Math.max(min, Math.min(ceiling, next));
}

// ─── Escape on a floating rail ───────────────────────────────────────────

/**
 * Whether a keydown should close a rail that is floating over the editor.
 * Anything that claimed the key first (a modal, the command palette, a
 * completion popup, an inline rename, a menu, a search field with text to
 * clear) wins, and with both rails open Escape closes the one focus is in.
 */
export function railTakesEscape({
  key,
  defaultPrevented,
  narrow,
  open,
  layerOpen = false,
  focusInOtherRail = false,
}) {
  if (key !== "Escape" || defaultPrevented) return false;
  if (!narrow || !open) return false;
  return !layerOpen && !focusInOtherRail;
}

/** Layers that sit above a floating rail and take Escape before it. */
export const ESCAPE_LAYER_SELECTOR =
  ".modal-overlay, .left-rail__context-menu, .cm-tooltip-autocomplete";

/**
 * Where focus goes when a rail closes: the first candidate that can take
 * it. `usable` says whether an element is still in the page and rendered.
 */
export function pickFocusReturn(candidates, usable) {
  return candidates.find((c) => c != null && usable(c)) ?? null;
}

/** An element that is attached and not `display: none`. */
export function isRendered(node) {
  return node?.isConnected === true && node.getClientRects().length > 0;
}
