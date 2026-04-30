// Transport-bar keymap chip. Shows the active profile and (for modal
// profiles) the current Vim/Helix mode. Click → opens profile picker popover.
// Mounted next to the MIDI pill.
//
// See design/work/21-keybindings.md §"Keymap chip + popover".
//
// Vim mode subscription uses @replit/codemirror-vim's getCM() + cm.on().
// getCM(view) returns the CM5-compat adapter stored at view.cm; that adapter
// fires "vim-mode-change" events with { mode, subMode } whenever the Vim mode
// flips. This is the same channel the built-in status panel uses (line ~8425
// of @replit/codemirror-vim/dist/index.js).
//
// Helix: Strudel's keybindings.mjs has no helix entry — the profile is
// aspirational. There is no vim-like adapter for it, so the subscription
// attempt returns null and the mode stays at "NORMAL" (first entry in
// profile.modes). That is the correct safe default.

import {
  KEYMAP_PROFILES,
  getProfile,
  getStoredProfileId,
  hasSeenTooltip,
  markTooltipSeen,
} from "../editor/keymap-profiles.js";
import { applyKeymapProfile, subscribeKeymapChange } from "../editor/keymap-apply.js";
import { formatChipLabel } from "./keymap-chip-format.js";
import { makeIcon } from "./icons.js";

export { formatChipLabel };

// Subscribes to Vim mode changes via the @replit/codemirror-vim CM5-compat
// adapter. Returns a teardown function.
//
// @replit/codemirror-vim's ViewPlugin stores the adapter at `view.cm`
// (source: @replit/codemirror-vim/dist/index.js line 8415). The adapter
// fires "vim-mode-change" events and exposes cm.on() / cm.off() for
// subscribe/unsubscribe. We read view.cm directly to avoid adding a static
// import of @replit/codemirror-vim (which is a transitive dep, not in
// package.json, so Rollup can't resolve it in production builds).
//
// If view.cm is not yet set (vim plugin initialises asynchronously on
// first render), we retry once after 50 ms. If still null (helix profile
// or non-vim context), we give up silently — the mode label stays at the
// profile's first entry ("NORMAL").
function subscribeVimMode(view, listener) {
  let cm = null;
  let torn = false;

  function handler(e) {
    if (torn) return;
    const mode = (e.mode ?? "normal").toUpperCase();
    listener(mode);
  }

  function attach(adapter) {
    if (torn) return;
    cm = adapter;
    cm.on("vim-mode-change", handler);
    // Prime with the current mode if already known (e.g. reload with vim active).
    const primeMode = adapter.state?.vim?.mode;
    if (primeMode) listener(primeMode.toUpperCase());
  }

  function tryAttach() {
    if (torn) return;
    // view.cm is set by the vim ViewPlugin constructor (same frame as
    // applyKeymapProfile in practice, but a retry handles the edge case).
    const adapter = view.cm ?? null;
    if (adapter) {
      attach(adapter);
    } else {
      setTimeout(() => {
        if (torn) return;
        const adapter2 = view.cm ?? null;
        if (adapter2) attach(adapter2);
        // If still null (e.g. helix profile), silently give up.
      }, 50);
    }
  }

  tryAttach();

  return () => {
    torn = true;
    if (cm) {
      cm.off("vim-mode-change", handler);
      cm = null;
    }
  };
}

