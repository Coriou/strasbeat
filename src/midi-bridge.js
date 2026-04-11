// MIDI bridge: turns a hardware MIDI keyboard into a software instrument that
// plays Strudel sounds, alongside whatever pattern the editor is running.
//
// Architecture (see also: STRUDEL.md and the source dive in chat):
//   - We listen on Web MIDI directly (navigator.requestMIDIAccess).
//   - On every noteon, we call superdough() — the same one-shot audio entry
//     point the pattern engine uses for every event. We get the full FX bus
//     (room, delay, filters) for free, public API only, no patching.
//   - We use the "trigger-and-decay" model: the note's envelope (decay,
//     sustain, release) is set per preset so notes ring out naturally instead
//     of needing explicit noteoff handling. This works perfectly for piano,
//     EP, pluck, bass, lead — anything with natural decay. True sustained
//     pads with key-up release would need bypassing superdough; we don't.
//   - Capture mode: a small ring buffer records played notes; "save phrase"
//     converts them into a Strudel pattern string and POSTs to /api/save,
//     producing a real version-controlled patterns/*.js file.

import { superdough, getAudioContext, getSound } from "@strudel/webaudio";
import {
  captureBufferToTranslationInput,
  analyzeTranslationInput,
  generatePatternDraft,
  gridSubdivisionLabel,
} from "./midi-to-strudel.js";

// ─── Presets ──────────────────────────────────────────────────────────────
// Each preset is the value object passed to superdough() per noteon, minus
// `note` and `velocity` which come from the MIDI event itself.
//   `s`        — the Strudel sound name (synth waveform, soundfont, sample)
//   `duration` — superdough's hold time before release; combined with the
//                envelope shape this controls the natural decay length
//   ADSR       — standard envelope; sustain=0 means natural decay (piano-like)
//   FX         — any superdough param: lpf, lpq, hpf, room, delay, …
// Special: a `drumMap` object selects a different sample per MIDI note number
// (General MIDI drum map), turning the keyboard into a drum pad.
// IMPORTANT: every `s` value below is verified to exist in the loaded
// soundMap. The Strudel soundfont names are NOT the full GM names —
// e.g. it's `gm_piano`, not `gm_acoustic_grand_piano`. To explore
// what's available, run `strasbeat.findSounds('keyword')` in the browser
// console.
// Preset categories for the picker UI.
export const PRESET_CATEGORIES = [
  "Keys",
  "Strings & Pads",
  "Synth",
  "Bass",
  "Drums",
];

export const presets = {
  piano: {
    label: "Piano",
    category: "Keys",
    s: "gm_piano",
    duration: 4,
    attack: 0.005,
    decay: 4,
    sustain: 0,
    release: 0.6,
    room: 0.2,
  },
  epiano: {
    label: "EPiano",
    category: "Keys",
    s: "gm_epiano1",
    duration: 4,
    attack: 0.005,
    decay: 3,
    sustain: 0,
    release: 0.5,
    room: 0.3,
  },
  harpsi: {
    label: "Harpsichord",
    category: "Keys",
    s: "gm_harpsichord",
    duration: 2,
    attack: 0.001,
    decay: 2,
    sustain: 0,
    release: 0.2,
    room: 0.15,
  },
  organ: {
    label: "Organ",
    category: "Keys",
    s: "gm_drawbar_organ",
    duration: 8,
    attack: 0.01,
    decay: 0.05,
    sustain: 0.9,
    release: 0.1,
    room: 0.25,
  },
  marimba: {
    label: "Marimba",
    category: "Keys",
    s: "gm_marimba",
    duration: 1.5,
    attack: 0.001,
    decay: 1.5,
    sustain: 0,
    release: 0.1,
    room: 0.2,
  },
  strings: {
    label: "Strings",
    category: "Strings & Pads",
    s: "gm_string_ensemble_1",
    duration: 5,
    attack: 0.1,
    decay: 0.5,
    sustain: 0.85,
    release: 1,
    room: 0.4,
  },
  pad: {
    label: "Pad (synth)",
    category: "Strings & Pads",
    s: "sawtooth",
    duration: 6,
    attack: 0.4,
    decay: 1,
    sustain: 0.7,
    release: 2,
    lpf: 1200,
    room: 0.5,
  },
  warmpad: {
    label: "Pad (warm)",
    category: "Strings & Pads",
    s: "gm_pad_warm",
    duration: 6,
    attack: 0.2,
    decay: 0.5,
    sustain: 0.85,
    release: 1.5,
    room: 0.4,
  },
  lead: {
    label: "Lead",
    category: "Synth",
    s: "gm_lead_2_sawtooth",
    duration: 2,
    attack: 0.01,
    decay: 2,
    sustain: 0,
    release: 0.3,
    lpf: 3000,
    room: 0.2,
  },
  pluck: {
    label: "Pluck",
    category: "Synth",
    s: "sawtooth",
    duration: 0.6,
    attack: 0.005,
    decay: 0.6,
    sustain: 0,
    release: 0.2,
    lpf: 1500,
    lpq: 6,
    room: 0.2,
  },
  bass: {
    label: "Bass",
    category: "Bass",
    s: "gm_synth_bass_1",
    duration: 1,
    attack: 0.005,
    decay: 1,
    sustain: 0,
    release: 0.2,
  },
  drums: {
    label: "Drums",
    category: "Drums",
    drumMap: {
      35: "bd",
      36: "bd",
      37: "rim",
      38: "sd",
      39: "cp",
      40: "sd",
      41: "lt",
      42: "hh",
      43: "lt",
      44: "hh",
      45: "mt",
      46: "oh",
      47: "mt",
      48: "ht",
      49: "cr",
      50: "ht",
      51: "rd",
    },
    duration: 0.5,
  },
};

