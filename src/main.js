import { StrudelMirror } from "@strudel/codemirror";
import { transpiler } from "@strudel/transpiler";
// Strudel packages — imported as namespaces to avoid the static+dynamic
// chunking warning. Boot-only packages (strudelDraw, soundfonts) live in
// boot.js; the rest are still needed here for installSoundCompletion.
import * as strudelCore from "@strudel/core";
import * as strudelMini from "@strudel/mini";
import * as strudelTonal from "@strudel/tonal";
import * as strudelWebaudio from "@strudel/webaudio";
import * as strudelExt from "./strudel-ext/index.js";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MidiBridge } from "./midi-bridge.js";
import { mountMidiBar } from "./ui/midi-bar.js";
import { installSoundCompletion } from "./editor/completions/sounds.js";
import {
  clearError,
  extractErrorLine,
  setError,
} from "./editor/error-marks.js";
import strudelDocs from "./editor/strudel-docs.json";
import { hydrateIcons } from "./ui/icons.js";
import { mount as mountLeftRail } from "./ui/left-rail.js";
import { mountTransport } from "./ui/transport.js";
import { mountRightRail } from "./ui/right-rail.js";
import { registerPanels } from "./panels.js";
import { renderRoll } from "./ui/piano-roll.js";
import { createScope } from "./ui/scope.js";
import { createBottomPanelModes } from "./ui/bottom-panel-modes.js";
import { mountTrackBar } from "./ui/track-bar.js";
import { prompt, confirm } from "./ui/modal.js";
import { applyStoredAccent } from "./ui/settings-drawer.js";
import { createLocalStore } from "./store.js";
import { readSharedFromHash, shareCurrent } from "./share.js";
import { prewarmSounds, isExportRunning } from "./export.js";
import { mountPianoRollResize } from "./piano-roll-resize.js";
import { mountDebugHelpers } from "./debug.js";
import {
  discoverPatterns,
  computeDirtySet,
  getUserPatternNames,
  createAutosave,
  handleNewPatternClick,
} from "./patterns.js";
import { showMidiImportDialog, getMidiFile } from "./ui/midi-import-dialog.js";
import {
  readStoredCmSettingsFromLocalStorage,
  applyInitialSettings,
  dispatchEditorExtensions,
} from "./editor-setup.js";
import { installDefaultStrudelLogger } from "./strudel-logger.js";
import { installEvalFeedback } from "./eval-feedback.js";
import { createBoot } from "./boot.js";
import { handleCaptureClick } from "./capture.js";
import { mountCommandPalette } from "./ui/command-palette.js";
import { buildPaletteCommands } from "./command-palette-actions.js";

const { getAudioContext, webaudioOutput, initAudio, setLogger, soundMap, getSound, superdough, setAudioContext, setSuperdoughAudioController, resetGlobalEffects } = strudelWebaudio; // prettier-ignore

// Version strings surfaced in the settings panel's "About" section.
// Injected at build/dev time by vite.config.js — always match package.json.
const APP_VERSION = __APP_VERSION__;
const STRUDEL_VERSION = __STRUDEL_VERSION__;

// ─── Auto-discover patterns ──────────────────────────────────────────────
// Every .js file in /patterns must `export default` a string of Strudel code.
// Adding/removing files triggers Vite HMR (see hot.accept below).
const patternModules = import.meta.glob("../patterns/*.js", { eager: true });
const { patterns, patternNames } = discoverPatterns(patternModules);

// ─── Persistence store ───────────────────────────────────────────────────
// See design/work/09-pattern-persistence.md.
const store = createLocalStore();

// ─── DOM refs ────────────────────────────────────────────────────────────
const editorRoot = document.getElementById("editor");
const canvas = document.getElementById("roll");
const status = document.getElementById("status");
const playBtn = document.getElementById("play");
const stopBtn = document.getElementById("stop");
const saveBtn = document.getElementById("save");
const exportBtn = document.getElementById("export-wav");
const shareBtn = document.getElementById("share");
const midiBarContainer = document.getElementById("midi-bar");

const shellEl = document.querySelector(".shell");
const transportEl = document.getElementById("transport");
const leftRailContainer = document.getElementById("left-rail");
const patternMenuBtn = document.getElementById("pattern-menu");
const patternMenuName = document.getElementById("pattern-menu-name");
const settingsBtn = document.getElementById("settings");
const rollToggleBtn = document.getElementById("roll-toggle");
const rollDivider = document.getElementById("roll-divider");
const rightRailEl = document.getElementById("right-rail");
const rightRailTabsEl = document.getElementById("right-rail-tabs");
const rightRailPanelEl = document.getElementById("right-rail-panel");
const rightRailResizeEl = document.getElementById("right-rail-resize");

