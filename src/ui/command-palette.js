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
// the input. Focus is trapped inside the overlay while open.

import { makeIcon } from "./icons.js";

const STORAGE_KEY = "strasbeat:palette-recents";
const MAX_RECENTS = 5;

let instance = null;

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
  let recents = loadRecents();

  // ─── DOM ──────────────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  overlay.setAttribute("role", "dialog");
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
  inputWrap.appendChild(input);

  const list = document.createElement("ul");
  list.id = "palette-list";
  list.className = "palette__list";
  list.setAttribute("role", "listbox");

  container.appendChild(inputWrap);
  container.appendChild(list);
  overlay.appendChild(container);

  // ─── Rendering ────────────────────────────────────────────────────────

  function renderList() {
    list.replaceChildren();
    for (let i = 0; i < filteredCommands.length; i++) {
      const cmd = filteredCommands[i];
      const li = document.createElement("li");
      li.className = "palette__item";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === selectedIndex ? "true" : "false");
      if (i === selectedIndex) li.classList.add("is-selected");
      li.dataset.index = i;

      const labelSpan = document.createElement("span");
      labelSpan.className = "palette__item-label";
      labelSpan.textContent = cmd.label;
      li.appendChild(labelSpan);

      if (cmd.shortcut) {
        const kbd = document.createElement("kbd");
        kbd.className = "palette__item-kbd";
        kbd.textContent = cmd.shortcut;
        li.appendChild(kbd);
      }

      li.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // keep focus on input
        executeCommand(i);
      });

      list.appendChild(li);
    }

    // Scroll selected into view
    const selectedEl = list.querySelector(".is-selected");
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
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
        const shortcut = (cmd.shortcut || "").toLowerCase();
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

  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        selectedIndex = Math.min(
          selectedIndex + 1,
          filteredCommands.length - 1,
        );
        renderList();
        break;
      case "ArrowUp":
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        renderList();
        break;
      case "Enter":
        e.preventDefault();
        executeCommand(selectedIndex);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
    }
  });

  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) {
      e.preventDefault();
      close();
    }
  });

  // ─── Public API ───────────────────────────────────────────────────────

  function open() {
    if (isOpen) {
      input.focus();
      input.select();
      return;
    }
    isOpen = true;
    prevFocus = document.activeElement;
    document.body.appendChild(overlay);
    input.value = "";
    filter("");
    requestAnimationFrame(() => {
      overlay.classList.add("palette-overlay--open");
      input.focus();
    });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.classList.remove("palette-overlay--open");
    overlay.classList.add("palette-overlay--exiting");
    const onEnd = () => {
      overlay.classList.remove("palette-overlay--exiting");
      overlay.remove();
    };
    overlay.addEventListener("transitionend", onEnd, { once: true });
    // Fallback in case transitionend doesn't fire (edge case)
    setTimeout(onEnd, 200);
    if (prevFocus && typeof prevFocus.focus === "function") {
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
  onOpenSetup,
  onClosePanel,
  onFocusPatterns,
  onSwitchToRoll,
  onSwitchToScope,
}) {
  return [
    // ─── Transport ────────────────
    {
      id: "play",
      label: "Play / Evaluate",
      shortcut: `${MOD}↵`,
      run: onEvaluate,
    },
    { id: "stop", label: "Stop Playback", shortcut: "Ctrl+.", run: onStop },

    // ─── Editor ───────────────────
    {
      id: "comment",
      label: "Toggle Comment",
      shortcut: `${MOD}/`,
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
      id: "setup",
      label: "Open Setup Panel",
      shortcut: null,
      run: onOpenSetup,
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

    // ─── File ─────────────────────
    { id: "save", label: "Save Pattern", shortcut: `${MOD}S`, run: onSave },
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
  ];
}
