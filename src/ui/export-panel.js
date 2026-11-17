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
// keeps the render path (see docs/architecture.md, "WAV export") out
// of panel code where a casual edit
// could reintroduce the eager-controller silent-output bug.
//
// Public surface (factory pattern — same shape as the other panels):
//
//   const panel = createExportPanel({
//     onFocusEditor,   // () => void        — Escape returns focus
//     onExport,        // (options: ExportOptions) => Promise<ExportResult>
//     getPatternName,  // () => string      — seeds the filename input
//     getCps,          // () => number      — tempo, for the length readout
//   });
//   rightRail.registerPanel(panel);
//
//   panel.showProgress(0.73);     // called from the host's poll loop
//   panel.showResult(result);     // called when onExport() resolves
//   panel.showError('…');         // called when onExport() rejects
//   panel.reset();                // back to idle
//   panel.autoExport();           // toolbar button entry point
//
// ExportOptions: { cycles, sampleRate, filename, normalize }
// ExportResult:  { buffer, scheduled, cycles, sampleRate, filename,
//                  fileSize, duration, peakAmplitude, sourcePeak,
//                  normalizeGain, percentNonZero }
//
// Pure DOM, no framework. Match the imperative style of
// src/ui/sound-browser.js, src/ui/reference-panel.js, and
// src/ui/console-panel.js.

import { makeIcon } from "./icons.js";

const STORAGE_KEY_CYCLES = "strasbeat:export-cycles";
const STORAGE_KEY_RATE = "strasbeat:export-rate";
const STORAGE_KEY_FILENAME = "strasbeat:export-filename";
const STORAGE_KEY_NORMALIZE = "strasbeat:export-normalize";

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
// Resolution the render is reduced to for display. Wider than the rail can
// get at 2× dpr, and ~16 KB instead of the whole AudioBuffer.
const WAVEFORM_PEAK_COLS = 2048;
// Near-silent heuristic — peak below -60 dB is effectively silence even
// if the buffer has a handful of non-zero samples. Matches the threshold
// a WAV-export sanity check would care about: if the user won't be able
// to hear it, warn.
const NEAR_SILENT_PEAK = 0.001;
// Share of the half-height that full scale (0 dB) occupies; the rest is
// room to show what a clipped render pushed past it.
const WAVEFORM_FULL_SCALE = 0.8;

