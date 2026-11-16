// Sound browser — first panel that registers with the right rail.
//
// Browsable view of every sound the running Strudel instance knows about
// (samples, soundfonts, synth waveforms). The composer can:
//   - search by name (debounced 150ms, with match highlighting)
//   - filter by category pill (All / Kits / GM / Synth)
//   - audition a sound by mousedown (one-shot through superdough)
//   - insert a sound into the editor by double-click (or Shift+Enter)
//   - see at a glance which sounds the current pattern is using
//
// See design/work/08-feature-parity-and-beyond.md "Phase 1: Sound Browser".
//
// Public surface (factory pattern so the panel can hold its own state
// without leaking module-globals):
//
//   const panel = createSoundBrowserPanel({
//     getSoundMap,        // () => Record<string, { onTrigger, data }>
//     onPreview,          // (name: string) => void  — fire one-shot audition
//     onInsert,           // (name: string) => void  — insert into editor
//     onFocusEditor,      // () => void              — Escape returns focus
//   });
//   rightRail.registerPanel(panel);
//   panel.refresh();                  // re-read the soundMap (post-prebake)
//   panel.setBufferText(editor.code); // update "in use" highlights
//
// The factory returns the right-rail panel spec ({ id, icon, label,
// create, activate, deactivate }) plus the two helpers above.
//
// Pure DOM, no framework. Match the imperative style of left-rail.js
// and transport.js.

import { makeIcon } from "./icons.js";
import { getUserSamples } from "../user-setup.js";

const SEARCH_DEBOUNCE_MS = 150;

// Conventional drum step ordering — within a kit group, recognised drum
// suffixes sort first in this order, then everything else falls back to
// alphabetical. Lifted from common DAW sample browsers.
const DRUM_ORDER = [
  "bd",
  "kick",
  "sd",
  "snare",
  "rim",
  "cp",
  "clap",
  "hh",
  "ch",
  "oh",
  "ho",
  "lt",
  "mt",
  "ht",
  "tom",
  "cb",
  "cy",
  "cr",
  "crash",
  "rd",
  "ride",
  "sh",
  "shaker",
];

// Rows built synchronously when the list renders (enough to fill the
// panel a few times over), then per animation frame until done.
const FIRST_CHUNK_ROWS = 60;
const CHUNK_ROWS = 80;

const NON_KIT_PREFIXES = new Set(["gm", "wt"]);
const NON_KIT_TYPES = new Set(["synth", "soundfont", "wavetable"]);

