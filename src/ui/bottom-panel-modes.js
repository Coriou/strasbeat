// Bottom panel mode switcher — a floating segmented pill in the top-right
// of the roll pane that toggles between Roll, Scope, Beat grid, and an
// optional Custom draw surface. Absolute-positioned so it never steals
// canvas height. Roll and Scope both render into the full #roll canvas;
// the beat grid is a flex sibling of the canvas that swaps into the same
// slot when active (see src/styles/beat-grid.css). All three views share
// the roll-pane height, so the divider at the top resizes them uniformly.
//
// Roll and Scope are always available. Beat grid only appears when the
// current pattern has at least one $: drum lane (editable or read-only)
// — see src/editor/drum-parse.js. Custom only appears when a pattern
// registers a custom draw function via setCustomDraw().
//
// The pill also carries a playback status dot (idle / queued / loading /
// playing) driven by transport.onPlaybackStateChange. It lives here
// because this strip is anchored to the roll canvas — the same place the
// user looks to decide "is this thing alive" — so a second indicator
// across the page would just split attention.

const MODES = [
  { id: "roll", label: "Roll" },
  { id: "scope", label: "Scope" },
  { id: "beats", label: "Beat grid" },
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
  let barEl = null;
  let toggleEl = null;
  let statusEl = null;
  let playbackState = "idle";
  const modesAvailable = new Set(["roll", "scope"]);
  const onChangeListeners = new Set();

  // Adds a mode-change listener. Multiple subscribers are allowed — main
  // wires beat grid visibility here, scope-controls wires its own strip.
  // Returns an unsubscribe fn.
  function setOnChange(fn) {
    if (typeof fn !== "function") return () => {};
    onChangeListeners.add(fn);
    return () => onChangeListeners.delete(fn);
  }

  function emitChange(mode) {
    for (const fn of onChangeListeners) {
      try {
        fn(mode);
      } catch (err) {
        console.warn("[bottom-panel] onChange listener threw:", err);
      }
    }
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
    emitChange(mode);
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

  // Beat grid availability is driven by the parser: visible iff the pattern
  // has at least one $: drum lane. We don't auto-switch when it appears
  // (unlike Custom) — the roll/scope already in view stays put; the user
  // opts into the grid when they want it. We do switch back to roll if the
  // grid disappears while it's the active view.
  function setBeatsAvailable(available) {
    if (available) {
      modesAvailable.add("beats");
    } else {
      modesAvailable.delete("beats");
      if (currentMode === "beats") setMode("roll");
    }
    updateToggle();
  }

  function mountToggle(container) {
    const bar = document.createElement("div");
    bar.className = "bottom-panel__bar";
    barEl = bar;

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

  function getBarEl() {
    return barEl;
  }

  return {
    getMode,
    setMode,
    setCustomDraw,
    getCustomDraw,
    setBeatsAvailable,
    mountToggle,
    getBarEl,
    setOnChange,
    setPlaybackState,
  };
}
