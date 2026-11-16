// DOM track bar: a persistent strip between the transport and the piano roll
// that shows per-track labels with click-to-mute and shift+click-to-solo.
//
// Mounted once from main.js after the editor is fully set up:
//
//   mountTrackBar({ container, view, docSync, onEvaluate, isPlaying })
//
// The strip auto-hides (via container.hidden) when the pattern has no named
// labels, causing the auto-sized grid row to collapse to 0 height. It
// reappears as soon as labels are detected on the next doc change.
//
// Palette color assignment uses the label's index in source order
// (PALETTE[i % PALETTE.length]). The piano roll derives its color the same
// way, from parseLabels of the evaluated code — `PALETTE[labels.indexOf(label)
// % PALETTE.length]` in piano-roll.js's hapInfo — so the two agree by
// construction, not by coincidence. colorForKey's insertion-order Map is only
// the piano roll's fallback for haps it cannot attribute to a label at all.

import { parseLabels, toggleMute, toggleSolo } from "../editor/track-labels.js";
import { diffChanges } from "../editor/text-diff.js";
import { PALETTE } from "./palette.js";

/**
 * Everything a track entry renders, as one comparable string. Source offsets
 * are deliberately not part of it: they move with every edit above the
 * track without changing how the entry looks or what its click does.
 */
export function entrySignature(label) {
  return [
    label.displayName,
    label.muted ? 1 : 0,
    label.soloed ? 1 : 0,
    label.soloSuppressed ? 1 : 0,
    label.duplicate ? 1 : 0,
  ].join("\u0001");
}

export function mountTrackBar({
  container,
  view,
  docSync,
  onEvaluate,
  isPlaying = () => true,
}) {
  // rebuild() runs on every doc change, so the duplicate-name warning is
  // deduped by the offending set — otherwise a single bad file would spam the
  // console once per keystroke. Reset when the names stop colliding.
  let warnedDuplicates = "";

  // The entries container once built, and one signature per rendered entry
  // (same order as its children).
  let entriesEl = null;
  let signatures = [];

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

    if (labels.length === 0) {
      // Nothing to show, and usually nothing was showing: don't touch the DOM.
      if (entriesEl) {
        while (container.firstChild) container.removeChild(container.firstChild);
        entriesEl = null;
        signatures = [];
      }
      if (!container.hidden) container.hidden = true;
      return;
    }

    if (container.hidden) container.hidden = false;

    if (!entriesEl) {
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

      entriesEl = document.createElement("div");
      entriesEl.className = "track-bar__entries";
      container.appendChild(entriesEl);
    }
    const entries = entriesEl;

    // Most edits leave every track as it was. An entry is rebuilt only when
    // something it shows changed; its colour follows its position, and its
    // click handler looks the track up by name, so neither needs more.
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const signature = entrySignature(label);
      if (signatures[i] === signature) continue;
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
        const toggle = e.shiftKey ? toggleSolo : toggleMute;
        const userEvent = e.shiftKey ? "input.track-solo" : "input.track-mute";
        const nextCode = toggle(currentCode, displayName);
        if (nextCode === currentCode) return;
        try {
          // Minimal changes (same as the Cmd+M path in keymap.js) so the
          // cursor and every mapped decoration outside the edit stay put.
          view.dispatch({
            changes: diffChanges(currentCode, nextCode),
            userEvent,
          });
          view.focus?.();
          // Re-evaluate so the change is audible — but only while the
          // transport is running. Muting a track before pressing play edits
          // the code and must not start playback by itself (same rule as
          // the beat grid); the next play picks the change up.
          if (isPlaying()) onEvaluate?.();
        } catch (err) {
          console.warn("[strasbeat/track-bar] toggle failed:", err);
        }
      });

      const prev = entries.children[i];
      if (prev) entries.replaceChild(btn, prev);
      else entries.appendChild(btn);
      signatures[i] = signature;
    }
    while (entries.children.length > labels.length) entries.lastChild.remove();
    signatures.length = labels.length;
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