export function createSoundBrowserPanel({
  getSoundMap,
  onPreview = () => {},
  onInsert = () => {},
  onFocusEditor = () => {},
}) {
  // ─── State ────────────────────────────────────────────────────────────
  /** @type {Array<{ name: string, type: string, sampleCount: number, kit: string|null }>} */
  let allSounds = [];
  /** @type {Set<string>} */
  let inUse = new Set();
  let currentBufferText = "";
  let query = "";
  let category = "all"; // all | kits | gm | synth | user | wavetable
  /** @type {Set<string>} names of sounds that came from user-imported banks */
  let userSounds = new Set();
  let activeIndex = -1; // index into the currently-rendered flat list
  /** Row currently painted as active — tracked so repainting is O(1). */
  let activeEl = null;
  /** @type {Set<string>} */
  let collapsedGroups = new Set();

  // DOM refs (re-bound on create()).
  let root = null;
  let searchInput = null;
  let pillsEl = null;
  let listEl = null;
  let countEl = null;
  let mounted = false;
  let searchTimer = null;

  // Each render() flattens visible sounds into this list so keyboard nav
  // and "select first match on Enter" can work without re-walking the
  // grouped DOM.
  /** @type {Array<{ name: string, kit: string|null }>} */
  let flatVisible = [];

  // What the list currently shows, in display order. Rows are built in
  // chunks (see renderChunk) and only for expanded groups, so this — not
  // the DOM — is the source of truth for keyboard navigation.
  /** @type {Array<{ key: string|null, sounds: Array, itemsEl: HTMLElement, built: number, groupEl: HTMLElement|null }>} */
  let sections = [];
  /** @type {Map<string, HTMLElement>} sound name → its row, once built */
  const itemEls = new Map();
  let renderJob = 0; // handle of the pending chunk callback, 0 when idle
  /** Sound names the list was last built from — skips no-op rebuilds. */
  let renderedNames = null;

  // ─── Right-rail panel spec ────────────────────────────────────────────

  return {
    id: "sounds",
    icon: "music",
    label: "Sound browser",
    create,
    activate,
    deactivate,
    refresh,
    setBufferText,
    focusSound,
    focusSearch,
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────

  function create(container) {
    root = container;
    root.classList.add("sound-browser");

    // Header — search input.
    const header = el("div", "sound-browser__header");
    const search = el("div", "sound-browser__search");
    const searchIcon = el("span", "sound-browser__search-icon");
    searchIcon.appendChild(makeIcon("search"));
    search.appendChild(searchIcon);

    searchInput = el("input", "sound-browser__search-input");
    searchInput.type = "text";
    searchInput.placeholder = "Search sounds…";
    searchInput.setAttribute("aria-label", "Search sounds");
    searchInput.spellcheck = false;
    searchInput.autocomplete = "off";
    searchInput.addEventListener("input", onSearchInput);
    searchInput.addEventListener("keydown", onSearchKeydown);
    search.appendChild(searchInput);
    header.appendChild(search);

    // Discoverability hint — fades out after the user's first preview.
    const hint = el(
      "div",
      "sound-browser__hint",
      "Click to preview · double-click to insert",
    );
    header.appendChild(hint);

    root.appendChild(header);

    // Category pills.
    pillsEl = el("div", "sound-browser__pills");
    // Filter toggles, not tabs: there's one list and no tabpanel per pill.
    pillsEl.setAttribute("role", "group");
    pillsEl.setAttribute("aria-label", "Sound category");
    for (const c of [
      { id: "all", label: "All" },
      { id: "kits", label: "Kits" },
      { id: "gm", label: "GM", title: "General MIDI soundfont instruments" },
      { id: "synth", label: "Synth" },
      {
        id: "wavetable",
        label: "Wavetable",
        title: "Wavetable synthesis samples",
        dynamic: true,
      },
      {
        id: "user",
        label: "User",
        title: "Your imported samples",
        dynamic: true,
      },
    ]) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "sound-browser__pill";
      pill.dataset.category = c.id;
      pill.textContent = c.label;
      if (c.title) pill.title = c.title;
      pill.setAttribute("aria-pressed", c.id === category ? "true" : "false");
      if (c.id === category) pill.classList.add("is-active");
      if (c.dynamic) pill.classList.add("is-dynamic");
      pill.addEventListener("click", () => {
        setCategory(c.id);
        render();
      });
      pillsEl.appendChild(pill);
    }
    root.appendChild(pillsEl);

    // List container — scroll region for groups + sound items.
    listEl = el("div", "sound-browser__list");
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "Sounds");
    listEl.addEventListener("keydown", onListKeydown);
    // One set of listeners for the whole list — rows carry no handlers of
    // their own, so a thousand-sound map doesn't cost thousands of closures.
    listEl.addEventListener("mousedown", onListMousedown);
    listEl.addEventListener("click", onListClick);
    listEl.addEventListener("dblclick", onListDblclick);
    listEl.addEventListener("dragstart", onListDragstart);
    root.appendChild(listEl);

    // Footer — count of visible / total sounds.
    countEl = el("div", "sound-browser__count");
    root.appendChild(countEl);

    mounted = true;
    refresh();
  }

  function activate({ focus = true } = {}) {
    if (!mounted) return;
    // Re-read in case the soundMap was populated after prebake but before
    // the user opened the panel for the first time. A no-op when nothing
    // changed, so scroll position and selection survive tab switches.
    refresh();
    // Focus the search input so the first keystroke goes there.
    if (focus && searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }

  function deactivate() {
    clearTimeout(searchTimer);
  }

  // ─── Public helpers ───────────────────────────────────────────────────

  function refresh() {
    const map = getSoundMap();
    const names = map && typeof map === "object" ? Object.keys(map) : [];
    const changed = !sameNames(names, renderedNames);
    if (changed) {
      allSounds = collectSounds(map);
      inUse = scanInUse(currentBufferText, allSounds);
    }
    // Refresh which sounds are user imports, and dynamic pill visibility.
    getUserSamples()
      .then((banks) => {
        const next = userSoundNames(banks);
        const userChanged = !sameNames([...next], [...userSounds]);
        userSounds = next;
        _syncDynamicPills();
        if (userChanged && mounted && category === "user") render();
      })
      .catch((err) => {
        console.warn("[sound-browser] couldn't read user sample banks:", err);
      });
    _syncDynamicPills();
    if (mounted && changed) {
      renderedNames = names;
      render();
    }
  }

  function _syncDynamicPills() {
    if (!pillsEl) return;
    const hasUser = userSounds.size > 0;
    const hasWavetable = allSounds.some((s) => s.name.startsWith("wt_"));
    for (const pill of pillsEl.querySelectorAll(
      ".sound-browser__pill.is-dynamic",
    )) {
      const id = pill.dataset.category;
      if (id === "user") pill.hidden = !hasUser;
      if (id === "wavetable") pill.hidden = !hasWavetable;
    }
  }

  function setBufferText(text) {
    currentBufferText = text ?? "";
    inUse = scanInUse(currentBufferText, allSounds);
    if (mounted) updateInUseHighlights();
  }

  // ─── Render ───────────────────────────────────────────────────────────

  function render() {
    if (!listEl) return;
    cancelRenderJob();
    listEl.replaceChildren();
    listEl.scrollTop = 0;
    sections = [];
    itemEls.clear();
    flatVisible = [];
    activeIndex = -1;
    activeEl = null;

    // 1. Filter by category.
    const visible = allSounds.filter((s) => matchCategory(s, category));

    // 2. Filter by search query (substring on name + kit).
    const filtered = query
      ? visible.filter((s) => soundMatchesQuery(s, query))
      : visible;

    countEl.textContent =
      filtered.length === allSounds.length
        ? `${allSounds.length} sounds`
        : `${filtered.length} shown · ${allSounds.length} total`;

    if (allSounds.length === 0) {
      const empty = el("div", "sound-browser__empty", "no sounds loaded yet");
      listEl.appendChild(empty);
      return;
    }
    if (filtered.length === 0) {
      if (category === "user" && !query) {
        const empty = el("div", "sound-browser__empty");
        empty.append(
          "No user samples imported yet.",
          document.createElement("br"),
          "Import samples in ",
          el("strong", null, "Settings → Samples"),
          ".",
        );
        listEl.appendChild(empty);
      } else {
        const empty = el(
          "div",
          "sound-browser__empty",
          query ? `no sounds match "${query}"` : "no sounds in this category",
        );
        listEl.appendChild(empty);
      }
      return;
    }

    // 3. Render mode depends on category:
    //    - kits: collapsible groups by kit prefix
    //    - synth, gm, all (with no query): collapsible groups too
    //    - all (with query): flat alphabetical list (groups would
    //      collapse most of the matches anyway)
    const useGroups = category !== "all" || !query;
    if (useGroups) renderGrouped(filtered);
    else renderFlat(filtered);
    syncFlatVisible();
    // First chunk now so the panel opens populated; the rest trickles in
    // over the following frames instead of blocking this one.
    renderChunk(FIRST_CHUNK_ROWS);
    if (hasUnbuiltRows()) scheduleRenderJob();
  }

  // Build up to `budget` more rows, walking sections in display order and
  // skipping collapsed groups (their rows are built when first expanded).
  function renderChunk(budget) {
    for (const section of sections) {
      if (budget <= 0) return;
      if (isCollapsed(section)) continue;
      budget -= buildRows(section, budget);
    }
  }

  function buildRows(section, budget) {
    const end = Math.min(section.sounds.length, section.built + budget);
    if (end <= section.built) return 0;
    const frag = document.createDocumentFragment();
    for (let i = section.built; i < end; i++) {
      frag.appendChild(buildSoundItem(section.sounds[i]));
    }
    const count = end - section.built;
    section.built = end;
    section.itemsEl.appendChild(frag);
    return count;
  }

  function isCollapsed(section) {
    return section.key != null && collapsedGroups.has(section.key);
  }

  function hasUnbuiltRows() {
    return sections.some(
      (sec) => !isCollapsed(sec) && sec.built < sec.sounds.length,
    );
  }

  function scheduleRenderJob() {
    if (renderJob) return;
    renderJob = requestAnimationFrame(() => {
      renderJob = 0;
      renderChunk(CHUNK_ROWS);
      if (hasUnbuiltRows()) scheduleRenderJob();
    });
  }

  function cancelRenderJob() {
    if (renderJob) cancelAnimationFrame(renderJob);
    renderJob = 0;
  }

  // Finish any pending chunks right now — used before code that needs a
  // specific row to exist (keyboard navigation, reveal-in-browser).
  function flushRender() {
    cancelRenderJob();
    renderChunk(Infinity);
  }

  function renderGrouped(filtered) {
    // Bucket sounds by kit (or "ungrouped" / type-based fallback).
    const groups = new Map();
    for (const s of filtered) {
      const key = s.kit ?? bucketLabel(s);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    // Within each group sort by drum order then alpha. Sort kit groups
    // alphabetically; bucket-label groups (synths, soundfonts, …) sink to
    // the end so the kit shelves stay at the top where the eye lands.
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      const aIsBucket = !groups.get(a)[0].kit;
      const bIsBucket = !groups.get(b)[0].kit;
      if (aIsBucket !== bIsBucket) return aIsBucket ? 1 : -1;
      return a.localeCompare(b);
    });

    // Build a fragment so we only touch the DOM once per render.
    const frag = document.createDocumentFragment();
    for (const key of orderedKeys) {
      const sounds = groups.get(key);
      sounds.sort(byDrumOrder);
      const groupEl = buildGroup(key, sounds);
      frag.appendChild(groupEl);
    }
    listEl.appendChild(frag);
  }

  function renderFlat(filtered) {
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    sections.push({
      key: null,
      sounds: sorted,
      itemsEl: listEl,
      built: 0,
      groupEl: null,
    });
  }

  function buildGroup(key, sounds) {
    const group = el("div", "sound-browser__group");
    group.dataset.groupKey = key;
    const head = el("button", "sound-browser__group-head");
    head.type = "button";
    const isCollapsed = collapsedGroups.has(key);
    head.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    if (isCollapsed) group.classList.add("is-collapsed");

    const chev = el("span", "sound-browser__group-chev");
    chev.appendChild(makeIcon("chevron-down"));
    head.appendChild(chev);

    const label = el(
      "span",
      "sound-browser__group-label",
      formatGroupLabel(key, sounds),
    );
    head.appendChild(label);

    const total = sounds.reduce((n, s) => n + Math.max(1, s.sampleCount), 0);
    const meta = el("span", "sound-browser__group-meta", `${sounds.length}`);
    meta.title = `${sounds.length} sound${sounds.length === 1 ? "" : "s"}, ${total} sample${total === 1 ? "" : "s"}`;
    head.appendChild(meta);

    const items = el("div", "sound-browser__group-items");
    sections.push({ key, sounds, itemsEl: items, built: 0, groupEl: group });

    group.appendChild(head);
    group.appendChild(items);
    return group;
  }

  function toggleGroup(group) {
    const key = group.dataset.groupKey;
    const section = sections.find((sec) => sec.groupEl === group);
    if (!section) return;
    const collapsed = group.classList.toggle("is-collapsed");
    if (collapsed) collapsedGroups.add(key);
    else collapsedGroups.delete(key);
    group
      .querySelector(".sound-browser__group-head")
      ?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (!collapsed) buildRows(section, Infinity);
    syncFlatVisible();
  }

  function buildSoundItem(sound) {
    const item = el("div", "sound-browser__item");
    item.setAttribute("role", "option");
    item.setAttribute("tabindex", "-1");
    item.dataset.soundName = sound.name;
    if (inUse.has(sound.name)) item.classList.add("is-in-use");
    itemEls.set(sound.name, item);

    // The "name" is shown without its kit prefix when we're in a kit
    // group, to reduce visual repetition (`bd`, `sd`, `hh` instead of
    // `808_bd`, `808_sd`, `808_hh`).
    const displayName =
      sound.kit && sound.name.startsWith(sound.kit + "_")
        ? sound.name.slice(sound.kit.length + 1)
        : sound.name;

    const nameEl = el("span", "sound-browser__item-name");
    appendHighlightedText(nameEl, displayName, query);
    item.appendChild(nameEl);

    if (sound.sampleCount > 1) {
      const meta = el(
        "span",
        "sound-browser__item-meta",
        `${sound.sampleCount}`,
      );
      meta.title = `${sound.sampleCount} variations`;
      item.appendChild(meta);
    }

    // Draggable onto the editor canvas — see onListDragstart. Preview /
    // insert / focus are handled by the list-level listeners too.
    item.draggable = true;

    return item;
  }

  // ─── Delegated row events ─────────────────────────────────────────────

  function rowFromEvent(e) {
    const target = e.target instanceof Element ? e.target : null;
    return target?.closest(".sound-browser__item") ?? null;
  }

  // Mousedown previews. We use mousedown (not click) so the audition
  // fires the instant the user touches the row — feels more like an
  // instrument and avoids the click-vs-double-click delay. Insert is on
  // double-click, which fires its own dblclick event later.
  function onListMousedown(e) {
    if (e.button !== 0) return;
    const item = rowFromEvent(e);
    if (item) previewSound(item.dataset.soundName, item);
  }

  function onListClick(e) {
    const target = e.target instanceof Element ? e.target : null;
    const head = target?.closest(".sound-browser__group-head");
    if (head) {
      toggleGroup(head.parentElement);
      return;
    }
    // Click also focuses the item so arrow keys take over from there.
    const item = rowFromEvent(e);
    if (item) focusItem(item.dataset.soundName);
  }

  function onListDblclick(e) {
    const item = rowFromEvent(e);
    if (!item) return;
    e.preventDefault();
    insertSound(item.dataset.soundName);
  }

  // Drag to editor — lets the user drag a sound row directly onto the
  // editor canvas. The editor's drop listener reads the custom MIME type
  // and calls insertSoundName with the editor view.
  function onListDragstart(e) {
    const item = rowFromEvent(e);
    if (!item || !e.dataTransfer) return;
    e.dataTransfer.setData("text/x-strasbeat-sound", item.dataset.soundName);
    e.dataTransfer.effectAllowed = "copyLink";
  }

  function appendHighlightedText(parent, text, q) {
    if (!q) {
      parent.textContent = text;
      return;
    }
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) {
      parent.textContent = text;
      return;
    }
    parent.appendChild(document.createTextNode(text.slice(0, idx)));
    const match = el(
      "span",
      "sound-browser__item-match",
      text.slice(idx, idx + q.length),
    );
    parent.appendChild(match);
    parent.appendChild(document.createTextNode(text.slice(idx + q.length)));
  }

  function updateInUseHighlights() {
    if (!listEl) return;
    for (const [name, item] of itemEls) {
      item.classList.toggle("is-in-use", inUse.has(name));
    }
  }

  // ─── Interactions ─────────────────────────────────────────────────────

  function previewSound(name, itemEl) {
    try {
      onPreview(name);
    } catch (err) {
      console.warn("[sound-browser] preview failed:", err);
    }
    if (!itemEl) return;
    itemEl.classList.add("is-previewing");
    setTimeout(() => itemEl.classList.remove("is-previewing"), 800);

    // Fade out the discoverability hint after the first successful preview.
    const hintEl = root?.querySelector(".sound-browser__hint");
    if (hintEl && !hintEl.classList.contains("is-hidden")) {
      hintEl.classList.add("is-hidden");
    }
  }

  function insertSound(name) {
    try {
      onInsert(name);
    } catch (err) {
      console.warn("[sound-browser] insert failed:", err);
    }
  }

  function focusItem(name) {
    activeIndex = flatVisible.findIndex((s) => s.name === name);
    paintActive();
  }

  // Public — called from main.js when Cmd+J fires. Fills the search input
  // with the cursor's word and triggers a filter so the user can explore
  // alternatives. The panel must already be visible (caller activates it
  // first).
  function focusSearch(prefilledQuery = "") {
    if (!mounted) return;
    if (searchInput) {
      searchInput.value = prefilledQuery;
      searchInput.focus();
      searchInput.select();
      if (prefilledQuery)
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // Public — called from main.js when Cmd+Shift+B resolves a sound under
  // the cursor and we want to highlight it in the browser. Expands the
  // containing kit group if collapsed so the row is actually visible.
  function focusSound(name) {
    if (!mounted) return;
    const sound = allSounds.find((s) => s.name === name);
    if (!sound) {
      console.warn(`[sound-browser] focusSound: "${name}" not in allSounds`);
      return;
    }
    // The current search or category may be hiding it — drop whichever
    // filter is in the way so the reveal always lands on a visible row.
    const groupKey = sound.kit ?? bucketLabel(sound);
    let needsRender = false;
    if (query && !soundMatchesQuery(sound, query)) {
      query = "";
      if (searchInput) searchInput.value = "";
      needsRender = true;
    }
    if (!matchCategory(sound, category)) {
      setCategory("all");
      needsRender = true;
    }
    if (collapsedGroups.has(groupKey)) {
      collapsedGroups.delete(groupKey);
      needsRender = true;
    }
    if (needsRender) render();
    activeIndex = flatVisible.findIndex((s) => s.name === name);
    paintActive();
  }

  function setCategory(next) {
    category = next;
    if (!pillsEl) return;
    for (const p of pillsEl.querySelectorAll(".sound-browser__pill")) {
      const isMe = p.dataset.category === category;
      p.classList.toggle("is-active", isMe);
      p.setAttribute("aria-pressed", isMe ? "true" : "false");
    }
  }

  function paintActive() {
    if (!listEl) return;
    if (activeEl) {
      activeEl.classList.remove("is-active");
      activeEl.setAttribute("aria-selected", "false");
      activeEl = null;
    }
    if (activeIndex < 0 || activeIndex >= flatVisible.length) return;
    const target = rowFor(flatVisible[activeIndex].name);
    if (target) {
      activeEl = target;
      target.classList.add("is-active");
      target.setAttribute("aria-selected", "true");
      target.scrollIntoView({ block: "nearest" });
      target.focus({ preventScroll: true });
    }
  }

  // The row for a visible sound, building any still-pending chunks first.
  function rowFor(name) {
    if (!itemEls.has(name)) flushRender();
    return itemEls.get(name) ?? null;
  }

  // Recompute the keyboard-navigable list from the section model, keeping
  // the active row if it's still visible.
  function syncFlatVisible() {
    const activeName =
      activeIndex >= 0 && activeIndex < flatVisible.length
        ? flatVisible[activeIndex].name
        : null;

    flatVisible = [];
    for (const section of sections) {
      if (isCollapsed(section)) continue;
      for (const s of section.sounds) {
        flatVisible.push({ name: s.name, kit: s.kit });
      }
    }

    activeIndex = activeName
      ? flatVisible.findIndex((sound) => sound.name === activeName)
      : -1;
    paintActive();
  }

  function moveActive(delta) {
    if (flatVisible.length === 0) return;
    if (activeIndex < 0) {
      activeIndex = delta > 0 ? 0 : flatVisible.length - 1;
    } else {
      activeIndex =
        (activeIndex + delta + flatVisible.length) % flatVisible.length;
    }
    paintActive();
  }

  // ─── Event handlers ───────────────────────────────────────────────────

  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchInput.value.trim().toLowerCase();
      render();
    }, SEARCH_DEBOUNCE_MS);
  }

  function onSearchKeydown(e) {
    if (e.key === "Escape") {
      if (searchInput.value) {
        e.preventDefault();
        searchInput.value = "";
        query = "";
        render();
        return;
      }
      e.preventDefault();
      onFocusEditor();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Flush the debounce so render() has the freshest filter, then jump
      // into the list.
      clearTimeout(searchTimer);
      query = searchInput.value.trim().toLowerCase();
      render();
      moveActive(+1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Pick the first visible sound — preview by default, insert with
      // Shift held (matches the rest of the keyboard behavior in the
      // list).
      clearTimeout(searchTimer);
      query = searchInput.value.trim().toLowerCase();
      render();
      if (flatVisible.length === 0) return;
      const name = flatVisible[0].name;
      activeIndex = 0;
      paintActive();
      if (e.shiftKey) insertSound(name);
      else previewSound(name, currentItemEl());
    }
  }

  function onListKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(+1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (activeIndex === 0) {
        // Wrap back into the search field at the top.
        activeIndex = -1;
        paintActive();
        searchInput.focus();
        searchInput.select();
        return;
      }
      moveActive(-1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onFocusEditor();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex < 0) return;
      const name = flatVisible[activeIndex].name;
      if (e.shiftKey) insertSound(name);
      else previewSound(name, currentItemEl());
    }
  }

  function currentItemEl() {
    if (activeIndex < 0 || !listEl) return null;
    return rowFor(flatVisible[activeIndex].name);
  }

  function matchCategory(s, c) {
    switch (c) {
      case "kits":
        return !!s.kit;
      case "gm":
        return s.name.startsWith("gm_");
      case "synth":
        return s.type === "synth";
      case "wavetable":
        return s.name.startsWith("wt_");
      case "user":
        return userSounds.has(s.name);
      case "all":
      default:
        return true;
    }
  }
}

