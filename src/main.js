import { StrudelMirror } from "@strudel/codemirror";
import { transpiler } from "./transpiler-patch.js";
// Strudel packages — imported as namespaces to avoid the static+dynamic
// chunking warning. Boot-only packages (strudelDraw, soundfonts) live in
// boot.js; the rest are still needed here for installCompletions.
import * as strudelCore from "@strudel/core";
import * as strudelMini from "@strudel/mini";
import * as strudelTonal from "@strudel/tonal";
import * as strudelWebaudio from "@strudel/webaudio";
import * as strudelExt from "./strudel-ext/index.js";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { toggleComment } from "@codemirror/commands";
import { MidiBridge } from "./midi-bridge.js";
import { mountMidiBar } from "./ui/midi-bar.js";
import { installCompletions } from "./editor/completions/install.js";
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
import { mountScopeControls } from "./ui/scope-controls.js";
import { createBottomPanelModes } from "./ui/bottom-panel-modes.js";
import { mountBeatGrid } from "./ui/beat-grid.js";
import { mountTrackBar } from "./ui/track-bar.js";
import { mountArrangeBar } from "./ui/arrange-bar.js";
import { prompt, confirm, formModal, choiceModal } from "./ui/modal.js";
import { applyStoredAccent } from "./ui/settings-drawer.js";
import { createLocalStore } from "./store.js";
import { readSharedFromHash, shareCurrent } from "./share.js";
import { prewarmSounds, isExportRunning } from "./export.js";
import { mountPianoRollResize } from "./piano-roll-resize.js";
import { mountDebugHelpers } from "./debug.js";
import {
  discoverPatterns,
  computeDirtySet,
  groupUserPatternsByFolder,
  validateFolderName,
  createAutosave,
  handleNewPatternClick,
  handleDuplicateClick,
  handleBulkDuplicateClick,
} from "./patterns.js";
import { showMidiImportDialog, getMidiFile } from "./ui/midi-import-dialog.js";
import {
  readStoredCmSettingsFromLocalStorage,
  applyInitialSettings,
  dispatchEditorExtensions,
  strasbeatOverlayCompartment,
} from "./editor-setup.js";
import { createTabController } from "./tabs.js";
import { freshTabState, liveCompartmentValues } from "./editor/build-editor-state.js";
import { createDocSync } from "./editor/doc-sync.js";
import { readSelectedCompletion } from "./editor/keymap-universal.js";
import { previewSoundName, insertSoundName } from "./editor-actions.js";
import { installDefaultStrudelLogger } from "./strudel-logger.js";
import { installEvalFeedback } from "./eval-feedback.js";
import { createBoot } from "./boot.js";
import { handleCaptureClick } from "./capture.js";
import { mountCommandPalette } from "./ui/command-palette.js";
import { mountTabStrip } from "./ui/tab-strip.js";
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
const editorPane = document.querySelector(".editor-pane"); // hosts the empty-state overlay
const canvas = document.getElementById("roll");
const status = document.getElementById("status");
const playBtn = document.getElementById("play");
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

// Platform-aware keyboard shortcut label on the transport button. Only the
// modifier key glyph changes (\u2318 \u2192 Ctrl); the \u21B5 stays.
if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
  const modKey = playBtn.querySelector(".transport__kbd-key");
  if (modKey) modKey.textContent = "Ctrl";
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

// Bottom panel mode switcher (Roll / Scope / Custom) — the toggle is a
// floating pill in the top-right of the roll pane; scope taps superdough's
// destinationGain lazily on first render, so nothing to wire here.
const scope = createScope();
const bottomModes = createBottomPanelModes();
bottomModes.mountToggle(canvas.parentElement);
mountScopeControls({
  container: bottomModes.getBarEl(),
  scope,
  modes: bottomModes,
});

