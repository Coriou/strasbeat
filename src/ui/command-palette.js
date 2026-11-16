// Command palette — VS Code-style Cmd+Shift+P overlay.
//
// Lists every available action with its keyboard shortcut, supports
// incremental fuzzy filtering, and executes on Enter/click. Designed to
// close the "Recognition Rather Than Recall" gap identified in the
// design critique: all 12+ keyboard shortcuts are now discoverable
// without reading source.
//
// Usage:
//
//   import { mountCommandPalette } from './ui/command-palette.js';
//
//   const palette = mountCommandPalette({
//     commands: [
//       { id: 'play', label: 'Play', shortcut: '⌘↵', run: () => editor.evaluate() },
//       ...
//     ],
//   });
//   palette.toggle(); // or palette.open() / palette.close()
//
// Only one palette may be open at a time. Opening while open refocuses
// the input. Focus is trapped inside the overlay while open: the input is
// the only focus target, and keys are handled at the document level so
// Escape always closes it no matter where focus ended up.

import { makeIcon } from "./icons.js";
import { getStoredProfileId } from "../editor/keymap-profiles.js";
import { subscribeKeymapChange } from "../editor/keymap-apply.js";

const STORAGE_KEY = "strasbeat:palette-recents";
const EXIT_MS = 120; // a little past the exit fade, see command-palette.css
const MAX_RECENTS = 5;

let instance = null;

// Resolve the shortcut to display for a command based on the currently
// active keymap profile. Modal profiles (vim/emacs/helix) can override
// the default shortcut via vimShortcut / emacsShortcut / helixShortcut
// fields on the command. Falls back to the default `shortcut` for
// Strudel and VSCode.
function shortcutForActiveProfile(cmd) {
  const profileId = getStoredProfileId();
  if (profileId === "vim" && cmd.vimShortcut) return cmd.vimShortcut;
  if (profileId === "emacs" && cmd.emacsShortcut) return cmd.emacsShortcut;
  if (profileId === "helix" && cmd.helixShortcut) return cmd.helixShortcut;
  return cmd.shortcut ?? null;
}

