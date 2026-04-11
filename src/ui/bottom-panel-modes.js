// Bottom panel mode switcher — manages visualization modes (Roll / Scope / Custom).
// See design/work/14-strudel-learning-and-extensibility.md Phase 5.
//
// The tab bar only appears when more than one mode is available.
// When only Roll mode is in use, the UI is invisible — zero noise.

import { makeIcon } from "./icons.js";

const MODES = [
  { id: "roll", label: "Roll", icon: "bar-chart" },
  { id: "scope", label: "Scope", icon: "waves" },
  { id: "custom", label: "Custom", icon: "paintbrush" },
];

export function createBottomPanelModes() {
  let currentMode = "roll";
  let customDraw = null;
  let tabBarEl = null;
  let onChange = null;
  let modesAvailable = new Set(["roll"]);

  function setOnChange(fn) {
    onChange = fn;
  }

  function getMode() {
    return currentMode;
  }

  function setMode(mode) {
    if (mode === currentMode) return;
    if (!MODES.find((m) => m.id === mode)) return;
    currentMode = mode;
    modesAvailable.add(mode);
    updateTabBar();
    if (onChange) onChange(mode);
  }

  function setCustomDraw(fn) {
    customDraw = fn;
    if (fn) {
      modesAvailable.add("custom");
      if (currentMode !== "custom") setMode("custom");
    } else {
      modesAvailable.delete("custom");
      if (currentMode === "custom") setMode("roll");
    }
    updateTabBar();
  }

  function getCustomDraw() {
    return customDraw;
  }

  function enableScope() {
    modesAvailable.add("scope");
    updateTabBar();
  }

  // ─── Tab bar DOM ────────────────────────────────────────────────────

  function mountTabBar(container) {
    tabBarEl = document.createElement("div");
    tabBarEl.className = "bottom-panel__modes";
    tabBarEl.setAttribute("role", "tablist");
    tabBarEl.setAttribute("aria-label", "Visualization mode");

    for (const mode of MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bottom-panel__mode-btn";
      btn.dataset.mode = mode.id;
      btn.setAttribute("role", "tab");
      btn.setAttribute(
        "aria-selected",
        mode.id === currentMode ? "true" : "false",
      );
      btn.title = mode.label;
      btn.textContent = mode.label;
      btn.addEventListener("click", () => setMode(mode.id));
      tabBarEl.appendChild(btn);
    }

    container.prepend(tabBarEl);
    updateTabBar();
  }

  function updateTabBar() {
    if (!tabBarEl) return;
    const showBar = modesAvailable.size > 1;
    tabBarEl.hidden = !showBar;

    for (const btn of tabBarEl.querySelectorAll(".bottom-panel__mode-btn")) {
      const mode = btn.dataset.mode;
      const isActive = mode === currentMode;
      const isAvailable = modesAvailable.has(mode);
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
      btn.hidden = !isAvailable;
    }
  }

  return {
    getMode,
    setMode,
    setCustomDraw,
    getCustomDraw,
    enableScope,
    mountTabBar,
    setOnChange,
  };
}
