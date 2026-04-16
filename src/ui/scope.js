// Scope (oscilloscope) — taps superdough's main output and renders a
// real-time waveform / spectrum to the roll canvas.
//
// Audio routing: SuperdoughAudioController builds a fixed chain at
// construction time — channelMerger → destinationGain → ctx.destination —
// and every voice connects through destinationGain. We tap that node
// directly. Intercepting ctx.destination (the previous approach) cannot
// work: superdough's chain is connected to the real destination at
// construction, so a later getter swap on ctx.destination is bypassed.
//
// The connection is lazy + idempotent: render() calls ensureConnected()
// each frame, so the scope transparently survives context teardown/
// restore (WAV export) and late audio-controller construction.
//
// Render modes share the same AnalyserNode but read different typed
// arrays: Float32Array[fftSize] for time domain (range [-1, 1]) and
// Float32Array[frequencyBinCount] for frequency domain (range ~[-100, 0]
// dB). Switching modes at runtime is a different getter call, not a node
// rebuild. The render pipeline adds four knobs on top of upstream:
//
//   scale    — y-axis zoom (time) / bar-height zoom (freq), 0.1 – 4
//   smear    — per-frame alpha-fill of the background so the trace leaves
//              a fading trail instead of being hard-cleared each frame
//   trigger  — threshold for the falling-edge alignment scan (time only)
//   mode     — 'time' | 'freq'
//
// Config is owned by setConfig/getConfig and persisted by scope-controls.js.
// needsClear forces a full hard clear on the next frame after a mode flip
// or after the scope regains the canvas from another mode (Roll / Beat grid).

import { getSuperdoughAudioController } from "@strudel/webaudio";

const FFT_SIZE = 2048;

const DEFAULTS = {
  mode: "time",
  scale: 1.0,
  smear: 0,
  trigger: 0,
};

// Freq-mode dB window — matches upstream drawFrequencyScope's [min, max].
const FREQ_DB_MIN = -100;
const FREQ_DB_MAX = 0;

