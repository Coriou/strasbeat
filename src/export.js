import {
  installDefaultStrudelLogger,
  shouldIgnoreStrudelLog,
} from "./strudel-logger.js";
import { track } from "./analytics.js";
import { classifyStrudelLog } from "./eval-state.js";

// ─── Export current pattern → WAV ────────────────────────────────────────
// We don't use upstream `renderPatternAudio` because it has a bug: it
// constructs `new SuperdoughAudioController(offline)` *before* `initAudio()`,
// and somewhere in that path live-context audio nodes leak into the offline
// graph (the per-hap mismatch errors get swallowed by errorLogger and the
// resulting WAV is bit-exact silent). We replicate its setup here, but pass
// `null` to setSuperdoughAudioController so the controller is built lazily on
// the first superdough() call — which always happens *after* the audio
// context swap is fully settled. Same teardown shape, audible output.
export const EXPORT_SAMPLE_RATE = 48000;
export const EXPORT_MAX_POLYPHONY = 1024;
// The live engine's voice cap (superdough's own default). It has to be passed
// on every live initAudio(): called without it, superdough parses `undefined`
// into NaN and voice stealing silently switches off.
export const LIVE_MAX_POLYPHONY = 128;

// Module-level export lock — prevents concurrent exports from corrupting
// the global audio context / controller state.
let _exportRunning = false;
export function isExportRunning() {
  return _exportRunning;
}

/**
 * Take the export lock for another offline render (the `probeRender` debug
 * helper swaps the audio context exactly like an export does). Returns
 * false when a render is already running; pair with `releaseExportLock()`.
 */
export function acquireExportLock() {
  if (_exportRunning) return false;
  _exportRunning = true;
  return true;
}
export function releaseExportLock() {
  _exportRunning = false;
}

// ─── Pre-warm: force lazy sample/soundfont buffers to load ──────────────
// Strudel loads audio buffers lazily: the first `superdough()` call for a
// given sound triggers a `fetch → decodeAudioData` chain whose promise is
// cached forever. If we close the live AudioContext (to swap in an offline
// one) while those fetches are in-flight, the `decodeAudioData` step fails
// on the now-closed context, and the rejected promise stays cached — every
// future attempt to play that sound gets the stale rejection.
//
// The fix: before closing the live context, iterate every unique sound in
// the pattern's haps and call the same `onTrigger` callback that
// `superdough()` would. This ensures all buffers are decoded and cached
// using the still-alive live context. We schedule the trigger at time 0
// with a dummy `onended`, wait for the promise, and then immediately
// disconnect the resulting audio nodes so no stray sound leaks.
//
// For live playback, the same pre-warm eliminates the "sounds appear
// gradually" artefact where the first cycle or two are missing instruments
// that haven't finished loading yet.

/**
 * Pre-warm all unique sounds in a set of haps by triggering their
 * `onTrigger` callbacks. Audio nodes are created then immediately
 * disconnected; the valuable side-effect is that the buffer fetch/decode
 * promises land in the module-level caches (`loadCache`, `bufferCache`,
 * and the soundfont `bufferCache`) so subsequent calls are instant.
 *
 * Call BEFORE closing the live AudioContext for export, or after
 * evaluate() for live playback.
 *
 * @param {Array} haps    Haps from pattern.queryArc()
 * @param {object} deps   { getSound, getAudioContext }
 * @param {object} [opts] { onProgress?: (loaded, total) => void, skip?: Set<string> }
 *   `skip` holds sound keys that are already warm — they are left alone, so
 *   a caller that re-warms on every evaluate doesn't rebuild a voice per
 *   sound each time. Feed it from the returned `warmedKeys`.
 * @returns {Promise<{ warmed: number, failed: string[], total: number, warmedKeys: string[] }>}
 */
