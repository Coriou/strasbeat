// MIDI bar — dedicated performance strip for live MIDI input.
// Auto-shows when a MIDI device connects, auto-hides when disconnected.
// Renders: mini-keyboard, note/chord display, octave shift, volume,
// preset picker popover, sustain lamp, capture button.
//
// See design/work/13-midi-experience.md.

import {
  presets,
  PRESET_CATEGORIES,
  midiToNoteName,
  detectChord,
} from "../midi-bridge.js";
import { superdough, getAudioContext } from "@strudel/webaudio";

// ─── Mini-keyboard renderer ──────────────────────────────────────────────
// 2-octave (24-key) piano visualization on a <canvas>.

const KB_OCTAVES = 2;
const KB_WHITE_KEYS = KB_OCTAVES * 7;
const KB_NOTE_PATTERN = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]; // 0=white, 1=black
const FADE_MS = 800; // key-release fade duration

function drawKeyboard(canvas, activeNotes, fadingNotes, octaveShift) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  // Size the backing store to match CSS size × dpr (same approach as piano-roll).
  const cssW = canvas.clientWidth || 140;
  const cssH = canvas.clientHeight || 22;
  const bufW = Math.round(cssW * dpr);
  const bufH = Math.round(cssH * dpr);
  if (canvas.width !== bufW || canvas.height !== bufH) {
    canvas.width = bufW;
    canvas.height = bufH;
  }

  // Work in CSS-pixel coordinates — scale the context by dpr.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Read design tokens so the accent color stays in sync with user overrides.
  const cs = getComputedStyle(canvas);
  const accent =
    cs.getPropertyValue("--accent").trim() || "oklch(0.63 0.19 358)";
  const whiteKeyColor =
    cs.getPropertyValue("--text").trim() || "oklch(0.9 0 0)";
  const blackKeyColor =
    cs.getPropertyValue("--surface-0").trim() || "oklch(0.16 0 0)";
  const borderColor =
    cs.getPropertyValue("--border").trim() || "oklch(0.3 0 0)";

  const w = cssW;
  const h = cssH;

  // The keyboard shows 2 octaves centered around C3-B4 (MIDI 48-71),
  // shifted by the octave offset.
  const baseNote = 48 + octaveShift * 12;
  const whiteKeyW = w / KB_WHITE_KEYS;
  const blackKeyW = whiteKeyW * 0.6;
  const blackKeyH = h * 0.6;

  // Collect white and black key positions
  const keys = [];
  let whiteIdx = 0;
  for (let i = 0; i < KB_OCTAVES * 12; i++) {
    const midi = baseNote + i;
    const isBlack = KB_NOTE_PATTERN[i % 12] === 1;
    if (isBlack) {
      const x = whiteIdx * whiteKeyW - blackKeyW / 2;
      keys.push({ midi, x, w: blackKeyW, h: blackKeyH, black: true });
    } else {
      keys.push({
        midi,
        x: whiteIdx * whiteKeyW,
        w: whiteKeyW,
        h,
        black: false,
      });
      whiteIdx++;
    }
  }

  // Draw white keys first
  for (const k of keys) {
    if (k.black) continue;
    const active = activeNotes.has(k.midi);
    const fading = !active && fadingNotes.has(k.midi);
    if (active) {
      const vel = activeNotes.get(k.midi).velocity;
      ctx.globalAlpha = 0.4 + vel * 0.5;
      ctx.fillStyle = accent;
    } else if (fading) {
      const { velocity: vel, startedAt } = fadingNotes.get(k.midi);
      const t = Math.min((performance.now() - startedAt) / FADE_MS, 1);
      ctx.globalAlpha = (1 - t) * (0.4 + vel * 0.5);
      ctx.fillStyle = accent;
    } else {
      ctx.globalAlpha = 1;
      ctx.fillStyle = whiteKeyColor;
    }
    ctx.fillRect(k.x + 0.5, 0, k.w - 1, k.h);
    // Key border
    ctx.globalAlpha = 1;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(k.x + 0.5, 0, k.w - 1, k.h);
  }

  // Draw black keys on top
  for (const k of keys) {
    if (!k.black) continue;
    const active = activeNotes.has(k.midi);
    const fading = !active && fadingNotes.has(k.midi);
    if (active) {
      const vel = activeNotes.get(k.midi).velocity;
      ctx.globalAlpha = 0.5 + vel * 0.4;
      ctx.fillStyle = accent;
    } else if (fading) {
      const { velocity: vel, startedAt } = fadingNotes.get(k.midi);
      const t = Math.min((performance.now() - startedAt) / FADE_MS, 1);
      ctx.globalAlpha = (1 - t) * (0.5 + vel * 0.4);
      ctx.fillStyle = accent;
    } else {
      ctx.globalAlpha = 1;
      ctx.fillStyle = blackKeyColor;
    }
    ctx.fillRect(k.x, 0, k.w, k.h);
  }
  ctx.globalAlpha = 1;
}

