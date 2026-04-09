import { StrudelMirror } from "@strudel/codemirror";
import { transpiler } from "@strudel/transpiler";
import { registerSoundfonts } from "@strudel/soundfonts";
// Strudel packages that are *also* fed to evalScope below: import them as
// whole namespaces so we can pass the values directly. Mixing static + dynamic
// imports of the same module triggers Vite/Rollup chunking warnings, and
// dynamic imports here can't actually be code-split (we use named exports
// from the same modules in this file). Single static import each, no warning.
import * as strudelCore from "@strudel/core";
import * as strudelDraw from "@strudel/draw";
import * as strudelMini from "@strudel/mini";
import * as strudelTonal from "@strudel/tonal";
import * as strudelWebaudio from "@strudel/webaudio";
import * as strudelExt from "./strudel-ext/index.js";
import { Prec, StateEffect } from "@codemirror/state";
import { MidiBridge, presets as midiPresets } from "./midi-bridge.js";
import { formatExtension } from "./editor/format.js";
import { createVscodeKeymap } from "./editor/keymap.js";
import { numericScrubber } from "./editor/numeric-scrubber.js";
import { installSoundCompletion } from "./editor/completions/sounds.js";
import { hoverDocs } from "./editor/hover-docs.js";
import { signatureHint } from "./editor/signature-hint.js";
import strudelDocs from "./editor/strudel-docs.json";
import { hydrateIcons } from "./ui/icons.js";
import { mount as mountLeftRail } from "./ui/left-rail.js";
import { mountTransport } from "./ui/transport.js";
import { mountRightRail } from "./ui/right-rail.js";
import { createSoundBrowserPanel } from "./ui/sound-browser.js";
import { createReferencePanel } from "./ui/reference-panel.js";
import { createConsolePanel } from "./ui/console-panel.js";
import { createExportPanel } from "./ui/export-panel.js";
import { renderRoll } from "./ui/piano-roll.js";
import { prompt, confirm } from "./ui/modal.js";
import {
  applyStoredAccent,
  mountSettingsDrawer,
} from "./ui/settings-drawer.js";

const { evalScope, controls } = strudelCore;
const {
  getAudioContext,
  webaudioOutput,
  registerSynthSounds,
  initAudio,
  initAudioOnFirstClick,
  setLogger,
  samples,
  soundMap,
  getSound,
  superdough,
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
} = strudelWebaudio;

// ─── Auto-discover patterns ──────────────────────────────────────────────
// Every .js file in /patterns must `export default` a string of Strudel code.
// Adding/removing files triggers Vite HMR (see hot.accept below).
const patternModules = import.meta.glob("../patterns/*.js", { eager: true });
const patterns = {};
for (const [filePath, mod] of Object.entries(patternModules)) {
  const name = filePath.split("/").pop().replace(/\.js$/, "");
  patterns[name] = mod.default;
}
const patternNames = Object.keys(patterns).sort();

// ─── DOM refs ────────────────────────────────────────────────────────────
// Existing IDs preserved so the off-limits prebake / WAV / share sections
// can keep writing to `status` etc. without modification (see SYSTEM.md
// §11). New shell elements (top-bar pattern menu, settings, roll toggle,
// left-rail container) are queried alongside.
const editorRoot = document.getElementById("editor");
const canvas = document.getElementById("roll");
const status = document.getElementById("status");
const playBtn = document.getElementById("play");
const stopBtn = document.getElementById("stop");
const saveBtn = document.getElementById("save");
const exportBtn = document.getElementById("export-wav");
const shareBtn = document.getElementById("share");
const presetPicker = document.getElementById("preset-picker");
const captureBtn = document.getElementById("capture");

// New shell refs
const shellEl = document.querySelector(".shell");
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

// Expand <span data-icon="..."> placeholders into Lucide SVGs before the
// rest of the wiring runs — every later attachShell handler can rely on
// the icons already being in the DOM.
hydrateIcons(document);

// Restore the user's chosen accent (if any) before any other UI mounts so
// the page never flashes the default rose pink. See settings-drawer.js.
applyStoredAccent();

// Toggle dev-only chrome (e.g. the disk-backed save button) via a body
// class. CSS hides .dev-only by default and reveals it when .dev-mode is
// present, so prod has zero flash of the save button before JS runs.
if (import.meta.env.DEV) document.body.classList.add("dev-mode");

// HiDPI piano roll
const dpr = window.devicePixelRatio || 1;
const resizeCanvas = () => {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
};
resizeCanvas();
window.addEventListener("resize", resizeCanvas);
const drawCtx = canvas.getContext("2d");
const drawTime = [-2, 2]; // seconds before / after now to render

// ─── Shareable URL helpers ───────────────────────────────────────────────
// In production we have no /api/save (Vercel filesystem is read-only), so
// the persistence story for visitors is "encode the editor buffer into a
// URL hash and copy it to the clipboard". The hash survives reload, and the
// initialiser below picks it up on next page load. base64url is binary-safe
// so multi-line patterns with backticks and ${} round-trip cleanly.
const SHARE_MAX_ENCODED = 6000; // ~6KB hash, comfortably under URL limits