// ─── Pure helpers (no closure state) ──────────────────────────────────────

/**
 * Walk the soundMap (`{ name: { onTrigger, data } }`) and project each entry
 * into the shape the panel renders. Detects kit membership via the
 * `<prefix>_<suffix>` convention used by every Strudel sample bank: a kit
 * exists when 3+ sounds share the same prefix.
 */
export function collectSounds(soundMapObj) {
  if (!soundMapObj || typeof soundMapObj !== "object") {
    console.warn("[sound-browser] soundMap is empty or invalid:", soundMapObj);
    return [];
  }
  // An empty map is the normal state until prebake finishes; the panel
  // shows "no sounds loaded yet" and re-reads on the next refresh.
  const names = Object.keys(soundMapObj);
  if (names.length === 0) return [];

  // First pass — count prefix occurrences so we can decide which prefixes
  // qualify as kits (3+ members).
  // Only sample banks form kits: `gm_*` soundfonts and `wt_*` wavetables
  // share a prefix too, but they're instrument families with their own
  // categories, not drum machines.
  const types = new Map();
  for (const name of names) {
    types.set(name, soundMapObj[name]?.data?.type ?? inferType(name));
  }
  const prefixCounts = new Map();
  for (const name of names) {
    const prefix = splitPrefix(name);
    if (!prefix || NON_KIT_PREFIXES.has(prefix)) continue;
    if (NON_KIT_TYPES.has(types.get(name))) continue;
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const kitPrefixes = new Set();
  for (const [prefix, count] of prefixCounts) {
    if (count >= 3) kitPrefixes.add(prefix);
  }

  // Second pass — build the projected sound objects.
  const out = [];
  for (const name of names) {
    const entry = soundMapObj[name];
    const data = entry?.data ?? {};
    const sampleCount = Array.isArray(data.samples)
      ? data.samples.length
      : typeof data.samples === "object" && data.samples != null
        ? Object.values(data.samples).reduce(
            (n, v) => n + (Array.isArray(v) ? v.length : 1),
            0,
          )
        : 1;
    const prefix = splitPrefix(name);
    const type = types.get(name);
    const kit =
      prefix && kitPrefixes.has(prefix) && !NON_KIT_TYPES.has(type)
        ? prefix
        : null;
    out.push({
      name,
      type,
      sampleCount,
      kit,
    });
  }
  return out;
}

function soundMatchesQuery(sound, q) {
  const lname = sound.name.toLowerCase();
  const lkit = sound.kit ? sound.kit.toLowerCase() : "";
  return lname.includes(q) || lkit.includes(q);
}

function sameNames(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Names of the sounds that user-imported banks register. A stored bank is
 * the manifest as fetched: every key except `_base` becomes a sound of that
 * name, whatever the bank itself is called.
 * @param {Array<{ name: string, sampleMap?: object }>} banks
 * @returns {Set<string>}
 */
export function userSoundNames(banks) {
  const out = new Set();
  for (const bank of banks ?? []) {
    const map = bank?.sampleMap;
    if (!map || typeof map !== "object") continue;
    for (const key of Object.keys(map)) {
      if (key !== "_base") out.add(key);
    }
  }
  return out;
}

function splitPrefix(name) {
  const i = name.indexOf("_");
  if (i <= 0) return null;
  return name.slice(0, i);
}

function inferType(name) {
  if (name.startsWith("gm_")) return "soundfont";
  if (name.startsWith("wt_")) return "wavetable";
  // Strudel's built-in synth waveform names — the few sounds the soundMap
  // ships with `data.type === 'synth'` are exactly this set, but in case
  // a future bank skips the type field we still want to bucket them.
  if (
    [
      "sine",
      "sawtooth",
      "square",
      "triangle",
      "pulse",
      "supersaw",
      "pwm",
      "noise",
      "pink",
      "brown",
      "white",
      "crackle",
    ].includes(name)
  ) {
    return "synth";
  }
  return "sample";
}

function bucketLabel(sound) {
  switch (sound.type) {
    case "synth":
      return "synth";
    case "soundfont":
      return "soundfonts";
    case "wavetable":
      return "wavetables";
    case "sample":
      return "samples";
    default:
      return sound.type ?? "other";
  }
}

function formatGroupLabel(key, sounds) {
  return sounds[0]?.kit ? key : key.charAt(0).toUpperCase() + key.slice(1);
}

function byDrumOrder(a, b) {
  // Sort within a kit: known drum suffixes first in DRUM_ORDER, then
  // alphabetical fall-through. The suffix is everything after the kit
  // prefix (e.g. "808_bd" → "bd"); for non-kit sounds use the full name.
  const sa = stripKitPrefix(a.name);
  const sb = stripKitPrefix(b.name);
  const ia = drumOrderIndex(sa);
  const ib = drumOrderIndex(sb);
  if (ia !== ib) return ia - ib;
  return sa.localeCompare(sb);
}

function stripKitPrefix(name) {
  const i = name.indexOf("_");
  return i > 0 ? name.slice(i + 1) : name;
}

function drumOrderIndex(suffix) {
  const idx = DRUM_ORDER.indexOf(suffix);
  return idx === -1 ? DRUM_ORDER.length : idx;
}

/**
 * Lightweight string scan: which of the registered sound names appear in
 * the editor buffer? Anchored on word boundaries so `bd` doesn't match
 * `bdsm` (yes, really — `bdsd` is a real Strudel sample). Cheap for
 * ~1000 sounds × ~2KB buffer.
 */
function scanInUse(text, sounds) {
  const out = new Set();
  if (!text) return out;
  for (const s of sounds) {
    // Use a word-boundary-style match. Sound names contain underscores,
    // which `\b` treats as a word char, so we manually check the chars
    // around the match instead.
    const name = s.name;
    let from = 0;
    while (from <= text.length) {
      const i = text.indexOf(name, from);
      if (i < 0) break;
      const before = i === 0 ? "" : text[i - 1];
      const after = text[i + name.length] ?? "";
      if (!isWordChar(before) && !isWordChar(after)) {
        out.add(name);
        break;
      }
      from = i + 1;
    }
  }
  return out;
}

function isWordChar(c) {
  return /[a-z0-9_]/i.test(c);
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Categorize all sounds in the soundMap by type for summary display.
 * `userSoundNameSet` is what `userSoundNames(banks)` returns.
 * Returns { total, kits, gm, synth, wavetable, user }.
 */
export function categorizeSounds(soundMapObj, userSoundNameSet = new Set()) {
  const result = { total: 0, kits: 0, gm: 0, synth: 0, wavetable: 0, user: 0 };
  if (!soundMapObj || typeof soundMapObj !== "object") return result;
  const sounds = collectSounds(soundMapObj);
  result.total = sounds.length;
  for (const s of sounds) {
    if (s.name.startsWith("gm_")) result.gm++;
    else if (s.name.startsWith("wt_")) result.wavetable++;
    else if (s.type === "synth") result.synth++;
    else if (userSoundNameSet.has(s.name)) result.user++;
    else result.kits++; // kit sounds + remaining samples
  }
  return result;
}