export function createExportPanel({
  onFocusEditor = () => {},
  onExport = async () => {
    throw new Error("export-panel: onExport not wired");
  },
  getPatternName = () => "untitled",
  getCps = () => null,
}) {
  // ─── State ────────────────────────────────────────────────────────────
  // 'idle' — show inputs + Export button; progress/result/error hidden
  // 'running' — progress bar visible, inputs + button disabled (a render
  //             can't be cancelled once started)
  // 'done' — waveform + stats + download-again shown below progress
  // 'error' — error message + try-again shown below progress
  let mode = "idle";
  // Last successful render, reduced to what the UI still needs: the WAV
  // as a Blob (for "Download again") and a few hundred min/max pairs (to
  // redraw the waveform at any width). The AudioBuffer itself — hundreds
  // of MB for a long 96 kHz render — is not kept.
  /** @type {{ filename: string, blob: Blob | null } | null} */
  let lastResult = null;
  /** @type {Float32Array | null} interleaved [min, max] per peak column */
  let lastPeaks = null;
  // Pattern the filename field was last auto-filled for, and whether the
  // user has typed their own name since. Their name is kept until the
  // pattern changes; otherwise the field follows the current pattern.
  let filenamePattern = null;
  let filenameEdited = false;

  // DOM refs (re-bound on create()).
  let root = null;
  let filenameInput = null;
  let cyclesInput = null;
  let rateSelect = null;
  let lengthEl = null;
  let normalizeBtn = null;
  let exportBtn = null;
  let progressRow = null;
  let progressFill = null;
  let progressLabel = null;
  let resultSection = null;
  let waveformCanvas = null;
  let statsName = null;
  let statsDuration = null;
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
    // Four rows: filename, cycles, sample rate, normalize. Every row shares the
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
    syncFilename();
    filenameInput.addEventListener("input", () => {
      filenameEdited = filenameInput.value.trim() !== "";
    });
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
    cyclesInput.addEventListener("input", syncLength);
    cyclesInput.addEventListener("change", () => {
      // Persist whatever the user committed (blur/enter), not every
      // keystroke — otherwise half-typed values get saved.
      const parsed = parseCycles(cyclesInput.value);
      if (parsed != null) writeStoredCycles(parsed);
    });
    // How long that many cycles last at the tempo of the last evaluate.
    lengthEl = el("span", "export-panel__length");
    lengthEl.title = "Length at the current tempo";
    const cyclesField = el("div", "export-panel__field");
    cyclesField.appendChild(cyclesInput);
    cyclesField.appendChild(lengthEl);
    cyclesRow.control.appendChild(cyclesField);
    controls.appendChild(cyclesRow.row);
    syncLength();

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

    // Normalize — scales the render so its loudest sample sits at -1 dB.
    // On by default: a mix that runs past 0 dB is otherwise hard-clipped
    // in the 16-bit file. A <div> row, not a <label>: a label would turn a
    // click on the switch into two toggles.
    const normalizeRow = el("div", "export-panel__row");
    const normalizeLabelId = "export-normalize-label";
    const normalizeLabel = el("span", "export-panel__row-label", "Normalize");
    normalizeLabel.id = normalizeLabelId;
    normalizeRow.appendChild(normalizeLabel);
    const normalizeControl = el("span", "export-panel__row-control export-panel__switch-wrap");
    normalizeBtn = el("button", "export-panel__switch");
    normalizeBtn.type = "button";
    normalizeBtn.setAttribute("role", "switch");
    normalizeBtn.setAttribute("aria-labelledby", normalizeLabelId);
    normalizeBtn.appendChild(el("span", "export-panel__switch-knob"));
    setNormalize(readStoredNormalize());
    normalizeBtn.addEventListener("click", () => {
      const on = normalizeBtn.getAttribute("aria-checked") !== "true";
      setNormalize(on);
      writeStoredNormalize(on);
    });
    normalizeBtn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onFocusEditor();
      }
    });
    normalizeControl.appendChild(normalizeBtn);
    normalizeControl.appendChild(
      el("span", "export-panel__switch-hint", "peak at −1 dB"),
    );
    normalizeRow.appendChild(normalizeControl);
    controls.appendChild(normalizeRow);

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

    // ─── Progress row (hidden until a render starts) ──────────────────
    progressRow = el("div", "export-panel__progress");
    progressRow.hidden = true;
    progressRow.setAttribute("role", "progressbar");
    progressRow.setAttribute("aria-label", "Render progress");
    progressRow.setAttribute("aria-valuemin", "0");
    progressRow.setAttribute("aria-valuemax", "100");
    progressRow.setAttribute("aria-valuenow", "0");
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
    resultSection.setAttribute("role", "status");

    // Result head: file name and length, with Download again beside them.
    const resultHead = el("div", "export-panel__result-head");
    const resultTitle = el("div", "export-panel__result-title");
    statsName = el("div", "export-panel__stats export-panel__stats--name");
    statsDuration = el("div", "export-panel__stats");
    resultTitle.appendChild(statsName);
    resultTitle.appendChild(statsDuration);
    resultHead.appendChild(resultTitle);
    // Re-downloads the cached WAV bytes so the user doesn't have to
    // re-render just to save it to a different folder.
    downloadAgainBtn = el("button", "export-panel__download-again");
    downloadAgainBtn.type = "button";
    downloadAgainBtn.title = "Download the file again";
    downloadAgainBtn.appendChild(makeIcon("download"));
    downloadAgainBtn.appendChild(el("span", null, "Download"));
    downloadAgainBtn.addEventListener("click", onDownloadAgain);
    resultHead.appendChild(downloadAgainBtn);
    resultSection.appendChild(resultHead);

    // Waveform canvas. Size is set in CSS; the backing store is scaled
    // to dpr when we draw into it so HiDPI screens stay crisp.
    const waveformWrap = el("div", "export-panel__waveform");
    waveformCanvas = document.createElement("canvas");
    waveformCanvas.className = "export-panel__waveform-canvas";
    waveformCanvas.setAttribute("role", "img");
    waveformCanvas.setAttribute("aria-label", "Exported waveform");
    waveformWrap.appendChild(waveformCanvas);
    resultSection.appendChild(waveformWrap);
    // Redraw whenever the canvas gets a (new) width: the rail was resized,
    // or the result arrived while this tab was hidden and is now shown.
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => drawWaveform()).observe(waveformWrap);
    }

    // Stats: one line of file facts, one peak readout ("silent!" when the
    // buffer is completely zero).
    statsLine2 = el("div", "export-panel__stats");
    statsPeak = el("div", "export-panel__stats export-panel__stats--peak");
    resultSection.appendChild(statsLine2);
    resultSection.appendChild(statsPeak);

    // Result warning — hidden by default; showResult fills it in for a
    // silent or a clipped render.
    warningEl = el("div", "export-panel__warning");
    warningEl.hidden = true;
    resultSection.appendChild(warningEl);

    root.appendChild(resultSection);

    // ─── Error section (hidden until showError is called) ─────────────
    errorSection = el("div", "export-panel__error");
    errorSection.hidden = true;
    errorSection.setAttribute("role", "alert");
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

  function activate({ focus = true } = {}) {
    if (!mounted) return;
    if (mode !== "running") syncFilename();
    syncLength();
    // A result that arrived while the tab was hidden had no width to draw
    // into; the rail may also have been resized since.
    if (mode === "done") drawWaveform();
    if (focus && filenameInput) {
      filenameInput.focus();
      filenameInput.select();
    }
  }

  // Keep the filename on the current pattern's name — so switching patterns
  // always exports under the right name, including from the toolbar button —
  // unless the user typed a name of their own for this pattern.
  function syncFilename() {
    if (!filenameInput) return;
    const pattern = getPatternName() || "";
    if (filenameEdited && pattern === filenamePattern) return;
    filenamePattern = pattern;
    filenameEdited = false;
    filenameInput.value = pattern || readStoredFilename() || "untitled";
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
    progressRow?.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
  }

  function showResult(result) {
    if (!mounted || !result) return;
    mode = "done";
    lastResult = {
      filename: result.filename,
      blob: result.wavBytes
        ? new Blob([result.wavBytes], { type: "audio/wav" })
        : null,
    };
    lastPeaks = computePeaks(result.buffer);

    // Pin the progress bar at 100% so the transition from "rendering" to
    // "done" reads naturally — a jump back to 0% would look broken.
    if (progressFill) progressFill.style.transform = "scaleX(1)";
    if (progressLabel) progressLabel.textContent = "100%";
    progressRow.setAttribute("aria-valuenow", "100");

    const displayName = withWavSuffix(result.filename);
    const duration = Number(result.duration) || 0;
    const scheduled = Number(result.scheduled) || 0;
    const rate = Number(result.sampleRate) || 0;
    const size = Number(result.fileSize) || 0;
    const peak = Number(result.peakAmplitude) || 0;
    const pctNonZero = Number(result.percentNonZero) || 0;

    statsName.textContent = displayName;
    statsDuration.textContent = fmtDuration(duration);
    statsLine2.textContent =
      `${scheduled} event${scheduled === 1 ? "" : "s"} · ` +
      `${fmtRateKhz(rate)} · ${fmtFileSize(size)}`;

    // Peak — the spec asks for "-∞ dB (silent!)" in --rec when the
    // buffer is all zeros. Any non-zero sample at least earns a proper
    // dB number, but the near-silent warning below still fires if it's
    // below -60 dB.
    // A peak above full scale can't be stored in a 16-bit WAV: everything
    // over 0 dB is flattened. Flag it the same way as silence.
    const isClipped = peak > 1;
    const gain = Number(result.normalizeGain) || 1;
    const sourcePeak = Number(result.sourcePeak) || peak;
    statsPeak.classList.remove("export-panel__stats--silent");
    if (peak <= 0) {
      statsPeak.textContent = "Peak -∞ dB (silent!)";
      statsPeak.classList.add("export-panel__stats--silent");
    } else if (isClipped) {
      statsPeak.textContent = `Peak ${fmtDb(peak)} dB · clipped`;
      statsPeak.classList.add("export-panel__stats--silent");
    } else if (gain !== 1) {
      statsPeak.textContent = `Peak ${fmtDb(peak)} dB · normalized from ${fmtDb(sourcePeak)} dB`;
    } else {
      statsPeak.textContent = `Peak ${fmtDb(peak)} dB`;
    }

    // Silent-export warning — spec says fire if peak is 0 OR non-zero %
    // is below 0.1. Add the near-silent guard so "audible but basically
    // nothing" also trips the warning, since the user probably meant
    // something louder.
    const isSilentish =
      peak <= 0 || pctNonZero < 0.1 || peak < NEAR_SILENT_PEAK;
    if (isSilentish) {
      warningEl.textContent = "This export appears silent — check your pattern.";
    } else if (isClipped) {
      warningEl.textContent =
        "Clipped above 0 dB. Turn on Normalize, or lower .gain().";
    }
    warningEl.hidden = !(isSilentish || isClipped);

    // Make sure the UI structure reflects 'done' mode. The result section
    // has to be laid out before the waveform is drawn — a hidden canvas
    // has no width to size its backing store from.
    progressRow.hidden = false;
    resultSection.hidden = false;
    errorSection.hidden = true;
    drawWaveform();
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
    // The download-again button lives in resultSection, which is hidden
    // from here until the next successful render replaces the result — so
    // nothing can reach the cached WAV any more. Let it go.
    lastResult = null;
    lastPeaks = null;
    if (!mounted) return;
    progressRow.hidden = true;
    resultSection.hidden = true;
    errorSection.hidden = true;
    if (progressFill) progressFill.style.transform = "scaleX(0)";
    if (progressLabel) progressLabel.textContent = "0%";
    progressRow.setAttribute("aria-valuenow", "0");
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
    // The toolbar button lands here without the panel being re-activated,
    // possibly after a pattern switch.
    syncFilename();
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
    progressRow.setAttribute("aria-valuenow", "0");
    // The previous render's WAV and waveform are obsolete from here on.
    lastResult = null;
    lastPeaks = null;
    setInputsDisabled(true);
    setExportButtonState("running");

    // Hand off to the host. The host is expected to call showProgress
    // during the render and either showResult or showError when done.
    // If onExport throws synchronously or rejects, we still want to
    // land back in a clean state — wrap in a promise chain rather than
    // relying on the host's catch.
    const normalize = normalizeBtn?.getAttribute("aria-checked") === "true";
    const options = { cycles, sampleRate, filename, normalize };
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
    if (normalizeBtn) normalizeBtn.disabled = disabled;
  }

  function setNormalize(on) {
    normalizeBtn.setAttribute("aria-checked", on ? "true" : "false");
    normalizeBtn.classList.toggle("is-on", on);
  }

  // "≈ 8.0s" beside the cycles input: what that many cycles last at the
  // tempo of the last evaluate. Blank when either is unknown.
  function syncLength() {
    if (!lengthEl) return;
    const cycles = parseCycles(cyclesInput?.value);
    const cps = Number(getCps());
    lengthEl.textContent =
      cycles != null && Number.isFinite(cps) && cps > 0
        ? `≈ ${fmtDuration(cycles / cps)}`
        : "";
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
    if (!lastResult.blob) {
      // The host always includes the WAV bytes in the result, but guard
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
      const url = URL.createObjectURL(lastResult.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = withWavSuffix(lastResult.filename);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Not synchronously: some browsers abort a download whose URL is
      // revoked before they've started reading it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.warn("[export-panel] download again failed:", err);
    }
  }

  // ─── Internal: waveform rendering ─────────────────────────────────────

  // Draw the cached peaks at the canvas's current width. Safe to call any
  // time; a no-op while the canvas has no layout (tab hidden) — activate()
  // calls it again once the panel is on screen.
  function drawWaveform() {
    if (!waveformCanvas || !lastPeaks) return;
    const ctx = waveformCanvas.getContext("2d");
    if (!ctx) return;

    // Size the backing store to the canvas's CSS box at devicePixelRatio
    // so the lines stay crisp on HiDPI displays. The CSS height is a
    // fixed constant; the CSS width comes from the flex layout and may
    // change if the rail is resized.
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.floor(waveformCanvas.getBoundingClientRect().width);
    if (cssWidth < WAVEFORM_MIN_COLS) return;
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
    const rec = styles.getPropertyValue("--rec").trim() || "#e5484d";
    const guide = styles.getPropertyValue("--border").trim() || "#444";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Full scale (0 dB) sits a little inside the edges, marked by dashed
    // lines, so a normalized file reads as "just under the line" and
    // anything past it (clipped in the file) shows outside, in --rec.
    const scale = (midY - 1) * WAVEFORM_FULL_SCALE;
    const over = (midY - 1) / scale;
    ctx.save();
    ctx.strokeStyle = guide;
    ctx.lineWidth = Math.max(1, Math.floor(dpr));
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    for (const y of [Math.round(midY - scale) + 0.5, Math.round(midY + scale) - 0.5]) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    ctx.restore();

    const cols = lastPeaks.length / 2;
    if (cols === 0) return;

    // A 50%-opacity overlay gets us the "soft fill" look without having
    // to manage an extra color token. The core lines are drawn at full
    // accent for contrast.
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1, Math.floor(dpr));
    ctx.beginPath();
    const clippedCols = [];

    // One line per device pixel, each spanning the min/max of the peak
    // columns it covers — the standard DAW waveform grammar. Samples past
    // full scale are pinned to the edge rather than drawn off-canvas.
    for (let x = 0; x < width; x++) {
      const from = Math.floor((x * cols) / width);
      const to = Math.max(from + 1, Math.floor(((x + 1) * cols) / width));
      let min = 0;
      let max = 0;
      for (let c = from; c < to && c < cols; c++) {
        if (lastPeaks[c * 2] < min) min = lastPeaks[c * 2];
        if (lastPeaks[c * 2 + 1] > max) max = lastPeaks[c * 2 + 1];
      }
      const y1 = midY - Math.min(over, max) * scale;
      const y2 = midY - Math.max(-over, min) * scale;
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
      if (max > 1 || min < -1) clippedCols.push(x, y1, y2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // The parts past full scale, in --rec.
    if (clippedCols.length) {
      ctx.strokeStyle = rec;
      ctx.beginPath();
      for (let i = 0; i < clippedCols.length; i += 3) {
        const x = clippedCols[i] + 0.5;
        const y1 = clippedCols[i + 1];
        const y2 = clippedCols[i + 2];
        if (y1 < midY - scale) {
          ctx.moveTo(x, y1);
          ctx.lineTo(x, midY - scale);
        }
        if (y2 > midY + scale) {
          ctx.moveTo(x, midY + scale);
          ctx.lineTo(x, y2);
        }
      }
      ctx.stroke();
    }
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
      if (mode !== "running") {
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

function readStoredNormalize() {
  try {
    return localStorage.getItem(STORAGE_KEY_NORMALIZE) !== "off";
  } catch {
    return true;
  }
}

function writeStoredNormalize(on) {
  try {
    localStorage.setItem(STORAGE_KEY_NORMALIZE, on ? "on" : "off");
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

export function parseCycles(raw) {
  // Whole numbers only — parseInt alone would read "4.7" as 4 and "1e2" as 1.
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const n = parseInt(text, 10);
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

export function fmtDb(peak) {
  if (!Number.isFinite(peak) || peak <= 0) return "-∞";
  const db = 20 * Math.log10(peak);
  // One decimal place — matches the "Peak: -2.1 dB" example in the
  // spec. Negative values are the common case (peaks below 0 dBFS); a
  // level above full scale gets an explicit plus sign so it can't be
  // misread as headroom.
  const text = db.toFixed(1);
  return db > 0 && text !== "0.0" ? `+${text}` : text.replace(/^-0\.0$/, "0.0");
}

/**
 * Reduce an AudioBuffer to WAVEFORM_PEAK_COLS [min, max] pairs of its mono
 * sum — enough to draw the waveform at any panel width without holding on
 * to the samples.
 * @returns {Float32Array | null}
 */
export function computePeaks(buffer, cols = WAVEFORM_PEAK_COLS) {
  if (!buffer || !buffer.length) return null;
  // Sum both channels to mono for display. Mono gives a single envelope
  // line that's easier to read at panel width; the stereo decorrelation
  // isn't visually meaningful at ~300px wide.
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const total = ch0.length;
  const n = Math.min(cols, total);
  const peaks = new Float32Array(n * 2);
  for (let c = 0; c < n; c++) {
    const start = Math.floor((c * total) / n);
    const end = Math.floor(((c + 1) * total) / n);
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      const sample = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      if (sample > max) max = sample;
      if (sample < min) min = sample;
    }
    peaks[c * 2] = min;
    peaks[c * 2 + 1] = max;
  }
  return peaks;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
