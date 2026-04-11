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
  "Guitar",
  "Brass & Wind",
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

  // ─── Keys (new) ─────────────────────────────────────────────────────
  musicbox: {
    label: "Music Box",
    category: "Keys",
    s: "gm_music_box",
    duration: 2,
    attack: 0.001,
    decay: 2,
    sustain: 0,
    release: 0.3,
    room: 0.35,
  },
  celesta: {
    label: "Celesta",
    category: "Keys",
    s: "gm_celesta",
    duration: 2,
    attack: 0.001,
    decay: 1.5,
    sustain: 0,
    release: 0.2,
    room: 0.3,
  },
  vibes: {
    label: "Vibraphone",
    category: "Keys",
    s: "gm_vibraphone",
    duration: 3,
    attack: 0.001,
    decay: 3,
    sustain: 0,
    release: 0.4,
    room: 0.35,
  },
  accordion: {
    label: "Accordion",
    category: "Keys",
    s: "gm_accordion",
    duration: 6,
    attack: 0.03,
    decay: 0.1,
    sustain: 0.85,
    release: 0.15,
    room: 0.2,
  },
  clavinet: {
    label: "Clavinet",
    category: "Keys",
    s: "gm_clavinet",
    duration: 1.5,
    attack: 0.001,
    decay: 1.5,
    sustain: 0,
    release: 0.15,
  },

  // ─── Strings & Pads (new) ──────────────────────────────────────────
  choir: {
    label: "Choir",
    category: "Strings & Pads",
    s: "gm_choir_aahs",
    duration: 6,
    attack: 0.2,
    decay: 0.5,
    sustain: 0.8,
    release: 1.2,
    room: 0.5,
  },
  padnewage: {
    label: "Pad (new age)",
    category: "Strings & Pads",
    s: "gm_pad_new_age",
    duration: 6,
    attack: 0.3,
    decay: 0.5,
    sustain: 0.8,
    release: 1.5,
    room: 0.45,
  },
  padchoir: {
    label: "Pad (choir)",
    category: "Strings & Pads",
    s: "gm_pad_choir",
    duration: 6,
    attack: 0.35,
    decay: 0.5,
    sustain: 0.75,
    release: 2,
    room: 0.5,
    lpf: 4000,
  },
  cello: {
    label: "Cello",
    category: "Strings & Pads",
    s: "gm_cello",
    duration: 4,
    attack: 0.08,
    decay: 0.5,
    sustain: 0.8,
    release: 0.8,
    room: 0.3,
  },

  // ─── Synth (new) ───────────────────────────────────────────────────
  synthbrass: {
    label: "Synth Brass",
    category: "Synth",
    s: "gm_synth_brass_1",
    duration: 3,
    attack: 0.02,
    decay: 0.3,
    sustain: 0.7,
    release: 0.3,
    lpf: 4000,
  },
  squarelead: {
    label: "Square Lead",
    category: "Synth",
    s: "gm_lead_1_square",
    duration: 2,
    attack: 0.01,
    decay: 2,
    sustain: 0,
    release: 0.2,
    lpf: 2500,
    room: 0.15,
  },
  fmsynth: {
    label: "FM Synth",
    category: "Synth",
    s: "sine",
    duration: 1.5,
    attack: 0.005,
    decay: 1.5,
    sustain: 0,
    release: 0.2,
    lpf: 5000,
    room: 0.2,
  },

  // ─── Bass (new) ────────────────────────────────────────────────────
  fingerbass: {
    label: "Finger Bass",
    category: "Bass",
    s: "gm_electric_bass_finger",
    duration: 1.2,
    attack: 0.005,
    decay: 1.2,
    sustain: 0,
    release: 0.15,
  },
  slapbass: {
    label: "Slap Bass",
    category: "Bass",
    s: "gm_slap_bass_1",
    duration: 0.8,
    attack: 0.001,
    decay: 0.8,
    sustain: 0,
    release: 0.1,
  },
  acousticbass: {
    label: "Acoustic Bass",
    category: "Bass",
    s: "gm_acoustic_bass",
    duration: 1.5,
    attack: 0.005,
    decay: 1.5,
    sustain: 0,
    release: 0.2,
    room: 0.15,
  },

  // ─── Guitar (new category) ─────────────────────────────────────────
  nylon: {
    label: "Nylon Guitar",
    category: "Guitar",
    s: "gm_acoustic_guitar_nylon",
    duration: 2,
    attack: 0.001,
    decay: 2,
    sustain: 0,
    release: 0.3,
    room: 0.2,
  },
  steel: {
    label: "Steel Guitar",
    category: "Guitar",
    s: "gm_acoustic_guitar_steel",
    duration: 2,
    attack: 0.001,
    decay: 2,
    sustain: 0,
    release: 0.3,
    room: 0.2,
  },
  cleanelectric: {
    label: "Clean Electric",
    category: "Guitar",
    s: "gm_electric_guitar_clean",
    duration: 2.5,
    attack: 0.001,
    decay: 2.5,
    sustain: 0,
    release: 0.3,
    room: 0.25,
    delay: 0.15,
  },

  // ─── Brass & Wind (new category) ───────────────────────────────────
  trumpet: {
    label: "Trumpet",
    category: "Brass & Wind",
    s: "gm_trumpet",
    duration: 3,
    attack: 0.03,
    decay: 0.3,
    sustain: 0.75,
    release: 0.2,
    room: 0.2,
  },
  sax: {
    label: "Sax",
    category: "Brass & Wind",
    s: "gm_tenor_sax",
    duration: 3,
    attack: 0.02,
    decay: 0.3,
    sustain: 0.8,
    release: 0.25,
    room: 0.2,
  },
  flute: {
    label: "Flute",
    category: "Brass & Wind",
    s: "gm_flute",
    duration: 3,
    attack: 0.05,
    decay: 0.3,
    sustain: 0.8,
    release: 0.3,
    room: 0.3,
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

    // ─── Per-preset FX overrides (session-only, not persisted) ────────
    /** @type {Map<string, {room?: number, delay?: number, lpf?: number}>} */
    this.presetOverrides = new Map();

    // ─── Mod wheel (CC1) ──────────────────────────────────────────────
    this._modWheel = 0; // 0–127, default fully open

    // ─── Velocity curve ───────────────────────────────────────────────
    /** @type {'soft'|'linear'|'hard'} */
    this._velocityCurve = 'linear';

    // ─── Device selector ──────────────────────────────────────────────
    /** @type {string|null} null = all devices */
    this._selectedDevice = null;

    // ─── Metronome ────────────────────────────────────────────────────
    this._metronomeEnabled = false;
    this._metronomeBpm = 120;
    this._metronomeIntervalId = null;
    this._metronomeBeat = 0;
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

  // ─── Per-preset FX overrides ───────────────────────────────────────
  setPresetOverride(presetKey, param, value) {
    const existing = this.presetOverrides.get(presetKey) ?? {};
    existing[param] = value;
    this.presetOverrides.set(presetKey, existing);
  }
  getPresetOverrides(presetKey) {
    return this.presetOverrides.get(presetKey) ?? {};
  }

  // ─── Sustain state ─────────────────────────────────────────────────
  isSustainDown() {
    return this._sustainDown;
  }

  // ─── Mod wheel ─────────────────────────────────────────────────────
  getModWheel() {
    return this._modWheel;
  }

  // ─── Velocity curve ────────────────────────────────────────────────
  getVelocityCurve() {
    return this._velocityCurve;
  }
  setVelocityCurve(mode) {
    if (mode === "soft" || mode === "linear" || mode === "hard") {
      this._velocityCurve = mode;
    }
  }

  // ─── Device selector ──────────────────────────────────────────────
  getSelectedDevice() {
    return this._selectedDevice;
  }
  setSelectedDevice(id) {
    this._selectedDevice = id;
    this._wireInputs();
  }

  // ─── Metronome ─────────────────────────────────────────────────────
  isMetronomeEnabled() {
    return this._metronomeEnabled;
  }
  setMetronomeEnabled(enabled) {
    this._metronomeEnabled = enabled;
    this._emit("metronomechange", { enabled, bpm: this._metronomeBpm });
  }
  getMetronomeBpm() {
    return this._metronomeBpm;
  }
  setMetronomeBpm(bpm) {
    this._metronomeBpm = Math.max(30, Math.min(300, Math.round(bpm)));
    this._emit("metronomechange", {
      enabled: this._metronomeEnabled,
      bpm: this._metronomeBpm,
    });
  }
  _startMetronome() {
    this._stopMetronome();
    if (!this._metronomeEnabled) return;
    const ctx = getAudioContext();
    if (!ctx || ctx.state !== "running") return;
    this._metronomeBeat = 0;
    const tick = () => {
      const now = getAudioContext()?.currentTime;
      if (!now) return;
      const beat = this._metronomeBeat % 4;
      const isDownbeat = beat === 0;
      Promise.resolve(
        superdough(
          {
            s: "sine",
            note: isDownbeat ? 80 : 76,
            duration: 0.02,
            gain: isDownbeat ? 0.5 : 0.3,
            attack: 0.001,
            decay: 0.02,
            sustain: 0,
            release: 0.01,
          },
          now + 0.01,
          0.02,
        ),
      ).catch(() => {});
      this._metronomeBeat++;
    };
    tick(); // play first beat immediately
    const interval = (60 / this._metronomeBpm) * 1000;
    this._metronomeIntervalId = setInterval(tick, interval);
  }
  _stopMetronome() {
    if (this._metronomeIntervalId !== null) {
      clearInterval(this._metronomeIntervalId);
      this._metronomeIntervalId = null;
    }
    this._metronomeBeat = 0;
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
    const selected = this._selectedDevice;
    let foundSelected = false;
    for (const input of this.access.inputs.values()) {
      if (selected && input.id !== selected) {
        input.onmidimessage = null;
        continue;
      }
      if (selected && input.id === selected) foundSelected = true;
      // Re-assigning .onmidimessage is idempotent — replaces any prior handler.
      input.onmidimessage = (e) => this._onMessage(e);
    }
    // If the selected device disconnected, fall back to all devices.
    if (selected && !foundSelected) {
      console.warn(
        `[midi] selected device "${selected}" disconnected — falling back to all devices`,
      );
      this._selectedDevice = null;
      for (const input of this.access.inputs.values()) {
        input.onmidimessage = (e) => this._onMessage(e);
      }
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
    // CC messages — sustain pedal (CC64), mod wheel (CC1), and general CC events.
    if (cmd === 0xb0) {
      this._emit("cc", { cc: data1, value: data2 });
      if (data1 === 64) {
        const down = data2 >= 64;
        if (down !== this._sustainDown) {
          this._sustainDown = down;
          this._emit("sustain", { down });
        }
      }
      if (data1 === 1) {
        this._modWheel = data2;
        this._emit("modwheel", { value: data2 });
      }
    }
    // Pitch bend (0xE0) — not implemented; superdough doesn't support
    // real-time cent offsets. Documented as future work.
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

    // Apply velocity curve.
    let vel = velocity;
    if (this._velocityCurve === "soft") vel = Math.sqrt(velocity);
    else if (this._velocityCurve === "hard") vel = velocity * velocity;

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
      value = { s, gain: this._volume * (0.5 + vel * 0.5) };
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
        gain: this._volume * (0.5 + vel * 0.5),
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

      // Merge per-preset FX overrides (session-only, from the popover sliders).
      const overrides = this.presetOverrides.get(presetKey);
      if (overrides) {
        if (overrides.room != null) value.room = overrides.room;
        if (overrides.delay != null) value.delay = overrides.delay;
        if (overrides.lpf != null) value.lpf = overrides.lpf;
      }

      // Mod wheel (CC1) → LPF: exponential curve 200 Hz–20 kHz.
      // The mod wheel can only close the filter (never open beyond preset).
      if (this._modWheel < 127) {
        const modWheelLpf = 200 * Math.pow(100, this._modWheel / 127);
        const presetLpf = value.lpf ?? 20000;
        value.lpf = Math.min(presetLpf, modWheelLpf);
      }
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
      this._startMetronome();
    } else {
      this._stopMetronome();
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
   *
   * @param {{ gridSubdivision?: number, bpmHint?: number }} [opts]
   */
  buildPatternFromCapture(opts = {}) {
    if (this.captureBuffer.length === 0) return null;
    const presetKey = this.getPreset();
    const preset = presets[presetKey];
    const sound = preset?.s ?? "sawtooth";

    const input = captureBufferToTranslationInput(this.captureBuffer, {
      presetName: presetKey,
    });
    // If metronome was enabled, use its BPM as the capture BPM.
    if (opts.bpmHint) input.bpm = opts.bpmHint;
    const analysisOpts = {};
    if (opts.gridSubdivision) analysisOpts.gridSubdivision = opts.gridSubdivision;
    const analysis = analyzeTranslationInput(input, analysisOpts);
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
