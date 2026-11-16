// Right rail — generic tabbed panel host on the right side of the editor.
//
// Mirrors the left rail's role (a column flush against the canvas) but
// holds *content panels* (sound browser, future API reference, console,
// export, settings) rather than a single collection. Each panel is a
// self-contained module that registers itself with the rail; the rail
// owns the chrome (vertical tab strip on the inner edge, collapse/expand,
// drag-resize, persistence) and routes activate/deactivate to the
// currently-visible panel. See design/work/08-feature-parity-and-beyond.md
// and design/SYSTEM.md §3.
//
// Public surface:
//
//   const rail = mountRightRail({
//     container,        // <aside class="right-rail">
//     tabsContainer,    // <nav class="right-rail__tabs">
//     panelContainer,   // <div class="right-rail__panel">
//     resizeHandle,     // <div class="right-rail__resize">
//     storageKey,       // localStorage key (default 'strasbeat:right-rail')
//     onFocusEditor,    // called when Escape returns focus to the editor
//   });
//
//   rail.registerPanel({
//     id:        'sounds',
//     icon:      'music',  // lucide name (must exist in src/ui/icons.js)
//     label:     'Sounds',
//     create:    (container) => { /* build DOM into container */ },
//     activate:  ({ focus }) => {},  // optional — called when tab is selected;
//                                    // `focus` is false when the rail is only
//                                    // restoring last session's tab at boot
//     deactivate:() => {},  // optional — called when tab is deselected
//   });
//
//   rail.activate('sounds');     // open the panel by id (and focus it;
//                                // pass { focus: false } not to)
//   rail.toggle();               // collapse <-> expand
//   rail.expand();
//   rail.collapse();
//   rail.isExpanded();
//
// Persistence — the active tab id, expanded/collapsed flag, and panel
// width are written to localStorage under `storageKey`. Restored on
// mount: the stored tab is activated when its panel registers, without
// taking keyboard focus. A stored id that no panel claims falls back to the
// first registered panel once the registration pass is over.
//
// Narrow viewports (src/ui/responsive.js) — below the breakpoint an open
// rail floats over the editor instead of sitting beside it (shell.css). The
// stored expanded flag is a wide-layout preference there: the rail always
// starts collapsed, opens only when the user asks, closes again on Escape
// or a tap on the scrim, and none of that is written back.
//
// Pure DOM, no framework. Tab buttons are rebuilt on every register
// call so the order matches registration order.

import { makeIcon } from './icons.js';
import {
  watchNarrow,
  resolveRailExpanded,
  expandedToPersist,
  rightRailMaxPanelWidth,
  resizedRailWidth,
  railTakesEscape,
  pickFocusReturn,
  isRendered,
  ESCAPE_LAYER_SELECTOR,
} from './responsive.js';

const DEFAULT_STORAGE_KEY = 'strasbeat:right-rail';
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const TABS_W = 36; // matches --right-rail-tabs-w in tokens.css

