// Settings panel — fifth tab in the right rail.
//
// Replaces the accent-only popover (src/ui/settings-drawer.js) with a
// categorized, persistent settings panel. Three sections:
//
//   APPEARANCE — theme picker, accent color (hue + lightness), font
//                size, font family.
//   EDITOR     — toggle switches for every user-relevant CodeMirror
//                compartment key (line numbers, wrapping, bracket
//                matching, etc.). isAutoCompletionEnabled and
//                isTooltipEnabled are intentionally NOT exposed — they
//                are required-on to keep the IDE feel and would just
//                confuse users if toggleable.
//   ABOUT      — strasbeat + Strudel version, sound count, links.
//
// Same factory-function shape as the four other panels. Match their
// imperative DOM-building style (no framework). The panel is ignorant
// about *how* settings persist — the host passes in callbacks that
// handle both the live editor reconfiguration AND the localStorage
// write. See src/main.js for the boot-time merge-with-stored sequence
// that matters for acceptance criteria (d) and (e).
//
// Public surface:
//
//   const panel = createSettingsPanel({
//     onFocusEditor,     // () => void
//     getSettings,       // () => object — current StrudelMirror settings
//     onChangeSetting,   // (key, value) => void — host applies + persists
//     onAccentChange,    // (hue, lightness) => void — host applies + persists
//     onAccentReset,     // () => void — host clears storage + resets CSS
//     getStoredAccent,   // () => { hue, lightness } | null
//     getSoundCount,     // () => number
//     themes,            // Array<{ key: string, label: string }>
//     appVersion,        // string
//     strudelVersion,    // string
//   });
//   rightRail.registerPanel(panel);
//
// Pure DOM, no framework. See design/work/08-feature-parity-and-beyond.md
// "Phase 5: Enhanced Settings Panel".

// ─── Default accent values (mirror settings-drawer.js / tokens.css) ──────
// Kept in sync by hand. If SYSTEM.md §5 ever moves, update both files.
const DEFAULT_HUE = 358;
const DEFAULT_LIGHTNESS = 0.63;
const LIGHTNESS_MIN = 0.4;
const LIGHTNESS_MAX = 0.8;

// Font sizes the picker offers. Sized to cover a 13" retina through a 4K
// desktop without giving users a useless continuum of in-between values.
const FONT_SIZES = [12, 14, 16, 18, 20, 22, 24];
const DEFAULT_FONT_SIZE = 18;

// Font families the picker offers. Geist Mono is strasbeat's default
// (self-hosted via @fontsource-variable/geist-mono); the rest of the list
// is populated with common monospace fonts that may or may not be on the
// user's system. A missing font falls back to monospace via the font
// stack we construct below.
//
// IMPORTANT: the Geist Mono value below MUST stay character-for-character
// identical to `GEIST_MONO_STACK` in src/main.js and `--font-mono` in
// src/styles/tokens.css. If they drift, the picker will still work but
// it will no longer recognise "Geist Mono (default)" as the active
// option on first load, and will render "Geist Mono" as if it were a
// non-default choice.
const FONT_FAMILIES = [
  {
    value:
      '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    label: "Geist Mono (default)",
  },
  { value: "monospace", label: "System mono" },
  { value: '"JetBrains Mono", monospace', label: "JetBrains Mono" },
  { value: '"Fira Code", monospace', label: "Fira Code" },
  { value: '"SF Mono", monospace', label: "SF Mono" },
  { value: "Menlo, monospace", label: "Menlo" },
];
const DEFAULT_FONT_FAMILY = FONT_FAMILIES[0].value;

