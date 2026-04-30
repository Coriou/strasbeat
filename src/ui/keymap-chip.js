// Transport-bar keymap chip. Shows the active profile and (for modal
// profiles) the current Vim/Helix mode. Click → popover (added in a
// later task). Mounted next to the MIDI pill.
//
// See design/work/21-keybindings.md §"Keymap chip + popover".

import { getProfile, getStoredProfileId } from "../editor/keymap-profiles.js";
import { subscribeKeymapChange } from "../editor/keymap-apply.js";
import { formatChipLabel } from "./keymap-chip-format.js";

export { formatChipLabel };

// Mounts the chip element into `container`. Returns an API object the
// caller can use later (e.g. for the popover task) — we expose `el`, a
// `setMode(mode)` setter for modal profiles, and `destroy()` for teardown.
export function mountKeymapChip({ container }) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "transport__pill keymap-chip";
  el.id = "keymap-chip";
  let currentMode = null;

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
  });

  function setMode(mode) {
    currentMode = mode;
    render();
  }

  render();
  container.appendChild(el);

  return {
    el,
    setMode,
    destroy: () => {
      unsubscribe();
      el.remove();
    },
  };
}
