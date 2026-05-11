/*
 * Modal surface — replaces window.prompt() / window.confirm() with in-app
 * dialogs that inherit the design-system tokens. See design/SYSTEM.md §2.7
 * (no native dialogs), §5–§8 (surfaces, elevation, radii) and §9 (motion).
 *
 * Four exports, layered shallow-to-deep:
 *
 *   - prompt({ title, ... })       — single text input, returns string | null
 *   - confirm({ title, ... })      — yes / no, returns boolean
 *   - formModal({ title, fields }) — multi-field form, returns
 *                                    Record<string,string> | null
 *   - choiceModal({ title, choices }) — N stacked buttons, returns the
 *                                       chosen value or null on cancel
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
    const prevFocus = document.activeElement;
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

    const cleanup = installListeners(root, () => closeActive(null));

    active = { resolve, root, prevFocus, cleanup };
  });
}

/**
 * Open a multi-field form modal. Each field is rendered as a label + input
 * (text or select). Resolves to `{ [key]: value }` on confirm, or `null` on
 * cancel / Escape / click-outside.
 *
 *   const values = await formModal({
 *     title: 'New pattern',
 *     fields: [
 *       { key: 'name', label: 'Name', type: 'text', defaultValue: 'untitled' },
 *       { key: 'folder', label: 'Folder', type: 'select', options: [
 *         { value: '', label: 'Unfiled' },
 *         { value: 'Jazz', label: 'Jazz' },
 *         { value: '__new__', label: 'New folder…' },
 *       ]},
 *     ],
 *     confirmLabel: 'Create',
 *     validate: (v) => v.name ? null : { name: 'name required' },
 *   });
 *   if (!values) return; // dismissed
 *
 * The `__new__` option value renders a visual divider above it inside the
 * select — so "create new" sits visually separated from the existing entries.
 *
 * `validate(values)` returns `null` to allow confirm, or a `{key: message}`
 * map to block confirm and surface per-field errors. On validation failure
 * the first errored field is focused.
 *
 * Reuses the same focus-trap, Escape / click-outside dismiss, exit animation,
 * and single-modal-at-a-time guarantee as `prompt()` and `confirm()`.
 *
 * @param {{
 *   title: string,
 *   fields: Array<{
 *     key: string,
 *     label: string,
 *     type: 'text' | 'select',
 *     placeholder?: string,
 *     defaultValue?: string,
 *     options?: Array<{ value: string, label: string }>,
 *   }>,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   validate?: (values: Record<string, string>) =>
 *     Record<string, string> | null | undefined,
 * }} opts
 * @returns {Promise<Record<string, string> | null>}
 */
export function formModal(opts) {
  if (active) closeActive(null);

  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const root = buildForm(opts, (values) => closeActive(values));
    document.body.appendChild(root);

    requestAnimationFrame(() => {
      root.classList.add('modal-overlay--open');
    });

    // Focus the first text input if any, else the first focusable element.
    const firstInput = root.querySelector('.modal__input');
    if (firstInput) {
      firstInput.focus();
      // Only <input> supports .select(); <select> does not.
      if (typeof firstInput.select === 'function') firstInput.select();
    }

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
    const prevFocus = document.activeElement;
    const root = buildConfirm(opts, (ok) => closeActive(ok));
    document.body.appendChild(root);

    requestAnimationFrame(() => {
      root.classList.add('modal-overlay--open');
    });

    const confirmBtn = root.querySelector('.modal__confirm');
    confirmBtn.focus();

    const cleanup = installListeners(root, () => closeActive(false));

    active = { resolve: (v) => resolve(v === true), root, prevFocus, cleanup };
  });
}

/**
 * Open a multi-choice modal. Resolves to the chosen choice's `value`, or
 * `null` on cancel / Escape / click-outside.
 *
 *   const r = await choiceModal({
 *     title: 'Delete folder "Jazz"?',
 *     message: 'This folder contains 3 patterns.',
 *     choices: [
 *       { value: 'unfile', label: 'Move 3 patterns to Unfiled' },
 *       { value: 'delete', label: 'Delete folder and all 3 patterns', danger: true },
 *     ],
 *     cancelLabel: 'Cancel',
 *   });
 *
 * Each choice renders as its own stacked button — the question is "which one"
 * rather than "yes or no", so we forgo the single-confirm/cancel layout in
 * favor of a vertical list. Reuses the same focus-trap, Escape /
 * click-outside dismiss, exit animation, and single-modal-at-a-time
 * guarantee as `prompt()`, `confirm()`, and `formModal()`.
 *
 * @param {{
 *   title: string,
 *   message?: string,
 *   choices: Array<{ value: string, label: string, danger?: boolean }>,
 *   cancelLabel?: string,
 * }} opts
 * @returns {Promise<string | null>}
 */
