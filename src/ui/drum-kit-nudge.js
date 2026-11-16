// The one-time "which kit do the bare drum names play?" card.
//
// Shown by the drum-kit controller (src/drum-kit.js) the first time a
// pattern that leans on the default kit is actually playing. It is a quiet
// card floating above the transport, in the spot the first-run hint uses
// (that one is gone by then: it leaves when playback first starts). It never
// takes focus and never blocks typing; it is announced politely, both
// actions are plain buttons in the tab order right after the transport, and
// Escape closes it while focus is inside.
//
// The card only reports what was picked. Applying and remembering the
// choice — and remembering that the card has been shown — is the
// controller's job.

import { makeIcon } from "./icons.js";
import { placeAbove, hintAnchor } from "./keymap-chip-format.js";

/**
 * @param {object} deps
 * @param {(kit: "classic" | "strudel") => void} deps.onChoose
 * @param {() => void} [deps.onDismiss]  closed without choosing
 * @returns {{ show(): void, close(): void, isOpen(): boolean }}
 */
export function mountDrumKitNudge({ onChoose, onDismiss = () => {} }) {
  let card = null;
  let teardown = null;

  function show() {
    if (card) return;
    const playBtn = document.getElementById("play");
    const transportEl = playBtn?.closest(".transport");
    if (!playBtn || !transportEl) return;

    card = document.createElement("section");
    card.className = "kit-nudge";
    card.setAttribute("aria-labelledby", "kit-nudge-title");

    // The live region is in the page before its text is, so the text is
    // announced as a change rather than missed as initial content.
    const message = document.createElement("div");
    message.className = "kit-nudge__message";
    message.setAttribute("role", "status");
    card.appendChild(message);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "kit-nudge__close";
    closeBtn.setAttribute("aria-label", "Dismiss");
    closeBtn.appendChild(makeIcon("x", { size: 12 }));
    card.appendChild(closeBtn);

    const actions = document.createElement("div");
    actions.className = "kit-nudge__actions";
    const switchBtn = button("Switch to the strudel.cc kit", "kit-nudge__btn kit-nudge__btn--switch");
    const keepBtn = button("Keep classic", "kit-nudge__btn");
    actions.append(switchBtn, keepBtn);
    card.appendChild(actions);

    // Right after the transport in the document, so Tab reaches it from the
    // controls it sits above. (It is positioned against the viewport.)
    transportEl.after(card);

    const fill = () => {
      if (!card) return;
      const title = document.createElement("p");
      title.id = "kit-nudge-title";
      title.className = "kit-nudge__title";
      title.textContent = "These drums are the classic Dirt kit";
      const note = document.createElement("p");
      note.className = "kit-nudge__note";
      note.append(
        "On strudel.cc, ",
        code("bd"),
        ", ",
        code("sd"),
        ", ",
        code("hh"),
        " and the other short drum names play a different kit, so a pattern pasted from there sounds different here. You can change this any time in Settings.",
      );
      message.append(title, note);
      place();
    };

    function place() {
      if (!card) return;
      const box = card.getBoundingClientRect();
      const { left, top } = placeAbove({
        anchor: hintAnchor(
          playBtn.getBoundingClientRect(),
          transportEl.getBoundingClientRect(),
        ),
        size: { width: box.width, height: box.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    }

    // The transport moves when the panes around it change size; the card's
    // own box changes when its text arrives or wraps.
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    for (const target of [transportEl, document.querySelector(".editor-pane"), card]) {
      if (target) observer?.observe(target);
    }
    window.addEventListener("resize", place);

    const finish = (after) => {
      // Closed from the keyboard: the focused button is about to go, so
      // hand focus to the control the card sits above.
      const hadFocus = card?.contains(document.activeElement);
      close();
      if (hadFocus) playBtn.focus({ preventScroll: true });
      after();
    };
    switchBtn.addEventListener("click", () => finish(() => onChoose("strudel")));
    keepBtn.addEventListener("click", () => finish(() => onChoose("classic")));
    closeBtn.addEventListener("click", () => finish(onDismiss));
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      finish(onDismiss);
    });

    teardown = () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };

    place();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fill);
    else fill();
  }

  function close() {
    if (!card) return;
    teardown?.();
    teardown = null;
    card.remove();
    card = null;
  }

  return { show, close, isOpen: () => card != null };
}

function button(label, className) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  return el;
}

function code(text) {
  const el = document.createElement("code");
  el.className = "kit-nudge__code";
  el.textContent = text;
  return el;
}
