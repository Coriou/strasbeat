import { track } from "./analytics.js";

// ─── Capture preview modal ───────────────────────────────────────────────
// Shows generated pattern code with Play/Save/Discard buttons and a
// quantization grid selector. Returns { code } on save, null on discard.
function showCapturePreviewModal({ initialCode, onGridChange, onPlay }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Capture preview");

    const dialog = document.createElement("div");
    dialog.className = "modal capture-preview";
    overlay.appendChild(dialog);

    const titleEl = document.createElement("div");
    titleEl.className = "modal__title";
    titleEl.textContent = "Capture preview";
    dialog.appendChild(titleEl);

    // Grid selector
    const gridSection = document.createElement("div");
    gridSection.className = "capture-preview__grid";
    const gridLabel = document.createElement("span");
    gridLabel.className = "capture-preview__grid-label";
    gridLabel.textContent = "Quantize:";
    gridSection.appendChild(gridLabel);

    const GRID_OPTIONS = [
      { value: "", label: "Auto" },
      { value: "4", label: "1/4" },
      { value: "8", label: "1/8" },
      { value: "16", label: "1/16" },
    ];
    let currentCode = initialCode;

    for (const opt of GRID_OPTIONS) {
      const radioLabel = document.createElement("label");
      radioLabel.className = "capture-preview__grid-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "capture-grid";
      radio.value = opt.value;
      radio.checked = opt.value === "";
      radio.addEventListener("change", () => {
        const grid = radio.value ? Number(radio.value) : undefined;
        const newCode = onGridChange(grid);
        if (newCode) {
          currentCode = newCode;
          codeEl.textContent = currentCode;
        }
      });
      radioLabel.appendChild(radio);
      radioLabel.appendChild(document.createTextNode(" " + opt.label));
      gridSection.appendChild(radioLabel);
    }
    dialog.appendChild(gridSection);

    // Code preview
    const codeWrap = document.createElement("div");
    codeWrap.className = "capture-preview__code-wrap";
    const codeEl = document.createElement("pre");
    codeEl.className = "capture-preview__code";
    codeEl.textContent = currentCode;
    codeWrap.appendChild(codeEl);
    dialog.appendChild(codeWrap);

    // Actions
    const actions = document.createElement("div");
    actions.className = "modal__actions";
    dialog.appendChild(actions);

    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "btn btn--ghost modal__cancel";
    discardBtn.textContent = "Discard";
    actions.appendChild(discardBtn);

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "btn btn--ghost";
    playBtn.textContent = "Play";
    actions.appendChild(playBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn modal__confirm";
    saveBtn.textContent = "Save";
    actions.appendChild(saveBtn);

    function close(value) {
      overlay.classList.remove("modal-overlay--open");
      overlay.classList.add("modal-overlay--exiting");
      document.removeEventListener("keydown", onKeydown, true);
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 80);
      resolve(value);
    }

    discardBtn.addEventListener("click", () => close(null));
    playBtn.addEventListener("click", () => onPlay(currentCode));
    saveBtn.addEventListener("click", () => close({ code: currentCode }));

    // A take can't be re-recorded, so the reflexive ways of dismissing a
    // dialog must not throw it away: a stray backdrop click does nothing, and
    // Escape first moves focus to Discard and asks for a second press.
    let discardArmed = false;
    function onKeydown(e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (discardArmed) {
        close(null);
        return;
      }
      discardArmed = true;
      discardBtn.textContent = "Discard take? (Esc)";
      discardBtn.focus();
    }
    document.addEventListener("keydown", onKeydown, true);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("modal-overlay--open"));
    saveBtn.focus();
  });
}

