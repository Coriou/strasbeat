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
//     activate:  () => {},  // optional — called when tab is selected
//     deactivate:() => {},  // optional — called when tab is deselected
//   });
//
//   rail.activate('sounds');     // open the panel by id
//   rail.toggle();               // collapse <-> expand
//   rail.expand();
//   rail.collapse();
//   rail.isExpanded();
//
// Persistence — the active tab id, expanded/collapsed flag, and panel
// width are written to localStorage under `storageKey`. Restored on
// mount. Stale ids (tab no longer registered) silently fall back.
//
// Pure DOM, no framework. Tab buttons are rebuilt on every register
// call so the order matches registration order.

import { makeIcon } from './icons.js';

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
  let expanded = stored?.expanded === true;
  let widthPx = clampWidth(stored?.width ?? DEFAULT_WIDTH);
  let activeId = stored?.activeId ?? null;

  /** @type {Map<string, {id, icon, label, create, activate, deactivate, tabBtn, mounted}>} */
  const panels = new Map();
  const panelOrder = []; // insertion order — drives tab strip layout

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
  if (resizeHandle) {
    resizeHandle.addEventListener('pointerdown', (e) => {
      if (!expanded) return;
      dragStartX = e.clientX;
      dragStartWidth = widthPx;
      resizeHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
      document.body.style.cursor = 'ew-resize';
    });
    resizeHandle.addEventListener('pointermove', (e) => {
      if (dragStartX == null) return;
      // Dragging left = bigger panel (panel is on the right edge of the page).
      const dx = dragStartX - e.clientX;
      widthPx = clampWidth(dragStartWidth + dx);
      applyShellWidth();
    });
    const endDrag = (e) => {
      if (dragStartX == null) return;
      dragStartX = null;
      document.body.style.cursor = '';
      if (e?.pointerId != null && resizeHandle.hasPointerCapture?.(e.pointerId)) {
        resizeHandle.releasePointerCapture(e.pointerId);
      }
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
  panelContainer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onFocusEditor();
    }
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
    //   - persisted active tab points at a panel that hasn't been
    //     registered (could be an old build or a renamed panel) → fall
    //     back to this one rather than leave the rail empty
    if (activeId == null || !panels.has(activeId)) {
      activeId = panel.id;
      if (expanded) doActivate(panel.id);
    } else if (activeId === panel.id && expanded) {
      doActivate(panel.id);
    }
    return panel;
  }

  function activate(id) {
    if (!panels.has(id)) {
      console.warn(`[right-rail] activate: unknown panel "${id}"`);
      return;
    }
    if (!expanded) expand();
    if (activeId === id) {
      // Already active — make sure focus moves into the panel for
      // keyboard nav (matches VSCode's "Cmd+B then arrow keys" flow).
      const slot = panels.get(id).slot;
      if (slot) focusFirstFocusable(slot);
      return;
    }
    doActivate(id);
  }

  function toggle() {
    if (expanded) collapse();
    else expand();
  }

  function expand() {
    if (expanded) return;
    expanded = true;
    syncCollapsedAttr();
    applyShellWidth();
    if (activeId == null && panelOrder.length > 0) activeId = panelOrder[0];
    if (activeId) doActivate(activeId);
    saveState();
  }

  function collapse() {
    if (!expanded) return;
    expanded = false;
    // Deactivate the current panel so it can stop any work (timers,
    // listeners) until reopened.
    if (activeId && panels.has(activeId)) {
      try { panels.get(activeId).deactivate(); }
      catch (err) { console.warn('[right-rail] deactivate failed:', err); }
    }
    syncCollapsedAttr();
    applyShellWidth();
    saveState();
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
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', 'right-rail-panel');
      btn.setAttribute('aria-label', panel.label);
      btn.setAttribute('title', panel.label);
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

  function doActivate(id) {
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
      try { panel.create(panel.slot); }
      catch (err) { console.error(`[right-rail] panel "${id}" create() failed:`, err); }
      panel.mounted = true;
    }
    panel.slot.hidden = false;

    if (panel.tabBtn) {
      panel.tabBtn.classList.add('is-active');
      panel.tabBtn.setAttribute('aria-selected', 'true');
    }

    try { panel.activate(); }
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
    writeStored(storageKey, {
      expanded,
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