// ─── Editor ──────────────────────────────────────────────────────────────
// Boot sequence: share link > store lastOpen > first shipped pattern.
const shared = await readSharedFromHash();
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
// Forward decl — mounted after the transport so its init playback-state
// callback (which fires synchronously with `idle`) can safely reference it.
let beatGrid = null;
let tabStrip = null;
let tabs = null;

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
    // Beat grid renders DOM over the canvas — no canvas paint to do, and
    // keeping the renderer running underneath would just waste cycles.
    if (mode === "beats") return;
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
  // Alt+ArrowDown / Alt+ArrowUp on a sound or sample-variant completion
  // fires a one-shot audition through the live audio context. Mirrors
  // the sound-browser's preview shape (see editor-actions.js#previewSoundName).
  // Non-audible completion types (function, chord, mode, etc.) are
  // ignored — we only know how to render audio for sounds.
  // `transport` is defined later in this file; the closure reads the
  // outer binding lazily so the late-binding works without reordering.
  onAuditionSelected: (view) => {
    const sel = readSelectedCompletion(view.state);
    if (!sel) return;
    // Sound and variant completions both stash an `_audition` payload
    // on the option (see providers/mini-notation.js + providers/sounds.js).
    // The payload carries the resolved name + bank + variant `n` so the
    // bank-aware and variant-aware audition fires the right sample.
    if (sel.audition) {
      previewSoundName(sel.audition.name, {
        getAudioContext,
        getSound,
        superdough,
        setStatus: (s) => transport?.setStatus(s),
      }, {
        bank: sel.audition.bank ?? undefined,
        n: sel.audition.n ?? undefined,
      });
      return;
    }
    // Fallback for legacy sound completions that don't carry a stashed
    // audition payload (defensive — every provider currently stashes one).
    if (sel.type === "sound") {
      previewSoundName(sel.label, {
        getAudioContext,
        getSound,
        superdough,
        setStatus: (s) => transport?.setStatus(s),
      });
    }
  },
  // Cmd+Shift+B reveal-in-browser. The keymap resolved the sound under
  // cursor; we open the right-rail browser and ask it to highlight that
  // exact name (expanding the kit group if it was collapsed).
  // `soundBrowser` and `rightRail` are declared further down in this
  // file but the closure runs lazily, so the order works.
  onRevealSound: (name) => {
    if (!name) {
      transport?.setStatus("no sound under cursor");
      return;
    }
    if (!soundBrowser) return;
    rightRail.activate("sounds");
    soundBrowser.focusSound(name);
  },
  // Cmd+J focus-browser. The keymap extracted the raw word under cursor;
  // we open the sound browser and pre-fill the search input so the user
  // can explore alternatives. Empty string clears the filter and shows
  // everything. `soundBrowser` and `rightRail` are late-bound (same as
  // onRevealSound above).
  onFocusBrowser: (word) => {
    if (!soundBrowser) return;
    rightRail.activate("sounds");
    soundBrowser.focusSearch(word);
  },
});

// Sound name completion — must run after applyInitialSettings.
// `audition` is wired in so each sound completion row's info panel
// renders a ▶ preview button (see buildAuditionInfo in
// src/editor/completions/info.js). Same shape as the Alt+Arrow audition
// path above — the third arg is unused by previewSoundName today and
// reserved for Phase 3 (Task 18) sample-variant opts.
installCompletions(editor.editor, [
  ...new Set([
    ...Object.keys(strudelCore),
    ...Object.keys(strudelMini),
    ...Object.keys(strudelTonal),
    ...Object.keys(strudelWebaudio),
    ...Object.keys(strudelExt),
  ]),
], {
  audition: (name, opts) => previewSoundName(name, {
    getAudioContext,
    getSound,
    superdough,
    setStatus: (s) => transport?.setStatus(s),
  }, opts),
});

// ─── Left rail (patterns library) ────────────────────────────────────────
const indexAtBoot = store.getIndex();
const collapsedFoldersAtBoot = indexAtBoot.uiState?.collapsedFolders ?? [];
const groupedAtBoot = groupUserPatternsByFolder(store);

// Re-pull grouped patterns + folders + collapsed state + dirty set and push
// them into the rail in one shot. Called from every state mutation below so
// the rail stays in sync without piecemeal add/remove calls.
function refreshRail() {
  const idx = store.getIndex();
  leftRail.setData({
    groupedUserPatterns: groupUserPatternsByFolder(store),
    folders: idx.folders ?? [],
    collapsedFolders: idx.uiState?.collapsedFolders ?? [],
    dirtySet: computeDirtySet(patternNames, patterns, store),
  });
  tabStrip?.render();
}

function persistCollapse(folderKey, isCollapsed) {
  const idx = store.getIndex();
  const set = new Set(idx.uiState?.collapsedFolders ?? []);
  if (isCollapsed) set.add(folderKey);
  else set.delete(folderKey);
  idx.uiState = {
    ...(idx.uiState ?? {}),
    collapsedFolders: Array.from(set),
  };
  store.setIndex(idx);
}

async function promptCreateFolder() {
  const idx = store.getIndex();
  const existing = idx.folders ?? [];
  const v = await formModal({
    title: "New folder",
    fields: [
      {
        key: "name",
        label: "Folder name",
        type: "text",
        placeholder: "e.g. Jazz Sessions",
      },
    ],
    confirmLabel: "Create",
    validate: (vals) => {
      const err = validateFolderName(vals.name, existing);
      return err ? { name: err } : null;
    },
  });
  if (!v) return null;
  const name = v.name.trim();
  store.setIndex({ ...idx, folders: [...existing, name] });
  refreshRail();
  return name;
}