export async function handleCaptureClick({
  midi,
  midiBar,
  transport,
  editor,
  store,
  leftRail,
  prompt,
  setCurrentName,
  openPattern,
  // Injectable for tests; the defaults are the real thing.
  showPreview = showCapturePreviewModal,
  isProd = import.meta.env?.PROD ?? false,
  fetchImpl = (...args) => fetch(...args),
}) {
  if (!midi.isCaptureEnabled()) {
    midi.setCaptureEnabled(true);
    midiBar.setCaptureState({ recording: true, count: 0 });
    transport.setStatus(
      "capturing MIDI · play something · click again to save",
    );
    track("midi_capture_started");
    return;
  }
  // stop capture
  midi.setCaptureEnabled(false);
  midiBar.setCaptureState({ recording: false });

  if (midi.getCaptureCount() === 0) {
    transport.setStatus("capture stopped — no notes recorded");
    return;
  }

  // Build initial pattern code. Use metronome BPM as hint if it was enabled.
  const bpmHint = midi.isMetronomeEnabled()
    ? midi.getMetronomeBpm()
    : undefined;
  let selectedGrid = undefined;
  let code = midi.buildPatternFromCapture({
    bpmHint,
    gridSubdivision: selectedGrid,
  });
  if (!code) {
    transport.setStatus("capture stopped — no notes recorded");
    return;
  }

  // Auditioning the take goes straight to the repl and NEVER through the
  // editor buffer. The buffer is the open pattern's document: anything put
  // there is picked up by autosave within a second and stored as that
  // pattern, and every exit from the dialog would have to undo it perfectly.
  // Evaluating the code directly leaves the user's pattern untouched no matter
  // how the dialog is left.
  let previewed = false;
  const playPreview = async (previewCode) => {
    previewed = true;
    try {
      await editor.repl.evaluate(previewCode);
      // The dialog was left while this was still evaluating: endPreview ran
      // before the take started, so stop it now.
      if (!previewed) {
        previewed = true;
        endPreview();
      }
    } catch (err) {
      console.warn("[strasbeat/capture] preview failed:", err);
      transport.setStatus(`preview failed: ${err?.message ?? err}`);
    }
  };
  const endPreview = () => {
    if (!previewed) return;
    previewed = false;
    try {
      // The scheduler is playing the take, not the pattern on screen. Stop it
      // and point the repl back at the buffer.
      editor.stop();
      editor.repl.setCode?.(editor.code);
    } catch (err) {
      console.warn("[strasbeat/capture] couldn't stop the preview:", err);
    }
  };

  let result;
  try {
    result = await showPreview({
      initialCode: code,
      onGridChange: (grid) => {
        selectedGrid = grid || undefined;
        code = midi.buildPatternFromCapture({
          bpmHint,
          gridSubdivision: selectedGrid,
        });
        return code;
      },
      onPlay: playPreview,
    });
  } finally {
    endPreview();
  }

  if (!result) {
    transport.setStatus("capture discarded");
    return;
  }

  // Save flow with the (possibly re-quantized) code
  code = result.code;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);

  if (isProd) {
    // No filesystem in prod — save as a user pattern in the store.
    let captureName = `captured-${stamp}`;
    // Two takes saved within the same second must not share a record.
    for (let n = 2; store.get(captureName) != null; n++) {
      captureName = `captured-${stamp}-${n}`;
    }
    try {
      const ok = store.set(captureName, {
        code,
        modified: new Date().toISOString(),
        isUserPattern: true,
      });
      if (ok === false) throw new Error("browser storage refused the write");
      const idx = store.getIndex();
      idx.userPatterns = [
        ...idx.userPatterns.filter((n) => n !== captureName),
        captureName,
      ];
      idx.lastOpen = captureName;
      store.setIndex(idx);
    } catch (err) {
      if (err?.name === "QuotaExceededError") {
        transport.setStatus(
          "⚠ couldn’t save — browser storage full",
        );
      } else {
        console.warn("[strasbeat/capture] save failed:", err);
        transport.setStatus(
          `⚠ couldn’t save the capture: ${err?.message ?? err}`,
        );
      }
      return;
    }
    leftRail.addUserPattern(captureName);
    if (openPattern) openPattern(captureName);
    else {
      setCurrentName(captureName);
      editor.setCode(code);
    }
    transport.setStatus(`captured phrase → "${captureName}"`);
    return;
  }

  // Dev: write patterns/<name>.js. The prompt comes back after any failure so
  // the take is only ever dropped by an explicit cancel.
  let suggestion = `captured-${stamp}`;
  for (;;) {
    const name = await prompt({
      title: "Save captured phrase",
      placeholder: "filename without .js",
      defaultValue: suggestion,
      confirmLabel: "Save",
      validate: (v) => {
        if (!/^[a-z0-9_-]+$/i.test(v)) return "use only letters, numbers, - and _";
        // Saving to disk drops the stored record of the same name (disk
        // becomes canonical) — never do that to a pattern the user already has.
        if (store.get(v) != null) return `"${v}" already exists in your library`;
        return null;
      },
    });
    if (!name) {
      transport.setStatus("capture discarded");
      return;
    }
    suggestion = name;
    let res;
    try {
      res = await fetchImpl("/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, code }),
      });
    } catch (err) {
      console.warn("[strasbeat/capture] save request failed:", err);
      transport.setStatus(
        `save failed: ${err?.message ?? err} — is the dev server running?`,
      );
      continue;
    }
    if (res.status === 409) {
      transport.setStatus(
        `patterns/${name}.js already exists — pick another name`,
      );
      continue;
    }
    if (!res.ok) {
      transport.setStatus(`save failed: ${await res.text()}`);
      continue;
    }
    const { path } = await res.json();
    store.delete(name); // disk is canonical, clear working copy
    transport.setStatus(`captured phrase → ${path} (HMR will reload)`);
    return;
  }
}