function encodeShareCode(code) {
  const bytes = new TextEncoder().encode(code);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShareCode(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function readSharedFromHash() {
  if (!location.hash) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const codeParam = params.get("code");
  if (!codeParam) return null;
  try {
    return {
      code: decodeShareCode(codeParam),
      name: params.get("name") || "shared",
    };
  } catch (err) {
    console.warn("[strasbeat] failed to decode shared code from URL:", err);
    return null;
  }
}

// ─── Editor ──────────────────────────────────────────────────────────────
// If we were opened with a #code=... share link, that takes precedence over
// the auto-discovered patterns.
const shared = readSharedFromHash();
const fallbackName = patternNames[0] ?? "empty";
const initialName = shared
  ? `shared-${shared.name}`.replace(/[^a-z0-9_-]/gi, "-").slice(0, 40)
  : fallbackName;
const initialCode =
  shared?.code ??
  patterns[fallbackName] ??
  `// no patterns found in /patterns yet — type some Strudel here\nsound("bd sd hh*4")`;

let currentName = initialName;

// Forward declaration so the StrudelMirror `onEvalError` callback below
// can close over the console panel before it's actually constructed —
// the right rail (and the panel itself) are mounted further down in
// this file, but the callback is only invoked on a real eval error,
// by which time the panel exists. Same pattern as `referencePanel`.
let consolePanel = null;

const editor = new StrudelMirror({
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  root: editorRoot,
  initialCode,
  drawTime,
  autodraw: true,
  // Pattern transpile/runtime failures land here. StrudelMirror passes
  // `onEvalError` through to the underlying repl (see
  // strudel-source/packages/core/repl.mjs — `onEvalError?.(err)` is
  // called after `logger(...)` has already dispatched a `strudel.log`
  // CustomEvent, but with the raw Error this path also gives us the
  // stack when we want it). Routed into the console panel so composers
  // don't need devtools open to see why an evaluation failed.
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
    initAudioOnFirstClick();
    // evalScope uses Promise.allSettled, so passing module values is fine —
    // identical effect to passing import() promises, just no chunking warning.
    const loadModules = evalScope(
      controls,
      strudelCore,
      strudelDraw,
      strudelMini,
      strudelTonal,
      strudelWebaudio,
      strudelExt,
    );
    // Wrap each sample bank load so a single failure (network, CORS,
    // upstream change) doesn't take down the rest of the prebake.
    // Some Strudel registration functions return void rather than a
    // Promise — Promise.resolve() normalises both cases.
    const safe = (label, p) =>
      Promise.resolve(p).catch((e) =>
        console.warn(`[strasbeat] failed to load ${label}:`, e),
      );
    await Promise.all([
      loadModules,
      safe("synth sounds", registerSynthSounds()),
      safe("soundfonts", registerSoundfonts()),
      safe("dirt-samples", samples("github:tidalcycles/dirt-samples")),
      // strudel.cc has no CORS headers, so we proxy via vite.config.js
      safe(
        "tidal-drum-machines",
        samples(
          "/strudel-cc/tidal-drum-machines.json",
          "github:ritchse/tidal-drum-machines/main/machines/",
        ),
      ),
    ]);
    status.textContent = "ready · click play (or Ctrl/Cmd+Enter)";
  },
});

// Strudel resets the Drawer's drawTime to [0, 0] after every eval when the
// pattern has no .onPaint() / .pianoroll() calls
// (@strudel/codemirror/codemirror.mjs:221-222 — the user-facing afterEval
// hook fires *before* the reset, so re-setting from there gets immediately
// overwritten). We render the piano roll via the constructor's `onDraw`,
// not via .onPaint() on individual patterns, so the reset would collapse
// our 4-cycle window to "currently playing only": the framer's per-frame
// filter `endClipped >= phase - lookbehind - lookahead` becomes
// `endClipped >= phase`, pruning every hap the instant it ends. Intercept
// the reset at the drawer level so both the immediate `invalidate()` call
// (which pre-loads future haps in [t, t + lookahead]) and the per-frame
// filter see our intended window.
const _setDrawTime = editor.drawer.setDrawTime.bind(editor.drawer);
editor.drawer.setDrawTime = (dt) => {
  if (Array.isArray(dt) && dt[0] === 0 && dt[1] === 0) {
    _setDrawTime(drawTime);
  } else {
    _setDrawTime(dt);
  }
};

// ─── IDE-quality editor settings ─────────────────────────────────────────
// Strudel ships autocomplete, hover tooltips, bracket matching, multi-cursor
// etc. but defaults all of them OFF. Turn them on so the editor feels like a
// real IDE: typing `note(` shows a doc tooltip, hovering a Strudel function
// shows its signature, () [] {} balance highlights, Cmd-click adds a cursor.
//
// GOTCHA: updateSettings iterates ALL extension keys and reconfigures them,
// even keys not present in this object (they get `undefined` → treated as
// false). So isPatternHighlightingEnabled MUST be listed here explicitly or
// the highlight compartment gets emptied and active-note outlines disappear.
editor.updateSettings({
  isAutoCompletionEnabled: true,
  isTooltipEnabled: true,
  isBracketMatchingEnabled: true,
  isMultiCursorEnabled: true,
  isActiveLineHighlighted: true,
  isTabIndentationEnabled: true,
  isPatternHighlightingEnabled: true,
});

// Inject our editor extensions (Prettier formatter + VSCode-style keymap +
// numeric scrubber) into the live EditorView. StrudelMirror builds the view
// internally and doesn't expose an `extensions` array, so we use the
// standard CM6 `StateEffect.appendConfig` mechanism to add them after
// construction.
//
// Why Prec.highest on the keymaps: Strudel loads `defaultKeymap` from
// `@codemirror/commands` at Prec.high (via the `keybindings: 'codemirror'`
// setting), and `defaultKeymap` already binds `Mod-Enter` to `insertBlankLine`.
// Without an explicit precedence, our `Mod-Enter → evaluate` binding would
// sit at default precedence and lose to `insertBlankLine` — Cmd+Enter would
// silently insert a blank line instead of evaluating. Prec.highest puts us
// at the same level as Strudel's own `Ctrl-Enter` binding, and since none of
// our keys collide with Strudel's Prec.highest set, both coexist cleanly.
//
// The numeric scrubber is left at default precedence — it's a ViewPlugin
// (mouse handlers, decorations) not a keymap, so precedence doesn't matter.
//
// Forward declaration so hoverDocs's deep-link callback can close over
// the reference panel before it's actually constructed (the right rail
// is mounted further down in this file). The closure is only invoked
// after a real user hover, by which time the panel exists.
let referencePanel = null;

editor.editor.dispatch({
  effects: StateEffect.appendConfig.of([
    Prec.highest(formatExtension),
    Prec.highest(createVscodeKeymap({ onEvaluate: () => editor.evaluate() })),
    // Inline drag-to-scrub on numeric literals — see
    // src/editor/numeric-scrubber.js. We hand the scrubber a thin
    // re-eval shim that bypasses StrudelMirror.evaluate() so each frame
    // doesn't fire the visual flash animation.
    numericScrubber({
      evaluate: () => editor.repl.evaluate(editor.code, false),
    }),
    hoverDocs({
      // "→ Reference" link at the bottom of every hover tooltip — opens
      // the right rail to the API reference panel and scrolls to the
      // hovered function. See src/editor/hover-docs.js + src/ui/
      // reference-panel.js for the two halves of this wiring.
      onOpenReference: (name) => {
        if (!referencePanel) return;
        rightRail.activate("reference"); // expands the rail if collapsed
        referencePanel.scrollTo(name);
      },
    }),
    signatureHint,
  ]),
});

// ─── Sound name completion ───────────────────────────────────────────────
// Reconfigure Strudel's autocompletion compartment to include our live
// sound-name completion source. Must run after updateSettings (which
// enables autocompletion in the first place). We derive Strudel function
// names from the package exports already imported above.
installSoundCompletion(editor.editor, [
  ...new Set([
    ...Object.keys(strudelCore),
    ...Object.keys(strudelMini),
    ...Object.keys(strudelTonal),
    ...Object.keys(strudelWebaudio),
  ]),
]);

// ─── Left rail (patterns library) ────────────────────────────────────────
// Replaces the old <select id="pattern-picker"> with a custom component
// that lives in the left rail and grows naturally to host other
// collections later (instruments, samples, captured phrases). See
// design/SYSTEM.md §3 and design/work/01-shell.md.
const leftRail = mountLeftRail({
  container: leftRailContainer,
  patterns,
  currentName: patternNames.includes(currentName) ? currentName : null,
  devMode: import.meta.env.DEV,
  onSelect(name) {
    setCurrentName(name);
    editor.setCode(patterns[name]);
    transport.setStatus(`loaded "${name}" — press play to hear it`);
  },
  onCreate() {
    if (import.meta.env.DEV) handleNewPatternClick();
  },
});

// ─── Transport bar ───────────────────────────────────────────────────────
// Owns the cps/bpm + cycle + playhead readouts and the status / midi pill
// text. The play / stop / capture / preset-picker buttons live in the
// static HTML so existing handlers below attach by ID without going
// through the transport component.
const transport = mountTransport({
  getScheduler: () => editor?.repl?.scheduler ?? null,
});

// Single source of truth for "what pattern is the editor showing right
// now". Keeps the top-bar wordmark, the left rail's active highlight, and
// the `currentName` variable in sync. Existing call sites that mutated
// `currentName` directly are updated to call this helper.
function setCurrentName(name) {
  currentName = name;
  patternMenuName.textContent = name || "untitled";
  if (name && name in patterns) leftRail.setCurrent(name);
  else leftRail.clearCurrent();
}
setCurrentName(currentName);

// ─── Top bar wiring ──────────────────────────────────────────────────────
// Clicking the pattern wordmark focuses the left-rail search input —
// gives the user a one-click path from "what am I editing" to "what else
// is in the library". The settings popover is wired by the settings-drawer
// module — it handles open/close, focus, and persistence internally.
patternMenuBtn.addEventListener("click", () => leftRail.focusSearch());
mountSettingsDrawer({ button: settingsBtn });

// ─── Right rail (sound browser, future panels) ──────────────────────────
// The right rail is a generic tabbed panel host (src/ui/right-rail.js).
// Phase 1 lights up its first panel — the sound browser — which lets the
// composer browse, audition, and insert any registered sound. See
// design/work/08-feature-parity-and-beyond.md.
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
  onPreview: (name) => previewSoundName(name),
  onInsert: (name) => insertSoundName(name),
  onFocusEditor: () => editor.editor.focus(),
});
rightRail.registerPanel(soundBrowser);