// ─── Mount ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container         #midi-bar
 * @param {import('../midi-bridge.js').MidiBridge} opts.midi
 * @param {() => string} opts.getPreset        current preset key
 * @param {(key: string) => void} opts.onPresetChange
 * @returns {{ dispose: () => void, setCaptureState: (s: {recording: boolean, count?: number}) => void }}
 */
export function mountMidiBar({ container, midi, getPreset, onPresetChange }) {
  // ─── Build DOM ──────────────────────────────────────────────────────
  container.innerHTML = "";

  // Mini-keyboard canvas
  const kbCanvas = document.createElement("canvas");
  kbCanvas.className = "midi-bar__keyboard";
  kbCanvas.setAttribute("role", "img");
  kbCanvas.setAttribute(
    "aria-label",
    "MIDI keyboard — active keys highlighted",
  );
  container.appendChild(kbCanvas);

  // Note / chord display
  const noteEl = document.createElement("span");
  noteEl.className = "midi-bar__note";
  noteEl.textContent = "";
  container.appendChild(noteEl);

  // Sep
  container.appendChild(makeSep());

  // Octave shift
  const octGroup = document.createElement("div");
  octGroup.className = "midi-bar__octave";
  const octDown = makeBtn("midi-bar__oct-btn", "−");
  octDown.title = "Octave down";
  octDown.setAttribute("aria-label", "Decrease octave");
  const octLabel = document.createElement("span");
  octLabel.className = "midi-bar__oct-label";
  octLabel.textContent = "0";
  const octUp = makeBtn("midi-bar__oct-btn", "+");
  octUp.title = "Octave up";
  octUp.setAttribute("aria-label", "Increase octave");
  octGroup.append(octDown, octLabel, octUp);
  container.appendChild(octGroup);

  // Sep
  container.appendChild(makeSep());

  // Volume
  const volGroup = document.createElement("div");
  volGroup.className = "midi-bar__volume";
  const volIcon = document.createElement("span");
  volIcon.className = "midi-bar__vol-icon btn__icon";
  volIcon.setAttribute("data-icon", "volume-2");
  const volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.className = "midi-bar__vol-slider";
  volSlider.min = "0";
  volSlider.max = "100";
  volSlider.value = String(Math.round(midi.getVolume() * 100));
  volSlider.title = "MIDI volume";
  volSlider.setAttribute("aria-label", "MIDI volume");
  const volLabel = document.createElement("span");
  volLabel.className = "midi-bar__vol-label";
  volLabel.textContent = `${volSlider.value}%`;
  volGroup.append(volIcon, volSlider, volLabel);
  container.appendChild(volGroup);

  // Spacer
  const spacer = document.createElement("div");
  spacer.className = "midi-bar__spacer";
  container.appendChild(spacer);

  // Preset picker button
  const presetBtn = document.createElement("button");
  presetBtn.type = "button";
  presetBtn.className = "midi-bar__preset-btn";
  presetBtn.setAttribute("aria-haspopup", "listbox");
  presetBtn.setAttribute("aria-expanded", "false");
  presetBtn.innerHTML = `<span class="midi-bar__preset-label">${presets[getPreset()]?.label ?? getPreset()}</span><span class="midi-bar__preset-chevron" aria-hidden="true">▾</span>`;
  container.appendChild(presetBtn);
  const presetLabelEl = presetBtn.querySelector(".midi-bar__preset-label");

  // Preset popover (initially hidden)
  const popover = buildPresetPopover(getPreset, (key) => {
    onPresetChange(key);
    presetLabelEl.textContent = presets[key]?.label ?? key;
    closePopover();
    popover._updateFxSliders();
  }, midi);
  popover.setAttribute("role", "listbox");
  popover.setAttribute("aria-label", "MIDI preset");
  document.body.appendChild(popover);

  // Sep
  container.appendChild(makeSep());

  // Sustain lamp
  const susGroup = document.createElement("div");
  susGroup.className = "midi-bar__sustain-group";
  const susLamp = document.createElement("div");
  susLamp.className = "midi-bar__sustain";
  susLamp.title = "Sustain pedal (CC64)";
  const susLabel = document.createElement("span");
  susLabel.className = "midi-bar__sustain-label";
  susLabel.textContent = "sus";
  susGroup.append(susLamp, susLabel);
  container.appendChild(susGroup);

  // Sep
  container.appendChild(makeSep());

  // Capture button (migrated from transport)
  const captureBtn = document.createElement("button");
  captureBtn.type = "button";
  captureBtn.id = "capture";
  captureBtn.className = "btn btn--icon capture";
  captureBtn.title =
    "Toggle live MIDI capture — click again to save the captured phrase";
  captureBtn.setAttribute("aria-label", "Capture");
  captureBtn.innerHTML = `<span class="btn__icon" data-icon="disc"></span><span id="capture-count" class="capture__count"></span>`;
  container.appendChild(captureBtn);

  // ─── Event handlers ─────────────────────────────────────────────────

  // Octave shift
  function updateOctLabel() {
    const v = midi.getOctaveShift();
    octLabel.textContent = v === 0 ? "0" : v > 0 ? `+${v}` : String(v);
  }
  octDown.addEventListener("click", () => {
    midi.setOctaveShift(midi.getOctaveShift() - 1);
    updateOctLabel();
    persistState();
    redrawKeyboard();
  });
  octUp.addEventListener("click", () => {
    midi.setOctaveShift(midi.getOctaveShift() + 1);
    updateOctLabel();
    persistState();
    redrawKeyboard();
  });

  // Volume slider
  volSlider.addEventListener("input", () => {
    const v = Number(volSlider.value) / 100;
    midi.setVolume(v);
    volLabel.textContent = `${volSlider.value}%`;
    persistState();
  });

  // Preset popover open/close
  let popoverOpen = false;
  function openPopover() {
    const rect = presetBtn.getBoundingClientRect();
    const popW = 200; // matches CSS width
    // Clamp horizontal: don't overflow right edge.
    const left = Math.min(rect.left, window.innerWidth - popW - 8);
    popover.style.left = `${Math.max(0, left)}px`;
    // Position above the button; clamp so it doesn't overflow the top.
    const idealBottom = window.innerHeight - rect.top + 4;
    const maxBottom = window.innerHeight - 8; // leave 8px top margin
    popover.style.bottom = `${Math.min(idealBottom, maxBottom)}px`;
    popover.hidden = false;
    popoverOpen = true;
    presetBtn.setAttribute("aria-expanded", "true");
    const filter = popover.querySelector(".midi-bar__preset-filter");
    if (filter) {
      filter.value = "";
      filterPresets("");
      filter.focus();
    }
    updatePopoverSelection();
    popover._updateFxSliders();
  }
  function closePopover() {
    popover.hidden = true;
    popoverOpen = false;
    presetBtn.setAttribute("aria-expanded", "false");
  }
  presetBtn.addEventListener("click", () => {
    if (popoverOpen) closePopover();
    else openPopover();
  });
  function onDocMousedown(e) {
    if (
      popoverOpen &&
      !popover.contains(e.target) &&
      !presetBtn.contains(e.target)
    ) {
      closePopover();
    }
  }
  function onDocKeydown(e) {
    if (popoverOpen && e.key === "Escape") {
      closePopover();
      presetBtn.focus();
    }
  }
  document.addEventListener("mousedown", onDocMousedown);
  document.addEventListener("keydown", onDocKeydown);

  // Note display + keyboard redraw on noteon
  let noteFadeTimer = null;
  function onNoteOn({ midi: midiNote, velocity, noteName }) {
    fadingNotes.delete(midiNote); // cancel any in-progress fade for re-struck key
    // Update note/chord display
    const activeKeys = [...midi.activeNotes.keys()];
    if (activeKeys.length > 1) {
      const chord = detectChord(activeKeys);
      noteEl.textContent = chord ?? activeKeys.map(midiToNoteName).join(" ");
    } else {
      noteEl.textContent = noteName;
    }
    noteEl.classList.remove("midi-bar__note--faded");
    clearTimeout(noteFadeTimer);
    noteFadeTimer = setTimeout(
      () => noteEl.classList.add("midi-bar__note--faded"),
      1500,
    );
    redrawKeyboard();
  }
  function onNoteOff({ midi: midiNote, velocity }) {
    // Start progressive fade for the released key
    fadingNotes.set(midiNote, {
      velocity: velocity ?? 0.5,
      startedAt: performance.now(),
    });
    startFadeLoop();
    // Update chord display if notes remain
    const activeKeys = [...midi.activeNotes.keys()];
    if (activeKeys.length > 1) {
      const chord = detectChord(activeKeys);
      noteEl.textContent = chord ?? activeKeys.map(midiToNoteName).join(" ");
    } else if (activeKeys.length === 1) {
      noteEl.textContent = midiToNoteName(activeKeys[0]);
    } else {
      // All notes released — start fade so the last chord/note text
      // doesn't linger indefinitely.
      clearTimeout(noteFadeTimer);
      noteFadeTimer = setTimeout(
        () => noteEl.classList.add("midi-bar__note--faded"),
        1500,
      );
    }
  }
  midi.on("noteon", onNoteOn);
  midi.on("noteoff", onNoteOff);

  // Sustain lamp
  function onSustain({ down }) {
    susLamp.classList.toggle("midi-bar__sustain--active", down);
  }
  midi.on("sustain", onSustain);

  // Auto-show/hide based on device connectivity
  function onDeviceChange({ devices }) {
    container.hidden = devices.length === 0;
    // Clear stale visual state when all devices disconnect so the bar
    // doesn't re-show with ghost active notes / lit sustain lamp.
    if (devices.length === 0) {
      noteEl.textContent = "";
      noteEl.classList.remove("midi-bar__note--faded");
      clearTimeout(noteFadeTimer);
      fadingNotes.clear();
      if (fadeAnimId !== null) {
        cancelAnimationFrame(fadeAnimId);
        fadeAnimId = null;
      }
      susLamp.classList.remove("midi-bar__sustain--active");
      redrawKeyboard();
    }
  }
  midi.on("devicechange", onDeviceChange);
  // Set initial state
  container.hidden = !midi.hasDevices();

  // ─── Keyboard rendering (with progressive fade) ──────────────────────
  /** @type {Map<number, {velocity: number, startedAt: number}>} */
  const fadingNotes = new Map();
  let fadeAnimId = null;
  let kbRafPending = false;

  function _fadeFrame() {
    const now = performance.now();
    for (const [m, f] of fadingNotes) {
      if (now - f.startedAt >= FADE_MS) fadingNotes.delete(m);
    }
    drawKeyboard(kbCanvas, midi.activeNotes, fadingNotes, midi.getOctaveShift());
    if (fadingNotes.size > 0) {
      fadeAnimId = requestAnimationFrame(_fadeFrame);
    } else {
      fadeAnimId = null;
    }
  }

  function startFadeLoop() {
    if (fadeAnimId === null) {
      fadeAnimId = requestAnimationFrame(_fadeFrame);
    }
  }

  function redrawKeyboard() {
    if (fadeAnimId !== null) return; // fade loop already redraws every frame
    if (kbRafPending) return;
    kbRafPending = true;
    requestAnimationFrame(() => {
      kbRafPending = false;
      drawKeyboard(kbCanvas, midi.activeNotes, fadingNotes, midi.getOctaveShift());
    });
  }
  // Initial draw (synchronous, canvas is empty).
  drawKeyboard(kbCanvas, midi.activeNotes, fadingNotes, midi.getOctaveShift());

  // ─── Persistence (localStorage) ─────────────────────────────────────
  const STORAGE_KEY = "strasbeat:midi-bar";
  function persistState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          volume: midi.getVolume(),
          octaveShift: midi.getOctaveShift(),
          preset: getPreset(),
        }),
      );
    } catch (_) {
      /* quota etc */
    }
  }
  function restoreState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.volume === "number") {
        midi.setVolume(s.volume);
        volSlider.value = String(Math.round(s.volume * 100));
        volLabel.textContent = `${volSlider.value}%`;
      }
      if (typeof s.octaveShift === "number") {
        midi.setOctaveShift(s.octaveShift);
        updateOctLabel();
      }
      if (typeof s.preset === "string" && presets[s.preset]) {
        onPresetChange(s.preset);
        presetLabelEl.textContent = presets[s.preset].label ?? s.preset;
      }
    } catch (_) {
      /* corrupted */
    }
  }
  restoreState();

  // ─── Capture state (called from main.js) ────────────────────────────
  const captureBadge = captureBtn.querySelector("#capture-count");
  function setCaptureState({ recording, count }) {
    captureBtn.classList.toggle("recording", !!recording);
    captureBtn.setAttribute("aria-pressed", recording ? "true" : "false");
    if (count != null && captureBadge) captureBadge.textContent = String(count);
    if (!recording && captureBadge) captureBadge.textContent = "";
  }

  // ─── Popover internals ──────────────────────────────────────────────
  function updatePopoverSelection() {
    const current = getPreset();
    for (const item of popover.querySelectorAll(".midi-bar__preset-item")) {
      item.classList.toggle("is-selected", item.dataset.key === current);
    }
  }

  let previewTimer = null;
  function startPreview(key) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const p = presets[key];
      if (!p || p.drumMap) return;
      const ctx = getAudioContext();
      if (!ctx || ctx.state !== "running") return;
      const now = ctx.currentTime;
      const value = {
        s: p.s,
        note: 60, // C4
        velocity: 0.5,
        gain: midi.getVolume() * 0.5,
        ...(p.attack != null && { attack: p.attack }),
        ...(p.decay != null && { decay: Math.min(p.decay, 1) }),
        ...(p.sustain != null && { sustain: 0 }),
        ...(p.release != null && { release: Math.min(p.release, 0.3) }),
        ...(p.room != null && { room: p.room }),
      };
      Promise.resolve(superdough(value, now + 0.01, 0.5)).catch(() => {});
    }, 300);
  }
  function stopPreview() {
    clearTimeout(previewTimer);
  }

  function filterPresets(query) {
    const q = query.toLowerCase();
    for (const item of popover.querySelectorAll(".midi-bar__preset-item")) {
      item.hidden = q && !item.textContent.toLowerCase().includes(q);
    }
    for (const cat of popover.querySelectorAll(".midi-bar__preset-category")) {
      // Hide category if all its items are hidden
      let next = cat.nextElementSibling;
      let anyVisible = false;
      while (next && !next.classList.contains("midi-bar__preset-category")) {
        if (!next.hidden) anyVisible = true;
        next = next.nextElementSibling;
      }
      cat.hidden = !anyVisible;
    }
  }

  // Wire popover events
  const filterInput = popover.querySelector(".midi-bar__preset-filter");
  if (filterInput) {
    filterInput.addEventListener("input", () =>
      filterPresets(filterInput.value),
    );
  }

  // Preview on hover (spec: 300ms debounce via startPreview).
  for (const item of popover.querySelectorAll(".midi-bar__preset-item")) {
    item.addEventListener("mouseenter", () => startPreview(item.dataset.key));
    item.addEventListener("mouseleave", () => stopPreview());
  }

  // Keyboard nav inside popover
  popover.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [
        ...popover.querySelectorAll(".midi-bar__preset-item:not([hidden])"),
      ];
      const focused = popover.querySelector(
        ".midi-bar__preset-item.is-focused",
      );
      let idx = items.indexOf(focused);
      if (focused) focused.classList.remove("is-focused");
      idx = e.key === "ArrowDown" ? idx + 1 : idx - 1;
      if (idx < 0) idx = items.length - 1;
      if (idx >= items.length) idx = 0;
      if (items[idx]) {
        items[idx].classList.add("is-focused");
        items[idx].scrollIntoView({ block: "nearest" });
        startPreview(items[idx].dataset.key);
      }
    }
    if (e.key === "Enter") {
      const focused = popover.querySelector(
        ".midi-bar__preset-item.is-focused",
      );
      if (focused) focused.click();
    }
    // Tab focus trap — cycle within the popover when open.
    if (e.key === "Tab") {
      const focusable = [
        ...popover.querySelectorAll(
          'input, button:not([hidden]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hidden && el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // ─── Dispose ────────────────────────────────────────────────────────
  function dispose() {
    midi.off("noteon", onNoteOn);
    midi.off("noteoff", onNoteOff);
    midi.off("sustain", onSustain);
    midi.off("devicechange", onDeviceChange);
    document.removeEventListener("mousedown", onDocMousedown);
    document.removeEventListener("keydown", onDocKeydown);
    clearTimeout(noteFadeTimer);
    clearTimeout(previewTimer);
    fadingNotes.clear();
    if (fadeAnimId !== null) {
      cancelAnimationFrame(fadeAnimId);
      fadeAnimId = null;
    }
    if (popover.parentNode) popover.parentNode.removeChild(popover);
  }

  return {
    dispose,
    setCaptureState,
    getCaptureButton: () => captureBtn,
    persistState,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeSep() {
  const el = document.createElement("span");
  el.className = "midi-bar__sep";
  el.setAttribute("aria-hidden", "true");
  return el;
}

function makeBtn(cls, text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  btn.textContent = text;
  return btn;
}

function buildPresetPopover(getPreset, onSelect, midi) {
  const popover = document.createElement("div");
  popover.className = "midi-bar__preset-popover";
  popover.hidden = true;

  // Filter input
  const filter = document.createElement("input");
  filter.type = "text";
  filter.className = "midi-bar__preset-filter";
  filter.placeholder = "Filter…";
  popover.appendChild(filter);

  // Scrollable preset list
  const listWrap = document.createElement("div");
  listWrap.className = "midi-bar__preset-list";
  popover.appendChild(listWrap);

  // Group presets by category
  const byCategory = new Map();
  for (const cat of PRESET_CATEGORIES) byCategory.set(cat, []);
  for (const [key, p] of Object.entries(presets)) {
    const cat = p.category ?? "Other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push({ key, label: p.label ?? key });
  }

  for (const [cat, items] of byCategory) {
    if (items.length === 0) continue;
    const catEl = document.createElement("div");
    catEl.className = "midi-bar__preset-category";
    catEl.textContent = cat;
    listWrap.appendChild(catEl);

    for (const { key, label } of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "midi-bar__preset-item";
      item.setAttribute("role", "option");
      item.dataset.key = key;
      item.textContent = label;
      item.addEventListener("click", () => onSelect(key));
      item.addEventListener("mouseenter", () => {
        // Remove previous keyboard-nav focus
        const prev = listWrap.querySelector(".is-focused");
        if (prev) prev.classList.remove("is-focused");
      });
      listWrap.appendChild(item);
    }
  }

  // ─── FX sliders section ─────────────────────────────────────────────
  const fxSection = document.createElement("div");
  fxSection.className = "midi-bar__fx-section";

  const FX_DEFS = [
    { param: "room", label: "Room", min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + "%" },
    { param: "delay", label: "Delay", min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + "%" },
    { param: "lpf", label: "LPF", min: 200, max: 20000, step: 100, fmt: (v) => v >= 10000 ? (v / 1000).toFixed(1) + "k" : Math.round(v) + "" },
  ];

  const fxSliders = {};
  for (const def of FX_DEFS) {
    const row = document.createElement("div");
    row.className = "midi-bar__fx-row";

    const lbl = document.createElement("label");
    lbl.className = "midi-bar__fx-label";
    lbl.textContent = def.label;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "midi-bar__fx-slider";
    slider.min = String(def.min);
    slider.max = String(def.max);
    slider.step = String(def.step);

    const valEl = document.createElement("span");
    valEl.className = "midi-bar__fx-value";

    lbl.setAttribute("for", `midi-fx-${def.param}`);
    slider.id = `midi-fx-${def.param}`;

    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      valEl.textContent = def.fmt(v);
      midi.setPresetOverride(getPreset(), def.param, v);
    });

    row.append(lbl, slider, valEl);
    fxSection.appendChild(row);
    fxSliders[def.param] = { slider, valEl, def };
  }

  popover.appendChild(fxSection);

  /** Sync slider positions with the current preset's values + any overrides. */
  popover._updateFxSliders = () => {
    const key = getPreset();
    const preset = presets[key];
    const overrides = midi.getPresetOverrides(key);
    for (const { param, def } of Object.values(fxSliders).map((o) => ({ param: o.def.param, def: o.def }))) {
      const fx = fxSliders[param];
      const base = param === "lpf" ? (preset?.[param] ?? 20000) : (preset?.[param] ?? 0);
      const val = overrides[param] ?? base;
      fx.slider.value = String(val);
      fx.valEl.textContent = fx.def.fmt(val);
    }
  };

  return popover;
}
