// MUST stay the first import: it makes localStorage safe to touch before any
// other module (ours or Strudel's) evaluates. See src/storage-guard.js.
import { storageIsEphemeral } from "./storage-guard.js";
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
import {
  setShaderErrorSink,
  _getShaderNode,
  _getDeriver,
} from "./strudel-ext/shader.js";
// App-internal visuals plumbing (kept out of the pattern-global barrel, same
// as the shader internals above): the lifecycle shared by the Hydra and shader
// layers.
import {
  getVisualCanvases,
  setVisualsChangeCallback,
  setVisualsVisible,
  syncVisualsToRepl,
} from "./strudel-ext/visuals-host.js";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MidiBridge } from "./midi-bridge.js";
import { mountMidiBar, wireMidiPill } from "./ui/midi-bar.js";
import { installCompletions } from "./editor/completions/install.js";
import {
  clearError,
  extractErrorLine,
  setError,
} from "./editor/error-marks.js";
import strudelDocs from "./editor/strudel-docs.json" with { type: "json" };
import { hydrateIcons } from "./ui/icons.js";
import { mount as mountLeftRail } from "./ui/left-rail.js";
import { mountTransport } from "./ui/transport.js";
import { mountRightRail } from "./ui/right-rail.js";
import { registerPanels } from "./panels.js";
import { createBottomCanvas } from "./ui/bottom-canvas.js";
import { createScope } from "./ui/scope.js";
import { mountScopeControls } from "./ui/scope-controls.js";
import { createBottomPanelModes } from "./ui/bottom-panel-modes.js";
import { mountBeatGrid } from "./ui/beat-grid.js";
import { mountTrackBar } from "./ui/track-bar.js";
import { mountArrangeBar } from "./ui/arrange-bar.js";
import { prompt, confirm, formModal, choiceModal } from "./ui/modal.js";
import { applyStoredAccent } from "./ui/settings-drawer.js";
import { createLocalStore, describeStorageEvent } from "./store.js";
import { mountStorageNotice } from "./ui/storage-notice.js";
import { readSharedFromHash, shareCurrent, adoptSharedPattern } from "./share.js";
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
  resolveWorkingCopy,
  reconcileStoredPatterns,
  handleExternalStoreChange,
} from "./patterns.js";
import { showMidiImportDialog, getMidiFile } from "./ui/midi-import-dialog.js";
import {
  readStoredCmSettingsFromLocalStorage,
  applyInitialSettings,
  dispatchEditorExtensions,
  editorClaimsCtrlB,
  strasbeatOverlayCompartment,
} from "./editor-setup.js";
import { createTabController } from "./tabs.js";
import { freshTabState, liveCompartmentValues, syncTabState } from "./editor/build-editor-state.js";
import { createDocSync } from "./editor/doc-sync.js";
import { readSelectedCompletion } from "./editor/keymap-universal.js";
import { previewSoundName, insertSoundName } from "./editor-actions.js";
import { installDefaultStrudelLogger } from "./strudel-logger.js";
import { installEvalFeedback } from "./eval-feedback.js";
import { shouldClaimPlayback } from "./eval-state.js";
import { clearSolo as clearArrangeSolo } from "./strudel-ext/arrange.js";
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

// Does a pattern's whole-tune source transpile? Mirrors how the editor
// evaluates a pattern (top-level await is wrapped). Used by the working-copy
// auto-heal so a broken cached Demo copy can fall back to its disk original.
function canTranspilePattern(code) {
  if (typeof code !== "string") return false;
  try {
    transpiler(code, { wrapAsync: true, addReturn: true });
    return true;
  } catch {
    return false;
  }
}

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

// The bottom canvas (piano roll / scope / Strudel draw functions). Sizing,
// HiDPI and the "paint only what can be seen" rule live in
// ui/bottom-canvas.js; it is created further down, once the editor exists.
let bottomCanvas = null;
const resizeCanvas = () => bottomCanvas?.refresh();
const drawTime = [-2, 2]; // cycles before / after now to render
// Phase 2 shader uniforms: wall-clock timestamp (ms) of the previous onDraw,
// used to derive the per-frame dt the decay envelope needs. null until the
// first frame.
let lastDrawMs = null;

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

