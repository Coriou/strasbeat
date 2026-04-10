import { StrudelMirror, codemirrorSettings } from "@strudel/codemirror";
import { transpiler } from "@strudel/transpiler";
import { registerSoundfonts } from "@strudel/soundfonts";
// Strudel packages fed to evalScope below — imported as namespaces to avoid
// the static+dynamic chunking warning from mixing with named imports.
import * as strudelCore from "@strudel/core";
import * as strudelDraw from "@strudel/draw";
import * as strudelMini from "@strudel/mini";
import * as strudelTonal from "@strudel/tonal";
import * as strudelWebaudio from "@strudel/webaudio";
import * as strudelExt from "./strudel-ext/index.js";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MidiBridge, presets as midiPresets } from "./midi-bridge.js";
import { mountMidiBar } from "./ui/midi-bar.js";
import { installSoundCompletion } from "./editor/completions/sounds.js";
import strudelDocs from "./editor/strudel-docs.json";
import { hydrateIcons } from "./ui/icons.js";
import { mount as mountLeftRail } from "./ui/left-rail.js";
import { mountTransport } from "./ui/transport.js";
import { mountRightRail } from "./ui/right-rail.js";
import { createSoundBrowserPanel } from "./ui/sound-browser.js";
import { createReferencePanel } from "./ui/reference-panel.js";
import { createConsolePanel } from "./ui/console-panel.js";
import { createExportPanel } from "./ui/export-panel.js";
import { createSettingsPanel } from "./ui/settings-panel.js";
import { renderRoll } from "./ui/piano-roll.js";
import { mountTrackBar } from "./ui/track-bar.js";
import { prompt, confirm } from "./ui/modal.js";
import { applyStoredAccent, applyAccent, resetAccent, readStoredAccent, saveStoredAccent, clearStoredAccent } from "./ui/settings-drawer.js"; // prettier-ignore
import { createLocalStore } from "./store.js";
import { readSharedFromHash, shareCurrent } from "./share.js";
import { runExport, prewarmSounds, isExportRunning } from "./export.js";
import { previewSoundName, insertSoundName, tryReferenceExample, insertFunctionTemplate } from "./editor-actions.js"; // prettier-ignore
import { mountPianoRollResize } from "./piano-roll-resize.js";
import { mountDebugHelpers } from "./debug.js";
import { discoverPatterns, computeDirtySet, getUserPatternNames, createAutosave, handleNewPatternClick } from "./patterns.js"; // prettier-ignore
import { readStoredCmSettingsFromLocalStorage, applyInitialSettings, dispatchEditorExtensions, THEME_OPTIONS, applyPanelSetting } from "./editor-setup.js"; // prettier-ignore
import {
  installDefaultStrudelLogger,
  shouldIgnoreStrudelLog,
} from "./strudel-logger.js";

const { evalScope, controls } = strudelCore;
const { getAudioContext, webaudioOutput, registerSynthSounds, initAudio, initAudioOnFirstClick, setLogger, samples, soundMap, getSound, superdough, setAudioContext, setSuperdoughAudioController, resetGlobalEffects } = strudelWebaudio; // prettier-ignore

// Version strings surfaced in the settings panel's "About" section.
// Keep in sync with `package.json`.
const APP_VERSION = "0.1.0";
const STRUDEL_VERSION = "1.2.6";

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
// Tracks prebake progress so the UI can gate play, show progress, and
// surface partial failures rather than silently degrading.
let bootReady = false;
let bootFailures = [];
let _bootResolve;
const bootPromise = new Promise((r) => {
  _bootResolve = r;
});

// Progress bar — thin accent line across the top of the shell.
const progressBar = document.createElement("div");
progressBar.className = "boot-progress";
shellEl.prepend(progressBar);

function setBootProgress(fraction, label) {
  progressBar.style.setProperty("--boot-pct", `${Math.round(fraction * 100)}%`);
  if (label) status.textContent = label;
}

// Gate export/share until boot completes.
exportBtn.disabled = true;
shellEl.classList.add("is-booting");

// Forward decl — panel mounted further down; onEvalError fires after boot.
let consolePanel = null;

