// MIDI import dialog — two-state modal for importing .mid/.midi files.
//
// State 1: file drop/browse (if no file provided).
// State 2: track selection + options + import.
//
// Uses the existing modal overlay pattern from modal.js (focus-trap, enter/exit
// animation, single-modal-at-a-time). Reuses validation from patterns.js.

import { makeIcon } from "./icons.js";
import {
  parseMidiFile,
  analyzeTranslationInput,
  midiFileToPattern,
} from "../midi-to-strudel.js";
import {
  validatePatternName,
  patternNameExists,
  saveNewPattern,
} from "../patterns.js";

// ─── Constants ───────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const VALID_EXTENSIONS = [".mid", ".midi"];

// ─── Active dialog state ─────────────────────────────────────────────────
let active = null;

function closeActive(value) {
  if (!active) return;
  const { resolve, root, prevFocus, cleanup } = active;
  active = null;
  cleanup();
  root.classList.remove("modal-overlay--open");
  root.classList.add("modal-overlay--exiting");
  setTimeout(() => {
    if (root.parentNode) root.parentNode.removeChild(root);
    if (prevFocus && typeof prevFocus.focus === "function") {
      try {
        prevFocus.focus();
      } catch {
        /* gone */
      }
    }
  }, 80);
  resolve(value);
}

function installListeners(root, onDismiss) {
  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onDismiss();
      return;
    }
    if (e.key === "Tab") {
      const focusables = Array.from(
        root.querySelectorAll(
          'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  function onClick(e) {
    if (e.target === root) onDismiss();
  }
  document.addEventListener("keydown", onKey, true);
  root.addEventListener("mousedown", onClick);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    root.removeEventListener("mousedown", onClick);
  };
}

// ─── Public entry point ──────────────────────────────────────────────────

/**
 * Open the MIDI import dialog.
 *
 * @param {{
 *   store: object,
 *   patterns: object,
 *   leftRail: object,
 *   editor: object,
 *   transport: object,
 *   setCurrentName: (name: string) => void,
 *   flushToStore: () => void,
 *   isDev: boolean,
 *   file?: File,                  // skip State 1 if a file is provided
 * }} ctx
 * @returns {Promise<string|null>} - pattern name on success, null on cancel
 */
export function showMidiImportDialog(ctx) {
  if (active) closeActive(null);

  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const root = el("div", "modal-overlay midi-import-overlay");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Import MIDI");

    const dialog = el("div", "modal midi-import");
    root.appendChild(dialog);
    document.body.appendChild(root);

    requestAnimationFrame(() => root.classList.add("modal-overlay--open"));
    const cleanup = installListeners(root, () => closeActive(null));
    active = { resolve, root, prevFocus, cleanup };

    if (ctx.file) {
      handleFile(ctx.file, dialog, ctx);
    } else {
      renderFileSelect(dialog, ctx);
    }
  });
}

// ─── State 1: file selection ─────────────────────────────────────────────

function renderFileSelect(dialog, ctx) {
  dialog.replaceChildren();

  const title = el("div", "modal__title", "Import MIDI");
  dialog.appendChild(title);

  const dropZone = el("div", "midi-import__drop-zone");
  const dropIcon = makeIcon("file-music", { size: 32 });
  dropIcon.classList.add("midi-import__drop-icon");
  dropZone.appendChild(dropIcon);
  const dropText = el("div", "midi-import__drop-text");
  dropText.innerHTML =
    "Drop a <code>.mid</code> file here<br>or click to browse";
  dropZone.appendChild(dropText);

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ".mid,.midi";
  fileInput.className = "midi-import__file-input";
  dropZone.appendChild(fileInput);

  // Click anywhere in the drop zone to open file picker.
  dropZone.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) handleFile(fileInput.files[0], dialog, ctx);
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add("midi-import__drop-zone--active");
  });
  dropZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("midi-import__drop-zone--active");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("midi-import__drop-zone--active");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file, dialog, ctx);
  });

  dialog.appendChild(dropZone);

  const actions = el("div", "modal__actions");
  const cancelBtn = el("button", "btn btn--ghost modal__cancel", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => closeActive(null));
  actions.appendChild(cancelBtn);
  dialog.appendChild(actions);
}

// ─── File validation + parsing ───────────────────────────────────────────