// ─── Note name helpers (used by event emitter + midi-bar) ─────────────────
const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
export function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[midi % 12] + octave;
}

// ─── Chord detection ──────────────────────────────────────────────────────
// Interval-set lookup for common chord types. Input: array of MIDI note
// numbers (any octave). Returns a chord symbol string or null.
const CHORD_TYPES = [
  // triads
  { intervals: [0, 4, 7], suffix: "" }, // major
  { intervals: [0, 3, 7], suffix: "m" }, // minor
  { intervals: [0, 3, 6], suffix: "dim" }, // diminished
  { intervals: [0, 4, 8], suffix: "aug" }, // augmented
  { intervals: [0, 5, 7], suffix: "sus4" }, // sus4
  { intervals: [0, 2, 7], suffix: "sus2" }, // sus2
  // 7ths
  { intervals: [0, 4, 7, 11], suffix: "^7" }, // major 7th
  { intervals: [0, 4, 7, 10], suffix: "7" }, // dominant 7th
  { intervals: [0, 3, 7, 10], suffix: "m7" }, // minor 7th
  { intervals: [0, 3, 6, 10], suffix: "h7" }, // half-diminished
  { intervals: [0, 3, 6, 9], suffix: "o7" }, // diminished 7th
  { intervals: [0, 3, 7, 11], suffix: "mM7" }, // minor-major 7th
  // 6ths
  { intervals: [0, 4, 7, 9], suffix: "6" }, // major 6th
  { intervals: [0, 3, 7, 9], suffix: "m6" }, // minor 6th
];

export function detectChord(midiNotes) {
  if (!midiNotes || midiNotes.length < 2) return null;
  // Normalize to pitch classes, deduplicate, sort
  const pcs = [...new Set(midiNotes.map((n) => n % 12))].sort((a, b) => a - b);
  if (pcs.length < 2) return null;
  // Try every pitch class as potential root
  for (const root of pcs) {
    const intervals = pcs
      .map((pc) => (pc - root + 12) % 12)
      .sort((a, b) => a - b);
    for (const ct of CHORD_TYPES) {
      if (ct.intervals.length !== intervals.length) continue;
      if (ct.intervals.every((v, i) => v === intervals[i])) {
        return NOTE_NAMES[root] + ct.suffix;
      }
    }
  }
  return null;
}

// ─── MidiBridge ───────────────────────────────────────────────────────────
export class MidiBridge {
  /**
   * @param {object} opts
   * @param {() => string} opts.getPreset    returns currently-selected preset key
   * @param {(s: {ok: boolean, msg: string}) => void} [opts.onStatus]
   * @param {(count: number) => void} [opts.onCaptureChange]   called after each captured event
   */
  constructor({ getPreset, onStatus, onCaptureChange }) {
    this.getPreset = getPreset;
    this.onStatus = onStatus ?? (() => {});
    this.onCaptureChange = onCaptureChange ?? (() => {});
    /** @type {MIDIAccess|null} */
    this.access = null;
    this.captureEnabled = false;
    /** @type {{midi:number, velocity:number, time:number}[]} */
    this.captureBuffer = [];
    this.captureStart = 0;
    /** Names we've already warned about — avoid spamming the console. */
    this._warnedSounds = new Set();

    // ─── New: event emitter ───────────────────────────────────────────
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    // ─── New: octave shift, volume, sustain, active notes ─────────────
    this._octaveShift = 0; // -3 to +3
    this._volume = 0.8; // 0–1, replaces hardcoded 0.9
    this._sustainDown = false;
    /** @type {Map<number, {velocity: number, timeout: number}>} */
    this.activeNotes = new Map();
  }

