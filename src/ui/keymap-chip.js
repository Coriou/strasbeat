// Transport-bar keymap chip. Shows the active profile and (for modal
// profiles) the current Vim/Helix mode. Click → popover (added in a
// later task). Mounted next to the MIDI pill.
//
// See design/work/21-keybindings.md §"Keymap chip + popover".

export function formatChipLabel(profile, currentMode) {
  if (!profile.isModal) return `${profile.label} ▾`;
  const modeLabel = currentMode ? String(currentMode).toUpperCase() : profile.modes[0];
  return `${profile.label} · ${modeLabel} ▾`;
}