hydrateIcons(document);
applyStoredAccent();
if (import.meta.env.DEV) document.body.classList.add("dev-mode");
installDefaultStrudelLogger(setLogger);

// Platform-aware keyboard shortcut label on the Play button.
{
  const kbd = playBtn.querySelector(".transport__kbd");
  if (kbd && !/Mac|iPhone|iPad/.test(navigator.platform)) {
    kbd.textContent = "Ctrl\u21B5";
  }
}

// HiDPI piano roll — ResizeObserver handles window resize, right-rail
// reflow, and DPR changes (e.g. dragging between monitors).
let resizeTimer = null;
const resizeCanvas = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(doResize, 50);
};
const doResize = () => {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (w === 0 && h === 0) return; // collapsed — keep the old backing store
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
};
resizeCanvas();
new ResizeObserver(() => resizeCanvas()).observe(canvas);
const drawCtx = canvas.getContext("2d");
const drawTime = [-2, 2]; // seconds before / after now to render

// Bottom panel mode switcher (Roll / Scope / Custom)
const scope = createScope();
const bottomModes = createBottomPanelModes();
bottomModes.mountTabBar(canvas.parentElement);
bottomModes.setOnChange((mode) => {
  if (mode === "scope") {
    try {
      scope.connect(getAudioContext());
    } catch {}
  }
});

// ─── Editor ──────────────────────────────────────────────────────────────
// Boot sequence: share link > store lastOpen > first shipped pattern.
const shared = readSharedFromHash();
const storeIndex = store.getIndex();
const fallbackName = patternNames[0] ?? "empty";

let initialName, initialCode;
if (shared) {
  initialName = `shared-${shared.name}`.replace(/[^a-z0-9_-]/gi, "-").slice(0, 40); // prettier-ignore
  initialCode = shared.code;
} else if (storeIndex.lastOpen) {
  initialName = storeIndex.lastOpen;
  const record = store.get(initialName);
  if (record) initialCode = record.code;
  else if (initialName in patterns) initialCode = patterns[initialName];
  else {
    initialName = fallbackName;
    initialCode = patterns[fallbackName] ?? `// no patterns found\nsound("bd sd hh*4")`; // prettier-ignore
  }
} else {
  initialName = fallbackName;
  initialCode = patterns[fallbackName] ?? `// no patterns found in /patterns yet — type some Strudel here\nsound("bd sd hh*4")`; // prettier-ignore
}

let currentName = initialName;

// Snapshot stored CM settings BEFORE StrudelMirror instantiation — see
// editor-setup.js for why.
const INITIAL_STORED_CM_SETTINGS = readStoredCmSettingsFromLocalStorage();

// ─── Boot state machine ─────────────────────────────────────────────────
const { bootPromise, getBootReady, prebake } = createBoot({
  shellEl,
  exportBtn,
  status,
});

// Forward decl — panel mounted further down; onEvalError fires after boot.
let consolePanel = null;
let transport = null;
let evalFeedback = null;

const editor = new StrudelMirror({
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  root: editorRoot,
  initialCode,
  drawTime,
  autodraw: true,
  // Eval failures routed into eval-feedback.js via forward-ref.
  onEvalError: (err) => evalFeedback?.handleEvalError(err),
  onDraw: (haps, time) => {
    const mode = bottomModes.getMode();
    if (mode === "scope") {
      const dpr = window.devicePixelRatio || 1;
      scope.render(drawCtx, canvas.width / dpr, canvas.height / dpr);
    } else if (mode === "custom") {
      const customFn = bottomModes.getCustomDraw();
      if (customFn) {
        try {
          customFn(drawCtx, haps, time);
        } catch (err) {
          console.warn("[strasbeat] custom draw error:", err);
        }
      }
    } else {
      renderRoll({ haps, time, ctx: drawCtx, drawTime, view: editor.editor });
    }
  },
  prebake,
});

function focusEditorLocation({ line, column } = {}) {
  const view = editor.editor;
  if (!view || !Number.isInteger(line)) return;
  if (line < 1 || line > view.state.doc.lines) return;
  const lineInfo = view.state.doc.line(line);
  const safeColumn =
    typeof column === "number"
      ? Math.max(0, Math.min(column, lineInfo.length))
      : 0;
  view.dispatch({
    selection: { anchor: lineInfo.from + safeColumn },
    scrollIntoView: true,
  });
  view.focus();
}

