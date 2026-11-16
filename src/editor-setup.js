import { Compartment, Prec, StateEffect } from "@codemirror/state";
import { createUniversalKeymap } from "./editor/keymap-universal.js";
import { getProfile, getStoredProfileId } from "./editor/keymap-profiles.js";
import { codemirrorSettings, defaultSettings } from "@strudel/codemirror";
import { formatExtension, formatStatus } from "./editor/format.js";
import { errorMarksExtension } from "./editor/error-marks.js";
import { createVscodeKeymap } from "./editor/keymap.js";
import { numericScrubber } from "./editor/numeric-scrubber.js";
import { hoverDocs } from "./editor/hover-docs.js";
import { signatureHint } from "./editor/signature-hint.js";
import { createLatestWinsRunner } from "./editor/latest-wins.js";
import { parseArrangements } from "./editor/arrange-parse.js";
import {
  primeArrangementParser,
  resetRegistry as resetArrangeRegistry,
  beginEvaluate as beginArrangeEvaluate,
  endEvaluate as endArrangeEvaluate,
  markEvalAppliedFor as markArrangeEvalAppliedFor,
  isEvalInProgress as isArrangeEvalInProgress,
} from "./strudel-ext/arrange.js";

// CodeMirror compartment for the strasbeat-side editing overlay
// (createVscodeKeymap). Wrapped so we can swap it in/out when the user
// changes profiles, without remounting the editor. See
// design/work/21-keybindings.md §"CM compartment for the strasbeat overlay".
// Exported so the per-tab EditorState factory (build-editor-state.js) and the
// switch path can read its live value when reasoning about a state swap.
export const strasbeatOverlayCompartment = new Compartment();

export function readStoredCmSettingsFromLocalStorage() {
  try {
    const raw = localStorage.getItem("codemirror-settings");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    console.warn(
      "[strasbeat/settings] could not read stored CM settings:",
      err,
    );
    return null;
  }
}

// ─── IDE-quality editor settings ─────────────────────────────────────────
// Strudel ships autocomplete, hover tooltips, bracket matching, multi-cursor
// etc. but defaults all of them OFF. We turn on the ones that make the
// editor feel like a real IDE: typing `note(` shows a doc tooltip,
// hovering a Strudel function shows its signature, () [] {} balance
// highlights, Cmd-click adds a cursor.
//
// GOTCHA 1: `updateSettings` iterates ALL extension keys and
// reconfigures them — any key absent from the passed object gets
// `undefined` → treated as falsy → disabled. So the merged object below
// must always include every key we care about.
//
// GOTCHA 2: the right-rail settings panel writes user-flipped booleans
// to StrudelMirror's persistent atom via `editor.changeSetting`, but a
// naive hardcoded `updateSettings` call at boot would clobber those on
// every page load. We fix this by merging in four layers (lowest wins):
//
//   1. Upstream defaults (every extension key present, correct types).
//   2. strasbeat's preferred defaults — what we turn on if the user has
//      no stored preference. These are the "IDE feel" bonuses
//      (bracket matching, active line highlight, multi-cursor, etc.).
//   3. The user's stored preferences from the persistent atom
//      (`codemirrorSettings`). Includes anything the settings panel
//      persisted on a previous run. Wins over strasbeat defaults so a
//      user who disabled bracket matching in the panel doesn't get it
//      re-enabled on reload.
//   4. Required-on settings — the two keys we never let the user turn
//      off because they are core to the IDE feel (autocompletion,
//      tooltips). Win over everything.
//
// See design/work/08-feature-parity-and-beyond.md "Phase 5" for the
// rationale and strudel-source/packages/codemirror/codemirror.mjs
// (defaultSettings, updateSettings, codemirrorSettings) for the API.

export const STRASBEAT_REQUIRED_ON = {
  isAutoCompletionEnabled: true,
  isTooltipEnabled: true,
};

// Geist Mono stack — kept in sync with `--font-mono` in
// src/styles/tokens.css. The editor.css rules used to hardcode the same
// stack on .cm-content, but that blocked the settings panel's font
// family picker from having any effect; now the CSS rule is gone and
// the stack flows through StrudelMirror's inline-style path instead.
// See design/work/08-feature-parity-and-beyond.md "Phase 5" and the
// rationale in src/styles/editor.css.
export const GEIST_MONO_STACK =
  '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const STRASBEAT_DEFAULT_PREFERENCES = {
  isBracketMatchingEnabled: true,
  isMultiCursorEnabled: true,
  isActiveLineHighlighted: true,
  isTabIndentationEnabled: true,
  isPatternHighlightingEnabled: true,
  fontFamily: GEIST_MONO_STACK,
  fontSize: 18,
};

