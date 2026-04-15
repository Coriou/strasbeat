// Settings panel — the single configuration tab in the right rail.
//
// Consolidates appearance, editor behavior, opt-in packages, user
// samples, and the setup script so the user never has to hunt across
// two tabs for workspace configuration.
//
// Sections (in order):
//   APPEARANCE  — theme picker, accent color (hue + lightness), font
//                 size, font family.
//   EDITOR      — toggle switches for every user-relevant CodeMirror
//                 compartment key (line numbers, wrapping, bracket
//                 matching, etc.).
//   PACKAGES    — opt-in Strudel packages (require reload to take effect).
//   SAMPLES     — import sample banks via URL; manage / delete banks.
//   SCRIPT      — setup script textarea; optional OSC output config when
//                 @strudel/osc is enabled.
//   ABOUT       — strasbeat + Strudel version, sound count, links.
//
// Public surface:
//
//   const panel = createSettingsPanel({
//     onFocusEditor,     // () => void
//     getSettings,       // () => object — current StrudelMirror settings
//     onChangeSetting,   // (key, value) => void — host applies + persists
//     onAccentChange,    // (hue, lightness) => void
//     onAccentReset,     // () => void
//     getStoredAccent,   // () => { hue, lightness } | null
//     getSoundCount,     // () => number
//     getSoundMap,       // () => object
//     themes,            // Array<{ key: string, label: string }>
//     appVersion,        // string
//     strudelVersion,    // string
//     onReloadRequired,  // () => void — host shows "reload to apply" status
//     confirm,           // (msg: string) => Promise<boolean> | boolean
//   });
//   rightRail.registerPanel(panel);

import { categorizeSounds } from "./sound-browser.js";
import { makeIcon } from "./icons.js";
import { getUserSamples } from "../user-setup.js";
import {
  OPT_IN_PACKAGES,
  getEnabledPackages,
  setEnabledPackages,
  getSetupScript,
  setSetupScript,
  importUserSamples,
  deleteUserSampleBank,
  deleteAllUserSamples,
} from "../user-setup.js";

// ─── Default accent values (mirror settings-drawer.js / tokens.css) ──────
const DEFAULT_HUE = 358;
const DEFAULT_LIGHTNESS = 0.63;
const LIGHTNESS_MIN = 0.4;
const LIGHTNESS_MAX = 0.8;