export function mountCommandPalette({ commands }) {
  if (instance) {
    instance.setCommands(commands);
    return instance;
  }

  let allCommands = commands;
  let filteredCommands = commands;
  let selectedIndex = 0;
  let isOpen = false;
  let prevFocus = null;
  let exitTimer = null; // pending removal of the overlay after close()
  let recents = loadRecents();

  // ─── DOM ──────────────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Command palette");

  const container = document.createElement("div");
  container.className = "palette";

  const inputWrap = document.createElement("div");
  inputWrap.className = "palette__input-wrap";

  const chevron = makeIcon("chevron-down", { size: 14 });
  chevron.classList.add("palette__chevron");
  inputWrap.appendChild(chevron);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "palette__input";
  input.placeholder = "Type a command…";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "palette-list");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-label", "Search commands");
  input.spellcheck = false;
  input.autocomplete = "off";
  inputWrap.appendChild(input);

  const list = document.createElement("ul");
  list.id = "palette-list";
  list.className = "palette__list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Commands");

  container.appendChild(inputWrap);
  container.appendChild(list);
  overlay.appendChild(container);

  // ─── Rendering ────────────────────────────────────────────────────────

  function renderList() {
    list.replaceChildren();
    if (filteredCommands.length === 0) {
      const empty = document.createElement("li");
      empty.className = "palette__empty";
      empty.setAttribute("role", "presentation");
      empty.textContent = "No matching commands";
      list.appendChild(empty);
      input.removeAttribute("aria-activedescendant");
      return;
    }
    for (let i = 0; i < filteredCommands.length; i++) {
      const cmd = filteredCommands[i];
      const li = document.createElement("li");
      li.className = "palette__item";
      li.id = `palette-option-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.dataset.index = i;

      const labelSpan = document.createElement("span");
      labelSpan.className = "palette__item-label";
      labelSpan.textContent = cmd.label;
      li.appendChild(labelSpan);

      const sc = shortcutForActiveProfile(cmd);
      if (sc) {
        const kbd = document.createElement("kbd");
        kbd.className = "palette__item-kbd";
        kbd.textContent = sc;
        li.appendChild(kbd);
      }

      list.appendChild(li);
    }
    paintSelection();
  }

  // Move the highlight without rebuilding the list, and tell assistive
  // tech which option the (still focused) input now points at.
  function paintSelection() {
    const prev = list.querySelector(".is-selected");
    if (prev) {
      prev.classList.remove("is-selected");
      prev.setAttribute("aria-selected", "false");
    }
    const selectedEl = list.children[selectedIndex];
    if (!selectedEl || !selectedEl.classList.contains("palette__item")) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    selectedEl.classList.add("is-selected");
    selectedEl.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", selectedEl.id);
    selectedEl.scrollIntoView({ block: "nearest" });
  }

  function filter(query) {
    if (!query) {
      // No filter — show recents at top, then everything else
      const recentIds = new Set(recents);
      const recentCmds = [];
      const otherCmds = [];
      for (const cmd of allCommands) {
        if (recentIds.has(cmd.id)) recentCmds.push(cmd);
        else otherCmds.push(cmd);
      }
      // Sort recents by their order in the recents array (most recent first)
      recentCmds.sort((a, b) => recents.indexOf(a.id) - recents.indexOf(b.id));
      filteredCommands = [...recentCmds, ...otherCmds];
    } else {
      const q = query.toLowerCase();
      filteredCommands = allCommands.filter((cmd) => {
        const label = cmd.label.toLowerCase();
        const shortcut = (shortcutForActiveProfile(cmd) ?? "").toLowerCase();
        // Simple substring match — intentionally not fuzzy to keep it
        // predictable and fast.
        return label.includes(q) || shortcut.includes(q);
      });
    }
    selectedIndex = 0;
    renderList();
  }

  function executeCommand(index) {
    const cmd = filteredCommands[index];
    if (!cmd) return;
    close();
    recordRecent(cmd.id);
    try {
      cmd.run();
    } catch (err) {
      console.warn(`[strasbeat/palette] command "${cmd.id}" failed:`, err);
    }
  }

  // ─── Recents ──────────────────────────────────────────────────────────

  function loadRecents() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(0, MAX_RECENTS) : [];
    } catch {
      return [];
    }
  }

  function recordRecent(id) {
    recents = [id, ...recents.filter((r) => r !== id)].slice(0, MAX_RECENTS);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
    } catch {
      /* quota exceeded — ignore */
    }
  }

  // ─── Event handlers ───────────────────────────────────────────────────

  input.addEventListener("input", () => filter(input.value));

  // Installed on `document` (capture) while open, so the palette keeps
  // working even if focus has slipped out of the input.
  function onKeydown(e) {
    // Keys that belong to an IME composition (its committing Enter included).
    if (e.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        selectedIndex = Math.min(
          selectedIndex + 1,
          filteredCommands.length - 1,
        );
        paintSelection();
        break;
      case "ArrowUp":
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        paintSelection();
        break;
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        executeCommand(selectedIndex);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        // The input is the palette's only focus target — Tab stays put
        // rather than walking into the app behind the overlay.
        e.preventDefault();
        input.focus();
        break;
      default:
        // Typing after focus strayed: bring it home so the text lands in
        // the search field.
        if (document.activeElement !== input) input.focus();
    }
  }

  function onFocusIn(e) {
    if (!overlay.contains(e.target)) input.focus();
  }

  // mousedown would blur the input (rows aren't focusable); cancel that and
  // run the command on a real click, so right-clicks and touch scrolls over
  // the list don't fire whatever is under the pointer.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const li = e.target instanceof Element ? e.target.closest(".palette__item") : null;
    if (li) executeCommand(Number(li.dataset.index));
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) {
      e.preventDefault();
      close();
    }
  });

  // Re-render so the kbd chips reflect the new active profile. Harmless
  // when the palette is closed (just refreshes the in-memory render).
  subscribeKeymapChange(() => {
    renderList();
  });

  // ─── Public API ───────────────────────────────────────────────────────

  function open() {
    if (isOpen) {
      input.focus();
      input.select();
      return;
    }
    // A dialog is waiting for an answer: opening over it would pull focus
    // out of its trap, and one Escape would then close both.
    if (document.querySelector(".modal-overlay")) return;
    isOpen = true;
    // Reopened while the previous close was still fading out: cancel that
    // removal, or it would take the overlay away from under the new session.
    clearTimeout(exitTimer);
    exitTimer = null;
    overlay.classList.remove("palette-overlay--exiting");
    prevFocus = document.activeElement;
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("focusin", onFocusIn);
    input.value = "";
    filter("");
    input.focus();
    requestAnimationFrame(() => {
      if (isOpen) overlay.classList.add("palette-overlay--open");
    });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("focusin", onFocusIn);
    overlay.classList.remove("palette-overlay--open");
    overlay.classList.add("palette-overlay--exiting");
    // Remove after the exit transition (--t-pop-out); a timer rather than
    // transitionend so reduced-motion and interrupted fades behave the same.
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      exitTimer = null;
      overlay.classList.remove("palette-overlay--exiting");
      overlay.remove();
    }, EXIT_MS);
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") {
      prevFocus.focus();
    }
    prevFocus = null;
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function setCommands(cmds) {
    allCommands = cmds;
    if (isOpen) filter(input.value);
  }

  instance = { open, close, toggle, setCommands };
  return instance;
}

// ─── Command definitions ────────────────────────────────────────────────
// Build the canonical command list from the wired editor + UI. Called from
// main.js after the editor, transport, and panels are mounted. Every `run`
// callback is fully resolved at build time — no dynamic imports or lazy
// dispatch.

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const ALT = IS_MAC ? "⌥" : "Alt+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

export function buildCommands({
  onEvaluate,
  onStop,
  onSave,
  onExportWav,
  onShare,
  onFormatCode,
  onToggleComment,
  onMuteTrack,
  onSoloTrack,
  onSelectNext,
  onSelectAllOccurrences,
  onSelectLine,
  onDeleteLine,
  onMoveLineUp,
  onMoveLineDown,
  onIndent,
  onDedent,
  onOpenLearn,
  onOpenSounds,
  onOpenReference,
  onOpenConsole,
  onOpenExport,
  onOpenSettings,
  onClosePanel,
  onFocusPatterns,
  onSwitchToRoll,
  onSwitchToScope,
  onRevealSound,
  onNextTab,
  onPrevTab,
  onCloseActiveTab,
  onToggleVisualsFullWindow,
}) {
  const commands = [
    // ─── Transport ────────────────
    {
      id: "play",
      label: "Play / Evaluate",
      shortcut: `${MOD}↵`,
      run: onEvaluate,
    },
    { id: "stop", label: "Stop Playback", shortcut: "Ctrl+.", run: onStop },
    {
      id: "evalStrudel",
      label: "Eval (Strudel :w)",
      // No shortcut — palette-only entry for searchability. The actual
      // evaluate keybinding is :w in vim, Cmd+Enter universally.
      run: onEvaluate,
    },
    {
      id: "stopStrudel",
      label: "Stop (Strudel :q)",
      run: onStop,
    },

    // ─── Editor ───────────────────
    {
      id: "comment",
      label: "Toggle Comment",
      shortcut: `${MOD}/`,
      vimShortcut: "gc",
      emacsShortcut: "C-/",
      helixShortcut: "gc",
      run: onToggleComment,
    },
    {
      id: "format",
      label: "Format Code",
      shortcut: `${SHIFT}${ALT}F`,
      run: onFormatCode,
    },
    {
      id: "mute",
      label: "Mute Track at Cursor",
      shortcut: `${MOD}M`,
      run: onMuteTrack,
    },
    {
      id: "solo",
      label: "Solo Track at Cursor",
      shortcut: `${MOD}${SHIFT}S`,
      run: onSoloTrack,
    },
    {
      id: "selectNext",
      label: "Select Next Occurrence",
      shortcut: `${MOD}D`,
      run: onSelectNext,
    },
    {
      id: "selectAll",
      label: "Select All Occurrences",
      shortcut: `${MOD}${SHIFT}L`,
      run: onSelectAllOccurrences,
    },
    {
      id: "selectLine",
      label: "Select Line",
      shortcut: `${MOD}L`,
      run: onSelectLine,
    },
    {
      id: "deleteLine",
      label: "Delete Line",
      shortcut: `${MOD}${SHIFT}K`,
      run: onDeleteLine,
    },
    {
      id: "moveLineUp",
      label: "Move Line Up",
      shortcut: `${ALT}↑`,
      run: onMoveLineUp,
    },
    {
      id: "moveLineDown",
      label: "Move Line Down",
      shortcut: `${ALT}↓`,
      run: onMoveLineDown,
    },
    { id: "indent", label: "Indent", shortcut: `${MOD}]`, run: onIndent },
    { id: "dedent", label: "Dedent", shortcut: `${MOD}[`, run: onDedent },

    // ─── Panels ───────────────────
    {
      id: "learn",
      label: "Open Learn Panel",
      shortcut: null,
      run: onOpenLearn,
    },
    {
      id: "sounds",
      label: "Open Sound Browser",
      shortcut: null,
      run: onOpenSounds,
    },
    {
      id: "revealSound",
      label: "Reveal sound in browser",
      // Same shortcut as the Layer-2 keymap binding so the chip in the
      // palette matches the muscle memory. The palette path can't read
      // the editor's cursor (that lives inside CM6), so it just falls
      // through to opening the panel — the user keeps their search.
      shortcut: `${MOD}${SHIFT}B`,
      run: onRevealSound,
    },
    {
      id: "reference",
      label: "Open Function Reference",
      shortcut: null,
      run: onOpenReference,
    },
    {
      id: "console",
      label: "Open Console",
      shortcut: null,
      run: onOpenConsole,
    },
    {
      id: "export",
      label: "Open Export Panel",
      shortcut: null,
      run: onOpenExport,
    },
    {
      id: "settings",
      label: "Open Settings",
      shortcut: null,
      run: onOpenSettings,
    },
    {
      id: "closePanel",
      label: "Close Panel",
      shortcut: null,
      run: onClosePanel,
    },
    {
      id: "patterns",
      label: "Focus Pattern Search",
      shortcut: null,
      run: onFocusPatterns,
    },

    // ─── Tabs ─────────────────────
    { id: "nextTab", label: "Next Tab", run: onNextTab },
    { id: "prevTab", label: "Previous Tab", run: onPrevTab },
    { id: "closeTab", label: "Close Tab", run: onCloseActiveTab },

    // ─── File ─────────────────────
    // Writing a pattern file to disk only exists on the dev server; in a
    // production build there's nothing to run (patterns autosave in the
    // browser), so the host leaves onSave out and the entry is dropped.
    { id: "save", label: "Save Pattern to Disk (dev)", shortcut: null, run: onSave },
    { id: "exportWav", label: "Export WAV", shortcut: null, run: onExportWav },
    { id: "share", label: "Copy Share Link", shortcut: null, run: onShare },

    // ─── Visualization ────────────
    {
      id: "switchRoll",
      label: "Switch to Piano Roll",
      shortcut: null,
      run: onSwitchToRoll,
    },
    {
      id: "switchScope",
      label: "Switch to Scope",
      shortcut: null,
      run: onSwitchToScope,
    },
    {
      id: "toggleVisualsFullWindow",
      label: "Visuals: toggle full-window",
      shortcut: null,
      run: onToggleVisualsFullWindow,
    },
  ];
  // An entry whose action the host didn't wire would close the palette and
  // do nothing — leave it out instead.
  return commands.filter((cmd) => typeof cmd.run === "function");
}
