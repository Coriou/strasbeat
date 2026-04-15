// Scope (oscilloscope) — taps superdough's main output and renders a
// real-time waveform to the roll canvas.
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

import { getSuperdoughAudioController } from "@strudel/webaudio";

export function createScope() {
  let analyser = null;
  let dataArray = null;
  let tappedOutput = null;

  let cachedTokenCanvas = null;
  let cachedTokens = null;
  let tokenTimer = null;

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
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.4;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      out.connect(analyser);
      tappedOutput = out;
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
    dataArray = null;
    tappedOutput = null;
  }

  function render(ctx, width, height) {
    const t = readTokens(ctx.canvas);

    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, width, height);

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
    if (!ready || !analyser || !dataArray) return;

    analyser.getByteTimeDomainData(dataArray);

    // Falling-edge trigger: find where the signal crosses the center line
    // going downward, so the waveform locks to pitch instead of wobbling.
    // Search only the first half so we always have room to draw.
    const len = dataArray.length;
    let start = 0;
    const scanEnd = len >> 1;
    for (let i = 1; i < scanEnd; i++) {
      if (dataArray[i - 1] > 128 && dataArray[i] <= 128) {
        start = i;
        break;
      }
    }

    const drawCount = len - start;
    const sliceWidth = width / drawCount;

    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();

    let x = 0;
    for (let i = 0; i < drawCount; i++) {
      const v = dataArray[start + i] / 128.0;
      const y = (v * height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
  }

  return { ensureConnected, disconnect, render };
}
