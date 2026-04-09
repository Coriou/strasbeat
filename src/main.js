import { StrudelMirror } from '@strudel/codemirror';
import { evalScope, controls } from '@strudel/core';
import { drawPianoroll } from '@strudel/draw';
import { transpiler } from '@strudel/transpiler';
import {
  getAudioContext,
  webaudioOutput,
  registerSynthSounds,
  initAudio,
  initAudioOnFirstClick,
  renderPatternAudio,
  setLogger,
  samples,
  soundMap,
  getSound,
  superdough,
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
} from '@strudel/webaudio';
import { registerSoundfonts } from '@strudel/soundfonts';
import { MidiBridge, presets as midiPresets } from './midi-bridge.js';

// ─── Auto-discover patterns ──────────────────────────────────────────────
// Every .js file in /patterns must `export default` a string of Strudel code.
// Adding/removing files triggers Vite HMR (see hot.accept below).
const patternModules = import.meta.glob('../patterns/*.js', { eager: true });
const patterns = {};
for (const [filePath, mod] of Object.entries(patternModules)) {
  const name = filePath.split('/').pop().replace(/\.js$/, '');
  patterns[name] = mod.default;
}
const patternNames = Object.keys(patterns).sort();

// ─── DOM refs ────────────────────────────────────────────────────────────
const editorRoot = document.getElementById('editor');
const canvas = document.getElementById('roll');
const picker = document.getElementById('pattern-picker');
const status = document.getElementById('status');
const playBtn = document.getElementById('play');
const stopBtn = document.getElementById('stop');
const saveBtn = document.getElementById('save');
const exportBtn = document.getElementById('export-wav');
const presetPicker = document.getElementById('preset-picker');
const captureBtn = document.getElementById('capture');
const midiStatus = document.getElementById('midi-status');

// HiDPI piano roll
const dpr = window.devicePixelRatio || 1;
const resizeCanvas = () => {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
};
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
const drawCtx = canvas.getContext('2d');
const drawTime = [-2, 2]; // seconds before / after now to render

// ─── Editor ──────────────────────────────────────────────────────────────
const initialName = patternNames[0] ?? 'empty';
const initialCode =
  patterns[initialName] ??
  `// no patterns found in /patterns yet — type some Strudel here\nsound("bd sd hh*4")`;

let currentName = initialName;

const editor = new StrudelMirror({
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  root: editorRoot,
  initialCode,
  drawTime,
  autodraw: true,
  onDraw: (haps, time) =>
    drawPianoroll({ haps, time, ctx: drawCtx, drawTime, fold: 0 }),
  prebake: async () => {
    initAudioOnFirstClick();
    const loadModules = evalScope(
      controls,
      import('@strudel/core'),
      import('@strudel/draw'),
      import('@strudel/mini'),
      import('@strudel/tonal'),
      import('@strudel/webaudio'),
    );
    // Wrap each sample bank load so a single failure (network, CORS,
    // upstream change) doesn't take down the rest of the prebake.
    // Some Strudel registration functions return void rather than a
    // Promise — Promise.resolve() normalises both cases.
    const safe = (label, p) =>
      Promise.resolve(p).catch((e) =>
        console.warn(`[beaitbox] failed to load ${label}:`, e),
      );
    await Promise.all([
      loadModules,
      safe('synth sounds', registerSynthSounds()),
      safe('soundfonts', registerSoundfonts()),
      safe('dirt-samples', samples('github:tidalcycles/dirt-samples')),
      // strudel.cc has no CORS headers, so we proxy via vite.config.js
      safe(
        'tidal-drum-machines',
        samples(
          '/strudel-cc/tidal-drum-machines.json',
          'github:ritchse/tidal-drum-machines/main/machines/',
        ),
      ),
    ]);
    status.textContent = 'ready · click play (or Ctrl/Cmd+Enter)';
  },
});

// ─── Pattern picker ──────────────────────────────────────────────────────
function rebuildPicker() {
  picker.innerHTML = '';
  for (const name of patternNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    picker.appendChild(opt);
  }
  if (patternNames.includes(currentName)) picker.value = currentName;
}
rebuildPicker();

picker.addEventListener('change', () => {
  currentName = picker.value;
  editor.setCode(patterns[currentName]);
  status.textContent = `loaded "${currentName}" — press play to hear it`;
});

// ─── Transport ───────────────────────────────────────────────────────────
playBtn.addEventListener('click', () => editor.evaluate());
stopBtn.addEventListener('click', () => editor.stop());

// ─── Save current editor → patterns/<name>.js ────────────────────────────
saveBtn.addEventListener('click', async () => {
  const suggestion = currentName || 'untitled';
  const name = window.prompt(
    'Save as (filename without .js, letters/numbers/-_):',
    suggestion,
  );
  if (!name) return;
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    status.textContent = 'invalid name — use only letters, numbers, - and _';
    return;
  }
  const res = await fetch('/api/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, code: editor.code }),
  });
  if (!res.ok) {
    status.textContent = `save failed: ${await res.text()}`;
    return;
  }
  const { path } = await res.json();
  currentName = name;
  status.textContent = `saved → ${path}`;
  // Vite HMR will pick up the new file and re-fire the glob below.
});

