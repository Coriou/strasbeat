// Learn panel — first tab in the right rail.
//
// In-app learning surface: workshop chapters, recipes, and example
// patterns. Searchable, tagged, with "Try" and "Copy to new pattern"
// actions. See design/work/14-strudel-learning-and-extensibility.md
// Phase 1.
//
// Public surface (factory pattern, same shape as reference-panel.js):
//
//   const panel = createLearnPanel({
//     onTry,               // (code: string) => Promise<void>
//     onCopyToNewPattern,  // (code: string, title: string) => Promise<void>
//     onFocusEditor,       // () => void
//     onOpenReference,     // (name: string) => void — deep-link into Reference
//   });
//   rightRail.registerPanel(panel);

import { makeIcon } from "./icons.js";
import learnIndex from "../learn/index.json";

const SEARCH_DEBOUNCE_MS = 150;

const TYPE_LABELS = {
  workshop: "Workshop",
  recipe: "Recipe",
  example: "Example",
};

const TYPE_ICONS = {
  workshop: "graduation-cap",
  recipe: "book-open",
  example: "music",
};

export function createLearnPanel({
  onTry = () => {},
  onCopyToNewPattern = () => {},
  onFocusEditor = () => {},
  onOpenReference = () => {},
}) {
  // ─── State ────────────────────────────────────────────────────────────
  let allEntries = learnIndex;
  let query = "";
  let category = "all"; // all | workshop | recipe | example
  let expandedId = null;
  let activeIndex = -1;

  // DOM refs
  let root = null;
  let searchInput = null;
  let pillsEl = null;
  let listEl = null;
  let countEl = null;
  let mounted = false;
  let searchTimer = null;
  let flatVisible = [];
  let hintEl = null;

  // Tried-state persistence
  const TRIED_KEY = "strasbeat:learn-tried";
  let triedSet = loadTriedSet();

  function loadTriedSet() {
    try {
      const raw = localStorage.getItem(TRIED_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  }

  function saveTried() {
    try {
      localStorage.setItem(TRIED_KEY, JSON.stringify([...triedSet]));
    } catch {}
  }

  function markTried(id) {
    if (!triedSet.has(id)) {
      triedSet.add(id);
      saveTried();
    }
  }

  // ─── Right-rail panel spec ────────────────────────────────────────────
  return {
    id: "learn",
    icon: "graduation-cap",
    label: "Learn",
    create,
    activate,
    deactivate,
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────

  function create(container) {
    root = container;
    root.classList.add("learn-panel");

    // Header — search
    const header = el("div", "learn-panel__header");

    const search = el("div", "learn-panel__search");
    const searchIcon = el("span", "learn-panel__search-icon");
    searchIcon.appendChild(makeIcon("search"));
    search.appendChild(searchIcon);

    searchInput = el("input", "learn-panel__search-input");
    searchInput.type = "text";
    searchInput.placeholder = "Search workshops, recipes, examples…";
    searchInput.setAttribute("aria-label", "Search learn content");
    searchInput.spellcheck = false;
    searchInput.autocomplete = "off";
    searchInput.addEventListener("input", onSearchInput);
    searchInput.addEventListener("keydown", onSearchKeydown);
    search.appendChild(searchInput);
    header.appendChild(search);
    root.appendChild(header);

    // Category pills
    pillsEl = el("div", "learn-panel__pills");
    pillsEl.setAttribute("role", "tablist");
    pillsEl.setAttribute("aria-label", "Content type");
    for (const c of [
      { id: "all", label: "All" },
      { id: "workshop", label: "Workshop" },
      { id: "recipe", label: "Recipes" },
      { id: "example", label: "Examples" },
    ]) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "learn-panel__pill";
      pill.dataset.category = c.id;
      pill.textContent = c.label;
      pill.setAttribute("role", "tab");
      pill.setAttribute("aria-selected", c.id === category ? "true" : "false");
      if (c.id === category) pill.classList.add("is-active");
      pill.addEventListener("click", () => {
        category = c.id;
        for (const p of pillsEl.querySelectorAll(".learn-panel__pill")) {
          const isMe = p.dataset.category === category;
          p.classList.toggle("is-active", isMe);
          p.setAttribute("aria-selected", isMe ? "true" : "false");
        }
        render();
      });
      pillsEl.appendChild(pill);
    }
    root.appendChild(pillsEl);

    // Hint for first-time users (hidden once any entry has been tried)
    hintEl = el(
      "div",
      "learn-panel__hint",
      "Pick a workshop to start learning, or search for a topic.",
    );
    hintEl.hidden = triedSet.size > 0;
    root.appendChild(hintEl);

    // Count
    countEl = el("div", "learn-panel__count");
    root.appendChild(countEl);

    // List
    listEl = el("div", "learn-panel__list");
    listEl.setAttribute("role", "listbox");
    listEl.addEventListener("keydown", onListKeydown);
    root.appendChild(listEl);

    mounted = true;
    render();
  }

  function activate() {
    if (!mounted) return;
    searchInput?.focus();
  }

  function deactivate() {
    clearTimeout(searchTimer);
  }

  // ─── Search ───────────────────────────────────────────────────────────

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
      clearTimeout(searchTimer);
      query = searchInput.value.trim().toLowerCase();
      render();
      moveActive(+1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (flatVisible.length > 0) {
        expandedId =
          expandedId === flatVisible[0].id ? null : flatVisible[0].id;
        activeIndex = 0;
        render();
        paintActive();
      }
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
        searchInput?.focus();
        activeIndex = -1;
        paintActive();
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
      const entry = flatVisible[activeIndex];
      if (!entry) return;
      if (entry.id !== expandedId) {
        expandedId = entry.id;
      } else {
        // Already expanded — trigger Try
        const btn = listEl.querySelector(
          `.learn-panel__entry[data-entry-id="${cssEscape(entry.id)}"] .learn-panel__btn--primary`,
        );
        triggerTry(entry, btn);
        return;
      }
      render();
      paintActive();
    }
  }

  // ─── Ranking ──────────────────────────────────────────────────────────

  function rankEntries(entries, q) {
    if (!q) return entries;
    const ranked = [];
    for (const e of entries) {
      const titleL = e.title.toLowerCase();
      const tagsStr = (e.tags ?? []).join(" ").toLowerCase();
      const summaryL = (e.summary ?? "").toLowerCase();
      const codeL = (e.code ?? "").toLowerCase();
      let rank = -1;
      if (titleL === q) rank = 0;
      else if (titleL.startsWith(q)) rank = 1;
      else if (titleL.includes(q)) rank = 2;
      else if (tagsStr.includes(q)) rank = 3;
      else if (summaryL.includes(q)) rank = 4;
      else if (codeL.includes(q)) rank = 5;
      if (rank >= 0) ranked.push({ entry: e, rank });
    }
    ranked.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.entry.title.localeCompare(b.entry.title);
    });
    return ranked.map((r) => r.entry);
  }

  // ─── Render ───────────────────────────────────────────────────────────

  function render() {
    if (!listEl) return;
    if (hintEl) hintEl.hidden = triedSet.size > 0;
    listEl.replaceChildren();
    flatVisible = [];

    let filtered = allEntries;
    if (category !== "all") {
      filtered = filtered.filter((e) => e.type === category);
    }
    if (query) {
      filtered = rankEntries(filtered, query);
    }

    flatVisible = filtered;
    countEl.textContent = `${filtered.length} item${filtered.length === 1 ? "" : "s"}`;

    if (filtered.length === 0) {
      const empty = el("div", "learn-panel__empty", "No matching content");
      listEl.appendChild(empty);
      return;
    }

    // Group by type when showing all + no search
    if (category === "all" && !query) {
      renderGrouped(filtered);
    } else {
      for (const entry of filtered) {
        listEl.appendChild(buildEntry(entry));
      }
    }

    paintActive();
  }

  function renderGrouped(entries) {
    const groups = { workshop: [], recipe: [], example: [] };
    for (const e of entries) {
      if (groups[e.type]) groups[e.type].push(e);
    }
    for (const [type, items] of Object.entries(groups)) {
      if (items.length === 0) continue;
      const groupEl = el("div", "learn-panel__group");
      const label = el(
        "div",
        "learn-panel__group-label",
        TYPE_LABELS[type] + "s",
      );
      groupEl.appendChild(label);
      for (const entry of items) {
        groupEl.appendChild(buildEntry(entry));
      }
      listEl.appendChild(groupEl);
    }
  }

  function buildEntry(entry) {
    const wrap = el("div", "learn-panel__entry");
    wrap.setAttribute("role", "option");
    wrap.setAttribute("tabindex", "-1");
    wrap.dataset.entryId = entry.id;

    // Header row
    const head = el("div", "learn-panel__entry-head");
    head.addEventListener("click", () => {
      expandedId = expandedId === entry.id ? null : entry.id;
      activeIndex = flatVisible.indexOf(entry);
      render();
      paintActive();
    });

    const chevron = el("span", "learn-panel__entry-chev");
    chevron.appendChild(
      makeIcon(expandedId === entry.id ? "chevron-down" : "chevron-right", {
        size: 12,
      }),
    );
    head.appendChild(chevron);

    const textCol = el("div", "learn-panel__entry-text");

    // Workshop chapter number prefix
    if (entry.type === "workshop" && entry.chapter != null) {
      const numEl = el(
        "span",
        "learn-panel__chapter-num",
        `${entry.chapter}. `,
      );
      textCol.appendChild(numEl);
    }

    const nameEl = el("span", "learn-panel__entry-name");
    appendHighlighted(nameEl, entry.title, query);
    textCol.appendChild(nameEl);

    // Tried indicator
    if (triedSet.has(entry.id)) {
      const check = el("span", "learn-panel__tried");
      check.appendChild(makeIcon("check", { size: 10 }));
      check.title = "Already tried";
      textCol.appendChild(check);
    }

    const badge = el("span", "learn-panel__entry-badge");
    badge.textContent = TYPE_LABELS[entry.type] ?? entry.type;
    badge.classList.add(`learn-panel__entry-badge--${entry.type}`);
    textCol.appendChild(badge);

    head.appendChild(textCol);
    wrap.appendChild(head);

    if (expandedId === entry.id) {
      wrap.classList.add("is-expanded");
      wrap.appendChild(buildEntryBody(entry));
    }

    return wrap;
  }

  function buildEntryBody(entry) {
    const body = el("div", "learn-panel__entry-body");

    if (entry.summary) {
      const summary = el("div", "learn-panel__entry-summary", entry.summary);
      body.appendChild(summary);
    }

    if (entry.tags?.length) {
      const tags = el("div", "learn-panel__entry-tags");
      for (const tag of entry.tags) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "learn-panel__tag";
        chip.textContent = tag;
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          searchInput.value = tag;
          query = tag.toLowerCase();
          category = "all";
          syncPills();
          render();
        });
        tags.appendChild(chip);
      }
      body.appendChild(tags);
    }

    // Code preview
    if (entry.code) {
      const codeWrap = el("div", "learn-panel__code-wrap");
      codeWrap.setAttribute("role", "region");
      codeWrap.setAttribute("aria-label", "Code example");
      const pre = el("pre", "learn-panel__code");
      const codeEl = el("code", null, entry.code);
      pre.appendChild(codeEl);
      codeWrap.appendChild(pre);
      body.appendChild(codeWrap);
    }

    // Actions
    const actions = el("div", "learn-panel__actions");

    const tryBtn = document.createElement("button");
    tryBtn.type = "button";
    tryBtn.className = "learn-panel__btn learn-panel__btn--primary";
    tryBtn.title = "Load into editor and play";
    tryBtn.appendChild(makeIcon("play", { size: 12 }));
    tryBtn.appendChild(document.createTextNode(" Try"));
    tryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerTry(entry, tryBtn);
    });
    actions.appendChild(tryBtn);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "learn-panel__btn";
    copyBtn.title = "Save as a new pattern file";
    copyBtn.appendChild(makeIcon("copy", { size: 12 }));
    copyBtn.appendChild(document.createTextNode(" Copy to new pattern"));
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerCopy(entry, copyBtn);
    });
    actions.appendChild(copyBtn);

    body.appendChild(actions);

    // Next chapter link (workshops only)
    if (entry.type === "workshop" && entry.chapter != null) {
      const nextEntry = allEntries.find(
        (e) => e.type === "workshop" && e.chapter === entry.chapter + 1,
      );
      if (nextEntry) {
        const nextBtn = document.createElement("button");
        nextBtn.type = "button";
        nextBtn.className = "learn-panel__next-chapter";
        nextBtn.textContent = `Next: ${nextEntry.title} \u2192`;
        nextBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          expandedId = nextEntry.id;
          activeIndex = flatVisible.indexOf(nextEntry);
          render();
          paintActive();
        });
        body.appendChild(nextBtn);
      }
    }

    return body;
  }

  // ─── Actions ──────────────────────────────────────────────────────────

  function triggerTry(entry, btn) {
    if (!entry.code) return;
    try {
      onTry(entry.code);
      markTried(entry.id);
      flashBtn(btn, " Loaded \u2713");
    } catch (err) {
      console.warn("[learn-panel] try failed:", err);
      flashBtn(btn, " Error", true);
    }
  }

  function triggerCopy(entry, btn) {
    if (!entry.code) return;
    try {
      onCopyToNewPattern(entry.code, entry.title);
      flashBtn(btn, " Copied \u2713");
    } catch (err) {
      console.warn("[learn-panel] copy to new pattern failed:", err);
      flashBtn(btn, " Error", true);
    }
  }

  function flashBtn(btn, label, isError) {
    if (!btn) return;
    const cls = isError ? "is-error" : "is-feedback";
    btn.classList.add(cls);
    const textNode = [...btn.childNodes].find((n) => n.nodeType === 3);
    const original = textNode?.textContent;
    if (textNode) textNode.textContent = label;
    setTimeout(() => {
      btn.classList.remove(cls);
      if (textNode && original != null) textNode.textContent = original;
    }, 1200);
  }

  // ─── Navigation helpers ───────────────────────────────────────────────

  function moveActive(delta) {
    if (flatVisible.length === 0) return;
    if (activeIndex < 0) {
      activeIndex = delta > 0 ? 0 : flatVisible.length - 1;
    } else {
      activeIndex = Math.max(
        0,
        Math.min(flatVisible.length - 1, activeIndex + delta),
      );
    }
    paintActive();
  }

  function paintActive() {
    for (const item of listEl?.querySelectorAll(".learn-panel__entry") ?? []) {
      item.classList.remove("is-active");
    }
    if (activeIndex >= 0 && activeIndex < flatVisible.length) {
      const id = flatVisible[activeIndex].id;
      const target = listEl?.querySelector(
        `.learn-panel__entry[data-entry-id="${cssEscape(id)}"]`,
      );
      if (target) {
        target.classList.add("is-active");
        target.scrollIntoView({ block: "nearest" });
        target.focus({ preventScroll: true });
      }
    }
  }

  function syncPills() {
    for (const p of pillsEl?.querySelectorAll(".learn-panel__pill") ?? []) {
      const isMe = p.dataset.category === category;
      p.classList.toggle("is-active", isMe);
      p.setAttribute("aria-selected", isMe ? "true" : "false");
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function appendHighlighted(parent, text, q) {
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
      "learn-panel__match",
      text.slice(idx, idx + q.length),
    );
    parent.appendChild(match);
    parent.appendChild(document.createTextNode(text.slice(idx + q.length)));
  }

  function cssEscape(s) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(s);
    }
    return s.replace(/[^a-z0-9_-]/gi, "\\$&");
  }
}
