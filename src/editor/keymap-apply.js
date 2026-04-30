// Single canonical handler for changing keymap profiles. Both the
// transport-bar chip popover and the Settings → Editor → Keymap
// dropdown call this. Subscribers (chip relabel, dropdown update,
// mode-subscription attach/detach) register via `subscribe(...)`.
//
// See design/work/21-keybindings.md §"Profile change flow".

import {
  getProfile,
  setStoredProfileId,
} from "./keymap-profiles.js";
import { applyPanelSetting, reconfigureOverlay } from "../editor-setup.js";

const subscribers = new Set();

export function subscribeKeymapChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function applyKeymapProfile(editor, profileId, { onEvaluate }) {
  const profile = getProfile(profileId);

  // Strudel-side: reconfigure its keybindings compartment + persist to atom.
  applyPanelSetting(editor, "keybindings", profile.strudelKeybindings);

  // Strasbeat-side: turn the overlay on/off via our compartment.
  reconfigureOverlay(editor, profile.applyStrasbeatOverlay, onEvaluate);

  // Persist canonical profile id (Strudel atom mirrors the string;
  // strasbeat profile id is the source of truth so we can map back to
  // the chip / dropdown on reload).
  setStoredProfileId(profile.id);

  // Notify subscribers (chip relabels, dropdown updates, mode subscription
  // attaches/detaches based on isModal).
  for (const fn of subscribers) {
    try {
      fn(profile);
    } catch (err) {
      console.warn("[strasbeat/keymap] subscriber threw:", err);
    }
  }
}
