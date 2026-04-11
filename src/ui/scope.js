// Scope (oscilloscope) visualization — renders a real-time waveform of
// the audio output to a canvas. Used as an alternative bottom-panel
// mode alongside the piano roll.
// See design/work/14-strudel-learning-and-extensibility.md Phase 5.
//
// Usage:
//   const scope = createScope();
//   scope.connect(audioContext);          // lazy AnalyserNode creation
//   scope.render(ctx, width, height);     // call in onDraw
//   scope.disconnect();                   // cleanup
//
// Audio routing: AudioDestinationNode has no output channels, so the
// naive `destination.connect(analyser)` silently produces zero data.
// Instead we override the context's `destination` getter to return a
// proxy GainNode that routes to both the real destination and our
// analyser. All future audio routed to `ctx.destination` (including
// superdough's one-shot calls) will be captured. Existing connections
// made before connect() are unaffected — those are rare since Strudel
// creates and connects nodes per-event.

export function createScope() {
  let analyser = null;
  let dataArray = null;
  let proxyGain = null;
  let realDestination = null;
  let patchedContext = null;
  // Cache token values so we don't call getComputedStyle every frame.
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
    // Invalidate cached tokens after a short delay so theme changes are
    // picked up without needing an explicit refresh.
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(() => {
      cachedTokens = null;
    }, 2000);
    return cachedTokens;
  }

  function connect(audioContext) {
    if (analyser) return;
    try {
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.4;
      dataArray = new Uint8Array(analyser.frequencyBinCount);

      // Intercept the destination getter so all future audio routes
      // through a pass-through gain node that splits the signal to
      // both the real destination and our analyser.
      realDestination = audioContext.destination;
      proxyGain = audioContext.createGain();
      proxyGain.connect(realDestination);
      proxyGain.connect(analyser);

      Object.defineProperty(audioContext, "destination", {
        get: () => proxyGain,
        configurable: true,
      });
      patchedContext = audioContext;
    } catch (err) {
      console.warn(
        "[strasbeat/scope] failed to tap audio output:",
        err,
        "— scope will show flat line",
      );
      // Leave analyser created so render() at least clears the canvas.
    }
  }

  function disconnect() {
    // Restore the original destination getter.
    if (patchedContext && realDestination) {
      try {
        Object.defineProperty(patchedContext, "destination", {
          get: () => realDestination,
          configurable: true,
        });
      } catch {
        // Context may already be closed post-export.
      }
    }
    if (proxyGain) {
      try {
        proxyGain.disconnect();
      } catch {}
      proxyGain = null;
    }
    if (analyser) {
      try {
        analyser.disconnect();
      } catch {}
      analyser = null;
      dataArray = null;
    }
    realDestination = null;
    patchedContext = null;
    cachedTokenCanvas = null;
    cachedTokens = null;
    clearTimeout(tokenTimer);
  }

  function render(ctx, width, height) {
    if (!analyser || !dataArray) {
      drawFlatLine(ctx, width, height);
      return;
    }

    analyser.getByteTimeDomainData(dataArray);
    const t = readTokens(ctx.canvas);

    // Background
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, width, height);

    // Center line
    ctx.strokeStyle = t.gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();

    const sliceWidth = width / dataArray.length;
    let x = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] / 128.0; // normalize 0-255 → 0-2
      const y = (v * height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }

  function drawFlatLine(ctx, width, height) {
    const t = readTokens(ctx.canvas);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = t.gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  return { connect, disconnect, render };
}
