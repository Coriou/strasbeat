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

    function onKeydown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    }
    document.addEventListener("keydown", onKeydown, true);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });

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
}) {
  if (!midi.isCaptureEnabled()) {
    midi.setCaptureEnabled(true);
    midiBar.setCaptureState({ recording: true, count: 0 });
    transport.setStatus(
      "capturing MIDI · play something · click again to save",
    );
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

  // Show capture preview modal
  const prevCode = editor.code;
  const result = await showCapturePreviewModal({
    initialCode: code,
    onGridChange: (grid) => {
      selectedGrid = grid || undefined;
      code = midi.buildPatternFromCapture({
        bpmHint,
        gridSubdivision: selectedGrid,
      });
      return code;
    },
    onPlay: (previewCode) => {
      editor.setCode(previewCode);
      editor.evaluate();
    },
  });

  if (!result) {
    // Discard — restore previous editor code
    editor.setCode(prevCode);
    transport.setStatus("capture discarded");
    return;
  }

  // Save flow with the (possibly re-quantized) code
  code = result.code;

  if (import.meta.env.PROD) {
    // No filesystem in prod — save as a user pattern in the store.
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T.]/g, "")
      .slice(0, 14);
    const captureName = `captured-${stamp}`;
    try {
      store.set(captureName, {
        code,
        modified: new Date().toISOString(),
        isUserPattern: true,
      });
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
          "\u26a0 couldn\u2019t save \u2014 browser storage full",
        );
      }
      return;
    }
    leftRail.addUserPattern(captureName);
    editor.setCode(code);
    setCurrentName(captureName);
    transport.setStatus(`captured phrase → "${captureName}"`);
    return;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);
  const suggestion = `captured-${stamp}`;
  const name = await prompt({
    title: "Save captured phrase",
    placeholder: "filename without .js",
    defaultValue: suggestion,
    confirmLabel: "Save",
    validate: (v) =>
      /^[a-z0-9_-]+$/i.test(v) ? null : "use only letters, numbers, - and _",
  });
  if (!name) {
    editor.setCode(prevCode);
    transport.setStatus("capture discarded");
    return;
  }
  const res = await fetch("/api/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, code }),
  });
  if (!res.ok) {
    transport.setStatus(`save failed: ${await res.text()}`);
    return;
  }
  const { path } = await res.json();
  store.delete(name); // disk is canonical, clear working copy
  transport.setStatus(`captured phrase → ${path} (HMR will reload)`);
}