// Toggles shown in the EDITOR section, in display order. Labels are the
// user-facing text; keys match the StrudelMirror extension compartment
// keys (see strudel-source/packages/codemirror/codemirror.mjs — line 31
// onwards). The ordering here intentionally puts line numbers / wrapping
// first (visual scaffolding), then bracket / brace behavior, then
// highlighting, then keymap-ish features.
const EDITOR_TOGGLES = [
  {
    key: "isLineNumbersDisplayed",
    label: "Line numbers",
    hint: "Show the gutter with line numbers.",
  },
  {
    key: "isLineWrappingEnabled",
    label: "Line wrapping",
    hint: "Soft-wrap long lines to fit the editor width.",
  },
  {
    key: "isBracketMatchingEnabled",
    label: "Bracket matching",
    hint: "Highlight the matching bracket when the cursor is on one.",
  },
  {
    key: "isBracketClosingEnabled",
    label: "Auto-close brackets",
    hint: "Insert the closing bracket automatically.",
  },
  {
    key: "isActiveLineHighlighted",
    label: "Active line highlight",
    hint: "Tint the line the cursor is on.",
  },
  {
    key: "isPatternHighlightingEnabled",
    label: "Pattern highlighting",
    hint: "Outline the notes currently being played in the pattern.",
  },
  {
    key: "isFlashEnabled",
    label: "Eval flash",
    hint: "Flash the editor background when a pattern is re-evaluated.",
  },
  {
    key: "isTabIndentationEnabled",
    label: "Tab indentation",
    hint: "Use Tab to indent instead of the default behavior.",
  },
  {
    key: "isMultiCursorEnabled",
    label: "Multi-cursor",
    hint: "Allow Cmd/Ctrl-click to add additional cursors.",
  },
];

