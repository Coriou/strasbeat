// A right-rail panel whose module is fetched the first time it is needed.
//
// The rail wants a panel spec (`{ id, icon, label, create, activate,
// deactivate }`) at registration time, synchronously, so the tab strip can
// be drawn and the last session's tab restored; and the rest of the app
// holds on to panel handles and calls methods on them (`setBufferText` on
// every evaluate, `scrollTo` from a hover-docs deep link, `autoExport` from
// the WAV button). `createLazyPanel` returns an object that is both of those
// things from the first moment, backed by nothing, and becomes a thin
// pass-through to the real panel once its module has loaded:
//
//   - Opening the tab starts the load. Until it finishes the slot is empty
//     (a "Loading…" line appears only if it takes long enough to notice);
//     then the real panel is created into the same slot and activated.
//   - A method called before the real panel exists is remembered — the
//     latest call per method — and replayed when it does. So the panel
//     opens on the current buffer, and "open the reference at `lpf`" works
//     on first use.
//   - If the load fails the slot says so and offers a retry (reopening the
//     tab retries too). Remembered calls that were requests of the moment
//     — "export now", "scroll to `lpf`" — are forgotten with the failure:
//     replayed minutes later, when the panel finally opens for some other
//     reason, they would act on a wish the user no longer has. Calls that
//     carry standing state (the current buffer) are kept. Nothing else in
//     the app depends on the panel having loaded.
//   - `preload()` warms the module in the background without showing
//     anything on failure.

import { once } from "../lazy-import.js";

const PLACEHOLDER_DELAY_MS = 250;

/**
 * @param {object} def
 * @param {string} def.id     rail panel id — must match the real panel's
 * @param {string} def.icon   lucide icon name for the tab
 * @param {string} def.label  tab label
 * @param {(opts: { silent: boolean }) => Promise<object>} def.load
 *   resolves with the real panel spec (import the module, call its factory)
 * @param {string[]} [def.methods]  names of the real panel's public methods
 *   that callers use through this handle
 * @param {string[]} [def.stateMethods]  the ones among them whose latest
 *   call is still true however much later the panel loads; every other
 *   remembered call is dropped when a load fails
 * @param {number} [def.placeholderDelayMs]
 */
export function createLazyPanel({
  id,
  icon,
  label,
  load,
  methods = [],
  stateMethods = ["setBufferText", "refresh"],
  placeholderDelayMs = PLACEHOLDER_DELAY_MS,
}) {
  let real = null; // the loaded panel spec
  let slot = null; // the rail's container for this panel, once opened
  let mounted = false; // real.create(slot) has run
  let active = false; // the rail's visible tab
  let activateOpts;
  let placeholderTimer = null;
  /** method name → args of the latest call made before `real` existed */
  const queued = new Map();

  const loadOnce = once((opts) => load({ silent: Boolean(opts?.silent) }));

  function ensure(opts) {
    return loadOnce(opts).then(
      (panel) => {
        if (!real) {
          real = panel;
          adopt();
        }
        return real;
      },
      (err) => {
        for (const name of [...queued.keys()]) {
          if (!stateMethods.includes(name)) queued.delete(name);
        }
        throw err;
      },
    );
  }

  // The real panel has just become available.
  function adopt() {
    if (slot) mount({ deferred: true });
    for (const [name, args] of queued) {
      try {
        real[name]?.(...args);
      } catch (err) {
        console.warn(`[strasbeat/panels] ${id}.${name}() failed:`, err);
      }
    }
    queued.clear();
  }

  function mount({ deferred = false } = {}) {
    if (mounted || !real || !slot) return;
    clearTimeout(placeholderTimer);
    slot.replaceChildren();
    try {
      real.create(slot);
      mounted = true;
    } catch (err) {
      console.error(`[strasbeat/panels] panel "${id}" create() failed:`, err);
      showStatus(`The ${label} panel failed to open. See the browser console.`);
      return;
    }
    // When the module arrived after the tab was opened, the rail's own
    // activate() has already come and gone — run it now.
    if (deferred && active) {
      real.activate?.({
        ...activateOpts,
        focus: activateOpts?.focus !== false && focusIsStillOurs(),
      });
    }
  }

  // The user asked for this panel a moment ago; by the time its module is
  // in they may be typing in the editor. Only take focus if it is still
  // parked where the click left it (the rail) or nowhere.
  function focusIsStillOurs() {
    const doc = slot?.ownerDocument;
    const el = doc?.activeElement;
    if (!el || el === doc.body) return true;
    const rail = slot.closest?.(".right-rail");
    return Boolean(rail?.contains?.(el));
  }

  function showStatus(text, { retry = false } = {}) {
    if (!slot || mounted) return;
    const doc = slot.ownerDocument;
    if (!doc) return;
    const el = doc.createElement("p");
    el.className = "right-rail__panel-status";
    el.setAttribute("role", "status");
    // Same treatment as the panels' own empty states (`*-panel__empty`).
    el.style.cssText =
      "margin:0;padding:var(--space-5) var(--space-4);font-size:var(--text-xs);color:var(--text-dim);text-align:center";
    el.textContent = text;
    if (!retry) {
      slot.replaceChildren(el);
      return;
    }
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "btn btn--ghost";
    button.textContent = "Retry";
    button.addEventListener("click", () => request());
    const actions = doc.createElement("p");
    actions.style.cssText = "margin:0;text-align:center";
    actions.append(button);
    slot.replaceChildren(el, actions);
  }

  // Start (or join) a load on the user's behalf.
  function request() {
    if (real) return;
    clearTimeout(placeholderTimer);
    if (slot && !loadOnce.loaded()) {
      slot.replaceChildren();
      placeholderTimer = setTimeout(
        () => showStatus(`Loading ${label}…`),
        placeholderDelayMs,
      );
    }
    ensure().catch((err) => {
      clearTimeout(placeholderTimer);
      showStatus(String(err?.message ?? err), { retry: true });
    });
  }

  const panel = {
    id,
    icon,
    label,
    create(el) {
      slot = el;
      if (real) mount();
      else request();
    },
    activate(opts) {
      active = true;
      activateOpts = opts;
      if (mounted) real.activate?.(opts);
      else if (real) mount({ deferred: true });
      else request();
    },
    deactivate() {
      active = false;
      if (mounted) real.deactivate?.();
    },
    /** Fetch the module in the background; never shows an error. */
    preload() {
      return ensure({ silent: true }).then(
        () => true,
        () => false,
      );
    },
    isLoaded: () => real != null,
  };

  for (const name of methods) {
    panel[name] = (...args) => {
      if (real) return real[name](...args);
      // Keep the most recent call last so replay order follows call order.
      queued.delete(name);
      queued.set(name, args);
      return undefined;
    };
  }

  return panel;
}
