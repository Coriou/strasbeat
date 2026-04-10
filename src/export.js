import {
  installDefaultStrudelLogger,
  shouldIgnoreStrudelLog,
} from "./strudel-logger.js";

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

// Module-level export lock — prevents concurrent exports from corrupting
// the global audio context / controller state.
let _exportRunning = false;
export function isExportRunning() {
  return _exportRunning;
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
 * @param {object} [opts] { onProgress?: (loaded, total) => void }
 * @returns {Promise<{ warmed: number, failed: string[] }>}
 */
export async function prewarmSounds(haps, deps, opts = {}) {
  const { getSound, getAudioContext } = deps;
  const { onProgress } = opts;

  // Collect unique sound keys (with bank prefix, matching superdough's lookup).
  const seen = new Map(); // soundKey → representative hap.value
  for (const hap of haps) {
    if (!hap.hasOnset?.()) continue;
    const v = hap.value;
    if (typeof v !== "object") continue;
    let s = v.s ?? "triangle";
    if (v.bank && s) s = `${v.bank}_${s}`;
    if (["-", "~", "_"].includes(s)) continue;
    if (!seen.has(s)) seen.set(s, v);
  }

  const total = seen.size;
  let loaded = 0;
  let warmed = 0;
  const failed = [];

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

  return { warmed, failed, total };
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
  } = ctx;

  // Query haps first so we can pre-warm while the live context is still open.
  const haps = pattern
    .queryArc(0, cycles, { _cps: cps })
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  // Pre-warm: force all unique sound buffers to load using the live context.
  // This prevents cache-poisoning from a mid-flight close (see prewarmSounds).
  await prewarmSounds(haps, { getSound, getAudioContext });

  const live = getAudioContext();
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

  let scheduled = 0;
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
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
    }
  }

  const rendered = await offline.startRendering();
  return { rendered, scheduled };
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
  URL.revokeObjectURL(url);
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
// order exactly — DO NOT re-order them (see CLAUDE.md § "WAV export:
// DO NOT use upstream renderPatternAudio"): the `SuperdoughAudio
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

  let scheduled = 0;
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
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
    }
  }

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
    return { rendered, scheduled };
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
  };
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
  } = ctx;

  // ── Mutex: refuse if an export is already in flight ──
  if (_exportRunning) {
    const msg = "export already in progress — wait for it to finish";
    status.textContent = msg;
    consolePanel?.warn?.(msg);
    throw new Error(msg);
  }
  _exportRunning = true;

  const webaudioCtx = {
    getAudioContext,
    getSound,
    setAudioContext,
    setSuperdoughAudioController,
    initAudio,
    superdough,
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

  // Surface per-hap errors that superdough's errorLogger normally swallows.
  const captured = [];
  setLogger((msg, type) => {
    if (shouldIgnoreStrudelLog(msg)) return;
    captured.push({ msg, type });
    if (type === "error" || type === "warning") console.warn("[strudel]", msg);
    else console.log("[strudel]", msg);
  });

  try {
    await editor.evaluate(false);
    editor.repl.scheduler.stop();

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

    status.textContent = `pre-loading sounds for ${onsetHaps.length} events…`;

    // Let any in-flight superdough/decode calls from previous playback
    // settle against the still-alive live context. Without this pause,
    // closing the context can reject mid-flight decodeAudioData promises
    // whose rejections then poison Strudel's private loadCache forever
    // (there's no public API to clear it).
    await new Promise((r) => setTimeout(r, 120));

    const { rendered, scheduled } = await renderPatternToBufferWithProgress(
      pattern,
      cps,
      cycles,
      sampleRate,
      (ratio) => exportPanel.showProgress(ratio),
      webaudioCtx,
    );

    const wavArrayBuffer = audioBufferToWav16(rendered);
    // Cache a Uint8Array view so the panel's "download again" button
    // can re-download the same bytes without touching the render path.
    // The ArrayBuffer itself is handed to the initial download too;
    // wrapping it in a Blob once now and once again on re-download is
    // wasteful but harmless at typical export sizes.
    const wavBytes = new Uint8Array(wavArrayBuffer);
    downloadWav(wavArrayBuffer, filename);

    const errorCount = captured.filter((c) => c.type === "error").length;
    if (errorCount) {
      console.warn(
        `[strasbeat/export] ${errorCount} strudel errors during render — see above`,
      );
      consolePanel?.warn?.(
        `export: ${errorCount} strudel error(s) during render — some sounds may be missing`,
      );
    }

    const stats = computeBufferStats(rendered);
    const duration = rendered.length / rendered.sampleRate;
    const fileSize = wavArrayBuffer.byteLength;

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

    status.textContent = `exported ${filename}.wav (${scheduled} events, ${cycles} cycle${cycles === 1 ? "" : "s"})`;
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
      cycles,
      sampleRate,
      filename,
      fileSize,
      duration,
      peakAmplitude: stats.peakAmplitude,
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
    // user can press play again without reloading.
    try {
      setAudioContext(null);
      setSuperdoughAudioController(null);
      resetGlobalEffects();
      await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });
      editor.repl.scheduler.stop();

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
        await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });
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
  }
}