export function createSettingsPanel({
  onFocusEditor = () => {},
  getSettings = () => ({}),
  onChangeSetting = () => {},
  onAccentChange = () => {},
  onAccentReset = () => {},
  getStoredAccent = () => null,
  getSoundCount = () => 0,
  themes = [],
  appVersion = "",
  strudelVersion = "",
}) {
  // ─── State ────────────────────────────────────────────────────────────
  // We cache the last-known settings snapshot so the toggle handlers can
  // read-modify-write without re-calling getSettings() on every click. It's
  // re-read on activate() so the panel re-opens with fresh values.
  let settings = { ...getSettings() };

  // DOM refs (re-bound on create()). Only the controls that need live
  // updates (active state on toggles, slider values on reset) are kept.
  let root = null;
  let mounted = false;
  let themeSelect = null;
  let hueInput = null;
  let lightInput = null;
  let hueValueEl = null;
  let lightValueEl = null;
  let fontSizeSelect = null;
  let fontFamilySelect = null;
  let soundCountEl = null;
  /** @type {Record<string, HTMLButtonElement>} key → toggle button */
  const toggleButtons = {};
  /** @type {Record<string, HTMLDivElement>} key → toggle row */
  const toggleRows = {};

  // ─── Right-rail panel spec ────────────────────────────────────────────

  return {
    id: "settings",
    icon: "settings",
    label: "Settings",
    create,
    activate,
    deactivate,
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────

  function create(container) {
    root = container;
    root.classList.add("settings-panel");

    root.appendChild(buildHeader());
    root.appendChild(buildAppearanceSection());
    root.appendChild(buildEditorSection());
    root.appendChild(buildAboutSection());

    mounted = true;
  }

  function activate() {
    if (!mounted) return;
    // Re-read the current settings so any external change (e.g. another
    // panel that calls editor.changeSetting behind our back, or a fresh
    // reload after boot merges in strasbeat's defaults) is reflected.
    settings = { ...getSettings() };
    syncAppearanceControls();
    syncEditorToggles();
    syncAboutInfo();
    // Focus the theme picker so Tab navigation starts at the top of the
    // panel. Consistent with the other panels' "focus first interactive
    // control on open" behavior.
    if (themeSelect) themeSelect.focus();
  }

  function deactivate() {
    // No timers/listeners to tear down — the panel keeps its DOM so
    // re-activate is fast and the user's scroll position survives.
  }

  // ─── Section builders ─────────────────────────────────────────────────

  function buildHeader() {
    const header = el("div", "settings-panel__header");
    const titleWrap = el("div", "settings-panel__title-wrap");
    titleWrap.appendChild(el("div", "settings-panel__eyebrow", "Workspace"));
    titleWrap.appendChild(el("div", "settings-panel__title", "Settings"));
    titleWrap.appendChild(
      el(
        "div",
        "settings-panel__meta",
        "Theme, accent, typography, and editor behavior.",
      ),
    );
    header.appendChild(titleWrap);
    return header;
  }

  function buildAppearanceSection() {
    const section = buildSection("Appearance");

    // ─── Theme picker ───────────────────────────────────────────────
    const themeRow = buildRow("Theme");
    themeSelect = el("select", "settings-panel__select");
    themeSelect.setAttribute("aria-label", "Editor theme");
    for (const t of themes) {
      const opt = document.createElement("option");
      opt.value = t.key;
      opt.textContent = t.label;
      themeSelect.appendChild(opt);
    }
    themeSelect.value = settings.theme ?? "strudelTheme";
    themeSelect.addEventListener("change", () => {
      const next = themeSelect.value;
      settings.theme = next;
      onChangeSetting("theme", next);
    });
    themeSelect.addEventListener("keydown", onControlKeydown);
    themeRow.control.appendChild(themeSelect);
    section.body.appendChild(themeRow.row);

    // ─── Accent color: preview + hue + lightness ───────────────────
    const stored = getStoredAccent();
    const startHue = stored?.hue ?? DEFAULT_HUE;
    const startLight = stored?.lightness ?? DEFAULT_LIGHTNESS;

    const accentRow = buildRow("Accent");
    const accentTools = el("div", "settings-panel__accent-row");
    const accentPreview = el("div", "settings-panel__accent-preview");
    const accentSwatch = el("span", "settings-panel__swatch");
    accentSwatch.setAttribute("aria-hidden", "true");
    accentPreview.appendChild(accentSwatch);
    accentPreview.appendChild(
      el("span", "settings-panel__accent-preview-text", "Live preview"),
    );
    accentTools.appendChild(accentPreview);
    const accentResetBtn = el("button", "settings-panel__reset", "Reset");
    accentResetBtn.type = "button";
    accentResetBtn.title = "Reset accent to default";
    accentResetBtn.addEventListener("click", onAccentResetClick);
    accentTools.appendChild(accentResetBtn);
    accentRow.control.appendChild(accentTools);
    section.body.appendChild(accentRow.row);

    const hueRow = buildRow("Hue");
    const hueControl = el("div", "settings-panel__slider-control");
    hueInput = buildSlider({
      min: 0,
      max: 360,
      step: 1,
      value: startHue,
      ariaLabel: "Accent hue",
      extraClass: "settings-panel__slider--hue",
    });
    hueInput.addEventListener("input", onAccentInput);
    hueInput.addEventListener("keydown", onControlKeydown);
    hueControl.appendChild(hueInput);
    hueValueEl = el(
      "span",
      "settings-panel__slider-value",
      formatHue(startHue),
    );
    hueControl.appendChild(hueValueEl);
    hueRow.control.appendChild(hueControl);
    section.body.appendChild(hueRow.row);

    const lightRow = buildRow("Lightness");
    const lightControl = el("div", "settings-panel__slider-control");
    lightInput = buildSlider({
      min: LIGHTNESS_MIN,
      max: LIGHTNESS_MAX,
      step: 0.01,
      value: startLight,
      ariaLabel: "Accent lightness",
    });
    lightInput.addEventListener("input", onAccentInput);
    lightInput.addEventListener("keydown", onControlKeydown);
    lightControl.appendChild(lightInput);
    lightValueEl = el(
      "span",
      "settings-panel__slider-value",
      formatLightness(startLight),
    );
    lightControl.appendChild(lightValueEl);
    lightRow.control.appendChild(lightControl);
    section.body.appendChild(lightRow.row);

    // ─── Font size ─────────────────────────────────────────────────
    const fontSizeRow = buildRow("Font size");
    fontSizeSelect = el("select", "settings-panel__select");
    fontSizeSelect.setAttribute("aria-label", "Font size");
    for (const size of FONT_SIZES) {
      const opt = document.createElement("option");
      opt.value = String(size);
      opt.textContent = `${size}px`;
      fontSizeSelect.appendChild(opt);
    }
    fontSizeSelect.value = String(settings.fontSize ?? DEFAULT_FONT_SIZE);
    fontSizeSelect.addEventListener("change", () => {
      const next = parseInt(fontSizeSelect.value, 10);
      if (!Number.isFinite(next)) return;
      settings.fontSize = next;
      onChangeSetting("fontSize", next);
    });
    fontSizeSelect.addEventListener("keydown", onControlKeydown);
    fontSizeRow.control.appendChild(fontSizeSelect);
    section.body.appendChild(fontSizeRow.row);

    // ─── Font family ───────────────────────────────────────────────
    const fontFamilyRow = buildRow("Font");
    fontFamilySelect = el("select", "settings-panel__select");
    fontFamilySelect.setAttribute("aria-label", "Font family");
    for (const f of FONT_FAMILIES) {
      const opt = document.createElement("option");
      opt.value = f.value;
      opt.textContent = f.label;
      fontFamilySelect.appendChild(opt);
    }
    // If the stored font family doesn't match any known option (user
    // edited localStorage, or a previous build's label set has been
    // renamed), fall back to the Geist default so the picker doesn't
    // look empty. The editor's actual font is still whatever's stored;
    // we only normalise what the picker shows.
    const storedFamily = settings.fontFamily ?? DEFAULT_FONT_FAMILY;
    const known = FONT_FAMILIES.find((f) => f.value === storedFamily);
    fontFamilySelect.value = known ? storedFamily : DEFAULT_FONT_FAMILY;
    fontFamilySelect.addEventListener("change", () => {
      const next = fontFamilySelect.value;
      settings.fontFamily = next;
      onChangeSetting("fontFamily", next);
    });
    fontFamilySelect.addEventListener("keydown", onControlKeydown);
    fontFamilyRow.control.appendChild(fontFamilySelect);
    section.body.appendChild(fontFamilyRow.row);

    return section.root;
  }

  function buildEditorSection() {
    const section = buildSection("Editor");
    for (const { key, label, hint } of EDITOR_TOGGLES) {
      const row = el("div", "settings-panel__toggle-row");
      row.title = hint;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".settings-panel__toggle")) return;
        onToggleClick(key);
      });

      const labelEl = el("span", "settings-panel__toggle-label", label);
      row.appendChild(labelEl);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-panel__toggle";
      btn.dataset.settingKey = key;
      btn.setAttribute("role", "switch");
      btn.setAttribute("aria-label", label);
      const on = !!settings[key];
      btn.setAttribute("aria-checked", on ? "true" : "false");
      if (on) btn.classList.add("is-on");
      const knob = el("span", "settings-panel__toggle-knob");
      btn.appendChild(knob);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggleClick(key);
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onToggleClick(key);
        } else {
          onControlKeydown(e);
        }
      });
      row.classList.toggle("is-on", on);
      row.appendChild(btn);
      toggleButtons[key] = btn;
      toggleRows[key] = row;
      section.body.appendChild(row);
    }
    return section.root;
  }

  function buildAboutSection() {
    const section = buildSection("About");

    const versionLine = el("div", "settings-panel__about-line");
    versionLine.textContent = `strasbeat ${appVersion || "dev"}`;
    section.body.appendChild(versionLine);

    const strudelLine = el("div", "settings-panel__about-line");
    strudelLine.textContent = `Strudel ${strudelVersion || "unknown"}`;
    section.body.appendChild(strudelLine);

    soundCountEl = el("div", "settings-panel__about-line");
    soundCountEl.textContent = `Sounds loaded: ${getSoundCount() || "…"}`;
    section.body.appendChild(soundCountEl);

    // Links row — opens in a new tab so the editor context isn't
    // dropped. noopener + noreferrer are defensive against tab-nabbing
    // via window.opener, same as any other outbound link.
    const links = el("div", "settings-panel__links");
    links.appendChild(
      buildLink("strudel.cc", "https://strudel.cc", "Strudel homepage"),
    );
    links.appendChild(
      buildLink(
        "GitHub",
        "https://github.com/Coriou/strasbeat",
        "strasbeat on GitHub",
      ),
    );
    section.body.appendChild(links);

    return section.root;
  }

  // ─── Control sync ─────────────────────────────────────────────────────

  function syncAppearanceControls() {
    if (themeSelect) themeSelect.value = settings.theme ?? "strudelTheme";
    if (fontSizeSelect) {
      fontSizeSelect.value = String(settings.fontSize ?? DEFAULT_FONT_SIZE);
    }
    if (fontFamilySelect) {
      const storedFamily = settings.fontFamily ?? DEFAULT_FONT_FAMILY;
      const known = FONT_FAMILIES.find((f) => f.value === storedFamily);
      fontFamilySelect.value = known ? storedFamily : DEFAULT_FONT_FAMILY;
    }
    syncAccentSliders();
  }

  function syncAccentSliders() {
    const stored = getStoredAccent();
    const hue = stored?.hue ?? DEFAULT_HUE;
    const light = stored?.lightness ?? DEFAULT_LIGHTNESS;
    if (hueInput) hueInput.value = String(hue);
    if (lightInput) lightInput.value = String(light);
    updateAccentValueLabels(hue, light);
    // The swatch is always `var(--accent)` — no need to set a per-sync
    // background. The CSS variable is updated by the host whenever the
    // sliders fire, so the swatch animates with the slider drag for free.
  }

  function syncEditorToggles() {
    for (const { key } of EDITOR_TOGGLES) {
      const btn = toggleButtons[key];
      const row = toggleRows[key];
      if (!btn) continue;
      const on = !!settings[key];
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
      row?.classList.toggle("is-on", on);
    }
  }

  function syncAboutInfo() {
    if (soundCountEl) {
      const n = getSoundCount();
      soundCountEl.textContent = `Sounds loaded: ${n || "…"}`;
    }
  }

  // ─── Event handlers ───────────────────────────────────────────────────

  function onToggleClick(key) {
    const current = !!settings[key];
    const next = !current;
    settings[key] = next;
    const btn = toggleButtons[key];
    if (btn) {
      btn.classList.toggle("is-on", next);
      btn.setAttribute("aria-checked", next ? "true" : "false");
    }
    onChangeSetting(key, next);
  }

  function onAccentInput() {
    const hue = Number(hueInput.value);
    const light = Number(lightInput.value);
    if (!Number.isFinite(hue) || !Number.isFinite(light)) return;
    updateAccentValueLabels(hue, light);
    onAccentChange(hue, light);
  }

  function onAccentResetClick() {
    onAccentReset();
    if (hueInput) hueInput.value = String(DEFAULT_HUE);
    if (lightInput) lightInput.value = String(DEFAULT_LIGHTNESS);
    updateAccentValueLabels(DEFAULT_HUE, DEFAULT_LIGHTNESS);
  }

  function onControlKeydown(e) {
    // Escape anywhere in the panel returns focus to the editor. Matches
    // the other panels' escape-to-editor rule.
    if (e.key === "Escape") {
      e.preventDefault();
      onFocusEditor();
    }
  }

  function updateAccentValueLabels(hue, light) {
    if (hueValueEl) hueValueEl.textContent = formatHue(hue);
    if (lightValueEl) lightValueEl.textContent = formatLightness(light);
  }

  // ─── Small DOM helpers ────────────────────────────────────────────────

  function buildSection(titleText) {
    const root = el("section", "settings-panel__section");
    const heading = el("h3", "settings-panel__section-title", titleText);
    root.appendChild(heading);
    const body = el("div", "settings-panel__section-body");
    root.appendChild(body);
    return { root, body };
  }

  function buildRow(labelText) {
    const row = el("label", "settings-panel__row");
    const labelEl = el("span", "settings-panel__row-label", labelText);
    row.appendChild(labelEl);
    const control = el("span", "settings-panel__row-control");
    row.appendChild(control);
    return { row, control };
  }

  function buildSlider({ min, max, step, value, ariaLabel, extraClass }) {
    const input = document.createElement("input");
    input.type = "range";
    input.className = "settings-panel__slider";
    if (extraClass) input.classList.add(extraClass);
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
    return input;
  }

  function buildLink(label, href, title) {
    const a = document.createElement("a");
    a.className = "settings-panel__link";
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    a.title = title;
    return a;
  }
}

// ─── Pure helpers (no closure state) ──────────────────────────────────────

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function formatHue(hue) {
  return `${Math.round(Number(hue) || 0)}°`;
}

function formatLightness(lightness) {
  return `${Math.round((Number(lightness) || 0) * 100)}%`;
}