export async function prewarmSounds(haps, deps, opts = {}) {
  const { getSound, getAudioContext } = deps;
  const { onProgress, skip } = opts;

  // Collect unique sound keys (with bank prefix, matching superdough's lookup).
  const seen = new Map(); // soundKey → representative hap.value
  for (const hap of haps) {
    if (!hap.hasOnset?.()) continue;
    const v = hap.value;
    if (typeof v !== "object") continue;
    let s = v.s ?? "triangle";
    if (v.bank && s) s = `${v.bank}_${s}`;
    if (["-", "~", "_"].includes(s)) continue;
    if (skip?.has(s)) continue;
    if (!seen.has(s)) seen.set(s, v);
  }

  const total = seen.size;
  let loaded = 0;
  let warmed = 0;
  const failed = [];
  const warmedKeys = [];

  const warmOne = async ([soundKey, value]) => {
    try {
      const entry = getSound(soundKey);
      if (!entry?.onTrigger) {
        failed.push(soundKey);
        return;
      }
      // Trigger with t=0 and a no-op onended. The callback will:
      //   - For samples: fetch + decode the buffer, create a BufferSourceNode
      //   - For soundfonts: fetch the font JS, decode per-pitch buffers
      //   - For synths: create oscillator nodes (instant, no fetch)
      // We await the trigger so the fetch/decode finishes, then discard.
      const ac = getAudioContext();
      const handle = await entry.onTrigger(
        ac.currentTime + 0.5, // schedule slightly in the future to avoid "in the past" warnings
        { ...value, duration: 0.1, gain: 0 }, // silent
        () => {}, // onended no-op
        0, // cps
      );
      // Immediately disconnect so no audio leaks through.
      if (handle?.node) {
        try {
          handle.node.disconnect();
        } catch {
          /* already disconnected */
        }
      }
      if (handle?.stop) {
        try {
          handle.stop(0);
        } catch {
          /* ignore */
        }
      }
      warmed++;
      warmedKeys.push(soundKey);
    } catch (err) {
      console.warn(`[strasbeat/prewarm] failed to warm "${soundKey}":`, err);
      failed.push(soundKey);
    } finally {
      loaded++;
      if (onProgress) {
        try {
          onProgress(loaded, total);
        } catch {
          /* ignore */
        }
      }
    }
  };

  // Warm sounds in parallel batches to balance throughput vs. resource use.
  const BATCH_SIZE = 8;
  const entries = [...seen.entries()];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(warmOne));
  }

  return { warmed, failed, total, warmedKeys };
}

// ─── Stale pooled nodes across a context swap ───────────────────────────
// superdough recycles filter / compressor / supersaw / wavetable nodes
// through module-level pools keyed by node type only — not by AudioContext
// — and offers no way to empty them (superdough/nodePools.mjs; the pools are
// private to its bundle). After we swap contexts, the pools still hand out
// nodes that belong to the previous context; connecting one throws
// "cannot connect to an AudioNode belonging to a different audio context"
// and superdough drops the hap. Going live → offline that silently removes
// the first filtered notes from the WAV; going offline → live it drops the
// first notes of the next play.
//
// This is a workaround, not a fix: the one thing the public API lets us do
// is use the stale nodes up. Every superdough() call that fails this way has
// popped (and discarded) one of them, so for each pool we schedule a silent
// probe event that draws from it, again and again, until one goes through —
// at that point that pool holds nothing from the old context any more.
//
// The probes are fixed, not derived from the pattern being rendered: the
// pools are shared by everything played this session, so a tab with filters
// leaves stale filters behind even when the exported tab has none. They
// carry `gain: 0` and no orbit-level control (delay, room, duck, djf, bus…),
// so a probe that goes through adds a voice of exact silence on the default
// orbit and writes no shared parameter — the rendered audio is unchanged.
const POOL_PROBES = [
  // "filter" — also what .hpf / .bpf / .phaser draw from.
  { s: "sawtooth", cutoff: 1000 },
  // "compressor"
  { s: "sawtooth", compressor: -20 },
  // "supersaw"
  { s: "supersaw" },
];
const MAX_FLUSH_ATTEMPTS = 4096;

function isCrossContextError(err) {
  return (
    err?.name === "InvalidAccessError" ||
    /different audio context/i.test(err?.message ?? "")
  );
}

