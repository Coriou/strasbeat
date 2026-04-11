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

export function createScope() {
  let analyser = null;
  let dataArray = null;

  function connect(audioContext) {
    if (analyser) return;
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.4;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    // Connect to audio context destination so we see the final output.
    try {
      audioContext.destination.connect?.(analyser);
    } catch {
      // Some audio contexts don't allow connecting from destination.
      // Fall back to connecting the analyser to nothing — the caller will
      // need to route audio through us.
    }
  }

  function disconnect() {
    if (analyser) {
      try {
        analyser.disconnect();
      } catch {}
      analyser = null;
      dataArray = null;
    }
  }

  function render(ctx, width, height) {
    if (!analyser || !dataArray) {
      // Not connected — draw a flat line.
      drawFlatLine(ctx, width, height);
      return;
    }

    analyser.getByteTimeDomainData(dataArray);

    const cs = getComputedStyle(ctx.canvas);
    const bg = cs.getPropertyValue("--surface-1").trim() || "#1a1a1a";
    const accent =
      cs.getPropertyValue("--accent").trim() || "oklch(0.63 0.19 358)";
    const gridColor =
      cs.getPropertyValue("--border-soft").trim() || "oklch(0.26 0 0)";

    // Background
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Center line
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform
    ctx.strokeStyle = accent;
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
    const cs = getComputedStyle(ctx.canvas);
    const bg = cs.getPropertyValue("--surface-1").trim() || "#1a1a1a";
    const gridColor =
      cs.getPropertyValue("--border-soft").trim() || "oklch(0.26 0 0)";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = gridColor;
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
