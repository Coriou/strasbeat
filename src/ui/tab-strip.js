// Pattern tab strip — the working set, above the editor. A view over the
// open-set controller (src/tabs.js); it renders state and routes gestures,
// it does not own state. See design/work/26-pattern-tabs.md §"Tab strip UI".
//
// Functional behavior only; visual + motion craft is deferred to
// /impeccable → /polish → /animate.

import { makeIcon } from "./icons.js";

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
 * @param {(name:string)=>void} opts.onFocus
 * @param {(name:string)=>void} opts.onClose
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

  function render() {
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
      return;
    }

    open.forEach((name, index) => {
      const tab = el("div", "tab-strip__tab");
      tab.setAttribute("role", "tab");
      tab.setAttribute("tabindex", "0");
      tab.dataset.name = name;
      tab.draggable = true;
      // Entrance animation only for tabs that weren't open last render.
      if (!prevNames.has(name)) tab.classList.add("is-entering");
      if (name === active) {
        tab.classList.add("is-active");
        tab.setAttribute("aria-selected", "true");
      } else {
        tab.setAttribute("aria-selected", "false");
      }
      if (name === playing) tab.classList.add("is-playing");

      // Playing marker (subtle; visual treatment via craft).
      if (name === playing) {
        const mark = el("span", "tab-strip__playing-mark");
        mark.setAttribute("aria-hidden", "true");
        tab.appendChild(mark);
      }

      const label = el("span", "tab-strip__label", prettyName(name));
      tab.appendChild(label);

      // Dirty dot — Demos only (user patterns have no shipped original).
      if (!isUser(name) && dirty.has(name)) {
        const dot = el("span", "tab-strip__dirty-dot");
        dot.title = "Modified";
        dot.setAttribute("aria-hidden", "true");
        tab.appendChild(dot);
      }

      const close = el("button", "tab-strip__close");
      close.type = "button";
      close.setAttribute("aria-label", `Close ${prettyName(name)}`);
      close.appendChild(makeIcon("x", { size: 12 }));
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        onClose(name);
      });
      tab.appendChild(close);

      tab.addEventListener("click", () => onFocus(name));
      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus(name);
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onClose(name);
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