export function mountRightRail({
  container,
  tabsContainer,
  panelContainer,
  resizeHandle,
  storageKey = DEFAULT_STORAGE_KEY,
  onFocusEditor = () => {},
}) {
  if (!container) throw new Error('right-rail.mount: container is required');
  if (!tabsContainer) throw new Error('right-rail.mount: tabsContainer is required');
  if (!panelContainer) throw new Error('right-rail.mount: panelContainer is required');

  // ─── State ────────────────────────────────────────────────────────────
  const stored = readStored(storageKey);
  // What the user chose on a wide layout — the value that gets persisted.
  let preferredExpanded = stored?.expanded === true;
  const narrow = watchNarrow((isNarrow) => {
    const want = resolveRailExpanded({
      storedExpanded: preferredExpanded,
      narrow: isNarrow,
    });
    if (want === expanded) return;
    // The viewport changed, not the user's mind: opening takes no focus
    // (closing still moves it out of a panel that is about to be hidden).
    if (want) expand({ focus: false });
    else collapse();
  });
  let expanded = resolveRailExpanded({
    storedExpanded: preferredExpanded,
    narrow: narrow.isNarrow(),
  });
  let widthPx = clampWidth(stored?.width ?? DEFAULT_WIDTH);
  let activeId = stored?.activeId ?? null;
  let openerEl = null;

  /** @type {Map<string, {id, icon, label, create, activate, deactivate, tabBtn, mounted}>} */
  const panels = new Map();
  const panelOrder = []; // insertion order — drives tab strip layout
  let fallbackScheduled = false;

  // The tabpanel is named by whichever tab currently owns it.
  if (!panelContainer.id) panelContainer.id = 'right-rail-panel';

  // Apply initial width to the shell so the grid column is correct on
  // first paint. The grid var lives on .shell (the parent), so write to
  // the closest ancestor; fall back to :root if none found.
  const shellEl = container.closest('.shell') ?? document.documentElement;
  applyShellWidth();
  syncCollapsedAttr();

  // ─── Resize handle ────────────────────────────────────────────────────
  // Drag the inner-edge handle horizontally to grow/shrink the panel.
  // Only meaningful when expanded; while collapsed the handle is disabled
  // by CSS (pointer-events: none on [data-collapsed="true"]).
  let dragStartX = null;
  let dragStartWidth = null;
  let dragCap = MAX_WIDTH;
  if (resizeHandle) {
    resizeHandle.addEventListener('pointerdown', (e) => {
      if (!expanded) return;
      dragStartX = e.clientX;
      dragStartWidth = widthPx;
      // The track is capped by the viewport (shell.css); drag within what is
      // actually drawn, or the handle would move through a dead zone first.
      dragCap = rightRailMaxPanelWidth({
        viewportWidth: window.innerWidth,
        leftRailWidth: leftRailTrackWidth(),
        tabsWidth: TABS_W,
      });
      resizeHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
      document.body.style.cursor = 'ew-resize';
      document.addEventListener('pointerup', endDrag);
      document.addEventListener('pointercancel', endDrag);
    });
    resizeHandle.addEventListener('pointermove', (e) => {
      if (dragStartX == null) return;
      // Dragging left = bigger panel (panel is on the right edge of the page).
      const dx = dragStartX - e.clientX;
      widthPx = resizedRailWidth({
        stored: dragStartWidth,
        dx,
        min: MIN_WIDTH,
        max: MAX_WIDTH,
        cap: dragCap,
      });
      applyShellWidth();
    });
    const endDrag = (e) => {
      if (dragStartX == null) return;
      dragStartX = null;
      document.body.style.cursor = '';
      if (e?.pointerId != null && resizeHandle.hasPointerCapture?.(e.pointerId)) {
        resizeHandle.releasePointerCapture(e.pointerId);
      }
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
      saveState();
    };
    resizeHandle.addEventListener('pointerup', endDrag);
    resizeHandle.addEventListener('pointercancel', endDrag);
    // Double-click resets to the default width.
    resizeHandle.addEventListener('dblclick', () => {
      widthPx = DEFAULT_WIDTH;
      applyShellWidth();
      saveState();
    });
  }

  // ─── Keyboard: Escape returns focus to the editor ─────────────────────
  // A panel that consumed the key itself (first Escape clears its search
  // field) calls preventDefault(); only an unclaimed Escape leaves the rail.
  panelContainer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      // Floating over the editor, the panel is in the way of where focus is
      // going — close it. collapse() moves focus out of the panel itself.
      if (narrow.isNarrow()) collapse();
      else onFocusEditor();
    }
  });

  // Floating over the editor, Escape closes the rail from anywhere — its tab
  // strip, the editor underneath — unless something above it claimed the key.
  // Listening on window (bubble) puts this after every other handler.
  window.addEventListener('keydown', (e) => {
    const otherRail = document.activeElement?.closest?.('.left-rail');
    if (
      !railTakesEscape({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        narrow: narrow.isNarrow(),
        open: expanded,
        layerOpen: document.querySelector(ESCAPE_LAYER_SELECTOR) != null,
        focusInOtherRail: otherRail != null,
      })
    ) {
      return;
    }
    e.preventDefault();
    collapse();
  });

  // A tap on the scrim beside the floating rail (the editor pane's own box,
  // not anything inside it — see shell.css) closes it.
  const paneEl = shellEl.querySelector?.('.editor-pane');
  paneEl?.addEventListener?.('pointerdown', (e) => {
    if (e.target === paneEl && narrow.isNarrow()) collapse();
  });

  // ─── Keyboard: arrow keys move between tabs (vertical tablist) ────────
  tabsContainer.addEventListener('keydown', (e) => {
    const tabs = panelOrder.map((id) => panels.get(id).tabBtn);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    tabs[next].focus();
  });

  // ─── Public API ───────────────────────────────────────────────────────

  function registerPanel(spec) {
    if (!spec || !spec.id) throw new Error('right-rail.registerPanel: id is required');
    if (panels.has(spec.id)) {
      console.warn(`[right-rail] panel "${spec.id}" already registered — replacing`);
      panelOrder.splice(panelOrder.indexOf(spec.id), 1);
    }
    const panel = {
      id: spec.id,
      icon: spec.icon ?? 'plus',
      label: spec.label ?? spec.id,
      create: spec.create ?? (() => {}),
      activate: spec.activate ?? (() => {}),
      deactivate: spec.deactivate ?? (() => {}),
      tabBtn: null,
      mounted: false,
      // Each panel renders into its own slot under panelContainer so we
      // don't tear down DOM (and lose state) when switching tabs.
      slot: null,
    };
    panels.set(panel.id, panel);
    panelOrder.push(panel.id);
    rebuildTabs();

    // Decide whether this newly-registered panel should become the live
    // tab. Three cases:
    //   - no active tab yet → adopt this one
    //   - persisted active tab points at *this* panel → activate it
    //   - persisted active tab points at a panel that isn't registered
    //     yet → wait. It usually registers later in the same pass; if it
    //     never does (old build, renamed panel) the deferred check below
    //     falls back to the first panel rather than leave the rail empty.
    // Restoring never takes keyboard focus: the page has only just loaded
    // and the user didn't ask for the panel.
    if (activeId == null) {
      activeId = panel.id;
      if (expanded) doActivate(panel.id, { focus: false });
    } else if (activeId === panel.id) {
      if (expanded) doActivate(panel.id, { focus: false });
    } else if (!panels.has(activeId) && !fallbackScheduled) {
      fallbackScheduled = true;
      queueMicrotask(resolveUnknownActive);
    }
    return panel;
  }

  function resolveUnknownActive() {
    fallbackScheduled = false;
    if (activeId != null && panels.has(activeId)) return;
    if (panelOrder.length === 0) return;
    activeId = panelOrder[0];
    if (expanded) doActivate(activeId, { focus: false });
  }

  // `focus: false` opens the panel without moving keyboard focus into it —
  // for opens the user didn't ask for (the first-run Learn panel).
  function activate(id, { focus = true } = {}) {
    if (!panels.has(id)) {
      console.warn(`[right-rail] activate: unknown panel "${id}"`);
      return;
    }
    if (!expanded && !focus && narrow.isNarrow()) {
      // An open the user didn't ask for would cover the editor here. Keep
      // the tab as the one their first tap on the strip brings up.
      activeId = id;
      saveState();
      return;
    }
    if (!expanded) {
      rememberOpener();
      expanded = true;
      syncCollapsedAttr();
      applyShellWidth();
    } else if (activeId === id) {
      // Already active — make sure focus moves into the panel for
      // keyboard nav (matches VSCode's "Cmd+B then arrow keys" flow).
      const slot = panels.get(id).slot;
      if (slot && focus) focusFirstFocusable(slot);
      return;
    }
    doActivate(id, { focus });
  }

  function toggle() {
    if (expanded) collapse();
    else expand();
  }

  function expand({ focus = true } = {}) {
    if (expanded) return;
    rememberOpener();
    expanded = true;
    syncCollapsedAttr();
    applyShellWidth();
    if ((activeId == null || !panels.has(activeId)) && panelOrder.length > 0) {
      activeId = panelOrder[0];
    }
    if (activeId) doActivate(activeId, { focus });
    saveState();
  }

  function collapse() {
    if (!expanded) return;
    expanded = false;
    // Deactivate the current panel so it can stop any work (timers,
    // listeners) until reopened.
    if (activeId && panels.has(activeId)) {
      const panel = panels.get(activeId);
      try { panel.deactivate(); }
      catch (err) { console.warn('[right-rail] deactivate failed:', err); }
      // A collapsed rail has no selected tab — the strip is just launchers.
      if (panel.tabBtn) {
        panel.tabBtn.classList.remove('is-active');
        panel.tabBtn.setAttribute('aria-selected', 'false');
      }
    }
    // The panel is about to become invisible; don't strand keyboard focus
    // on an element inside it.
    const hadFocus = panelContainer.contains(document.activeElement);
    syncCollapsedAttr();
    applyShellWidth();
    saveState();
    const opener = openerEl;
    openerEl = null;
    if (!hadFocus) return;
    // A floating rail gives focus back to whatever opened it; docked (or
    // with the opener gone) it goes to the editor.
    const back = pickFocusReturn([opener], isRendered);
    if (back) back.focus();
    else onFocusEditor();
  }

  // What had focus when a floating rail was opened, so closing can return
  // there. Not tracked while docked: the rail isn't in the editor's way.
  function rememberOpener() {
    const active = document.activeElement;
    openerEl =
      narrow.isNarrow() && active && active !== document.body ? active : null;
  }

  // The left rail's current track: its inline width on the shell, or the
  // stylesheet default before the left rail has mounted.
  function leftRailTrackWidth() {
    const read = (style) => parseFloat(style.getPropertyValue('--left-rail-w'));
    const inline = read(shellEl.style);
    return Number.isFinite(inline) ? inline : read(getComputedStyle(shellEl)) || 0;
  }

  function isExpanded() {
    return expanded;
  }

  function getActiveId() {
    return activeId;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  function rebuildTabs() {
    tabsContainer.replaceChildren();
    for (const id of panelOrder) {
      const panel = panels.get(id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'right-rail__tab';
      btn.dataset.panelId = id;
      btn.dataset.tooltip = panel.label;
      btn.id = `right-rail-tab-${id}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', panelContainer.id);
      btn.setAttribute('aria-label', panel.label);
      btn.setAttribute('aria-selected', expanded && id === activeId ? 'true' : 'false');
      btn.appendChild(makeIcon(panel.icon));
      btn.addEventListener('click', () => onTabClick(id));
      panel.tabBtn = btn;
      tabsContainer.appendChild(btn);
      if (expanded && id === activeId) btn.classList.add('is-active');
    }
  }

  function onTabClick(id) {
    // Click on the active tab while expanded → collapse (toggles the rail
    // off without leaving the active selection floating). Matches the
    // Cmd+B muscle memory but with the mouse.
    if (expanded && id === activeId) {
      collapse();
      return;
    }
    activate(id);
  }

  function doActivate(id, { focus = true } = {}) {
    const panel = panels.get(id);
    if (!panel) return;

    // Deactivate the previous tab (if any).
    if (activeId && activeId !== id && panels.has(activeId)) {
      const prev = panels.get(activeId);
      try { prev.deactivate(); }
      catch (err) { console.warn('[right-rail] deactivate failed:', err); }
      if (prev.slot) prev.slot.hidden = true;
      if (prev.tabBtn) {
        prev.tabBtn.classList.remove('is-active');
        prev.tabBtn.setAttribute('aria-selected', 'false');
      }
    }

    activeId = id;

    // Lazily build the panel's DOM the first time it's activated. We
    // wrap each panel in its own slot so multiple panels can coexist in
    // the host without their DOM colliding, and we never destroy a
    // panel's DOM on tab-switch (preserves scroll position, search text,
    // selection, etc.).
    if (!panel.mounted) {
      panel.slot = document.createElement('div');
      panel.slot.className = 'right-rail__panel-slot';
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
    panel.slot.hidden = false;

    if (panel.tabBtn) {
      panel.tabBtn.classList.add('is-active');
      panel.tabBtn.setAttribute('aria-selected', 'true');
      panelContainer.setAttribute('aria-labelledby', panel.tabBtn.id);
    }

    try { panel.activate({ focus }); }
    catch (err) { console.warn(`[right-rail] panel "${id}" activate() failed:`, err); }

    saveState();
  }

  function applyShellWidth() {
    const w = expanded ? widthPx + TABS_W : TABS_W;
    shellEl.style.setProperty('--right-rail-w', `${w}px`);
  }

  function syncCollapsedAttr() {
    container.dataset.collapsed = expanded ? 'false' : 'true';
  }

  function saveState() {
    preferredExpanded = expandedToPersist({
      expanded,
      narrow: narrow.isNarrow(),
      storedExpanded: preferredExpanded,
    });
    writeStored(storageKey, {
      expanded: preferredExpanded,
      width: widthPx,
      activeId,
    });
  }

  return {
    registerPanel,
    activate,
    toggle,
    expand,
    collapse,
    isExpanded,
    getActiveId,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function clampWidth(w) {
  if (!Number.isFinite(w)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
}

function readStored(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    console.warn('[right-rail] failed to read stored state:', err);
  }
  return null;
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('[right-rail] failed to persist state:', err);
  }
}

function focusFirstFocusable(root) {
  const target = root.querySelector(
    'input, button, [tabindex]:not([tabindex="-1"])',
  );
  if (target && typeof target.focus === 'function') target.focus();
}
