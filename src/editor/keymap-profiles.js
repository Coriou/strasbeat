// Single source of truth for keybinding profiles. Pure module — no DOM,
// no CodeMirror imports — so it can be unit-tested with node --test.
//
// See design/work/21-keybindings.md for rationale.

export const KEYMAP_PROFILES = [
  {
    id: "strudel",
    label: "Strudel",
    description: "Matches strudel.cc · Ctrl+⏎ play, Ctrl+. stop",
    isDefault: true,
    strudelKeybindings: "codemirror",
    applyStrasbeatOverlay: false,
    isModal: false,
  },
  {
    id: "vscode",
    label: "VSCode",
    description: "Cmd+D selectNext, Cmd+Shift+K delete line, Alt+↓ move",
    strudelKeybindings: "vscode",
    applyStrasbeatOverlay: true,
    isModal: false,
  },
  {
    id: "vim",
    label: "Vim",
    description: "Modal · :w eval, :q stop, gc comment",
    strudelKeybindings: "vim",
    applyStrasbeatOverlay: false,
    isModal: true,
    modes: ["NORMAL", "INSERT", "VISUAL", "REPLACE"],
  },
  {
    id: "emacs",
    label: "Emacs",
    description: "C-x C-s save, C-/ comment, M-w yank",
    strudelKeybindings: "emacs",
    applyStrasbeatOverlay: false,
    isModal: false,
  },
  {
    id: "helix",
    label: "Helix",
    description: "Modal · select-then-act, gc comment",
    strudelKeybindings: "helix",
    applyStrasbeatOverlay: false,
    isModal: true,
    modes: ["NORMAL", "INSERT", "SELECT"],
  },
];

export const DEFAULT_PROFILE_ID = "strudel";
export const STORAGE_KEY = "strasbeat:keymap-profile";
export const TOOLTIP_SEEN_KEY = "strasbeat:keymap-chip-seen";

const PROFILE_BY_ID = new Map(KEYMAP_PROFILES.map((p) => [p.id, p]));

export function getProfile(id) {
  return PROFILE_BY_ID.get(id) ?? PROFILE_BY_ID.get(DEFAULT_PROFILE_ID);
}

export function getStoredProfileId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return PROFILE_BY_ID.has(raw) ? raw : DEFAULT_PROFILE_ID;
  } catch {
    return DEFAULT_PROFILE_ID;
  }
}

export function setStoredProfileId(id) {
  if (!PROFILE_BY_ID.has(id)) return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage may be unavailable (private browsing, full disk). Silent
    // fail is acceptable — the live profile change still applies.
  }
}

export function hasSeenTooltip() {
  try {
    return localStorage.getItem(TOOLTIP_SEEN_KEY) === "1";
  } catch {
    // Pretend we've seen it so we don't keep showing the tooltip when
    // storage is unavailable.
    return true;
  }
}

export function markTooltipSeen() {
  try {
    localStorage.setItem(TOOLTIP_SEEN_KEY, "1");
  } catch {
    // Same rationale as setStoredProfileId — storage failures are silent.
  }
}
