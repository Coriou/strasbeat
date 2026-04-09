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

export function mount({
  container,
  patterns,
  userPatterns: initialUserPatterns = [],
  dirtySet: initialDirtySet = new Set(),
  currentName = null,
  onSelect = () => {},
  onCreate = () => {},
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

  // ─── Build the static structure once ──────────────────────────────────
  container.replaceChildren();
  container.classList.add("left-rail__section");

  // Header: title + "+" button
  const header = el("div", "left-rail__header");
  const title = el("span", "left-rail__title", "Patterns");
  header.appendChild(title);

  const plusBtn = el("button", "btn btn--icon left-rail__plus");
  plusBtn.type = "button";
  plusBtn.title = "Create a new pattern";
  plusBtn.setAttribute("aria-label", "New pattern");
  plusBtn.appendChild(makeIcon("plus"));
  plusBtn.addEventListener("click", () => onCreate());
  header.appendChild(plusBtn);
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
  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    renderList();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      query = "";
      renderList();
    } else if (e.key === "Enter") {
      const first = listEl.querySelector(".left-rail__item");
      if (first) first.click();
    }
  });
  search.appendChild(searchInput);
  container.appendChild(search);

  // List
  listEl = el("div", "left-rail__list");
  listEl.setAttribute("role", "listbox");
  container.appendChild(listEl);

  renderList();

  // ─── render: re-paint the list rows ───────────────────────────────────
  function renderList() {
    listEl.replaceChildren();

    const filteredShipped = query
      ? shippedNames.filter((name) => name.toLowerCase().includes(query))
      : shippedNames;

    const filteredUser = query
      ? userPatternNames.filter((name) => name.toLowerCase().includes(query))
      : userPatternNames;

    if (!filteredShipped.length && !filteredUser.length) {
      const empty = el(
        "div",
        "left-rail__empty",
        query ? `no patterns match "${query}"` : "no patterns",
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
    row.setAttribute("data-name", name);
    if (isUser) row.setAttribute("data-user", "");
    if (name === activeName) {
      row.classList.add("is-active");
      row.setAttribute("aria-selected", "true");
    }

    const nameEl = el("span", "left-rail__item-name");
    if (query) {
      const lower = name.toLowerCase();
      const idx = lower.indexOf(query);
      if (idx >= 0) {
        nameEl.appendChild(document.createTextNode(name.slice(0, idx)));
        const match = el(
          "span",
          "left-rail__item-match",
          name.slice(idx, idx + query.length),
        );
        nameEl.appendChild(match);
        nameEl.appendChild(
          document.createTextNode(name.slice(idx + query.length)),
        );
      } else {
        nameEl.textContent = name;
      }
    } else {
      nameEl.textContent = name;
    }
    row.appendChild(nameEl);

    // Modified dot for shipped patterns with working copies.
    if (!isUser && dirtySet.has(name)) {
      const dot = el("span", "left-rail__dirty-dot");
      dot.title = "Modified — right-click to revert";
      row.appendChild(dot);
    }

    row.addEventListener("click", () => {
      dismissContextMenu();
      setCurrent(name);
      onSelect(name);
    });

    // Context menu on right-click.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, name, isUser);
    });

    return row;
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
        const ok = await confirm({
          title: `Delete "${name}"?`,
          message: "This can\u2019t be undone.",
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          destructive: true,
        });
        if (ok) onDelete(name);
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
        const ok = await confirm({
          title: "Revert to original?",
          message: `Your changes to "${name}" will be lost. This can\u2019t be undone.`,
          confirmLabel: "Revert",
          cancelLabel: "Cancel",
          destructive: true,
        });
        if (ok) onRevert(name);
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
