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
import {
  getMidiOutputState,
  getMidiOutputs,
  getMidiOutputDevice,
  setMidiOutputDevice,
  onMidiOutputChange,
  enableMidiOutput,
  resolveMidiOutputName,
  getEnabledPackages,
} from "../user-setup.js";
import { isExportRunning } from "../export.js";
import { makeIcon } from "./icons.js";

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

  // Device selector (only visible when >1 device connected)
  const deviceGroup = document.createElement("div");
  deviceGroup.className = "midi-bar__device";
  deviceGroup.hidden = true;
  const deviceSelect = document.createElement("select");
  deviceSelect.className = "midi-bar__device-select";
  deviceSelect.title = "MIDI input device";
  deviceSelect.setAttribute("aria-label", "MIDI input device");
  deviceGroup.appendChild(deviceSelect);
  container.appendChild(deviceGroup);

  // ─── MIDI output device selector ────────────────────────────────────
  // Visible only when @strudel/midi is enabled as an opt-in package.
  const midiOutputEnabled = getEnabledPackages().includes("midi");
  const outGroup = document.createElement("div");
  outGroup.className = "midi-bar__output";
  outGroup.hidden = !midiOutputEnabled;
  const outLabel = document.createElement("span");
  outLabel.className = "midi-bar__output-label";
  outLabel.textContent = "Out";
  const outSelect = document.createElement("select");
  outSelect.className = "midi-bar__device-select";
  outSelect.title = "MIDI output device";
  outSelect.setAttribute("aria-label", "MIDI output device");
  // Enable / Retry — shown instead of a dead selector while MIDI output has
  // no browser permission yet (or was refused it).
  const outEnableBtn = makeBtn("midi-bar__out-btn", "Enable");
  outEnableBtn.hidden = true;
  const outDot = document.createElement("span");
  outDot.className = "midi-bar__output-dot";
  outDot.setAttribute("role", "img");
  outGroup.append(outLabel, outSelect, outEnableBtn, outDot);
  if (midiOutputEnabled) container.appendChild(outGroup);

  // Sep (only if output is present)
  if (midiOutputEnabled) container.appendChild(makeSep());

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

  // Sep
  container.appendChild(makeSep());

  // Velocity curve toggle (segmented: Soft / Linear / Hard)
  const velGroup = document.createElement("div");
  velGroup.className = "midi-bar__velocity-curve";
  velGroup.title = "Velocity curve";
  velGroup.setAttribute("role", "group");
  velGroup.setAttribute("aria-label", "Velocity curve");
  const VELOCITY_MODES = ["soft", "linear", "hard"];
  const velBtns = {};
  for (const mode of VELOCITY_MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "midi-bar__vel-btn";
    btn.textContent = mode[0].toUpperCase() + mode.slice(1);
    btn.dataset.mode = mode;
    btn.addEventListener("click", () => {
      midi.setVelocityCurve(mode);
      syncVelocityButtons();
      persistState();
    });
    velGroup.appendChild(btn);
    velBtns[mode] = btn;
  }
  function syncVelocityButtons() {
    const current = midi.getVelocityCurve();
    for (const [mode, b] of Object.entries(velBtns)) {
      b.classList.toggle("is-active", mode === current);
      b.setAttribute("aria-pressed", mode === current ? "true" : "false");
    }
  }
  syncVelocityButtons();
  container.appendChild(velGroup);

  // Spacer
  const spacer = document.createElement("div");
  spacer.className = "midi-bar__spacer";
  container.appendChild(spacer);

  // Preset picker button
  const presetBtn = document.createElement("button");
  presetBtn.type = "button";
  presetBtn.className = "midi-bar__preset-btn";
  presetBtn.setAttribute("aria-haspopup", "dialog");
  presetBtn.setAttribute("aria-expanded", "false");
  const presetLabelEl = document.createElement("span");
  presetLabelEl.className = "midi-bar__preset-label";
  presetLabelEl.textContent = presets[getPreset()]?.label ?? getPreset();
  const presetChevron = makeIcon("chevron-down", { size: 12 });
  presetChevron.classList.add("midi-bar__preset-chevron");
  presetBtn.append(presetLabelEl, presetChevron);
  function setPresetLabel(key) {
    const label = presets[key]?.label ?? key;
    presetLabelEl.textContent = label;
    presetBtn.setAttribute("aria-label", `MIDI preset: ${label}`);
  }
  setPresetLabel(getPreset());
  container.appendChild(presetBtn);

  // Preset popover (initially hidden)
  const popover = buildPresetPopover(
    getPreset,
    (key) => {
      onPresetChange(key);
      setPresetLabel(key);
      closePopover();
      popover._updateFxSliders();
    },
    midi,
  );
  // The popover holds a filter field, the preset list and the FX sliders, so
  // it is a dialog; only the list inside it is the listbox.
  popover.setAttribute("role", "dialog");
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
  susLamp.setAttribute("role", "img");
  susLamp.setAttribute("aria-label", "Sustain pedal: up");
  const susLabel = document.createElement("span");
  susLabel.className = "midi-bar__sustain-label";
  susLabel.setAttribute("aria-hidden", "true");
  susLabel.textContent = "sus";
  susGroup.append(susLamp, susLabel);
  container.appendChild(susGroup);

  // Mod wheel indicator (thin bar + label, near sustain)
  const modGroup = document.createElement("div");
  modGroup.className = "midi-bar__mod-group";
  const modBar = document.createElement("div");
  modBar.className = "midi-bar__mod-bar";
  modBar.title = "Mod wheel (CC1) — closes a low-pass filter on live notes";
  modBar.setAttribute("role", "img");
  modBar.setAttribute("aria-label", "Mod wheel: 0%");
  const modFill = document.createElement("div");
  modFill.className = "midi-bar__mod-fill";
  modFill.style.height = "0%";
  modBar.appendChild(modFill);
  const modLabel = document.createElement("span");
  modLabel.className = "midi-bar__mod-label";
  modLabel.setAttribute("aria-hidden", "true");
  modLabel.textContent = "mod";
  modGroup.append(modBar, modLabel);
  container.appendChild(modGroup);

  // Sep
  container.appendChild(makeSep());

  // Metronome toggle + BPM
  const metGroup = document.createElement("div");
  metGroup.className = "midi-bar__metronome";
  const metBtn = document.createElement("button");
  metBtn.type = "button";
  metBtn.className = "midi-bar__met-btn";
  metBtn.title = "Toggle metronome for capture";
  metBtn.setAttribute("aria-label", "Metronome");
  metBtn.setAttribute("aria-pressed", "false");
  metBtn.innerHTML = `<span class="btn__icon" data-icon="timer"></span>`;
  const metBpmEl = document.createElement("span");
  metBpmEl.className = "midi-bar__met-bpm";
  metBpmEl.textContent = "";
  metGroup.append(metBtn, metBpmEl);
  container.appendChild(metGroup);

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
  captureBtn.setAttribute("aria-pressed", "false");
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

  // Device selector
  function rebuildDeviceSelect(devices) {
    deviceSelect.innerHTML = "";
    if (devices.length <= 1) {
      deviceGroup.hidden = true;
      return;
    }
    deviceGroup.hidden = false;
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All devices";
    deviceSelect.appendChild(allOpt);
    for (const d of devices) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.name || d.id;
      deviceSelect.appendChild(opt);
    }
    deviceSelect.value = midi.getSelectedDevice() ?? "";
  }
  deviceSelect.addEventListener("change", () => {
    const id = deviceSelect.value || null;
    midi.setSelectedDevice(id);
    persistState();
  });

  // ─── MIDI output device selector ────────────────────────────────────
  let unsubMidiOutput = null;
  if (midiOutputEnabled) {
    function rebuildOutputSelect() {
      outSelect.innerHTML = "";
      const state = getMidiOutputState();
      outGroup.hidden = false;

      if (state !== "ready") {
        // No device list without browser permission: say why, and offer the
        // click that asks for it rather than a selector stuck on "Loading…".
        const copy = {
          off: ["Loading…", null, "MIDI output is loading"],
          enabling: ["Waiting…", null, "Waiting for MIDI permission…"],
          idle: [
            "Off",
            "Enable",
            "MIDI output needs permission. Click Enable — your browser will ask to allow MIDI devices.",
          ],
          blocked: [
            "Blocked",
            "Retry",
            "MIDI output is blocked for this site. Allow MIDI devices in your browser's site settings, then click Retry.",
          ],
          unsupported: [
            "Unsupported",
            null,
            "This browser does not support Web MIDI, so .midi() cannot send anywhere.",
          ],
        }[state];
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = copy[0];
        outSelect.appendChild(opt);
        outSelect.disabled = true;
        outSelect.title = copy[2];
        outEnableBtn.hidden = copy[1] == null;
        if (copy[1]) outEnableBtn.textContent = copy[1];
        outEnableBtn.title = copy[2];
        outDot.classList.remove("is-active");
        outDot.title = copy[2];
        outDot.setAttribute("aria-label", copy[2]);
        return;
      }

      outEnableBtn.hidden = true;
      const outputs = getMidiOutputs();
      if (outputs.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No outputs";
        outSelect.appendChild(opt);
        outSelect.disabled = true;
        outSelect.title = "No MIDI output device is connected";
        outDot.classList.remove("is-active");
        outDot.title = outSelect.title;
        outDot.setAttribute("aria-label", outSelect.title);
        return;
      }
      outSelect.disabled = false;
      outDot.classList.add("is-active");
      for (const o of outputs) {
        const opt = document.createElement("option");
        opt.value = o.name;
        opt.textContent = o.name;
        outSelect.appendChild(opt);
      }
      // Show the device a bare .midi() will really use: the persisted choice
      // when it is connected, otherwise the same default upstream applies.
      const stored = getMidiOutputDevice();
      const { name, missing } = resolveMidiOutputName(
        stored,
        outputs.map((o) => o.name),
      );
      outSelect.value = name ?? "";
      const status = missing
        ? `"${stored}" is not connected — .midi() sends to "${name}"`
        : `.midi() sends to "${name}" (applies from the next evaluate)`;
      outSelect.title = status;
      outDot.title = status;
      outDot.setAttribute("aria-label", status);
    }
    rebuildOutputSelect();
    outSelect.addEventListener("change", () => {
      setMidiOutputDevice(outSelect.value);
    });
    outEnableBtn.addEventListener("click", () => {
      enableMidiOutput();
    });
    unsubMidiOutput = onMidiOutputChange(rebuildOutputSelect);
  }

  // Mod wheel indicator
  function onModWheel({ value }) {
    const pct = Math.round((value / 127) * 100);
    modFill.style.height = `${pct}%`;
    modBar.setAttribute("aria-label", `Mod wheel: ${pct}%`);
  }
  midi.on("modwheel", onModWheel);

  // Metronome toggle
  function updateMetUI() {
    const on = midi.isMetronomeEnabled();
    metBtn.classList.toggle("is-active", on);
    metBtn.setAttribute("aria-pressed", on ? "true" : "false");
    metBpmEl.textContent = on ? `${midi.getMetronomeBpm()}` : "";
  }
  metBtn.addEventListener("click", () => {
    midi.setMetronomeEnabled(!midi.isMetronomeEnabled());
    updateMetUI();
    persistState();
  });
  // BPM adjustment via scroll on the BPM label
  metBpmEl.addEventListener(
    "wheel",
    (e) => {
      if (!midi.isMetronomeEnabled()) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      midi.setMetronomeBpm(midi.getMetronomeBpm() + delta);
      updateMetUI();
      persistState();
    },
    { passive: false },
  );
  midi.on("metronomechange", updateMetUI);

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
    susLamp.setAttribute("aria-label", `Sustain pedal: ${down ? "down" : "up"}`);
  }
  midi.on("sustain", onSustain);

  // Auto-show/hide based on device connectivity
  function onDeviceChange({ devices }) {
    // Show bar if input devices are connected OR if MIDI output is enabled.
    container.hidden = devices.length === 0 && !midiOutputEnabled;
    rebuildDeviceSelect(devices);
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
      modFill.style.height = "0%";
      redrawKeyboard();
    }
  }
  midi.on("devicechange", onDeviceChange);
  // Set initial state — show bar if input devices exist or MIDI output is enabled.
  container.hidden = !midi.hasDevices() && !midiOutputEnabled;

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
    drawKeyboard(
      kbCanvas,
      midi.activeNotes,
      fadingNotes,
      midi.getOctaveShift(),
    );
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
      drawKeyboard(
        kbCanvas,
        midi.activeNotes,
        fadingNotes,
        midi.getOctaveShift(),
      );
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
          velocityCurve: midi.getVelocityCurve(),
          // the chosen input, even while it is unplugged and the bridge has
          // fallen back to all devices
          selectedDevice: midi.getPreferredDevice(),
          metronomeEnabled: midi.isMetronomeEnabled(),
          metronomeBpm: midi.getMetronomeBpm(),
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
        setPresetLabel(s.preset);
      }
      if (typeof s.velocityCurve === "string") {
        midi.setVelocityCurve(s.velocityCurve);
        syncVelocityButtons();
      }
      if (typeof s.selectedDevice === "string") {
        midi.setSelectedDevice(s.selectedDevice);
      }
      if (typeof s.metronomeEnabled === "boolean") {
        midi.setMetronomeEnabled(s.metronomeEnabled);
        updateMetUI();
      }
      if (typeof s.metronomeBpm === "number") {
        midi.setMetronomeBpm(s.metronomeBpm);
        updateMetUI();
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
      const selected = item.dataset.key === current;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
    }
  }

  let previewTimer = null;
  function startPreview(key) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const p = presets[key];
      if (!p || p.drumMap) return;
      // During a WAV export the shared context is the offline one; a preview
      // would land in the rendered file.
      if (isExportRunning()) return;
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
    for (const group of popover.querySelectorAll(".midi-bar__preset-group")) {
      // Hide a category when all its items are hidden
      group.hidden = !group.querySelector(
        ".midi-bar__preset-item:not([hidden])",
      );
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
    midi.off("modwheel", onModWheel);
    midi.off("metronomechange", updateMetUI);
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
    if (unsubMidiOutput) unsubMidiOutput();
  }

  return {
    dispose,
    setCaptureState,
    getCaptureButton: () => captureBtn,
    persistState,
  };
}