function renameFolderHandler(oldName, newName) {
  if (oldName === newName) return;
  // Folder rename is two-step: rewrite N pattern records, then rewrite the
  // index. A QuotaExceededError mid-loop would leave records half-renamed.
  // Catch it at the boundary, refresh the rail to reflect whatever did land,
  // and surface the truncated state in the status bar.
  let rewrittenRecords = 0;
  try {
    rewrittenRecords = store.renameFolderInRecords(oldName, newName);
    const idx = store.getIndex();
    idx.folders = (idx.folders ?? []).map((f) => (f === oldName ? newName : f));
    if (idx.uiState?.collapsedFolders?.includes(oldName)) {
      idx.uiState = {
        ...idx.uiState,
        collapsedFolders: idx.uiState.collapsedFolders.map((f) =>
          f === oldName ? newName : f,
        ),
      };
    }
    if (idx.uiState?.lastNewPatternFolder === oldName) {
      idx.uiState = { ...idx.uiState, lastNewPatternFolder: newName };
    }
    store.setIndex(idx);
  } catch (err) {
    refreshRail();
    if (err?.name === "QuotaExceededError") {
      transport.setStatus(
        `⚠ storage full — folder rename stopped after ${rewrittenRecords} record(s)`,
      );
    } else {
      transport.setStatus(`rename failed: ${err?.message ?? err}`);
    }
    return;
  }
  refreshRail();
  transport.setStatus(`renamed folder "${oldName}" → "${newName}"`);
}

function removeFolderEntry(folderName) {
  const idx = store.getIndex();
  idx.folders = (idx.folders ?? []).filter((f) => f !== folderName);
  if (idx.uiState?.collapsedFolders) {
    idx.uiState = {
      ...idx.uiState,
      collapsedFolders: idx.uiState.collapsedFolders.filter(
        (f) => f !== folderName,
      ),
    };
  }
  if (idx.uiState?.lastNewPatternFolder === folderName) {
    idx.uiState = { ...idx.uiState, lastNewPatternFolder: null };
  }
  store.setIndex(idx);
}