// Strudel resets Drawer.drawTime to [0,0] after eval when the pattern has no
// .onPaint()/.pianoroll() — intercept to preserve our 4-cycle window.
const _setDrawTime = editor.drawer.setDrawTime.bind(editor.drawer);
editor.drawer.setDrawTime = (dt) => {
  if (Array.isArray(dt) && dt[0] === 0 && dt[1] === 0) {
    _setDrawTime(drawTime);
  } else {
    _setDrawTime(dt);
  }
};

applyInitialSettings(editor, INITIAL_STORED_CM_SETTINGS);

// Forward decl — panel mounted further down; hoverDocs deep-link fires later.
let referencePanel = null;

dispatchEditorExtensions(editor, {
  onOpenReference: (name) => {
    if (!referencePanel) return;
    rightRail.activate("reference");
    referencePanel.scrollTo(name);
  },
});

// Sound name completion — must run after applyInitialSettings.
installSoundCompletion(editor.editor, [
  ...new Set([
    ...Object.keys(strudelCore),
    ...Object.keys(strudelMini),
    ...Object.keys(strudelTonal),
    ...Object.keys(strudelWebaudio),
    ...Object.keys(strudelExt),
  ]),
]);

// ─── Left rail (patterns library) ────────────────────────────────────────
const leftRail = mountLeftRail({
  container: leftRailContainer,
  patterns,
  userPatterns: getUserPatternNames(store),
  dirtySet: computeDirtySet(patternNames, patterns, store),
  currentName: currentName,
  onSelect(name) {
    flushToStore();
    clearError(editor.editor);
    evalFeedback?.resetRuntimeErrors();
    setCurrentName(name);
    const record = store.get(name);
    if (record) editor.setCode(record.code);
    else if (name in patterns) editor.setCode(patterns[name]);
    const idx = store.getIndex();
    idx.lastOpen = name;
    store.setIndex(idx);
    transport.setStatus(`Loaded "${name}"`);
  },
  onCreate() {
    handleNewPatternClick({
      store,
      patterns,
      editor,
      leftRail,
      transport,
      setCurrentName,
      flushToStore,
      prompt,
      isDev: import.meta.env.DEV,
    });
  },
  onImportMidi() {
    openMidiImportDialog();
  },
  onRevert(name) {
    store.delete(name);
    lastDirtyState.delete(name);
    if (currentName === name) {
      clearError(editor.editor);
      evalFeedback?.resetRuntimeErrors();
      editor.setCode(patterns[name]);
    }
    leftRail.updateDirtySet(computeDirtySet(patternNames, patterns, store));
    transport.setStatus(`reverted "${name}" to original`);
  },
  onDelete(name) {
    store.delete(name);
    const idx = store.getIndex();
    idx.userPatterns = idx.userPatterns.filter((n) => n !== name);
    leftRail.removeUserPattern(name);
    if (currentName === name) {
      const fallback = patternNames[0];
      setCurrentName(fallback);
      editor.setCode(patterns[fallback]);
      idx.lastOpen = fallback;
    }
    store.setIndex(idx);
    transport.setStatus(`deleted "${name}"`);
  },
});

// ─── Transport bar ───────────────────────────────────────────────────────
transport = mountTransport({
  getScheduler: () => editor?.repl?.scheduler ?? null,
  getAudioContext,
  onErrorBadgeClick: () => {
    const ate = evalFeedback?.getActiveTransportError();
    if (ate?.entryId != null) {
      rightRail.activate("console");
      consolePanel?.scrollToEntry(ate.entryId);
      return;
    }
    if (ate?.location) {
      focusEditorLocation(ate.location);
      return;
    }
    rightRail.activate("console");
  },
});

// Keeps the top-bar wordmark, left rail highlight, and `currentName` in sync.
function setCurrentName(name) {
  currentName = name;
  patternMenuName.textContent = name || "untitled";
  // The rail knows about both shipped and user patterns.
  if (name) leftRail.setCurrent(name);
  else leftRail.clearCurrent();
}
setCurrentName(currentName);

// Show a one-time boot message if we restored a working copy.
if (!shared && storeIndex.lastOpen && store.get(storeIndex.lastOpen)) {
  transport.setStatus(`restored your edits to "${storeIndex.lastOpen}"`);
}

// ─── Autosave ────────────────────────────────────────────────────────────
const { flushToStore, scheduleAutosave, lastDirtyState } = createAutosave({
  editor,
  store,
  patterns,
  patternNames,
  getCurrentName: () => currentName,
  leftRail,
  transport,
});