const editor = new StrudelMirror({
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  root: editorRoot,
  initialCode,
  drawTime,
  autodraw: true,
  // Eval failures routed into the console panel.
  onEvalError: (err) => {
    if (!consolePanel) return;
    try {
      consolePanel.error(err?.message || String(err), { error: err });
    } catch (panelErr) {
      console.warn("[strasbeat/console] error() failed:", panelErr);
    }
  },
  onDraw: (haps, time) =>
    renderRoll({ haps, time, ctx: drawCtx, drawTime, view: editor.editor }),
  prebake: async () => {
    try {
      initAudioOnFirstClick();
      setBootProgress(0.05, "loading modules…");
      const loadModules = evalScope(controls, strudelCore, strudelDraw, strudelMini, strudelTonal, strudelWebaudio, strudelExt); // prettier-ignore
      await loadModules;
      setBootProgress(0.15, "loading synth sounds…");

      const failures = [];
      const safe = (label, p) =>
        Promise.resolve(p).catch((e) => {
          console.warn(`[strasbeat] failed to load ${label}:`, e);
          failures.push(label);
        });

      // Timeout wrapper — if a phase takes longer than `ms`, continue with
      // whatever loaded rather than hanging the boot sequence forever. The
      // CDN (strudel.cc, GitHub) can be slow or unreachable; the user
      // should still get a working editor with degraded sound coverage.
      const BOOT_TIMEOUT_MS = 15_000;
      const withTimeout = (label, p, ms = BOOT_TIMEOUT_MS) =>
        safe(
          label,
          Promise.race([
            p,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`${label}: timed out after ${ms}ms`)),
                ms,
              ),
            ),
          ]),
        );

      // Phase 1: synth sounds (small, fast — no timeout needed)
      await safe("synth sounds", registerSynthSounds());
      setBootProgress(0.3, "loading soundfonts…");

      // Phase 2: soundfonts (medium — timeout protects against CDN issues)
      await withTimeout("soundfonts", registerSoundfonts());
      setBootProgress(0.5, "loading samples…");

      // Phase 3: sample banks (large, in parallel as they're independent)
      // strudel.cc has no CORS headers, so we proxy via vite.config.js
      await Promise.all([
        withTimeout("dirt-samples", samples("github:tidalcycles/dirt-samples")),
        withTimeout('tidal-drum-machines', samples('/strudel-cc/tidal-drum-machines.json', 'github:ritchse/tidal-drum-machines/main/machines/')), // prettier-ignore
      ]);
      setBootProgress(1.0);

      // ── Finalize boot state ──
      bootFailures = failures;
      bootReady = true;
      exportBtn.disabled = false;
      shellEl.classList.remove("is-booting");
      shellEl.classList.add("is-ready");

      if (failures.length === 0) {
        status.textContent = "Ready to play";
      } else {
        status.textContent = `Ready with ${failures.length} load warning${failures.length === 1 ? "" : "s"}`;
        console.warn("[strasbeat] boot completed with failures:", failures);
      }

      // Fade out progress bar.
      progressBar.classList.add("boot-progress--done");
      setTimeout(() => progressBar.remove(), 600);

      _bootResolve();
    } catch (fatalErr) {
      // Top-level error boundary — boot must ALWAYS resolve so the
      // editor is at least usable (even if sounds didn't load). Without
      // this, an unhandled throw leaves the boot promise hanging forever.
      console.error("[strasbeat] fatal boot error:", fatalErr);
      bootReady = true;
      exportBtn.disabled = false;
      shellEl.classList.remove("is-booting");
      shellEl.classList.add("is-ready");
      status.textContent = "Boot failed. Check console.";
      progressBar.classList.add("boot-progress--done");
      setTimeout(() => progressBar.remove(), 600);
      _bootResolve();
    }
  },
});

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
  onRevert(name) {
    store.delete(name);
    lastDirtyState.delete(name);
    if (currentName === name) {
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
const transport = mountTransport({
  getScheduler: () => editor?.repl?.scheduler ?? null,
});
let playbackRequestId = 0;

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

const soundBrowser = createSoundBrowserPanel({
  getSoundMap: () => soundMap.get(),
  onPreview: (name) =>
    previewSoundName(name, {
      getAudioContext,
      getSound,
      superdough,
      setStatus: (s) => transport.setStatus(s),
    }),
  onInsert: (name) => insertSoundName(name, editor.editor),
  onFocusEditor: () => editor.editor.focus(),
});
rightRail.registerPanel(soundBrowser);

referencePanel = createReferencePanel({
  docs: strudelDocs,
  onTry: (exampleCode) =>
    tryReferenceExample(exampleCode, {
      editor,
      patterns,
      getCurrentName: () => currentName,
      confirm,
    }),
  onInsert: (name, template) =>
    insertFunctionTemplate(name, template, editor.editor),
  onFocusEditor: () => editor.editor.focus(),
});
rightRail.registerPanel(referencePanel);
// Seed "in use" highlights immediately — buildEntries runs synchronously.
referencePanel.setBufferText(editor.code ?? "");

consolePanel = createConsolePanel({
  onFocusEditor: () => editor.editor.focus(),
});
rightRail.registerPanel(consolePanel);

// prettier-ignore
const exportPanel = createExportPanel({
  onFocusEditor: () => editor.editor.focus(),
  onExport: (options) => runExport(options, { editor, consolePanel, exportPanel, exportBtn, status, setLogger, getAudioContext, getSound, setAudioContext, setSuperdoughAudioController, resetGlobalEffects, initAudio, superdough }),
  getPatternName: () => currentName || "untitled",
});
rightRail.registerPanel(exportPanel);

let accentSaveTimer;
const settingsPanel = createSettingsPanel({
  onFocusEditor: () => editor.editor.focus(),
  getSettings: () => codemirrorSettings.get?.() ?? {},
  onChangeSetting: (key, value) => applyPanelSetting(editor, key, value),
  onAccentChange: (hue, lightness) => {
    applyAccent(hue, lightness);
    clearTimeout(accentSaveTimer);
    accentSaveTimer = setTimeout(() => saveStoredAccent(hue, lightness), 100);
  },
  onAccentReset: () => {
    clearStoredAccent();
    resetAccent();
  },
  getStoredAccent: () => readStoredAccent(),
  getSoundCount: () => Object.keys(soundMap.get() ?? {}).length,
  themes: THEME_OPTIONS,
  appVersion: APP_VERSION,
  strudelVersion: STRUDEL_VERSION,
});
rightRail.registerPanel(settingsPanel);

// Strudel's `logger()` dispatches a `strudel.log` CustomEvent on document
// for every internal log message — route into the console panel.
document.addEventListener("strudel.log", (e) => {
  if (!consolePanel) return;
  const detail = e?.detail ?? {};
  const type = typeof detail.type === "string" ? detail.type : "";
  const message = detail.message ?? "";
  const data = detail.data ?? null;
  if (shouldIgnoreStrudelLog(message)) return;
  try {
    if (type === "error") consolePanel.error(message, data);
    else if (type === "warning") consolePanel.warn(message, data);
    else consolePanel.log(message, data);
  } catch (panelErr) {
    console.warn("[strasbeat/console] dispatch failed:", panelErr);
  }
});

// Refresh the sound browser once prebake completes and the soundMap is populated.
bootPromise.then(() => {
  const count = Object.keys(soundMap.get() ?? {}).length;
  if (count > 0) {
    soundBrowser.refresh();
    soundBrowser.setBufferText(editor.code ?? "");
  } else {
    console.warn(
      "[strasbeat/sound-browser] soundMap still empty after boot — " +
        "the panel will stay empty until reload",
    );
  }
});

// Wrap editor.evaluate to fire a console divider, rescan "in use" sounds,
// refresh the reference panel on every eval entry point, and gate on boot.
// The first evaluate after boot awaits prewarm so all instruments are ready
// before the scheduler plays cycle 1; subsequent evals fire-and-forget.
let _firstEvalDone = false;
const _editorEvaluate = editor.evaluate.bind(editor);
editor.evaluate = async function patchedEvaluate(...args) {
  const evalRequestId = ++playbackRequestId;

  try {
    // If prebake is still in progress, keep Play live and queue the start.
    if (!bootReady) {
      transport.setPlaybackState("queued");
      transport.setStatus("Loading sounds…");
      await bootPromise;
      if (evalRequestId !== playbackRequestId) return null;
    }

    transport.setPlaybackState("loading");

    // Health-check: if the AudioContext is closed (e.g. post-export bug,
    // tab backgrounded on iOS), restore it before evaluating. A suspended
    // context is normal (autoplay policy) — resume will un-gate it.
    try {
      const ac = getAudioContext();
      if (ac.state === "closed") {
        console.warn("[strasbeat] AudioContext was closed — restoring");
        setAudioContext(null);
        setSuperdoughAudioController(null);
        resetGlobalEffects();
        await initAudio();
      } else if (ac.state === "suspended") {
        await ac.resume();
      }
    } catch (err) {
      console.warn("[strasbeat] audio context health check failed:", err);
    }
    if (evalRequestId !== playbackRequestId) return null;

    try {
      consolePanel?.divider(currentName || "eval");
    } catch (err) {
      console.warn("[strasbeat/console] divider failed:", err);
    }
    const result = await _editorEvaluate(...args);
    if (evalRequestId !== playbackRequestId) return result;

    try {
      soundBrowser.setBufferText(editor.code ?? "");
    } catch (err) {
      console.warn("[strasbeat/sound-browser] in-use scan failed:", err);
    }
    try {
      referencePanel.setBufferText(editor.code ?? "");
    } catch (err) {
      console.warn("[strasbeat/reference-panel] in-use scan failed:", err);
    }

    // Pre-warm: trigger loading of all sounds the pattern uses.
    // First play: AWAIT pre-warm so every instrument is ready before
    // cycle 1 — eliminates the "sounds appear gradually" artifact.
    // Subsequent plays: fire-and-forget (sounds are already cached).
    try {
      const pattern = editor.repl?.state?.pattern;
      const cps = editor.repl?.scheduler?.cps ?? 1;
      if (pattern) {
        const haps = pattern.queryArc(0, 4, { _cps: cps });
        if (!_firstEvalDone) {
          _firstEvalDone = true;
          transport.setStatus("loading instruments…");
          const { warmed, failed } = await prewarmSounds(haps, {
            getSound,
            getAudioContext,
          });
          if (evalRequestId !== playbackRequestId) return result;
          if (failed.length) {
            console.warn(
              `[strasbeat/prewarm] ${failed.length} sound(s) failed to warm:`,
              failed,
            );
            transport.setStatus(
              `playing · ${failed.length} sound(s) couldn't load`,
            );
          } else {
            transport.setStatus(`playing · ${warmed} instruments ready`);
          }
        } else {
          prewarmSounds(haps, { getSound, getAudioContext }).catch((err) =>
            console.warn("[strasbeat/prewarm] background warm failed:", err),
          );
        }
      }
    } catch (err) {
      console.warn("[strasbeat/prewarm] failed to kick off pre-warm:", err);
    }

    if (
      evalRequestId === playbackRequestId &&
      !editor.repl?.scheduler?.started
    ) {
      transport.setPlaybackState("idle");
    }

    return result;
  } catch (err) {
    if (evalRequestId === playbackRequestId) {
      transport.setPlaybackState("idle");
    }
    throw err;
  }
};

const _editorStop = editor.stop.bind(editor);
editor.stop = function patchedStop(...args) {
  const state = transportEl?.dataset.transportState ?? "idle";
  playbackRequestId += 1;
  const result = _editorStop(...args);
  transport.setPlaybackState("idle");
  if (state === "queued" || state === "loading") {
    transport.setStatus("play canceled");
  } else {
    transport.setStatus("Stopped");
  }
  return result;
};

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

captureBtn.addEventListener("click", async () => {
  if (!midi.isCaptureEnabled()) {
    midi.setCaptureEnabled(true);
    midiBar.setCaptureState({ recording: true, count: 0 });
    transport.setStatus(
      "capturing MIDI · play something · click again to save",
    );
    return;
  }
  // stop + save
  midi.setCaptureEnabled(false);
  midiBar.setCaptureState({ recording: false });
  const code = midi.buildPatternFromCapture();
  if (!code) {
    transport.setStatus("capture stopped — no notes recorded");
    return;
  }
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
});

// prettier-ignore
window.strasbeat = mountDebugHelpers({ soundMap, getSound, editor, getConsolePanel: () => consolePanel, getAudioContext, setAudioContext, setSuperdoughAudioController, resetGlobalEffects, initAudio, superdough });

// expose for console tinkering
window.editor = editor;
window.patterns = patterns;
window.midi = midi;