// ─── Export current pattern → WAV ────────────────────────────────────────
// renderPatternAudio swaps the live AudioContext for an OfflineAudioContext,
// replays the pattern's haps through superdough into the offline graph, then
// downloads the rendered buffer as a WAV. The live audio context is torn
// down during render and restored in the click handler's finally block.
//
// We probe haps before render and install a temporary logger to surface any
// per-hap superdough errors that the upstream code logs but doesn't throw.
const EXPORT_SAMPLE_RATE = 48000;
const EXPORT_MAX_POLYPHONY = 1024;

exportBtn.addEventListener('click', async () => {
  const input = window.prompt('Render length (in cycles):', '4');
  if (input == null) return;
  const cycles = parseInt(input, 10);
  if (!Number.isFinite(cycles) || cycles < 1) {
    status.textContent = 'export cancelled — cycles must be a positive integer';
    return;
  }

  const filename = currentName || 'untitled';
  exportBtn.disabled = true;
  exportBtn.textContent = '⤓ rendering…';
  status.textContent = `rendering ${cycles} cycle${cycles === 1 ? '' : 's'} → ${filename}.wav`;

  // Capture all strudel logger output during the export so per-hap errors
  // (which renderPatternAudio swallows via errorLogger) become visible.
  const captured = [];
  setLogger((msg, type) => {
    captured.push({ msg, type });
    if (type === 'error' || type === 'warning') console.warn('[strudel]', msg);
    else console.log('[strudel]', msg);
  });

  try {
    await editor.evaluate(false);
    editor.repl.scheduler.stop();

    const pattern = editor.repl.state.pattern;
    const cps = editor.repl.scheduler.cps;
    console.log('[beaitbox/export] cps =', cps, 'cycles =', cycles);
    if (!pattern) throw new Error('no pattern after evaluate — eval probably failed');
    if (!Number.isFinite(cps) || cps <= 0) throw new Error(`bad cps: ${cps}`);

    // Sanity-check the haps before render: if the pattern is silent in the
    // requested arc, we'll know up front instead of getting an empty WAV.
    const probeHaps = pattern.queryArc(0, cycles, { _cps: cps });
    const onsetHaps = probeHaps.filter((h) => h.hasOnset?.());
    console.log(`[beaitbox/export] ${probeHaps.length} haps, ${onsetHaps.length} with onset; first onset value:`, onsetHaps[0]?.value);
    if (!onsetHaps.length) throw new Error('pattern produced no onset haps for the requested cycle range');

    await renderPatternAudio(
      pattern,
      cps,
      0,                          // begin cycle
      cycles,                     // end cycle
      EXPORT_SAMPLE_RATE,
      EXPORT_MAX_POLYPHONY,
      false,                      // multiChannelOrbits — single stereo mix
      filename,
    );
    const errorCount = captured.filter((c) => c.type === 'error').length;
    if (errorCount) console.warn(`[beaitbox/export] ${errorCount} strudel errors during render — see above`);
    status.textContent = `exported ${filename}.wav (${cycles} cycle${cycles === 1 ? '' : 's'})`;
  } catch (err) {
    console.error('[beaitbox] wav export failed:', err);
    status.textContent = `export failed: ${err.message ?? err}`;
  } finally {
    // Restore the default strudel logger.
    setLogger((msg) => console.log(msg));
    // renderPatternAudio nulls the live audio context — restore it so the
    // user can press play again without reloading the page.
    try {
      await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });
      editor.repl.scheduler.stop();
    } catch (err) {
      console.error('[beaitbox] failed to restore audio after export:', err);
    }
    exportBtn.disabled = false;
    exportBtn.textContent = '⤓ wav';
  }
});

// ─── HMR: refresh pattern list when files change on disk ─────────────────
if (import.meta.hot) {
  import.meta.hot.accept(
    Object.keys(patternModules).map((p) => p.replace('..', '/patterns')),
    () => {
      // a known pattern file changed — reload the page module to refresh state
      location.reload();
    },
  );
  // also pick up *new* files (vite re-evaluates the importing module)
  import.meta.hot.accept(() => location.reload());
}

// ─── MIDI bridge ─────────────────────────────────────────────────────────
// Populate the preset picker from midi-bridge's presets dict.
for (const [key, p] of Object.entries(midiPresets)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = p.label ?? key;
  presetPicker.appendChild(opt);
}
presetPicker.value = 'epiano';

const midi = new MidiBridge({
  getPreset: () => presetPicker.value,
  onStatus: ({ ok, msg }) => {
    midiStatus.textContent = msg;
    midiStatus.style.color = ok ? '' : '#ff5b6b';
  },
  onCaptureChange: (n) => {
    if (midi.isCaptureEnabled()) {
      captureBtn.textContent = `● recording · ${n}`;
    }
  },
});
midi.start();