// API reference panel — second tab in the right rail. See
// src/ui/reference-panel.js and design/work/08-feature-parity-and-beyond.md
// "Phase 2". Assigned to the forward-declared `referencePanel` so the
// hoverDocs deep-link callback (set up earlier in this file) can find
// it without needing the panel to exist at extension-dispatch time.
referencePanel = createReferencePanel({
  docs: strudelDocs,
  onTry: (exampleCode) => tryReferenceExample(exampleCode),
  onInsert: (name, template) => insertFunctionTemplate(name, template),
  onFocusEditor: () => editor.editor.focus(),
});
rightRail.registerPanel(referencePanel);
// Seed the "in use" highlights immediately — buildEntries() runs
// synchronously inside the factory, so this is safe before the panel
// has been activated for the first time.
referencePanel.setBufferText(editor.code ?? "");

// Console panel — third tab in the right rail. See
// src/ui/console-panel.js and design/work/08-feature-parity-and-beyond.md
// "Phase 3". Assigned to the forward-declared `consolePanel` so the
// StrudelMirror `onEvalError` callback (set up earlier in this file)
// can find it without needing the panel to exist at constructor time.
//
// The panel is dumb about where its entries come from — three hooks
// below feed it: the `strudel.log` CustomEvent on `document` captures
// scheduler + audio + eval log messages; `onEvalError` (above) captures
// transpile/runtime failures in user pattern code; and the
// `editor.evaluate` wrapper (further down) fires a divider before each
// evaluation so the user can tell one eval's tail output from the next
// one's head. No `console.*` patching — per CLAUDE.md's "don't silently
// patch globals" spirit, we stick to Strudel's own event surface.
consolePanel = createConsolePanel({
  onFocusEditor: () => editor.editor.focus(),
});
rightRail.registerPanel(consolePanel);

// Export panel — fourth tab in the right rail. See
// src/ui/export-panel.js and design/work/08-feature-parity-and-beyond.md
// "Phase 4". Replaces the old modal-based WAV flow. The factory takes
// the render pipeline as a callback; `runExport` is defined further
// down (same file, hoisted function declaration) so it can reach the
// `editor` + `renderPatternToBufferWithProgress` closures without a
// circular import. The panel owns the UI; the host owns the pipeline.
const exportPanel = createExportPanel({
  onFocusEditor: () => editor.editor.focus(),
  onExport: (options) => runExport(options),
  getPatternName: () => currentName || "untitled",
});
rightRail.registerPanel(exportPanel);