// The "wavetable" pool can only be reached through a registered wavetable
// sound, and those exist only when a pattern loaded some with tables(). Probe
// with the ones this pattern uses (their tables are already fetched). A
// wavetable voice left in the pool by a DIFFERENT pattern is not covered.
function wavetableProbes(haps, getSound) {
  const probes = new Map();
  if (typeof getSound !== "function") return [];
  for (const hap of haps ?? []) {
    const value = hap?.value;
    if (!value || typeof value !== "object" || typeof value.s !== "string") {
      continue;
    }
    const name = value.bank ? `${value.bank}_${value.s}` : value.s;
    if (probes.has(name)) continue;
    if (getSound(name)?.data?.type !== "wavetable") continue;
    probes.set(name, { s: name, n: value.n });
  }
  return [...probes.values()];
}

/**
 * Use up pooled audio nodes left over from the previous AudioContext.
 * Call right after a context swap (and its `initAudio`), before anything
 * audible is scheduled. Returns how many stale nodes were discarded.
 *
 * `haps` is only consulted for wavetable sounds (see wavetableProbes).
 */
export async function flushStaleNodePools(haps, cps, deps) {
  const { superdough, getAudioContext, getSound } = deps;
  let discarded = 0;
  for (const probe of [...POOL_PROBES, ...wavetableProbes(haps, getSound)]) {
    for (let attempt = 0; attempt < MAX_FLUSH_ATTEMPTS; attempt++) {
      try {
        const t = getAudioContext().currentTime + 0.1;
        // A fresh copy per attempt: superdough writes into the value.
        await superdough({ ...probe, gain: 0 }, t, 0.02, cps, t);
        break;
      } catch (err) {
        if (isCrossContextError(err)) {
          discarded++;
          continue;
        }
        // Not a stale node — this pool was not drained. Say so: the symptom
        // (dropped first notes) is otherwise impossible to trace back here.
        console.warn(
          `[strasbeat/export] could not flush superdough's node pool with "${probe.s}":`,
          err,
        );
        break;
      }
    }
  }
  return discarded;
}

/**
 * Schedule every onset hap into the (offline) context through superdough.
 * A hap that throws is skipped — one bad event must not abort the render —
 * but it is recorded, so the export can say that events are missing instead
 * of reporting a clean render.
 */
async function scheduleHaps(haps, cps, superdough) {
  let scheduled = 0;
  const failures = [];
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
    // `.midi()` / `.osc()` layers set a dominant trigger: live, the repl
    // skips the WebAudio output for them (core/repl.mjs getTrigger), so
    // they are silent in the app and must be silent in the file too.
    if (hap.context?.onTrigger && hap.context.dominantTrigger) continue;
    const t = hap.whole.begin.valueOf() / cps;
    const dur = hap.duration / cps;
    try {
      await superdough(hap.value, t, dur, cps, t);
      scheduled++;
    } catch (err) {
      console.warn(
        "[strasbeat/export] superdough failed for hap:",
        err,
        hap.value,
      );
      failures.push(err?.message ?? String(err));
    }
  }
  return { scheduled, failures };
}

/**
 * Render a Strudel pattern to a stereo AudioBuffer offline.
 * Mirrors the strudel/webaudio renderPatternAudio setup but with lazy
 * controller construction (see comment above).
 */