// The merge uses the stored settings captured BEFORE the StrudelMirror
// constructor ran. See the long comment in main.js for why —
// nanostores' persistentAtom writes defaultSettings to localStorage on
// its first touch, so reading localStorage here (after the constructor)
// would round-trip defaults as if they were the user's stored
// preferences.
export function applyInitialSettings(editor, storedSettings) {
  const profile = getProfile(getStoredProfileId());
  editor.updateSettings({
    ...defaultSettings,
    ...STRASBEAT_DEFAULT_PREFERENCES,
    ...(storedSettings ?? {}),
    ...STRASBEAT_REQUIRED_ON,
    keybindings: profile.strudelKeybindings, // last so we win
  });
}

// Ctrl+B belongs to the editor in the Emacs profile (cursor left) and in the
// modal ones (Vim / Helix page up). The app's Ctrl+B shortcut must stand
// down while one of them is active and the key is typed into the editor.
export function editorClaimsCtrlB(target) {
  const profile = getProfile(getStoredProfileId());
  if (!profile.isModal && profile.id !== "emacs") return false;
  return Boolean(target?.closest?.(".cm-editor"));
}

// Mute/solo edit the buffer and re-evaluate so the change is heard — but
// only while this buffer is the one playing (the track bar and the beat grid
// follow the same rule). With the transport stopped the toggle is just an
// edit and must not start playback; in a tab that is not the playing one it
// must not replace the pattern that is.
//
// `isPlaying` is the host's "the focused tab is playing" predicate
// (`isTabPlaying` in tabs.js), handed over once through
// dispatchEditorExtensions and read at each keypress: the overlay is rebuilt
// from several places on a profile change, and all of them must gate alike.
// Until the host has provided it, nothing is known to be playing.
let isBufferPlaying = () => false;
export function evaluateIfPlaying(isPlaying, onEvaluate) {
  return () => {
    if (isPlaying()) onEvaluate();
  };
}
const evaluateIfBufferPlaying = (onEvaluate) =>
  evaluateIfPlaying(() => isBufferPlaying(), onEvaluate);

// Re-evaluate for a live edit (the numeric scrubber) without the ceremony of
// a user-initiated evaluate: no flash, no console divider, no transport
// "loading" flicker, no diagnostics pass — a drag fires this many times a
// second. What it must NOT skip is the arrange() bookkeeping the full
// evaluate does (eval-feedback.js): the wrapper in strudel-ext/arrange.js
// numbers arrange() calls from the last registry reset, so evaluating
// without one makes the registry grow on every call and silently drops a
// soloed section (its index stops matching).
async function evaluateLiveEdit(editor) {
  // A full evaluate is mid-flight and owns the arrange registry, so this
  // edit is skipped. That evaluate read the buffer when it started: a value
  // scrubbed after that point is only heard if another scrub request follows
  // (the runner's trailing run) or on the next evaluate.
  if (isArrangeEvalInProgress()) return;
  const code = editor.code ?? "";
  try {
    primeArrangementParser(parseArrangements(code));
    resetArrangeRegistry();
    beginArrangeEvaluate();
  } catch (err) {
    console.warn("[strasbeat/arrange] failed to prime parser:", err);
  }
  let applied = false;
  try {
    await editor.repl.evaluate(code, false);
    applied = true;
  } finally {
    try {
      endArrangeEvaluate();
      if (applied) markArrangeEvalAppliedFor(code);
    } catch (err) {
      console.warn("[strasbeat/arrange] endEvaluate failed:", err);
    }
  }
}

// Inject our editor extensions (Prettier formatter + keymaps + numeric
// scrubber) into the live EditorView via StateEffect.appendConfig.
//
// Prec.highest on the keymaps: Strudel loads defaultKeymap at Prec.high
// which binds Mod-Enter to insertBlankLine. Without explicit precedence,
// our Mod-Enter → evaluate would lose to insertBlankLine.
//
// The universal keymap (Layer 2) is always loaded — it provides Mod-Enter
// evaluate regardless of profile. The strasbeat overlay (createVscodeKeymap)
// is wrapped in a Compartment so it can be swapped in/out at runtime when
// the user changes profiles, without remounting the editor.
export function dispatchEditorExtensions(
  editor,
  {
    onOpenReference,
    onAuditionSelected,
    onRevealSound,
    onFocusBrowser,
    onStatus,
    isFocusedTabPlaying,
    isTabPlaying,
  },
) {
  if (isTabPlaying) isBufferPlaying = isTabPlaying;
  const profile = getProfile(getStoredProfileId());
  const onEvaluate = () => editor.evaluate();

  // Scrubbing only re-evaluates when the result would be heard *and* belongs
  // to what is playing: with the transport stopped there is nothing to
  // update, and evaluating a tab that isn't the playing one would replace
  // the playing tab's audio while the tab strip still credits the other tab.
  const requestScrubEvaluate = createLatestWinsRunner(
    () => {
      if (!editor.repl?.scheduler?.started) return;
      if (isFocusedTabPlaying && !isFocusedTabPlaying()) return;
      return evaluateLiveEdit(editor);
    },
    { onError: (err) => console.warn("[scrubber] eval rejected:", err) },
  );

  editor.editor.dispatch({
    effects: StateEffect.appendConfig.of([
      errorMarksExtension,
      Prec.highest(formatExtension),
      onStatus ? formatStatus.of(onStatus) : [],
      Prec.highest(createUniversalKeymap({ onEvaluate, onAuditionSelected, onRevealSound, onFocusBrowser })),
      strasbeatOverlayCompartment.of(
        profile.applyStrasbeatOverlay
          ? Prec.highest(
              createVscodeKeymap({
                onEvaluate: evaluateIfBufferPlaying(onEvaluate),
              }),
            )
          : [],
      ),
      numericScrubber({ evaluate: requestScrubEvaluate }),
      hoverDocs({ onOpenReference }),
      signatureHint,
    ]),
  });
}

