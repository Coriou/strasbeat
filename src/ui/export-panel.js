// Export panel — fourth tab in the right rail.
//
// Replaces the modal-based WAV export flow with a proper in-rail panel:
// filename + cycles + sample-rate controls, a real progress bar during
// the offline render, and a post-export view with waveform + stats +
// silent-export warning + download-again. The toolbar WAV button stays
// as a quick-export shortcut — `autoExport()` lets the host kick off an
// export from outside the panel using whatever settings are in the
// inputs right now. See design/work/08-feature-parity-and-beyond.md
// "Phase 4: Enhanced Export Panel".
//
// The panel owns the UI, never the audio pipeline. The host (main.js)
// supplies an `onExport(options)` callback that does the actual render
// (including offline-context progress polling) and returns an
// `ExportResult` the panel uses to draw the waveform / stats. This
// keeps the render path (see CLAUDE.md § "WAV export: DO NOT use
// upstream renderPatternAudio") out of panel code where a casual edit
// could reintroduce the eager-controller silent-output bug.
//
// Public surface (factory pattern — same shape as the other panels):
//
//   const panel = createExportPanel({
//     onFocusEditor,   // () => void        — Escape returns focus
//     onExport,        // (options: ExportOptions) => Promise<ExportResult>
//     getPatternName,  // () => string      — seeds the filename input
//   });
//   rightRail.registerPanel(panel);
//
//   panel.showProgress(0.73);     // called from the host's poll loop
//   panel.showResult(result);     // called when onExport() resolves
//   panel.showError('…');         // called when onExport() rejects
//   panel.reset();                // back to idle
//   panel.autoExport();           // toolbar button entry point
//
// ExportOptions: { cycles, sampleRate, filename }
// ExportResult:  { buffer, scheduled, cycles, sampleRate, filename,
//                  fileSize, duration, peakAmplitude, percentNonZero }
//
// Pure DOM, no framework. Match the imperative style of
// src/ui/sound-browser.js, src/ui/reference-panel.js, and
// src/ui/console-panel.js.

import { makeIcon } from "./icons.js";

const STORAGE_KEY_CYCLES = "strasbeat:export-cycles";
const STORAGE_KEY_RATE = "strasbeat:export-rate";
const STORAGE_KEY_FILENAME = "strasbeat:export-filename";

const DEFAULT_CYCLES = 4;
const MIN_CYCLES = 1;
const MAX_CYCLES = 128;

const SAMPLE_RATES = [44100, 48000, 96000];
const DEFAULT_SAMPLE_RATE = 48000;

// Waveform canvas logical size — the backing store is scaled by dpr on
// create() so HiDPI displays still get crisp lines.
const WAVEFORM_HEIGHT_CSS = 64;
// The render loop down-samples the buffer to one column per pixel; this
// guard keeps the loop from doing anything pathological on a 1px canvas.
const WAVEFORM_MIN_COLS = 16;
// Near-silent heuristic — peak below -60 dB is effectively silence even
// if the buffer has a handful of non-zero samples. Matches the threshold
// a WAV-export sanity check would care about: if the user won't be able
// to hear it, warn.
const NEAR_SILENT_PEAK = 0.001;