// Hook 1 — Strudel's `logger()` dispatches a `strudel.log` CustomEvent
// on `document` for every internal log message. Shape (from
// strudel-source/packages/core/logger.mjs):
//   { detail: { message: string, type: string, data: any } }
// `type` is a freeform label set by the caller — empty for info,
// "error" for errors, "warning" for warnings, plus whatever else
// upstream decides to emit. Map the ones we recognise into the
// panel's level taxonomy, route everything else to log().
document.addEventListener("strudel.log", (e) => {
  if (!consolePanel) return;
  const detail = e?.detail ?? {};
  const type = typeof detail.type === "string" ? detail.type : "";
  const message = detail.message ?? "";
  const data = detail.data ?? null;
  try {
    if (type === "error") consolePanel.error(message, data);
    else if (type === "warning") consolePanel.warn(message, data);
    else consolePanel.log(message, data);
  } catch (panelErr) {
    console.warn("[strasbeat/console] dispatch failed:", panelErr);
  }
});

// Refresh the panel once the prebake has populated soundMap. Prebake is
// off-limits (CLAUDE.md / SYSTEM.md §11) so we can't hook into it
// directly — instead we poll the soundMap until it has entries, then
// fire a single refresh. Caps at ~10s so a stuck prebake doesn't leave
// the interval running forever.
{
  const start = performance.now();
  const POLL_MS = 200;
  const TIMEOUT_MS = 10000;
  const interval = setInterval(() => {
    const count = Object.keys(soundMap.get() ?? {}).length;
    if (count > 0) {
      clearInterval(interval);
      soundBrowser.refresh();
      // Seed the "in use" highlights with whatever's in the editor right
      // now (even if the user hasn't pressed evaluate yet).
      soundBrowser.setBufferText(editor.code ?? "");
    } else if (performance.now() - start > TIMEOUT_MS) {
      clearInterval(interval);
      console.warn(
        "[strasbeat/sound-browser] soundMap still empty after 10s — " +
          "prebake may have failed; the panel will stay empty until reload",
      );
    }
  }, POLL_MS);
}

// Re-scan the editor buffer for "in use" sounds + functions on every
// evaluate. Both scans are string matches (not AST), cheap enough to
// run synchronously. Wrapping `editor.evaluate` lets us catch *all*
// eval entry points (toolbar, Cmd+Enter, share-link reload, …) without
// touching the Strudel keymap. The same wrapper fires a console-panel
// divider before the eval so the console's scroll region gets a
// visible separator between one evaluation's tail output and the next
// one's head.
const _editorEvaluate = editor.evaluate.bind(editor);
editor.evaluate = async function patchedEvaluate(...args) {
  // Fire the divider BEFORE the eval runs, so any log / warn / error
  // lines produced by the evaluation land *below* the divider, not
  // above it. Guarded so a console failure never blocks the eval.
  try {
    consolePanel?.divider(currentName || "eval");
  } catch (err) {
    console.warn("[strasbeat/console] divider failed:", err);
  }
  const result = await _editorEvaluate(...args);
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
  return result;
};

// Cmd/Ctrl+B toggles the right rail (matches VSCode's sidebar toggle).
// Captured at the document level so it works whether the focus is in
// the editor, in the sound-browser search input, or anywhere else in
// the shell. preventDefault keeps the browser's default "bold" mapping
// from running on focused inputs (where it would do nothing useful).
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

/**
 * Fire a one-shot audition of a sound through the live audio context.
 * Mirrors the MIDI bridge's superdough call shape (src/midi-bridge.js)
 * with a tuned envelope that works for both melodic sounds and one-shots.
 *
 * Unlike the MIDI bridge (which receives MIDI events that aren't user
 * gestures), this is always called from a mousedown handler — a real user
 * gesture. So we can (and must) resume a suspended AudioContext here
 * rather than just bailing out. The upstream initAudioOnFirstClick
 * listener sits on `document` and fires *after* the sound item's handler
 * (event bubbling goes inner → outer), so on the first interaction the
 * context is still suspended when we get here.
 */
async function previewSoundName(name) {
  const ctx = getAudioContext();
  if (!ctx) {
    transport.setStatus("no audio context — try reloading the page");
    return;
  }
  // Resume on first user gesture if the context is still suspended.
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (err) {
      console.warn("[strasbeat/sound-browser] ctx.resume() failed:", err);
    }
  }
  if (ctx.state !== "running") {
    transport.setStatus(
      "click the page once to enable audio, then preview again",
    );
    return;
  }
  if (!getSound(name)) {
    console.warn(`[strasbeat/sound-browser] sound "${name}" is not loaded`);
    return;
  }
  const value = {
    s: name,
    note: 60, // middle C — ignored by drum hits, used by melodic sounds
    gain: 0.8,
    attack: 0.005,
    decay: 0.4,
    sustain: 0,
    release: 0.3,
  };
  // 10ms latency cushion — superdough warns and skips events scheduled in
  // the past, same as the MIDI bridge.
  Promise.resolve(superdough(value, ctx.currentTime + 0.01, 0.5)).catch((err) =>
    console.warn(`[strasbeat/sound-browser] preview "${name}" failed:`, err),
  );
}

/**
 * Insert a sound name into the editor at the cursor. Context-aware: if
 * the cursor sits inside an existing `s("…")` / `sound("…")` literal,
 * we replace just the inner string contents; otherwise we drop a fresh
 * `s("name")` at the cursor (or over the current selection).
 */
