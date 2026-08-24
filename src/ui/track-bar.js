// DOM track bar: a persistent strip between the transport and the piano roll
// that shows per-track labels with click-to-mute and shift+click-to-solo.
//
// Mounted once from main.js after the editor is fully set up:
//
//   mountTrackBar({ container, view, onEvaluate })
//
// The strip auto-hides (via container.hidden) when the pattern has no named
// labels, causing the auto-sized grid row to collapse to 0 height. It
// reappears as soon as labels are detected on the next doc change.
//
// Palette color assignment uses the label's index in source order
// (PALETTE[i % 10]), which matches the insertion-order behavior of the piano
// roll's colorForKey Map when labels are not reordered mid-session.

import { parseLabels, toggleMute, toggleSolo } from "../editor/track-labels.js";
import { computeNewSelection } from "../editor/format.js";
import { PALETTE } from "./palette.js";

export function mountTrackBar({ container, view, docSync, onEvaluate }) {
  // rebuild() runs on every doc change, so the duplicate-name warning is
  // deduped by the offending set — otherwise a single bad file would spam the
  // console once per keystroke. Reset when the names stop colliding.
  let warnedDuplicates = "";

  function rebuild() {
    const code = view.state.doc.toString();
    const labels = parseLabels(code);

    const duplicates = [...new Set(labels.filter((l) => l.duplicate).map((l) => l.displayName))];
    const dupKey = duplicates.join(",");
    if (dupKey !== warnedDuplicates) {
      warnedDuplicates = dupKey;
      if (duplicates.length) {
        console.warn(
          `[strasbeat/track-bar] duplicate track ${duplicates.length > 1 ? "names" : "name"} ${duplicates
            .map((n) => `"${n}"`)
            .join(", ")}: Strudel keeps only the last block with a given label, so the earlier one never plays and its mute/solo button does nothing. Rename one of them.`,
        );
      }
    }

    // Clear previous children without innerHTML to avoid unnecessary reflow.
    while (container.firstChild) container.removeChild(container.firstChild);

    if (labels.length === 0) {
      container.hidden = true;
      return;
    }

    container.hidden = false;

    const meta = document.createElement("div");
    meta.className = "track-bar__meta";

    const title = document.createElement("span");
    title.className = "track-bar__title";
    title.textContent = "Tracks";

    const hint = document.createElement("span");
    hint.className = "track-bar__hint";
    hint.textContent = "Click to mute · Shift\u2011click to solo";

    meta.append(title, hint);
    container.appendChild(meta);

    const entries = document.createElement("div");
    entries.className = "track-bar__entries";
    container.appendChild(entries);

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const color = PALETTE[i % PALETTE.length];
      const displayName = label.displayName;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "track-bar__entry";
      if (label.muted) btn.classList.add("track-bar__entry--muted");
      if (label.soloed) btn.classList.add("track-bar__entry--soloed");
      // No toggle can write `S<name>_` any more, but a hand-edited file can
      // still contain it. Say what Strudel actually does with it rather than
      // reporting a state it will not honour (design/work/27 BUG-1).
      // Duplicate names are a broken file, not a state: Strudel keeps only the
      // last block with a given id and the toggles target the first, so the
      // button is an audible no-op. Say so rather than looking functional.
      const dupText = label.duplicate
        ? " · duplicate name — only the last block plays, so this button does nothing"
        : "";
      const stateText = label.soloSuppressed
        ? "Muted — the S prefix is ignored while muted"
        : label.muted
          ? "Muted"
          : label.soloed
            ? "Soloed"
            : "Active";
      if (label.duplicate) btn.classList.add("track-bar__entry--duplicate");
      btn.title = `${displayName} · ${stateText}${dupText} · Click mute · Shift-click solo`;
      btn.setAttribute(
        "aria-label",
        `${displayName}. ${stateText}.${dupText ? ` Warning: ${dupText.slice(3)}.` : ""} Click toggles mute. Shift-click toggles solo.`,
      );

      const dot = document.createElement("span");
      dot.className = "track-bar__dot";
      dot.style.backgroundColor = color;
      dot.setAttribute("aria-hidden", "true");

      const labelEl = document.createElement("span");
      labelEl.className = "track-bar__label";
      labelEl.textContent = displayName;

      const states = document.createElement("span");
      states.className = "track-bar__states";
      if (label.muted) {
        const mutedTag = document.createElement("span");
        mutedTag.className = "track-bar__state track-bar__state--muted";
        mutedTag.textContent = "M";
        mutedTag.setAttribute("aria-hidden", "true");
        states.appendChild(mutedTag);
      }
      if (label.soloed) {
        const soloTag = document.createElement("span");
        soloTag.className = "track-bar__state track-bar__state--soloed";
        soloTag.textContent = "S";
        soloTag.setAttribute("aria-hidden", "true");
        states.appendChild(soloTag);
      }

      btn.appendChild(dot);
      btn.appendChild(labelEl);
      if (states.childElementCount > 0) btn.appendChild(states);

      btn.addEventListener("click", (e) => {
        const currentCode = view.state.doc.toString();
        const oldSelection = view.state.selection;
        const oldDoc = view.state.doc;
        const toggle = e.shiftKey ? toggleSolo : toggleMute;
        const userEvent = e.shiftKey ? "input.track-solo" : "input.track-mute";
        const nextCode = toggle(currentCode, displayName);
        if (nextCode === currentCode) return;
        try {
          view.dispatch({
            changes: { from: 0, to: currentCode.length, insert: nextCode },
            selection: computeNewSelection(oldSelection, oldDoc, nextCode),
            userEvent,
          });
          view.focus?.();
          onEvaluate?.();
        } catch (err) {
          console.warn("[strasbeat/track-bar] toggle failed:", err);
        }
      });

      entries.appendChild(btn);
    }
  }

  // Initial render from whatever is already in the editor.
  rebuild();

  // Re-render whenever the doc changes: mute/solo toggles, pattern loads, edits.
  // Debounced to the next animation frame so rapid keystrokes batch into one rebuild.
  let rebuildScheduled = false;
  function scheduleRebuild() {
    if (rebuildScheduled) return;
    rebuildScheduled = true;
    requestAnimationFrame(() => {
      rebuildScheduled = false;
      rebuild();
    });
  }

  // Re-render on every doc change and on every tab swap. docSync owns the
  // signal for all three bottom bars — see src/editor/doc-sync.js for why this
  // is NOT a StateEffect.appendConfig listener of our own.
  docSync.subscribe(({ immediate }) => {
    if (immediate) rebuild();
    else scheduleRebuild();
  });
}