async function deleteFolderHandler(folderName) {
  const grouped = groupUserPatternsByFolder(store);
  const inFolder = grouped.folders[folderName] ?? [];
  if (inFolder.length === 0) {
    const ok = await confirm({
      title: "Delete folder?",
      message: `Delete folder "${folderName}"?`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    removeFolderEntry(folderName);
    refreshRail();
    transport.setStatus(`deleted folder "${folderName}"`);
    return;
  }
  const choice = await choiceModal({
    title: `Delete folder "${folderName}"?`,
    message: `This folder contains ${inFolder.length} patterns.`,
    choices: [
      {
        value: "unfile",
        label: `Move ${inFolder.length} patterns to Unfiled`,
      },
      {
        value: "delete",
        label: `Delete folder and all ${inFolder.length} patterns`,
        danger: true,
      },
    ],
  });
  if (!choice) return;
  if (choice === "unfile") {
    for (const name of inFolder) {
      const rec = store.get(name);
      if (rec) {
        const next = { ...rec };
        delete next.folder;
        store.set(name, next);
      }
    }
  } else {
    for (const name of inFolder) {
      store.delete(name);
    }
    const idx = store.getIndex();
    idx.userPatterns = (idx.userPatterns ?? []).filter(
      (n) => !inFolder.includes(n),
    );
    store.setIndex(idx);
    for (const name of inFolder) {
      if (tabs.getOpenItems().includes(name)) tabs.close(name);
    }
  }
  removeFolderEntry(folderName);
  refreshRail();
  transport.setStatus(
    choice === "unfile"
      ? `moved ${inFolder.length} patterns to Unfiled, deleted folder "${folderName}"`
      : `deleted folder "${folderName}" and ${inFolder.length} patterns`,
  );
}

async function moveMany(names, target /* string | null | "__new__" */) {
  if (target === "__new__") {
    const created = await promptCreateFolder();
    if (created) await moveMany(names, created);
    return;
  }
  flushToStore();
  let movedUser = 0;
  let skippedDemos = 0;
  let quotaErrored = false;
  for (const name of names) {
    const rec = store.get(name);
    if (!rec || !rec.isUserPattern) {
      skippedDemos++;
      continue;
    }
    const next = { ...rec };
    if (target == null) delete next.folder;
    else next.folder = target;
    try {
      store.set(name, next);
      movedUser++;
    } catch (err) {
      if (err?.name === "QuotaExceededError") {
        quotaErrored = true;
        break;
      }
      console.warn(`[main] couldn't move "${name}":`, err);
    }
  }
  // If we moved something into a folder that's currently collapsed, expand
  // it so the user sees the result — otherwise the drop reads as "nothing
  // happened." Drag with hover-to-expand handles the same case during the
  // drag, but a quick drop (<500ms) bypasses the spring-load.
  if (target && movedUser > 0) {
    const idx = store.getIndex();
    const collapsed = idx.uiState?.collapsedFolders ?? [];
    if (collapsed.includes(target)) {
      idx.uiState = {
        ...(idx.uiState ?? {}),
        collapsedFolders: collapsed.filter((f) => f !== target),
      };
      try {
        store.setIndex(idx);
      } catch {
        /* index write failure is non-fatal here; folder just stays collapsed */
      }
    }
  }
  refreshRail();
  if (quotaErrored) {
    transport.setStatus(
      `⚠ storage full — stopped after moving ${movedUser} pattern${movedUser === 1 ? "" : "s"}`,
    );
  } else if (skippedDemos > 0 && movedUser === 0) {
    transport.setStatus(
      `Skipped ${skippedDemos} Demo${skippedDemos > 1 ? "s" : ""} — duplicate to customize`,
    );
  } else if (movedUser > 0) {
    const folderLabel = target ?? "Unfiled";
    const suffix = skippedDemos > 0
      ? ` (skipped ${skippedDemos} Demo${skippedDemos > 1 ? "s" : ""})`
      : "";
    transport.setStatus(
      `Moved ${movedUser} pattern${movedUser > 1 ? "s" : ""} to ${folderLabel}${suffix}`,
    );
  }
}

async function deleteMany(names) {
  const userNames = names.filter((n) => store.get(n)?.isUserPattern);
  if (userNames.length === 0) {
    transport.setStatus("Nothing to delete — Demos can't be removed");
    return;
  }
  const ok = await confirm({
    title: `Delete ${userNames.length} patterns?`,
    message: "This can’t be undone.",
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok) return;
  // store.delete swallows errors internally, so we don't need a try/catch
  // around the loop. The index write below is the only failable step.
  for (const name of userNames) {
    store.delete(name);
  }
  try {
    const idx = store.getIndex();
    idx.userPatterns = (idx.userPatterns ?? []).filter(
      (n) => !userNames.includes(n),
    );
    store.setIndex(idx);
  } catch (err) {
    refreshRail();
    if (err?.name === "QuotaExceededError") {
      transport.setStatus(
        "⚠ storage full — records deleted but index may be stale; reload to recover",
      );
    } else {
      transport.setStatus(`delete failed: ${err?.message ?? err}`);
    }
    return;
  }
  for (const n of userNames) {
    if (tabs.getOpenItems().includes(n)) tabs.close(n);
  }
  refreshRail();
  transport.setStatus(
    `Deleted ${userNames.length} pattern${userNames.length > 1 ? "s" : ""}`,
  );
}

function renamePatternHandler(oldName, newName) {
  if (oldName === newName) return;
  flushToStore();
  try {
    store.renamePatternKey(oldName, newName);
    const idx = store.getIndex();
    idx.userPatterns = (idx.userPatterns ?? []).map((n) =>
      n === oldName ? newName : n,
    );
    if (idx.lastOpen === oldName) idx.lastOpen = newName;
    store.setIndex(idx);
  } catch (err) {
    refreshRail();
    if (err?.name === "QuotaExceededError") {
      transport.setStatus(
        "⚠ storage full — couldn't rename, original record preserved",
      );
    } else {
      transport.setStatus(`rename failed: ${err?.message ?? err}`);
    }
    return;
  }
  tabs.reKey(oldName, newName);
  if (currentName === oldName) setCurrentName(newName);
  refreshRail();
  transport.setStatus(`renamed "${oldName}" → "${newName}"`);
}

const leftRail = mountLeftRail({
  container: leftRailContainer,
  patterns,
  folders: indexAtBoot.folders ?? [],
  groupedUserPatterns: groupedAtBoot,
  collapsedFolders: collapsedFoldersAtBoot,
  dirtySet: computeDirtySet(patternNames, patterns, store),
  currentName: currentName,
  onSelect(name) {
    // Open-or-focus through the tab controller: lossless per-tab EditorState
    // swap. flush + error-clear + setCurrentName + lastOpen persistence all
    // happen inside the controller's focus()/installState path now. (`tabs` is
    // defined later in this file; this closure only runs on user interaction,
    // after boot, so it resolves fine.)
    tabs.openOrFocus(name);
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
      formModal,
      folders: store.getIndex().folders ?? [],
      lastNewPatternFolder:
        store.getIndex().uiState?.lastNewPatternFolder ?? null,
      onLastNewPatternFolderChange(folder) {
        const idx = store.getIndex();
        idx.uiState = {
          ...(idx.uiState ?? {}),
          lastNewPatternFolder: folder,
        };
        store.setIndex(idx);
      },
      openPattern: (name) => tabs.openOrFocus(name),
    });
  },
  onCreateFolder() {
    promptCreateFolder();
  },
  onDuplicate(sourceName, preselectedFolder) {
    handleDuplicateClick({
      sourceName,
      preselectedFolder,
      store,
      patterns,
      editor,
      leftRail,
      transport,
      setCurrentName,
      flushToStore,
      formModal,
      folders: store.getIndex().folders ?? [],
      openPattern: (name) => tabs.openOrFocus(name),
    });
  },
  onBulkDuplicate(names) {
    handleBulkDuplicateClick({
      sourceNames: names,
      store,
      patterns,
      editor,
      leftRail,
      transport,
      setCurrentName,
      flushToStore,
      formModal,
      folders: store.getIndex().folders ?? [],
      openPattern: (name) => tabs.openOrFocus(name),
    });
  },
  onImportMidi() {
    openMidiImportDialog();
  },
  onRevert(name) {
    store.delete(name); // working copy gone → codeFor(name) now returns the original
    lastDirtyState.delete(name);
    if (tabs.getOpenItems().includes(name)) {
      if (tabs.getActiveItem() === name) {
        clearError(editor.editor);
        evalFeedback?.resetRuntimeErrors();
        tabs.refresh(name); // fresh EditorState from the reverted (original) code, empty undo
      } else {
        tabs.evictState(name); // rebuilt fresh on next focus
      }
    } else if (currentName === name) {
      clearError(editor.editor);
      evalFeedback?.resetRuntimeErrors();
      editor.setCode(patterns[name]);
    }
    refreshRail();
    transport.setStatus(`reverted "${name}" to original`);
  },
  onDelete(name) {
    store.delete(name);
    const idx = store.getIndex();
    idx.userPatterns = idx.userPatterns.filter((n) => n !== name);
    store.setIndex(idx);
    // Reconcile the open set: closing focuses a neighbor (or the empty state)
    // and persists activeTab/lastOpen. If it was the playing tab, audio
    // continues (orphaned) per spec — Stop clears it.
    if (tabs.getOpenItems().includes(name)) tabs.close(name);
    refreshRail();
    transport.setStatus(`deleted "${name}"`);
  },
  onCollapseChange(folderKey, isCol) {
    persistCollapse(folderKey, isCol);
  },
  onRenameFolder(oldName, newName) {
    renameFolderHandler(oldName, newName);
  },
  onDeleteFolder(name) {
    deleteFolderHandler(name);
  },
  onMoveTo(names, target) {
    moveMany(names, target);
  },
  onBulkMove(names, target) {
    moveMany(names, target);
  },
  onBulkDelete(names) {
    deleteMany(names);
  },
  onRenamePattern(oldName, newName) {
    renamePatternHandler(oldName, newName);
  },
});

// ─── Transport bar ───────────────────────────────────────────────────────
transport = mountTransport({
  getScheduler: () => editor?.repl?.scheduler ?? null,
  getAudioContext,
  rootEl: shellEl,
  editor,
  onEvaluate: () => editor.evaluate(),
  onPlaybackStateChange: (s) => {
    bottomModes.setPlaybackState(s);
    beatGrid?.setPlaybackState(s);
    // Stop (or scheduler idle) releases playing-ownership. Audio that's merely
    // orphaned (playing tab closed, still sounding) keeps the scheduler NON-idle,
    // so this won't fire and the orphan persists until Stop — exactly the spec.
    if (s === "idle") {
      tabs?.clearPlaying();
      refreshNowPlaying();
    }
  },
  onNowPlayingClick: () => {
    const target = tabs.getOrphanedPlaying() ?? tabs.getPlayingItem();
    if (target) tabs.openOrFocus(target); // reopens an orphan, or focuses the playing tab
    refreshNowPlaying();
  },
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
  onBankChipClick: (name) => {
    rightRail.activate("sounds");
    const searchInput = document.querySelector(".sound-browser__search-input");
    if (searchInput) {
      searchInput.value = name;
      searchInput.dispatchEvent(new Event("input"));
    }
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
  onDirtyChange: () => tabStrip?.render(),
});

editor.editor.dispatch({
  effects: StateEffect.appendConfig.of([
    EditorView.updateListener.of((update) => {
      if (update.docChanged) scheduleAutosave();
    }),
  ]),
});

// Bank chip — detect `.bank("name")` calls in the buffer and display the
// last one found in the transport chip. Uses a simple regex on doc-change
// rather than the buffer-context plugin to avoid coupling to its debounce.
// "Last in source order" is close enough to "most recently edited" for the
// common single-bank pattern; tracking per-bank edit recency isn't worth it.
const BANK_DETECT_RE = /\bbank\(\s*['"]([^'"]+)['"]/g;
let bankUpdateTimer = null;
editor.editor.dispatch({
  effects: StateEffect.appendConfig.of([
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (bankUpdateTimer) clearTimeout(bankUpdateTimer);
      bankUpdateTimer = setTimeout(() => {
        bankUpdateTimer = null;
        const text = update.view.state.doc.toString();
        BANK_DETECT_RE.lastIndex = 0;
        let m, last = null;
        while ((m = BANK_DETECT_RE.exec(text)) !== null) last = m[1];
        transport?.setBank(last ?? null);
      }, 200);
    }),
  ]),
});

// ─── Doc-change fan-out for the bottom bars ──────────────────────────────
// The single doc-change signal the track bar, arrange bar and beat grid all
// render from. Installed HERE — before `cleanBaseState` is captured below — so
// it lands in the config every per-tab EditorState inherits. The mounts
// subscribe much later (they're built at the bottom of this file); subscribing
// is a plain closure push, so it reaches every tab no matter when it happens.
//
// Do NOT go back to a per-mount `StateEffect.appendConfig` listener: anything
// appended after the capture below is invisible to every fresh tab. That was
// BUG-2 in design/work/27, and doc-sync.js's header documents it in full.
const docSync = createDocSync();
editor.editor.dispatch({
  effects: StateEffect.appendConfig.of([docSync.extension]),
});

// ─── Pattern tabs: playing-ownership helpers ─────────────────────────────
// refreshNowPlaying is a hoisted function so it can be called from
// onPlaybackStateChange (which fires synchronously at transport mount, before
// the controller is assigned). The `if (!tabs)` guard makes those early calls
// safe no-ops.
function refreshNowPlaying() {
  if (!tabs) return;
  const playing = tabs.getPlayingItem();
  const orphan = tabs.getOrphanedPlaying();
  const active = tabs.getActiveItem();
  if (orphan) {
    transport.setNowPlaying({ name: orphan, isFocused: false, isOrphan: true });
  } else if (playing) {
    transport.setNowPlaying({ name: playing, isFocused: playing === active, isOrphan: false });
  } else {
    transport.setNowPlaying(null);
  }
  tabStrip?.render(); // playing marker on the owning tab
}

// Toggle the editor empty state. The open-set controller allows an empty set
// (closing the last tab); when that happens it relabels the wordmark and
// repaints the strip but deliberately leaves the live CodeMirror buffer alone
// (src/tabs.js close→empty path). Without this the editor would keep showing
// the just-closed pattern's code while the strip says nothing's open. We don't
// clear the buffer — instead .editor-pane.is-empty reveals an overlay over
// #editor, sidestepping any autosave-to-a-null-name concern. Hides again the
// moment any pattern is opened (the open-or-focus swap installs its content).
function updateEmptyState() {
  if (!tabs) return;
  editorPane?.classList.toggle("is-empty", tabs.getActiveItem() == null);
}

// ─── Pattern tabs: open-set controller + per-tab EditorState swap ──────────
// Tabs are a view over the store (spec 26). Switching swaps a cached EditorState
// on the single view, preserving each tab's cursor/selection/scroll/undo.

// A tab "snapshot" is { state, scrollTop, scrollLeft } — EditorState carries
// doc/selection/undo, but NOT scroll (that lives on the view's scrollDOM), so
// we capture/restore scroll alongside the state.
// Captured ONCE here, at the controller block — after the editor is fully
// configured (dispatchEditorExtensions + installCompletions + the appended
// updateListeners, including docSync above) and before any user edit, so it has
// the full config with an EMPTY undo history. EditorStates are immutable, so
// this stays a clean base for every fresh tab; freshTabState reconfigures it to
// the current live compartment values at build time.
//
// INVARIANT: nothing below this line may add to the editor's config. A
// `StateEffect.appendConfig` dispatched after this point exists only in the
// tab that was live at the time and is silently dead in every other one
// (design/work/27 BUG-2). Views that need to react to the buffer subscribe to
// `docSync` instead — that list is a closure, not CodeMirror config.
const cleanBaseState = editor.editor.state;
function buildTabState({ code }) {
  return {
    state: freshTabState(
      cleanBaseState,
      code,
      liveCompartmentValues(editor.editor.state, strasbeatOverlayCompartment),
    ),
    scrollTop: 0,
    scrollLeft: 0,
  };
}
function captureTabState() {
  const scroller = editor.editor.scrollDOM;
  return {
    state: editor.editor.state, // owns this tab's history/cursor/selection
    scrollTop: scroller?.scrollTop ?? 0,
    scrollLeft: scroller?.scrollLeft ?? 0,
  };
}
function installTabState(snap) {
  editor.editor.setState(snap.state);
  // CRITICAL: setState does NOT fire updateListeners, so StrudelMirror's
  // onChange (which sets editor.code + repl.setCode) won't run. Sync explicitly
  // or evaluate() would play the previous tab's buffer.
  editor.code = editor.editor.state.doc.toString();
  editor.repl.setCode?.(editor.code);
  // Same reason: the bottom bars are driven by docSync, whose updateListener
  // setState skips. Without this the track bar keeps showing the OUTGOING tab's
  // tracks and its buttons act on names the new buffer may not have — a dead
  // no-op at best, the wrong track at worst (design/work/27 BUG-2). `immediate`
  // because the repaint has to beat the user's next click, not wait a frame.
  docSync.notify({ immediate: true });
  // Restore scroll after the new state lays out (setState resets it).
  const scroller = editor.editor.scrollDOM;
  if (scroller) {
    requestAnimationFrame(() => {
      scroller.scrollTop = snap.scrollTop ?? 0;
      scroller.scrollLeft = snap.scrollLeft ?? 0;
    });
  }
}

tabs = createTabController({
  store,
  patterns,
  buildState: buildTabState,
  installState: (snap) => {
    installTabState(snap);
    // Error/console state is global + keyed to the live buffer (spec: per-tab
    // errors are out of scope). Clear on every swap, matching the old onSelect.
    clearError(editor.editor);
    evalFeedback?.resetRuntimeErrors();
  },
  captureState: captureTabState,
  flushToStore,
  setCurrentName,
  onAfterSwitch: () => {
    refreshNowPlaying();
    updateEmptyState();
  },
});
tabs.hydrate();
// The editor was constructed showing `initialName`'s code; make it the focused
// tab (no swap). adoptInitial handles share-link / fallback / empty-set boots.
tabs.adoptInitial(initialName);

tabStrip = mountTabStrip({
  container: document.getElementById("tab-strip"),
  getOpenItems: () => tabs.getOpenItems(),
  getActiveItem: () => tabs.getActiveItem(),
  getPlayingItem: () => tabs.getPlayingItem(),
  getDirtySet: () => computeDirtySet(patternNames, patterns, store),
  isUser: (name) => !(name in patterns),
  onFocus: (name) => tabs.openOrFocus(name),
  onClose: (name) => tabs.close(name),
  onReorder: (name, toIndex) => tabs.reorder(name, toIndex),
});
refreshNowPlaying(); // initial state: nothing playing → chip hidden
updateEmptyState(); // initial state: overlay shows only if the open set is empty

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
    openPattern: (name) => tabs.openOrFocus(name),
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

// ─── Sound-browser drag-and-drop on the editor surface ───────────────────
// Handles drags initiated from the sound browser panel. The MIDI listeners
// above handle "Files" types; these handle the custom MIME type set by the
// sound browser's dragstart handler. A single drag event carries only one.
editorRoot.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("text/x-strasbeat-sound")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
});
editorRoot.addEventListener("drop", (e) => {
  const name = e.dataTransfer?.getData("text/x-strasbeat-sound");
  if (!name) return;
  e.preventDefault();
  e.stopPropagation();
  insertSoundName(name, editor.editor);
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
  openPattern: (name) => tabs.openOrFocus(name),
  focusEditorLocation,
  refreshRail,
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

// Tab playing-ownership: an autostart evaluate transfers scheduler ownership to
// the focused tab. ALL play paths funnel through editor.evaluate() (the play
// toggle, Cmd/Ctrl+Enter via the keymap, repl-evaluate, the palette), so wrapping
// it here is the single chokepoint that makes acceptance #4/#5 deterministic
// (including transferring ownership via Cmd+Enter while another tab plays — no
// reliance on playback-state transitions). Wrapped AFTER eval-feedback's patch so
// we compose with its tracking. The WAV export renders with evaluate(false); that
// must NOT grab ownership — hence the autostart guard. Releasing happens on idle
// (Stop), handled in onPlaybackStateChange above.
const _evaluateForTabs = editor.evaluate.bind(editor);
editor.evaluate = async function (...args) {
  const autostart = args.length === 0 || args[0] !== false;
  const result = await _evaluateForTabs(...args);
  if (autostart && tabs) {
    tabs.setPlaying(tabs.getActiveItem());
    refreshNowPlaying();
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

// Strudel's vim/emacs/helix integrations dispatch these custom DOM events
// instead of running CM commands directly — the host wires them to
// whatever the app considers "evaluate" / "stop" / "toggle comment".
// See node_modules/@strudel/codemirror/keybindings.mjs (Vim.defineEx
// blocks). Harmless when the active profile is Strudel/VSCode (no event
// ever fires); load-bearing in modal profiles.
document.addEventListener("repl-evaluate", () => editor.evaluate());
document.addEventListener("repl-stop", () => editor.stop());
document.addEventListener("repl-toggle-comment", () => {
  editor.editor.focus();
  toggleComment(editor.editor);
});

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
    onNextTab: () => {
      const open = tabs.getOpenItems();
      const a = tabs.getActiveItem();
      if (open.length < 2) return;
      const i = open.indexOf(a);
      tabs.openOrFocus(open[(i + 1) % open.length]);
    },
    onPrevTab: () => {
      const open = tabs.getOpenItems();
      const a = tabs.getActiveItem();
      if (open.length < 2) return;
      const i = open.indexOf(a);
      tabs.openOrFocus(open[(i - 1 + open.length) % open.length]);
    },
    onCloseActiveTab: () => {
      const a = tabs.getActiveItem();
      if (a) tabs.close(a);
    },
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
  docSync,
  onEvaluate: () => editor.evaluate(),
});
mountArrangeBar({
  container: document.getElementById("arrange-bar"),
  view: editor.editor,
  docSync,
  getScheduler: () => editor?.repl?.scheduler ?? null,
  onEvaluate: () => editor.evaluate(),
});

// ─── Beat grid (bottom-panel "Beat grid" mode) ───────────────────────────
// Mounts as a flex sibling of the #roll canvas inside .roll-pane, hidden
// by default. When shown, CSS hides the canvas (display:none) so the grid
// claims the canvas's flex slot — the divider at the top of the pane
// remains the single resize handle for all three views.
// Visibility follows two signals:
//   1. parser: any `$:` drum lane in the buffer → tab available
//   2. mode  : user picked "beats" → DOM shown, canvas paint skipped
// See design/work/19-beat-grid.md.
beatGrid = mountBeatGrid({
  container: canvas.parentElement,
  view: editor.editor,
  docSync,
  onLanesChange: (count) => bottomModes.setBeatsAvailable(count > 0),
  getSoundMap: () => soundMap.get(),
  // Playhead sweep reads editor.repl.scheduler.now() each frame — same
  // hook arrange-bar and transport use. Guarded against a missing REPL.
  getScheduler: () => editor?.repl?.scheduler ?? null,
  // Fire a one-shot audition when the user turns on a cell / picks a
  // variant. Mirrors the sound-browser preview: tuned envelope + passed
  // bank so variant-N from a Roland kit actually plays that kit's N.
  onPreview: (name, opts = {}) => previewDrumCell(name, opts),
  // Auto-replay after any grid edit so changes are immediately audible
  // during playback — same mechanism track-bar's mute/solo uses.
  onEvaluate: () => editor.evaluate(),
});
async function previewDrumCell(name, { bank, variant } = {}) {
  const audioCtx = getAudioContext();
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {}
  }
  if (audioCtx.state !== "running") return;
  const value = {
    s: name,
    note: 60,
    gain: 0.7,
    attack: 0.002,
    decay: 0.35,
    sustain: 0,
    release: 0.25,
  };
  if (bank) value.bank = bank;
  if (variant != null) value.n = variant;
  Promise.resolve(
    superdough(value, audioCtx.currentTime + 0.01, 0.4),
  ).catch((err) =>
    console.warn(`[beat-grid] preview "${name}" failed:`, err),
  );
}
bottomModes.setBeatsAvailable(beatGrid.getLaneCount() > 0);
bottomModes.setOnChange((mode) => {
  const isBeats = mode === "beats";
  shellEl.classList.toggle("shell--beat-grid", isBeats);
  if (isBeats) beatGrid.show();
  else beatGrid.hide();
});

// ─── Transport ───────────────────────────────────────────────────────────
// One button, two jobs. The visible state lives on the transport element's
// `data-transport-state` (kept in lockstep with the scheduler by transport.js),
// so reading it here is the authoritative "is the engine live?" check — no
// separate flag to drift out of sync. Idle → play; anything else → stop.
playBtn.addEventListener("click", async () => {
  if (isExportRunning()) {
    transport.setStatus("Export in progress");
    return;
  }
  if ((transportEl.dataset.transportState ?? "idle") !== "idle") {
    editor.stop();
    return;
  }
  await editor.evaluate();
  transport.kick(); // promote the readout loop to rAF immediately
});

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
    // Disk is now canonical — promote to Demo: drop the store record, and
    // drop the user-pattern tracking too (otherwise the rail keeps a ghost
    // entry in idx.userPatterns after HMR reloads). The pattern will
    // re-appear as a Demo via import.meta.glob.
    store.delete(name);
    const idx = store.getIndex();
    if (idx.userPatterns?.includes(name)) {
      idx.userPatterns = idx.userPatterns.filter((n) => n !== name);
      store.setIndex(idx);
    }
    leftRail.removeUserPattern(name);
    leftRail.updateDirtySet(computeDirtySet(patternNames, patterns, store));
    tabStrip?.render();
    status.textContent = `saved → ${path}`;
    // Vite HMR will pick up the new file and re-fire the glob below.
  });
}

