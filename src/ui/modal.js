/*
 * Modal prompt — replaces window.prompt() with an in-app surface that
 * inherits the design-system tokens. See design/SYSTEM.md §2.7 (no native
 * dialogs), §5–§8 (surfaces, elevation, radii) and §9 (motion).
 *
 * Usage:
 *
 *   import { prompt } from './ui/modal.js';
 *
 *   const name = await prompt({
 *     title: 'New pattern name',
 *     placeholder: 'untitled',
 *     defaultValue: 'untitled-1234',
 *     validate: (value) => /^[a-z0-9_-]+$/i.test(value)
 *       ? null
 *       : 'use only letters, numbers, - and _',
 *   });
 *   if (name == null) return; // user dismissed
 *
 * Returns a Promise<string | null>:
 *   - resolves to the entered value when the user confirms
 *   - resolves to null on Escape, click-outside, or cancel button
 *
 * Validation:
 *   - validate?(value) returns a string error message to block confirm,
 *     or null/undefined to allow it. Errors render under the input.
 *   - Empty input is treated as null (cancel) — same as window.prompt.
 *
 * Focus is trapped inside the modal while open. Only one modal may be open
 * at a time; opening a second one rejects the first.
 */

let active = null; // { resolve, root, prevFocus, cleanup }

/**
 * Open a modal prompt. Resolves to the entered string, or null if cancelled.
 * @param {{
 *   title: string,
 *   placeholder?: string,
 *   defaultValue?: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   validate?: (value: string) => string | null | undefined,
 * }} opts
 * @returns {Promise<string | null>}
 */
export function prompt(opts) {
  // Closing any previous instance keeps the API simple — callers don't have
  // to worry about a stale modal hanging around. The previous resolver is
  // settled with null so any awaiting `await prompt(...)` unblocks.
  if (active) closeActive(null);

  return new Promise((resolve) => {
    const root = buildModal(opts, (value) => closeActive(value));
    document.body.appendChild(root);

    // Trigger the enter animation on the next frame so the browser has had
    // a chance to register the .modal-overlay--entering state.
    requestAnimationFrame(() => {
      root.classList.add('modal-overlay--open');
    });

    const input = root.querySelector('.modal__input');
    input.focus();
    input.select();

    const prevFocus = document.activeElement;
    const cleanup = installListeners(root, () => closeActive(null));

    active = { resolve, root, prevFocus, cleanup };
  });
}

/**
 * Open a yes/no modal. Resolves to `true` on confirm, `false` on cancel /
 * Escape / click-outside. Same focus-trap, same exit animation, same
 * single-modal-at-a-time guarantee as `prompt()` — just no input field.
 *
 *   const ok = await confirm({
 *     title: 'Replace current buffer with example?',
 *     message: 'Unsaved changes will be lost.',
 *     confirmLabel: 'Replace',
 *     destructive: true,
 *   });
 *   if (!ok) return;
 *
 * @param {{
 *   title: string,
 *   message?: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   destructive?: boolean,
 * }} opts
 * @returns {Promise<boolean>}
 */
export function confirm(opts) {
  if (active) closeActive(null);

  return new Promise((resolve) => {
    const root = buildConfirm(opts, (ok) => closeActive(ok));
    document.body.appendChild(root);

    requestAnimationFrame(() => {
      root.classList.add('modal-overlay--open');
    });

    const confirmBtn = root.querySelector('.modal__confirm');
    confirmBtn.focus();

    const prevFocus = document.activeElement;
    const cleanup = installListeners(root, () => closeActive(false));

    active = { resolve: (v) => resolve(v === true), root, prevFocus, cleanup };
  });
}

function closeActive(value) {
  if (!active) return;
  const { resolve, root, prevFocus, cleanup } = active;
  active = null;
  cleanup();
  // Animate out (80ms ease-in per SYSTEM.md §9), then remove from DOM.
  root.classList.remove('modal-overlay--open');
  root.classList.add('modal-overlay--exiting');
  setTimeout(() => {
    if (root.parentNode) root.parentNode.removeChild(root);
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try {
        prevFocus.focus();
      } catch {
        /* element may have been removed */
      }
    }
  }, 80);
  resolve(value);
}

