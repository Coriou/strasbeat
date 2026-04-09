// Left rail — patterns library.
//
// Replaces the old `<select id="pattern-picker">` with a custom component
// that can grow into other collections (instruments, samples, captured
// phrases) without a layout refactor. See design/SYSTEM.md §3 and
// design/work/01-shell.md.
//
// Public surface:
//   const rail = mount({
//     container,            // HTMLElement to render into (and own)
//     patterns,             // { [name]: codeString }
//     currentName,          // initially-selected pattern name (or null)
//     onSelect(name),       // called when the user picks a pattern
//     onCreate(),           // called when the user clicks the "+" button
//     devMode,              // bool — controls "+" visibility
//   });
//   rail.setCurrent(name);  // imperative — used by the share-link flow,
//                           //   capture flow etc. to keep the rail in sync
//                           //   with editor state changes that didn't go
//                           //   through onSelect.
//   rail.clearCurrent();    // when nothing in the library matches the editor
//                           //   contents (e.g. shared link, captured phrase).
//
// Pure DOM, no framework. The whole component is rebuilt from scratch on
// every filter change — fast enough for a few hundred patterns and saves us
// a stale-DOM bug surface.

import { makeIcon } from './icons.js';

export function mount({
  container,
  patterns,
  currentName = null,
  onSelect = () => {},
  onCreate = () => {},
  devMode = false,
}) {
  if (!container) throw new Error('left-rail.mount: container is required');

  const allNames = Object.keys(patterns).sort();
  let activeName = currentName;
  let query = '';
  let listEl;        // re-bound on render
  let searchInput;

  // ─── Build the static structure once ──────────────────────────────────
  container.replaceChildren();
  container.classList.add('left-rail__section');

  // Header: title + "+" button
  const header = el('div', 'left-rail__header');
  const title = el('span', 'left-rail__title', 'Patterns');
  header.appendChild(title);

  const plusBtn = el('button', 'btn btn--icon left-rail__plus');
  if (devMode) plusBtn.classList.add('dev-only');
  plusBtn.type = 'button';
  plusBtn.title = 'Create a new pattern';
  plusBtn.setAttribute('aria-label', 'New pattern');
  plusBtn.appendChild(makeIcon('plus'));
  plusBtn.addEventListener('click', () => onCreate());
  if (!devMode) plusBtn.classList.add('dev-only');   // hidden in prod
  header.appendChild(plusBtn);
  container.appendChild(header);

  // Search input
  const search = el('div', 'left-rail__search');
  const searchIcon = el('span', 'left-rail__search-icon');
  searchIcon.appendChild(makeIcon('search'));
  search.appendChild(searchIcon);

  searchInput = el('input', 'left-rail__search-input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search patterns…';
  searchInput.setAttribute('aria-label', 'Search patterns');
  searchInput.spellcheck = false;
  searchInput.autocomplete = 'off';
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    renderList();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      query = '';
      renderList();
    } else if (e.key === 'Enter') {
      // Pick the first visible match — quick keyboard nav.
      const first = listEl.querySelector('.left-rail__item');
      if (first) first.click();
    }
  });
  search.appendChild(searchInput);
  container.appendChild(search);

  // List
  listEl = el('div', 'left-rail__list');
  listEl.setAttribute('role', 'listbox');
  container.appendChild(listEl);

  renderList();

  // ─── render: re-paint the list rows ───────────────────────────────────
  function renderList() {
    listEl.replaceChildren();
    const filtered = query
      ? allNames.filter((name) => name.toLowerCase().includes(query))
      : allNames;

    if (!filtered.length) {
      const empty = el('div', 'left-rail__empty', query ? `no patterns match "${query}"` : 'no patterns');
      listEl.appendChild(empty);
      return;
    }

    for (const name of filtered) {
      const row = el('div', 'left-rail__item');
      row.setAttribute('role', 'option');
      row.setAttribute('data-name', name);
      if (name === activeName) {
        row.classList.add('is-active');
        row.setAttribute('aria-selected', 'true');
      }
      const nameEl = el('span', 'left-rail__item-name');
      if (query) {
        // Highlight the matching substring.
        const lower = name.toLowerCase();
        const idx = lower.indexOf(query);
        if (idx >= 0) {
          nameEl.appendChild(document.createTextNode(name.slice(0, idx)));
          const match = el('span', 'left-rail__item-match', name.slice(idx, idx + query.length));
          nameEl.appendChild(match);
          nameEl.appendChild(document.createTextNode(name.slice(idx + query.length)));
        } else {
          nameEl.textContent = name;
        }
      } else {
        nameEl.textContent = name;
      }
      row.appendChild(nameEl);
      row.addEventListener('click', () => {
        setCurrent(name);
        onSelect(name);
      });
      listEl.appendChild(row);
    }
  }

  function setCurrent(name) {
    activeName = name;
    // Cheap O(n) refresh of the .is-active class only — no full re-render.
    for (const row of listEl.querySelectorAll('.left-rail__item')) {
      const matches = row.dataset.name === name;
      row.classList.toggle('is-active', matches);
      if (matches) row.setAttribute('aria-selected', 'true');
      else row.removeAttribute('aria-selected');
    }
  }

  function clearCurrent() {
    activeName = null;
    for (const row of listEl.querySelectorAll('.left-rail__item')) {
      row.classList.remove('is-active');
      row.removeAttribute('aria-selected');
    }
  }

  function focusSearch() {
    searchInput.focus();
    searchInput.select();
  }

  function getCurrent() {
    return activeName;
  }

  return { setCurrent, clearCurrent, focusSearch, getCurrent };
}

// ─── Tiny DOM helpers ────────────────────────────────────────────────────

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