captureBtn.addEventListener('click', async () => {
  if (!midi.isCaptureEnabled()) {
    midi.setCaptureEnabled(true);
    captureBtn.textContent = '● recording · 0';
    captureBtn.classList.add('recording');
    status.textContent = 'capturing MIDI · play something · click again to save';
    return;
  }
  // stop + save
  midi.setCaptureEnabled(false);
  captureBtn.textContent = '● capture';
  captureBtn.classList.remove('recording');
  const code = midi.buildPatternFromCapture();
  if (!code) {
    status.textContent = 'capture stopped — no notes recorded';
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const suggestion = `captured-${stamp}`;
  const name = window.prompt(
    'Save captured phrase as (filename without .js):',
    suggestion,
  );
  if (!name) {
    status.textContent = 'capture discarded';
    return;
  }
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    status.textContent = 'invalid name — use only letters, numbers, - and _';
    return;
  }
  const res = await fetch('/api/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, code }),
  });
  if (!res.ok) {
    status.textContent = `save failed: ${await res.text()}`;
    return;
  }
  const { path } = await res.json();
  status.textContent = `captured phrase → ${path} (HMR will reload)`;
});

// ─── Console helpers ─────────────────────────────────────────────────────
// Strudel sound names are not 1:1 with the official GM-128 names. Use
// `beaitbox.findSounds("piano")` from devtools to discover what's actually
// loaded before guessing in your patterns.
window.beaitbox = {
  /** List loaded sounds whose key matches `query` (regex, case-insensitive). */
  findSounds(query = '') {
    const all = Object.keys(soundMap.get());
    if (!query) {
      console.log(`${all.length} sounds loaded — pass a query to filter`);
      return all.slice(0, 30);
    }
    const re = new RegExp(query, 'i');
    return all.filter((k) => re.test(k));
  },
  /** Total number of registered sounds (samples + soundfonts + synths). */
  countSounds() {
    return Object.keys(soundMap.get()).length;
  },
  /** Check if a specific name resolves. */
  hasSound(name) {
    return !!getSound(name);
  },
  /**
   * Debug helper: render the current pattern offline like the export button
   * does, but instead of downloading a WAV, return per-channel signal stats
   * (abs max, non-zero count) and a per-hap log. Use from devtools to
   * diagnose silent exports without saving files to disk.
   *
   * `mode`:
   *   'lazy'  — leave the SuperdoughAudioController null and let superdough
   *             lazily construct it on first use (THIS WORKS).
   *   'eager' — construct a fresh controller via getSuperdoughAudioController()
   *             *before* initAudio runs, mirroring renderPatternAudio's setup
   *             (THIS PRODUCES SILENCE — repro for the upstream bug).
   */
  async probeRender(cycles = 4, sampleRate = 48000, mode = 'lazy') {
    await editor.evaluate(false);
    editor.repl.scheduler.stop();
    const pattern = editor.repl.state.pattern;
    const cps = editor.repl.scheduler.cps;
    if (!pattern) throw new Error('no pattern after evaluate');

    // Match renderPatternAudio's setup but render to a buffer we keep.
    const live = getAudioContext();
    await live.close();
    const offline = new OfflineAudioContext(2, ((cycles - 0) / cps) * sampleRate, sampleRate);
    setAudioContext(offline);
    // null → first superdough() call will lazily build the controller against
    // the offline context. mode is reserved for future variants.
    setSuperdoughAudioController(null);
    await initAudio({ maxPolyphony: 1024 });

    const haps = pattern
      .queryArc(0, cycles, { _cps: cps })
      .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

    const log = [];
    let scheduled = 0, failed = 0;
    for (const hap of haps) {
      if (!hap.hasOnset()) continue;
      const t = hap.whole.begin.valueOf() / cps;
      const dur = hap.duration / cps;
      try {
        await superdough(hap.value, t, dur, cps, t);
        scheduled++;
        if (log.length < 5) log.push({ ok: true, t, dur, value: { ...hap.value } });
      } catch (err) {
        failed++;
        if (log.length < 10) log.push({ ok: false, t, error: err.message });
      }
    }

    const rendered = await offline.startRendering();
    const ch0 = rendered.getChannelData(0);
    const ch1 = rendered.getChannelData(1);
    let absMax0 = 0, absMax1 = 0, nz0 = 0, nz1 = 0;
    for (let i = 0; i < ch0.length; i++) {
      const a = Math.abs(ch0[i]);
      if (a > absMax0) absMax0 = a;
      if (ch0[i] !== 0) nz0++;
    }
    for (let i = 0; i < ch1.length; i++) {
      const a = Math.abs(ch1[i]);
      if (a > absMax1) absMax1 = a;
      if (ch1[i] !== 0) nz1++;
    }

    // Tear down the offline ctx & restore a live one for further interaction.
    setAudioContext(null);
    setSuperdoughAudioController(null);
    resetGlobalEffects();
    await initAudio({ maxPolyphony: 1024 });

    return {
      cps,
      cycles,
      scheduled,
      failed,
      log,
      bufferSeconds: rendered.length / sampleRate,
      ch0: { absMax: absMax0, nonZero: nz0, total: ch0.length },
      ch1: { absMax: absMax1, nonZero: nz1, total: ch1.length },
    };
  },
};

// expose for console tinkering
window.editor = editor;
window.patterns = patterns;
window.midi = midi;