// Live-swap the strasbeat overlay extension. Called by applyKeymapProfile
// when the user picks a new profile. CM6 compartment.reconfigure is
// instant (single dispatch) — no editor remount, no scroll/cursor reset.
export function reconfigureOverlay(editor, applyOverlay, onEvaluate) {
  editor.editor.dispatch({
    effects: strasbeatOverlayCompartment.reconfigure(
      applyOverlay
        ? Prec.highest(
            createVscodeKeymap({
              onEvaluate: evaluateIfBufferPlaying(onEvaluate),
            }),
          )
        : [],
    ),
  });
}

// prettier-ignore
export const THEME_OPTIONS = [
  { key: "strudelTheme", label: "Strudel (default)" }, { key: "dracula", label: "Dracula" }, { key: "nord", label: "Nord" },
  { key: "vscodeDark", label: "VS Code Dark" }, { key: "vscodeLight", label: "VS Code Light" }, { key: "monokai", label: "Monokai" },
  { key: "gruvboxDark", label: "Gruvbox Dark" }, { key: "gruvboxLight", label: "Gruvbox Light" },
  { key: "solarizedDark", label: "Solarized Dark" }, { key: "solarizedLight", label: "Solarized Light" },
  { key: "tokyoNight", label: "Tokyo Night" }, { key: "tokyoNightStorm", label: "Tokyo Night Storm" }, { key: "tokyoNightDay", label: "Tokyo Night Day" },
  { key: "githubDark", label: "GitHub Dark" }, { key: "githubLight", label: "GitHub Light" },
  { key: "materialDark", label: "Material Dark" }, { key: "materialLight", label: "Material Light" },
  { key: "sublime", label: "Sublime" }, { key: "atomone", label: "Atom One" }, { key: "aura", label: "Aura" },
  { key: "darcula", label: "Darcula (JetBrains)" }, { key: "duotoneDark", label: "Duotone Dark" },
  { key: "noctisLilac", label: "Noctis Lilac" }, { key: "eclipse", label: "Eclipse" }, { key: "bbedit", label: "BBEdit" },
  { key: "bluescreen", label: "Blue Screen" }, { key: "bluescreenlight", label: "Blue Screen Light" },
  { key: "blackscreen", label: "Black Screen" }, { key: "whitescreen", label: "White Screen" },
  { key: "teletext", label: "Teletext" }, { key: "algoboy", label: "Algo Boy" }, { key: "archBtw", label: "Arch BTW" },
  { key: "androidstudio", label: "Android Studio" }, { key: "CutiePi", label: "Cutie Pi" },
  { key: "sonicPink", label: "Sonic Pink" }, { key: "fruitDaw", label: "Fruit DAW" },
  { key: "greenText", label: "Green Text" }, { key: "redText", label: "Red Text" }, { key: "xcodeLight", label: "Xcode Light" },
];

// Applies a setting live AND persists to StrudelMirror's atom — upstream's
// `changeSetting` only touches the compartment, not the atom, so without
// this mirror the panel's toggles would reset on every page load.
export function applyPanelSetting(editor, key, value) {
  if (
    (key === "isAutoCompletionEnabled" || key === "isTooltipEnabled") &&
    value === false
  ) {
    console.warn(
      `[strasbeat/settings] refusing to disable required-on setting "${key}"`,
    );
    return;
  }
  try {
    editor.changeSetting(key, value);
  } catch (err) {
    console.warn(`[strasbeat/settings] changeSetting("${key}") failed:`, err);
    return;
  }
  try {
    const current = codemirrorSettings.get?.() ?? {};
    codemirrorSettings.set({ ...current, [key]: value });
  } catch (err) {
    console.warn(
      `[strasbeat/settings] persisting "${key}" to atom failed:`,
      err,
    );
  }
}