editor.editor.dispatch({
  effects: StateEffect.appendConfig.of([
    EditorView.updateListener.of((update) => {
      if (update.docChanged) scheduleAutosave();
    }),
  ]),
});

{
  const idx = store.getIndex();
  idx.lastOpen = currentName;
  store.setIndex(idx);
}

window.addEventListener("beforeunload", () => {
  flushToStore();
});

// ─── MIDI import dialog helper ───────────────────────────────────────────
function openMidiImportDialog(file) {
  showMidiImportDialog({
    store,
    patterns,
    leftRail,
    editor,
    transport,
    setCurrentName,
    flushToStore,
    isDev: import.meta.env.DEV,
    file,
  });
}

// ─── MIDI file drag-and-drop on the editor surface ───────────────────────
editorRoot.addEventListener("dragover", (e) => {
  // During dragover, browsers restrict file access — we can only check
  // whether *any* files are being dragged, not their names. Show the cue
  // optimistically for any file drag; the drop handler filters by extension.
  if (e.dataTransfer?.types?.includes("Files")) {
    e.preventDefault();
    e.stopPropagation();
    editorRoot.classList.add("editor--midi-dragover");
  }
});
editorRoot.addEventListener("dragleave", (e) => {
  if (e.target === editorRoot || !editorRoot.contains(e.relatedTarget)) {
    editorRoot.classList.remove("editor--midi-dragover");
  }
});
editorRoot.addEventListener("drop", (e) => {
  editorRoot.classList.remove("editor--midi-dragover");
  const file = getMidiFile(e.dataTransfer);
  if (file) {
    e.preventDefault();
    e.stopPropagation();
    openMidiImportDialog(file);
  }
  // Non-MIDI files fall through to the browser/editor's normal behavior.
});

// ─── Top bar wiring ──────────────────────────────────────────────────────
patternMenuBtn.addEventListener("click", () => leftRail.focusSearch());
settingsBtn.addEventListener("click", () => {
  if (rightRail.isExpanded() && rightRail.getActiveId() === "settings") {
    rightRail.collapse();
  } else {
    rightRail.activate("settings");
  }
});

// ─── Right rail (panel host) ─────────────────────────────────────────────
const rightRail = mountRightRail({
  container: rightRailEl,
  tabsContainer: rightRailTabsEl,
  panelContainer: rightRailPanelEl,
  resizeHandle: rightRailResizeEl,
  storageKey: "strasbeat:right-rail",
  onFocusEditor: () => editor.editor.focus(),
});

const {
  consolePanel: cp,
  soundBrowser,
  referencePanel: rp,
  exportPanel,
} = registerPanels({
  rightRail,
  editor,
  transport,
  patterns,
  getCurrentName: () => currentName,
  confirm,
  prompt,
  store,
  leftRail,
  setCurrentName,
  flushToStore,
  handleNewPatternClick,
  focusEditorLocation,
  getEvalFeedback: () => evalFeedback,
  strudelDocs,
  soundMap,
  getAudioContext,
  getSound,
  superdough,
  setLogger,
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  initAudio,
  scope,
  bottomModes,
  saveBtn,
  exportBtn,
  status,
  APP_VERSION,
  STRUDEL_VERSION,
  isDev: import.meta.env.DEV,
  bootPromise,
});
consolePanel = cp;
referencePanel = rp;

// ─── Eval feedback (error infra + sound validation + patched evaluate) ───
evalFeedback = installEvalFeedback({
  editor,
  transport,
  transportEl,
  consolePanel,
  soundBrowser,
  referencePanel,
  soundMap,
  getSound,
  getAudioContext,
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  initAudio,
  bootPromise,
  getBootReady,
  clearError,
  setError,
  extractErrorLine,
  prewarmSounds,
  getCurrentName: () => currentName,
});

// Cmd/Ctrl+B toggles the right rail (matches VSCode's sidebar toggle).
document.addEventListener(
  "keydown",
  (e) => {
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === "b"
    ) {
      e.preventDefault();
      rightRail.toggle();
    }
  },
  true,
);

// ─── Command palette (Cmd+Shift+P) ──────────────────────────────────────
const palette = mountCommandPalette({
  commands: buildPaletteCommands({
    editor,
    rightRail,
    leftRail,
    bottomModes,
    saveBtn,
    exportBtn,
    shareBtn,
  }),
});

document.addEventListener(
  "keydown",
  (e) => {
    if (
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === "p"
    ) {
      e.preventDefault();
      palette.toggle();
    }
  },
  true,
);