// ─── Visuals (Hydra / shader) placement ──────────────────────────────────
// Each visual layer owns a full-viewport, fixed canvas (.visuals-canvas, see
// strudel-ext/visuals-host.js). This block decides where those canvases show:
//   - Visuals bottom-panel mode → clipped to the .roll-pane rect, so they only
//     paint through the bottom panel, not over the editor;
//   - full-window mode → un-clipped, behind the transparent editor;
//   - otherwise hidden.
// It also reports "is anything on screen" back to the host, which is what
// gates the render loops: a hidden canvas never renders a frame.
//
// Re-synced on: a layer appearing/disappearing, a bottom-panel mode change,
// the full-window toggle, window resize, and — via a ResizeObserver on the
// roll pane — every size change of the pane, including each frame of its
// collapse/expand transition and a divider drag. Reading the rect right after
// flipping the collapse class would only see the transition's starting
// geometry.
const rollPaneEl = document.getElementById("roll-pane");
const FULLWINDOW_KEY = "strasbeat:visuals-fullwindow";
let visualsFullWindow = localStorage.getItem(FULLWINDOW_KEY) === "true";

function syncVisualsLayout() {
  const rect = rollPaneEl.getBoundingClientRect();
  const inPanel =
    bottomModes.getMode() === "visuals" && rect.height > 1 && rect.width > 1;
  // Full-window wins over the panel clip.
  const placement = visualsFullWindow
    ? "fullwindow"
    : inPanel
      ? "clipped"
      : null;
  for (const cv of getVisualCanvases()) {
    cv.classList.toggle("is-visuals-fullwindow", placement === "fullwindow");
    cv.classList.toggle("is-visuals-clipped", placement === "clipped");
    if (placement !== "clipped") continue;
    cv.style.setProperty("--visuals-clip-top", `${rect.top}px`);
    cv.style.setProperty(
      "--visuals-clip-right",
      `${window.innerWidth - rect.right}px`,
    );
    cv.style.setProperty(
      "--visuals-clip-bottom",
      `${window.innerHeight - rect.bottom}px`,
    );
    cv.style.setProperty("--visuals-clip-left", `${rect.left}px`);
  }
  setVisualsVisible(placement !== null);
}

// Visual layers → bottom-panel Visuals mode gating + placement of a freshly
// created canvas. Called on every layer init (true) / teardown (false).
setVisualsChangeCallback((available) => {
  bottomModes.setVisualsAvailable(available);
  syncVisualsLayout();
});

// Re-sync when the user switches bottom-panel modes.
bottomModes.setOnChange(() => syncVisualsLayout());

new ResizeObserver(() => syncVisualsLayout()).observe(rollPaneEl);

// Debounced window-resize re-sync (matches existing canvas-resize cadence).
let visualsResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(visualsResizeTimer);
  visualsResizeTimer = setTimeout(syncVisualsLayout, 200);
});

// ─── Editor ──────────────────────────────────────────────────────────────
// Boot sequence: share link > store lastOpen > first shipped pattern.
const shared = await readSharedFromHash();
// Re-list stored patterns the library lost track of, before anything reads
// the index.
reconcileStoredPatterns({ store, patterns });
// A share link lands as a real, indexed user pattern under a name of its own
// (never on top of an existing record), and the hash is then dropped from the
// URL — so a reload resumes the recipient's working copy from the store
// instead of re-applying the original snapshot over their edits.
const sharedArrival = shared
  ? adoptSharedPattern({ shared, store, patterns })
  : null;
const storeIndex = store.getIndex();
const fallbackName = patternNames[0] ?? "empty";