const FONT_SIZES = [12, 14, 16, 18, 20, 22, 24];
const DEFAULT_FONT_SIZE = 18;

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
  getSoundMap = () => ({}),
  themes = [],
  appVersion = "",
  strudelVersion = "",
  onReloadRequired = () => {},
  confirm: confirmFn = window.confirm,
}) {
  // ─── State ────────────────────────────────────────────────────────────
  let settings = { ...getSettings() };
  let root = null;
  let mounted = false;

  // Appearance refs
  let themeSelect = null;
  let hueInput = null;
  let lightInput = null;
  let hueValueEl = null;
  let lightValueEl = null;
  let fontSizeSelect = null;
  let fontFamilySelect = null;

  // About refs
  let soundCountEl = null;
  let soundBreakdownEl = null;

  // Setup refs
  let reloadBannerEl = null;
  let scriptEditor = null;
  let banksEl = null;

  /** @type {Record<string, HTMLButtonElement>} key → editor toggle button */
  const toggleButtons = {};
  /** @type {Record<string, HTMLDivElement>} key → editor toggle row */
  const toggleRows = {};

  /** @type {Record<string, HTMLButtonElement>} pkg.id → package toggle button */
  const pkgToggles = {};
  /** @type {Record<string, HTMLDivElement>} pkg.id → package toggle row */
  const pkgRows = {};

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
    reloadBannerEl = buildReloadBanner();
    root.appendChild(reloadBannerEl);
    root.appendChild(buildAppearanceSection());
    root.appendChild(buildEditorSection());
    root.appendChild(buildPackagesSection());
    root.appendChild(buildSamplesSection());
    root.appendChild(buildScriptSection());
    root.appendChild(buildAboutSection());

    mounted = true;
    refreshBanks();
  }

  function activate() {
    if (!mounted) return;
    settings = { ...getSettings() };
    syncAppearanceControls();
    syncEditorToggles();
    syncAboutInfo();
    refreshBanks();
    if (themeSelect) themeSelect.focus();
  }

  function deactivate() {}

  // ─── Reload banner ────────────────────────────────────────────────────

  function buildReloadBanner() {
    const banner = el("div", "settings-panel__reload-banner");
    banner.hidden = true;
    banner.appendChild(
      el(
        "span",
        "settings-panel__reload-banner-text",
        "Reload to apply package changes.",
      ),
    );
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-panel__reload-btn";
    btn.textContent = "Reload now";
    btn.addEventListener("click", () => window.location.reload());
    banner.appendChild(btn);
    return banner;
  }

  function showReloadBanner() {
    if (reloadBannerEl) reloadBannerEl.hidden = false;
    onReloadRequired();
  }

  // ─── Header ───────────────────────────────────────────────────────────

  function buildHeader() {
    const header = el("div", "settings-panel__header");
    const titleWrap = el("div", "settings-panel__title-wrap");
    titleWrap.appendChild(el("div", "settings-panel__eyebrow", "Workspace"));
    titleWrap.appendChild(el("div", "settings-panel__title", "Settings"));
    titleWrap.appendChild(
      el(
        "div",
        "settings-panel__meta",
        "Appearance, editor, packages, and samples.",
      ),
    );
    header.appendChild(titleWrap);
    return header;
  }

  // ─── Appearance section ───────────────────────────────────────────────

  function buildAppearanceSection() {
    const section = buildSection("Appearance");

    // Theme picker
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

    // Accent color: preview swatch + hue + lightness sliders
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

    // Font size
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

    // Font family
    const fontFamilyRow = buildRow("Font");
    fontFamilySelect = el("select", "settings-panel__select");
    fontFamilySelect.setAttribute("aria-label", "Font family");
    for (const f of FONT_FAMILIES) {
      const opt = document.createElement("option");
      opt.value = f.value;
      opt.textContent = f.label;
      fontFamilySelect.appendChild(opt);
    }
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

  // ─── Editor section ───────────────────────────────────────────────────

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

  // ─── Packages section ─────────────────────────────────────────────────

  function buildPackagesSection() {
    const section = buildSection("Packages");
    section.body.appendChild(
      el(
        "div",
        "settings-panel__section-desc",
        "Enable additional Strudel packages. Takes effect on next reload.",
      ),
    );

    const enabledSet = new Set(getEnabledPackages());

    for (const pkg of OPT_IN_PACKAGES) {
      const row = el("div", "settings-panel__toggle-row settings-panel__toggle-row--pkg");
      row.addEventListener("click", (e) => {
        if (e.target.closest(".settings-panel__toggle")) return;
        onPkgToggleClick(pkg.id);
      });

      // Two-line label (name + description)
      const info = el("div", "settings-panel__pkg-info");
      info.appendChild(el("span", "settings-panel__toggle-label", pkg.label));
      info.appendChild(el("span", "settings-panel__pkg-desc", pkg.description));
      row.appendChild(info);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-panel__toggle";
      btn.dataset.pkgId = pkg.id;
      btn.setAttribute("role", "switch");
      btn.setAttribute("aria-label", pkg.label);
      const on = enabledSet.has(pkg.id);
      btn.setAttribute("aria-checked", on ? "true" : "false");
      if (on) btn.classList.add("is-on");
      const knob = el("span", "settings-panel__toggle-knob");
      btn.appendChild(knob);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onPkgToggleClick(pkg.id);
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onPkgToggleClick(pkg.id);
        } else {
          onControlKeydown(e);
        }
      });
      row.classList.toggle("is-on", on);
      row.appendChild(btn);
      pkgToggles[pkg.id] = btn;
      pkgRows[pkg.id] = row;
      section.body.appendChild(row);
    }
    return section.root;
  }

  // ─── Samples section ──────────────────────────────────────────────────

  function buildSamplesSection() {
    const section = buildSection("Samples");
    section.body.appendChild(
      el(
        "div",
        "settings-panel__section-desc",
        "Import sample folder URLs or manage imported banks. Stored in your browser.",
      ),
    );

    // URL import row
    const importRow = el("div", "settings-panel__import-row");
    const urlInput = el("input", "settings-panel__url-input");
    urlInput.type = "text";
    urlInput.placeholder = "Samples JSON URL\u2026";
    urlInput.setAttribute("aria-label", "Sample manifest URL");
    importRow.appendChild(urlInput);

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "settings-panel__btn";
    importBtn.textContent = "Import";
    importBtn.addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const sampleMap = await resp.json();
        const name =
          new URL(url).pathname
            .split("/")
            .pop()
            ?.replace(/\.json$/i, "") || "user-import";
        await importUserSamples(name, sampleMap);
        urlInput.value = "";
        refreshBanks();
        console.log(`[settings] imported sample bank "${name}" from URL`);
      } catch (err) {
        console.error("[settings] import failed:", err);
        alert(`Import failed: ${err.message}`);
      }
    });
    importRow.appendChild(importBtn);
    section.body.appendChild(importRow);

    // Bank list
    banksEl = el("div", "settings-panel__banks");
    section.body.appendChild(banksEl);

    // Delete all
    const deleteAllBtn = document.createElement("button");
    deleteAllBtn.type = "button";
    deleteAllBtn.className = "settings-panel__btn settings-panel__btn--danger";
    deleteAllBtn.textContent = "Delete all user samples";
    deleteAllBtn.addEventListener("click", async () => {
      const yes = await confirmFn(
        "Delete all user samples? This cannot be undone.",
      );
      if (!yes) return;
      await deleteAllUserSamples();
      refreshBanks();
    });
    section.body.appendChild(deleteAllBtn);

    return section.root;
  }

  // ─── Script section ───────────────────────────────────────────────────

  function buildScriptSection() {
    const section = buildSection("Script");
    section.body.appendChild(
      el(
        "div",
        "settings-panel__section-desc",
        "Runs once at boot after core packages load. Same permissions as pattern code.",
      ),
    );

    scriptEditor = document.createElement("textarea");
    scriptEditor.className = "settings-panel__script";
    scriptEditor.spellcheck = false;
    scriptEditor.placeholder =
      "// e.g. samples('https://...')\n// or any initialization code";
    scriptEditor.value = getSetupScript();
    section.body.appendChild(scriptEditor);

    const actions = el("div", "settings-panel__btn-row");
    const saveScriptBtn = document.createElement("button");
    saveScriptBtn.type = "button";
    saveScriptBtn.className = "settings-panel__btn settings-panel__btn--primary";
    saveScriptBtn.textContent = "Save script";
    saveScriptBtn.addEventListener("click", () => {
      setSetupScript(scriptEditor.value);
      showReloadBanner();
    });
    actions.appendChild(saveScriptBtn);
    const clearScriptBtn = document.createElement("button");
    clearScriptBtn.type = "button";
    clearScriptBtn.className = "settings-panel__btn";
    clearScriptBtn.textContent = "Clear";
    clearScriptBtn.addEventListener("click", () => {
      scriptEditor.value = "";
      setSetupScript("");
    });
    actions.appendChild(clearScriptBtn);
    section.body.appendChild(actions);

    // OSC config — only when @strudel/osc is enabled
    if (new Set(getEnabledPackages()).has("osc")) {
      section.body.appendChild(buildOscSubsection());
    }

    return section.root;
  }

  function buildOscSubsection() {
    const DEFAULT_OSC_URL = "ws://localhost:8080";
    const wrap = el("div", "settings-panel__osc");

    const title = el("div", "settings-panel__osc-title", "OSC Output");
    wrap.appendChild(title);
    wrap.appendChild(
      el(
        "div",
        "settings-panel__section-desc",
        "Strudel sends OSC messages via WebSocket. The bridge server must listen on the URL below.",
      ),
    );

    // URL display (read-only — upstream hardcodes ws://localhost:8080)
    const urlRow = el("div", "settings-panel__osc-row");
    urlRow.appendChild(el("span", "settings-panel__osc-label", "Target:"));
    urlRow.appendChild(el("span", "settings-panel__osc-value", DEFAULT_OSC_URL));
    wrap.appendChild(urlRow);

    // Status indicator
    const statusRow = el("div", "settings-panel__osc-row");
    const dot = el("span", "settings-panel__osc-dot");
    dot.dataset.status = "unknown";
    const statusText = el(
      "span",
      "settings-panel__osc-status-text",
      "Not connected",
    );
    statusRow.appendChild(dot);
    statusRow.appendChild(statusText);
    wrap.appendChild(statusRow);

    // Test button
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "settings-panel__btn";
    testBtn.textContent = "Test connection";
    testBtn.addEventListener("click", async () => {
      dot.dataset.status = "connecting";
      statusText.textContent = "Connecting\u2026";
      try {
        const ws = new WebSocket(DEFAULT_OSC_URL);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", () => {
            dot.dataset.status = "connected";
            statusText.textContent = "Connected";
            ws.send(
              JSON.stringify({
                address: "/strasbeat/test",
                args: ["hello"],
                timestamp: 0,
              }),
            );
            console.log("[settings] OSC test message sent to", DEFAULT_OSC_URL);
            resolve();
            setTimeout(() => ws.close(), 500);
          });
          ws.addEventListener("error", () =>
            reject(new Error("Connection failed")),
          );
          ws.addEventListener("close", () => {
            if (dot.dataset.status === "connecting")
              reject(new Error("Connection closed"));
          });
          setTimeout(() => reject(new Error("Timeout")), 3000);
        });
      } catch (err) {
        dot.dataset.status = "error";
        statusText.textContent = `Error: ${err.message}`;
        console.warn("[settings] OSC test failed:", err.message);
      }
    });
    wrap.appendChild(testBtn);

    return wrap;
  }

  // ─── About section ────────────────────────────────────────────────────

  function buildAboutSection() {
    const section = buildSection("About");

    const versionLine = el("div", "settings-panel__about-line");
    versionLine.textContent = `strasbeat ${appVersion || "dev"}`;
    section.body.appendChild(versionLine);

    const strudelLine = el("div", "settings-panel__about-line");
    strudelLine.textContent = `Strudel ${strudelVersion || "unknown"}`;
    section.body.appendChild(strudelLine);

    soundCountEl = el("div", "settings-panel__about-line");
    soundCountEl.textContent = `Sounds loaded: ${getSoundCount() || "\u2026"}`;
    section.body.appendChild(soundCountEl);

    soundBreakdownEl = el("div", "settings-panel__about-breakdown");
    section.body.appendChild(soundBreakdownEl);

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
      soundCountEl.textContent = `Sounds loaded: ${n ? n.toLocaleString() : "\u2026"}`;
    }
    if (soundBreakdownEl) {
      const mapObj = getSoundMap();
      getUserSamples()
        .then((banks) => {
          const bankNames = new Set(banks.map((b) => b.name));
          const cats = categorizeSounds(mapObj, bankNames);
          _renderBreakdown(cats);
        })
        .catch(() => {
          const cats = categorizeSounds(mapObj);
          _renderBreakdown(cats);
        });
    }
  }

  function _renderBreakdown(cats) {
    if (!soundBreakdownEl) return;
    const parts = [];
    if (cats.kits) parts.push(`Kits: ${cats.kits.toLocaleString()}`);
    if (cats.gm) parts.push(`GM: ${cats.gm.toLocaleString()}`);
    if (cats.synth) parts.push(`Synth: ${cats.synth.toLocaleString()}`);
    if (cats.wavetable)
      parts.push(`Wavetable: ${cats.wavetable.toLocaleString()}`);
    if (cats.user) parts.push(`User: ${cats.user.toLocaleString()}`);
    soundBreakdownEl.textContent = parts.length ? parts.join(" \u00b7 ") : "";
  }

  // ─── Sample banks ─────────────────────────────────────────────────────

  async function refreshBanks() {
    if (!banksEl) return;
    banksEl.replaceChildren();
    try {
      const banks = await getUserSamples();
      if (banks.length === 0) {
        banksEl.appendChild(
          el("div", "settings-panel__empty", "No user samples imported yet."),
        );
        return;
      }
      for (const bank of banks) {
        const row = el("div", "settings-panel__bank-row");
        row.appendChild(el("span", "settings-panel__bank-name", bank.name));
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "settings-panel__bank-del";
        delBtn.title = `Delete "${bank.name}"`;
        delBtn.appendChild(makeIcon("trash-2", { size: 12 }));
        delBtn.addEventListener("click", async () => {
          const yes = await confirmFn(`Delete sample bank "${bank.name}"?`);
          if (!yes) return;
          await deleteUserSampleBank(bank.name);
          refreshBanks();
        });
        row.appendChild(delBtn);
        banksEl.appendChild(row);
      }
    } catch {
      banksEl.appendChild(
        el("div", "settings-panel__empty", "Failed to load user samples."),
      );
    }
  }

  // ─── Event handlers ───────────────────────────────────────────────────

  function onToggleClick(key) {
    const next = !settings[key];
    settings[key] = next;
    const btn = toggleButtons[key];
    if (btn) {
      btn.classList.toggle("is-on", next);
      btn.setAttribute("aria-checked", next ? "true" : "false");
    }
    toggleRows[key]?.classList.toggle("is-on", next);
    onChangeSetting(key, next);
  }

  function onPkgToggleClick(id) {
    const btn = pkgToggles[id];
    const row = pkgRows[id];
    if (!btn) return;
    const next = btn.getAttribute("aria-checked") !== "true";
    btn.classList.toggle("is-on", next);
    btn.setAttribute("aria-checked", next ? "true" : "false");
    row?.classList.toggle("is-on", next);

    const enabled = getEnabledPackages();
    const nextList = next
      ? [...new Set([...enabled, id])]
      : enabled.filter((x) => x !== id);
    setEnabledPackages(nextList);
    showReloadBanner();
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
    if (e.key === "Escape") {
      e.preventDefault();
      onFocusEditor();
    }
  }

  function updateAccentValueLabels(hue, light) {
    if (hueValueEl) hueValueEl.textContent = formatHue(hue);
    if (lightValueEl) lightValueEl.textContent = formatLightness(light);
  }

  // ─── DOM helpers ──────────────────────────────────────────────────────

  function buildSection(titleText) {
    const root = el("section", "settings-panel__section");
    root.appendChild(el("h3", "settings-panel__section-title", titleText));
    const body = el("div", "settings-panel__section-body");
    root.appendChild(body);
    return { root, body };
  }

  function buildRow(labelText) {
    const row = el("label", "settings-panel__row");
    row.appendChild(el("span", "settings-panel__row-label", labelText));
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
  return `${Math.round(Number(hue) || 0)}\u00b0`;
}

function formatLightness(lightness) {
  return `${Math.round((Number(lightness) || 0) * 100)}%`;
}
