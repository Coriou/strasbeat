// Transport-bar keymap chip. Shows the active profile and (for modal
// profiles) the current Vim/Helix mode. Click → opens profile picker popover.
// Mounted next to the MIDI pill.
//
// See design/work/21-keybindings.md §"Keymap chip + popover".

import { getProfile, getStoredProfileId } from "../editor/keymap-profiles.js";
import { subscribeKeymapChange, applyKeymapProfile } from "../editor/keymap-apply.js";
import { KEYMAP_PROFILES } from "../editor/keymap-profiles.js";
import { formatChipLabel } from "./keymap-chip-format.js";

export { formatChipLabel };

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

  function render() {
    const profile = getProfile(getStoredProfileId());
    el.textContent = formatChipLabel(profile, currentMode);
    el.dataset.profile = profile.id;
    el.dataset.modal = profile.isModal ? "1" : "0";
  }

  // Re-render when the profile changes (chip popover or settings dropdown).
  const unsubscribe = subscribeKeymapChange((profile) => {
    // Reset mode when leaving a modal profile, otherwise the stale
    // "INSERT" tag would render alongside the new "VSCode" label.
    if (!profile.isModal) currentMode = null;
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

  render();
  container.appendChild(el);

  return {
    el,
    setMode,
    destroy: () => {
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
    check.textContent = profile.id === activeId ? "✓" : "";
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
  document.body.appendChild(popover);
  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.left = `${Math.max(8, rect.left)}px`;
  popover.style.top = `${rect.top - popRect.height - 8}px`;

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
