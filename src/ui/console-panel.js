// Console panel — third tab in the right rail.
//
// Structured, filterable, ring-buffered view of everything the pattern
// engine wants to say. Replaces the need to keep browser devtools open
// during composition. The panel is dumb about where its entries come
// from — the host (src/main.js) subscribes to the `strudel.log`
// CustomEvent, the StrudelMirror `onEvalError` callback, and the
// `editor.evaluate` wrapper, then calls `panel.log/warn/error/divider`.
// Nothing here patches `console.*`, and nothing here peeks at Strudel
// internals. See design/work/08-feature-parity-and-beyond.md "Phase 3:
// Console Panel".
//
// What it does:
//   - Accumulates log / warn / error entries in a ring buffer (500 max).
//     Oldest entries are evicted, oldest DOM nodes removed alongside.
//   - Three independently-toggleable level filters (Log / Warn / Error).
//   - Debounced search filter across entry messages.
//   - Clear button empties the buffer.
//   - Auto-scrolls to the newest entry when the user was already at the
//     bottom; stays put when they've scrolled up to read (standard
//     terminal behavior).
//   - Divider entries — rendered as horizontal rules with pattern
//     name + timestamp — separate one evaluation's tail output from the
//     next. The host fires a divider before each `editor.evaluate()`.
//   - Best-effort hap inspector: when an entry carries `data` that
//     looks like a Strudel hap (whole / part / value), the message is
//     rendered as a structured card instead of raw text.
//   - Keyboard: Escape → focus editor, Up/Down → scroll the list.
//     The console is read-only, so there's no per-entry focus like the
//     sound browser and reference panel.
//
// Public surface (factory pattern, identical shape to
// createSoundBrowserPanel and createReferencePanel):
//
//   const panel = createConsolePanel({
//     onFocusEditor, // () => void
//   });
//   rightRail.registerPanel(panel);
//   panel.log('scheduler started', { cps: 0.5 });
//   panel.warn('sample not found');
//   panel.error('transpile failed: unexpected token');
//   panel.divider('05-chords');
//   panel.clear();
//
// Entries pushed before `create()` runs are kept in the buffer and
// rendered on first mount, so the host can start piping events from the
// moment the panel is constructed — no ordering dance required.
//
// Pure DOM, no framework. Match the imperative style of left-rail.js,
// sound-browser.js, and reference-panel.js.

import { extractErrorLine } from "../editor/error-marks.js";
import { makeIcon } from "./icons.js";

const SEARCH_DEBOUNCE_MS = 150;
// Retained entries (and DOM rows). Repeats of the same line collapse into
// one entry with a ×N counter, so a pattern that logs the same error for
// every hap neither floods the list nor pushes real history out of it.
const MAX_ENTRIES = 1000;
// Pixels of slack at the bottom of the scroll region that still count as
// "the user is looking at the tail". ~20px matches the standard terminal
// rule-of-thumb and survives the zero-scroll case on first paint.
const SCROLL_LOCK_THRESHOLD_PX = 20;

// Level metadata — the `divider` "level" is synthesized by the panel
// itself (not toggleable, not filterable by search) and lives outside
// this list on purpose.
const LEVELS = [
  { id: "log", label: "Log", title: "Info + scheduler messages" },
  { id: "warn", label: "Warn", title: "Warnings" },
  { id: "error", label: "Error", title: "Errors" },
];

