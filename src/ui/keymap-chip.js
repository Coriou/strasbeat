// Transport-bar keymap chip. Shows the active profile and (for modal
// profiles) the current Vim/Helix mode. Click → opens profile picker popover.
// Mounted next to the MIDI pill.
//
// Also owns the transport's first-run hint. It used to advertise this chip;
// a newcomer's first question is "how do I hear something", so it now points
// at Play (see showFirstRunHint).
//
// See design/work/21-keybindings.md §"Keymap chip + popover".
//
// Vim mode subscription uses @replit/codemirror-vim's getCM() + cm.on().
// getCM(view) returns the CM5-compat adapter stored at view.cm; that adapter
// fires "vim-mode-change" events with { mode, subMode } whenever the Vim mode
// flips. This is the same channel the built-in status panel uses (line ~8425
// of @replit/codemirror-vim/dist/index.js).
//
// Helix: Strudel's keybindings.mjs has no helix entry — the profile is
// aspirational. There is no vim-like adapter for it, so the subscription
// attempt returns null and the mode stays at "NORMAL" (first entry in
// profile.modes). That is the correct safe default.

import {
  KEYMAP_PROFILES,
  getProfile,
  getStoredProfileId,
  hasSeenTooltip,
  markTooltipSeen,
} from "../editor/keymap-profiles.js";
import { applyKeymapProfile, subscribeKeymapChange } from "../editor/keymap-apply.js";
import {
  keymapStatus,
  loadKeymap,
  onKeymapStatus,
} from "../editor/lazy-keymaps.js";
import {
  chipReadout,
  formatChipLabel,
  hintAnchor,
  placeAbove,
} from "./keymap-chip-format.js";
import { NARROW_QUERY } from "./responsive.js";
import { formatShortcut, localizeShortcuts } from "./shortcut-format.js";
import { makeIcon } from "./icons.js";

// The command palette lists every command with its shortcut, but nothing
// said how to open it. The keymap chip is the chrome's "keyboard" corner, so
// its tooltip and popover carry the pointer.
const PALETTE_CHORD = "Mod+Shift+P";

export { formatChipLabel };

// Subscribes to Vim mode changes via the @replit/codemirror-vim CM5-compat
// adapter. Returns a teardown function.
//
// @replit/codemirror-vim's ViewPlugin stores the adapter at `view.cm`
// (source: @replit/codemirror-vim/dist/index.js line 8415). The adapter
// fires "vim-mode-change" events and exposes cm.on() / cm.off() for
// subscribe/unsubscribe. We read view.cm directly to avoid adding a static
// import of @replit/codemirror-vim (which is a transitive dep, not in
// package.json, so Rollup can't resolve it in production builds).
//
// If view.cm is not yet set (vim plugin initialises asynchronously on
// first render), we retry once after 50 ms. If still null (helix profile
// or non-vim context), we give up silently — the mode label stays at the
// profile's first entry ("NORMAL").
function subscribeVimMode(view, listener) {
  let cm = null;
  let torn = false;

  function handler(e) {
    if (torn) return;
    const mode = (e.mode ?? "normal").toUpperCase();
    listener(mode);
  }

  function attach(adapter) {
    if (torn) return;
    cm = adapter;
    cm.on("vim-mode-change", handler);
    // Prime with the current mode if already known (e.g. reload with vim active).
    const primeMode = adapter.state?.vim?.mode;
    if (primeMode) listener(primeMode.toUpperCase());
  }

  function tryAttach() {
    if (torn) return;
    // view.cm is set by the vim ViewPlugin constructor (same frame as
    // applyKeymapProfile in practice, but a retry handles the edge case).
    const adapter = view.cm ?? null;
    if (adapter) {
      attach(adapter);
    } else {
      setTimeout(() => {
        if (torn) return;
        const adapter2 = view.cm ?? null;
        if (adapter2) attach(adapter2);
        // If still null (e.g. helix profile), silently give up.
      }, 50);
    }
  }

  tryAttach();

  return () => {
    torn = true;
    if (cm) {
      cm.off("vim-mode-change", handler);
      cm = null;
    }
  };
}