export function createExportPanel({
  onFocusEditor = () => {},
  onExport = async () => {
    throw new Error("export-panel: onExport not wired");
  },
  getPatternName = () => "untitled",
}) {
  // ─── State ────────────────────────────────────────────────────────────
  // 'idle' — show inputs + Export button; progress/result/error hidden
  // 'running' — progress bar visible, inputs disabled, button → "Cancel"
  // 'done' — waveform + stats + download-again shown below progress
  // 'error' — error message + try-again shown below progress
  let mode = "idle";
  /** @type {ExportResult | null} Last successful render — cached so the
   *  download-again button can redownload without re-rendering. */
  let lastResult = null;
  let lastWavBytes = null; // cached Uint8Array from lastResult for re-download

  // DOM refs (re-bound on create()).
  let root = null;
  let filenameInput = null;
  let cyclesInput = null;
  let rateSelect = null;
  let exportBtn = null;
  let progressRow = null;
  let progressFill = null;
  let progressLabel = null;
  let resultSection = null;
  let waveformCanvas = null;
  let statsLine1 = null;
  let statsLine2 = null;
  let statsPeak = null;
  let warningEl = null;
  let downloadAgainBtn = null;
  let errorSection = null;
  let errorMsgEl = null;
  let tryAgainBtn = null;
  let mounted = false;

  // ─── Right-rail panel spec ────────────────────────────────────────────

  return {
    id: "export",
    icon: "download",
    label: "Export",
    create,
    activate,
    deactivate,
    showProgress,
    showResult,
    showError,
    reset,
    autoExport,
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────

  function create(container) {
    root = container;
    root.classList.add("export-panel");
    root.appendChild(buildHeader());

    // ─── Controls block ────────────────────────────────────────────────
    // Three rows: filename, cycles, sample rate. Every row shares the
    // same label-then-control layout via grid so the control columns
    // line up regardless of label text.
    const controls = el("div", "export-panel__controls");

    // Filename — defaults to the current pattern name, refreshed on
    // every activate() so the input always reflects what's loaded. The
    // input never carries a `.wav` suffix; the host appends it.
    const filenameRow = buildRow("Filename");
    filenameInput = el("input", "export-panel__input");
    filenameInput.type = "text";
    filenameInput.placeholder = "pattern";
    filenameInput.setAttribute("aria-label", "Filename");
    filenameInput.spellcheck = false;
    filenameInput.autocomplete = "off";
    filenameInput.value = getPatternName() || "untitled";
    filenameInput.addEventListener("keydown", onInputKeydown);
    const filenameField = el("div", "export-panel__field");
    filenameField.appendChild(filenameInput);
    filenameField.appendChild(el("span", "export-panel__suffix", ".wav"));
    filenameRow.control.appendChild(filenameField);
    controls.appendChild(filenameRow.row);

    // Cycles — number input with min/max validation deferred until the
    // user clicks Export (validating on every keystroke is obnoxious).
    // Persisted to localStorage so the last-used value survives reload.
    const cyclesRow = buildRow("Cycles");
    cyclesInput = el("input", "export-panel__input export-panel__input--num");
    cyclesInput.type = "number";
    cyclesInput.min = String(MIN_CYCLES);
    cyclesInput.max = String(MAX_CYCLES);
    cyclesInput.step = "1";
    cyclesInput.inputMode = "numeric";
    cyclesInput.setAttribute("aria-label", "Cycles to render");
    cyclesInput.value = String(readStoredCycles());
    cyclesInput.addEventListener("keydown", onInputKeydown);
    cyclesInput.addEventListener("change", () => {
      // Persist whatever the user committed (blur/enter), not every
      // keystroke — otherwise half-typed values get saved.
      const parsed = parseCycles(cyclesInput.value);
      if (parsed != null) writeStoredCycles(parsed);
    });
    cyclesRow.control.appendChild(cyclesInput);
    controls.appendChild(cyclesRow.row);

    // Sample rate — the design system forbids native <select> (SYSTEM.md
    // §2.7) but shipping a popover picker for three options is overkill.
    // Style the native select to match the other controls instead; it
    // blends in well enough and the options list is short. A future
    // custom picker can drop in without touching the rest of the panel.
    const rateRow = buildRow("Rate");
    rateSelect = el("select", "export-panel__select");
    rateSelect.setAttribute("aria-label", "Sample rate");
    const storedRate = readStoredRate();
    for (const rate of SAMPLE_RATES) {
      const opt = document.createElement("option");
      opt.value = String(rate);
      opt.textContent = `${rate} Hz`;
      if (rate === storedRate) opt.selected = true;
      rateSelect.appendChild(opt);
    }
    rateSelect.addEventListener("change", () => {
      const parsed = parseInt(rateSelect.value, 10);
      if (SAMPLE_RATES.includes(parsed)) writeStoredRate(parsed);
    });
    rateSelect.addEventListener("keydown", onInputKeydown);
    rateRow.control.appendChild(rateSelect);
    controls.appendChild(rateRow.row);

    root.appendChild(controls);

    // ─── Export button ─────────────────────────────────────────────────
    exportBtn = el("button", "export-panel__export");
    exportBtn.type = "button";
    const btnIcon = el("span", "export-panel__export-icon");
    btnIcon.appendChild(makeIcon("download"));
    exportBtn.appendChild(btnIcon);
    const btnLabel = el("span", "export-panel__export-label", "Export");
    exportBtn.appendChild(btnLabel);
    exportBtn.addEventListener("click", onExportClick);
    root.appendChild(exportBtn);

    const exportHint = el(
      "div",
      "export-panel__hint",
      "Offline render. .wav is added automatically.",
    );
    root.appendChild(exportHint);

    // ─── Progress row (hidden until a render starts) ──────────────────
    progressRow = el("div", "export-panel__progress");
    progressRow.hidden = true;
    const progressBar = el("div", "export-panel__progress-bar");
    progressFill = el("div", "export-panel__progress-fill");
    progressBar.appendChild(progressFill);
    progressRow.appendChild(progressBar);
    progressLabel = el("div", "export-panel__progress-label", "0%");
    progressRow.appendChild(progressLabel);
    root.appendChild(progressRow);

    // ─── Result section (hidden until a render succeeds) ──────────────
    resultSection = el("div", "export-panel__result");
    resultSection.hidden = true;

    // Waveform canvas. Size is set in CSS; the backing store is scaled
    // to dpr when we draw into it so HiDPI screens stay crisp.
    const waveformWrap = el("div", "export-panel__waveform");
    waveformCanvas = document.createElement("canvas");
    waveformCanvas.className = "export-panel__waveform-canvas";
    waveformCanvas.setAttribute("aria-label", "Exported waveform");
    waveformWrap.appendChild(waveformCanvas);
    resultSection.appendChild(waveformWrap);

    // Stats lines — two rows of dense mono text + a per-line peak read-
    // out. The spec shows peak dB with an "silent!" fallback when the
    // buffer is completely zero.
    statsLine1 = el("div", "export-panel__stats export-panel__stats--name");
    statsLine2 = el("div", "export-panel__stats");
    statsPeak = el("div", "export-panel__stats export-panel__stats--peak");
    resultSection.appendChild(statsLine1);
    resultSection.appendChild(statsLine2);
    resultSection.appendChild(statsPeak);

    // Silent-export warning — hidden by default, filled in by showResult
    // when peak is near zero.
    warningEl = el("div", "export-panel__warning");
    warningEl.hidden = true;
    warningEl.textContent = "This export appears silent — check your pattern.";
    resultSection.appendChild(warningEl);

    // Download-again button — re-downloads the cached WAV bytes so the
    // user doesn't have to re-render just to save it to a different
    // folder.
    downloadAgainBtn = el(
      "button",
      "export-panel__download-again",
      "Download again",
    );
    downloadAgainBtn.type = "button";
    downloadAgainBtn.addEventListener("click", onDownloadAgain);
    resultSection.appendChild(downloadAgainBtn);

    root.appendChild(resultSection);

    // ─── Error section (hidden until showError is called) ─────────────
    errorSection = el("div", "export-panel__error");
    errorSection.hidden = true;
    errorMsgEl = el("div", "export-panel__error-message");
    errorSection.appendChild(errorMsgEl);
    tryAgainBtn = el("button", "export-panel__try-again", "Try again");
    tryAgainBtn.type = "button";
    tryAgainBtn.addEventListener("click", () => {
      reset();
      filenameInput?.focus();
    });
    errorSection.appendChild(tryAgainBtn);
    root.appendChild(errorSection);

    mounted = true;
  }

  function activate() {
    if (!mounted) return;
    // Current pattern name wins — so switching patterns via the left rail
    // always shows the right filename. Stored filename is a fallback only
    // when no pattern is loaded. Leave the value alone while a render is
    // in flight or after a successful render, so the user can still see
    // what was just exported.
    if (mode === "idle" && filenameInput) {
      filenameInput.value =
        getPatternName() || readStoredFilename() || "untitled";
    }
    if (filenameInput) {
      filenameInput.focus();
      filenameInput.select();
    }
  }

  function deactivate() {
    // Nothing to tear down — the panel keeps its DOM so re-activate is
    // fast and post-export state is preserved while the user browses
    // other tabs.
  }

  // ─── Public API (host → panel) ────────────────────────────────────────

  function buildHeader() {
    const header = el("div", "export-panel__header");
    const titleWrap = el("div", "export-panel__title-wrap");
    titleWrap.appendChild(el("div", "export-panel__eyebrow", "Offline render"));
    titleWrap.appendChild(el("div", "export-panel__title", "Export WAV"));
    titleWrap.appendChild(
      el(
        "div",
        "export-panel__meta",
        "Render the current pattern to disk with the current settings.",
      ),
    );
    header.appendChild(titleWrap);
    return header;
  }

  function showProgress(ratio) {
    if (!mounted) return;
    if (mode !== "running") {
      // A progress update while not running is a no-op: the host starts
      // polling before awaiting startRendering(), so `mode` is already
      // 'running' by the time ratio > 0 arrives.
      return;
    }
    const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
    if (progressFill) progressFill.style.transform = `scaleX(${pct.toFixed(4)})`;
    if (progressLabel) progressLabel.textContent = `${Math.round(pct * 100)}%`;
  }

  function showResult(result) {
    if (!mounted || !result) return;
    mode = "done";
    lastResult = result;
    lastWavBytes = result.wavBytes ?? null;

    // Pin the progress bar at 100% so the transition from "rendering" to
    // "done" reads naturally — a jump back to 0% would look broken.
    if (progressFill) progressFill.style.transform = "scaleX(1)";
    if (progressLabel) progressLabel.textContent = "100%";

    renderWaveform(result.buffer);

    const displayName = withWavSuffix(result.filename);
    const duration = Number(result.duration) || 0;
    const scheduled = Number(result.scheduled) || 0;
    const rate = Number(result.sampleRate) || 0;
    const size = Number(result.fileSize) || 0;
    const peak = Number(result.peakAmplitude) || 0;
    const pctNonZero = Number(result.percentNonZero) || 0;

    statsLine1.textContent = `${displayName} — ${fmtDuration(duration)}`;
    statsLine2.textContent =
      `${scheduled} event${scheduled === 1 ? "" : "s"} · ` +
      `${fmtRateKhz(rate)} · ${fmtFileSize(size)}`;

    // Peak — the spec asks for "-∞ dB (silent!)" in --rec when the
    // buffer is all zeros. Any non-zero sample at least earns a proper
    // dB number, but the near-silent warning below still fires if it's
    // below -60 dB.
    statsPeak.classList.remove("export-panel__stats--silent");
    if (peak <= 0) {
      statsPeak.textContent = "Peak: -∞ dB (silent!)";
      statsPeak.classList.add("export-panel__stats--silent");
    } else {
      statsPeak.textContent = `Peak: ${fmtDb(peak)} dB`;
    }

    // Silent-export warning — spec says fire if peak is 0 OR non-zero %
    // is below 0.1. Add the near-silent guard so "audible but basically
    // nothing" also trips the warning, since the user probably meant
    // something louder.
    const isSilentish =
      peak <= 0 || pctNonZero < 0.1 || peak < NEAR_SILENT_PEAK;
    warningEl.hidden = !isSilentish;

    // Make sure the UI structure reflects 'done' mode.
    progressRow.hidden = false;
    resultSection.hidden = false;
    errorSection.hidden = true;
    // Re-enable inputs now that the render is done.
    setInputsDisabled(false);
    setExportButtonState("done");
  }

  function showError(message) {
    if (!mounted) return;
    mode = "error";
    errorMsgEl.textContent = String(message ?? "Export failed.");
    errorSection.hidden = false;
    resultSection.hidden = true;
    // Leave the progress bar visible wherever it reached — the spec
    // says "display the error below the progress bar (which should show
    // at whatever ratio it reached)".
    progressRow.hidden = false;
    setInputsDisabled(false);
    setExportButtonState("error");
  }

  function reset() {
    mode = "idle";
    // Don't clear lastResult / lastWavBytes — the user may still want
    // to re-download the previous export. The download-again button is
    // inside resultSection, which gets hidden here, but we keep the
    // cached bytes so a future showResult re-shows them.
    if (!mounted) return;
    progressRow.hidden = true;
    resultSection.hidden = true;
    errorSection.hidden = true;
    if (progressFill) progressFill.style.transform = "scaleX(0)";
    if (progressLabel) progressLabel.textContent = "0%";
    setInputsDisabled(false);
    setExportButtonState("idle");
  }

  /**
   * Toolbar entry point — kick off an export with whatever's currently
   * in the inputs (or their stored defaults if the panel hasn't been
   * opened yet). Ensures the panel is mounted before reading values;
   * the host is responsible for calling rightRail.activate('export')
   * first so create() has run.
   */
  function autoExport() {
    if (!mounted) {
      console.warn(
        "[export-panel] autoExport called before create() — did the host " +
          "forget to activate the tab first?",
      );
      return;
    }
    startExport();
  }

  // ─── Internal: export flow ────────────────────────────────────────────

  function onExportClick() {
    if (mode === "running") return; // defensive — button should be disabled
    startExport();
  }

  function commitInputs() {
    const fn = (filenameInput?.value || "").trim();
    if (fn) writeStoredFilename(fn);
    const c = parseCycles(cyclesInput?.value);
    if (c != null) writeStoredCycles(c);
    const r = parseInt(rateSelect?.value, 10);
    if (SAMPLE_RATES.includes(r)) writeStoredRate(r);
  }

  function startExport() {
    if (mode === "running") return;
    commitInputs();

    const rawFilename = (filenameInput.value || "").trim();
    const filename = rawFilename || getPatternName() || "untitled";

    const cycles = parseCycles(cyclesInput.value);
    if (cycles == null) {
      showError(
        `Cycles must be a whole number between ${MIN_CYCLES} and ${MAX_CYCLES}.`,
      );
      return;
    }
    // Persist the validated value in case `change` didn't fire (user
    // clicked Export with focus still in the input).
    writeStoredCycles(cycles);

    const sampleRate = parseInt(rateSelect.value, 10);
    if (!SAMPLE_RATES.includes(sampleRate)) {
      showError("Sample rate must be 44100, 48000, or 96000.");
      return;
    }

    // Switch to running mode: hide old result/error, reset progress,
    // disable inputs, flip button label.
    mode = "running";
    errorSection.hidden = true;
    resultSection.hidden = true;
    progressRow.hidden = false;
    if (progressFill) progressFill.style.transform = "scaleX(0)";
    if (progressLabel) progressLabel.textContent = "0%";
    setInputsDisabled(true);
    setExportButtonState("running");

    // Hand off to the host. The host is expected to call showProgress
    // during the render and either showResult or showError when done.
    // If onExport throws synchronously or rejects, we still want to
    // land back in a clean state — wrap in a promise chain rather than
    // relying on the host's catch.
    const options = { cycles, sampleRate, filename };
    Promise.resolve()
      .then(() => onExport(options))
      .then((result) => {
        if (result) showResult(result);
        else reset();
      })
      .catch((err) => {
        console.error("[export-panel] onExport failed:", err);
        showError(err?.message || String(err));
      });
  }

  function setInputsDisabled(disabled) {
    if (filenameInput) filenameInput.disabled = disabled;
    if (cyclesInput) cyclesInput.disabled = disabled;
    if (rateSelect) rateSelect.disabled = disabled;
  }

  function setExportButtonState(state) {
    if (!exportBtn) return;
    const label = exportBtn.querySelector(".export-panel__export-label");
    exportBtn.classList.remove("is-running", "is-done", "is-error");
    switch (state) {
      case "running":
        exportBtn.disabled = true;
        exportBtn.classList.add("is-running");
        if (label) label.textContent = "Rendering…";
        break;
      case "done":
        exportBtn.disabled = false;
        exportBtn.classList.add("is-done");
        if (label) label.textContent = "Export";
        break;
      case "error":
        exportBtn.disabled = false;
        exportBtn.classList.add("is-error");
        if (label) label.textContent = "Export";
        break;
      case "idle":
      default:
        exportBtn.disabled = false;
        if (label) label.textContent = "Export";
        break;
    }
  }

  // ─── Internal: download-again ─────────────────────────────────────────

  function onDownloadAgain() {
    if (!lastResult) return;
    if (!lastWavBytes) {
      // The host always caches the WAV bytes in the result, but guard
      // in case a future caller forgets — a missing cache is a bug, not
      // a panic, so log loudly and bail instead of silently no-op-ing.
      console.warn(
        "[export-panel] download again: no cached bytes on lastResult",
      );
      return;
    }
    // Re-trigger a browser download without going through the render
    // path. Same Blob → <a> click shape as downloadWav() in main.js,
    // duplicated here so the panel stays standalone.
    try {
      const bytes = lastWavBytes;
      // Wrap the cached Uint8Array in a fresh Blob — some browsers
      // revoke the URL associated with the original blob after the
      // first click, and we want each "download again" to be a clean
      // download.
      const blob = new Blob([bytes], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = withWavSuffix(lastResult.filename);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[export-panel] download again failed:", err);
    }
  }

  // ─── Internal: waveform rendering ─────────────────────────────────────

  function renderWaveform(buffer) {
    if (!waveformCanvas || !buffer) return;
    const ctx = waveformCanvas.getContext("2d");
    if (!ctx) return;

    // Size the backing store to the canvas's CSS box at devicePixelRatio
    // so the lines stay crisp on HiDPI displays. The CSS height is a
    // fixed constant; the CSS width comes from the flex layout and may
    // change if the rail is resized.
    const dpr = window.devicePixelRatio || 1;
    const cssRect = waveformCanvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(cssRect.width));
    const cssHeight = WAVEFORM_HEIGHT_CSS;
    waveformCanvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    waveformCanvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    waveformCanvas.style.height = `${cssHeight}px`;

    const width = waveformCanvas.width;
    const height = waveformCanvas.height;
    const midY = height / 2;

    // Background — matches --surface-2 via canvas clear + token fill.
    // Pulling the computed CSS variable keeps the waveform in sync with
    // the user's accent theme without hardcoding any hex.
    const styles = getComputedStyle(root);
    const bg = styles.getPropertyValue("--surface-2").trim() || "#222";
    const accent = styles.getPropertyValue("--accent").trim() || "#cf418d";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    if (width < WAVEFORM_MIN_COLS) return;

    // Sum both channels to mono for display. Mono gives a single
    // envelope line that's easier to read at panel width; the stereo
    // decorrelation isn't visually meaningful at ~300px wide.
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const total = ch0.length;
    if (total === 0) return;

    // One column per device pixel — at high dpr this is a lot of
    // columns, but still cheap compared to the actual render we just
    // finished. The inner loop scans min/max across each column's
    // sample window, which is the standard DAW waveform grammar.
    const samplesPerCol = Math.max(1, Math.floor(total / width));

    // A 50%-opacity overlay gets us the "soft fill" look without having
    // to manage an extra color token. The core lines are drawn at full
    // accent for contrast.
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1, Math.floor(dpr));
    ctx.beginPath();

    for (let x = 0; x < width; x++) {
      const start = x * samplesPerCol;
      const end = Math.min(total, start + samplesPerCol);
      let min = 0;
      let max = 0;
      for (let i = start; i < end; i++) {
        const sample = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
        if (sample > max) max = sample;
        if (sample < min) min = sample;
      }
      const y1 = midY - max * (midY - 1);
      const y2 = midY - min * (midY - 1);
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ─── Keyboard handlers ────────────────────────────────────────────────

  function onInputKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      onFocusEditor();
      return;
    }
    if (e.key === "Enter") {
      // Enter in any input commits + starts the export, matching the
      // "press Enter to render" muscle memory the prompt() modal had.
      // The sample-rate <select> also forwards Enter here so the user
      // can tab-then-enter through the row without reaching for the
      // mouse.
      if (mode === "idle") {
        e.preventDefault();
        startExport();
      }
    }
  }

  // ─── Internal: helpers ────────────────────────────────────────────────

  function buildRow(labelText) {
    const row = el("label", "export-panel__row");
    const lbl = el("span", "export-panel__row-label", labelText);
    row.appendChild(lbl);
    const control = el("span", "export-panel__row-control");
    row.appendChild(control);
    return { row, control };
  }
}