export function createConsolePanel({
  onFocusEditor = () => {},
  onJumpToLine = () => {},
  onClear = () => {},
} = {}) {
  // ─── State ────────────────────────────────────────────────────────────
  /** @type {Array<{id:number, level:string, message:string, timestamp:number, data:any}>} */
  let entries = [];
  let nextId = 1;
  /** @type {Set<string>} */
  let enabledLevels = new Set(LEVELS.map((l) => l.id));
  let query = "";

  // DOM refs (re-bound on create()).
  let root = null;
  let searchInput = null;
  let listEl = null;
  let countEl = null;
  /** @type {Record<string, HTMLButtonElement>} */
  let levelButtons = {};
  let mounted = false;
  let searchTimer = null;

  // DOM work is batched: pushEntry() only updates the buffer and asks for
  // one flush per animation frame, and nothing is touched at all while the
  // panel isn't the rail's visible tab (activate() catches up).
  let visible = false;
  let flushHandle = 0;
  /** @type {Map<number, HTMLElement>} entry id → its row, when rendered */
  const rowById = new Map();
  /** Highest entry id already reflected in the DOM. */
  let renderedThroughId = 0;
  /** Rendered entries whose repeat count changed since the last flush. */
  const repeatDirty = new Set();
  /** Ids evicted from the buffer whose rows are still in the DOM. */
  let evictedIds = [];
  let forceScroll = false;
  /** Entries passing the current filters — kept in step, never recounted. */
  let visibleCount = 0;

  // ─── Right-rail panel spec ────────────────────────────────────────────

  return {
    id: "console",
    icon: "terminal",
    label: "Console",
    create,
    activate,
    deactivate,
    log,
    warn,
    error,
    divider,
    clear,
    scrollToEntry,
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────

  function create(container) {
    root = container;
    root.classList.add("console-panel");

    // Header — level toggles + search input + clear button, all on one
    // row so the scroll region has maximum vertical budget.
    const header = el("div", "console-panel__header");

    const levels = el("div", "console-panel__levels");
    levels.setAttribute("role", "toolbar");
    levels.setAttribute("aria-label", "Level filters");
    levelButtons = {};
    for (const lvl of LEVELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `console-panel__level console-panel__level--${lvl.id} is-active`;
      btn.dataset.level = lvl.id;
      btn.textContent = lvl.label;
      btn.title = lvl.title;
      btn.setAttribute("aria-pressed", "true");
      btn.addEventListener("click", () => toggleLevel(lvl.id));
      levels.appendChild(btn);
      levelButtons[lvl.id] = btn;
    }
    header.appendChild(levels);

    const search = el("div", "console-panel__search");
    const searchIcon = el("span", "console-panel__search-icon");
    searchIcon.appendChild(makeIcon("search"));
    search.appendChild(searchIcon);
    searchInput = el("input", "console-panel__search-input");
    searchInput.type = "text";
    searchInput.placeholder = "Filter…";
    searchInput.setAttribute("aria-label", "Filter console entries");
    searchInput.spellcheck = false;
    searchInput.autocomplete = "off";
    searchInput.addEventListener("input", onSearchInput);
    searchInput.addEventListener("keydown", onSearchKeydown);
    search.appendChild(searchInput);
    header.appendChild(search);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "console-panel__clear";
    clearBtn.title = "Clear console";
    clearBtn.setAttribute("aria-label", "Clear console");
    clearBtn.appendChild(makeIcon("eraser"));
    clearBtn.addEventListener("click", () => clear());
    header.appendChild(clearBtn);

    root.appendChild(header);

    // Scroll region. Role="log" + aria-live="polite" lets screen readers
    // announce new entries without pre-empting whatever the user is
    // doing in the editor. tabIndex makes the container focusable for
    // the arrow-key scroll shortcut.
    listEl = el("div", "console-panel__list");
    listEl.setAttribute("role", "log");
    listEl.setAttribute("aria-live", "polite");
    listEl.setAttribute("aria-atomic", "false");
    listEl.tabIndex = 0;
    listEl.addEventListener("keydown", onListKeydown);
    root.appendChild(listEl);

    // Footer — visible / total entry counts.
    countEl = el("div", "console-panel__count");
    root.appendChild(countEl);

    mounted = true;
    render();
  }

  function activate({ focus = true } = {}) {
    if (!mounted) return;
    visible = true;
    // Catch up on whatever arrived while the tab was hidden, then pin the
    // viewport to the tail so the user lands on the newest output, and
    // surface the search field so the first keystroke can refine the filter.
    flush();
    listEl.scrollTop = listEl.scrollHeight;
    if (focus && searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }

  function deactivate() {
    clearTimeout(searchTimer);
    visible = false;
  }

  // ─── Public helpers — the host calls these from log hooks ─────────────

  function log(message, data) {
    return pushEntry("log", message, data);
  }
  function warn(message, data) {
    return pushEntry("warn", message, data);
  }
  function error(message, data) {
    return pushEntry("error", message, data);
  }

  /**
   * Add an evaluation-separator entry. Rendered as a horizontal rule
   * with the given label (typically the pattern name) + timestamp so
   * the user can tell one eval's tail output from the next one's head.
   */
  function divider(label) {
    return pushEntry("divider", label ?? "", null);
  }

  function clear() {
    entries = [];
    if (mounted) render();
    onClear();
  }

  // ─── Ring buffer + DOM updates ────────────────────────────────────────

  function pushEntry(level, rawMessage, data) {
    const message = stringify(rawMessage);
    const now = Date.now();

    // The same line again, back to back: count it on the existing entry
    // instead of adding a row.
    const last = entries[entries.length - 1];
    if (last && isRepeat(last, level, message, data)) {
      last.count += 1;
      last.timestamp = now;
      if (rowById.has(last.id)) repeatDirty.add(last);
      scheduleFlush();
      return last.id;
    }

    const entry = {
      id: nextId++,
      level,
      message,
      timestamp: now,
      data,
      location: extractEntryLocation(level, message, data),
      count: 1,
    };
    entries.push(entry);
    if (isVisible(entry)) visibleCount++;
    // Dividers always force-scroll: the visual purpose of a divider is
    // "look here, something new just happened".
    if (level === "divider") forceScroll = true;

    // Evict oldest beyond the buffer cap. The row (if any) is removed on
    // the next flush, so there's exactly one DOM node per live entry.
    while (entries.length > MAX_ENTRIES) {
      const removed = entries.shift();
      if (isVisible(removed)) visibleCount--;
      repeatDirty.delete(removed);
      if (rowById.has(removed.id)) evictedIds.push(removed.id);
    }

    scheduleFlush();
    return entry.id;
  }

  function scheduleFlush() {
    if (!mounted || !visible || flushHandle) return;
    flushHandle = requestAnimationFrame(() => {
      flushHandle = 0;
      flush();
    });
  }

  // Bring the DOM up to date with the buffer: drop evicted rows, refresh
  // changed repeat counters, append everything new. One layout read
  // (the scroll-lock check) and one write per frame, however many lines
  // arrived.
  function flush() {
    if (!mounted) return;
    if (flushHandle) {
      cancelAnimationFrame(flushHandle);
      flushHandle = 0;
    }
    // Auto-scroll lock — measure BEFORE mutating so we know whether the
    // user was already pinned to the tail.
    const stuckToBottom = isScrolledToBottom();

    for (const id of evictedIds) {
      rowById.get(id)?.remove();
      rowById.delete(id);
    }
    evictedIds = [];

    for (const entry of repeatDirty) {
      const row = rowById.get(entry.id);
      if (row) syncRepeat(row, entry);
    }
    repeatDirty.clear();

    let frag = null;
    // New entries are a suffix of the buffer — walk back to the first one.
    let start = entries.length;
    while (start > 0 && entries[start - 1].id > renderedThroughId) start--;
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i];
      if (!isVisible(entry)) continue;
      frag ??= document.createDocumentFragment();
      frag.appendChild(buildEntryNode(entry));
    }
    if (entries.length > 0) {
      renderedThroughId = entries[entries.length - 1].id;
    }
    if (frag) listEl.appendChild(frag);
    updateCount();

    if (stuckToBottom || forceScroll) {
      // scrollTop rather than scrollIntoView to avoid shifting focus.
      listEl.scrollTop = listEl.scrollHeight;
    }
    forceScroll = false;
  }

  function scrollToEntry(entryId) {
    if (!mounted || !listEl) return;
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;

    if (entry.level !== "divider") {
      enabledLevels.add(entry.level);
      const btn = levelButtons[entry.level];
      if (btn) {
        btn.classList.add("is-active");
        btn.setAttribute("aria-pressed", "true");
      }
    }

    if (query) {
      query = "";
      if (searchInput) searchInput.value = "";
    }

    render();

    const node = rowById.get(entryId);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
  }

  function isScrolledToBottom() {
    if (!listEl) return true;
    const gap = listEl.scrollHeight - listEl.clientHeight - listEl.scrollTop;
    return gap <= SCROLL_LOCK_THRESHOLD_PX;
  }

  function isVisible(entry) {
    // Dividers never get filtered out — they anchor the log visually.
    if (entry.level === "divider") return true;
    if (!enabledLevels.has(entry.level)) return false;
    if (query && !entry.message.toLowerCase().includes(query)) return false;
    return true;
  }

  // Full re-render after a filter change. Rebuilds the scroll region
  // from the current buffer; cheap at this scale.
  function render() {
    if (!listEl) return;
    const wasAtBottom = isScrolledToBottom();
    listEl.replaceChildren();
    rowById.clear();
    repeatDirty.clear();
    evictedIds = [];
    visibleCount = 0;
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      if (!isVisible(entry)) continue;
      visibleCount++;
      frag.appendChild(buildEntryNode(entry));
    }
    renderedThroughId = entries.length ? entries[entries.length - 1].id : 0;
    listEl.appendChild(frag);
    updateCount();
    if (wasAtBottom) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  }

  function updateCount() {
    if (!countEl) return;
    const total = entries.length;
    if (total === 0) {
      countEl.textContent = "empty";
      return;
    }
    countEl.textContent =
      visibleCount === total
        ? `${total} entries`
        : `${visibleCount} of ${total}`;
  }

  // ─── Entry DOM builders ───────────────────────────────────────────────

  function buildEntryNode(entry) {
    if (entry.level === "divider") return buildDividerNode(entry);

    const row = el(
      "div",
      `console-panel__entry console-panel__entry--${entry.level}`,
    );
    row.dataset.entryId = String(entry.id);
    rowById.set(entry.id, row);

    const ts = el("span", "console-panel__ts", formatTime(entry.timestamp));
    row.appendChild(ts);

    const dot = el("span", "console-panel__dot");
    dot.setAttribute("aria-hidden", "true");
    row.appendChild(dot);

    const body = el("div", "console-panel__body");

    // Best-effort hap inspector — when the entry's data looks like a
    // Strudel hap, render a structured card instead of the raw message.
    // If detection is ambiguous the card is skipped and the fallback
    // text path renders — it's a nice-to-have, not a blocker.
    const hap = extractHap(entry);
    if (hap) {
      body.appendChild(buildHapCard(entry, hap));
      if (entry.location) {
        body.appendChild(buildLineBadge(entry.location));
      }
    } else {
      const messageRow = el("div", "console-panel__message-row");
      const msg = el("span", "console-panel__msg", entry.message);
      messageRow.appendChild(msg);
      if (entry.location) {
        messageRow.appendChild(buildLineBadge(entry.location));
      }
      body.appendChild(messageRow);
    }

    row.appendChild(body);
    if (entry.count > 1) syncRepeat(row, entry);
    return row;
  }

  // Show (or update) the ×N counter on a row, and move its timestamp to
  // the latest occurrence.
  function syncRepeat(row, entry) {
    row.querySelector(".console-panel__ts").textContent = formatTime(
      entry.timestamp,
    );
    let badge = row.querySelector(".console-panel__repeat");
    if (!badge) {
      badge = el("span", "console-panel__repeat");
      // Repeats never carry a hap card, so the message row is always there.
      row.querySelector(".console-panel__message-row").appendChild(badge);
    }
    badge.textContent = `×${entry.count}`;
    badge.title = `Repeated ${entry.count} times`;
  }

  function buildDividerNode(entry) {
    const row = el("div", "console-panel__divider");
    row.dataset.entryId = String(entry.id);
    rowById.set(entry.id, row);
    row.setAttribute("role", "separator");
    const labelText = entry.message
      ? `${entry.message} · ${formatTime(entry.timestamp)}`
      : formatTime(entry.timestamp);
    const label = el("span", "console-panel__divider-label", labelText);
    row.appendChild(label);
    return row;
  }

  function buildLineBadge(location) {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "console-panel__line-badge";
    badge.textContent = `[line ${location.line}]`;
    badge.title = `Jump to line ${location.line}`;
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onJumpToLine(location);
    });
    return badge;
  }

  function buildHapCard(entry, hap) {
    const card = el("div", "console-panel__hap");

    if (entry.message) {
      const head = el("div", "console-panel__hap-head", entry.message);
      card.appendChild(head);
    }

    const span = el("div", "console-panel__hap-span");
    span.textContent = `span ${fmtFraction(hap.whole?.begin)} → ${fmtFraction(hap.whole?.end)}`;
    card.appendChild(span);

    const val = el(
      "div",
      "console-panel__hap-value",
      `value ${stringify(hap.value)}`,
    );
    card.appendChild(val);

    // Source location — some Strudel errors carry a `{ line, column }`
    // in `data.locations` or similar. If we find one, render it as a
    // clickable pointer; the host can attach a click handler through a
    // future API if needed, but for now it's just informational.
    const loc = extractSourceLocation(hap, entry.data);
    if (loc) {
      const locEl = el(
        "div",
        "console-panel__hap-loc",
        `at line ${loc.line}${loc.column != null ? `, col ${loc.column}` : ""}`,
      );
      card.appendChild(locEl);
    }

    return card;
  }

  // ─── Filters + keyboard ───────────────────────────────────────────────

  function toggleLevel(level) {
    if (enabledLevels.has(level)) enabledLevels.delete(level);
    else enabledLevels.add(level);
    const btn = levelButtons[level];
    if (btn) {
      const on = enabledLevels.has(level);
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    render();
  }

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
        // First Escape clears the filter — second Escape returns focus
        // to the editor. Matches the sound browser + reference panel.
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
      // Jump into the list so subsequent arrow keys scroll. Matches the
      // "search then arrow-down" muscle memory from the other panels,
      // even though the console has no per-entry focus.
      e.preventDefault();
      clearTimeout(searchTimer);
      query = searchInput.value.trim().toLowerCase();
      render();
      listEl.focus();
    }
  }

  function onListKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      onFocusEditor();
      return;
    }
    // Read-only scroll keys — the console intentionally has no
    // per-entry focus, so these just nudge the scroll position.
    const ROW_PX = 22;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      listEl.scrollTop += ROW_PX;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      listEl.scrollTop -= ROW_PX;
      return;
    }
    if (e.key === "PageDown") {
      e.preventDefault();
      listEl.scrollTop += listEl.clientHeight * 0.9;
      return;
    }
    if (e.key === "PageUp") {
      e.preventDefault();
      listEl.scrollTop -= listEl.clientHeight * 0.9;
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      listEl.scrollTop = 0;
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      listEl.scrollTop = listEl.scrollHeight;
    }
  }
}