function insertSoundName(name) {
  const view = editor.editor;
  if (!view) return;
  const { state } = view;
  const cursor = state.selection.main.head;
  const doc = state.doc.toString();

  // Detect "cursor inside an s("…") / sound("…") literal":
  //   - look backwards for `s(` or `sound(` followed by a quote and any
  //     non-quote/paren/newline run that ends at the cursor
  //   - look forwards for the matching close quote on the same line
  // If both halves match, replace the entire inner string.
  const before = doc.slice(0, cursor);
  const after = doc.slice(cursor);
  const openMatch = before.match(/\b(?:s|sound)\(\s*(["'])([^"'\n)]*)$/);
  if (openMatch) {
    const quote = openMatch[1];
    const innerSoFar = openMatch[2];
    // Match a same-line run up to the matching close quote.
    const closeRe = new RegExp(`^([^"'\\n)]*)${quote === '"' ? '"' : "'"}`);
    const tail = after.match(closeRe);
    if (tail) {
      const innerStart = cursor - innerSoFar.length;
      const innerEnd = cursor + tail[1].length;
      view.dispatch({
        changes: { from: innerStart, to: innerEnd, insert: name },
        selection: { anchor: innerStart + name.length },
      });
      view.focus();
      return;
    }
  }

  // Fallback: insert a new s("name") call at the cursor (or replace the
  // current selection if there is one).
  const sel = state.selection.main;
  const insert = `s("${name}")`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
  });
  view.focus();
}

/**
 * Try a reference panel example: replace the editor buffer with the
 * given code and evaluate it. If the buffer differs from the loaded
 * pattern (i.e. has unsaved edits), confirm via the modal system before
 * destroying the user's work.
 */
async function tryReferenceExample(code) {
  const loaded = patterns[currentName];
  const isDirty = loaded == null || editor.code !== loaded;
  if (isDirty) {
    const ok = await confirm({
      title: "Replace current buffer with example?",
      message: "Unsaved changes will be lost.",
      confirmLabel: "Replace",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (!ok) return;
  }
  editor.setCode(code);
  try {
    await editor.evaluate();
  } catch (err) {
    console.warn("[strasbeat/reference-panel] try evaluate failed:", err);
  }
}

/**
 * Insert a function-call template at the editor cursor, placing the
 * caret between the parens. Same dispatch shape as insertSoundName but
 * dumber: no context detection, no replacement of existing content.
 */
function insertFunctionTemplate(name, template) {
  const view = editor.editor;
  if (!view) return;
  const { state } = view;
  const sel = state.selection.main;
  const cursorOffset = template.indexOf("(") + 1; // between the parens
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: template },
    selection: { anchor: sel.from + cursorOffset },
  });
  view.focus();
}

// ─── Collapsible piano roll ──────────────────────────────────────────────
// Click the transport's roll-toggle button to collapse/expand. The shell
// grid animates `--roll-h` between 0 and the current expanded value, so
// the editor reclaims the freed vertical space.
let rollCollapsed = false;
let rollExpandedPx = 180; // matches tokens.css default --roll-h
rollToggleBtn.addEventListener("click", toggleRoll);
function toggleRoll() {
  rollCollapsed = !rollCollapsed;
  shellEl.classList.toggle("shell--roll-collapsed", rollCollapsed);
  rollToggleBtn.setAttribute("aria-expanded", String(!rollCollapsed));
  if (!rollCollapsed) {
    shellEl.style.setProperty("--roll-h", `${rollExpandedPx}px`);
  }
  // Keep the canvas backing-store sized to its new visible area.
  requestAnimationFrame(resizeCanvas);
}

// Drag the divider to resize the roll. Click on a collapsed divider
// expands. Tracks pointer events directly so it works on touch and
// trackpad without extra plumbing.
let dragStartY = null;
let dragStartHeight = null;
const ROLL_MIN_PX = 80;
const ROLL_MAX_PX = 360;
rollDivider.addEventListener("pointerdown", (e) => {
  if (rollCollapsed) {
    toggleRoll();
    return;
  }
  dragStartY = e.clientY;
  dragStartHeight = rollExpandedPx;
  rollDivider.setPointerCapture(e.pointerId);
  e.preventDefault();
  document.body.style.cursor = "ns-resize";
});
rollDivider.addEventListener("pointermove", (e) => {
  if (dragStartY == null) return;
  const dy = dragStartY - e.clientY; // dragging up = bigger roll
  const h = Math.min(ROLL_MAX_PX, Math.max(ROLL_MIN_PX, dragStartHeight + dy));
  rollExpandedPx = h;
  shellEl.style.setProperty("--roll-h", `${h}px`);
});
function endRollDrag(e) {
  if (dragStartY == null) return;
  dragStartY = null;
  document.body.style.cursor = "";
  if (e?.pointerId != null && rollDivider.hasPointerCapture?.(e.pointerId)) {
    rollDivider.releasePointerCapture(e.pointerId);
  }
  requestAnimationFrame(resizeCanvas);
}
rollDivider.addEventListener("pointerup", endRollDrag);
rollDivider.addEventListener("pointercancel", endRollDrag);

// ─── New pattern ("+") button — dev only ─────────────────────────────────
// Reuses the existing /api/save endpoint with a tiny template body so the
// "+" affordance is a UI shape change, not a new server pipe. HMR picks
// up the new file and the page reloads.
async function handleNewPatternClick() {
  const name = await prompt({
    title: "New pattern name",
    placeholder: "letters, numbers, - and _",
    defaultValue: `untitled-${Date.now().toString(36)}`,
    confirmLabel: "Create",
    validate: (v) =>
      /^[a-z0-9_-]+$/i.test(v) ? null : "use only letters, numbers, - and _",
  });
  if (!name) return;
  if (name in patterns) {
    transport.setStatus(`"${name}" already exists — pick another name`);
    return;
  }
  const code = `// ${name}\nsetcps(120/60/4)\n\nsound("bd ~ sd ~")\n`;
  const res = await fetch("/api/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, code }),
  });
  if (!res.ok) {
    transport.setStatus(`save failed: ${await res.text()}`);
    return;
  }
  transport.setStatus(`created "${name}" — HMR will reload`);
}

// ─── Transport ───────────────────────────────────────────────────────────
playBtn.addEventListener("click", async () => {
  await editor.evaluate();
  transport.kick(); // promote the readout loop to rAF immediately
});
stopBtn.addEventListener("click", () => editor.stop());

