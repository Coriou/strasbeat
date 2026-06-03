import { codemirrorSettings } from "@strudel/codemirror";
import { createSoundBrowserPanel } from "./ui/sound-browser.js";
import { createReferencePanel } from "./ui/reference-panel.js";
import { createConsolePanel } from "./ui/console-panel.js";
import { createExportPanel } from "./ui/export-panel.js";
import { createSettingsPanel } from "./ui/settings-panel.js";
import { createLearnPanel } from "./ui/learn-panel.js";
import { previewSoundName, insertSoundName, tryReferenceExample, insertFunctionTemplate } from "./editor-actions.js"; // prettier-ignore
import { runExport } from "./export.js";
import { applyAccent, resetAccent, readStoredAccent, saveStoredAccent, clearStoredAccent } from "./ui/settings-drawer.js"; // prettier-ignore
import { THEME_OPTIONS, applyPanelSetting } from "./editor-setup.js";
import { applyKeymapProfile } from "./editor/keymap-apply.js";
import { buildExport, parseImportJson, previewImport, applyImport } from "./library-io.js";
import { choiceModal, confirm as modalConfirm } from "./ui/modal.js";

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
  openPattern,
  focusEditorLocation,
  refreshRail,
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
        openPattern,
      });
      // If a new pattern was created, seed it with the learn content.
      // `openPattern` routed it through the tab controller (so it's a managed
      // tab — no currentName/controller desync); setCode then replaces THAT
      // tab's buffer with the snippet, which the disk save / autosave persists.
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
    onExport: (options) => runExport(options, { editor, consolePanel, exportPanel, exportBtn, status, setLogger, getAudioContext, getSound, setAudioContext, setSuperdoughAudioController, resetGlobalEffects, initAudio, superdough, onBeforeContextTeardown: () => scope.disconnect() }),
    getPatternName: () => getCurrentName() || "untitled",
  });
  rightRail.registerPanel(exportPanel);

  let accentSaveTimer;
  const settingsPanel = createSettingsPanel({
    onFocusEditor: () => editor.editor.focus(),
    getSettings: () => codemirrorSettings.get?.() ?? {},
    onChangeSetting: (key, value) => applyPanelSetting(editor, key, value),
    onKeymapChange: (profileId) => applyKeymapProfile(editor, profileId, {
      onEvaluate: () => editor.evaluate(),
    }),
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
    onReloadRequired: () => {
      status.textContent = "Reload to apply changes";
    },
    confirm,
    onExportLibrary() {
      const payload = buildExport(store);
      if (
        payload.folders.length === 0 &&
        Object.keys(payload.patterns).length === 0
      ) {
        transport.setStatus("Library is empty — nothing to export");
        return;
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = url;
      a.download = `strasbeat-library-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      transport.setStatus(
        `Exported ${Object.keys(payload.patterns).length} patterns`,
      );
    },
    async onImportLibrary(file) {
      let text;
      try {
        text = await file.text();
      } catch (err) {
        await modalConfirm({
          title: "Couldn't read file",
          message: String(err?.message ?? err),
          confirmLabel: "OK",
          cancelLabel: "",
        });
        return;
      }
      const parsed = parseImportJson(text);
      if (!parsed.ok) {
        await modalConfirm({
          title: "Couldn't read library",
          message: parsed.error,
          confirmLabel: "OK",
          cancelLabel: "",
        });
        return;
      }
      const shippedDemos = new Set(Object.keys(patterns));
      const pv = previewImport(parsed.data, store, shippedDemos);
      const conflictCount = pv.conflicts.length;
      const newCount = pv.newUserPatterns.length;
      const untransferable = pv.demoWorkingCopies.untransferable.length;

      let strategy = "skip";
      if (conflictCount > 0) {
        const choices = [
          { value: "skip", label: "Skip existing" },
          { value: "overwrite", label: "Overwrite existing" },
          { value: "rename", label: "Rename existing as -imported" },
        ];
        const r = await choiceModal({
          title: "Import library",
          message:
            `${newCount + conflictCount} patterns across ${pv.newFolders.length} new folder(s).` +
            `\n\n${conflictCount} already exist: ${pv.conflicts.slice(0, 5).join(", ")}${conflictCount > 5 ? "…" : ""}` +
            (untransferable
              ? `\n\n${untransferable} modified demo(s) won't be imported (originals not in this build).`
              : ""),
          choices,
          cancelLabel: "Cancel",
        });
        if (r == null) return;
        strategy = r;
      } else {
        const ok = await modalConfirm({
          title: "Import library",
          message:
            `${newCount} pattern${newCount === 1 ? "" : "s"} will be imported.` +
            (pv.newFolders.length
              ? ` ${pv.newFolders.length} new folder${pv.newFolders.length === 1 ? "" : "s"}.`
              : "") +
            (untransferable
              ? `\n\n${untransferable} modified demo(s) won't be imported (originals not in this build).`
              : ""),
          confirmLabel: "Import",
        });
        if (!ok) return;
      }
      const result = applyImport(parsed.data, store, {
        conflictStrategy: strategy,
        shippedDemos,
      });
      if (result.ok) {
        if (result.imported > 0) refreshRail?.();
        transport.setStatus(
          `Imported ${result.imported} patterns into ${pv.newFolders.length} new folder(s)`,
        );
      } else {
        transport.setStatus(result.error ?? "Import failed");
        return;
      }
    },
  });
  rightRail.registerPanel(settingsPanel);

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
