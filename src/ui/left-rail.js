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
//     patterns,             // { [name]: codeString } — shipped patterns
//     userPatterns,         // string[] — user-created pattern names
//     dirtySet,             // Set<string> — shipped names with working copies
//     currentName,          // initially-selected pattern name (or null)
//     onSelect(name),       // called when the user picks a pattern
//     onCreate(),           // called when the user clicks the "+" button
//     onRevert(name),       // called when the user reverts a shipped pattern
//     onDelete(name),       // called when the user deletes a user pattern
//     devMode,              // bool — controls dev-only chrome
//   });
//   rail.setCurrent(name);
//   rail.clearCurrent();
//   rail.focusSearch();
//   rail.getCurrent();
//   rail.updateDirtySet(newSet);
//   rail.addUserPattern(name);
//   rail.removeUserPattern(name);
//
// Pure DOM, no framework. The whole component is rebuilt from scratch on
// every filter change — fast enough for a few hundred patterns and saves us
// a stale-DOM bug surface.

import { makeIcon } from "./icons.js";
import { confirm } from "./modal.js";

// ─── Pretty name ─────────────────────────────────────────────────────────
// Strips leading numeric+letter prefixes (e.g. "25-", "G3-") and title-cases
// the result so pattern names read like track titles, not filenames.
//   "25-dub"              → "Dub"
//   "G3-progression-demo" → "Progression Demo"
//   "ben-choir"           → "Ben Choir"
function prettyName(raw) {
  const stripped = raw.replace(/^[a-zA-Z]*\d+[a-zA-Z]*-/, "");
  const spaced = stripped.replace(/[-_]/g, " ");
  const titled = spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  return titled.trim() || raw;
}

