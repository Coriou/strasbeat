// Left rail — patterns library.
//
// Replaces the old `<select id="pattern-picker">` with a custom component
// that can grow into other collections (instruments, samples, captured
// phrases) without a layout refactor. See design/SYSTEM.md §3 and
// design/work/01-shell.md.
//
// Public surface:
//   const rail = mount({
//     container,              // HTMLElement to render into (and own)
//     patterns,               // { [name]: codeString } — shipped patterns (Demos)
//     folders,                // string[] — user-defined folder names in display order
//     groupedUserPatterns,    // { folders: { [name]: string[] }, unfiled: string[] }
//     collapsedFolders,       // string[] — folder names whose state is "collapsed".
//                             //   "__demos__" is the reserved key for the Demos section.
//     dirtySet,               // Set<string> — shipped names with working copies
//     currentName,            // initially-selected pattern name (or null)
//     onSelect(name),         // user picks a pattern
//     onCreate(),             // "+" pattern button
//     onCreateFolder(),       // "+ folder" button
//     onImportMidi(),         // MIDI import button
//     onRevert(name),         // revert a shipped pattern
//     onDelete(name),         // delete a user pattern
//     onCollapseChange(folderKey, isCollapsed),  // persist collapse state
//     // Task 8/9/10/11/14 props — accepted now so the shape is stable:
//     onMoveTo, onDuplicate, onRenamePattern, onRenameFolder, onDeleteFolder
//   });
//   rail.setCurrent(name);
//   rail.clearCurrent();
//   rail.focusSearch();
//   rail.getCurrent();
//   rail.updateDirtySet(newSet);
//   rail.addUserPattern(name, folder?);
//   rail.removeUserPattern(name);
//   rail.setData({ groupedUserPatterns?, folders?, collapsedFolders?, dirtySet? });
//
// Pure DOM, no framework. The whole component is rebuilt from scratch on
// every filter change — fast enough for a few hundred patterns and saves us
// a stale-DOM bug surface.

import { makeIcon } from "./icons.js";
import { confirm } from "./modal.js";
import { score } from "./fuzzy.js";
import { validatePatternName, validateFolderName } from "../patterns.js";

// Cap the number of rendered search results. Beyond this we render a
// "+N more — refine your search…" hint so the rail stays scannable.
const SEARCH_RESULT_LIMIT = 50;

// Reserved collapse-state key for the synthetic Demos section. Picked so it
// can't collide with a user folder named "Demos" (which validation rejects
// anyway — belt-and-suspenders).
const DEMOS_KEY = "__demos__";

// Reserved drop-target key for the Unfiled section. A drop on this key
// resolves to `folder: null` (clears the pattern's folder field). Picked
// with the same `__…__` convention so it can't collide with a user folder.
const UNFILED_KEY = "__unfiled__";

// Hover-to-expand spring-load duration during drag. Mirrors macOS Finder.
const SPRING_LOAD_MS = 500;

// Auto-scroll near the rail's vertical edges during a drag. Number of px
// from the edge to start scrolling, and number of px to scroll per event.
const AUTOSCROLL_EDGE_PX = 24;
const AUTOSCROLL_STEP_PX = 8;

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

// ─── Inline rename helper ────────────────────────────────────────────────
/**
 * Start in-place rename on an element. Replaces `displayEl` with a text
 * input, commits on Enter (after validation), cancels on Escape, commits
 * on blur. `validate(value)` returns an error string or null.
 *
 * The cleanup guard prevents double-commits: pressing Enter calls commit()
 * which calls cleanup() — but the input being removed from the DOM also
 * fires a blur event, which would re-enter commit() with a stale value.
 */
function beginInlineEdit({ displayEl, initial, validate, onCommit, onCancel }) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "left-rail__inline-edit";
  input.value = initial;
  input.setAttribute("aria-label", "Rename");

  const parent = displayEl.parentNode;
  parent.replaceChild(input, displayEl);

  const errEl = document.createElement("div");
  errEl.className = "left-rail__inline-error";
  parent.appendChild(errEl);

  input.focus();
  input.select();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (input.parentNode) parent.replaceChild(displayEl, input);
    if (errEl.parentNode) errEl.remove();
  }
  function commit() {
    const value = input.value.trim();
    if (value === initial) {
      cleanup();
      onCancel?.();
      return;
    }
    const err = validate(value);
    if (err) {
      errEl.textContent = err;
      input.classList.add("left-rail__inline-edit--error");
      // Don't cleanup — let the user fix it.
      input.focus();
      input.select();
      return;
    }
    cleanup();
    onCommit(value);
  }
  function cancel() {
    cleanup();
    onCancel?.();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else {
      // Stop bubbling so the row/header keydown handlers don't react
      // (e.g. Cmd-A while editing should select input text, not all rows).
      e.stopPropagation();
    }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  // Commit-on-blur for consistency with VS Code. The cleanup guard prevents
  // double-commits when Enter triggers a blur.
  input.addEventListener("blur", () => {
    if (!cleaned) commit();
  });
}