// ─── Save current editor → patterns/<name>.js ────────────────────────────
// Dev-only: relies on the /api/save middleware in vite.config.js, which only
// runs in the dev server. Wrapping the registration in `if (DEV)` lets the
// minifier strip the entire handler from the prod bundle (the button itself
// is also hidden via the .dev-only CSS class — see index.html / style.css).
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
    status.textContent = `saved → ${path}`;
    // Vite HMR will pick up the new file and re-fire the glob below.
  });
}

// ─── Share current editor → URL with #code=... ──────────────────────────
// Encodes the editor buffer into a base64url hash, copies the resulting URL
// to the clipboard, and updates the address bar so a refresh keeps the work
// (and the user can fall back to copying from the URL bar). This is the
// production persistence story — see the dev-only save button above for the
// disk-backed alternative used in dev.
async function shareCurrent() {
  const code = editor.code ?? "";
  if (!code.trim()) {
    status.textContent = "nothing to share — editor is empty";
    return;
  }
  let encoded;
  try {
    encoded = encodeShareCode(code);
  } catch (err) {
    console.warn("[strasbeat] share encode failed:", err);
    status.textContent = "share failed — could not encode pattern";
    return;
  }
  if (encoded.length > SHARE_MAX_ENCODED) {
    status.textContent = `pattern too large to share via URL (${encoded.length} > ${SHARE_MAX_ENCODED} bytes encoded)`;
    return;
  }
  const params = new URLSearchParams({ code: encoded });
  if (currentName) params.set("name", currentName);
  const hash = `#${params.toString()}`;
  // Update the address bar so refresh keeps the work and the user has a
  // visible copy even if the clipboard write fails.
  history.replaceState(null, "", hash);
  const url = `${location.origin}${location.pathname}${hash}`;
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = "share link copied to clipboard";
  } catch {
    status.textContent = "share link is in the URL bar — copy from there";
  }
}

shareBtn.addEventListener("click", shareCurrent);

// ─── Export current pattern → WAV ────────────────────────────────────────
// We don't use upstream `renderPatternAudio` because it has a bug: it
// constructs `new SuperdoughAudioController(offline)` *before* `initAudio()`,
// and somewhere in that path live-context audio nodes leak into the offline
// graph (the per-hap mismatch errors get swallowed by errorLogger and the
// resulting WAV is bit-exact silent). We replicate its setup here, but pass
// `null` to setSuperdoughAudioController so the controller is built lazily on
// the first superdough() call — which always happens *after* the audio
// context swap is fully settled. Same teardown shape, audible output.
const EXPORT_SAMPLE_RATE = 48000;
const EXPORT_MAX_POLYPHONY = 1024;

/**
 * Render a Strudel pattern to a stereo AudioBuffer offline.
 * Mirrors the strudel/webaudio renderPatternAudio setup but with lazy
 * controller construction (see comment above).
 */
async function renderPatternToBuffer(pattern, cps, cycles, sampleRate) {
  const live = getAudioContext();
  await live.close();
  const offline = new OfflineAudioContext(
    2,
    (cycles / cps) * sampleRate,
    sampleRate,
  );
  setAudioContext(offline);
  // Crucial: lazy controller. The first superdough() call below will build
  // the controller against `offline` via getSuperdoughAudioController().
  setSuperdoughAudioController(null);
  await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });

  const haps = pattern
    .queryArc(0, cycles, { _cps: cps })
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  let scheduled = 0;
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
    const t = hap.whole.begin.valueOf() / cps;
    const dur = hap.duration / cps;
    try {
      await superdough(hap.value, t, dur, cps, t);
      scheduled++;
    } catch (err) {
      console.warn(
        "[strasbeat/export] superdough failed for hap:",
        err,
        hap.value,
      );
    }
  }

  const rendered = await offline.startRendering();
  return { rendered, scheduled };
}

/** Encode a 2-channel AudioBuffer to a 16-bit PCM WAV ArrayBuffer. */
function audioBufferToWav16(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const ch0 = buffer.getChannelData(0);
  const ch1 = numChannels > 1 ? buffer.getChannelData(1) : ch0;
  const numFrames = ch0.length;
  const dataBytes = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);

  // RIFF header
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  // Interleaved 16-bit PCM
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, (ch === 0 ? ch0 : ch1)[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return out;
}

function downloadWav(arrayBuf, filename) {
  const blob = new Blob([arrayBuf], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".wav") ? filename : `${filename}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Export pipeline with progress polling ──────────────────────────────
//
// The export panel owns the UI but delegates the actual render to the
// host via the `onExport` callback. `runExport` is that callback: it
// wraps the same setup as the probe helper (evaluate → stop scheduler →
// sanity-check haps → render → download), but in addition it polls the
// offline AudioContext's `currentTime` every 100ms during render so the
// panel's progress bar has something to animate.
//
// `renderPatternToBufferWithProgress` is a close cousin of
// `renderPatternToBuffer` that accepts an `onProgress(ratio)` callback
// and fires it from a `setInterval` kicked off right before
// `offline.startRendering()`. The two functions share the same setup
// order exactly — DO NOT re-order them (see CLAUDE.md § "WAV export:
// DO NOT use upstream renderPatternAudio"): the `SuperdoughAudio
// Controller` must be reset to null BEFORE `initAudio` so the first
// `superdough()` call builds it lazily against the offline context.
// The duplication is a deliberate ~30-line clone rather than a shared
// helper because the original `renderPatternToBuffer` is still used by
// `probeRender()` below, and the progress interval is overkill there.

/**
 * Same setup as `renderPatternToBuffer` but with an `onProgress(ratio)`
 * callback that fires every 100ms while `offline.startRendering()` is
 * in flight. `ratio` is 0..1 derived from `offline.currentTime /
 * totalSeconds`. Called once with `1` after `startRendering()` resolves
 * so the progress bar always lands at 100% before the panel flips to
 * its "done" state.
 */
async function renderPatternToBufferWithProgress(
  pattern,
  cps,
  cycles,
  sampleRate,
  onProgress,
) {
  const live = getAudioContext();
  await live.close();
  const offline = new OfflineAudioContext(
    2,
    (cycles / cps) * sampleRate,
    sampleRate,
  );
  setAudioContext(offline);
  // Crucial: lazy controller. The first superdough() call below will build
  // the controller against `offline` via getSuperdoughAudioController().
  setSuperdoughAudioController(null);
  await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });

  const haps = pattern
    .queryArc(0, cycles, { _cps: cps })
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  let scheduled = 0;
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
    const t = hap.whole.begin.valueOf() / cps;
    const dur = hap.duration / cps;
    try {
      await superdough(hap.value, t, dur, cps, t);
      scheduled++;
    } catch (err) {
      console.warn(
        "[strasbeat/export] superdough failed for hap:",
        err,
        hap.value,
      );
    }
  }

  // Poll the offline context's currentTime so the panel can show a
  // moving progress bar. `startRendering()` advances `currentTime`
  // monotonically as it pulls samples from the graph, so this is a
  // reliable (if coarse) percentage. 100ms is the spec's suggested
  // cadence — fast enough to feel live, slow enough to avoid churning
  // layout.
  const totalSeconds = offline.length / offline.sampleRate;
  let pollHandle = null;
  if (typeof onProgress === "function") {
    pollHandle = setInterval(() => {
      try {
        const ratio = Math.min(1, offline.currentTime / totalSeconds);
        onProgress(ratio);
      } catch (err) {
        console.warn("[strasbeat/export] progress poll failed:", err);
      }
    }, 100);
  }

  try {
    const rendered = await offline.startRendering();
    if (typeof onProgress === "function") {
      try {
        onProgress(1);
      } catch {
        /* ignore */
      }
    }
    return { rendered, scheduled };
  } finally {
    if (pollHandle != null) clearInterval(pollHandle);
  }
}