// ─── Transport MIDI pill ──────────────────────────────────────────────────

/**
 * Make the transport's MIDI status pill the place to connect a keyboard.
 *
 * MIDI access is only requested from a user gesture (the browser shows a
 * permission prompt), and with no device connected the MIDI bar itself is
 * hidden — so the pill is the one always-visible entry point. It behaves as
 * a button while there is something to do (connect, or retry after the
 * permission was refused) and as a plain status readout otherwise.
 *
 * @param {HTMLElement} pillEl  #midi-status
 * @param {import('../midi-bridge.js').MidiBridge} midi
 * @returns {() => void} dispose
 */
export function wireMidiPill(pillEl, midi) {
  const isActionable = () => {
    const state = midi.getConnectionState();
    return state === "idle" || state === "blocked";
  };
  function sync() {
    const actionable = isActionable();
    pillEl.classList.toggle("is-action", actionable);
    if (actionable) {
      pillEl.setAttribute("role", "button");
      pillEl.tabIndex = 0;
    } else {
      pillEl.setAttribute("role", "status");
      pillEl.removeAttribute("tabindex");
    }
  }
  function activate() {
    if (isActionable()) midi.start();
  }
  function onKeydown(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!isActionable()) return;
    e.preventDefault();
    activate();
  }
  pillEl.addEventListener("click", activate);
  pillEl.addEventListener("keydown", onKeydown);
  midi.on("connectionchange", sync);
  sync();
  return () => {
    pillEl.removeEventListener("click", activate);
    pillEl.removeEventListener("keydown", onKeydown);
    midi.off("connectionchange", sync);
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
  filter.setAttribute("aria-label", "Filter presets");
  popover.appendChild(filter);

  // Scrollable preset list
  const listWrap = document.createElement("div");
  listWrap.className = "midi-bar__preset-list";
  listWrap.setAttribute("role", "listbox");
  listWrap.setAttribute("aria-label", "Presets");
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
    // One group per category, so the listbox contains only groups of options.
    const groupEl = document.createElement("div");
    groupEl.className = "midi-bar__preset-group";
    groupEl.setAttribute("role", "group");
    groupEl.setAttribute("aria-label", cat);
    listWrap.appendChild(groupEl);
    const catEl = document.createElement("div");
    catEl.className = "midi-bar__preset-category";
    catEl.setAttribute("role", "presentation");
    catEl.textContent = cat;
    groupEl.appendChild(catEl);

    for (const { key, label } of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "midi-bar__preset-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.dataset.key = key;
      item.textContent = label;
      item.addEventListener("click", () => onSelect(key));
      item.addEventListener("mouseenter", () => {
        // Remove previous keyboard-nav focus
        const prev = listWrap.querySelector(".is-focused");
        if (prev) prev.classList.remove("is-focused");
      });
      groupEl.appendChild(item);
    }
  }

  // ─── FX sliders section ─────────────────────────────────────────────
  const fxSection = document.createElement("div");
  fxSection.className = "midi-bar__fx-section";
  fxSection.setAttribute("role", "group");
  fxSection.setAttribute("aria-label", "Preset effects");

  const FX_DEFS = [
    {
      param: "room",
      label: "Room",
      min: 0,
      max: 1,
      step: 0.01,
      fmt: (v) => Math.round(v * 100) + "%",
    },
    {
      param: "delay",
      label: "Delay",
      min: 0,
      max: 1,
      step: 0.01,
      fmt: (v) => Math.round(v * 100) + "%",
    },
    {
      param: "lpf",
      label: "LPF",
      min: 200,
      max: 20000,
      step: 100,
      fmt: (v) =>
        v >= 10000 ? (v / 1000).toFixed(1) + "k" : Math.round(v) + "",
    },
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
    for (const [param, fx] of Object.entries(fxSliders)) {
      const base =
        param === "lpf" ? (preset?.[param] ?? 20000) : (preset?.[param] ?? 0);
      const val = overrides[param] ?? base;
      fx.slider.value = String(val);
      fx.valEl.textContent = fx.def.fmt(val);
    }
  };

  return popover;
}
