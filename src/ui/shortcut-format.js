// Platform-consistent shortcut text for chrome (tooltips, menu hints, the
// keymap popover). macOS gets modifier glyphs with no separators (⌘⇧P);
// everything else gets spelled-out names joined with "+" (Ctrl+Shift+P).
// Pure — the platform is a parameter so both spellings are testable.

export function isMacPlatform() {
  return /Mac|iPhone|iPad/.test(
    typeof navigator !== "undefined" ? (navigator.platform ?? "") : "",
  );
}

const MAC_MODS = { Mod: "⌘", Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const OTHER_MODS = { Mod: "Ctrl", Cmd: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
const MAC_KEYS = { Enter: "↵", "⏎": "↵", Backspace: "⌫" };
const OTHER_KEYS = { "↵": "Enter", "⏎": "Enter", "⌫": "Backspace" };

/**
 * Format one chord written as "Mod+Shift+P". `Mod` (and `Cmd`) is the
 * platform's primary modifier.
 */
export function formatShortcut(chord, isMac = isMacPlatform()) {
  const parts = String(chord).split("+");
  const key = parts.pop();
  const mods = parts.map((m) => (isMac ? MAC_MODS : OTHER_MODS)[m] ?? m);
  const keyText = (isMac ? MAC_KEYS : OTHER_KEYS)[key] ?? key;
  return isMac ? mods.join("") + keyText : [...mods, keyText].join("+");
}

/**
 * Rewrite every "Cmd+…"/"Ctrl+…"/"Alt+…"/"Shift+…" chord inside a sentence
 * (the keymap profile descriptions) for the platform, leaving the prose and
 * Emacs-style "C-x" notation alone.
 */
export function localizeShortcuts(text, isMac = isMacPlatform()) {
  return String(text).replace(
    /\b(?:(?:Mod|Cmd|Ctrl|Alt|Shift)\+)+(?:[A-Za-z0-9]+|\S)/g,
    (chord) => formatShortcut(chord, isMac),
  );
}
