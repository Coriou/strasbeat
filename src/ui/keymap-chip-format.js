// Pure helper for the chip's text content. Lives in its own file so the
// node test runner can import it without pulling in DOM, CodeMirror, or
// the strudel-docs.json index that the editor-side modules transitively
// load. See design/work/21-keybindings.md §"Keymap chip + popover".

export function formatChipLabel(profile, currentMode, status = "ready") {
  const { text } = chipReadout(profile, currentMode, status);
  return text ? `${profile.label} · ${text} ▾` : `${profile.label} ▾`;
}

// What the chip shows after the profile name. A profile whose keymap code is
// still on its way (or failed to arrive) is not in force — the editor is on
// its base keys — so the chip says that instead of a mode it is not in.
// `status` is the keymap's load status (see editor/lazy-keymaps.js).
//
// Returns { state, text, title }: `state` is "ready" | "loading" | "failed",
// `text` the short readout (null for none), `title` a sentence for the
// tooltip and screen readers (null when there is nothing to explain).
export function chipReadout(profile, currentMode, status = "ready") {
  if (status === "failed") {
    return {
      state: "failed",
      text: "RETRY",
      title: `The ${profile.label} keymap didn't load, so the editor is on its default keys. Click to try again.`,
    };
  }
  if (status !== "ready") {
    return {
      state: "loading",
      text: "LOADING",
      title: `Loading the ${profile.label} keymap. The editor is on its default keys until it arrives.`,
    };
  }
  if (!profile.isModal) return { state: "ready", text: null, title: null };
  const text = currentMode ? String(currentMode).toUpperCase() : profile.modes[0];
  return { state: "ready", text, title: null };
}

// Where to put a floating hint so it sits just above `anchor` without ever
// overlapping it or leaving the viewport: left-aligned with the anchor, slid
// back in from the right edge when it would overflow. All arguments are
// plain rect-like objects so this stays testable without a DOM.
export function placeAbove({ anchor, size, viewport, margin = 8 }) {
  const maxLeft = viewport.width - size.width - margin;
  const left = Math.max(margin, Math.min(anchor.left, maxLeft));
  const top = Math.max(margin, anchor.top - size.height - margin);
  return { left, top };
}

// What the hint is placed above: Play's left edge, and the top of the whole
// transport. On a phone the transport wraps to two rows, and a card resting
// on Play's own row would cover the controls beside and above it.
export function hintAnchor(play, transport) {
  return {
    left: play.left,
    top: transport ? Math.min(play.top, transport.top) : play.top,
  };
}
