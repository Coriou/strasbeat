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
    setAudioContext,
    setSuperdoughAudioController,
    initAudio,
    superdough,
  } = ctx;
  const live = getAudioContext();
  await live.close();
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
    setAudioContext,
    setSuperdoughAudioController,
    initAudio,
    superdough,
  } = ctx;
  const live = getAudioContext();
  await live.close();
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
    setAudioContext,
    setSuperdoughAudioController,
    resetGlobalEffects,
    initAudio,
    superdough,
  } = ctx;
  const webaudioCtx = {
    getAudioContext,
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
    if (errorCount)
      console.warn(
        `[strasbeat/export] ${errorCount} strudel errors during render — see above`,
      );

    const stats = computeBufferStats(rendered);
    const duration = rendered.length / rendered.sampleRate;
    const fileSize = wavArrayBuffer.byteLength;

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
      console.error("[strasbeat] failed to restore audio after export:", err);
    }
    exportBtn.disabled = false;
    if (exportLabel) exportLabel.textContent = "wav";
  }
}