// Share flow is async (gzip + base64 + clipboard write). Guard against
// double-clicks while in flight, and flash the button on resolve so the
// user has a visual confirmation at the cursor — the status text in the
// transport bar is the secondary, aria-live channel.
let sharing = false;
shareBtn.addEventListener("click", async () => {
  if (sharing) return;
  sharing = true;
  shareBtn.setAttribute("aria-busy", "true");
  shareBtn.disabled = true;
  let ok = false;
  try {
    ok = await shareCurrent({
      getCode: () => editor.code ?? "",
      getName: () => currentName,
      setStatus: (s) => {
        status.textContent = s;
      },
    });
  } finally {
    sharing = false;
    shareBtn.disabled = false;
    shareBtn.removeAttribute("aria-busy");
    const flash = ok ? "is-flash-ok" : "is-flash-err";
    shareBtn.classList.add(flash);
    setTimeout(() => shareBtn.classList.remove(flash), 700);
  }
});

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
    openPattern: (name) => tabs.openOrFocus(name),
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
      store,
      patterns,
      editor,
      leftRail,
      transport,
      setCurrentName,
      flushToStore,
      formModal,
      folders: store.getIndex().folders ?? [],
      lastNewPatternFolder:
        store.getIndex().uiState?.lastNewPatternFolder ?? null,
      onLastNewPatternFolderChange(folder) {
        const idx = store.getIndex();
        idx.uiState = {
          ...(idx.uiState ?? {}),
          lastNewPatternFolder: folder,
        };
        store.setIndex(idx);
      },
      openPattern: (name) => tabs.openOrFocus(name),
    });
  } else if (action === "export") {
    exportBtn?.click();
  }
});
