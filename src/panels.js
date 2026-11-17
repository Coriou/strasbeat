import { codemirrorSettings } from "@strudel/codemirror";
import { createConsolePanel } from "./ui/console-panel.js";
import { createLazyPanel } from "./ui/lazy-panel.js";
import { lazyImport } from "./lazy-import.js";
import { loadDocs } from "./editor/docs-store.js";
import { previewSoundName, insertSoundName, tryReferenceExample, insertFunctionTemplate, SCRATCH_PATTERN_NAME } from "./editor-actions.js"; // prettier-ignore
import { saveNewPattern } from "./patterns.js";
import { runExport } from "./export.js";
import { applyAccent, resetAccent, readStoredAccent, saveStoredAccent, clearStoredAccent } from "./ui/settings-drawer.js"; // prettier-ignore
import { THEME_OPTIONS, applyPanelSetting } from "./editor-setup.js";
import { applyKeymapProfile } from "./editor/keymap-apply.js";
import { buildExport, parseImportJson, previewImport, applyImport } from "./library-io.js";
import { choiceModal, formModal, confirm as modalConfirm } from "./ui/modal.js";

// Every panel except the console is fetched the first time its tab is
// opened (and warmed in the background once the app has booted), so their
// code is not in front of the editor's first paint. The console stays in the
// main bundle: it is where errors are shown, including the error of a panel
// that failed to load.
//
// Each factory below has the signature of the panel module's own
// `create…Panel(options)` and returns a handle with the same id, tab icon,
// label and public methods, so registration order, the persisted active tab
// and every caller holding a handle work as if the panel were already there
// — see ui/lazy-panel.js for what happens to calls made before it is.
// `id` / `icon` / `label` must match the spec the real module returns.
function lazyPanelFactory({ id, icon, label, methods, load, prepare }) {
  return (options) =>
    createLazyPanel({
      id,
      icon,
      label,
      methods,
      load: async ({ silent }) => {
        const [create, extra] = await Promise.all([
          lazyImport(load, { what: `the ${label} panel`, silent }),
          prepare ? prepare({ silent }) : null,
        ]);
        return create({ ...options, ...extra });
      },
    });
}

const createLearnPanel = lazyPanelFactory({
  id: "learn",
  icon: "graduation-cap",
  label: "Learn",
  load: () => import("./ui/learn-panel.js").then((m) => m.createLearnPanel),
});

const createSoundBrowserPanel = lazyPanelFactory({
  id: "sounds",
  icon: "music",
  label: "Sound browser",
  methods: ["refresh", "setBufferText", "focusSound", "focusSearch"],
  load: () =>
    import("./ui/sound-browser.js").then((m) => m.createSoundBrowserPanel),
});

const createReferencePanel = lazyPanelFactory({
  id: "reference",
  icon: "book-open",
  label: "API reference",
  methods: ["setBufferText", "scrollTo"],
  load: () =>
    import("./ui/reference-panel.js").then((m) => m.createReferencePanel),
  // The panel builds its entry list from the docs index when constructed.
  prepare: async ({ silent }) => ({ docs: await loadDocs({ silent }) }),
});

const createExportPanel = lazyPanelFactory({
  id: "export",
  icon: "download",
  label: "Export",
  methods: ["showProgress", "showResult", "showError", "reset", "autoExport"],
  load: () => import("./ui/export-panel.js").then((m) => m.createExportPanel),
});

const createSettingsPanel = lazyPanelFactory({
  id: "settings",
  icon: "settings",
  label: "Settings",
  load: () =>
    import("./ui/settings-panel.js").then((m) => m.createSettingsPanel),
});

