// Pattern tab strip — the working set, above the editor. A view over the
// open-set controller (src/tabs.js); it renders state and routes gestures,
// it does not own state. See design/work/26-pattern-tabs.md §"Tab strip UI".
//
// Functional behavior only; visual + motion craft is deferred to
// /impeccable → /polish → /animate.

import { makeIcon } from "./icons.js";
import { moveIndex } from "./roving.js";

// Strip leading numeric prefixes for display, mirroring left-rail prettyName.
// left-rail.js keeps this function module-private (not exported), so we
// replicate the same logic here rather than share it.
//   "05-dub"              → "Dub"
//   "G3-progression-demo" → "Progression Demo"
//   "ben-choir"           → "Ben Choir"
function prettyName(raw) {
  const stripped = raw.replace(/^[a-zA-Z]*\d+[a-zA-Z]*-/, "");
  const spaced = stripped.replace(/[-_]/g, " ");
  const titled = spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  return titled.trim() || raw;
}

/**
 * What a screen reader says for a tab: the name plus the two states the strip
 * otherwise shows only as marks (the modified dot, the playing triangle).
 */
export function tabAccessibleName({ label, dirty = false, playing = false }) {
  let name = label;
  if (dirty) name += ", modified";
  if (playing) name += ", playing";
  return name;
}

/**
 * Which tab holds the strip's single tab stop: the focused pattern, or the
 * first tab when nothing is focused. Returns a name, or null with no tabs.
 */
export function rovingTabName(open, active) {
  if (open.length === 0) return null;
  return open.includes(active) ? active : open[0];
}

/**
 * Which tab gets keyboard focus back after a re-render, given the tab that
 * had it before. The same tab if it is still open; otherwise (it was just
 * closed) the tab that slid into its place, or the last one. Only keyboard
 * focus is handed back: a tab that was merely clicked gets none, or the next
 * Backspace meant for the editor would close it.
 */
export function tabToRefocus({
  open,
  previousName,
  previousIndex,
  keyboard = true,
}) {
  if (!keyboard) return null;
  if (previousName == null || open.length === 0) return null;
  if (open.includes(previousName)) return previousName;
  return open[Math.min(Math.max(previousIndex, 0), open.length - 1)];
}

/**
 * Mount the pattern tab strip into `container`. The strip is a pure view:
 * it renders the open set and routes gestures (focus/close/reorder) via
 * injected callbacks — it owns no state.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container       the #tab-strip element
 * @param {() => string[]} opts.getOpenItems
 * @param {() => string|null} opts.getActiveItem
 * @param {() => string|null} opts.getPlayingItem
 * @param {() => Set<string>} opts.getDirtySet  shipped names with working copies
 * @param {(name:string)=>boolean} opts.isUser  user pattern (no dirty dot)
 * @param {(name:string, how:{viaPointer:boolean})=>void} opts.onFocus
 *   `viaPointer` is true for a click, false for Enter/Space on the tab — a
 *   host can send focus to the editor after a click.
 * @param {(name:string, how:{viaPointer:boolean})=>void} opts.onClose
 * @param {(name:string, toIndex:number)=>void} opts.onReorder
 * @returns {{ render: () => void }}
 */
