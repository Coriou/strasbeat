// Bottom panel mode switcher — a floating segmented pill in the top-right
// of the roll pane that toggles between Roll, Scope, and an optional
// Custom draw surface. Absolute-positioned so it never steals canvas
// height — the roll and scope both render into the full #roll canvas.
//
// Roll and Scope are always available; Custom only appears when a
// pattern registers a custom draw function via setCustomDraw().
//
// The pill also carries a playback status dot (idle / queued / loading /
// playing) driven by transport.onPlaybackStateChange. It lives here
// because this strip is anchored to the roll canvas — the same place the
// user looks to decide "is this thing alive" — so a second indicator
// across the page would just split attention.

const MODES = [
  { id: "roll", label: "Roll" },
  { id: "scope", label: "Scope" },
  { id: "custom", label: "Custom" },
];

const PLAYBACK_LABELS = {
  idle: "Stopped",
  queued: "Queued",
  loading: "Loading",
  playing: "Playing",
};

export function createBottomPanelModes() {
  let currentMode = "roll";
  let customDraw = null;
  let toggleEl = null;
  let statusEl = null;
  let onChange = null;
  let playbackState = "idle";
  const modesAvailable = new Set(["roll", "scope"]);

  function setOnChange(fn) {
    onChange = fn;
  }

  function getMode() {
    return currentMode;
  }

  function setMode(mode) {
    if (mode === currentMode) return;
    if (!MODES.find((m) => m.id === mode)) return;
    if (!modesAvailable.has(mode)) return;
    currentMode = mode;
    updateToggle();
    if (onChange) onChange(mode);
  }

  function setCustomDraw(fn) {
    customDraw = fn;
    if (fn) {
      modesAvailable.add("custom");
      setMode("custom");
    } else {
      modesAvailable.delete("custom");
      if (currentMode === "custom") setMode("roll");
    }
    updateToggle();
  }

  function getCustomDraw() {
    return customDraw;
  }

  function mountToggle(container) {
    const bar = document.createElement("div");
    bar.className = "bottom-panel__bar";

    statusEl = document.createElement("div");
    statusEl.className = "bottom-panel__status";
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    statusEl.innerHTML =
      '<span class="bottom-panel__status-dot" aria-hidden="true"></span>' +
      '<span class="bottom-panel__status-label"></span>';
    bar.appendChild(statusEl);

    toggleEl = document.createElement("div");
    toggleEl.className = "bottom-panel__modes";
    toggleEl.setAttribute("role", "tablist");
    toggleEl.setAttribute("aria-label", "Bottom panel view");

    for (const mode of MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bottom-panel__mode-btn";
      btn.dataset.mode = mode.id;
      btn.setAttribute("role", "tab");
      btn.textContent = mode.label;
      btn.addEventListener("click", () => setMode(mode.id));
      toggleEl.appendChild(btn);
    }
    bar.appendChild(toggleEl);

    container.appendChild(bar);
    updateToggle();
    updateStatus();
  }

  function updateToggle() {
    if (!toggleEl) return;
    for (const btn of toggleEl.querySelectorAll(".bottom-panel__mode-btn")) {
      const mode = btn.dataset.mode;
      const isActive = mode === currentMode;
      const isAvailable = modesAvailable.has(mode);
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
      btn.hidden = !isAvailable;
    }
  }

  function setPlaybackState(state) {
    if (!PLAYBACK_LABELS[state]) return;
    playbackState = state;
    updateStatus();
  }

  function updateStatus() {
    if (!statusEl) return;
    statusEl.dataset.state = playbackState;
    const label = PLAYBACK_LABELS[playbackState];
    statusEl.setAttribute("aria-label", label);
    const labelEl = statusEl.querySelector(".bottom-panel__status-label");
    if (labelEl) labelEl.textContent = label;
  }

  return {
    getMode,
    setMode,
    setCustomDraw,
    getCustomDraw,
    mountToggle,
    setOnChange,
    setPlaybackState,
  };
}
