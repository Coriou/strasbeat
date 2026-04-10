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

import { makeIcon } from './icons.js';

const SEARCH_DEBOUNCE_MS = 150;

// Conventional drum step ordering — within a kit group, recognised drum
// suffixes sort first in this order, then everything else falls back to
// alphabetical. Lifted from common DAW sample browsers.
const DRUM_ORDER = [
  'bd', 'kick', 'sd', 'snare', 'rim', 'cp', 'clap',
  'hh', 'ch', 'oh', 'ho',
  'lt', 'mt', 'ht', 'tom',
  'cb', 'cy', 'cr', 'crash', 'rd', 'ride', 'sh', 'shaker',
];

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
  let currentBufferText = '';
  let query = '';
  let category = 'all'; // all | kits | gm | synth
  let activeIndex = -1; // index into the currently-rendered flat list

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

  // ─── Right-rail panel spec ────────────────────────────────────────────

  return {
    id: 'sounds',
    icon: 'music',
    label: 'Sound browser',
    create,
    activate,
    deactivate,
    refresh,
    setBufferText,
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────

  function create(container) {
    root = container;
    root.classList.add('sound-browser');

    // Header — search input.
    const header = el('div', 'sound-browser__header');
    const search = el('div', 'sound-browser__search');
    const searchIcon = el('span', 'sound-browser__search-icon');
    searchIcon.appendChild(makeIcon('search'));
    search.appendChild(searchIcon);

    searchInput = el('input', 'sound-browser__search-input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search sounds…';
    searchInput.setAttribute('aria-label', 'Search sounds');
    searchInput.spellcheck = false;
    searchInput.autocomplete = 'off';
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('keydown', onSearchKeydown);
    search.appendChild(searchInput);
    header.appendChild(search);
    root.appendChild(header);

    // Category pills.
    pillsEl = el('div', 'sound-browser__pills');
    pillsEl.setAttribute('role', 'tablist');
    pillsEl.setAttribute('aria-label', 'Sound category');
    for (const c of [
      { id: 'all', label: 'All' },
      { id: 'kits', label: 'Kits' },
      { id: 'gm', label: 'GM' },
      { id: 'synth', label: 'Synth' },
    ]) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'sound-browser__pill';
      pill.dataset.category = c.id;
      pill.textContent = c.label;
      pill.setAttribute('role', 'tab');
      pill.setAttribute('aria-selected', c.id === category ? 'true' : 'false');
      if (c.id === category) pill.classList.add('is-active');
      pill.addEventListener('click', () => {
        category = c.id;
        for (const p of pillsEl.querySelectorAll('.sound-browser__pill')) {
          const isMe = p.dataset.category === category;
          p.classList.toggle('is-active', isMe);
          p.setAttribute('aria-selected', isMe ? 'true' : 'false');
        }
        render();
      });
      pillsEl.appendChild(pill);
    }
    root.appendChild(pillsEl);

    // List container — scroll region for groups + sound items.
    listEl = el('div', 'sound-browser__list');
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-label', 'Sounds');
    listEl.addEventListener('keydown', onListKeydown);
    root.appendChild(listEl);

    // Footer — count of visible / total sounds.
    countEl = el('div', 'sound-browser__count');
    root.appendChild(countEl);

    mounted = true;
    refresh();
  }

  function activate() {
    if (!mounted) return;
    // Re-read in case the soundMap was populated after prebake but before
    // the user opened the panel for the first time.
    refresh();
    // Focus the search input so the first keystroke goes there.
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }

  function deactivate() {
    clearTimeout(searchTimer);
  }

  // ─── Public helpers ───────────────────────────────────────────────────

  function refresh() {
    allSounds = collectSounds(getSoundMap());
    if (mounted) render();
  }

  function setBufferText(text) {
    currentBufferText = text ?? '';
    inUse = scanInUse(currentBufferText, allSounds);
    if (mounted) updateInUseHighlights();
  }

  // ─── Render ───────────────────────────────────────────────────────────

  function render() {
    if (!listEl) return;
    listEl.replaceChildren();
    flatVisible = [];
    activeIndex = -1;

    // 1. Filter by category.
    const visible = allSounds.filter((s) => matchCategory(s, category));

    // 2. Filter by search query (substring on name + kit).
    const filtered = query
      ? visible.filter((s) => {
          const lname = s.name.toLowerCase();
          const lkit = s.kit ? s.kit.toLowerCase() : '';
          return lname.includes(query) || lkit.includes(query);
        })
      : visible;

    countEl.textContent = filtered.length === allSounds.length
      ? `${allSounds.length} sounds`
      : `${filtered.length} of ${allSounds.length}`;

    if (allSounds.length === 0) {
      const empty = el('div', 'sound-browser__empty', 'no sounds loaded yet');
      listEl.appendChild(empty);
      return;
    }
    if (filtered.length === 0) {
      const empty = el(
        'div',
        'sound-browser__empty',
        query ? `no sounds match "${query}"` : 'no sounds in this category',
      );
      listEl.appendChild(empty);
      return;
    }

    // 3. Render mode depends on category:
    //    - kits: collapsible groups by kit prefix
    //    - synth, gm, all (with no query): collapsible groups too
    //    - all (with query): flat alphabetical list (groups would
    //      collapse most of the matches anyway)
    const useGroups = (category !== 'all') || !query;
    if (useGroups) renderGrouped(filtered);
    else renderFlat(filtered);
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
    const frag = document.createDocumentFragment();
    for (const s of sorted) {
      frag.appendChild(buildSoundItem(s));
      flatVisible.push({ name: s.name, kit: s.kit });
    }
    listEl.appendChild(frag);
  }

  function buildGroup(key, sounds) {
    const group = el('div', 'sound-browser__group');
    const head = el('button', 'sound-browser__group-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'true');

    const chev = el('span', 'sound-browser__group-chev');
    chev.appendChild(makeIcon('chevron-down'));
    head.appendChild(chev);

    const label = el('span', 'sound-browser__group-label', key);
    head.appendChild(label);

    const total = sounds.reduce((n, s) => n + Math.max(1, s.sampleCount), 0);
    const meta = el('span', 'sound-browser__group-meta', `${sounds.length}`);
    meta.title = `${sounds.length} sound${sounds.length === 1 ? '' : 's'}, ${total} sample${total === 1 ? '' : 's'}`;
    head.appendChild(meta);

    const items = el('div', 'sound-browser__group-items');
    for (const s of sounds) {
      items.appendChild(buildSoundItem(s));
      flatVisible.push({ name: s.name, kit: s.kit });
    }

    head.addEventListener('click', () => {
      const collapsed = group.classList.toggle('is-collapsed');
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });

    group.appendChild(head);
    group.appendChild(items);
    return group;
  }

  function buildSoundItem(sound) {
    const item = el('div', 'sound-browser__item');
    item.setAttribute('role', 'option');
    item.setAttribute('tabindex', '-1');
    item.dataset.soundName = sound.name;
    if (inUse.has(sound.name)) item.classList.add('is-in-use');

    // The "name" is shown without its kit prefix when we're in a kit
    // group, to reduce visual repetition (`bd`, `sd`, `hh` instead of
    // `808_bd`, `808_sd`, `808_hh`).
    const displayName = sound.kit && sound.name.startsWith(sound.kit + '_')
      ? sound.name.slice(sound.kit.length + 1)
      : sound.name;

    const nameEl = el('span', 'sound-browser__item-name');
    appendHighlightedText(nameEl, displayName, query);
    item.appendChild(nameEl);

    if (sound.sampleCount > 1) {
      const meta = el('span', 'sound-browser__item-meta', `${sound.sampleCount}`);
      meta.title = `${sound.sampleCount} variations`;
      item.appendChild(meta);
    }

    // Mousedown previews. We use mousedown (not click) so the audition
    // fires the instant the user touches the row — feels more like an
    // instrument and avoids the click-vs-double-click delay. Insert is on
    // double-click, which fires its own dblclick event later.
    item.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      previewSound(sound.name, item);
    });
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      insertSound(sound.name);
    });

    // Click also focuses the item so arrow keys take over from there.
    item.addEventListener('click', () => focusItem(sound.name));

    return item;
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
    const match = el('span', 'sound-browser__item-match', text.slice(idx, idx + q.length));
    parent.appendChild(match);
    parent.appendChild(document.createTextNode(text.slice(idx + q.length)));
  }

  function updateInUseHighlights() {
    if (!listEl) return;
    for (const item of listEl.querySelectorAll('.sound-browser__item')) {
      const name = item.dataset.soundName;
      item.classList.toggle('is-in-use', inUse.has(name));
    }
  }

  // ─── Interactions ─────────────────────────────────────────────────────

  function previewSound(name, itemEl) {
    try {
      onPreview(name);
    } catch (err) {
      console.warn('[sound-browser] preview failed:', err);
    }
    if (!itemEl) return;
    itemEl.classList.add('is-previewing');
    setTimeout(() => itemEl.classList.remove('is-previewing'), 500);
  }

  function insertSound(name) {
    try {
      onInsert(name);
    } catch (err) {
      console.warn('[sound-browser] insert failed:', err);
    }
  }

  function focusItem(name) {
    activeIndex = flatVisible.findIndex((s) => s.name === name);
    paintActive();
  }

  function paintActive() {
    if (!listEl) return;
    for (const item of listEl.querySelectorAll('.sound-browser__item')) {
      item.classList.remove('is-active');
    }
    if (activeIndex < 0 || activeIndex >= flatVisible.length) return;
    const name = flatVisible[activeIndex].name;
    const target = listEl.querySelector(`.sound-browser__item[data-sound-name="${cssEscape(name)}"]`);
    if (target) {
      target.classList.add('is-active');
      target.scrollIntoView({ block: 'nearest' });
      target.focus({ preventScroll: true });
    }
  }

  function moveActive(delta) {
    if (flatVisible.length === 0) return;
    if (activeIndex < 0) {
      activeIndex = delta > 0 ? 0 : flatVisible.length - 1;
    } else {
      activeIndex = (activeIndex + delta + flatVisible.length) % flatVisible.length;
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
    if (e.key === 'Escape') {
      if (searchInput.value) {
        e.preventDefault();
        searchInput.value = '';
        query = '';
        render();
        return;
      }
      e.preventDefault();
      onFocusEditor();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Flush the debounce so render() has the freshest filter, then jump
      // into the list.
      clearTimeout(searchTimer);
      query = searchInput.value.trim().toLowerCase();
      render();
      moveActive(+1);
      return;
    }
    if (e.key === 'Enter') {
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
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(+1);
      return;
    }
    if (e.key === 'ArrowUp') {
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
    if (e.key === 'Escape') {
      e.preventDefault();
      onFocusEditor();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex < 0) return;
      const name = flatVisible[activeIndex].name;
      if (e.shiftKey) insertSound(name);
      else previewSound(name, currentItemEl());
    }
  }

  function currentItemEl() {
    if (activeIndex < 0 || !listEl) return null;
    const name = flatVisible[activeIndex].name;
    return listEl.querySelector(`.sound-browser__item[data-sound-name="${cssEscape(name)}"]`);
  }

  function matchCategory(s, c) {
    switch (c) {
      case 'kits': return !!s.kit;
      case 'gm': return s.name.startsWith('gm_');
      case 'synth': return s.type === 'synth';
      case 'all':
      default: return true;
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
function collectSounds(soundMapObj) {
  if (!soundMapObj || typeof soundMapObj !== 'object') {
    console.warn('[sound-browser] soundMap is empty or invalid:', soundMapObj);
    return [];
  }
  const names = Object.keys(soundMapObj);
  if (names.length === 0) {
    console.warn('[sound-browser] soundMap has no sounds — has prebake completed?');
    return [];
  }

  // First pass — count prefix occurrences so we can decide which prefixes
  // qualify as kits (3+ members).
  const prefixCounts = new Map();
  for (const name of names) {
    const prefix = splitPrefix(name);
    if (!prefix) continue;
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
      : (typeof data.samples === 'object' && data.samples != null)
      ? Object.values(data.samples).reduce(
          (n, v) => n + (Array.isArray(v) ? v.length : 1),
          0,
        )
      : 1;
    const prefix = splitPrefix(name);
    const kit = prefix && kitPrefixes.has(prefix) ? prefix : null;
    out.push({
      name,
      type: data.type ?? inferType(name),
      sampleCount,
      kit,
    });
  }
  return out;
}

function splitPrefix(name) {
  const i = name.indexOf('_');
  if (i <= 0) return null;
  return name.slice(0, i);
}

function inferType(name) {
  if (name.startsWith('gm_')) return 'soundfont';
  // Strudel's built-in synth waveform names — the few sounds the soundMap
  // ships with `data.type === 'synth'` are exactly this set, but in case
  // a future bank skips the type field we still want to bucket them.
  if (['sine', 'sawtooth', 'square', 'triangle', 'pulse', 'supersaw',
       'pwm', 'noise', 'pink', 'brown', 'white', 'crackle'].includes(name)) {
    return 'synth';
  }
  return 'sample';
}

function bucketLabel(sound) {
  switch (sound.type) {
    case 'synth': return 'synth';
    case 'soundfont': return 'soundfonts';
    case 'sample': return 'samples';
    default: return sound.type ?? 'other';
  }
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
  const i = name.indexOf('_');
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
      const before = i === 0 ? '' : text[i - 1];
      const after = text[i + name.length] ?? '';
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

function cssEscape(s) {
  // Use the standards CSS.escape if available; the names we get are
  // [a-z0-9_-]+ in practice but defending against future weirdness
  // (`/`, `:`) is cheap.
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/[^a-z0-9_-]/gi, '\\$&');
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