export function createScope() {
  let analyser = null;
  let timeBuf = null;
  let freqBuf = null;
  let tappedOutput = null;

  let cachedTokenCanvas = null;
  let cachedTokens = null;
  let tokenTimer = null;

  const config = { ...DEFAULTS };
  let needsClear = true;

  function readTokens(canvas) {
    if (canvas === cachedTokenCanvas && cachedTokens) return cachedTokens;
    const cs = getComputedStyle(canvas);
    cachedTokenCanvas = canvas;
    cachedTokens = {
      bg: cs.getPropertyValue("--surface-1").trim() || "#1a1a1a",
      accent: cs.getPropertyValue("--accent").trim() || "oklch(0.63 0.19 358)",
      gridColor:
        cs.getPropertyValue("--border-soft").trim() || "oklch(0.26 0 0)",
    };
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(() => {
      cachedTokens = null;
    }, 2000);
    return cachedTokens;
  }

  function ensureConnected() {
    let controller;
    try {
      controller = getSuperdoughAudioController();
    } catch {
      return false;
    }
    // SuperdoughAudioController → SuperdoughOutput (`.output`) holds the
    // destinationGain node that every voice flows through.
    const out = controller?.output?.destinationGain;
    if (!out) return false;
    if (tappedOutput === out && analyser) return true;

    // Controller was rebuilt (post-export restore) — drop stale analyser.
    disconnect();

    try {
      analyser = out.context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.4;
      timeBuf = new Float32Array(analyser.fftSize);
      freqBuf = new Float32Array(analyser.frequencyBinCount);
      out.connect(analyser);
      tappedOutput = out;
      // Controller swap leaves a frame of whatever-was-there on the canvas;
      // force a hard clear so we don't smear past frames into fresh audio.
      needsClear = true;
      return true;
    } catch (err) {
      console.warn("[strasbeat/scope] failed to tap output:", err);
      disconnect();
      return false;
    }
  }

  function disconnect() {
    if (tappedOutput && analyser) {
      try {
        tappedOutput.disconnect(analyser);
      } catch {}
    }
    if (analyser) {
      try {
        analyser.disconnect();
      } catch {}
    }
    analyser = null;
    timeBuf = null;
    freqBuf = null;
    tappedOutput = null;
  }

  function setConfig(next) {
    if (!next || typeof next !== "object") return;
    const before = config.mode;
    if (next.mode === "time" || next.mode === "freq") config.mode = next.mode;
    if (Number.isFinite(next.scale)) config.scale = clamp(next.scale, 0.1, 4);
    if (Number.isFinite(next.smear)) config.smear = clamp(next.smear, 0, 0.99);
    if (Number.isFinite(next.trigger))
      config.trigger = clamp(next.trigger, -1, 1);
    if (config.mode !== before) needsClear = true;
  }

  function getConfig() {
    return { ...config };
  }

  // External hook for main.js: the scope shares the roll canvas, so when
  // the bottom-panel mode switches away and back we must hard-clear once
  // to drop whatever the other renderer left behind.
  function markDirty() {
    needsClear = true;
  }

  function render(ctx, width, height) {
    const t = readTokens(ctx.canvas);
    const dpr = window.devicePixelRatio || 1;
    // Canvas backing store is device-pixel-sized (see main.js resizeCanvas).
    // Set the transform every frame so we can think in CSS pixels and stay
    // robust to whatever the previous renderer (Roll / custom) left on ctx.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const smear = config.smear;
    if (smear <= 0 || needsClear) {
      ctx.fillStyle = t.bg;
      ctx.fillRect(0, 0, width, height);
      needsClear = false;
    } else {
      // Alpha-fill the bg so older frames fade at geometric rate (1-smear)^n.
      ctx.fillStyle = bgWithAlpha(t.bg, 1 - smear);
      ctx.fillRect(0, 0, width, height);
    }

    const centerY = height / 2;

    // Subtle baseline — always visible so the panel never reads as empty.
    ctx.strokeStyle = t.gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    ctx.setLineDash([]);

    const ready = ensureConnected();
    if (!ready || !analyser) return;

    if (config.mode === "freq") {
      analyser.getFloatFrequencyData(freqBuf);
      drawFreq(ctx, width, height, centerY, t);
    } else {
      analyser.getFloatTimeDomainData(timeBuf);
      drawTime(ctx, width, height, centerY, t);
    }
  }

  function drawTime(ctx, width, height, centerY, tokens) {
    const data = timeBuf;
    const len = data.length;
    const trigger = config.trigger;
    const scale = config.scale;

    // Falling-edge trigger scan — ported from upstream drawTimeScope. The
    // threshold is -trigger (upstream convention), so trigger=0 parks the
    // trace at the first zero-crossing going down.
    let start = 0;
    const scanEnd = len >> 1;
    for (let i = 1; i < scanEnd; i++) {
      if (data[i - 1] > -trigger && data[i] <= -trigger) {
        start = i;
        break;
      }
    }

    const drawCount = len - start;
    const sliceWidth = width / drawCount;
    const halfH = height / 2;

    ctx.strokeStyle = tokens.accent;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();

    let x = 0;
    for (let i = 0; i < drawCount; i++) {
      const v = data[start + i];
      const y = centerY - v * halfH * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
  }

  function drawFreq(ctx, width, height, centerY, tokens) {
    const data = freqBuf;
    const binCount = data.length;
    const scale = config.scale;
    const halfH = height / 2;
    const range = FREQ_DB_MAX - FREQ_DB_MIN;
    // Log-scaled x axis: bins are spaced by log2 so bass/mids/treble each
    // get roughly equal real estate. Linear-freq crowds the bass into 1/10
    // of the width and reads as a solid blob for most music.
    const logMax = Math.log2(binCount + 1);

    ctx.fillStyle = tokens.accent;
    for (let i = 0; i < binCount; i++) {
      const db = data[i];
      // Float dB readings go to -Infinity for silent bins; clamp before the
      // normalize so NaN doesn't leak into fillRect.
      const clamped = Number.isFinite(db) ? db : FREQ_DB_MIN;
      const normalized = clamp((clamped - FREQ_DB_MIN) / range, 0, 1);
      const barHeight = normalized * scale * halfH;
      if (barHeight <= 0.5) continue;
      const x0 = (Math.log2(i + 1) / logMax) * width;
      const x1 = (Math.log2(i + 2) / logMax) * width;
      const barWidth = Math.max(x1 - x0, 1);
      // Bloom up + down from centerline — reads as a spectrogram, not a
      // bar chart sitting on the floor.
      ctx.fillRect(x0, centerY - barHeight, barWidth, barHeight * 2);
    }
  }

  return {
    ensureConnected,
    disconnect,
    render,
    setConfig,
    getConfig,
    markDirty,
  };
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

// Take an OKLCH token string like "oklch(0.2 0 0)" or
// "oklch(0.63 0.19 358 / 0.12)" and emit the same color with a different
// alpha. Falls back to a near-black rgba if the token isn't OKLCH — the
// scope panel bg is surface-1 (near-black) so a few shades off on the
// smear fill won't read as a bug.
function bgWithAlpha(oklchStr, alpha) {
  const m = /^\s*oklch\(\s*([^/)]+?)\s*(?:\/[^)]+)?\s*\)\s*$/.exec(
    oklchStr || "",
  );
  if (m) return `oklch(${m[1].trim()} / ${alpha})`;
  return `rgba(0, 0, 0, ${alpha})`;
}