export function mount({
  container,
  patterns,
  userPatterns: initialUserPatterns = [],
  dirtySet: initialDirtySet = new Set(),
  currentName = null,
  onSelect = () => {},
  onCreate = () => {},
  onImportMidi = () => {},
  onRevert = () => {},
  onDelete = () => {},
}) {
  if (!container) throw new Error("left-rail.mount: container is required");

  const shippedNames = Object.keys(patterns).sort();
  let userPatternNames = [...initialUserPatterns];
  let dirtySet = new Set(initialDirtySet);
  let activeName = currentName;
  let query = "";
  let listEl;
  let searchInput;

  // ─── Collapse state ───────────────────────────────────────────────────
  const COLLAPSE_KEY = "strasbeat:left-rail-collapsed";
  const EXPANDED_W = 240;
  const COLLAPSED_W = 36;
  let isCollapsed = localStorage.getItem(COLLAPSE_KEY) === "true";
  const shellEl = container.closest(".shell") ?? document.documentElement;

  // ─── Active context menu ──────────────────────────────────────────────
  let activeMenu = null;
  function dismissContextMenu() {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
    document.removeEventListener("click", onDocClickDismiss, true);
    document.removeEventListener("keydown", onDocKeyDismiss, true);
  }
  function onDocClickDismiss() {
    dismissContextMenu();
  }
  function onDocKeyDismiss(e) {
    if (e.key === "Escape") dismissContextMenu();
  }

  // ─── Collapse ─────────────────────────────────────────────────────────
  function toggleCollapse() {
    isCollapsed = !isCollapsed;
    localStorage.setItem(COLLAPSE_KEY, isCollapsed);
    applyCollapseState();
  }

  function applyCollapseState() {
    shellEl.style.setProperty(
      "--left-rail-w",
      isCollapsed ? `${COLLAPSED_W}px` : `${EXPANDED_W}px`,
    );
    container.setAttribute("data-collapsed", isCollapsed ? "true" : "false");
    const label = isCollapsed
      ? "Expand patterns panel"
      : "Collapse patterns panel";
    collapseBtn.setAttribute("aria-label", label);
    collapseBtn.title = label;
  }

  // ─── Build the static structure once ──────────────────────────────────
  container.replaceChildren();
  container.classList.add("left-rail__section");

  // Header: collapse toggle + title + "+" button.
  // Collapse button is first so it remains visible in the 36px collapsed strip.
  const header = el("div", "left-rail__header");

  const collapseBtn = el("button", "btn btn--icon left-rail__collapse-btn");
  collapseBtn.type = "button";
  collapseBtn.setAttribute(
    "aria-label",
    isCollapsed ? "Expand patterns panel" : "Collapse patterns panel",
  );
  collapseBtn.appendChild(makeIcon("chevron-left", { size: 14 }));
  collapseBtn.addEventListener("click", toggleCollapse);
  header.appendChild(collapseBtn);

  const title = el("span", "left-rail__title", "Patterns");
  header.appendChild(title);

  const plusBtn = el("button", "btn btn--icon left-rail__plus");
  plusBtn.type = "button";
  plusBtn.title = "Create a new pattern";
  plusBtn.setAttribute("aria-label", "New pattern");
  plusBtn.appendChild(makeIcon("plus"));
  plusBtn.addEventListener("click", () => onCreate());
  header.appendChild(plusBtn);

  const importBtn = el("button", "btn btn--icon left-rail__import");
  importBtn.type = "button";
  importBtn.title = "Import MIDI file";
  importBtn.setAttribute("aria-label", "Import MIDI");
  importBtn.appendChild(makeIcon("file-music", { size: 14 }));
  importBtn.addEventListener("click", () => onImportMidi());
  header.appendChild(importBtn);
  container.appendChild(header);

  // Search input
  const search = el("div", "left-rail__search");
  const searchIcon = el("span", "left-rail__search-icon");
  searchIcon.appendChild(makeIcon("search"));
  search.appendChild(searchIcon);

  searchInput = el("input", "left-rail__search-input");
  searchInput.type = "text";
  searchInput.placeholder = "Search patterns…";
  searchInput.setAttribute("aria-label", "Search patterns");
  searchInput.spellcheck = false;
  searchInput.autocomplete = "off";

  const clearBtn = el("button", "left-rail__search-clear");
  clearBtn.type = "button";
  clearBtn.title = "Clear search";
  clearBtn.setAttribute("aria-label", "Clear search");
  clearBtn.appendChild(makeIcon("x"));
  clearBtn.style.display = "none";
  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    query = "";
    clearBtn.style.display = "none";
    renderList();
    searchInput.focus();
  });

  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    clearBtn.style.display = query ? "" : "none";
    renderList();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      query = "";
      clearBtn.style.display = "none";
      renderList();
    } else if (e.key === "Enter") {
      const first = listEl.querySelector(".left-rail__item");
      if (first) first.click();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const first = listEl.querySelector(".left-rail__item");
      if (first) first.focus();
    }
  });
  search.appendChild(searchInput);
  search.appendChild(clearBtn);
  container.appendChild(search);

  // List
  listEl = el("div", "left-rail__list");
  listEl.setAttribute("role", "listbox");
  container.appendChild(listEl);

  renderList();
  applyCollapseState();

  // Scroll the active pattern into view after mount (no animation on first paint).
  requestAnimationFrame(() => {
    const activeRow = listEl.querySelector(".left-rail__item.is-active");
    if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
  });

  // ─── render: re-paint the list rows ───────────────────────────────────
  function renderList() {
    listEl.replaceChildren();

    // Match against both raw filename AND pretty display name so users
    // can search by either convention (e.g. "25" finds "25-dub").
    const filteredShipped = query
      ? shippedNames.filter(
          (n) =>
            n.toLowerCase().includes(query) ||
            prettyName(n).toLowerCase().includes(query),
        )
      : shippedNames;

    const filteredUser = query
      ? userPatternNames.filter(
          (n) =>
            n.toLowerCase().includes(query) ||
            prettyName(n).toLowerCase().includes(query),
        )
      : userPatternNames;

    if (!filteredShipped.length && !filteredUser.length) {
      const empty = el(
        "div",
        "left-rail__empty",
        query ? `No results for "${query}"` : "No patterns yet",
      );
      listEl.appendChild(empty);
      return;
    }

    // Shipped patterns
    for (const name of filteredShipped) {
      listEl.appendChild(buildRow(name, false));
    }

    // User patterns divider + rows
    if (filteredUser.length) {
      const divider = el("div", "left-rail__divider", "My patterns");
      listEl.appendChild(divider);
      for (const name of filteredUser) {
        listEl.appendChild(buildRow(name, true));
      }
    }
  }

  function buildRow(name, isUser) {
    const row = el("div", "left-rail__item");
    row.setAttribute("role", "option");
    row.setAttribute("tabindex", "-1");
    row.setAttribute("data-name", name);
    if (isUser) row.setAttribute("data-user", "");
    if (name === activeName) {
      row.classList.add("is-active");
      row.setAttribute("aria-selected", "true");
    }

    const accentEl = el("span", "left-rail__item-accent");
    accentEl.setAttribute("aria-hidden", "true");
    row.appendChild(accentEl);

    const nameEl = el("span", "left-rail__item-name");
    const display = prettyName(name);
    if (query) {
      const lowerDisplay = display.toLowerCase();
      const idx = lowerDisplay.indexOf(query);
      if (idx >= 0) {
        nameEl.appendChild(document.createTextNode(display.slice(0, idx)));
        const match = el(
          "span",
          "left-rail__item-match",
          display.slice(idx, idx + query.length),
        );
        nameEl.appendChild(match);
        nameEl.appendChild(
          document.createTextNode(display.slice(idx + query.length)),
        );
      } else {
        nameEl.textContent = display;
      }
    } else {
      nameEl.textContent = display;
    }
    row.appendChild(nameEl);

    const metaEl = el("span", "left-rail__item-meta");
    metaEl.setAttribute("aria-hidden", "true");

    // Modified dot for shipped patterns with working copies.
    if (!isUser && dirtySet.has(name)) {
      const dot = el("span", "left-rail__dirty-dot");
      dot.title = "Modified";
      metaEl.appendChild(dot);
    }

    // Hover-reveal action button — visible alternative to right-click.
    if (isUser || dirtySet.has(name)) {
      const moreBtn = el("button", "left-rail__more-btn");
      moreBtn.type = "button";
      moreBtn.setAttribute("aria-label", "Pattern options");
      moreBtn.appendChild(makeIcon("more-horizontal", { size: 12 }));
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rect = moreBtn.getBoundingClientRect();
        // Open below the button so it reads as a dropdown, not a tooltip.
        showContextMenu(rect.left, rect.bottom, name, isUser);
      });
      metaEl.appendChild(moreBtn);
    }

    row.appendChild(metaEl);

    row.addEventListener("click", () => {
      dismissContextMenu();
      setCurrent(name);
      onSelect(name);
    });

    // Keyboard navigation within the list.
    row.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = nextItem(row);
        if (next) next.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = prevItem(row);
        if (prev) prev.focus();
        else searchInput.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        row.click();
      } else if (e.key === "Escape") {
        searchInput.focus();
      }
    });

    // Context menu on right-click.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, name, isUser);
    });

    return row;
  }

  /** Next .left-rail__item sibling, skipping dividers. */
  function nextItem(current) {
    let el = current.nextElementSibling;
    while (el && !el.classList.contains("left-rail__item"))
      el = el.nextElementSibling;
    return el;
  }
  /** Previous .left-rail__item sibling, skipping dividers. */
  function prevItem(current) {
    let el = current.previousElementSibling;
    while (el && !el.classList.contains("left-rail__item"))
      el = el.previousElementSibling;
    return el;
  }

  // ─── Context menu ─────────────────────────────────────────────────────
  function showContextMenu(x, y, name, isUser) {
    dismissContextMenu();
    const menu = el("div", "left-rail__context-menu");

    if (isUser) {
      const deleteItem = el(
        "button",
        "left-rail__context-item left-rail__context-item--danger",
        "Delete pattern",
      );
      deleteItem.type = "button";
      deleteItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        dismissContextMenu();
        try {
          const ok = await confirm({
            title: `Delete "${name}"?`,
            message: "This can\u2019t be undone.",
            confirmLabel: "Delete",
            cancelLabel: "Cancel",
            destructive: true,
          });
          if (ok) onDelete(name);
        } finally {
          dismissContextMenu();
        }
      });
      menu.appendChild(deleteItem);
    } else if (dirtySet.has(name)) {
      const revertItem = el(
        "button",
        "left-rail__context-item",
        "Revert to original",
      );
      revertItem.type = "button";
      revertItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        dismissContextMenu();
        try {
          const ok = await confirm({
            title: "Revert to original?",
            message: `Your changes to "${name}" will be lost. This can\u2019t be undone.`,
            confirmLabel: "Revert",
            cancelLabel: "Cancel",
            destructive: true,
          });
          if (ok) onRevert(name);
        } finally {
          dismissContextMenu();
        }
      });
      menu.appendChild(revertItem);
    } else {
      // No actions available for a clean shipped pattern.
      return;
    }

    document.body.appendChild(menu);
    activeMenu = menu;

    // Clamp to viewport so the menu doesn't clip off-screen.
    const rect = menu.getBoundingClientRect();
    const clampedX = Math.min(x, window.innerWidth - rect.width - 8);
    const clampedY = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(0, clampedX)}px`;
    menu.style.top = `${Math.max(0, clampedY)}px`;

    // Dismiss on next click or Escape.
    requestAnimationFrame(() => {
      document.addEventListener("click", onDocClickDismiss, true);
      document.addEventListener("keydown", onDocKeyDismiss, true);
    });
  }

  function setCurrent(name) {
    activeName = name;
    for (const row of listEl.querySelectorAll(".left-rail__item")) {
      const matches = row.dataset.name === name;
      row.classList.toggle("is-active", matches);
      if (matches) row.setAttribute("aria-selected", "true");
      else row.removeAttribute("aria-selected");
    }
  }

  function clearCurrent() {
    activeName = null;
    for (const row of listEl.querySelectorAll(".left-rail__item")) {
      row.classList.remove("is-active");
      row.removeAttribute("aria-selected");
    }
  }

  function focusSearch() {
    searchInput.focus();
    searchInput.select();
  }

  function getCurrent() {
    return activeName;
  }

  /** Update the set of shipped patterns that have working copies. */
  function updateDirtySet(newSet) {
    dirtySet = new Set(newSet);
    renderList();
  }

  /** Add a new user pattern to the list (appears immediately). */
  function addUserPattern(name) {
    if (!userPatternNames.includes(name)) {
      userPatternNames.push(name);
      renderList();
    }
  }

  /** Remove a user pattern from the list. */
  function removeUserPattern(name) {
    userPatternNames = userPatternNames.filter((n) => n !== name);
    renderList();
  }

  return {
    setCurrent,
    clearCurrent,
    focusSearch,
    getCurrent,
    updateDirtySet,
    addUserPattern,
    removeUserPattern,
  };
}

// ─── Tiny DOM helpers ────────────────────────────────────────────────────

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
