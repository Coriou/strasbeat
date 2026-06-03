// Open-set controller for pattern tabs. See design/work/26-pattern-tabs.md.
//
// Tabs are a VIEW over the spec-09/24 store — no second code store, no
// second dirtiness model. This module owns the runtime open set and the
// per-tab EditorState cache. Internal naming is deliberately generic
// (openItems / activeItem / "open an item") so spec 06's "open track" maps
// onto the same structure; the persisted keys stay openTabs / activeTab.

/**
 * Read the persisted open set from the store index.
 * @returns {{ openTabs: string[], activeTab: string|null }}
 */
export function readOpenSet(store) {
  const idx = store.getIndex();
  const ui = idx.uiState ?? {};
  const openTabs = Array.isArray(ui.openTabs)
    ? ui.openTabs.filter((n) => typeof n === "string")
    : [];
  const activeTab = typeof ui.activeTab === "string" ? ui.activeTab : null;
  return { openTabs, activeTab };
}

/**
 * Persist the open set under uiState, preserving every other index field.
 * Also mirrors activeTab into lastOpen (spec: kept in sync, lastOpen is the
 * pre-tabs spelling of "the focused pattern").
 */
export function writeOpenSet(store, { openTabs, activeTab }) {
  const idx = store.getIndex();
  idx.uiState = {
    ...(idx.uiState ?? {}),
    openTabs: [...openTabs],
    activeTab: activeTab ?? null,
  };
  idx.lastOpen = activeTab ?? idx.lastOpen ?? null;
  store.setIndex(idx);
}

/**
 * Derive the initial open set at boot, migrating older persistence shapes.
 *
 *   - openTabs present                       → use it as-is.
 *   - only lastOpen present (legacy)         → single tab = [lastOpen].
 *   - neither                                → empty open set.
 *   - openTabs present AND lastOpen disagrees → lastOpen wins as focus and is
 *     appended to openTabs (an older build may have written only lastOpen on
 *     its last switch).
 */
export function migrateOpenSet(store) {
  const idx = store.getIndex();
  const ui = idx.uiState ?? {};
  const hasOpenTabs = Array.isArray(ui.openTabs);

  if (!hasOpenTabs) {
    if (idx.lastOpen) return { openTabs: [idx.lastOpen], activeTab: idx.lastOpen };
    return { openTabs: [], activeTab: null };
  }

  const openTabs = ui.openTabs.filter((n) => typeof n === "string");
  let activeTab = typeof ui.activeTab === "string" ? ui.activeTab : null;

  // lastOpen wins as focus only when it isn't already in the open set —
  // that means it was opened after the tab set was last written (e.g. a
  // direct pattern switch without the tab controller running). When lastOpen
  // is already present in openTabs, the stored activeTab is authoritative.
  if (idx.lastOpen && !openTabs.includes(idx.lastOpen)) {
    activeTab = idx.lastOpen;
    openTabs.push(idx.lastOpen);
  }
  // Guard: if activeTab fell outside openTabs, focus the first tab (or null).
  if (activeTab && !openTabs.includes(activeTab)) {
    activeTab = openTabs[0] ?? null;
  }
  return { openTabs, activeTab };
}

/**
 * Create the open-set controller. DOM-free; the host injects how to build /
 * install / capture editor state and how to flush + relabel.
 *
 * Injected deps:
 *   store          — the persistence store (getIndex/setIndex/get)
 *   patterns       — { [name]: code } shipped patterns (for fresh-state seed)
 *   buildState({ name, code, fresh }) → EditorState   build a tab's state
 *   installState(state)              → void           view.setState(state)
 *   captureState()                   → EditorState     snapshot the live state
 *   flushToStore()                   → void            immediate autosave flush
 *   setCurrentName(name)             → void            wordmark + rail highlight
 *   onAfterSwitch?(name)             → void            optional UI hook (strip repaint)
 */