// Mounts the chip element into `container`. Returns an API object the
// caller can use later — we expose `el`, a `setMode(mode)` setter for
// modal profiles, and `destroy()` for teardown.
export function mountKeymapChip({ container, editor, onEvaluate }) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "transport__pill keymap-chip";
  el.id = "keymap-chip";
  el.setAttribute("aria-haspopup", "menu");
  el.setAttribute("aria-expanded", "false");
  let currentMode = null;
  let popover = null;
  let modeUnsub = null;
  let tooltip = null;
  let dismissTooltip = null;

  // Persistent children — built once so mode flips don't tear down nodes.
  // Layout: [label] [sep · mode]? [chevron]
  const labelEl = document.createElement("span");
  labelEl.className = "keymap-chip__label";
  const modeWrap = document.createElement("span");
  modeWrap.className = "keymap-chip__mode";
  modeWrap.setAttribute("aria-hidden", "true");
  const modeEl = document.createElement("span");
  modeEl.className = "keymap-chip__mode-text";
  modeWrap.appendChild(modeEl);
  const chevron = makeIcon("chevron-down");
  chevron.classList.add("keymap-chip__chevron");
  el.appendChild(labelEl);
  el.appendChild(modeWrap);
  el.appendChild(chevron);

  // The Vim and Emacs keymaps are fetched on first use. Until the code is in
  // (and for good if the fetch failed) the editor is on its base keys, and
  // the chip says so instead of showing the profile as active.
  const loadStatus = (profile) => keymapStatus(profile.strudelKeybindings);
  // "Loading" must mean a fetch is under way. Applying a profile starts one;
  // this covers a profile that is stored but was never applied.
  function requestKeymap(profile) {
    if (loadStatus(profile) === "idle") loadKeymap(profile.strudelKeybindings);
  }

  function render() {
    const profile = getProfile(getStoredProfileId());
    const status = loadStatus(profile);
    const readout = chipReadout(profile, currentMode, status);
    labelEl.textContent = profile.label;
    modeWrap.dataset.shown = readout.text ? "1" : "0";
    modeEl.textContent = readout.text ?? "";
    // Accessible label for screen readers — full string form, including the
    // dropdown affordance, so screen readers announce e.g. "Vim · NORMAL,
    // keymap profile picker, menu".
    el.setAttribute(
      "aria-label",
      readout.title
        ? `${profile.label}, keymap profile. ${readout.title}`
        : `${formatChipLabel(profile, currentMode, status).replace(/\s*▾\s*$/, "")}, keymap profile`,
    );
    el.title =
      readout.title ??
      `Editor keymap: ${profile.label}  ·  All commands: ${formatShortcut(PALETTE_CHORD)}`;
    el.dataset.profile = profile.id;
    el.dataset.modal = profile.isModal ? "1" : "0";
    el.dataset.keymapState = readout.state;
  }

  // Attach or detach the mode subscription when the active profile changes.
  // If entering a modal profile, wire up the vim-mode-change listener and
  // prime currentMode to the profile's first mode label (e.g. "NORMAL").
  // If leaving, tear down and clear the mode so the chip label reverts to
  // plain "VSCode ▾" etc.
  function attachModeSubscription(profile) {
    if (modeUnsub) {
      modeUnsub();
      modeUnsub = null;
    }
    // A modal keymap that has not loaded has no mode to report.
    if (!profile.isModal || loadStatus(profile) !== "ready") {
      currentMode = null;
      return;
    }
    // Prime with the initial mode before the first event fires.
    currentMode = profile.modes[0];
    modeUnsub = subscribeVimMode(editor.editor, (mode) => {
      currentMode = mode;
      render();
    });
  }

  // Re-render when the profile changes (chip popover or settings dropdown).
  const unsubscribe = subscribeKeymapChange((profile) => {
    requestKeymap(profile);
    attachModeSubscription(profile);
    render();
    closePopover();
  });

  // The active profile's keymap started loading, arrived or failed.
  const unsubscribeStatus = onKeymapStatus((name) => {
    const profile = getProfile(getStoredProfileId());
    if (profile.strudelKeybindings !== name) return;
    attachModeSubscription(profile);
    render();
  });

  function setMode(mode) {
    currentMode = mode;
    render();
  }

  function openPopover() {
    if (popover) return;
    popover = renderPopover({
      anchor: el,
      activeId: getStoredProfileId(),
      onPick: (profileId) => {
        applyKeymapProfile(editor, profileId, { onEvaluate });
        closePopover();
      },
      onDismiss: closePopover,
    });
    el.setAttribute("aria-expanded", "true");
  }

  function closePopover() {
    if (!popover) return;
    popover.destroy();
    popover = null;
    el.setAttribute("aria-expanded", "false");
    el.focus();
  }

  el.addEventListener("click", () => {
    // A keymap that failed to load is fetched again; the picker still opens
    // so another profile can be chosen while that is not possible.
    const profile = getProfile(getStoredProfileId());
    const status = loadStatus(profile);
    if (status === "failed" || status === "idle") {
      loadKeymap(profile.strudelKeybindings);
    }
    if (popover) closePopover();
    else openPopover();
  });

  // Handle reload: if the stored profile is already modal (e.g. user had
  // vim active last session), prime the subscription immediately so the chip
  // shows "Vim · NORMAL ▾" on first paint instead of just "Vim ▾".
  const initialProfile = getProfile(getStoredProfileId());
  requestKeymap(initialProfile);
  if (initialProfile.isModal) {
    attachModeSubscription(initialProfile);
  }

  // First-run hint. One card, anchored above Play: it names the first thing
  // to do and why a click is needed at all (browsers keep audio off until
  // one). It never sits on a control — it floats over the canvas, above the
  // whole transport (which wraps to two rows on a phone) — and it stays
  // until the user closes it or playback first starts, rather than vanishing
  // on the first stray keypress. The transport moves whenever something
  // below or beside it changes size (the roll, the track bar, a rail), so
  // the card follows the layout rather than the window; and it steps aside
  // while a floating rail or a dialog has the screen.
  function showFirstRunHint() {
    if (hasSeenTooltip()) return;
    const playBtn = document.getElementById("play");
    if (!playBtn) return;
    const transportEl = playBtn.closest(".transport");

    tooltip = document.createElement("div");
    tooltip.className = "transport__hint";
    tooltip.setAttribute("role", "status");

    const text = document.createElement("span");
    text.className = "transport__hint-text";
    text.textContent = "Press Play to hear this pattern.";
    const note = document.createElement("span");
    note.className = "transport__hint-note";
    note.textContent = `Browsers stay silent until your first click, so start there. From the editor: ${formatShortcut("Mod+Enter")}.`;
    text.appendChild(note);
    tooltip.appendChild(text);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "transport__hint-close";
    closeBtn.setAttribute("aria-label", "Dismiss hint");
    closeBtn.appendChild(makeIcon("x", { size: 12 }));
    tooltip.appendChild(closeBtn);
    document.body.appendChild(tooltip);

    function place() {
      if (!tooltip || tooltip.hidden) return;
      const tip = tooltip.getBoundingClientRect();
      const { left, top } = placeAbove({
        anchor: hintAnchor(
          playBtn.getBoundingClientRect(),
          transportEl?.getBoundingClientRect(),
        ),
        size: { width: tip.width, height: tip.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    }

    // The editor pane takes whatever height the rows below it leave, so its
    // box changes exactly when the transport is pushed up or down; the
    // transport's own box changes when it wraps; the card's when its text
    // does.
    const layoutObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    for (const target of [
      transportEl,
      document.querySelector(".editor-pane"),
      tooltip,
    ]) {
      if (target) layoutObserver?.observe(target);
    }

    // A rail floating over the editor (narrow layouts) or a dialog covers
    // the spot the card sits in.
    const rails = [...document.querySelectorAll(".shell > .left-rail, .shell > .right-rail")];
    const narrow =
      typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
    function syncCovered() {
      if (!tooltip) return;
      const covered =
        document.querySelector(".modal-overlay, .palette-overlay") != null ||
        (narrow?.matches === true &&
          rails.some((rail) => rail.dataset.collapsed === "false"));
      if (tooltip.hidden === covered) return;
      tooltip.hidden = covered;
      place();
    }
    const coverObserver = new MutationObserver(syncCovered);
    for (const rail of rails) {
      coverObserver.observe(rail, {
        attributes: true,
        attributeFilter: ["data-collapsed"],
      });
    }
    // Dialogs and the command palette are appended to (and removed from)
    // the body.
    coverObserver.observe(document.body, { childList: true });
    narrow?.addEventListener?.("change", syncCovered);

    // Playback starting by any route (the button, the editor shortcut, a
    // Learn-panel example) means the hint has done its job.
    const stateObserver = transportEl
      ? new MutationObserver(() => {
          if (transportEl.dataset.transportState !== "idle") dismiss();
        })
      : null;

    // `remember: false` is teardown, not the user being done with it.
    function dismiss({ remember = true } = {}) {
      if (!tooltip) return;
      if (remember) markTooltipSeen();
      tooltip.remove();
      tooltip = null;
      stateObserver?.disconnect();
      layoutObserver?.disconnect();
      coverObserver.disconnect();
      narrow?.removeEventListener?.("change", syncCovered);
      window.removeEventListener("resize", place);
    }
    dismissTooltip = dismiss;

    closeBtn.addEventListener("click", () => dismiss());
    stateObserver?.observe(transportEl, {
      attributes: true,
      attributeFilter: ["data-transport-state"],
    });
    window.addEventListener("resize", place);
    syncCovered();
    // We can't measure until the card is laid out; one frame is enough.
    requestAnimationFrame(place);
  }

  render();
  container.appendChild(el);
  showFirstRunHint();

  return {
    el,
    setMode,
    destroy: () => {
      dismissTooltip?.({ remember: false });
      if (modeUnsub) {
        modeUnsub();
        modeUnsub = null;
      }
      closePopover();
      unsubscribe();
      unsubscribeStatus();
      el.remove();
    },
  };
}

// Private helper — NOT exported. Renders the profile picker popover,
// positions it above the anchor chip, wires keyboard nav + click-outside,
// and returns a { destroy } handle for teardown.
function renderPopover({ anchor, activeId, onPick, onDismiss }) {
  const popover = document.createElement("div");
  popover.className = "keymap-popover";
  popover.setAttribute("role", "menu");

  const rows = KEYMAP_PROFILES.map((profile) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "keymap-popover__row";
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", profile.id === activeId ? "true" : "false");
    row.dataset.profileId = profile.id;
    if (profile.id === activeId) row.classList.add("keymap-popover__row--active");

    const check = document.createElement("span");
    check.className = "keymap-popover__check";
    check.setAttribute("aria-hidden", "true");
    if (profile.id === activeId) {
      const checkIcon = makeIcon("check");
      check.appendChild(checkIcon);
    }
    row.appendChild(check);

    const body = document.createElement("span");
    body.className = "keymap-popover__body";
    const name = document.createElement("span");
    name.className = "keymap-popover__name";
    name.textContent = profile.label;
    const desc = document.createElement("span");
    desc.className = "keymap-popover__desc";
    desc.textContent = localizeShortcuts(profile.description);
    body.appendChild(name);
    body.appendChild(desc);
    row.appendChild(body);

    if (profile.isDefault) {
      const tag = document.createElement("span");
      tag.className = "keymap-popover__tag";
      tag.textContent = "default";
      row.appendChild(tag);
    }

    row.addEventListener("click", () => onPick(profile.id));
    popover.appendChild(row);
    return row;
  });

  // Where the rest of the shortcuts are. A caption, not a menu item — the
  // chip's tooltip says the same to assistive tech.
  const footer = document.createElement("div");
  footer.className = "keymap-popover__footer";
  footer.setAttribute("aria-hidden", "true");
  const footerLabel = document.createElement("span");
  footerLabel.textContent = "All commands and shortcuts";
  const footerKbd = document.createElement("span");
  footerKbd.className = "keymap-popover__tag";
  footerKbd.textContent = formatShortcut(PALETTE_CHORD);
  footer.appendChild(footerLabel);
  footer.appendChild(footerKbd);
  popover.appendChild(footer);

  // Position above the chip (transport bar is at the bottom of the shell).
  // Default to chip-left-aligned; if that would overflow the viewport on
  // the right, fall back to chip-right-aligned. The chip lives near the
  // right edge of the transport bar, so right-alignment is the common case.
  document.body.appendChild(popover);
  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 8;
  const overflowRight = rect.left + popRect.width > window.innerWidth - margin;
  const left = overflowRight
    ? Math.max(margin, rect.right - popRect.width)
    : Math.max(margin, rect.left);
  popover.style.position = "fixed";
  popover.style.left = `${left}px`;
  popover.style.top = `${rect.top - popRect.height - margin}px`;

  // Initial focus on the active row (or first row if no row matched).
  const activeRow = rows.find((r) => r.dataset.profileId === activeId) ?? rows[0];
  activeRow.focus();

  function onKey(e) {
    if (e.key === "Escape" || e.key === "Tab") {
      // Tab would otherwise walk focus out from under an open menu.
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = (idx + delta + rows.length) % rows.length;
      rows[next].focus();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const focused = document.activeElement;
      if (focused?.dataset?.profileId) onPick(focused.dataset.profileId);
    }
  }

  function onClickOutside(e) {
    // (contains: the chip's label and chevron are children of the anchor)
    if (!popover.contains(e.target) && !anchor.contains(e.target)) onDismiss();
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onClickOutside, true);

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onClickOutside, true);
      popover.remove();
    },
  };
}