let initialName, initialCode;
if (sharedArrival) {
  initialName = sharedArrival.name;
  initialCode = sharedArrival.code;
} else if (storeIndex.lastOpen) {
  initialName = storeIndex.lastOpen;
  // resolveWorkingCopy heals the stale-broken-cache class: if lastOpen is a
  // shipped Demo whose working copy no longer transpiles (e.g. an old broken
  // shader copy shadowing a fixed 05-shader-demo.js), it drops the copy and
  // falls back to the disk original — so a non-compiling cache can't strand
  // boot on the very pattern the user left open. User patterns and healthy
  // edits are returned untouched.
  const { code } = resolveWorkingCopy({
    name: initialName,
    patterns,
    store,
    canTranspile: canTranspilePattern,
  });
  if (code != null) initialCode = code;
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
const { bootPromise, getBootReady, getBootFailures, prebake } = createBoot({
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
  // Visuals exist iff the evaluated code asked for them and the scheduler is
  // running. The repl reports every start/stop and both ends of every
  // evaluate here, so this one hook covers all play/stop/evaluate paths.
  onUpdateState: syncVisualsToRepl,
  onDraw: (haps, time) => {
    // Phase 2: drive the shader node's uniforms from the haps the playhead
    // (`time`, in cycles) just reached. dt is wall-clock seconds between
    // draws, so the pulse decay is the same length at any tempo. This runs
    // every frame regardless of the bottom-panel mode — the shader paints its
    // own canvas, so the feed never depends on what the bottom canvas shows.
    const shaderNode = _getShaderNode?.();
    if (shaderNode?.hasProgram?.()) {
      const _deriver = _getDeriver?.();
      const nowMs = performance.now();
      const dt = lastDrawMs == null ? 0.016 : (nowMs - lastDrawMs) / 1000;
      lastDrawMs = nowMs;
      if (_deriver) shaderNode.setUniformMap(_deriver.frame(haps, time, dt));
    }
    // Roll / scope / the pattern's own draw functions — or nothing at all
    // when the canvas is collapsed, covered or in a background tab.
    bottomCanvas?.draw(haps, time);
  },
  prebake,
});

// ─── Phase 1.5 — full-window visuals behind the editor ───────────────────
// A toggle (NOT in the share codec — spec §"Phase 1.5") that un-clips the
// visuals canvases to full-viewport and makes the editor transparent so
// visuals show through. The per-line .cm-line>* plates (Task 3) keep code
// legible. Persisted to localStorage only (read in the placement block above).
//
// Layering (visuals.css): the full-window canvas sits BELOW the whole shell
// (z-index:-1), so the opaque chrome — top bar, rails, transport, bottom
// panel — covers it and only the editor region lets it through. That takes
// three surfaces out of the way:
//   - .editor-pane's background, via .shell--visuals-fullwindow (CSS);
//   - #editor's inline background: StrudelMirror's constructor sets
//     editorRoot.style.backgroundColor = 'var(--background)' (bgFill:true), so
//     we override that same inline style here and restore the exact value when
//     OFF. No !important, no updateSettings (bgFill is constructor-only);
//   - .cm-gutters, via the #editor.is-visuals-fullwindow class (CSS).
// The .cm-editor background is already 'transparent' (StrudelMirror always
// does that).
function applyVisualsFullWindow() {
  editorRoot.style.backgroundColor = visualsFullWindow
    ? "transparent"
    : "var(--background)";
  editorRoot.classList.toggle("is-visuals-fullwindow", visualsFullWindow);
  shellEl.classList.toggle("shell--visuals-fullwindow", visualsFullWindow);
  // Canvas classes + render gate. Canvases created later (the next play) are
  // placed by the same call from the layer-change callback.
  syncVisualsLayout();
}

function toggleVisualsFullWindow() {
  visualsFullWindow = !visualsFullWindow;
  localStorage.setItem(FULLWINDOW_KEY, String(visualsFullWindow));
  applyVisualsFullWindow();
}

// Apply persisted state once now that editorRoot and shellEl exist.
applyVisualsFullWindow();

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

bottomCanvas = createBottomCanvas({
  canvas,
  modes: bottomModes,
  scope,
  drawTime,
  getView: () => editor.editor,
  isPlaying: () => !!editor.repl?.scheduler?.started,
  // A note in the roll belongs to the pattern that is playing, which may sit
  // in another tab (or a closed one): bring it into the editor before the
  // click moves the cursor.
  beforeLocate: () => {
    const playing = tabs?.getOrphanedPlaying() ?? tabs?.getPlayingItem();
    if (playing && playing !== tabs.getActiveItem()) tabs.openOrFocus(playing);
  },
  isPlayingDocFocused: () => {
    const playing = tabs?.getOrphanedPlaying() ?? tabs?.getPlayingItem();
    return playing == null || playing === tabs.getActiveItem();
  },
});

// The Drawer's window. It keeps — and re-filters on every frame — each hap
// inside `drawTime`, so the window is the roll's full four cycles only while
// something shows them: the roll itself, or draw functions the pattern
// registered. Otherwise it shrinks to the present moment, which is all that
// highlighting and the shader uniforms read, and what upstream uses for any
// pattern without painters. (Upstream picks the window after every evaluate
// through setDrawTime; that call is intercepted here.)
const NOW_ONLY = [0, 0];
const _setDrawTime = editor.drawer.setDrawTime.bind(editor.drawer);
const _invalidate = editor.drawer.invalidate.bind(editor.drawer);
let paintersWantWindow = false;
// Returns whether the window changed.
function applyDrawWindow(wide) {
  const current = editor.drawer.drawTime;
  const wasWide = current[0] !== 0 || current[1] !== 0;
  if (wasWide === wide) return false;
  _setDrawTime(wide ? drawTime : NOW_ONLY);
  // The Drawer queries from its previous frame's right edge to the new one.
  // After shrinking, that edge lies in the future; make the next frame
  // re-anchor instead of querying backwards. After widening it lies behind
  // the stretch the invalidate that follows is about to queue; move it to
  // where a Drawer that had been wide all along would have it, or the next
  // frame queues the end of that stretch a second time.
  if (!wide) {
    editor.drawer.lastFrame = null;
  } else if (editor.drawer.lastFrame != null) {
    const sched = editor.repl?.scheduler;
    if (sched?.started) editor.drawer.lastFrame = sched.now() + drawTime[1];
  }
  return true;
}
editor.drawer.setDrawTime = (dt) => {
  // Upstream passes [0, 0] unless the evaluated pattern has painters.
  paintersWantWindow = Array.isArray(dt) && (dt[0] !== 0 || dt[1] !== 0);
  applyDrawWindow(paintersWantWindow || bottomCanvas.wantsHapWindow());
};
// Every evaluate (and the boot-time first frame) ends in an invalidate: the
// one moment the pattern's painters and the code its haps point into are
// both known. `refill` is for the invalidates below, which only query the
// pattern on show again.
function invalidateDrawer(scheduler, t, refill) {
  _invalidate(scheduler, t);
  bottomCanvas.afterInvalidate({
    code: editor.repl.state.activeCode,
    painters: editor.drawer.painters,
    haps: editor.drawer.visibleHaps,
    time: t ?? editor.drawer.scheduler?.now?.() ?? 0,
    refill,
  });
}
editor.drawer.invalidate = (scheduler, t) => invalidateDrawer(scheduler, t, false);
// The roll came into view or went out of it (pane collapse, mode switch).
bottomCanvas.setOnHapDemandChange((wide) => {
  if (!applyDrawWindow(wide || paintersWantWindow)) return;
  const sched = editor.repl?.scheduler;
  if (!sched?.pattern) return;
  if (!wide) {
    // Drop the haps queued beyond the narrower window.
    if (sched.started) invalidateDrawer(sched, undefined, true);
    return;
  }
  // Stopped with nothing on the roll (the tab was switched): leave it empty.
  if (!sched.started && !bottomCanvas.hasFrame()) return;
  // Refill the window around the playhead (or, while stopped, around the
  // frame the roll last showed) so the roll does not come back half empty.
  const t = sched.started ? sched.now() : bottomCanvas.getLastTime();
  try {
    editor.drawer.visibleHaps =
      t > 0
        ? sched.pattern
            .queryArc(Math.max(0, t + drawTime[0]), t)
            .filter((hap) => hap.hasOnset())
        : [];
    invalidateDrawer(sched, t, true);
    bottomCanvas.draw(editor.drawer.visibleHaps, t);
  } catch (err) {
    console.warn("[strasbeat] could not refill the piano roll:", err);
  }
});


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
  // Format outcomes the user should see (syntax error, result dropped).
  onStatus: (s) => transport?.setStatus(s),
  // Live edits (numeric scrubbing) only re-evaluate the buffer that is
  // actually playing. `tabs` is assigned further down; read lazily. The
  // caller has already checked that the scheduler runs, so "no owner
  // recorded and nothing orphaned" is a play that has started but not been
  // credited to its tab yet (ownership is claimed once the evaluate
  // resolves) — that is the focused tab too.
  isFocusedTabPlaying: () => {
    if (!tabs) return true;
    if (tabs.getOrphanedPlaying() != null) return false;
    const playing = tabs.getPlayingItem();
    return playing == null || playing === tabs.getActiveItem();
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
      if (tabs.getOpenItems().includes(name)) tabs.close(name, { flush: false });
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
    if (tabs.getOpenItems().includes(n)) tabs.close(n, { flush: false });
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
  renamePending(oldName, newName);
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
    if (tabs.getOpenItems().includes(name)) tabs.close(name, { flush: false });
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
if (sharedArrival) {
  transport.setStatus(
    sharedArrival.saved
      ? `opened shared pattern as "${sharedArrival.name}"`
      : "\u26a0 couldn\u2019t save the shared pattern \u2014 keep the link",
  );
} else if (storeIndex.lastOpen && store.get(storeIndex.lastOpen)) {
  transport.setStatus(`restored your edits to "${storeIndex.lastOpen}"`);
}

// ─── Autosave ────────────────────────────────────────────────────────────
const { flushToStore, scheduleAutosave, hasPending, renamePending } = createAutosave({
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
  // A cached state froze the runtime compartments (theme, keymap profile, line
  // wrapping, …) as they were when its tab was last on screen. Bring it up to
  // the live values first, or a settings change made in one tab silently
  // reverts in every other. Doc, selection and undo history are untouched.
  editor.editor.setState(
    syncTabState(
      snap.state,
      liveCompartmentValues(editor.editor.state, strasbeatOverlayCompartment),
    ),
  );
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
  // Auto-heal a broken cached Demo copy on tab open: if a shipped pattern's
  // working copy no longer transpiles but the disk original does, drop the copy
  // and use the original (lossless — a non-compiling cache isn't a real edit).
  resolveCode: (name) =>
    resolveWorkingCopy({ name, patterns, store, canTranspile: canTranspilePattern }).code,
  buildState: buildTabState,
  installState: (snap) => {
    installTabState(snap);
    // Error/console state is global + keyed to the live buffer (spec: per-tab
    // errors are out of scope). Clear on every swap, matching the old onSelect.
    clearError(editor.editor);
    evalFeedback?.resetRuntimeErrors();
    // Arrange solo addresses a section by position, so it only means
    // something for the buffer it was set in — don't carry it to another tab.
    clearArrangeSolo();
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
  // A pointer activation hands focus back to the editor; a keyboard one keeps
  // it on the strip so arrow-key navigation continues.
  onFocus: (name, { viaPointer } = {}) => {
    tabs.openOrFocus(name);
    if (viaPointer) editor.editor.focus();
  },
  onClose: (name, { viaPointer } = {}) => {
    tabs.close(name);
    if (viaPointer) editor.editor.focus();
  },
  onReorder: (name, toIndex) => tabs.reorder(name, toIndex),
});
refreshNowPlaying(); // initial state: nothing playing → chip hidden
updateEmptyState(); // initial state: overlay shows only if the open set is empty

window.addEventListener("beforeunload", () => {
  flushToStore();
});
// Mobile browsers discard backgrounded tabs without ever firing beforeunload;
// pagehide / hidden are the last reliable moments to write pending edits.
window.addEventListener("pagehide", () => {
  flushToStore();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushToStore();
});

// Another window on this origin wrote to the store: follow it rather than
// keep a stale buffer that a later flush could write back over newer work.
//
// Handling is deferred a beat: the other window's operations are bursts of
// several writes (record, then index), each delivered as its own event, and
// this window's view of storage only catches up as they arrive. Reacting to
// the first one could read — and, when a tab closes, write back — an index
// that is one step behind.
let externalChanges = [];
let externalChangeTimer = null;
window.addEventListener("storage", (e) => {
  if (e.storageArea !== localStorage) return;
  const change = describeStorageEvent(e);
  if (!change) return;
  externalChanges.push(change);
  clearTimeout(externalChangeTimer);
  externalChangeTimer = setTimeout(() => {
    const batch = externalChanges;
    externalChanges = [];
    for (const c of batch) {
      handleExternalStoreChange(c, {
        tabs,
        patterns,
        store,
        hasPending,
        getActiveCode: () => editor.code,
        // The active tab is the live buffer, so scheduling an autosave is
        // what queues it to be stored again.
        keepLocalEdits: scheduleAutosave,
        canTranspile: canTranspilePattern,
        refreshRail,
        setStatus: (s) => transport.setStatus(s),
      });
    }
  }, 60);
});

// A share link pasted into an already-open strasbeat changes only the
// fragment, so there is no page load to pick it up.
window.addEventListener("hashchange", async () => {
  const again = await readSharedFromHash();
  if (!again) return;
  const arrival = adoptSharedPattern({ shared: again, store, patterns });
  if (!arrival.saved) {
    transport.setStatus(
      "\u26a0 couldn\u2019t save the shared pattern \u2014 browser storage full",
    );
    return;
  }
  refreshRail();
  tabs.openOrFocus(arrival.name);
  transport.setStatus(`opened shared pattern as "${arrival.name}"`);
});

// Save problems stay on screen for as long as they last.
const storageNotice = mountStorageNotice(
  document.querySelector(".top-bar__actions"),
);
if (storageIsEphemeral()) {
  storageNotice.show(
    "Not saving \u2014 browser storage is blocked",
    "This browser is blocking site storage, so patterns and settings only last until the page is closed. Allow site data for this page, or use Share to keep a copy.",
  );
} else {
  store.onWriteStatus(({ failing, quota }) => {
    if (!failing) storageNotice.clear();
    else if (quota) {
      storageNotice.show(
        "Not saving \u2014 browser storage is full",
        "Recent edits are NOT saved. Delete patterns you no longer need, or export your library from Settings, to free space.",
      );
    } else {
      storageNotice.show(
        "Not saving \u2014 browser storage error",
        "Recent edits could not be written to browser storage. See the console for details.",
      );
    }
  });
}

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
  refreshOpenTab: (name) => tabs.refresh(name),
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

// Route raw-WebGL shader compile/link + context-loss errors into the in-app
// console panel (they also always go to console.error). Surface-failures-
// loudly: a broken shader is visible without opening devtools.
setShaderErrorSink((msg) => consolePanel?.error?.(msg));

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
  getEvalOwner: () => tabs?.getActiveItem() ?? null,
  getBootFailures,
});

// Tab playing-ownership: an autostart evaluate transfers scheduler ownership to
// the focused tab. ALL play paths funnel through editor.evaluate() (the play
// toggle, Cmd/Ctrl+Enter via the keymap, repl-evaluate, the palette), so wrapping
// it here is the single chokepoint that makes acceptance #4/#5 deterministic
// (including transferring ownership via Cmd+Enter while another tab plays — no
// reliance on playback-state transitions). Wrapped AFTER eval-feedback's patch so
// we compose with its tracking. The WAV export renders with evaluate(false); that
// must NOT grab ownership — hence the autostart guard. Neither must an evaluate
// that failed, was cancelled or was replaced: it started nothing. The owner is
// the tab whose buffer was actually evaluated (captured by eval-feedback when it
// read the code), not whichever tab has focus once the evaluate settles.
// Releasing happens on idle (Stop), handled in onPlaybackStateChange above.
const _evaluateForTabs = editor.evaluate.bind(editor);
editor.evaluate = async function (...args) {
  const autostart = args.length === 0 || args[0] !== false;
  // Nothing open: the buffer still holds the last-closed pattern behind the
  // empty-state overlay, and playing it would sound code the UI says is gone.
  if (autostart && tabs && tabs.getActiveItem() == null) {
    transport.setStatus("nothing open \u2014 pick a pattern to play");
    return { status: "empty", started: false, owner: null };
  }
  const outcome = await _evaluateForTabs(...args);
  const started = !!editor.repl?.scheduler?.started;
  if (tabs && shouldClaimPlayback({ autostart, outcome, started })) {
    tabs.setPlaying(outcome.owner ?? tabs.getActiveItem());
    refreshNowPlaying();
  }
  return outcome;
};

// Cmd/Ctrl+B toggles the right rail (matches VSCode's sidebar toggle).
document.addEventListener(
  "keydown",
  (e) => {
    // Platform modifier only: on macOS Ctrl+B is cursor-left (natively and
    // in the Emacs profile) and must keep reaching the editor. Elsewhere the
    // platform modifier IS Ctrl, so the Emacs / Vim / Helix profiles keep
    // Ctrl+B for themselves while the editor has the key.
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    if (
      (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === "b" &&
      (isMac || !editorClaimsCtrlB(e.target))
    ) {
      e.preventDefault();
      rightRail.toggle();
    }
  },
  true,
);

// Strudel's vim/emacs/helix integrations dispatch `repl-evaluate`, `repl-stop`
// and `repl-toggle-comment` DOM events instead of running CM commands directly
// (node_modules/@strudel/codemirror/keybindings.mjs, Vim.defineEx blocks).
// StrudelMirror itself listens for all three (codemirror.mjs, end of the
// constructor) and routes them to this.evaluate() / this.stop() — our patched
// versions — and toggleLineComment. Handling them here as well made vim `:w`
// evaluate twice and `gc` toggle the comment twice (i.e. not at all). Nothing
// is left for the host to do: the visuals teardown follows the repl's own
// state (visuals-host.js), whichever path stopped it.

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
    onToggleVisualsFullWindow: toggleVisualsFullWindow,
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
// A tab swap replaces the document the roll's last frame described.
docSync.subscribe(({ immediate }) => immediate && bottomCanvas.handleDocSwap());
mountTrackBar({
  container: document.getElementById("track-bar"),
  view: editor.editor,
  docSync,
  onEvaluate: () => editor.evaluate(),
  isPlaying: () => !!editor.repl?.scheduler?.started,
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
  isPlaying: () => !!editor.repl?.scheduler?.started && tabs?.getPlayingItem() === tabs?.getActiveItem(),
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
  // Stop comes first, export or not: an export still waiting for its
  // compile-only evaluate (queued behind a stalled one) shows as non-idle,
  // and stopping is the way to release it. The visuals follow the repl
  // (visuals-host.js), so there is nothing to tear down here.
  if ((transportEl.dataset.transportState ?? "idle") !== "idle") {
    editor.stop();
    return;
  }
  if (isExportRunning()) {
    transport.setStatus("Export in progress");
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
    // Saving over a DIFFERENT existing pattern file replaces it for good.
    // So does saving under the name of a stored pattern: the record is
    // dropped below once disk becomes canonical.
    const replacesOther =
      name !== currentName && (name in patterns || store.get(name) != null);
    if (replacesOther) {
      const ok = await confirm({
        title: `Overwrite "${name}"?`,
        message: `A pattern named "${name}" already exists and will be replaced with the current buffer.`,
        confirmLabel: "Overwrite",
        destructive: true,
      });
      if (!ok) return;
    }
    let res;
    try {
      res = await fetch("/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          code: editor.code,
          overwrite: name in patterns,
        }),
      });
    } catch (err) {
      status.textContent = `save failed: ${err?.message ?? err} — is the dev server running?`;
      return;
    }
    if (!res.ok) {
      status.textContent = `save failed: ${await res.text()}`;
      return;
    }
    const { path } = await res.json();
    // Pending edits belong to the pattern that was open, not to the new name.
    flushToStore();
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

// No permission prompt on page load: connect right away only when MIDI
// access was granted on an earlier visit, otherwise the transport pill is
// the "Connect MIDI" button that asks on click.
wireMidiPill(document.getElementById("midi-status"), midi);
midi.startIfPermitted();

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