// ─── Pure helpers (no closure state) ──────────────────────────────────────

/**
 * Coerce whatever a caller handed us into a displayable string. Strings
 * pass through, primitives get `String()`, everything else goes through
 * `JSON.stringify` with a fallback to defend against circular refs.
 */
function stringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message || String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Whether a new line is the previous entry over again. Entries that carry
 * a hap are never merged: each one renders its own span/value card.
 */
function isRepeat(last, level, message, data) {
  if (level === "divider" || last.level !== level) return false;
  if (last.message !== message) return false;
  return !extractHap(last) && !extractHap({ data });
}

function formatTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Strudel's Fraction type (`{ n, d }` or `{ numerator, denominator }`
 * depending on the path it came from) pretty-prints as "1/2". Numbers
 * pass through. Anything weird falls back to `String(v)`.
 */
function fmtFraction(v) {
  if (v == null) return "?";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    if (typeof v.n === "number" && typeof v.d === "number") {
      return v.d === 1 ? String(v.n) : `${v.n}/${v.d}`;
    }
    if (typeof v.numerator === "number" && typeof v.denominator === "number") {
      return v.denominator === 1
        ? String(v.numerator)
        : `${v.numerator}/${v.denominator}`;
    }
    if (typeof v.valueOf === "function") {
      try {
        const n = v.valueOf();
        if (typeof n === "number") return String(n);
      } catch {
        /* ignore */
      }
    }
  }
  return String(v);
}

