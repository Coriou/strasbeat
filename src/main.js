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
const shareBtn = document.getElementById('share');
const presetPicker = document.getElementById('preset-picker');
const captureBtn = document.getElementById('capture');
const midiStatus = document.getElementById('midi-status');

// Toggle dev-only chrome (e.g. the disk-backed save button) via a body
// class. CSS hides .dev-only by default and reveals it when .dev-mode is
// present, so prod has zero flash of the save button before JS runs.
if (import.meta.env.DEV) document.body.classList.add('dev-mode');

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

// ─── Shareable URL helpers ───────────────────────────────────────────────
// In production we have no /api/save (Vercel filesystem is read-only), so
// the persistence story for visitors is "encode the editor buffer into a
// URL hash and copy it to the clipboard". The hash survives reload, and the
// initialiser below picks it up on next page load. base64url is binary-safe
// so multi-line patterns with backticks and ${} round-trip cleanly.
const SHARE_MAX_ENCODED = 6000; // ~6KB hash, comfortably under URL limits

function encodeShareCode(code) {
  const bytes = new TextEncoder().encode(code);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeShareCode(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function readSharedFromHash() {
  if (!location.hash) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const codeParam = params.get('code');
  if (!codeParam) return null;
  try {
    return {
      code: decodeShareCode(codeParam),
      name: params.get('name') || 'shared',
    };
  } catch (err) {
    console.warn('[strasbeat] failed to decode shared code from URL:', err);
    return null;
  }
}

// ─── Editor ──────────────────────────────────────────────────────────────
// If we were opened with a #code=... share link, that takes precedence over
// the auto-discovered patterns.
const shared = readSharedFromHash();
const fallbackName = patternNames[0] ?? 'empty';
const initialName = shared
  ? `shared-${shared.name}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 40)
  : fallbackName;
const initialCode =
  shared?.code ??
  patterns[fallbackName] ??
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
        console.warn(`[strasbeat] failed to load ${label}:`, e),
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

// ─── IDE-quality editor settings ─────────────────────────────────────────
// Strudel ships autocomplete, hover tooltips, bracket matching, multi-cursor
// etc. but defaults all of them OFF. Turn them on so the editor feels like a
// real IDE: typing `note(` shows a doc tooltip, hovering a Strudel function
// shows its signature, () [] {} balance highlights, Cmd-click adds a cursor.
editor.updateSettings({
  isAutoCompletionEnabled: true,
  isTooltipEnabled: true,
  isBracketMatchingEnabled: true,
  isMultiCursorEnabled: true,
  isActiveLineHighlighted: true,
  isTabIndentationEnabled: true,
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
if (shared) {
  // The shared name isn't a real /patterns file — leave the dropdown blank
  // so the UI doesn't pretend it's pointing at one.
  picker.selectedIndex = -1;
}

picker.addEventListener('change', () => {
  currentName = picker.value;
  editor.setCode(patterns[currentName]);
  status.textContent = `loaded "${currentName}" — press play to hear it`;
});

// ─── Transport ───────────────────────────────────────────────────────────
playBtn.addEventListener('click', () => editor.evaluate());
stopBtn.addEventListener('click', () => editor.stop());

// ─── Save current editor → patterns/<name>.js ────────────────────────────
// Dev-only: relies on the /api/save middleware in vite.config.js, which only
// runs in the dev server. Wrapping the registration in `if (DEV)` lets the
// minifier strip the entire handler from the prod bundle (the button itself
// is also hidden via the .dev-only CSS class — see index.html / style.css).
if (import.meta.env.DEV) {
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
}

// ─── Share current editor → URL with #code=... ──────────────────────────
// Encodes the editor buffer into a base64url hash, copies the resulting URL
// to the clipboard, and updates the address bar so a refresh keeps the work
// (and the user can fall back to copying from the URL bar). This is the
// production persistence story — see the dev-only save button above for the
// disk-backed alternative used in dev.
async function shareCurrent() {
  const code = editor.code ?? '';
  if (!code.trim()) {
    status.textContent = 'nothing to share — editor is empty';
    return;
  }
  let encoded;
  try {
    encoded = encodeShareCode(code);
  } catch (err) {
    console.warn('[strasbeat] share encode failed:', err);
    status.textContent = 'share failed — could not encode pattern';
    return;
  }
  if (encoded.length > SHARE_MAX_ENCODED) {
    status.textContent = `pattern too large to share via URL (${encoded.length} > ${SHARE_MAX_ENCODED} bytes encoded)`;
    return;
  }
  const params = new URLSearchParams({ code: encoded });
  if (currentName) params.set('name', currentName);
  const hash = `#${params.toString()}`;
  // Update the address bar so refresh keeps the work and the user has a
  // visible copy even if the clipboard write fails.
  history.replaceState(null, '', hash);
  const url = `${location.origin}${location.pathname}${hash}`;
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = 'share link copied to clipboard';
  } catch {
    status.textContent = 'share link is in the URL bar — copy from there';
  }
}

shareBtn.addEventListener('click', shareCurrent);

// ─── Export current pattern → WAV ────────────────────────────────────────
// We don't use upstream `renderPatternAudio` because it has a bug: it
// constructs `new SuperdoughAudioController(offline)` *before* `initAudio()`,
// and somewhere in that path live-context audio nodes leak into the offline
// graph (the per-hap mismatch errors get swallowed by errorLogger and the
// resulting WAV is bit-exact silent). We replicate its setup here, but pass
// `null` to setSuperdoughAudioController so the controller is built lazily on
// the first superdough() call — which always happens *after* the audio
// context swap is fully settled. Same teardown shape, audible output.
const EXPORT_SAMPLE_RATE = 48000;
const EXPORT_MAX_POLYPHONY = 1024;

/**
 * Render a Strudel pattern to a stereo AudioBuffer offline.
 * Mirrors the strudel/webaudio renderPatternAudio setup but with lazy
 * controller construction (see comment above).
 */
async function renderPatternToBuffer(pattern, cps, cycles, sampleRate) {
  const live = getAudioContext();
  await live.close();
  const offline = new OfflineAudioContext(2, (cycles / cps) * sampleRate, sampleRate);
  setAudioContext(offline);
  // Crucial: lazy controller. The first superdough() call below will build
  // the controller against `offline` via getSuperdoughAudioController().
  setSuperdoughAudioController(null);
  await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });

  const haps = pattern
    .queryArc(0, cycles, { _cps: cps })
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  let scheduled = 0;
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
    const t = hap.whole.begin.valueOf() / cps;
    const dur = hap.duration / cps;
    try {
      await superdough(hap.value, t, dur, cps, t);
      scheduled++;
    } catch (err) {
      console.warn('[strasbeat/export] superdough failed for hap:', err, hap.value);
    }
  }

  const rendered = await offline.startRendering();
  return { rendered, scheduled };
}