// Run `fn` when the main thread has nothing better to do.
function whenIdle(fn) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(fn, { timeout: 5000 });
  } else {
    setTimeout(fn, 1500);
  }
}

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
  refreshOpenTab,
  focusEditorLocation,
  refreshRail,
  getEvalFeedback,
  drumKit,
  chooseDrumKit,
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
  BUILD_ID,
  STRUDEL_VERSION,
  isDev,
  bootPromise,
}) {
  // "Try" (Learn + Reference) opens the example in a scratch user pattern
  // rather than over the open one — see tryReferenceExample. A shipped
  // pattern can't be the scratch target, so step aside if one has the name.
  const tryContext = {
    editor,
    getCurrentName,
    confirm,
    scratch: {
      name:
        SCRATCH_PATTERN_NAME in patterns
          ? `${SCRATCH_PATTERN_NAME}-scratch`
          : SCRATCH_PATTERN_NAME,
      read: (name) => {
        const rec = store.get(name);
        const listed = (store.getIndex().userPatterns ?? []).includes(name);
        return rec?.isUserPattern && listed ? (rec.code ?? "") : null;
      },
      write: (name, code) => {
        store.set(name, {
          ...store.get(name),
          code,
          modified: new Date().toISOString(),
        });
        // Drop any cached editor state for the tab so it reopens on the
        // code just written, not on what it showed last time.
        refreshOpenTab(name);
      },
      create: (name, code) =>
        saveNewPattern({
          name,
          code,
          store,
          leftRail,
          setCurrentName,
          editor,
          transport,
          openPattern,
        }),
      open: openPattern,
    },
  };

  const learnPanel = createLearnPanel({
    onTry: (code) => tryReferenceExample(code, tryContext),
    onCopyToNewPattern: async (code) => {
      const before = getCurrentName();
      const index = store.getIndex();
      await handleNewPatternClick({
        store,
        patterns,
        editor,
        leftRail,
        transport,
        setCurrentName,
        flushToStore,
        formModal,
        folders: index.folders ?? [],
        lastNewPatternFolder: index.uiState?.lastNewPatternFolder ?? null,
        onLastNewPatternFolderChange(folder) {
          const idx = store.getIndex();
          idx.uiState = { ...(idx.uiState ?? {}), lastNewPatternFolder: folder };
          store.setIndex(idx);
        },
        openPattern,
      });
      // Cancelled (or failed) — nothing was created, nothing to seed.
      if (getCurrentName() === before) return false;
      // `openPattern` routed the new pattern through the tab controller (so
      // it's a managed tab — no currentName/controller desync); setCode then
      // replaces THAT tab's starter buffer with the snippet, and the flush
      // persists it to the store right away.
      editor.setCode(code);
      flushToStore();
      return true;
    },
    onFocusEditor: () => editor.editor.focus(),
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
    onTry: (exampleCode) => tryReferenceExample(exampleCode, tryContext),
    onInsert: (name, template) =>
      insertFunctionTemplate(name, template, editor.editor),
    onFocusEditor: () => editor.editor.focus(),
  });
  rightRail.registerPanel(referencePanel);
  // Seed "in use" highlights — held until the panel's module has loaded.
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
    // Only once something was evaluated: before that the scheduler holds
    // its default tempo, not the pattern's.
    getCps: () => (editor.repl?.state?.pattern ? editor.repl.scheduler.cps : null),
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
    getDrumKit: () => drumKit.getKit(),
    onDrumKitChange: (kit) => chooseDrumKit(kit),
    subscribeDrumKit: (fn) => drumKit.onChange(fn),
    themes: THEME_OPTIONS,
    appVersion: APP_VERSION,
    buildId: BUILD_ID,
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
          cancelLabel: null,
        });
        return;
      }
      const parsed = parseImportJson(text);
      if (!parsed.ok) {
        await modalConfirm({
          title: "Couldn't read library",
          message: parsed.error,
          confirmLabel: "OK",
          cancelLabel: null,
        });
        return;
      }
      const shippedDemos = new Set(Object.keys(patterns));
      const pv = previewImport(parsed.data, store, shippedDemos);
      const conflictCount = pv.conflicts.length;
      // New user patterns plus the Demo edits that replace nothing here.
      const newCount =
        pv.newUserPatterns.length +
        pv.demoWorkingCopies.transferable.filter(
          (name) => !pv.conflicts.includes(name),
        ).length;
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
      // Persist the open buffer first (this also cancels the pending
      // autosave), then note what every incoming name holds now: a tab
      // whose record the import rewrites has to be rebuilt from the store,
      // or its stale buffer is flushed straight back over the import on
      // the next tab switch.
      flushToStore();
      const incoming = Object.keys(parsed.data.patterns ?? {});
      const codeBefore = new Map(
        incoming.map((name) => [name, store.get(name)?.code]),
      );
      const result = applyImport(parsed.data, store, {
        conflictStrategy: strategy,
        shippedDemos,
      });
      // Also after a partial (storage-full) import: whatever was written
      // must show, in the open tabs and in the library.
      for (const name of result.written ?? []) {
        if (store.get(name)?.code !== codeBefore.get(name)) refreshOpenTab(name);
      }
      if (result.imported > 0) refreshRail?.();
      if (result.ok) {
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
      // Shown, not focused: the user hasn't asked for it, and the page's
      // first keystrokes shouldn't land in a search field.
      rightRail.activate("learn", { focus: false });
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
          "the panel stays empty until sounds register (it re-reads each " +
          "time it's opened)",
      );
    }
  });

  // Once the app is up, fetch the panel modules in the background so the
  // first open of each is instant and they keep working if the connection
  // drops later. One at a time, quietly: a failure here is retried (and
  // reported) when the user actually opens the panel.
  bootPromise.then(() =>
    whenIdle(async () => {
      for (const panel of [learnPanel, soundBrowser, referencePanel, exportPanel, settingsPanel]) {
        await panel.preload();
      }
    }),
  );

  return { consolePanel, soundBrowser, referencePanel, exportPanel };
}
