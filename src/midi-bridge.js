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

import { superdough, getAudioContext, getSound } from '@strudel/webaudio';

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
export const presets = {
  piano: {
    label: 'Piano',
    s: 'gm_piano',
    duration: 4, attack: 0.005, decay: 4, sustain: 0, release: 0.6,
    room: 0.2,
  },
  epiano: {
    label: 'EPiano',
    s: 'gm_epiano1',
    duration: 4, attack: 0.005, decay: 3, sustain: 0, release: 0.5,
    room: 0.3,
  },
  harpsi: {
    label: 'Harpsichord',
    s: 'gm_harpsichord',
    duration: 2, attack: 0.001, decay: 2, sustain: 0, release: 0.2,
    room: 0.15,
  },
  organ: {
    label: 'Organ',
    s: 'gm_drawbar_organ',
    duration: 8, attack: 0.01, decay: 0.05, sustain: 0.9, release: 0.1,
    room: 0.25,
  },
  marimba: {
    label: 'Marimba',
    s: 'gm_marimba',
    duration: 1.5, attack: 0.001, decay: 1.5, sustain: 0, release: 0.1,
    room: 0.2,
  },
  pluck: {
    label: 'Pluck',
    s: 'sawtooth',
    duration: 0.6, attack: 0.005, decay: 0.6, sustain: 0, release: 0.2,
    lpf: 1500, lpq: 6, room: 0.2,
  },
  pad: {
    label: 'Pad (synth)',
    s: 'sawtooth',
    duration: 6, attack: 0.4, decay: 1, sustain: 0.7, release: 2,
    lpf: 1200, room: 0.5,
  },
  warmpad: {
    label: 'Pad (warm)',
    s: 'gm_pad_warm',
    duration: 6, attack: 0.2, decay: 0.5, sustain: 0.85, release: 1.5,
    room: 0.4,
  },
  strings: {
    label: 'Strings',
    s: 'gm_string_ensemble_1',
    duration: 5, attack: 0.1, decay: 0.5, sustain: 0.85, release: 1,
    room: 0.4,
  },
  bass: {
    label: 'Bass',
    s: 'gm_synth_bass_1',
    duration: 1, attack: 0.005, decay: 1, sustain: 0, release: 0.2,
  },
  lead: {
    label: 'Lead',
    s: 'gm_lead_2_sawtooth',
    duration: 2, attack: 0.01, decay: 2, sustain: 0, release: 0.3,
    lpf: 3000, room: 0.2,
  },
  drums: {
    label: 'Drums',
    drumMap: {
      35: 'bd', 36: 'bd', 37: 'rim', 38: 'sd',  39: 'cp', 40: 'sd',
      41: 'lt', 42: 'hh', 43: 'lt', 44: 'hh',  45: 'mt', 46: 'oh',
      47: 'mt', 48: 'ht', 49: 'cr', 50: 'ht',  51: 'rd',
    },
    duration: 0.5,
  },
};

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
  }

  async start() {
    if (typeof navigator.requestMIDIAccess !== 'function') {
      this.onStatus({ ok: false, msg: 'MIDI: Web MIDI not supported' });
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch (e) {
      console.warn('[midi] permission denied:', e);
      this.onStatus({ ok: false, msg: 'MIDI: permission denied' });
      return false;
    }
    this._wireInputs();
    this.access.addEventListener('statechange', () => this._wireInputs());
    return true;
  }

  _wireInputs() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      // Re-assigning .onmidimessage is idempotent — replaces any prior handler.
      input.onmidimessage = (e) => this._onMessage(e);
    }
    this._announce();
  }

  _announce() {
    const inputs = this.access ? [...this.access.inputs.values()] : [];
    if (inputs.length === 0) {
      this.onStatus({ ok: true, msg: 'MIDI: ready · plug in a device' });
    } else {
      this.onStatus({
        ok: true,
        msg: `MIDI: ${inputs.map((i) => i.name).join(', ')}`,
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
  }

  _noteOn(midi, velocity) {
    const presetKey = this.getPreset();
    const preset = presets[presetKey];
    if (!preset) {
      console.warn('[midi] unknown preset:', presetKey);
      return;
    }
    const ctx = getAudioContext();
    if (!ctx || ctx.state !== 'running') {
      // The audio context only resumes after a *user* click somewhere on the
      // page. A MIDI message is not a user gesture in Chrome's eyes.
      this.onStatus({
        ok: true,
        msg: 'MIDI: click the page once to enable audio',
      });
      return;
    }
    const now = ctx.currentTime;

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
      value = { s, gain: 0.9 * (0.5 + velocity * 0.5) };
    } else {
      // Validate the synth/soundfont sound name once per preset. Silent
      // failures here have cost real debugging time before — we'd rather
      // shout in the console than play nothing without explanation.
      if (!getSound(preset.s) && !this._warnedSounds.has(preset.s)) {
        this._warnedSounds.add(preset.s);
        console.warn(
          `[midi] preset "${presetKey}" uses sound "${preset.s}" which is ` +
            `not in the loaded soundMap. Try strasbeat.findSounds("${preset.s.replace(/^gm_/, '')}") ` +
            `in the console to find a registered alternative.`,
        );
        this.onStatus({
          ok: false,
          msg: `MIDI: "${presetKey}" sound "${preset.s}" not loaded`,
        });
        return;
      }

      value = {
        s: preset.s,
        note: midi,
        velocity,
        gain: 0.9,
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
    Promise.resolve(superdough(value, now + 0.01, preset.duration ?? 0.5)).catch(
      (err) => console.warn('[midi] superdough failed:', err),
    );

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
   * Algorithm (deliberately simple, easy to refine in the editor afterward):
   *   1. Group events that fall within `chordWindow` of each other into chords.
   *   2. Each group becomes one step in a mini-notation pattern.
   *   3. Notes are emitted as MIDI numbers (round-trip safe).
   *   4. Wrap in `note("…").sound("<preset>")` so it plays the same sound the
   *      user was hearing while they captured.
   */
  buildPatternFromCapture() {
    if (this.captureBuffer.length === 0) return null;
    const presetKey = this.getPreset();
    const preset = presets[presetKey];
    const sound = preset?.s ?? 'sawtooth';

    const chordWindow = 0.06; // seconds — anything closer than this = chord
    const groups = [];
    for (const ev of this.captureBuffer) {
      const last = groups[groups.length - 1];
      if (last && ev.time - last.time < chordWindow) {
        last.notes.push(ev.midi);
      } else {
        groups.push({ time: ev.time, notes: [ev.midi] });
      }
    }
    const steps = groups.map((g) =>
      g.notes.length === 1 ? String(g.notes[0]) : `[${g.notes.join(',')}]`,
    );

    const header = `// captured live from MIDI · ${groups.length} step${
      groups.length === 1 ? '' : 's'
    } · preset "${presetKey}"
// edit me — try .slow(2), .fast(2), add .gain(), or change the sound

`;
    const body = `note("${steps.join(' ')}").sound("${sound}")\n`;
    return header + body;
  }
}