/**
 * Scan a rendered AudioBuffer for the stats the export panel needs to
 * display: the absolute peak across both channels, and the percent of
 * samples that are non-zero (the silent-export warning fires if this is
 * too low). Walks every sample once — cheap at 48kHz × ~30s.
 */
function computeBufferStats(buffer) {
  let absMax = 0;
  let nonZero = 0;
  let totalSamples = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    totalSamples += data.length;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > absMax) absMax = a;
      if (data[i] !== 0) nonZero++;
    }
  }
  return {
    peakAmplitude: absMax,
    percentNonZero: totalSamples > 0 ? (100 * nonZero) / totalSamples : 0,
  };
}

/**
 * The `onExport` callback wired into the export panel. Same high-level
 * flow as the old `exportBtn.addEventListener('click', …)` handler, but
 * factored so the panel (not a prompt modal) collects the options, and
 * the return value feeds the panel's waveform + stats view.
 *
 * Routes both success and failure into the console panel too so a
 * composer who has the console open can see the render progress
 * without switching tabs.
 */
async function runExport(options) {
  const { cycles, sampleRate, filename } = options;
  const exportLabel = exportBtn.querySelector(".btn__label");

  // Reflect "rendering…" in the toolbar button too so users watching
  // the top bar see the same state the panel shows.
  exportBtn.disabled = true;
  if (exportLabel) exportLabel.textContent = "…";
  status.textContent = `rendering ${cycles} cycle${cycles === 1 ? "" : "s"} → ${filename}.wav`;
  try {
    consolePanel?.log(
      `export: rendering ${cycles} cycle${cycles === 1 ? "" : "s"} → ${filename}.wav @ ${sampleRate}Hz`,
    );
  } catch (err) {
    console.warn("[strasbeat/console] export log failed:", err);
  }

  // Surface per-hap errors that superdough's errorLogger normally swallows.
  const captured = [];
  setLogger((msg, type) => {
    captured.push({ msg, type });
    if (type === "error" || type === "warning") console.warn("[strudel]", msg);
    else console.log("[strudel]", msg);
  });

  try {
    await editor.evaluate(false);
    editor.repl.scheduler.stop();

    const pattern = editor.repl.state.pattern;
    const cps = editor.repl.scheduler.cps;
    if (!pattern)
      throw new Error("no pattern after evaluate — eval probably failed");
    if (!Number.isFinite(cps) || cps <= 0) throw new Error(`bad cps: ${cps}`);

    // Sanity-check the haps before render: if the pattern is silent in the
    // requested arc, fail fast instead of writing an empty file.
    const probeHaps = pattern.queryArc(0, cycles, { _cps: cps });
    const onsetHaps = probeHaps.filter((h) => h.hasOnset?.());
    console.log(
      `[strasbeat/export] cps=${cps} cycles=${cycles} ${probeHaps.length} haps, ${onsetHaps.length} onsets`,
    );
    if (!onsetHaps.length)
      throw new Error(
        "pattern produced no onset haps for the requested cycle range",
      );

    const { rendered, scheduled } = await renderPatternToBufferWithProgress(
      pattern,
      cps,
      cycles,
      sampleRate,
      (ratio) => exportPanel.showProgress(ratio),
    );

    const wavArrayBuffer = audioBufferToWav16(rendered);
    // Cache a Uint8Array view so the panel's "download again" button
    // can re-download the same bytes without touching the render path.
    // The ArrayBuffer itself is handed to the initial download too;
    // wrapping it in a Blob once now and once again on re-download is
    // wasteful but harmless at typical export sizes.
    const wavBytes = new Uint8Array(wavArrayBuffer);
    downloadWav(wavArrayBuffer, filename);

    const errorCount = captured.filter((c) => c.type === "error").length;
    if (errorCount)
      console.warn(
        `[strasbeat/export] ${errorCount} strudel errors during render — see above`,
      );

    const stats = computeBufferStats(rendered);
    const duration = rendered.length / rendered.sampleRate;
    const fileSize = wavArrayBuffer.byteLength;

    status.textContent = `exported ${filename}.wav (${scheduled} events, ${cycles} cycle${cycles === 1 ? "" : "s"})`;
    try {
      consolePanel?.log(
        `export: done — ${scheduled} events, peak=${stats.peakAmplitude.toFixed(3)}, ${fileSize} bytes`,
      );
    } catch (err) {
      console.warn("[strasbeat/console] export log failed:", err);
    }

    return {
      buffer: rendered,
      wavBytes,
      scheduled,
      cycles,
      sampleRate,
      filename,
      fileSize,
      duration,
      peakAmplitude: stats.peakAmplitude,
      percentNonZero: stats.percentNonZero,
    };
  } catch (err) {
    console.error("[strasbeat] wav export failed:", err);
    status.textContent = `export failed: ${err.message ?? err}`;
    // Echo the failure into the console panel so users who don't have
    // devtools open still see it. The panel itself also displays the
    // error in its own error state via showError, so this is a
    // deliberate double-surface.
    try {
      consolePanel?.error(
        `export failed: ${err?.message ?? String(err)}`,
        { error: err },
      );
    } catch (panelErr) {
      console.warn("[strasbeat/console] export error echo failed:", panelErr);
    }
    throw err;
  } finally {
    // Restore the default strudel logger.
    setLogger((msg) => console.log(msg));
    // The render torn down the live audio context — restore it so the user
    // can press play again without reloading.
    try {
      setAudioContext(null);
      setSuperdoughAudioController(null);
      resetGlobalEffects();
      await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });
      editor.repl.scheduler.stop();
    } catch (err) {
      console.error("[strasbeat] failed to restore audio after export:", err);
    }
    exportBtn.disabled = false;
    if (exportLabel) exportLabel.textContent = "wav";
  }
}