async function handleFile(file, dialog, ctx) {
  // Extension check.
  const ext = "." + file.name.split(".").pop().toLowerCase();
  if (!VALID_EXTENSIONS.includes(ext)) {
    renderError(
      dialog,
      ctx,
      `"${file.name}" is not a MIDI file. Expected .mid or .midi.`,
    );
    return;
  }

  // Size check.
  if (file.size > MAX_FILE_SIZE) {
    renderError(
      dialog,
      ctx,
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.`,
    );
    return;
  }

  // Parse.
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    renderError(dialog, ctx, `Could not read file: ${err.message}`);
    return;
  }

  let input;
  try {
    input = parseMidiFile(buffer);
  } catch (err) {
    renderError(dialog, ctx, `Invalid MIDI file: ${err.message}`);
    return;
  }

  renderTrackSelection(dialog, ctx, input, buffer, file.name);
}

function renderError(dialog, ctx, message) {
  dialog.replaceChildren();
  const title = el("div", "modal__title", "Import MIDI");
  dialog.appendChild(title);

  const errorEl = el("div", "midi-import__error");
  errorEl.textContent = message;
  dialog.appendChild(errorEl);

  const actions = el("div", "modal__actions");
  const backBtn = el("button", "btn btn--ghost", "Back");
  backBtn.type = "button";
  backBtn.addEventListener("click", () => renderFileSelect(dialog, ctx));
  actions.appendChild(backBtn);
  dialog.appendChild(actions);
}

// ─── State 2: track selection ────────────────────────────────────────────

function renderTrackSelection(dialog, ctx, input, buffer, fileName) {
  dialog.replaceChildren();

  // Default pattern name from MIDI metadata or filename.
  const defaultName = sanitizePatternName(
    input.sourceName !== "untitled" ? input.sourceName : fileName,
  );

  // Title.
  const title = el("div", "modal__title");
  title.textContent = `Import: "${input.sourceName}"`;
  dialog.appendChild(title);

  // Pattern name input.
  const nameRow = el("div", "midi-import__name-row");
  const nameLabel = el("label", "midi-import__label", "Name");
  nameLabel.setAttribute("for", "midi-import-name");
  nameRow.appendChild(nameLabel);
  const nameInput = el("input", "modal__input midi-import__name-input");
  nameInput.type = "text";
  nameInput.id = "midi-import-name";
  nameInput.value = defaultName;
  nameInput.placeholder = "letters, numbers, - and _";
  nameInput.spellcheck = false;
  nameInput.autocomplete = "off";
  nameRow.appendChild(nameInput);
  const nameError = el("div", "modal__error midi-import__name-error");
  nameError.setAttribute("aria-live", "polite");
  nameRow.appendChild(nameError);
  dialog.appendChild(nameRow);

  // Song metadata.
  const [tsNum, tsDenom] = input.timeSignature;
  const totalNotes = input.tracks.reduce((s, t) => s + t.notes.length, 0);

  // Run analysis to get bar count and grid.
  const preAnalysis = analyzeTranslationInput(input);

  const metaEl = el("div", "midi-import__meta");
  metaEl.textContent = `${tsNum}/${tsDenom} at ${input.bpm} BPM · ${preAnalysis.totalBars} bars · ${totalNotes} notes`;
  dialog.appendChild(metaEl);

  // Track checkboxes.
  const tracksSection = el("div", "midi-import__tracks");
  const tracksLabel = el("div", "midi-import__section-label", "Tracks");
  tracksSection.appendChild(tracksLabel);

  const trackCheckboxes = [];

  for (let i = 0; i < input.tracks.length; i++) {
    const track = input.tracks[i];
    const analyzed = preAnalysis.tracks.find((t) => t.name === track.name);
    const isEmpty = track.notes.length === 0;
    const sound = analyzed
      ? track.isDrum
        ? "drums"
        : analyzed.strudelSound
      : "";
    const pitchRange = analyzed ? analyzed.pitchRange : "";

    const row = el(
      "label",
      "midi-import__track-row" +
        (isEmpty ? " midi-import__track-row--disabled" : ""),
    );
    const cb = el("input");
    cb.type = "checkbox";
    cb.className = "midi-import__track-cb";
    cb.checked = !isEmpty;
    cb.disabled = isEmpty;
    cb.dataset.trackIndex = String(i);
    trackCheckboxes.push(cb);
    row.appendChild(cb);

    const info = el("span", "midi-import__track-info");
    const nameSpan = el("span", "midi-import__track-name", track.name);
    info.appendChild(nameSpan);

    if (isEmpty) {
      const emptyBadge = el(
        "span",
        "midi-import__badge midi-import__badge--empty",
        "(empty)",
      );
      info.appendChild(emptyBadge);
    } else {
      const details = el("span", "midi-import__track-details");
      details.textContent = `${track.notes.length} notes`;
      if (pitchRange) details.textContent += `  ${pitchRange}`;
      info.appendChild(details);

      const soundBadge = el("span", "midi-import__badge", `→ ${sound}`);
      info.appendChild(soundBadge);
    }

    row.appendChild(info);
    tracksSection.appendChild(row);
  }

  dialog.appendChild(tracksSection);

  // Grid selector.
  const gridSection = el("div", "midi-import__grid-section");
  const gridLabel = el("div", "midi-import__section-label", "Grid");
  gridSection.appendChild(gridLabel);

  const gridRow = el("div", "midi-import__grid-row");
  const gridOptions = [
    {
      value: "auto",
      label: `auto (${gridSubdivisionLabel(preAnalysis.gridSubdivision, input.timeSignature)} detected)`,
    },
    { value: "8", label: "8th" },
    { value: "16", label: "16th" },
    { value: "32", label: "32nd" },
  ];

  let selectedGrid = "auto";

  for (const opt of gridOptions) {
    const radioLabel = el("label", "midi-import__grid-option");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "midi-import-grid";
    radio.value = opt.value;
    radio.checked = opt.value === "auto";
    radio.addEventListener("change", () => {
      selectedGrid = opt.value;
    });
    radioLabel.appendChild(radio);
    radioLabel.appendChild(document.createTextNode(" " + opt.label));
    gridRow.appendChild(radioLabel);
  }

  gridSection.appendChild(gridRow);
  dialog.appendChild(gridSection);

  // Warnings.
  const warningsEl = el("div", "midi-import__warnings");
  if (preAnalysis.warnings.length > 0) {
    for (const w of preAnalysis.warnings) {
      const wEl = el("div", "midi-import__warning");
      wEl.textContent = "⚠ " + w;
      warningsEl.appendChild(wEl);
    }
  }
  dialog.appendChild(warningsEl);

  // Actions.
  const actions = el("div", "modal__actions");
  const cancelBtn = el("button", "btn btn--ghost modal__cancel", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => closeActive(null));
  actions.appendChild(cancelBtn);

  const importBtn = el("button", "btn modal__confirm", "Import as pattern");
  importBtn.type = "button";
  actions.appendChild(importBtn);
  dialog.appendChild(actions);

  // Focus the name input.
  requestAnimationFrame(() => {
    nameInput.focus();
    nameInput.select();
  });

  // ─── Name validation (live) ────────────────────────────────────────────
  function validateName() {
    const name = nameInput.value.trim();
    const err = validatePatternName(name);
    if (err) {
      nameError.textContent = err;
      return null;
    }
    if (patternNameExists(name, ctx.patterns, ctx.store)) {
      nameError.textContent = `"${name}" already exists`;
      return null;
    }
    nameError.textContent = "";
    return name;
  }

  nameInput.addEventListener("input", validateName);

  // ─── Import action ────────────────────────────────────────────────────

  importBtn.addEventListener("click", async () => {
    const name = validateName();
    if (!name) {
      nameInput.focus();
      return;
    }

    const selectedIndices = trackCheckboxes
      .filter((cb) => cb.checked && !cb.disabled)
      .map((cb) => Number(cb.dataset.trackIndex));

    if (selectedIndices.length === 0) {
      // Show a temporary note.
      nameError.textContent = "Select at least one track";
      return;
    }

    const gridSubdivision =
      selectedGrid === "auto" ? undefined : Number(selectedGrid);

    let result;
    try {
      result = midiFileToPattern(buffer, {
        patternName: name,
        trackIndices: selectedIndices,
        gridSubdivision,
      });
    } catch (err) {
      nameError.textContent = `Import failed: ${err.message}`;
      return;
    }

    // Save via the shared saveNewPattern path.
    // result.patternBody = raw Strudel code (no export wrapper).
    // /api/save handles the export default `…` file wrapper on disk.
    ctx.flushToStore();
    const saveResult = await saveNewPattern({
      name: result.name,
      code: result.patternBody,
      store: ctx.store,
      patterns: ctx.patterns,
      leftRail: ctx.leftRail,
      setCurrentName: ctx.setCurrentName,
      editor: ctx.editor,
      transport: ctx.transport,
      isDev: ctx.isDev,
    });

    if (saveResult.ok) {
      closeActive(result.name);
    } else {
      nameError.textContent = saveResult.error || "Save failed";
    }
  });

  // Enter key in name input triggers import.
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      importBtn.click();
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sanitizePatternName(name) {
  return (
    name
      .toLowerCase()
      .replace(/\.midi?$/i, "")
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "imported-midi"
  );
}

function gridSubdivisionLabel(gridSlots, timeSignature) {
  const [tsNum, tsDenom] = timeSignature;
  const beatsPerBar = tsNum * (4 / tsDenom);
  const ratio = gridSlots / beatsPerBar;
  if (ratio === 1) return "quarter note";
  if (ratio === 2) return "8th note";
  if (ratio === 3) return "8th note triplet";
  if (ratio === 4) return "16th note";
  if (ratio === 6) return "16th note triplet";
  if (ratio === 8) return "32nd note";
  return `${gridSlots}-slot`;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// ─── Drag-and-drop helpers for the editor surface ────────────────────────

/**
 * Returns true if the DataTransfer contains a MIDI file.
 */
export function hasMidiFile(dataTransfer) {
  if (!dataTransfer?.files?.length) return false;
  for (const file of dataTransfer.files) {
    const ext = "." + file.name.split(".").pop().toLowerCase();
    if (VALID_EXTENSIONS.includes(ext)) return true;
  }
  return false;
}

/**
 * Extract the first MIDI file from a DataTransfer.
 */
export function getMidiFile(dataTransfer) {
  for (const file of dataTransfer.files) {
    const ext = "." + file.name.split(".").pop().toLowerCase();
    if (VALID_EXTENSIONS.includes(ext)) return file;
  }
  return null;
}
