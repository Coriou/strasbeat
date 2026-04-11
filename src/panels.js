import { codemirrorSettings } from "@strudel/codemirror";
import { createSoundBrowserPanel } from "./ui/sound-browser.js";
import { createReferencePanel } from "./ui/reference-panel.js";
import { createConsolePanel } from "./ui/console-panel.js";
import { createExportPanel } from "./ui/export-panel.js";
import { createSettingsPanel } from "./ui/settings-panel.js";
import { createLearnPanel } from "./ui/learn-panel.js";
import { createSetupPanel } from "./ui/setup-panel.js";
import { previewSoundName, insertSoundName, tryReferenceExample, insertFunctionTemplate } from "./editor-actions.js"; // prettier-ignore
import { runExport } from "./export.js";
import { applyAccent, resetAccent, readStoredAccent, saveStoredAccent, clearStoredAccent } from "./ui/settings-drawer.js"; // prettier-ignore
import { THEME_OPTIONS, applyPanelSetting } from "./editor-setup.js";

/**
 * Creates and registers all right-rail panels. Call after `mountRightRail`.
 *
 * Returns the panel handles that other parts of the app need to interact
 * with (consolePanel, soundBrowser, referencePanel, exportPanel).
 */
export function registerPanels({
  rightRail,
  editor,
  transport,
  patterns,
  getCurrentName,
  confirm,
  prompt,
  store,
  leftRail,
  setCurrentName,
  flushToStore,
  handleNewPatternClick,
  focusEditorLocation,
  getEvalFeedback,
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
  isDev,
  bootPromise,
}) {
  const learnPanel = createLearnPanel({
    onTry: (code) =>
      tryReferenceExample(code, {
        editor,
        patterns,
        getCurrentName,
        confirm,
      }),
    onCopyToNewPattern: async (code, title) => {
      const before = getCurrentName();
      await handleNewPatternClick({
        store,
        patterns,
        editor,
        leftRail,
        transport,
        setCurrentName,
        flushToStore,
        prompt,
        isDev,
      });
      // If a new pattern was created, seed it with the learn content.
      if (getCurrentName() !== before) {
        editor.setCode(code);
        saveBtn?.click();
      }
    },
    onFocusEditor: () => editor.editor.focus(),
    onOpenReference: (name) => {
      rightRail.activate("reference");
      referencePanel?.focusEntry?.(name);
    },
  });
  rightRail.registerPanel(learnPanel);

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

  const referencePanel = createReferencePanel({
    docs: strudelDocs,
    onTry: (exampleCode) =>
      tryReferenceExample(exampleCode, {
        editor,
        patterns,
        getCurrentName,
        confirm,
      }),
    onInsert: (name, template) =>
      insertFunctionTemplate(name, template, editor.editor),
    onFocusEditor: () => editor.editor.focus(),
  });
  rightRail.registerPanel(referencePanel);
  // Seed "in use" highlights immediately — buildEntries runs synchronously.
  referencePanel.setBufferText(editor.code ?? "");

  const consolePanel = createConsolePanel({
    onFocusEditor: () => editor.editor.focus(),
    onJumpToLine: focusEditorLocation,
    onClear: () => getEvalFeedback()?.dismissRuntimeErrors(),
  });
  rightRail.registerPanel(consolePanel);

  // prettier-ignore
  const exportPanel = createExportPanel({
    onFocusEditor: () => editor.editor.focus(),
    onExport: (options) => runExport(options, { editor, consolePanel, exportPanel, exportBtn, status, setLogger, getAudioContext, getSound, setAudioContext, setSuperdoughAudioController, resetGlobalEffects, initAudio, superdough, onBeforeContextTeardown: () => scope.disconnect(), onAfterContextRestore: () => { if (bottomModes.getMode() === "scope") { try { scope.connect(getAudioContext()); } catch {} } } }),
    getPatternName: () => getCurrentName() || "untitled",
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
    getSoundMap: () => soundMap.get(),
    themes: THEME_OPTIONS,
    appVersion: APP_VERSION,
    strudelVersion: STRUDEL_VERSION,
  });
  rightRail.registerPanel(settingsPanel);

  const setupPanel = createSetupPanel({
    onFocusEditor: () => editor.editor.focus(),
    onReloadRequired: () => {
      status.textContent = "Reload to apply changes";
    },
    confirm,
  });
  rightRail.registerPanel(setupPanel);

  // ─── First-run orientation ───────────────────────────────────────────────
  // Auto-open the right rail to the Learn panel on first visit so new users
  // discover the in-app learning surface and the panel system. The flag is
  // cleared after the first visit; after that, the rail remembers the user's
  // choice.
  {
    const FIRST_RUN_KEY = "strasbeat:first-run-done";
    if (!localStorage.getItem(FIRST_RUN_KEY)) {
      localStorage.setItem(FIRST_RUN_KEY, "1");
      rightRail.activate("learn");
    }
  }

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

  return { consolePanel, soundBrowser, referencePanel, exportPanel };
}
