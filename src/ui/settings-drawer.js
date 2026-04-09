/*
 * Settings popover — anchored under the #settings button in the top bar.
 * For v1 it has a single section: accent color (hue + lightness sliders +
 * reset link). The same component is the natural home for future settings.
 *
 * Why a popover (not a slide-out drawer): SYSTEM.md §2.6 — "floating
 * contextual actions near the cursor". One section, one click target, no
 * need to take up a whole edge of the screen.
 *
 * Persistence: the chosen hue/lightness pair is written to localStorage
 * under STORAGE_KEY. `applyStoredAccent()` reads it and writes the four
 * accent CSS variables back onto :root. Call this at the very top of
 * main.js so the page boots with the user's accent already applied.
 */

const STORAGE_KEY = 'strasbeat:accent';

// Mirror of the OKLCH defaults in src/styles/tokens.css.
// Keep these in sync if SYSTEM.md §5 ever moves.
export const DEFAULT_HUE = 358;
export const DEFAULT_LIGHTNESS = 0.63;
const BASE_CHROMA = 0.19;
const HI_CHROMA = 0.20;
const LO_CHROMA = 0.12;
const HI_LIGHTNESS_OFFSET = 0.07;
const LO_LIGHTNESS_OFFSET = -0.21;
const WASH_ALPHA = 0.12;

const LIGHTNESS_MIN = 0.40;
const LIGHTNESS_MAX = 0.80;

let popover = null; // { root, cleanup }

/**
 * Apply a stored accent (if any) to :root before the rest of the UI mounts.
 * Idempotent — safe to call multiple times.
 */
export function applyStoredAccent() {
  const stored = readStored();
  if (!stored) return;
  applyAccent(stored.hue, stored.lightness);
}

/**
 * Wire the settings button to toggle the popover.
 * @param {{ button: HTMLElement }} args
 */
export function mountSettingsDrawer({ button }) {
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover) close();
    else open(button);
  });
}

// ─── Open / close ────────────────────────────────────────────────────────

function open(anchor) {
  const stored = readStored() ?? {
    hue: DEFAULT_HUE,
    lightness: DEFAULT_LIGHTNESS,
  };

  const root = buildPopover(stored, {
    onChange(hue, lightness) {
      applyAccent(hue, lightness);
      saveStored(hue, lightness);
    },
    onReset() {
      clearStored();
      resetAccent();
      // Refresh the slider DOM in place so the inputs reflect the reset.
      const hueInput = root.querySelector('[data-field="hue"]');
      const lightInput = root.querySelector('[data-field="lightness"]');
      if (hueInput) hueInput.value = String(DEFAULT_HUE);
      if (lightInput) lightInput.value = String(DEFAULT_LIGHTNESS);
      const swatch = root.querySelector('.settings-pop__swatch');
      if (swatch) swatch.style.background = `var(--accent)`;
    },
  });

  document.body.appendChild(root);

  // Position fixed underneath the anchor button. Right-aligned so the
  // popover hugs the right edge of the top bar where the button lives.
  positionPopover(root, anchor);

  // Trigger enter animation on the next frame.
  requestAnimationFrame(() => root.classList.add('settings-pop--open'));

  const cleanup = installListeners(root, anchor);
  popover = { root, cleanup };
}

function close() {
  if (!popover) return;
  const { root, cleanup } = popover;
  popover = null;
  cleanup();
  root.classList.remove('settings-pop--open');
  root.classList.add('settings-pop--exiting');
  setTimeout(() => {
    if (root.parentNode) root.parentNode.removeChild(root);
  }, 80);
}

function positionPopover(root, anchor) {
  const rect = anchor.getBoundingClientRect();
  // Anchor under the button, right-aligned with the button's right edge so
  // the popover doesn't overflow the top bar's right side.
  root.style.top = `${rect.bottom + 6}px`;
  root.style.right = `${window.innerWidth - rect.right}px`;
}

function installListeners(root, anchor) {
  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
  function onClick(e) {
    // Click outside both the popover and the anchor button dismisses.
    if (root.contains(e.target)) return;
    if (anchor.contains(e.target)) return;
    close();
  }
  document.addEventListener('keydown', onKeydown, true);
  // Use mousedown so the dismiss happens on press, not release — feels
  // snappier and matches the modal's click-outside behavior.
  document.addEventListener('mousedown', onClick, true);
  return () => {
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('mousedown', onClick, true);
  };
}

// ─── DOM building ────────────────────────────────────────────────────────