/** Encode a 2-channel AudioBuffer to a 16-bit PCM WAV ArrayBuffer. */
function audioBufferToWav16(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const ch0 = buffer.getChannelData(0);
  const ch1 = numChannels > 1 ? buffer.getChannelData(1) : ch0;
  const numFrames = ch0.length;
  const dataBytes = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);

  // RIFF header
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk size
  view.setUint16(20, 1, true);             // format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);            // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Interleaved 16-bit PCM
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, (ch === 0 ? ch0 : ch1)[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return out;
}

function downloadWav(arrayBuf, filename) {
  const blob = new Blob([arrayBuf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.wav') ? filename : `${filename}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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

  // Surface per-hap errors that superdough's errorLogger normally swallows.
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
    if (!pattern) throw new Error('no pattern after evaluate — eval probably failed');
    if (!Number.isFinite(cps) || cps <= 0) throw new Error(`bad cps: ${cps}`);

    // Sanity-check the haps before render: if the pattern is silent in the
    // requested arc, fail fast instead of writing an empty file.
    const probeHaps = pattern.queryArc(0, cycles, { _cps: cps });
    const onsetHaps = probeHaps.filter((h) => h.hasOnset?.());
    console.log(`[strasbeat/export] cps=${cps} cycles=${cycles} ${probeHaps.length} haps, ${onsetHaps.length} onsets`);
    if (!onsetHaps.length) throw new Error('pattern produced no onset haps for the requested cycle range');

    const { rendered, scheduled } = await renderPatternToBuffer(pattern, cps, cycles, EXPORT_SAMPLE_RATE);
    const wav = audioBufferToWav16(rendered);
    downloadWav(wav, filename);

    const errorCount = captured.filter((c) => c.type === 'error').length;
    if (errorCount) console.warn(`[strasbeat/export] ${errorCount} strudel errors during render — see above`);
    status.textContent = `exported ${filename}.wav (${scheduled} events, ${cycles} cycle${cycles === 1 ? '' : 's'})`;
  } catch (err) {
    console.error('[strasbeat] wav export failed:', err);
    status.textContent = `export failed: ${err.message ?? err}`;
  } finally {
    // Restore the default strudel logger.
    setLogger((msg) => console.log(msg));
    // The render torn down the live audio context — restore it so the user
    // can press play again without reloading.
    try {
      setAudioContext(null);
      setSuperdoughAudioController(null);
      resetGlobalEffects();
      await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });
      editor.repl.scheduler.stop();
    } catch (err) {
      console.error('[strasbeat] failed to restore audio after export:', err);
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
  if (import.meta.env.PROD) {
    // No filesystem in prod — drop the captured phrase into the editor
    // and let the user share it via the share button.
    editor.setCode(code);
    currentName = 'captured';
    picker.selectedIndex = -1;
    status.textContent = 'captured phrase loaded · ↗ share to send it';
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
// `strasbeat.findSounds("piano")` from devtools to discover what's actually
// loaded before guessing in your patterns.
window.strasbeat = {
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
   * Debug helper: render the current pattern offline (no file written) and
   * return per-channel signal stats. Use from devtools to verify the export
   * pipeline still produces audio without flooding ~/Downloads with WAVs.
   *
   *   await strasbeat.probeRender(4)
   */
  async probeRender(cycles = 4, sampleRate = EXPORT_SAMPLE_RATE) {
    await editor.evaluate(false);
    editor.repl.scheduler.stop();
    const pattern = editor.repl.state.pattern;
    const cps = editor.repl.scheduler.cps;
    if (!pattern) throw new Error('no pattern after evaluate');
    const { rendered, scheduled } = await renderPatternToBuffer(pattern, cps, cycles, sampleRate);
    const ch0 = rendered.getChannelData(0);
    let absMax = 0, nz = 0;
    for (let i = 0; i < ch0.length; i++) {
      const a = Math.abs(ch0[i]);
      if (a > absMax) absMax = a;
      if (ch0[i] !== 0) nz++;
    }
    setAudioContext(null);
    setSuperdoughAudioController(null);
    resetGlobalEffects();
    await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });
    return {
      cps, cycles, scheduled,
      seconds: rendered.length / sampleRate,
      absMax, percentNonZero: (100 * nz) / ch0.length,
    };
  },
};

// expose for console tinkering
window.editor = editor;
window.patterns = patterns;
window.midi = midi;