function buildModal(opts, onConfirm) {
  const {
    title,
    placeholder = '',
    defaultValue = '',
    confirmLabel = 'OK',
    cancelLabel = 'Cancel',
    validate,
  } = opts;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);

  const dialog = document.createElement('div');
  dialog.className = 'modal';
  overlay.appendChild(dialog);

  const titleEl = document.createElement('div');
  titleEl.className = 'modal__title';
  titleEl.textContent = title;
  dialog.appendChild(titleEl);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'modal__input';
  input.placeholder = placeholder;
  input.value = defaultValue;
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  dialog.appendChild(input);

  const error = document.createElement('div');
  error.className = 'modal__error';
  error.setAttribute('aria-live', 'polite');
  dialog.appendChild(error);

  const actions = document.createElement('div');
  actions.className = 'modal__actions';
  dialog.appendChild(actions);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--ghost modal__cancel';
  cancelBtn.textContent = cancelLabel;
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn modal__confirm';
  confirmBtn.textContent = confirmLabel;
  actions.appendChild(confirmBtn);

  function tryConfirm() {
    const value = input.value;
    if (!value) {
      // Empty == cancel, matching window.prompt() semantics. Resolves with
      // null so callers can `if (!name) return;` exactly as before.
      onConfirm(null);
      return;
    }
    if (validate) {
      const err = validate(value);
      if (err) {
        error.textContent = err;
        input.focus();
        input.select();
        return;
      }
    }
    error.textContent = '';
    onConfirm(value);
  }

  confirmBtn.addEventListener('click', tryConfirm);
  cancelBtn.addEventListener('click', () => onConfirm(null));
  input.addEventListener('input', () => {
    if (error.textContent) error.textContent = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tryConfirm();
    }
  });

  return overlay;
}

function buildConfirm(opts, onResult) {
  const {
    title,
    message,
    confirmLabel = 'OK',
    cancelLabel = 'Cancel',
    destructive = false,
  } = opts;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);

  const dialog = document.createElement('div');
  dialog.className = 'modal';
  overlay.appendChild(dialog);

  const titleEl = document.createElement('div');
  titleEl.className = 'modal__title';
  titleEl.textContent = title;
  dialog.appendChild(titleEl);

  if (message) {
    const messageEl = document.createElement('div');
    messageEl.className = 'modal__message';
    messageEl.textContent = message;
    dialog.appendChild(messageEl);
  }

  const actions = document.createElement('div');
  actions.className = 'modal__actions';
  dialog.appendChild(actions);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--ghost modal__cancel';
  cancelBtn.textContent = cancelLabel;
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn modal__confirm';
  if (destructive) confirmBtn.classList.add('btn--destructive');
  confirmBtn.textContent = confirmLabel;
  actions.appendChild(confirmBtn);

  confirmBtn.addEventListener('click', () => onResult(true));
  cancelBtn.addEventListener('click', () => onResult(false));
  // Enter on the focused confirm button is the platform default; nothing
  // extra to wire here. Escape is handled by installListeners().

  return overlay;
}

function installListeners(root, onDismiss) {
  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === 'Tab') {
      // Focus trap — keep tab cycle inside the modal.
      const focusables = getFocusables(root);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function onClick(e) {
    // Click on the backdrop (overlay itself, not the dialog) dismisses.
    if (e.target === root) onDismiss();
  }

  document.addEventListener('keydown', onKeydown, true);
  root.addEventListener('mousedown', onClick);

  return () => {
    document.removeEventListener('keydown', onKeydown, true);
    root.removeEventListener('mousedown', onClick);
  };
}

function getFocusables(root) {
  return Array.from(
    root.querySelectorAll(
      'input, button, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.disabled && el.offsetParent !== null);
}