// Toolbar WAV button → open the export panel and auto-start a render
// with the panel's current settings. Same one-click muscle memory as
// the old modal flow, minus the cycles prompt. The panel takes over
// from there (progress + waveform + stats + download-again).
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
// Populate the preset picker from midi-bridge's presets dict.
for (const [key, p] of Object.entries(midiPresets)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = p.label ?? key;
  presetPicker.appendChild(opt);
}
presetPicker.value = "epiano";

const midi = new MidiBridge({
  getPreset: () => presetPicker.value,
  // Status / capture-count callbacks route through the transport bar
  // component so the styling is in CSS (no hard-coded recording color) and
  // the capture button keeps its icon SVG instead of having textContent
  // overwritten.
  onStatus: (s) => transport.setMidiStatus(s),
  onCaptureChange: (n) => {
    if (midi.isCaptureEnabled())
      transport.setCaptureState({ recording: true, count: n });
  },
});
midi.start();

captureBtn.addEventListener("click", async () => {
  if (!midi.isCaptureEnabled()) {
    midi.setCaptureEnabled(true);
    transport.setCaptureState({ recording: true, count: 0 });
    transport.setStatus(
      "capturing MIDI · play something · click again to save",
    );
    return;
  }
  // stop + save
  midi.setCaptureEnabled(false);
  transport.setCaptureState({ recording: false });
  const code = midi.buildPatternFromCapture();
  if (!code) {
    transport.setStatus("capture stopped — no notes recorded");
    return;
  }
  if (import.meta.env.PROD) {
    // No filesystem in prod — drop the captured phrase into the editor
    // and let the user share it via the share button.
    editor.setCode(code);
    setCurrentName("captured");
    transport.setStatus("captured phrase loaded · share to send it");
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
  transport.setStatus(`captured phrase → ${path} (HMR will reload)`);
});

// ─── Console helpers ─────────────────────────────────────────────────────
// Strudel sound names are not 1:1 with the official GM-128 names. Use
// `strasbeat.findSounds("piano")` from devtools to discover what's actually
// loaded before guessing in your patterns.
// Echo helper output into the console panel alongside devtools so the
// composer can see results without switching windows. Additive —
// devtools still get the same `console.log` lines.
function echoHelper(message, data) {
  console.log(message, data ?? "");
  try {
    consolePanel?.log(message, data);
  } catch (err) {
    console.warn("[strasbeat/console] helper echo failed:", err);
  }
}

window.strasbeat = {
  /** List loaded sounds whose key matches `query` (regex, case-insensitive). */
  findSounds(query = "") {
    const all = Object.keys(soundMap.get());
    if (!query) {
      echoHelper(`${all.length} sounds loaded — pass a query to filter`);
      return all.slice(0, 30);
    }
    const re = new RegExp(query, "i");
    const matches = all.filter((k) => re.test(k));
    echoHelper(
      `findSounds(${JSON.stringify(query)}) → ${matches.length} match${matches.length === 1 ? "" : "es"}`,
      matches.slice(0, 30),
    );
    return matches;
  },
  /** Total number of registered sounds (samples + soundfonts + synths). */
  countSounds() {
    return Object.keys(soundMap.get()).length;
  },
  /** Check if a specific name resolves. */
  hasSound(name) {
    return !!getSound(name);
  },
  /**
   * Debug helper: render the current pattern offline (no file written) and
   * return per-channel signal stats. Use from devtools to verify the export
   * pipeline still produces audio without flooding ~/Downloads with WAVs.
   *
   *   await strasbeat.probeRender(4)
   */
  async probeRender(cycles = 4, sampleRate = EXPORT_SAMPLE_RATE) {
    await editor.evaluate(false);
    editor.repl.scheduler.stop();
    const pattern = editor.repl.state.pattern;
    const cps = editor.repl.scheduler.cps;
    if (!pattern) throw new Error("no pattern after evaluate");
    const { rendered, scheduled } = await renderPatternToBuffer(
      pattern,
      cps,
      cycles,
      sampleRate,
    );
    const ch0 = rendered.getChannelData(0);
    let absMax = 0,
      nz = 0;
    for (let i = 0; i < ch0.length; i++) {
      const a = Math.abs(ch0[i]);
      if (a > absMax) absMax = a;
      if (ch0[i] !== 0) nz++;
    }
    setAudioContext(null);
    setSuperdoughAudioController(null);
    resetGlobalEffects();
    await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });
    const stats = {
      cps,
      cycles,
      scheduled,
      seconds: rendered.length / sampleRate,
      absMax,
      percentNonZero: (100 * nz) / ch0.length,
    };
    echoHelper(
      `probeRender(${cycles}) → ${scheduled} events, absMax=${absMax.toFixed(3)}`,
      stats,
    );
    return stats;
  },
};

// expose for console tinkering
window.editor = editor;
window.patterns = patterns;
window.midi = midi;