// ─── Pure helpers (no closure state) ──────────────────────────────────────

function readStoredCycles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CYCLES);
    if (raw == null) return DEFAULT_CYCLES;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_CYCLES;
    if (n < MIN_CYCLES || n > MAX_CYCLES) return DEFAULT_CYCLES;
    return n;
  } catch {
    return DEFAULT_CYCLES;
  }
}

function writeStoredCycles(n) {
  try {
    localStorage.setItem(STORAGE_KEY_CYCLES, String(n));
  } catch {
    /* ignore — quota or private mode */
  }
}

function readStoredRate() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RATE);
    if (raw == null) return DEFAULT_SAMPLE_RATE;
    const n = parseInt(raw, 10);
    if (SAMPLE_RATES.includes(n)) return n;
    return DEFAULT_SAMPLE_RATE;
  } catch {
    return DEFAULT_SAMPLE_RATE;
  }
}

function writeStoredRate(n) {
  try {
    localStorage.setItem(STORAGE_KEY_RATE, String(n));
  } catch {
    /* ignore */
  }
}

function readStoredFilename() {
  try {
    return localStorage.getItem(STORAGE_KEY_FILENAME) || null;
  } catch {
    return null;
  }
}

function writeStoredFilename(s) {
  try {
    localStorage.setItem(STORAGE_KEY_FILENAME, s);
  } catch {
    /* ignore */
  }
}

function parseCycles(raw) {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_CYCLES || n > MAX_CYCLES) return null;
  return n;
}

function withWavSuffix(name) {
  if (!name) return "untitled.wav";
  return name.toLowerCase().endsWith(".wav") ? name : `${name}.wav`;
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0.0s";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}m ${s.toFixed(1)}s`;
}

function fmtRateKhz(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  const khz = rate / 1000;
  // 48 kHz, 44.1 kHz, 96 kHz — preserve the .1 for 44100 without
  // showing .0 on the round rates.
  return Number.isInteger(khz) ? `${khz}kHz` : `${khz.toFixed(1)}kHz`;
}

function fmtFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDb(peak) {
  if (!Number.isFinite(peak) || peak <= 0) return "-∞";
  const db = 20 * Math.log10(peak);
  // One decimal place — matches the "Peak: -2.1 dB" example in the
  // spec. Negative values are the common case (peaks below 0 dBFS).
  return db.toFixed(1);
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