mountPianoRollResize({ shellEl, rollToggleBtn, rollDivider, resizeCanvas });
mountTrackBar({
  container: document.getElementById("track-bar"),
  view: editor.editor,
  onEvaluate: () => editor.evaluate(),
});

// ─── Transport ───────────────────────────────────────────────────────────
playBtn.addEventListener("click", async () => {
  if (isExportRunning()) {
    transport.setStatus("Export in progress");
    return;
  }
  await editor.evaluate();
  transport.kick(); // promote the readout loop to rAF immediately
});
stopBtn.addEventListener("click", () => editor.stop());

// ─── Save current editor → patterns/<name>.js (dev-only) ────────────────
if (import.meta.env.DEV) {
  saveBtn.addEventListener("click", async () => {
    const suggestion = currentName || "untitled";
    const name = await prompt({
      title: "Save pattern as",
      placeholder: "filename without .js",
      defaultValue: suggestion,
      confirmLabel: "Save",
      validate: (v) =>
        /^[a-z0-9_-]+$/i.test(v) ? null : "use only letters, numbers, - and _",
    });
    if (!name) return;
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, code: editor.code }),
    });
    if (!res.ok) {
      status.textContent = `save failed: ${await res.text()}`;
      return;
    }
    const { path } = await res.json();
    setCurrentName(name);
    // Disk is now canonical — clear the working copy from store.
    store.delete(name);
    leftRail.updateDirtySet(computeDirtySet(patternNames, patterns, store));
    status.textContent = `saved → ${path}`;
    // Vite HMR will pick up the new file and re-fire the glob below.
  });
}

shareBtn.addEventListener("click", () =>
  shareCurrent({
    getCode: () => editor.code ?? "",
    getName: () => currentName,
    setStatus: (s) => {
      status.textContent = s;
    },
  }),
);

// Toolbar WAV button → open the export panel and auto-start a render.
exportBtn.addEventListener("click", () => {
  rightRail.activate("export");
  exportPanel.autoExport();
});

// ─── HMR: refresh pattern list when files change on disk ─────────────────
if (import.meta.hot) {
  import.meta.hot.accept(
    Object.keys(patternModules).map((p) => p.replace("..", "/patterns")),
    () => {
      // a known pattern file changed — reload the page module to refresh state
      location.reload();
    },
  );
  // also pick up *new* files (vite re-evaluates the importing module)
  import.meta.hot.accept(() => location.reload());
}

// ─── MIDI bridge ─────────────────────────────────────────────────────────
let currentPreset = "epiano";

const midi = new MidiBridge({
  getPreset: () => currentPreset,
  onStatus: (s) => transport.setMidiStatus(s),
  onCaptureChange: (n) => {
    if (midi.isCaptureEnabled())
      midiBar.setCaptureState({ recording: true, count: n });
  },
});

const midiBar = mountMidiBar({
  container: midiBarContainer,
  midi,
  getPreset: () => currentPreset,
  onPresetChange: (key) => {
    currentPreset = key;
    midiBar.persistState();
  },
});

// Hydrate icons inside the dynamically built MIDI bar.
hydrateIcons(midiBarContainer);

midi.start();

// Capture button lives inside the MIDI bar now; find it there.
const captureBtn = midiBar.getCaptureButton();

captureBtn.addEventListener("click", () =>
  handleCaptureClick({
    midi,
    midiBar,
    transport,
    editor,
    store,
    leftRail,
    prompt,
    setCurrentName,
  }),
);

// prettier-ignore
window.strasbeat = mountDebugHelpers({ soundMap, getSound, editor, getConsolePanel: () => consolePanel, getAudioContext, setAudioContext, setSuperdoughAudioController, resetGlobalEffects, initAudio, superdough });

// expose for console tinkering
window.editor = editor;
window.patterns = patterns;
window.midi = midi;

// ─── PWA shortcut actions (?action=new|export from manifest shortcuts) ───
bootPromise.then(() => {
  const params = new URLSearchParams(location.search);
  const action = params.get("action");
  if (!action) return;
  // Clean the URL so the action doesn't re-fire on reload.
  const clean = new URL(location.href);
  clean.searchParams.delete("action");
  history.replaceState(null, "", clean.pathname + clean.search + clean.hash);
  if (action === "new") {
    handleNewPatternClick({
      getEditorCode: () => editor.code ?? "",
      getCurrentName: () => currentName,
      setCurrentName,
      patterns,
      patternNames,
      leftRail,
      store,
      editor,
    });
  } else if (action === "export") {
    exportBtn?.click();
  }
});