  // ─── Event emitter ──────────────────────────────────────────────────
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
  }
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }
  _emit(event, data) {
    const fns = this._listeners.get(event);
    if (fns)
      for (const fn of fns) {
        try {
          fn(data);
        } catch (e) {
          console.warn("[midi] listener error:", e);
        }
      }
  }

  // ─── Octave shift ──────────────────────────────────────────────────
  setOctaveShift(n) {
    this._octaveShift = Math.max(-3, Math.min(3, n));
  }
  getOctaveShift() {
    return this._octaveShift;
  }

  // ─── Master volume ─────────────────────────────────────────────────
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
  }
  getVolume() {
    return this._volume;
  }

  // ─── Sustain state ─────────────────────────────────────────────────
  isSustainDown() {
    return this._sustainDown;
  }

  // ─── Device enumeration ────────────────────────────────────────────
  getDevices() {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map((i) => ({
      id: i.id,
      name: i.name,
    }));
  }
  hasDevices() {
    return this.getDevices().length > 0;
  }

  async start() {
    if (typeof navigator.requestMIDIAccess !== "function") {
      this.onStatus({
        ok: false,
        msg: "MIDI unavailable",
        title: "Web MIDI is not supported in this browser.",
      });
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch (e) {
      console.warn("[midi] permission denied:", e);
      this.onStatus({
        ok: false,
        msg: "MIDI blocked",
        title: "MIDI permission was denied for this page.",
      });
      return false;
    }
    this._wireInputs();
    this.access.addEventListener("statechange", () => this._wireInputs());
    return true;
  }

  _wireInputs() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      // Re-assigning .onmidimessage is idempotent — replaces any prior handler.
      input.onmidimessage = (e) => this._onMessage(e);
    }
    this._announce();
    this._emit("devicechange", { devices: this.getDevices() });
  }

  _announce() {
    const inputs = this.access ? [...this.access.inputs.values()] : [];
    if (inputs.length === 0) {
      this.onStatus({
        ok: null,
        msg: "No MIDI device",
        title: "No MIDI device connected. Connect a keyboard at any time.",
      });
    } else {
      const names = inputs.map((i) => i.name).join(", ");
      this.onStatus({
        ok: true,
        msg: `MIDI: ${names}`,
        title: `Connected MIDI input${inputs.length === 1 ? "" : "s"}: ${names}`,
      });
    }
  }

  _onMessage(e) {
    const [status, data1, data2] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && data2 > 0) {
      this._noteOn(data1, data2 / 127);
    }
    // noteoff is intentionally ignored — see file header.
    // CC messages — sustain pedal (CC64) and general CC events.
    if (cmd === 0xb0) {
      this._emit("cc", { cc: data1, value: data2 });
      if (data1 === 64) {
        const down = data2 >= 64;
        if (down !== this._sustainDown) {
          this._sustainDown = down;
          this._emit("sustain", { down });
        }
      }
    }
  }

  _noteOn(midiRaw, velocity) {
    const presetKey = this.getPreset();
    const preset = presets[presetKey];
    if (!preset) {
      console.warn("[midi] unknown preset:", presetKey);
      return;
    }
    const ctx = getAudioContext();
    if (!ctx || ctx.state !== "running") {
      this.onStatus({
        ok: null,
        msg: "MIDI needs audio",
        title: "Click the page once to enable audio for live MIDI.",
      });
      return;
    }
    const now = ctx.currentTime;

    // Apply octave shift (clamped to valid MIDI range 0–127).
    const midi = Math.max(0, Math.min(127, midiRaw + this._octaveShift * 12));

    // Duration — sustain pedal extends by 3×.
    const baseDuration = preset.duration ?? 0.5;
    const duration = this._sustainDown ? baseDuration * 3 : baseDuration;

    let value;
    if (preset.drumMap) {
      const s = preset.drumMap[midi];
      if (!s) return; // out-of-range key on a drum preset
      if (!getSound(s) && !this._warnedSounds.has(s)) {
        this._warnedSounds.add(s);
        console.warn(
          `[midi] preset "${presetKey}" → drum sound "${s}" not loaded. ` +
            `Run strasbeat.findSounds("${s}") to look for alternatives.`,
        );
        return;
      }
      value = { s, gain: this._volume * (0.5 + velocity * 0.5) };
    } else {
      if (!getSound(preset.s) && !this._warnedSounds.has(preset.s)) {
        this._warnedSounds.add(preset.s);
        console.warn(
          `[midi] preset "${presetKey}" uses sound "${preset.s}" which is ` +
            `not in the loaded soundMap. Try strasbeat.findSounds("${preset.s.replace(/^gm_/, "")}") ` +
            `in the console to find a registered alternative.`,
        );
        this.onStatus({
          ok: false,
          msg: "MIDI preset unavailable",
          title: `MIDI preset "${presetKey}" could not load sound "${preset.s}".`,
        });
        return;
      }

      value = {
        s: preset.s,
        note: midi,
        gain: this._volume * (0.5 + velocity * 0.5),
        ...(preset.attack != null && { attack: preset.attack }),
        ...(preset.decay != null && { decay: preset.decay }),
        ...(preset.sustain != null && { sustain: preset.sustain }),
        ...(preset.release != null && { release: preset.release }),
        ...(preset.lpf != null && { lpf: preset.lpf }),
        ...(preset.lpq != null && { lpq: preset.lpq }),
        ...(preset.hpf != null && { hpf: preset.hpf }),
        ...(preset.room != null && { room: preset.room }),
        ...(preset.delay != null && { delay: preset.delay }),
      };
    }

    // 10ms latency cushion so the note schedules slightly in the future —
    // strictly required, superdough warns and skips events scheduled in the
    // past.
    Promise.resolve(superdough(value, now + 0.01, duration)).catch((err) =>
      console.warn("[midi] superdough failed:", err),
    );

    // Track active note (for keyboard visualization).
    const prev = this.activeNotes.get(midi);
    if (prev?.timeout) clearTimeout(prev.timeout);
    const noteTimeout = setTimeout(() => {
      const expired = this.activeNotes.get(midi);
      this.activeNotes.delete(midi);
      this._emit("noteoff", { midi, velocity: expired?.velocity ?? 0 });
    }, duration * 1000);
    this.activeNotes.set(midi, { velocity, timeout: noteTimeout });

    // Emit event (after sound is triggered, so listeners never block audio).
    this._emit("noteon", { midi, velocity, noteName: midiToNoteName(midi) });

    if (this.captureEnabled) {
      this._capture(midi, velocity, now);
    }
  }

  _capture(midi, velocity, now) {
    if (this.captureBuffer.length === 0) this.captureStart = now;
    this.captureBuffer.push({ midi, velocity, time: now - this.captureStart });
    this.onCaptureChange(this.captureBuffer.length);
  }

  setCaptureEnabled(enabled) {
    this.captureEnabled = enabled;
    if (enabled) {
      this.captureBuffer = [];
      this.captureStart = 0;
      this.onCaptureChange(0);
    }
  }

  isCaptureEnabled() {
    return this.captureEnabled;
  }

  getCaptureCount() {
    return this.captureBuffer.length;
  }

  /**
   * Convert the captured events into a usable Strudel pattern string.
   *
   * Uses the shared translation pipeline (captureBufferToTranslationInput →
   * analyzeTranslationInput → generatePatternDraft) so capture output gets
   * the same quality as file import: note names, bar structure, quantization,
   * repetition detection, and velocity preservation.
   */
  buildPatternFromCapture() {
    if (this.captureBuffer.length === 0) return null;
    const presetKey = this.getPreset();
    const preset = presets[presetKey];
    const sound = preset?.s ?? "sawtooth";

    const input = captureBufferToTranslationInput(this.captureBuffer, {
      presetName: presetKey,
    });
    const analysis = analyzeTranslationInput(input);
    const body = generatePatternDraft(analysis, {
      soundOverrides: { 0: sound },
    });

    const noteCount = this.captureBuffer.length;
    const gridLabel = gridSubdivisionLabel(
      analysis.gridSubdivision,
      analysis.timeSignature,
    );
    const header = [
      `// captured live from MIDI · preset "${presetKey}" · ${noteCount} note${noteCount === 1 ? "" : "s"}`,
      `// ${gridLabel} grid · ${analysis.totalBars} bar${analysis.totalBars === 1 ? "" : "s"} at ${analysis.bpm} BPM (estimated)`,
      `// edit me — try .slow(2), .fast(2), add .gain(), or change the sound`,
    ];

    return header.join("\n") + "\n\n" + body + "\n";
  }
}