export async function renderPatternToBuffer(
  pattern,
  cps,
  cycles,
  sampleRate,
  ctx,
) {
  const {
    getAudioContext,
    getSound,
    setAudioContext,
    setSuperdoughAudioController,
    initAudio,
    superdough,
    onContextSwap,
  } = ctx;

  // Query haps first so we can pre-warm while the live context is still open.
  const haps = pattern
    .queryArc(0, cycles, { _cps: cps })
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  // Pre-warm: force all unique sound buffers to load using the live context.
  // This prevents cache-poisoning from a mid-flight close (see prewarmSounds).
  await prewarmSounds(haps, { getSound, getAudioContext });

  const live = getAudioContext();
  // From here on the live context is gone and the caller has to rebuild it.
  onContextSwap?.();
  if (live.state !== "closed") {
    await live.close();
  }
  const offline = new OfflineAudioContext(
    2,
    (cycles / cps) * sampleRate,
    sampleRate,
  );
  setAudioContext(offline);
  // Crucial: lazy controller. The first superdough() call below will build
  // the controller against `offline` via getSuperdoughAudioController().
  setSuperdoughAudioController(null);
  await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });

  // Still the lazy-controller order: this is the first superdough() call
  // after the swap, so it is what builds the controller against `offline`.
  await flushStaleNodePools(haps, cps, {
    superdough,
    getAudioContext,
    getSound,
  });
  const { scheduled, failures } = await scheduleHaps(haps, cps, superdough);

  const rendered = await offline.startRendering();
  return { rendered, scheduled, failures };
}

/** Encode a 2-channel AudioBuffer to a 16-bit PCM WAV ArrayBuffer. */
export function audioBufferToWav16(buffer) {
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
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
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

export function downloadWav(arrayBuf, filename) {
  const blob = new Blob([arrayBuf], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".wav") ? filename : `${filename}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking in the same tick can cancel the download before the browser
  // has started reading the blob (Safari, large files).
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ─── Export pipeline with progress polling ──────────────────────────────
//
// The export panel owns the UI but delegates the actual render to the
// host via the `onExport` callback. `runExport` is that callback: it
// wraps the same setup as the probe helper (evaluate → stop scheduler →
// sanity-check haps → render → download), but in addition it polls the
// offline AudioContext's `currentTime` every 100ms during render so the
// panel's progress bar has something to animate.
//
// `renderPatternToBufferWithProgress` is a close cousin of
// `renderPatternToBuffer` that accepts an `onProgress(ratio)` callback
// and fires it from a `setInterval` kicked off right before
// `offline.startRendering()`. The two functions share the same setup
// order exactly — DO NOT re-order them (see docs/architecture.md,
// "WAV export"): the `SuperdoughAudio
// Controller` must be reset to null BEFORE `initAudio` so the first
// `superdough()` call builds it lazily against the offline context.
// The duplication is a deliberate ~30-line clone rather than a shared
// helper because the original `renderPatternToBuffer` is still used by
// `probeRender()` below, and the progress interval is overkill there.

/**
 * Same setup as `renderPatternToBuffer` but with an `onProgress(ratio)`
 * callback that fires every 100ms while `offline.startRendering()` is
 * in flight. `ratio` is 0..1 derived from `offline.currentTime /
 * totalSeconds`. Called once with `1` after `startRendering()` resolves
 * so the progress bar always lands at 100% before the panel flips to
 * its "done" state.
 */
export async function renderPatternToBufferWithProgress(
  pattern,
  cps,
  cycles,
  sampleRate,
  onProgress,
  ctx,
) {
  const {
    getAudioContext,
    getSound,
    setAudioContext,
    setSuperdoughAudioController,
    initAudio,
    superdough,
    onContextSwap,
  } = ctx;

  // Query haps first so we can pre-warm while the live context is still open.
  const haps = pattern
    .queryArc(0, cycles, { _cps: cps })
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  // Pre-warm: force all unique sound buffers to load using the live context.
  // Await fully — if any sound fetch is still in-flight when we close the
  // context, its decodeAudioData will reject and poison the cache forever.
  await prewarmSounds(haps, { getSound, getAudioContext });

  const live = getAudioContext();
  // Guard: the context may already be closed if the user triggered a rapid
  // double-export (the mutex in runExport prevents this, but
  // renderPatternToBuffer is also used by probeRender).
  // From here on the live context is gone and the caller has to rebuild it.
  onContextSwap?.();
  if (live.state !== "closed") {
    await live.close();
  }
  const offline = new OfflineAudioContext(
    2,
    (cycles / cps) * sampleRate,
    sampleRate,
  );
  setAudioContext(offline);
  // Crucial: lazy controller. The first superdough() call below will build
  // the controller against `offline` via getSuperdoughAudioController().
  setSuperdoughAudioController(null);
  await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });

  // Still the lazy-controller order: this is the first superdough() call
  // after the swap, so it is what builds the controller against `offline`.
  await flushStaleNodePools(haps, cps, {
    superdough,
    getAudioContext,
    getSound,
  });
  const { scheduled, failures } = await scheduleHaps(haps, cps, superdough);

  // Poll the offline context's currentTime so the panel can show a
  // moving progress bar. `startRendering()` advances `currentTime`
  // monotonically as it pulls samples from the graph, so this is a
  // reliable (if coarse) percentage. 100ms is the spec's suggested
  // cadence — fast enough to feel live, slow enough to avoid churning
  // layout.
  const totalSeconds = offline.length / offline.sampleRate;
  let pollHandle = null;
  if (typeof onProgress === "function") {
    pollHandle = setInterval(() => {
      try {
        const ratio = Math.min(1, offline.currentTime / totalSeconds);
        onProgress(ratio);
      } catch (err) {
        console.warn("[strasbeat/export] progress poll failed:", err);
      }
    }, 100);
  }

  try {
    const rendered = await offline.startRendering();
    if (typeof onProgress === "function") {
      try {
        onProgress(1);
      } catch {
        /* ignore */
      }
    }
    return { rendered, scheduled, failures };
  } finally {
    if (pollHandle != null) clearInterval(pollHandle);
  }
}