// Mounts the chip element into `container`. Returns an API object the
// caller can use later — we expose `el`, a `setMode(mode)` setter for
// modal profiles, and `destroy()` for teardown.
export function mountKeymapChip({ container, editor, onEvaluate }) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "transport__pill keymap-chip";
  el.id = "keymap-chip";
  el.setAttribute("aria-haspopup", "menu");
  el.setAttribute("aria-expanded", "false");
  let currentMode = null;
  let popover = null;
  let modeUnsub = null;
  let tooltip = null;

  // Persistent children — built once so mode flips don't tear down nodes.
  // Layout: [label] [sep · mode]? [chevron]
  const labelEl = document.createElement("span");
  labelEl.className = "keymap-chip__label";
  const modeWrap = document.createElement("span");
  modeWrap.className = "keymap-chip__mode";
  modeWrap.setAttribute("aria-hidden", "true");
  const modeEl = document.createElement("span");
  modeEl.className = "keymap-chip__mode-text";
  modeWrap.appendChild(modeEl);
  const chevron = makeIcon("chevron-down");
  chevron.classList.add("keymap-chip__chevron");
  el.appendChild(labelEl);
  el.appendChild(modeWrap);
  el.appendChild(chevron);

  function render() {
    const profile = getProfile(getStoredProfileId());
    labelEl.textContent = profile.label;
    if (profile.isModal) {
      modeWrap.dataset.shown = "1";
      modeEl.textContent = currentMode || profile.modes[0];
    } else {
      modeWrap.dataset.shown = "0";
      modeEl.textContent = "";
    }
    // Accessible label for screen readers — full string form, including the
    // dropdown affordance, so screen readers announce e.g. "Vim · NORMAL,
    // keymap profile picker, menu".
    el.setAttribute("aria-label", `${formatChipLabel(profile, currentMode).replace(/\s*▾\s*$/, "")}, keymap profile`);
    el.dataset.profile = profile.id;
    el.dataset.modal = profile.isModal ? "1" : "0";
  }

  // Attach or detach the mode subscription when the active profile changes.
  // If entering a modal profile, wire up the vim-mode-change listener and
  // prime currentMode to the profile's first mode label (e.g. "NORMAL").
  // If leaving, tear down and clear the mode so the chip label reverts to
  // plain "VSCode ▾" etc.
  function attachModeSubscription(profile) {
    if (modeUnsub) {
      modeUnsub();
      modeUnsub = null;
    }
    if (!profile.isModal) {
      currentMode = null;
      return;
    }
    // Prime with the initial mode before the first event fires.
    currentMode = profile.modes[0];
    modeUnsub = subscribeVimMode(editor.editor, (mode) => {
      currentMode = mode;
      render();
    });
  }

  // Re-render when the profile changes (chip popover or settings dropdown).
  const unsubscribe = subscribeKeymapChange((profile) => {
    attachModeSubscription(profile);
    render();
    closePopover();
  });

  function setMode(mode) {
    currentMode = mode;
    render();
  }

  function openPopover() {
    if (popover) return;
    popover = renderPopover({
      anchor: el,
      activeId: getStoredProfileId(),
      onPick: (profileId) => {
        applyKeymapProfile(editor, profileId, { onEvaluate });
        closePopover();
      },
      onDismiss: closePopover,
    });
    el.setAttribute("aria-expanded", "true");
  }

  function closePopover() {
    if (!popover) return;
    popover.destroy();
    popover = null;
    el.setAttribute("aria-expanded", "false");
    el.focus();
  }

  el.addEventListener("click", () => {
    if (popover) closePopover();
    else openPopover();
  });

  // Handle reload: if the stored profile is already modal (e.g. user had
  // vim active last session), prime the subscription immediately so the chip
  // shows "Vim · NORMAL ▾" on first paint instead of just "Vim ▾".
  const initialProfile = getProfile(getStoredProfileId());
  if (initialProfile.isModal) {
    attachModeSubscription(initialProfile);
  }

  function showInitialTooltipIfNeeded() {
    if (hasSeenTooltip()) return;
    tooltip = document.createElement("div");
    tooltip.className = "keymap-chip__tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = "Click to change your editor keymap";
    document.body.appendChild(tooltip);

    // Position above the chip. We can't measure until the chip is in the
    // DOM, so requestAnimationFrame defers this one frame.
    requestAnimationFrame(() => {
      if (!tooltip) return;
      const rect = el.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      tooltip.style.position = "fixed";
      tooltip.style.left = `${Math.max(8, rect.left)}px`;
      tooltip.style.top = `${rect.top - tipRect.height - 8}px`;
    });

    function dismiss() {
      if (!tooltip) return;
      markTooltipSeen();
      tooltip.remove();
      tooltip = null;
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
    }

    // Any user interaction dismisses it. Capture-phase listeners so we
    // see the event before any in-app handler can stopPropagation.
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
  }

  render();
  container.appendChild(el);
  showInitialTooltipIfNeeded();

  return {
    el,
    setMode,
    destroy: () => {
      if (tooltip) tooltip.remove();
      if (modeUnsub) {
        modeUnsub();
        modeUnsub = null;
      }
      closePopover();
      unsubscribe();
      el.remove();
    },
  };
}

// Private helper — NOT exported. Renders the profile picker popover,
// positions it above the anchor chip, wires keyboard nav + click-outside,
// and returns a { destroy } handle for teardown.
function renderPopover({ anchor, activeId, onPick, onDismiss }) {
  const popover = document.createElement("div");
  popover.className = "keymap-popover";
  popover.setAttribute("role", "menu");

  const rows = KEYMAP_PROFILES.map((profile) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "keymap-popover__row";
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", profile.id === activeId ? "true" : "false");
    row.dataset.profileId = profile.id;
    if (profile.id === activeId) row.classList.add("keymap-popover__row--active");

    const check = document.createElement("span");
    check.className = "keymap-popover__check";
    check.setAttribute("aria-hidden", "true");
    if (profile.id === activeId) {
      const checkIcon = makeIcon("check");
      check.appendChild(checkIcon);
    }
    row.appendChild(check);

    const body = document.createElement("span");
    body.className = "keymap-popover__body";
    const name = document.createElement("span");
    name.className = "keymap-popover__name";
    name.textContent = profile.label;
    const desc = document.createElement("span");
    desc.className = "keymap-popover__desc";
    desc.textContent = profile.description;
    body.appendChild(name);
    body.appendChild(desc);
    row.appendChild(body);

    if (profile.isDefault) {
      const tag = document.createElement("span");
      tag.className = "keymap-popover__tag";
      tag.textContent = "default";
      row.appendChild(tag);
    }

    row.addEventListener("click", () => onPick(profile.id));
    popover.appendChild(row);
    return row;
  });

  // Position above the chip (transport bar is at the bottom of the shell).
  // Default to chip-left-aligned; if that would overflow the viewport on
  // the right, fall back to chip-right-aligned. The chip lives near the
  // right edge of the transport bar, so right-alignment is the common case.
  document.body.appendChild(popover);
  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 8;
  const overflowRight = rect.left + popRect.width > window.innerWidth - margin;
  const left = overflowRight
    ? Math.max(margin, rect.right - popRect.width)
    : Math.max(margin, rect.left);
  popover.style.position = "fixed";
  popover.style.left = `${left}px`;
  popover.style.top = `${rect.top - popRect.height - margin}px`;

  // Initial focus on the active row (or first row if no row matched).
  const activeRow = rows.find((r) => r.dataset.profileId === activeId) ?? rows[0];
  activeRow.focus();

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = (idx + delta + rows.length) % rows.length;
      rows[next].focus();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const focused = document.activeElement;
      if (focused?.dataset?.profileId) onPick(focused.dataset.profileId);
    }
  }

  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchor) onDismiss();
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onClickOutside, true);

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onClickOutside, true);
      popover.remove();
    },
  };
}
