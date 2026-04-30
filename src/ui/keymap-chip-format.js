// Pure helper for the chip's text content. Lives in its own file so the
// node test runner can import it without pulling in DOM, CodeMirror, or
// the strudel-docs.json index that the editor-side modules transitively
// load. See design/work/21-keybindings.md §"Keymap chip + popover".

export function formatChipLabel(profile, currentMode) {
  if (!profile.isModal) return `${profile.label} ▾`;
  const modeLabel = currentMode ? String(currentMode).toUpperCase() : profile.modes[0];
  return `${profile.label} · ${modeLabel} ▾`;
}