/**
 * Heuristic hap detection — a Strudel hap is `{ whole, part, value }`
 * at minimum. Logs may pass the hap directly as `data`, or nested
 * under `data.hap`. Anything else returns null and the entry falls
 * back to the plain-text renderer.
 */
function extractHap(entry) {
  const d = entry?.data;
  if (!d || typeof d !== "object") return null;
  const candidate = d.hap ?? d;
  if (
    candidate &&
    typeof candidate === "object" &&
    candidate.whole &&
    "value" in candidate
  ) {
    return candidate;
  }
  return null;
}

/**
 * Some Strudel errors carry a source location in `data.locations` (an
 * array) or directly on the hap as `{ line, column }`. Try the common
 * shapes; return null if we can't find anything that looks numeric.
 */
function extractSourceLocation(hap, rawData) {
  if (hap && typeof hap.line === "number") {
    return { line: hap.line, column: hap.column };
  }
  if (rawData && Array.isArray(rawData.locations) && rawData.locations[0]) {
    const l = rawData.locations[0];
    if (typeof l.line === "number") return { line: l.line, column: l.column };
  }
  if (rawData && typeof rawData.line === "number") {
    return { line: rawData.line, column: rawData.column };
  }
  return null;
}

function extractEntryLocation(level, message, rawData) {
  if (level !== "error") return null;

  const fromError = extractErrorLine(rawData?.error ?? rawData);
  if (fromError) {
    return { line: fromError.line, column: fromError.column };
  }

  const fromStructuredData = extractSourceLocation(null, rawData);
  if (fromStructuredData) return fromStructuredData;

  const fromMessage = extractErrorLine({ message });
  if (fromMessage) {
    return { line: fromMessage.line, column: fromMessage.column };
  }

  return null;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