function buildPopover({ hue, lightness }, { onChange, onReset }) {
  const root = document.createElement('div');
  root.className = 'settings-pop';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Settings');

  const section = document.createElement('div');
  section.className = 'settings-pop__section';
  root.appendChild(section);

  const header = document.createElement('div');
  header.className = 'settings-pop__header';
  section.appendChild(header);

  const title = document.createElement('div');
  title.className = 'settings-pop__title';
  title.textContent = 'Accent color';
  header.appendChild(title);

  const swatch = document.createElement('div');
  swatch.className = 'settings-pop__swatch';
  swatch.setAttribute('aria-hidden', 'true');
  header.appendChild(swatch);

  // Hue slider
  section.appendChild(
    buildSlider({
      label: 'Hue',
      field: 'hue',
      min: 0,
      max: 360,
      step: 1,
      value: hue,
      track: 'settings-pop__hue-track',
      onInput(next) {
        hue = Number(next);
        applyAccent(hue, lightness);
        onChange(hue, lightness);
      },
    }),
  );

  // Lightness slider
  section.appendChild(
    buildSlider({
      label: 'Lightness',
      field: 'lightness',
      min: LIGHTNESS_MIN,
      max: LIGHTNESS_MAX,
      step: 0.01,
      value: lightness,
      onInput(next) {
        lightness = Number(next);
        applyAccent(hue, lightness);
        onChange(hue, lightness);
      },
    }),
  );

  // Reset link
  const resetRow = document.createElement('div');
  resetRow.className = 'settings-pop__reset-row';
  const resetLink = document.createElement('button');
  resetLink.type = 'button';
  resetLink.className = 'settings-pop__reset';
  resetLink.textContent = 'Reset to default';
  resetLink.addEventListener('click', () => onReset());
  resetRow.appendChild(resetLink);
  section.appendChild(resetRow);

  return root;
}

function buildSlider({ label, field, min, max, step, value, track, onInput }) {
  const wrap = document.createElement('label');
  wrap.className = 'settings-pop__field';

  const labelEl = document.createElement('span');
  labelEl.className = 'settings-pop__field-label';
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'settings-pop__slider';
  if (track) input.classList.add(track);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.dataset.field = field;
  input.addEventListener('input', () => onInput(input.value));
  wrap.appendChild(input);

  return wrap;
}

// ─── Color application ──────────────────────────────────────────────────
// Exported so src/ui/settings-panel.js can reuse the same OKLCH math +
// storage keys when the accent picker is driven from the right-rail
// settings panel instead of the legacy popover. Popover stays as dead
// code for now — see design/work/08-feature-parity-and-beyond.md Phase 5
// cleanup note.

export function applyAccent(hue, lightness) {
  const root = document.documentElement;
  const lHi = clamp(lightness + HI_LIGHTNESS_OFFSET, 0, 1);
  const lLo = clamp(lightness + LO_LIGHTNESS_OFFSET, 0, 1);
  root.style.setProperty('--accent', `oklch(${lightness} ${BASE_CHROMA} ${hue})`);
  root.style.setProperty('--accent-hi', `oklch(${lHi} ${HI_CHROMA} ${hue})`);
  root.style.setProperty('--accent-lo', `oklch(${lLo} ${LO_CHROMA} ${hue})`);
  root.style.setProperty(
    '--accent-wash',
    `oklch(${lightness} ${BASE_CHROMA} ${hue} / ${WASH_ALPHA})`,
  );
}

export function resetAccent() {
  // Clearing the inline properties lets :root fall back to the values in
  // tokens.css — the single source of truth (SYSTEM.md §5).
  const root = document.documentElement;
  root.style.removeProperty('--accent');
  root.style.removeProperty('--accent-hi');
  root.style.removeProperty('--accent-lo');
  root.style.removeProperty('--accent-wash');
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// ─── Storage ────────────────────────────────────────────────────────────
// Same exported-for-reuse rationale as applyAccent above: the panel
// reads/writes the same localStorage key so the popover + panel stay
// swap-compatible while the popover lingers as dead code.

export function readStoredAccent() {
  return readStored();
}

export function saveStoredAccent(hue, lightness) {
  saveStored(hue, lightness);
}

export function clearStoredAccent() {
  clearStored();
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.hue !== 'number') return null;
    if (typeof parsed?.lightness !== 'number') return null;
    return { hue: parsed.hue, lightness: parsed.lightness };
  } catch {
    return null;
  }
}

function saveStored(hue, lightness) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ hue, lightness }));
  } catch {
    /* private mode / quota — ignore */
  }
}

function clearStored() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
