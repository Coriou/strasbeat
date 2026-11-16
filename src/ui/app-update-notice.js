// The "a new version is ready" card.
//
// Shown by src/app-update.js when a new build has been downloaded and is
// waiting. It borrows the drum-kit card's look and manners
// (src/ui/drum-kit-nudge.js): it floats above the transport, never takes
// focus, never blocks typing or playback, is announced politely, and Escape
// closes it while focus is inside. If that card is up, this one waits behind
// it rather than stacking a second notice over the editor.
//
// Dismissing it changes nothing: the new version stays waiting and takes
// over the next time the app is opened.

import { makeIcon } from "./icons.js";
import { placeAbove, hintAnchor } from "./keymap-chip-format.js";

/**
 * @param {() => void} apply  the user asked for the update now
 * @returns {(() => void) | undefined} closes the card
 */
export function mountUpdateNotice(apply) {
  const play = document.getElementById("play");
  const transport = play?.closest(".transport");
  if (!transport) return;
  const card = document.createElement("section");
  card.className = "kit-nudge app-update-notice";
  card.setAttribute("aria-label", "App update");
  const message = document.createElement("div");
  message.className = "kit-nudge__message";
  message.setAttribute("role", "status");
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "kit-nudge__close";
  dismiss.setAttribute("aria-label", "Dismiss update notice");
  dismiss.append(makeIcon("x", { size: 12 }));
  const actions = document.createElement("div");
  actions.className = "kit-nudge__actions";
  const update = document.createElement("button");
  update.type = "button";
  update.className = "kit-nudge__btn kit-nudge__btn--switch";
  update.textContent = "Reload to update";
  actions.append(update);
  card.append(message, dismiss, actions);
  let closed = false;
  function place() {
    if (closed) return;
    // Queue behind the one-time kit card, rather
    // than stacking notices over the editor on a small screen.
    const blocked = document.querySelector(
      ".kit-nudge:not(.app-update-notice)",
    );
    card.style.display = blocked ? "none" : "grid";
    const box = card.getBoundingClientRect();
    const { left, top } = placeAbove({
      anchor: hintAnchor(
        play.getBoundingClientRect(),
        transport.getBoundingClientRect(),
      ),
      size: { width: box.width, height: box.height },
      viewport: { width: innerWidth, height: innerHeight },
    });
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }
  function close() {
    if (closed) return;
    const focused = card.contains(document.activeElement);
    closed = true;
    resize.disconnect();
    changes.disconnect();
    window.removeEventListener("resize", place);
    card.remove();
    if (focused) play.focus({ preventScroll: true });
  }
  dismiss.addEventListener("click", close);
  update.addEventListener("click", () => {
    // Applying takes a moment (the new worker activates, then the page
    // reloads); say so, and take the second click away.
    update.disabled = true;
    update.textContent = "Updating…";
    apply();
  });
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.stopPropagation();
    close();
  });
  const resize = new ResizeObserver(place);
  resize.observe(transport);
  resize.observe(card);
  const changes = new MutationObserver(place);
  changes.observe(transport.parentElement, { childList: true });
  window.addEventListener("resize", place);
  transport.after(card);
  place();
  requestAnimationFrame(() => {
    message.textContent = "A new version of strasbeat is ready.";
    place();
  });
  return close;
}