export function mountTabStrip(opts) {
  const {
    container,
    getOpenItems,
    getActiveItem,
    getPlayingItem,
    getDirtySet,
    isUser,
    onFocus,
    onClose,
    onReorder,
  } = opts;
  if (!container) throw new Error("tab-strip.mount: container is required");

  container.replaceChildren();

  let dragName = null;
  // Names present in the previous render. Used purely to decide which tabs
  // get the entrance animation (genuinely new ones), so a focus switch or a
  // reorder — which also re-render every tab — doesn't replay the open
  // animation across the whole strip. This is presentation state in the view;
  // it never touches the open set or any callback.
  let prevNames = new Set();

  // Presentation-only drag feedback. Exactly one tab carries the drop
  // insertion bar at a time; clearDragMarks wipes all drag classes when the
  // gesture ends (drop/dragend). These never gate onReorder.
  function markDropTarget(tab) {
    for (const t of container.querySelectorAll(
      ".tab-strip__tab.is-drop-target",
    ))
      t.classList.remove("is-drop-target");
    tab.classList.add("is-drop-target");
  }
  function clearDragMarks() {
    for (const t of container.querySelectorAll(".tab-strip__tab"))
      t.classList.remove("is-dragging", "is-drop-target");
  }

  const tabEls = () =>
    Array.from(container.querySelectorAll(".tab-strip__tab-btn"));

  // Whether the strip's focus was put there from the keyboard (Tab, arrows)
  // rather than by pressing a tab with the pointer. Decided as focus lands —
  // :focus-visible is only dependable at that moment — and dropped by any
  // press on the strip.
  let keyboardFocus = false;
  container.addEventListener(
    "pointerdown",
    () => {
      keyboardFocus = false;
    },
    true,
  );
  container.addEventListener("focusin", (e) => {
    keyboardFocus =
      e.target.matches?.(".tab-strip__tab-btn:focus-visible") === true;
  });
  container.addEventListener("focusout", (e) => {
    if (!container.contains(e.relatedTarget)) keyboardFocus = false;
  });

  // Every render replaces all children. If a tab had keyboard focus, note
  // which, so the rebuilt strip can hand focus back instead of dropping it.
  function focusedTab() {
    const btn = document.activeElement;
    if (!btn?.matches?.(".tab-strip__tab-btn") || !container.contains(btn)) {
      return null;
    }
    const tab = btn.parentElement;
    return {
      previousName: tab.dataset.name,
      previousIndex: Array.from(container.children).indexOf(tab),
      keyboard: keyboardFocus,
    };
  }

  function render() {
    const hadFocus = focusedTab();
    keyboardFocus = false;
    container.replaceChildren();
    const open = getOpenItems();
    const active = getActiveItem();
    const playing = getPlayingItem();
    const dirty = getDirtySet();

    if (open.length === 0) {
      const empty = el(
        "div",
        "tab-strip__empty",
        "No open patterns — open one from the library",
      );
      container.appendChild(empty);
      // The last tab was closed from the keyboard: the focused tab is gone
      // and the strip has no tab stop left. Hand focus to the control that
      // opens the library rather than dropping it on the page.
      if (hadFocus?.keyboard) document.getElementById("pattern-menu")?.focus();
      return;
    }

    const stop = rovingTabName(open, active);

    open.forEach((name, index) => {
      // The chip: drag source, hover surface, and the box both controls sit
      // in. The tab itself and its close button are siblings inside it, so
      // neither interactive element nests in the other.
      const tab = el("div", "tab-strip__tab");
      tab.setAttribute("role", "presentation");
      tab.dataset.name = name;
      tab.draggable = true;
      // Entrance animation only for tabs that weren't open last render.
      if (!prevNames.has(name)) tab.classList.add("is-entering");
      if (name === active) tab.classList.add("is-active");
      if (name === playing) tab.classList.add("is-playing");

      const display = prettyName(name);
      const isDirty = !isUser(name) && dirty.has(name);

      const tabBtn = el("div", "tab-strip__tab-btn");
      tabBtn.setAttribute("role", "tab");
      tabBtn.setAttribute("aria-selected", name === active ? "true" : "false");
      tabBtn.setAttribute("aria-controls", "editor");
      // One tab stop for the whole strip; arrows move between tabs.
      tabBtn.setAttribute("tabindex", name === stop ? "0" : "-1");
      tabBtn.setAttribute(
        "aria-label",
        tabAccessibleName({
          label: display,
          dirty: isDirty,
          playing: name === playing,
        }),
      );
      tabBtn.setAttribute("aria-keyshortcuts", "Delete");
      tabBtn.title = `${name} — Delete closes the tab`;

      // Playing marker (subtle; visual treatment via craft).
      if (name === playing) {
        const mark = el("span", "tab-strip__playing-mark");
        mark.setAttribute("aria-hidden", "true");
        tabBtn.appendChild(mark);
      }

      const label = el("span", "tab-strip__label", display);
      tabBtn.appendChild(label);

      // Dirty dot — Demos only (user patterns have no shipped original).
      if (isDirty) {
        const dot = el("span", "tab-strip__dirty-dot");
        dot.title = "Modified";
        dot.setAttribute("aria-hidden", "true");
        tabBtn.appendChild(dot);
      }
      tab.appendChild(tabBtn);

      // Pointer affordance for closing. The keyboard closes with Delete or
      // Backspace on the tab, so this stays out of the tab order.
      const close = el("button", "tab-strip__close");
      close.type = "button";
      close.tabIndex = -1;
      close.setAttribute("aria-label", `Close ${display}`);
      close.appendChild(makeIcon("x", { size: 12 }));
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        onClose(name, { viaPointer: true });
      });
      tab.appendChild(close);

      tab.addEventListener("click", () => onFocus(name, { viaPointer: true }));
      // Middle-click closes, as in every tabbed editor. The mousedown guard
      // stops the browser's autoscroll from starting on the same press.
      tab.addEventListener("mousedown", (e) => {
        if (e.button === 1) e.preventDefault();
      });
      tab.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        onClose(name, { viaPointer: true });
      });
      tabBtn.addEventListener("keydown", (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus(name, { viaPointer: false });
        } else if (e.key === "Delete" || e.key === "Backspace") {
          // Only for a tab the keyboard is on. One that holds focus because
          // it was clicked must not swallow a key meant for the editor.
          if (e.target !== tabBtn || !keyboardFocus) return;
          e.preventDefault();
          onClose(name, { viaPointer: false });
        } else {
          const tabs = tabEls();
          const next = moveIndex(tabs.indexOf(tabBtn), tabs.length, e.key, {
            horizontal: true,
            wrap: true,
          });
          if (next < 0) return;
          e.preventDefault();
          tabs[next].focus();
        }
      });
      // The tab stop follows focus, so Tab-out / Shift+Tab-in returns to
      // the tab the user was last on.
      tabBtn.addEventListener("focus", () => {
        for (const t of tabEls()) {
          t.setAttribute("tabindex", t === tabBtn ? "0" : "-1");
        }
      });

      // Drag to reorder. The class toggles below are presentation only —
      // the dragged tab dims (.is-dragging) and the hovered target shows an
      // accent insertion bar (.is-drop-target), both styled in tab-strip.css.
      // The reorder decision (onReorder) and dragName bookkeeping are
      // unchanged; the marks just make the gesture legible.
      tab.addEventListener("dragstart", (e) => {
        dragName = name;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", name);
        tab.classList.add("is-dragging");
      });
      tab.addEventListener("dragover", (e) => {
        if (dragName == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (name !== dragName) markDropTarget(tab);
      });
      tab.addEventListener("dragleave", () => {
        tab.classList.remove("is-drop-target");
      });
      tab.addEventListener("drop", (e) => {
        if (dragName == null) return;
        e.preventDefault();
        onReorder(dragName, index);
        dragName = null;
        clearDragMarks();
      });
      tab.addEventListener("dragend", () => {
        dragName = null;
        clearDragMarks();
      });

      container.appendChild(tab);
    });

    // Remember this render's names so the next render can tell new tabs
    // (which animate in) from re-rendered existing ones (which don't).
    prevNames = new Set(open);

    if (hadFocus) {
      const refocus = tabToRefocus({ open, ...hadFocus });
      const target = tabEls().find(
        (t) => t.parentElement.dataset.name === refocus,
      );
      if (target) {
        target.focus();
        // Restored on the keyboard's behalf, however the browser rates a
        // scripted focus.
        keyboardFocus = true;
      }
    }

    // Auto-scroll the focused tab into view (overflow handling; craft picks
    // the exact mechanism, this guarantees reachability).
    requestAnimationFrame(() => {
      const activeTabEl = container.querySelector(".tab-strip__tab.is-active");
      if (activeTabEl)
        activeTabEl.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  }

  render();
  return { render };
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