export function createTabController(deps) {
  const {
    store,
    patterns,
    buildState,
    installState,
    captureState,
    flushToStore,
    setCurrentName,
    onAfterSwitch = () => {},
  } = deps;

  let openItems = [];
  let activeItem = null;
  let playingItem = null;
  let orphanedPlaying = null;
  /** @type {Map<string, any>} name → cached EditorState */
  const stateCache = new Map();

  function hydrate() {
    const { openTabs, activeTab } = migrateOpenSet(store);
    openItems = [...openTabs];
    activeItem = activeTab;
    persist();
  }

  function persist() {
    writeOpenSet(store, { openTabs: openItems, activeTab: activeItem });
  }

  function codeFor(name) {
    const rec = store.get(name);
    if (rec) return rec.code;
    if (name in patterns) return patterns[name];
    return "";
  }

  // The core switch: cache outgoing, install incoming, relabel, persist.
  function focus(name) {
    if (activeItem === name) return;
    // 1. Flush + cache the outgoing state (preserves undo/cursor/scroll).
    if (activeItem != null) {
      flushToStore();
      stateCache.set(activeItem, captureState());
    }
    // 2. Install B's state — cached if present, else fresh from working copy.
    let state = stateCache.get(name);
    if (!state) {
      state = buildState({ name, code: codeFor(name), fresh: true });
      stateCache.set(name, state);
    }
    installState(state);
    // 3. Relabel + persist focus.
    activeItem = name;
    setCurrentName(name);
    persist();
    onAfterSwitch(name);
  }

  function openOrFocus(name) {
    if (!openItems.includes(name)) openItems.push(name);
    // Reopening the orphaned-playing tab clears the orphan into playingItem.
    if (orphanedPlaying === name) {
      orphanedPlaying = null;
      playingItem = name;
    }
    focus(name);
  }

  function close(name) {
    const idx = openItems.indexOf(name);
    if (idx < 0) return;
    const wasActive = activeItem === name;
    openItems.splice(idx, 1);
    stateCache.delete(name);
    // Orphan playback if the closed tab owned the sound (audio continues).
    if (playingItem === name) {
      playingItem = null;
      orphanedPlaying = name;
    }
    if (wasActive) {
      // Focus the right neighbor, else the left, else empty.
      const next = openItems[idx] ?? openItems[idx - 1] ?? null;
      activeItem = null; // force focus() to run for `next`
      if (next != null) focus(next);
      else {
        setCurrentName(null);
        persist();
        onAfterSwitch(null);
      }
    } else {
      persist();
      onAfterSwitch(activeItem);
    }
  }

  function reorder(name, toIndex) {
    const from = openItems.indexOf(name);
    if (from < 0) return;
    openItems.splice(from, 1);
    openItems.splice(toIndex, 0, name);
    persist();
    onAfterSwitch(activeItem);
  }

  // Rename: re-key in place across openItems, cache, focus, playing, orphan.
  function reKey(oldName, newName) {
    const i = openItems.indexOf(oldName);
    if (i >= 0) openItems[i] = newName;
    if (stateCache.has(oldName)) {
      stateCache.set(newName, stateCache.get(oldName));
      stateCache.delete(oldName);
    }
    if (activeItem === oldName) activeItem = newName;
    if (playingItem === oldName) playingItem = newName;
    if (orphanedPlaying === oldName) orphanedPlaying = newName;
    persist();
    onAfterSwitch(activeItem);
  }

  // Revert/delete-with-fresh-state: drop the cached state so the next focus
  // rebuilds from the (reverted) working copy. Caller updates the store first.
  function evictState(name) {
    stateCache.delete(name);
  }

  // Rebuild + reinstall the active tab's state from its CURRENT working copy.
  // Used by revert: the document identity changed wholesale (the working copy
  // was reset to the shipped original), so a fresh state with empty undo is the
  // honest result. For a non-active open tab, just evict — it rebuilds fresh on
  // its next focus.
  function refresh(name) {
    evictState(name);
    if (activeItem === name) {
      const state = buildState({ name, code: codeFor(name), fresh: true });
      stateCache.set(name, state);
      installState(state);
      onAfterSwitch(name);
    }
  }

  function setPlaying(name) {
    playingItem = name;
    orphanedPlaying = null;
  }
  function clearPlaying() {
    playingItem = null;
    orphanedPlaying = null;
  }

  // Boot reconciliation. The editor already DISPLAYS `name`'s code — the boot
  // resolution chose it (share link > lastOpen working copy > shipped original
  // > fallback). Make `name` the focused item WITHOUT a swap: the live state
  // already IS this item's state, and it gets cached lazily on the first
  // switch-away. Ensures `name` is in the open set. This deliberately overrides
  // a persisted activeTab that disagrees (e.g. a share link makes the boot
  // pattern differ from last session's focus) — going through the normal switch
  // path here would both swap away from the shown code AND cache it under the
  // wrong name.
  function adoptInitial(name) {
    if (name == null) return;
    if (!openItems.includes(name)) openItems.push(name);
    activeItem = name;
    setCurrentName(name);
    persist();
    onAfterSwitch(name);
  }

  return {
    hydrate,
    adoptInitial,
    openOrFocus,
    close,
    reorder,
    reKey,
    evictState,
    refresh,
    setPlaying,
    clearPlaying,
    persist,
    getOpenItems: () => [...openItems],
    getActiveItem: () => activeItem,
    getPlayingItem: () => playingItem,
    getOrphanedPlaying: () => orphanedPlaying,
  };
}