export function choiceModal(opts) {
  if (active) closeActive(null);

  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const root = buildChoice(opts, (value) => closeActive(value));
    document.body.appendChild(root);

    requestAnimationFrame(() => {
      root.classList.add('modal-overlay--open');
    });

    // Focus the first choice button (or cancel if no choices). Matches
    // confirm()'s "primary action under the cursor when the modal opens"
    // ergonomic — Enter immediately fires the first choice.
    const firstBtn = root.querySelector('.modal__choice');
    if (firstBtn) firstBtn.focus();
    else root.querySelector('.modal__cancel')?.focus();

    const cleanup = installListeners(root, () => closeActive(null));

    active = { resolve, root, prevFocus, cleanup };
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

function buildForm(opts, onConfirm) {
  const {
    title,
    fields = [],
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
  dialog.className = 'modal modal--form';
  overlay.appendChild(dialog);

  const titleEl = document.createElement('div');
  titleEl.className = 'modal__title';
  titleEl.textContent = title;
  dialog.appendChild(titleEl);

  const inputs = {};
  const errors = {};

  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'modal__field';

    const lbl = document.createElement('label');
    lbl.className = 'modal__label';
    lbl.textContent = f.label;
    lbl.htmlFor = `modal-field-${f.key}`;
    row.appendChild(lbl);

    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      input.className = 'modal__input modal__select';
      for (const opt of f.options || []) {
        // A `__new__` option is the "create new" affordance. Insert a
        // visual divider above it so the eye separates existing entries
        // from the action. The divider is a disabled <option> styled via
        // the .modal__select-divider class.
        if (opt.value === '__new__') {
          const sep = document.createElement('option');
          sep.disabled = true;
          sep.className = 'modal__select-divider';
          // Em-dashes render as a horizontal-rule-ish line inside the
          // native dropdown across all major browsers.
          sep.textContent = '──────────';
          input.appendChild(sep);
        }
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      }
      input.value = f.defaultValue ?? '';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'modal__input';
      input.placeholder = f.placeholder ?? '';
      input.value = f.defaultValue ?? '';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
    }
    input.id = `modal-field-${f.key}`;
    row.appendChild(input);

    const err = document.createElement('div');
    err.className = 'modal__error';
    err.setAttribute('aria-live', 'polite');
    row.appendChild(err);

    dialog.appendChild(row);
    inputs[f.key] = input;
    errors[f.key] = err;
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
  confirmBtn.textContent = confirmLabel;
  actions.appendChild(confirmBtn);

  function readValues() {
    const out = {};
    for (const [k, i] of Object.entries(inputs)) out[k] = i.value;
    return out;
  }

  function showErrors(errs) {
    let firstErrorKey = null;
    for (const k of Object.keys(errors)) {
      const msg = errs?.[k] ?? '';
      errors[k].textContent = msg;
      inputs[k].classList.toggle('modal__input--error', !!msg);
      if (msg && !firstErrorKey) firstErrorKey = k;
    }
    if (firstErrorKey) {
      const el = inputs[firstErrorKey];
      el.focus();
      if (typeof el.select === 'function') el.select();
    }
  }

  function tryConfirm() {
    const values = readValues();
    if (validate) {
      const errs = validate(values);
      if (errs) {
        showErrors(errs);
        return;
      }
    }
    for (const k of Object.keys(errors)) {
      errors[k].textContent = '';
      inputs[k].classList.remove('modal__input--error');
    }
    onConfirm(values);
  }

  confirmBtn.addEventListener('click', tryConfirm);
  cancelBtn.addEventListener('click', () => onConfirm(null));

  // Enter inside any <input> confirms — same shortcut as prompt(). Don't
  // bind Enter on <select> elements: that conflicts with the native
  // dropdown's open/close-and-pick behavior.
  for (const input of Object.values(inputs)) {
    if (input.tagName === 'INPUT') {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          tryConfirm();
        }
      });
      input.addEventListener('input', () => {
        const k = input.id.replace(/^modal-field-/, '');
        if (errors[k]?.textContent) {
          errors[k].textContent = '';
          input.classList.remove('modal__input--error');
        }
      });
    } else if (input.tagName === 'SELECT') {
      input.addEventListener('change', () => {
        const k = input.id.replace(/^modal-field-/, '');
        if (errors[k]?.textContent) {
          errors[k].textContent = '';
          input.classList.remove('modal__input--error');
        }
      });
    }
  }

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

function buildChoice(opts, onResult) {
  const { title, message, choices, cancelLabel = 'Cancel' } = opts;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);

  const dialog = document.createElement('div');
  dialog.className = 'modal modal--choice';
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

  // Stacked actions: each choice is a row of its own. Order is
  // [choice1, choice2, …, Cancel] top-to-bottom so the destructive choice
  // (if any) doesn't sit visually adjacent to a wall-of-text cancel button.
  const actions = document.createElement('div');
  actions.className = 'modal__actions modal__actions--stacked';
  dialog.appendChild(actions);

  for (const c of choices ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn modal__choice';
    if (c.danger) btn.classList.add('btn--destructive');
    btn.textContent = c.label;
    btn.addEventListener('click', () => onResult(c.value));
    actions.appendChild(btn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--ghost modal__cancel';
  cancelBtn.textContent = cancelLabel;
  cancelBtn.addEventListener('click', () => onResult(null));
  actions.appendChild(cancelBtn);

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
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.disabled && el.offsetParent !== null);
}