/**
 * Scan a rendered AudioBuffer for the stats the export panel needs to
 * display: the absolute peak across both channels, and the percent of
 * samples that are non-zero (the silent-export warning fires if this is
 * too low). Walks every sample once — cheap at 48kHz × ~30s.
 */
export function computeBufferStats(buffer) {
  let absMax = 0;
  let nonZero = 0;
  let totalSamples = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    totalSamples += data.length;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > absMax) absMax = a;
      if (data[i] !== 0) nonZero++;
    }
  }
  return {
    peakAmplitude: absMax,
    percentNonZero: totalSamples > 0 ? (100 * nonZero) / totalSamples : 0,
    // The 16-bit encoder hard-clamps to ±1, so anything above is distortion.
    clipped: absMax > 1,
  };
}

// Peak an export is normalized to: -1 dBFS, the usual headroom for a file
// that will be converted or mixed further.
export const NORMALIZE_PEAK = 10 ** (-1 / 20);
// Below this (-60 dB) a render counts as silent: boosting it would only
// amplify noise and hide the silent-export warning.
const NORMALIZE_MIN_PEAK = 0.001;

/**
 * Scale every channel of `buffer` in place so its peak lands on
 * NORMALIZE_PEAK. Down for a mix that would clip in the 16-bit file, up for
 * a quiet one. A silent or near-silent render is left untouched.
 * @returns {{ gain: number }} the factor applied (1 when nothing was done)
 */
export function normalizeBuffer(buffer, peak) {
  if (!(peak >= NORMALIZE_MIN_PEAK)) return { gain: 1 };
  const gain = NORMALIZE_PEAK / peak;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }
  return { gain };
}

/**
 * Throws unless `outcome` (what the patched `editor.evaluate` resolved to)
 * says the CURRENT buffer was evaluated. Shared by the export and the
 * `probeRender` debug helper.
 */
export function assertEvaluated(outcome, editor) {
  const status = outcome?.status;
  if (status === "ok") return;
  if (status === "error" || editor?.repl?.state?.evalError) {
    const detail = editor?.repl?.state?.evalError?.message;
    throw new Error(
      `the pattern has an error — fix it before exporting${detail ? ` (${String(detail).split(/\r?\n/, 1)[0]})` : ""}`,
    );
  }
  if (status === "empty") {
    throw new Error("nothing to export — the editor is empty");
  }
  if (status === "cancelled" || status === "superseded") {
    throw new Error("export was interrupted — try again");
  }
  // No outcome at all: evaluate was not the patched one. Fall through to
  // the caller's own "is there a pattern?" check.
}