export function mount({
  container,
  patterns,
  folders = [],
  groupedUserPatterns = { folders: {}, unfiled: [] },
  collapsedFolders = [],
  dirtySet: initialDirtySet = new Set(),
  currentName = null,
  onSelect = () => {},
  onCreate = () => {},
  onCreateFolder = () => {},
  onImportMidi = () => {},
  onRevert = () => {},
  onDelete = () => {},
  onCollapseChange = () => {},
  // Tasks 8/9/10/11/14 — accept now so the prop shape is stable.
  // onMoveTo and onDuplicate are wired by Task 8 (drag-to-move and
  // drag-to-fork); the rest land in later tasks.
  onMoveTo = () => {},
  onDuplicate = () => {},
  onRenamePattern = () => {},
  onRenameFolder = () => {},
  onDeleteFolder = () => {},
  // Task 9 — bulk callbacks fired by Cmd-D / Cmd-Backspace when a
  // multi-selection is active. Wired by Tasks 15 / 17.
  // eslint-disable-next-line no-unused-vars
  onBulkDuplicate = () => {},
  // eslint-disable-next-line no-unused-vars
  onBulkDelete = () => {},
  // eslint-disable-next-line no-unused-vars
  onBulkMove = () => {},
}) {
  if (!container) throw new Error("left-rail.mount: container is required");

  const shippedNames = Object.keys(patterns).sort();
  let groupedUserPatterns_ = groupedUserPatterns;
  let folders_ = [...folders];
  const collapsedSet = new Set(collapsedFolders);
  let dirtySet = new Set(initialDirtySet);
  let activeName = currentName;
  let query = "";
  let listEl;
  let searchInput;

  // Multi-select selection set. Populated by click handlers and bulk
  // keyboard shortcuts; persists across re-renders within a session so the
  // visible highlight survives HMR / search refreshes. `lastClickedName`
  // anchors shift-range selection.
  const selectedNames = new Set();
  let lastClickedName = null;

  function clearSelection() {
    selectedNames.clear();
    paintSelection();
  }

  function paintSelection() {
    for (const row of listEl.querySelectorAll(".left-rail__item")) {
      row.classList.toggle(
        "is-selected",
        selectedNames.has(row.dataset.name),
      );
    }
  }

  // Distinguish user patterns from Demos for keyboard-driven bulk delete.
  // Demos come from the `patterns` keys; everything else is a user pattern.
  function isUserName(name) {
    return !(name in patterns);
  }

  // ─── Inline rename wiring ────────────────────────────────────────────
  /**
   * Set of every name currently known to the rail — Demos + grouped user
   * patterns (folders + unfiled). Used by the rename validator to reject
   * collisions.
   */
  function allExistingNames() {
    const set = new Set(Object.keys(patterns));
    for (const names of Object.values(groupedUserPatterns_.folders ?? {})) {
      for (const n of names) set.add(n);
    }
    for (const n of groupedUserPatterns_.unfiled ?? []) set.add(n);
    return set;
  }

  /** Start an inline rename on a user-pattern row. */
  function renamePatternRow(row, name) {
    const nameEl = row.querySelector(".left-rail__item-name");
    if (!nameEl) return;
    beginInlineEdit({
      displayEl: nameEl,
      initial: name,
      validate: (v) => {
        if (v === name) return null;
        const err = validatePatternName(v);
        if (err) return err;
        if (allExistingNames().has(v)) return `"${v}" already exists`;
        return null;
      },
      onCommit: (newName) => onRenamePattern(name, newName),
    });
  }

  /** Start an inline rename on a user-folder header. */
  function renameFolderRow(header, folderName) {
    const nameEl = header.querySelector(".left-rail__folder-name");
    if (!nameEl) return;
    beginInlineEdit({
      displayEl: nameEl,
      initial: folderName,
      validate: (v) =>
        validateFolderName(
          v,
          folders_.filter((f) => f !== folderName),
        ),
      onCommit: (newName) => onRenameFolder(folderName, newName),
    });
  }

  // Spring-load state — used during drag-over on a collapsed folder.
  // After SPRING_LOAD_MS of continuous hover the folder auto-expands so the
  // user can drop into it. Cancelled if the drag leaves or ends.
  let springTimer = null;
  let springFolder = null;

  // ─── Collapse state (whole rail panel) ────────────────────────────────
  const COLLAPSE_KEY = "strasbeat:left-rail-collapsed";
  const EXPANDED_W = 240;
  const COLLAPSED_W = 36;
  let isPanelCollapsed = localStorage.getItem(COLLAPSE_KEY) === "true";
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

  // ─── Per-folder collapse (sections) ───────────────────────────────────
  function isCollapsed(folderKey) {
    return collapsedSet.has(folderKey);
  }
  function toggleCollapse(folderKey) {
    const next = !collapsedSet.has(folderKey);
    if (next) collapsedSet.add(folderKey);
    else collapsedSet.delete(folderKey);
    onCollapseChange(folderKey, next);
    renderList();
  }

  // ─── Panel collapse ───────────────────────────────────────────────────
  function togglePanelCollapse() {
    isPanelCollapsed = !isPanelCollapsed;
    localStorage.setItem(COLLAPSE_KEY, isPanelCollapsed);
    applyCollapseState();
  }

  function applyCollapseState() {
    shellEl.style.setProperty(
      "--left-rail-w",
      isPanelCollapsed ? `${COLLAPSED_W}px` : `${EXPANDED_W}px`,
    );
    container.setAttribute(
      "data-collapsed",
      isPanelCollapsed ? "true" : "false",
    );
    const label = isPanelCollapsed
      ? "Expand patterns panel"
      : "Collapse patterns panel";
    collapseBtn.setAttribute("aria-label", label);
    collapseBtn.title = label;
  }

  // ─── Build the static structure once ──────────────────────────────────
  container.replaceChildren();
  container.classList.add("left-rail__section");

  // Header: collapse toggle + title + "+" pattern + "+ folder" + import MIDI.
  // Collapse button is first so it remains visible in the 36px collapsed strip.
  const header = el("div", "left-rail__header");

  const collapseBtn = el("button", "btn btn--icon left-rail__collapse-btn");
  collapseBtn.type = "button";
  collapseBtn.setAttribute(
    "aria-label",
    isPanelCollapsed ? "Expand patterns panel" : "Collapse patterns panel",
  );
  collapseBtn.appendChild(makeIcon("chevron-left", { size: 14 }));
  collapseBtn.addEventListener("click", togglePanelCollapse);
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

  const folderPlusBtn = el("button", "btn btn--icon left-rail__folder-plus");
  folderPlusBtn.type = "button";
  folderPlusBtn.title = "Create a new folder";
  folderPlusBtn.setAttribute("aria-label", "New folder");
  folderPlusBtn.appendChild(makeIcon("folder-plus", { size: 14 }));
  folderPlusBtn.addEventListener("click", () => onCreateFolder());
  header.appendChild(folderPlusBtn);

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
    // Don't pre-lowercase: foldAccents() inside score() handles
    // normalization. Just trim outer whitespace.
    query = searchInput.value.trim();
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

  // ─── Container-level keyboard shortcuts ──────────────────────────────
  // Cmd-A: select all visible rows. Escape: clear selection. Cmd-D:
  // duplicate (single → onDuplicate, bulk → onBulkDuplicate). Cmd-Backspace:
  // delete (user patterns only; single → onDelete, bulk → onBulkDelete).
  // Scoped to focus on a row so the rail's shortcuts don't hijack global
  // Cmd-A inside the editor.
  container.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const focused = document.activeElement;
    const onRow = !!focused?.classList?.contains("left-rail__item");

    if (mod && e.key.toLowerCase() === "a" && onRow) {
      e.preventDefault();
      for (const r of listEl.querySelectorAll(".left-rail__item")) {
        selectedNames.add(r.dataset.name);
      }
      paintSelection();
      return;
    }
    if (e.key === "Escape" && selectedNames.size > 0) {
      e.preventDefault();
      clearSelection();
      return;
    }
    if (mod && e.key.toLowerCase() === "d" && onRow) {
      e.preventDefault();
      const names =
        selectedNames.size > 0
          ? Array.from(selectedNames)
          : focused?.dataset?.name
            ? [focused.dataset.name]
            : [];
      if (names.length === 0) return;
      if (names.length === 1) onDuplicate(names[0], undefined);
      else onBulkDuplicate(names);
      return;
    }
    if (mod && e.key === "Backspace" && onRow) {
      e.preventDefault();
      const names =
        selectedNames.size > 0
          ? Array.from(selectedNames)
          : focused?.dataset?.name
            ? [focused.dataset.name]
            : [];
      if (names.length === 0) return;
      const userNames = names.filter((n) => isUserName(n));
      if (userNames.length === 0) return;
      if (userNames.length === 1) onDelete(userNames[0]);
      else onBulkDelete(userNames);
      return;
    }
  });

  // ─── render ───────────────────────────────────────────────────────────
  function renderList() {
    listEl.replaceChildren();

    // Any active spring-load timer is bound to the previous DOM. Drop it
    // so a re-render doesn't expand a folder the user has since left.
    // renderList() can also run mid-drag (HMR / websocket refresh). The
    // source row gets detached so dragend never fires — reset drag-only
    // state here so we don't leave a stuck "grabbing" cursor (body attr
    // drives global CSS) or stale outlines on detached sections.
    cancelSpringLoad();
    document.body.removeAttribute("data-rail-dragging");
    clearAllDropHighlights();

    // Search active → flat fuzzy-ranked rendering. No folder section
    // headers; each row carries an inline "· Folder" suffix instead.
    if (query) {
      renderSearchResults();
      return;
    }

    // Section 1 — Demos (always present)
    const demosSection = renderSection({
      key: DEMOS_KEY,
      title: "Demos",
      patternNames: shippedNames,
      isUser: false,
      showMore: false,
      folderForRows: null,
      showEmptyHint: false,
    });
    attachDropHandlers(demosSection, DEMOS_KEY);

    // Section 2 — user folders, in display order
    for (const folderName of folders_) {
      const names = groupedUserPatterns_.folders?.[folderName] ?? [];
      const folderSection = renderSection({
        key: folderName,
        title: folderName,
        patternNames: names,
        isUser: true,
        showMore: true,
        folderForRows: folderName,
        showEmptyHint: true,
      });
      attachDropHandlers(folderSection, folderName);
    }

    // Section 3 — Unfiled (only when there are unfiled user patterns)
    const unfiled = groupedUserPatterns_.unfiled ?? [];
    if (unfiled.length > 0) {
      const unfiledSection = renderSection({
        key: UNFILED_KEY,
        title: "Unfiled",
        patternNames: unfiled,
        isUser: true,
        showMore: false,
        folderForRows: null,
        showEmptyHint: false,
      });
      // Spec: dropping on Unfiled clears the folder field. Use the reserved
      // key so the drop handler can branch on it.
      attachDropHandlers(unfiledSection, UNFILED_KEY);
    }

    // Defensive — shipped patterns always exist in this project.
    if (!listEl.firstChild) {
      listEl.appendChild(el("div", "left-rail__empty", "No patterns yet"));
    }

    // Selection set persists across re-renders within a session, but the
    // rows are freshly created — re-apply the .is-selected class.
    paintSelection();
  }

  /**
   * Render one folder section (Demos, a user folder, or Unfiled).
   * Sections always show the header + chevron. The body is rendered when
   * the section is expanded. Returns the rendered section element so the
   * caller can attach drag-and-drop handlers without re-querying the DOM.
   */
  function renderSection({
    key,
    title,
    patternNames,
    isUser,
    showMore,
    folderForRows,
    showEmptyHint,
  }) {
    const collapsed = isCollapsed(key);
    const section = el("div", "left-rail__folder-section");
    section.dataset.folder = key;

    // Header row
    const headerRow = el("div", "left-rail__folder-header");
    headerRow.setAttribute("role", "button");
    headerRow.setAttribute("tabindex", "0");
    headerRow.setAttribute(
      "aria-expanded",
      collapsed ? "false" : "true",
    );
    headerRow.dataset.collapsed = collapsed ? "true" : "false";

    const chevron = el("span", "left-rail__folder-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.appendChild(makeIcon("chevron-down", { size: 12 }));
    headerRow.appendChild(chevron);

    const nameEl = el("span", "left-rail__folder-name", title);
    headerRow.appendChild(nameEl);

    const countEl = el(
      "span",
      "left-rail__folder-count",
      `(${patternNames.length})`,
    );
    countEl.setAttribute("aria-hidden", "true");
    headerRow.appendChild(countEl);

    if (showMore) {
      const moreBtn = el("button", "left-rail__folder-more");
      moreBtn.type = "button";
      moreBtn.setAttribute("aria-label", "Folder options");
      moreBtn.appendChild(makeIcon("more-horizontal", { size: 12 }));
      // User folders open the header context menu; Demos/Unfiled stub
      // out (they aren't user folders even though Demos has showMore=false
      // — belt-and-suspenders for any future call site that flips showMore).
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (key === DEMOS_KEY || key === UNFILED_KEY || !isUser) return;
        const rect = moreBtn.getBoundingClientRect();
        showFolderHeaderMenu(rect.left, rect.bottom, key);
      });
      headerRow.appendChild(moreBtn);
    }

    headerRow.addEventListener("click", () => toggleCollapse(key));
    headerRow.addEventListener("keydown", (e) => {
      if (
        e.key === "F2" &&
        key !== DEMOS_KEY &&
        key !== UNFILED_KEY &&
        isUser
      ) {
        e.preventDefault();
        renameFolderRow(headerRow, key);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCollapse(key);
      }
    });

    // Double-click on the folder name starts inline rename (user folders only;
    // Demos and Unfiled are reserved). stopPropagation prevents the header
    // click handler from also toggling the section. Look up a fresh header
    // in case a re-render swapped it under us mid-click.
    if (isUser && key !== DEMOS_KEY && key !== UNFILED_KEY) {
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const freshHeader = listEl.querySelector(
          `.left-rail__folder-section[data-folder="${cssEscape(key)}"] .left-rail__folder-header`,
        );
        if (freshHeader) renameFolderRow(freshHeader, key);
      });

      // Right-click on a user folder header opens the same menu at cursor.
      // Skipped for Demos/Unfiled (those sections are synthetic).
      headerRow.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showFolderHeaderMenu(e.clientX, e.clientY, key);
      });
    }

    section.appendChild(headerRow);

    // Body
    if (!collapsed) {
      const body = el("div", "left-rail__folder-body");
      if (patternNames.length === 0 && showEmptyHint) {
        const hint = el(
          "div",
          "left-rail__empty-folder-hint",
          "Drop patterns here",
        );
        body.appendChild(hint);
      } else {
        for (const name of patternNames) {
          body.appendChild(buildRow(name, isUser, folderForRows));
        }
      }
      section.appendChild(body);
    }

    listEl.appendChild(section);
    return section;
  }

  /**
   * Gather every pattern visible in the rail into a flat candidate list.
   * Returns Array<{ name, isUser, folder: string | null }> where `folder`
   * is the user folder name, or null for both Demos and Unfiled.
   */
  function gatherAllForSearch() {
    const out = [];
    for (const name of shippedNames) {
      out.push({ name, isUser: false, folder: null });
    }
    for (const folderName of folders_) {
      const names = groupedUserPatterns_.folders?.[folderName] ?? [];
      for (const name of names) {
        out.push({ name, isUser: true, folder: folderName });
      }
    }
    for (const name of groupedUserPatterns_.unfiled ?? []) {
      out.push({ name, isUser: true, folder: null });
    }
    return out;
  }

  /**
   * Score every candidate against `query` using the fuzzy matcher.
   * Returns the full scored array sorted high → low. Caller decides how
   * many to render (we keep the total around so we can show a "+N more"
   * row when results overflow the cap).
   *
   * Two scores feed the final rank:
   *   - blob score: query vs. "{display} {filename} {folderLabel}". Lets
   *     folder-name and filename matches surface even when the display
   *     name has nothing in common with the query.
   *   - display score: query vs. just the pretty display name. Doubled
   *     and added on top so display-name hits always rank above hits
   *     that landed only on filename or folder.
   *
   * We also keep `displayMatch` on each result so the row renderer can
   * highlight matched characters in the visible name. When the display
   * score is null (e.g. a folder-name-only match), no highlights render
   * for that row — which is fine; the suffix tells the user why it's
   * here.
   */
  function fuzzyResults(q) {
    const candidates = gatherAllForSearch();
    const scored = [];
    for (const c of candidates) {
      const folderLabel = c.folder ?? (c.isUser ? "Unfiled" : "Demos");
      const display = prettyName(c.name);
      const blob = `${display} ${c.name} ${folderLabel}`;
      const blobMatch = score(q, blob);
      if (!blobMatch) continue;

      // Boost rows where the query touches the display name itself.
      const displayMatch = score(q, display);
      const finalScore = (displayMatch?.score ?? 0) * 2 + blobMatch.score;
      scored.push({
        ...c,
        score: finalScore,
        displayMatch,
        folderLabel,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /** Flat fuzzy-ranked search-result rendering. */
  function renderSearchResults() {
    const all = fuzzyResults(query);

    if (all.length === 0) {
      const empty = el(
        "div",
        "left-rail__empty",
        `No results for "${query}"`,
      );
      listEl.appendChild(empty);
      return;
    }

    const visible = all.slice(0, SEARCH_RESULT_LIMIT);
    for (const r of visible) {
      listEl.appendChild(
        buildRow(r.name, r.isUser, r.folder, {
          folderSuffix: r.folderLabel,
          matchIndices: r.displayMatch?.matches ?? null,
        }),
      );
    }

    if (all.length > SEARCH_RESULT_LIMIT) {
      const extra = all.length - SEARCH_RESULT_LIMIT;
      const moreRow = el(
        "div",
        "left-rail__more-row",
        `+ ${extra} more — refine your search…`,
      );
      listEl.appendChild(moreRow);
    }
  }

  /**
   * Build one pattern row.
   *
   * `searchOpts` is supplied only by the fuzzy search renderer:
   *   - folderSuffix: string  → render "· {label}" beside the name
   *   - matchIndices: number[] | null → highlight these char positions
   *     in the display name (indices into prettyName(name); foldAccents()
   *     preserves string length so they map 1:1 onto the original).
   */
  function buildRow(name, isUser, folderForRow, searchOpts = null) {
    const row = el("div", "left-rail__item");
    row.setAttribute("role", "option");
    row.setAttribute("tabindex", "-1");
    row.setAttribute("data-name", name);
    if (isUser) row.setAttribute("data-user", "");
    if (folderForRow) row.setAttribute("data-folder", folderForRow);
    if (name === activeName) {
      row.classList.add("is-active");
      row.setAttribute("aria-selected", "true");
    }

    // Drag source — every row is draggable. Drop targets live on sections.
    row.draggable = true;
    row.addEventListener("dragstart", (e) =>
      onPatternDragStart(e, name, isUser, folderForRow),
    );
    row.addEventListener("dragend", onPatternDragEnd);

    const accentEl = el("span", "left-rail__item-accent");
    accentEl.setAttribute("aria-hidden", "true");
    row.appendChild(accentEl);

    const display = prettyName(name);
    const nameEl = buildHighlightedNameSpan(
      display,
      searchOpts?.matchIndices ?? null,
    );

    // Search-mode folder suffix. Lives inside the name span so it shares
    // the 1fr column (ellipsis when crowded) instead of fighting the
    // fixed-width meta column.
    if (searchOpts?.folderSuffix) {
      const suffix = el(
        "span",
        "left-rail__item-folder-suffix",
        ` · ${searchOpts.folderSuffix}`,
      );
      suffix.setAttribute("aria-hidden", "true");
      nameEl.appendChild(suffix);
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
    // Every row gets one now (Task 11 menu has items for Demos clean / dirty,
    // user pattern, and bulk selections — there's no "no actions" case).
    {
      const moreBtn = el("button", "left-rail__more-btn");
      moreBtn.type = "button";
      moreBtn.setAttribute("aria-label", "Pattern options");
      moreBtn.appendChild(makeIcon("more-horizontal", { size: 12 }));
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rect = moreBtn.getBoundingClientRect();
        // Open below the button so it reads as a dropdown, not a tooltip.
        showContextMenu(rect.left, rect.bottom, name, isUser, folderForRow);
      });
      metaEl.appendChild(moreBtn);
    }

    row.appendChild(metaEl);

    row.addEventListener("click", (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isMod) {
        e.preventDefault();
        if (selectedNames.has(name)) selectedNames.delete(name);
        else selectedNames.add(name);
        lastClickedName = name;
        paintSelection();
        return;
      }
      if (isShift && lastClickedName) {
        // Range select within the visible flat row list.
        const visible = Array.from(
          listEl.querySelectorAll(".left-rail__item"),
        ).map((r) => r.dataset.name);
        const a = visible.indexOf(lastClickedName);
        const b = visible.indexOf(name);
        if (a >= 0 && b >= 0) {
          e.preventDefault();
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) selectedNames.add(visible[i]);
          paintSelection();
          return;
        }
        // Anchor row is no longer visible (e.g. its folder was collapsed).
        // Fall through to plain-click below rather than silently no-op
        // (CLAUDE.md: surface silent failures loudly).
      }

      // Plain click: clear any pending multi-selection and open the pattern.
      if (selectedNames.size > 0) clearSelection();
      lastClickedName = name;
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
      } else if (e.key === "F2") {
        e.preventDefault();
        if (isUser) {
          renamePatternRow(row, name);
        }
        // Demos: silently no-op (read-only).
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        row.click();
      } else if (e.key === "Escape") {
        searchInput.focus();
      }
    });

    // Double-click on the name span starts inline rename for user patterns.
    // The first click of a dblclick fires the row click handler, which
    // calls onSelect → flushToStore. flushToStore may trigger a
    // renderList() (updateDirtySet path) and detach the row before the
    // dblclick handler runs. Look up a fresh row by name so rename always
    // targets the live DOM, not the detached snapshot.
    if (isUser) {
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const freshRow = listEl.querySelector(
          `.left-rail__item[data-name="${cssEscape(name)}"]`,
        );
        if (freshRow) renamePatternRow(freshRow, name);
      });
    }

    // Context menu on right-click.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, name, isUser, folderForRow);
    });

    return row;
  }

  /**
   * Build a `.left-rail__item-name` span with the given indices wrapped in
   * `.left-rail__item-match`. Indices are positions into `display` — the
   * caller is responsible for ensuring they map onto the original string
   * (foldAccents preserves length, so the indices returned by score()
   * line up 1:1).
   */
  function buildHighlightedNameSpan(display, matchIndices) {
    const nameEl = el("span", "left-rail__item-name");
    if (!matchIndices || matchIndices.length === 0) {
      nameEl.textContent = display;
      return nameEl;
    }
    const matchSet = new Set(matchIndices);
    const len = display.length;
    let i = 0;
    while (i < len) {
      if (matchSet.has(i)) {
        let j = i;
        while (j < len && matchSet.has(j)) j++;
        const match = el(
          "span",
          "left-rail__item-match",
          display.slice(i, j),
        );
        nameEl.appendChild(match);
        i = j;
      } else {
        let j = i;
        while (j < len && !matchSet.has(j)) j++;
        nameEl.appendChild(document.createTextNode(display.slice(i, j)));
        i = j;
      }
    }
    return nameEl;
  }

  /** Next .left-rail__item in document order, skipping non-item nodes. */
  function nextItem(current) {
    const items = Array.from(listEl.querySelectorAll(".left-rail__item"));
    const idx = items.indexOf(current);
    return idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null;
  }
  /** Previous .left-rail__item in document order, skipping non-item nodes. */
  function prevItem(current) {
    const items = Array.from(listEl.querySelectorAll(".left-rail__item"));
    const idx = items.indexOf(current);
    return idx > 0 ? items[idx - 1] : null;
  }

  // ─── Drag-and-drop ────────────────────────────────────────────────────
  // Spec: design/work/24-pattern-folders.md §"Drag-and-drop (primary)".
  // - Every row is a drag source. The dragged payload is JSON, so a future
  //   ingest from elsewhere (e.g. a captured-phrase pane) is possible.
  // - Folder sections (Demos + each user folder + Unfiled) are drop
  //   targets. Demos rejects with a red outline; everything else accepts.
  // - Dropping a Demo onto a user destination opens Duplicate (Task 14).
  //   Dropping a user pattern moves it. Multi-select: a drag of a selected
  //   row carries the whole selection.

  /**
   * Look up a pattern by name across shipped + grouped user state.
   * Returns `{name, isUser, folder}`. Used when the dragged set comes from
   * the multi-select Set rather than the row that was clicked.
   *
   * Falls back to `{isUser: true, folder: null}` when the name can't be
   * found — that's the safest default (worst case we treat an unknown name
   * as Unfiled and the host validates on commit).
   */
  function resolveDraggedItem(n) {
    if (n in patterns) return { name: n, isUser: false, folder: null };
    const userFolders = groupedUserPatterns_.folders ?? {};
    for (const [folder, names] of Object.entries(userFolders)) {
      if (names.includes(n)) return { name: n, isUser: true, folder };
    }
    if ((groupedUserPatterns_.unfiled ?? []).includes(n)) {
      return { name: n, isUser: true, folder: null };
    }
    return { name: n, isUser: true, folder: null };
  }

  /**
   * Build the floating "ghost" element passed to dataTransfer.setDragImage.
   * It needs to be in the DOM during the dragstart event (the browser
   * snapshots it synchronously), but we hide it off-screen via CSS and
   * tear it down immediately after.
   */
  function makeDragGhost(draggedSet) {
    return el(
      "div",
      "left-rail__drag-ghost",
      draggedSet.length === 1
        ? prettyName(draggedSet[0].name)
        : `${draggedSet.length} patterns`,
    );
  }

  function onPatternDragStart(e, name, isUser, folder) {
    // If this row is part of an active multi-selection, drag all selected
    // rows. Otherwise drag just this row.
    const draggedSet = selectedNames.has(name)
      ? Array.from(selectedNames).map((n) => resolveDraggedItem(n))
      : [{ name, isUser, folder }];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      "application/x-strasbeat-patterns",
      JSON.stringify(draggedSet),
    );
    const ghost = makeDragGhost(draggedSet);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    // Tear down the ghost after the browser snapshots it. setTimeout(0) is
    // the standard pattern — the dragImage is captured synchronously inside
    // the dragstart handler.
    setTimeout(() => ghost.remove(), 0);
    document.body.setAttribute("data-rail-dragging", "true");
  }

  function onPatternDragEnd() {
    document.body.removeAttribute("data-rail-dragging");
    clearAllDropHighlights();
    cancelSpringLoad();
  }

  function attachDropHandlers(sectionEl, folderKey) {
    // folderKey is either a user folder name, UNFILED_KEY, or DEMOS_KEY.
    sectionEl.addEventListener("dragover", (e) =>
      onSectionDragOver(e, sectionEl, folderKey),
    );
    sectionEl.addEventListener("dragleave", (e) =>
      onSectionDragLeave(e, sectionEl, folderKey),
    );
    sectionEl.addEventListener("drop", (e) =>
      onSectionDrop(e, sectionEl, folderKey),
    );
  }

  function onSectionDragOver(e, sectionEl, folderKey) {
    if (folderKey === DEMOS_KEY) {
      // Demos is read-only. preventDefault is required so the dragleave
      // fires reliably (otherwise the browser may treat it as no-drop and
      // skip events). dropEffect "none" signals rejection to the cursor.
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
      sectionEl.classList.add("is-drop-rejected");
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    sectionEl.classList.add("is-drop-target");
    scheduleSpringLoad(folderKey);
  }

  function onSectionDragLeave(e, sectionEl, folderKey) {
    // dragleave fires when crossing into a child element too — only clear
    // if the pointer actually left the section. relatedTarget is the
    // element being entered.
    if (e.relatedTarget && sectionEl.contains(e.relatedTarget)) return;
    sectionEl.classList.remove("is-drop-target");
    sectionEl.classList.remove("is-drop-rejected");
    if (springFolder === folderKey) cancelSpringLoad();
  }

  function clearAllDropHighlights() {
    for (const node of listEl.querySelectorAll(
      ".is-drop-target, .is-drop-rejected",
    )) {
      node.classList.remove("is-drop-target", "is-drop-rejected");
    }
  }

  function scheduleSpringLoad(folderKey) {
    if (springFolder === folderKey) return;
    cancelSpringLoad();
    // Demos can't spring (the section itself rejects drops). Unfiled never
    // collapses meaningfully — it's only rendered when there are patterns
    // in it — so there's nothing to spring open.
    if (folderKey === DEMOS_KEY || folderKey === UNFILED_KEY) return;
    springFolder = folderKey;
    if (!isCollapsed(folderKey)) return;
    springTimer = setTimeout(() => {
      // Re-check collapse state — the user may have toggled it manually.
      if (isCollapsed(folderKey)) toggleCollapse(folderKey);
    }, SPRING_LOAD_MS);
  }

  function cancelSpringLoad() {
    if (springTimer) {
      clearTimeout(springTimer);
      springTimer = null;
    }
    springFolder = null;
  }

  function onSectionDrop(e, sectionEl, folderKey) {
    e.preventDefault();
    cancelSpringLoad();
    clearAllDropHighlights();
    if (folderKey === DEMOS_KEY) return; // rejected — no-op

    const raw = e.dataTransfer.getData("application/x-strasbeat-patterns");
    if (!raw) return;
    let dragged;
    try {
      dragged = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(dragged) || dragged.length === 0) return;

    // Resolve the target folder: UNFILED_KEY → null (clear field);
    // otherwise the user folder name.
    const target = folderKey === UNFILED_KEY ? null : folderKey;

    // Partition: user patterns move; Demos open the Duplicate dialog.
    const userMoves = dragged.filter((d) => d.isUser).map((d) => d.name);
    const demoForks = dragged.filter((d) => !d.isUser);

    if (userMoves.length) {
      onMoveTo(userMoves, target);
    }
    if (demoForks.length) {
      // Multi-demo drag is out of scope for Task 14 (single-Duplicate
      // dialog). Open the dialog for the first one with the target folder
      // preselected; the host (main.js) can surface a status hint for the
      // remainder. The spec's "drag-to-fork" path lives here.
      if (demoForks.length > 1) {
        console.warn(
          `[left-rail] multi-demo drag: only "${demoForks[0].name}" forwarded to duplicate; skipped ${demoForks.length - 1} other demo(s)`,
        );
      }
      onDuplicate(demoForks[0].name, target);
    }
  }

  /**
   * Auto-scroll the list when the cursor is near the top/bottom edge of
   * the rail during a drag. Hooked on the list container; bubbling
   * dragover events from sections fire this too, which is fine.
   *
   * `dropEffect`/`preventDefault` aren't set here on purpose — the
   * section-level handler owns the drop semantics. This is purely scroll.
   */
  function onListDragOver(e) {
    const rect = listEl.getBoundingClientRect();
    const top = e.clientY - rect.top;
    const bottom = rect.bottom - e.clientY;
    if (top >= 0 && top < AUTOSCROLL_EDGE_PX) {
      listEl.scrollBy({ top: -AUTOSCROLL_STEP_PX, behavior: "auto" });
    } else if (bottom >= 0 && bottom < AUTOSCROLL_EDGE_PX) {
      listEl.scrollBy({ top: AUTOSCROLL_STEP_PX, behavior: "auto" });
    }
  }
  listEl.addEventListener("dragover", onListDragOver);

  // ─── Context menu ─────────────────────────────────────────────────────
  // Spec: design/work/24-pattern-folders.md §"Per-row context menu".
  //
  // The menu dispatches three shapes:
  //   - bulk (right-clicked row is part of a multi-selection): Move N… /
  //     Duplicate N… / Delete N… (Delete disabled if any Demos are in
  //     the selection — Demos can't be deleted).
  //   - user pattern: Open / Rename… / Duplicate… / Move to ▸ / Delete.
  //   - Demo: Open / Duplicate… / (Revert to original if dirty).
  //
  // `folderForRow` is the user folder the row was rendered into, or null
  // for Demos / Unfiled / search results. It seeds Duplicate's default
  // folder.
  function showContextMenu(x, y, name, isUser, folderForRow) {
    dismissContextMenu();
    const menu = el("div", "left-rail__context-menu");

    const isSelected = selectedNames.has(name);
    const isBulk = isSelected && selectedNames.size > 1;
    const names = isBulk ? Array.from(selectedNames) : [name];

    if (isBulk) {
      buildBulkMenu(menu, names);
    } else if (isUser) {
      buildUserMenu(menu, name, folderForRow);
    } else {
      buildDemoMenu(menu, name);
    }

    // Empty menu (e.g. would have been "no actions" pre-Task 11): drop it
    // entirely rather than render an empty box.
    if (!menu.firstChild) return;

    positionAndShow(menu, x, y);
  }

  /**
   * Folder-header context menu — Rename / Delete for user folders. The rail
   * emits onDeleteFolder; Task 17 wires the actual confirm + choiceModal
   * flow in main.js. Demos and Unfiled never reach this path (the call
   * sites gate on the folder key).
   */
  function showFolderHeaderMenu(x, y, folderName) {
    dismissContextMenu();
    const menu = el("div", "left-rail__context-menu");
    addItem(
      menu,
      "Rename folder…",
      () => {
        const header = listEl.querySelector(
          `.left-rail__folder-section[data-folder="${cssEscape(folderName)}"] .left-rail__folder-header`,
        );
        if (header) renameFolderRow(header, folderName);
      },
      { kbd: "F2" },
    );
    addItem(menu, "Delete folder…", () => onDeleteFolder(folderName), {
      danger: true,
    });
    positionAndShow(menu, x, y);
  }

  // ─── Context menu helpers ─────────────────────────────────────────────
  /**
   * Append a clickable menu item. Returns the element so callers can
   * tweak it (e.g. disable conditionally). `kbd` renders a keyboard
   * shortcut hint on the right edge — pure UX surface, the actual
   * binding is wired in the container keydown handler.
   */
  function addItem(menu, label, onClick, { danger = false, disabled = false, kbd = null } = {}) {
    const item = el(
      "button",
      "left-rail__context-item" +
        (danger ? " left-rail__context-item--danger" : ""),
    );
    item.type = "button";
    const labelEl = el("span", "left-rail__context-label", label);
    item.appendChild(labelEl);
    if (kbd) {
      const kbdEl = el("span", "left-rail__context-kbd", kbd);
      kbdEl.setAttribute("aria-hidden", "true");
      item.appendChild(kbdEl);
    }
    if (disabled) {
      item.classList.add("is-disabled");
      item.setAttribute("aria-disabled", "true");
    } else {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissContextMenu();
        onClick();
      });
    }
    menu.appendChild(item);
    return item;
  }

  function addSeparator(menu) {
    menu.appendChild(el("div", "left-rail__context-separator"));
  }

  /**
   * Append a submenu-bearing menu item. Hover or keyboard-focus opens the
   * flyout to the right of the parent item (CSS-driven). `items` is a
   * mix of `{ label, onClick, danger? }` entries and the string
   * `"separator"`.
   */
  function addSubmenu(menu, label, items) {
    const item = el(
      "button",
      "left-rail__context-item left-rail__context-item--has-submenu",
    );
    item.type = "button";
    item.textContent = label;

    const submenu = el("div", "left-rail__context-submenu");
    for (const entry of items) {
      if (entry === "separator") {
        addSeparator(submenu);
        continue;
      }
      addItem(submenu, entry.label, entry.onClick, { danger: entry.danger });
    }

    item.appendChild(submenu);
    menu.appendChild(item);
    return item;
  }

  /**
   * Mount the menu, position it within the viewport, and arm dismissal
   * listeners. Listeners are armed in the next frame so the click that
   * opened the menu doesn't immediately close it.
   */
  function positionAndShow(menu, x, y) {
    document.body.appendChild(menu);
    activeMenu = menu;

    const rect = menu.getBoundingClientRect();
    const cx = Math.min(x, window.innerWidth - rect.width - 8);
    const cy = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(0, cx)}px`;
    menu.style.top = `${Math.max(0, cy)}px`;

    requestAnimationFrame(() => {
      document.addEventListener("click", onDocClickDismiss, true);
      document.addEventListener("keydown", onDocKeyDismiss, true);
    });
  }

  // ─── Menu shapes ──────────────────────────────────────────────────────
  // Platform-aware mod-key glyph. Used purely for the visual kbd hints in
  // the context menu — the actual key bindings work with metaKey || ctrlKey
  // either way.
  const IS_MAC = /Mac|iPhone|iPad/.test(
    typeof navigator !== "undefined" ? navigator.platform : "",
  );
  const MOD = IS_MAC ? "⌘" : "Ctrl+";

  function buildUserMenu(menu, name, folder) {
    addItem(menu, "Open", () => openName(name), { kbd: "↵" });
    addItem(menu, "Rename…", () => {
      const row = rowOf(name);
      if (row) renamePatternRow(row, name);
    }, { kbd: "F2" });
    addItem(menu, "Duplicate…", () => onDuplicate(name, folder ?? null), {
      kbd: `${MOD}D`,
    });
    addSubmenu(menu, "Move to", buildMoveItems([name]));
    addSeparator(menu);
    addItem(
      menu,
      "Delete",
      async () => {
        const ok = await confirm({
          title: `Delete "${name}"?`,
          message: "This can’t be undone.",
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          destructive: true,
        });
        if (ok) onDelete(name);
      },
      { danger: true, kbd: `${MOD}⌫` },
    );
  }

  function buildDemoMenu(menu, name) {
    addItem(menu, "Open", () => openName(name), { kbd: "↵" });
    addItem(menu, "Duplicate…", () => onDuplicate(name, null), {
      kbd: `${MOD}D`,
    });
    if (dirtySet.has(name)) {
      addSeparator(menu);
      addItem(menu, "Revert to original", async () => {
        const ok = await confirm({
          title: "Revert to original?",
          message: `Your changes to "${name}" will be lost. This can’t be undone.`,
          confirmLabel: "Revert",
          cancelLabel: "Cancel",
          destructive: true,
        });
        if (ok) onRevert(name);
      });
    }
  }

  function buildBulkMenu(menu, names) {
    const allUser = names.every((n) => isUserName(n));
    const n = names.length;

    addSubmenu(menu, `Move ${n} patterns to`, buildMoveItems(names));
    addItem(menu, `Duplicate ${n} patterns…`, () => onBulkDuplicate(names), {
      kbd: `${MOD}D`,
    });
    addSeparator(menu);
    addItem(
      menu,
      `Delete ${n} patterns…`,
      async () => {
        const ok = await confirm({
          title: `Delete ${n} patterns?`,
          message: "This can’t be undone.",
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          destructive: true,
        });
        if (ok) onBulkDelete(names);
      },
      { danger: true, disabled: !allUser, kbd: `${MOD}⌫` },
    );
  }

  /**
   * Build the {folders + Unfiled + New folder…} submenu items used by both
   * the single-row Move to ▸ and the bulk Move N to ▸. Each entry calls
   * `onBulkMove` with the target folder name (or null for Unfiled, the
   * sentinel "__new__" for New folder…). The host (Task 17) is responsible
   * for resolving "__new__" into a real folder name via a prompt before
   * persisting.
   */
  function buildMoveItems(names) {
    const items = [];
    for (const f of folders_) {
      items.push({ label: f, onClick: () => onBulkMove(names, f) });
    }
    items.push("separator");
    items.push({ label: "Unfiled", onClick: () => onBulkMove(names, null) });
    items.push("separator");
    items.push({
      label: "New folder…",
      onClick: () => onBulkMove(names, "__new__"),
    });
    return items;
  }

  /** Find the rendered row for `name`, if any. Used by Rename…'s callback. */
  function rowOf(name) {
    return listEl.querySelector(
      `.left-rail__item[data-name="${cssEscape(name)}"]`,
    );
  }

  /** Open a pattern (selects it and fires `onSelect`). */
  function openName(name) {
    setCurrent(name);
    onSelect(name);
  }

  /**
   * CSS.escape polyfill for older browsers. Used to build attribute
   * selectors with arbitrary pattern names. Strict enough for our needs;
   * we don't expect names containing the more exotic edge cases the spec
   * documents.
   */
  function cssEscape(s) {
    return (window.CSS?.escape ?? ((x) => x.replace(/(["\\\n\r\t])/g, "\\$1")))(
      s,
    );
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

  /**
   * Add a new user pattern to the rendered grouped state. Optional `folder`
   * places the pattern in that user folder (if it exists in folders_),
   * otherwise the pattern lands in Unfiled. Idempotent — adding a name that's
   * already tracked is a no-op (avoids visual dupes during HMR / retries).
   *
   * Side-effect: if the target folder is collapsed, expand it so the user
   * can see the pattern they just created. Also scrolls the new row into
   * view after the next paint. Both are scoped to the create path so
   * normal navigation doesn't trigger surprise scrolls.
   */
  function addUserPattern(name, folder) {
    // Ensure the grouped shape exists.
    if (!groupedUserPatterns_.folders) groupedUserPatterns_.folders = {};
    if (!groupedUserPatterns_.unfiled) groupedUserPatterns_.unfiled = [];

    // De-dupe across all buckets.
    const existsInUnfiled = groupedUserPatterns_.unfiled.includes(name);
    const existsInAnyFolder = Object.values(groupedUserPatterns_.folders).some(
      (arr) => arr.includes(name),
    );
    if (existsInUnfiled || existsInAnyFolder) {
      renderList();
      return;
    }

    // If the target folder is collapsed, expand it so the new pattern is
    // visible. Persisting the change isn't strictly necessary (the host
    // didn't ask for it), but keeping the collapsed-set in sync with the
    // DOM prevents the chevron from lying when the user toggles again.
    const targetKey = folder && folders_.includes(folder) ? folder : UNFILED_KEY;
    if (collapsedSet.has(targetKey)) {
      collapsedSet.delete(targetKey);
      onCollapseChange(targetKey, false);
    }

    if (folder && folders_.includes(folder)) {
      if (!groupedUserPatterns_.folders[folder]) {
        groupedUserPatterns_.folders[folder] = [];
      }
      groupedUserPatterns_.folders[folder].unshift(name);
    } else {
      groupedUserPatterns_.unfiled.unshift(name);
    }
    renderList();
    // Scroll into view after the row exists in the DOM. Use "smooth" only
    // when the user hasn't opted out of motion — Safari/Firefox don't auto-
    // downgrade scrollIntoView based on prefers-reduced-motion.
    requestAnimationFrame(() => {
      const row = listEl.querySelector(
        `.left-rail__item[data-name="${cssEscape(name)}"]`,
      );
      if (!row) return;
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({
        block: "nearest",
        behavior: reduced ? "auto" : "smooth",
      });
    });
  }

  /** Remove a user pattern from wherever it lives. */
  function removeUserPattern(name) {
    if (groupedUserPatterns_.unfiled) {
      groupedUserPatterns_.unfiled = groupedUserPatterns_.unfiled.filter(
        (n) => n !== name,
      );
    }
    if (groupedUserPatterns_.folders) {
      for (const f of Object.keys(groupedUserPatterns_.folders)) {
        groupedUserPatterns_.folders[f] = groupedUserPatterns_.folders[f].filter(
          (n) => n !== name,
        );
      }
    }
    renderList();
  }

  /**
   * Bulk update. Task 17 will use this for refreshRail.
   * Every field is optional; unspecified fields are left as-is.
   */
  function setData({
    groupedUserPatterns: gup,
    folders: f,
    collapsedFolders: cf,
    dirtySet: ds,
  } = {}) {
    if (gup !== undefined) groupedUserPatterns_ = gup;
    if (f !== undefined) folders_ = [...f];
    if (cf !== undefined) {
      collapsedSet.clear();
      for (const name of cf) collapsedSet.add(name);
    }
    if (ds !== undefined) dirtySet = new Set(ds);
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
    setData,
  };
}

// ─── Tiny DOM helpers ────────────────────────────────────────────────────

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