/**
 * The `onExport` callback wired into the export panel. Same high-level
 * flow as the old `exportBtn.addEventListener('click', …)` handler, but
 * factored so the panel (not a prompt modal) collects the options, and
 * the return value feeds the panel's waveform + stats view.
 *
 * Routes both success and failure into the console panel too so a
 * composer who has the console open can see the render progress
 * without switching tabs.
 */
export async function runExport(options, ctx) {
  const {
    editor,
    consolePanel,
    exportPanel,
    exportBtn,
    status,
    setLogger,
    getAudioContext,
    getSound,
    setAudioContext,
    setSuperdoughAudioController,
    resetGlobalEffects,
    initAudio,
    superdough,
    onBeforeContextTeardown,
    onAfterContextRestore,
  } = ctx;

  // ── Mutex: refuse if an export is already in flight ──
  if (_exportRunning) {
    const msg = "export already in progress — wait for it to finish";
    status.textContent = msg;
    consolePanel?.warn?.(msg);
    throw new Error(msg);
  }
  _exportRunning = true;

  // Set the moment the render closes the live context. Until then a failed
  // export (eval error, silent pattern, bad cps) has left the audio engine
  // untouched and there is nothing to rebuild.
  let contextSwapped = false;
  const webaudioCtx = {
    getAudioContext,
    getSound,
    setAudioContext,
    setSuperdoughAudioController,
    initAudio,
    superdough,
    onContextSwap: () => {
      contextSwapped = true;
    },
  };
  const { cycles, sampleRate, filename } = options;
  const exportLabel = exportBtn.querySelector(".btn__label");

  // Reflect "rendering…" in the toolbar button too so users watching
  // the top bar see the same state the panel shows.
  exportBtn.disabled = true;
  if (exportLabel) exportLabel.textContent = "…";
  status.textContent = `rendering ${cycles} cycle${cycles === 1 ? "" : "s"} → ${filename}.wav`;
  try {
    consolePanel?.log(
      `export: rendering ${cycles} cycle${cycles === 1 ? "" : "s"} → ${filename}.wav @ ${sampleRate}Hz`,
    );
  } catch (err) {
    console.warn("[strasbeat/console] export log failed:", err);
  }

  // What the render scheduled — passed to the node-pool flush that runs
  // after the live context is rebuilt; see flushStaleNodePools.
  let renderedHaps = [];
  let renderedCps = 1;

  // Surface per-hap errors that superdough's errorLogger normally swallows.
  const captured = [];
  setLogger((msg, type) => {
    if (shouldIgnoreStrudelLog(msg)) return;
    captured.push({ msg, type });
    if (type === "error" || type === "warning") console.warn("[strudel]", msg);
    else console.log("[strudel]", msg);
  });

  try {
    // The repl swallows eval errors and keeps the previous pattern, so a
    // plain "is there a pattern?" check would happily render the LAST good
    // code under the current filename. Only render what just evaluated.
    const evalOutcome = await editor.evaluate(false);
    editor.repl.scheduler.stop();
    assertEvaluated(evalOutcome, editor);

    const pattern = editor.repl.state.pattern;
    const cps = editor.repl.scheduler.cps;
    if (!pattern)
      throw new Error("no pattern after evaluate — eval probably failed");
    if (!Number.isFinite(cps) || cps <= 0) throw new Error(`bad cps: ${cps}`);

    // Sanity-check the haps before render: if the pattern is silent in the
    // requested arc, fail fast instead of writing an empty file.
    const probeHaps = pattern.queryArc(0, cycles, { _cps: cps });
    const onsetHaps = probeHaps.filter((h) => h.hasOnset?.());
    console.log(
      `[strasbeat/export] cps=${cps} cycles=${cycles} ${probeHaps.length} haps, ${onsetHaps.length} onsets`,
    );
    if (!onsetHaps.length)
      throw new Error(
        "pattern produced no onset haps for the requested cycle range",
      );

    renderedHaps = onsetHaps;
    renderedCps = cps;

    status.textContent = `pre-loading sounds for ${onsetHaps.length} events…`;

    // Let any in-flight superdough/decode calls from previous playback
    // settle against the still-alive live context. Without this pause,
    // closing the context can reject mid-flight decodeAudioData promises
    // whose rejections then poison Strudel's private loadCache forever
    // (there's no public API to clear it).
    await new Promise((r) => setTimeout(r, 120));

    // Notify listeners (e.g. scope) that the audio context is about to
    // be torn down — they should disconnect any patched state.
    if (typeof onBeforeContextTeardown === "function") {
      try {
        onBeforeContextTeardown();
      } catch (err) {
        console.warn("[strasbeat/export] context teardown hook failed:", err);
      }
    }

    const { rendered, scheduled, failures } =
      await renderPatternToBufferWithProgress(
        pattern,
        cps,
        cycles,
        sampleRate,
        (ratio) => exportPanel.showProgress(ratio),
        webaudioCtx,
      );

    // Measure the mix as rendered, then (if asked) bring its peak to
    // -1 dBFS before it is encoded: a mix past full scale would otherwise be
    // hard-clipped by the 16-bit encoder.
    const sourceStats = computeBufferStats(rendered);
    const { gain: normalizeGain } = options.normalize
      ? normalizeBuffer(rendered, sourceStats.peakAmplitude)
      : { gain: 1 };
    const stats =
      normalizeGain === 1 ? sourceStats : computeBufferStats(rendered);

    const wavArrayBuffer = audioBufferToWav16(rendered);
    // Cache a Uint8Array view so the panel's "download again" button
    // can re-download the same bytes without touching the render path.
    // The ArrayBuffer itself is handed to the initial download too;
    // wrapping it in a Blob once now and once again on re-download is
    // wasteful but harmless at typical export sizes.
    const wavBytes = new Uint8Array(wavArrayBuffer);
    downloadWav(wavArrayBuffer, filename);
    track("wav_exported", { cycles, sampleRate, normalize: !!options.normalize });

    // Events superdough refused outright (unknown sound, a node that
    // couldn't be built). They are missing from the file.
    if (failures.length) {
      const distinct = [...new Set(failures)];
      const shown = distinct.slice(0, 3).join("; ");
      consolePanel?.warn?.(
        `export: ${failures.length} of ${failures.length + scheduled} events could not be rendered and are missing from the file — ${shown}${distinct.length > 3 ? "; …" : ""}`,
      );
    }

    // errorLogger() reports without a type ("[origin] error: …"), so count
    // those as well as the typed ones.
    const errorCount = captured.filter(
      (c) => classifyStrudelLog(c.msg, c.type) === "error",
    ).length;
    if (errorCount) {
      console.warn(
        `[strasbeat/export] ${errorCount} strudel errors during render — see above`,
      );
      consolePanel?.warn?.(
        `export: ${errorCount} strudel error(s) during render — some sounds may be missing`,
      );
    }

    const duration = rendered.length / rendered.sampleRate;
    const fileSize = wavArrayBuffer.byteLength;

    if (stats.clipped) {
      consolePanel?.warn?.(
        `export: the mix peaks at ${stats.peakAmplitude.toFixed(2)} (above full scale) and was clipped in the file — turn on Normalize, or lower .gain()`,
      );
    }

    // Loud silent-export warning — the #1 export footgun.
    if (stats.peakAmplitude <= 0) {
      console.error(
        "[strasbeat/export] SILENT OUTPUT — rendered WAV is all zeros. " +
          "This usually means the audio controller was built against the " +
          "wrong context. Check the lazy-init order in renderPatternToBuffer.",
      );
      consolePanel?.error?.(
        "export produced a completely silent file — see console for details",
      );
    } else if (stats.peakAmplitude < 0.001) {
      console.warn(
        `[strasbeat/export] near-silent output: peak=${stats.peakAmplitude.toFixed(6)}`,
      );
      consolePanel?.warn?.(
        `export: near-silent output (peak ${stats.peakAmplitude.toFixed(6)}) — some sounds may not have loaded`,
      );
    }

    status.textContent = `exported ${filename}.wav (${scheduled} events${failures.length ? `, ${failures.length} failed` : ""}, ${cycles} cycle${cycles === 1 ? "" : "s"})`;
    try {
      consolePanel?.log(
        `export: done — ${scheduled} events, peak=${stats.peakAmplitude.toFixed(3)}, ${fileSize} bytes`,
      );
    } catch (err) {
      console.warn("[strasbeat/console] export log failed:", err);
    }

    return {
      buffer: rendered,
      wavBytes,
      scheduled,
      failed: failures.length,
      clipped: stats.clipped,
      cycles,
      sampleRate,
      filename,
      fileSize,
      duration,
      peakAmplitude: stats.peakAmplitude,
      // The peak before normalization, and the gain it applied (1 = none).
      sourcePeak: sourceStats.peakAmplitude,
      normalizeGain,
      percentNonZero: stats.percentNonZero,
    };
  } catch (err) {
    console.error("[strasbeat] wav export failed:", err);
    status.textContent = `export failed: ${err.message ?? err}`;
    // Echo the failure into the console panel so users who don't have
    // devtools open still see it. The panel itself also displays the
    // error in its own error state via showError, so this is a
    // deliberate double-surface.
    try {
      consolePanel?.error(`export failed: ${err?.message ?? String(err)}`, {
        error: err,
      });
    } catch (panelErr) {
      console.warn("[strasbeat/console] export error echo failed:", panelErr);
    }
    throw err;
  } finally {
    // Restore the default strudel logger.
    installDefaultStrudelLogger(setLogger);
    // The render tore down the live audio context — restore it so the
    // user can press play again without reloading. An export that failed
    // before the swap still has its live context: leave it alone rather
    // than orphaning a running AudioContext and building another.
    if (contextSwapped) try {
      setAudioContext(null);
      setSuperdoughAudioController(null);
      resetGlobalEffects();
      await initAudio({ maxPolyphony: LIVE_MAX_POLYPHONY });
      editor.repl.scheduler.stop();
      try {
        await flushStaleNodePools(renderedHaps, renderedCps, {
          superdough,
          getAudioContext,
          getSound,
        });
      } catch (err) {
        console.warn("[strasbeat/export] node pool flush failed:", err);
      }

      // Verify the restored context is actually usable — a closed or
      // suspended context that slipped through would cause all subsequent
      // playback to silently fail. Create a zero-gain oscillator and
      // start/stop it; if this throws, the context is dead and we need
      // a hard reset.
      try {
        const testCtx = getAudioContext();
        if (testCtx.state === "closed")
          throw new Error("context is closed after restore");
        if (testCtx.state === "suspended") await testCtx.resume();
        const testOsc = testCtx.createOscillator();
        const testGain = testCtx.createGain();
        testGain.gain.value = 0;
        testOsc.connect(testGain).connect(testCtx.destination);
        testOsc.start();
        testOsc.stop(testCtx.currentTime + 0.001);
        testGain.disconnect();
      } catch (verifyErr) {
        console.error(
          "[strasbeat/export] restored context failed verification — " +
            "forcing a full reset:",
          verifyErr,
        );
        // Nuclear option: null everything and rebuild from scratch.
        setAudioContext(null);
        setSuperdoughAudioController(null);
        resetGlobalEffects();
        await initAudio({ maxPolyphony: LIVE_MAX_POLYPHONY });
        status.textContent =
          "audio restored after export (required full reset) — press play";
      }
    } catch (err) {
      console.error("[strasbeat] failed to restore audio after export:", err);
      status.textContent =
        "audio restore failed after export — reload the page to continue";
      consolePanel?.error?.(
        "failed to restore audio after export — you may need to reload",
      );
    }
    _exportRunning = false;
    exportBtn.disabled = false;
    if (exportLabel) exportLabel.textContent = "wav";

    // Notify listeners (e.g. scope) that a fresh audio context is ready.
    if (typeof onAfterContextRestore === "function") {
      try {
        onAfterContextRestore();
      } catch (err) {
        console.warn("[strasbeat/export] context restore hook failed:", err);
      }
    }
  }
}
