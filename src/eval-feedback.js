import { shouldIgnoreStrudelLog } from "./strudel-logger.js";

/**
 * Installs the eval feedback infrastructure: error tracking, sound validation,
 * patched evaluate/stop, and the strudel.log → console panel bridge.
 *
 * Call after all panels are mounted. Monkey-patches editor.evaluate and
 * editor.stop. Returns the small API surface main.js needs for wiring.
 */
export function installEvalFeedback({
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
  getCurrentName,
}) {
  // ─── State ───────────────────────────────────────────────────────────────
  let _firstEvalDone = false;
  let runtimeErrorCount = 0;
  let activeTransportError = null;
  let lastWarnedUnknownSounds = new Set();
  // Flag set by handleEvalError — lets the patched evaluate know whether
  // _editorEvaluate produced an error (it catches internally, never throws).
  let _lastEvalHadError = false;
  // True while _editorEvaluate is in flight — strudel.log errors during eval
  // are eval errors (handled by onEvalError + inline marks), not runtime errors.
  let _evalInProgress = false;
  let playbackRequestId = 0;

  const _editorEvaluate = editor.evaluate.bind(editor);
  const _editorStop = editor.stop.bind(editor);

  // ─── Error tracking ─────────────────────────────────────────────────────

  function resetRuntimeErrors() {
    runtimeErrorCount = 0;
    activeTransportError = null;
    transport?.clearErrorState();
  }

  function dismissRuntimeErrors() {
    runtimeErrorCount = 0;
    if (activeTransportError?.source === "runtime") {
      activeTransportError = null;
      transport?.clearErrorState();
    }
  }

  function registerEvalError(err, entryId, located) {
    const message = readErrorMessage(err);
    const isSyntaxError =
      err?.name === "SyntaxError" ||
      Boolean(err?.loc) ||
      /\[mini\]\s*parse error/i.test(message);

    showTransportError({
      source: "eval",
      kind: isSyntaxError ? "parse" : "eval",
      label: isSyntaxError ? "syntax error" : "eval error",
      title: `Open console: ${firstLine(message) || "error"}`,
      entryId,
      location: located ?? extractErrorLine(err),
    });
  }

  function registerRuntimeError(entryId) {
    if (activeTransportError?.source === "eval") return;

    runtimeErrorCount += 1;
    const firstEntryId =
      activeTransportError?.source === "runtime" &&
      Number.isInteger(activeTransportError.entryId)
        ? activeTransportError.entryId
        : Number.isInteger(entryId)
          ? entryId
          : null;
    const label =
      runtimeErrorCount === 1
        ? "runtime error"
        : `${runtimeErrorCount} runtime errors`;

    showTransportError({
      source: "runtime",
      kind: "runtime",
      label,
      title: `Open console: ${label}`,
      entryId: firstEntryId,
    });
  }

  function showTransportError({
    source,
    kind,
    label,
    title,
    entryId = null,
    location = null,
  }) {
    activeTransportError = {
      source,
      entryId: Number.isInteger(entryId) ? entryId : null,
      location: normalizeTransportLocation(location),
    };
    transport?.setErrorState({ kind, label, title });
  }

  function normalizeTransportLocation(location) {
    if (!location || !Number.isInteger(location.line) || location.line < 1) {
      return null;
    }
    const next = { line: location.line };
    if (typeof location.column === "number") next.column = location.column;
    return next;
  }

  function readErrorMessage(err) {
    if (typeof err === "string") return err;
    return err?.message || String(err ?? "");
  }

  function firstLine(text) {
    return String(text ?? "")
      .split(/\r?\n/, 1)[0]
      .trim();
  }

  // ─── Sound validation ───────────────────────────────────────────────────

  function collectOnsets(haps) {
    return haps.filter((hap) => hap?.hasOnset?.());
  }

  function soundKeyFromHap(hap) {
    const value = hap?.value;
    if (!value || typeof value !== "object") return null;
    let soundKey = value.s ?? "triangle";
    if (value.bank && soundKey) soundKey = `${value.bank}_${soundKey}`;
    if (typeof soundKey !== "string") return null;
    if (["-", "~", "_"].includes(soundKey)) return null;
    return soundKey;
  }

  function findSoundSuggestions(query) {
    const allSounds = Object.keys(soundMap.get() ?? {});
    if (!query) return [];

    let matches = [];
    try {
      const re = new RegExp(query, "i");
      matches = allSounds.filter((soundName) => re.test(soundName));
    } catch {
      const needle = String(query).toLowerCase();
      matches = allSounds.filter((soundName) =>
        soundName.toLowerCase().includes(needle),
      );
    }

    if (matches.length === 0 && String(query).includes("_")) {
      const tail = String(query).split("_").pop();
      matches = allSounds.filter((soundName) =>
        soundName.toLowerCase().includes(String(tail).toLowerCase()),
      );
    }

    return matches.slice(0, 5);
  }

  function isExplicitSilencePattern(code) {
    const lines = String(code ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("//"));

    if (lines.length === 0) return false;
    return lines.every(
      (line) => /^setcp[sm]\(/.test(line) || /^silence(?:\(\))?$/.test(line),
    );
  }

  function warnIfPatternStartsSilent(firstCycleOnsets, nearbyOnsets) {
    if (firstCycleOnsets.length > 0) return;
    if (nearbyOnsets.length > 0) return;
    if (isExplicitSilencePattern(editor.code)) return;
    consolePanel?.warn(
      "Pattern evaluated but produced no sound events in the first 4 cycles. Check your sound names and pattern structure.",
    );
  }

  function warnForUnknownSounds(haps) {
    const soundMapObj = soundMap.get() ?? {};
    const unknownSounds = new Set();

    for (const hap of haps) {
      const soundKey = soundKeyFromHap(hap);
      if (!soundKey) continue;
      if (!soundMapObj[soundKey.toLowerCase()]) {
        unknownSounds.add(soundKey);
      }
    }

    for (const soundName of unknownSounds) {
      if (lastWarnedUnknownSounds.has(soundName)) continue;
      const suggestions = findSoundSuggestions(soundName);
      const message = suggestions.length
        ? `Sound "${soundName}" not found. Did you mean: ${suggestions.join(", ")}?`
        : `Sound "${soundName}" not found. Use strasbeat.findSounds('${soundName}') in the console to search.`;
      consolePanel?.warn(message);
    }

    lastWarnedUnknownSounds = unknownSounds;
  }

  // ─── onEvalError handler (wired via forward-ref from StrudelMirror) ────

  function handleEvalError(err) {
    _lastEvalHadError = true;
    const located = setError(editor.editor, err);
    let entryId = null;
    const message = err?.message || String(err);
    try {
      // When the content-based heuristic found a line, pass it as
      // structured data so the console panel can render a [line N] badge
      // even for errors that don't carry line numbers natively.
      const data = { error: err };
      if (located) data.line = located.line;
      if (located?.column != null) data.column = located.column;
      entryId = consolePanel?.error(message, data) ?? null;
    } catch (panelErr) {
      console.warn("[strasbeat/console] error() failed:", panelErr);
    }
    registerEvalError(err, entryId, located);
  }

  // ─── Patched evaluate ──────────────────────────────────────────────────

  editor.evaluate = async function patchedEvaluate(...args) {
    const evalRequestId = ++playbackRequestId;

    try {
      // If prebake is still in progress, keep Play live and queue the start.
      if (!getBootReady()) {
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
        consolePanel?.divider(getCurrentName() || "eval");
      } catch (err) {
        console.warn("[strasbeat/console] divider failed:", err);
      }
      _lastEvalHadError = false;
      _evalInProgress = true;
      // Reset badge at eval start — new eval = fresh error slate.
      resetRuntimeErrors();
      const result = await _editorEvaluate(...args);
      _evalInProgress = false;
      if (evalRequestId !== playbackRequestId) return result;

      // Only clear inline marks on success — on failure, onEvalError
      // already called setError.
      if (!_lastEvalHadError) {
        clearError(editor.editor);
      } else {
        // Eval failed — skip post-eval diagnostics (prewarm, silence
        // detection, sound validation). The error is already surfaced.
        // Restore transport state: if the scheduler is still running the
        // old pattern, stay "playing"; otherwise revert to "idle".
        if (evalRequestId === playbackRequestId) {
          transport.setPlaybackState(
            editor.repl?.scheduler?.started ? "playing" : "idle",
          );
        }
        return result;
      }

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
          const firstCycleHaps = pattern.queryArc(0, 1, { _cps: cps });
          const firstCycleOnsets = collectOnsets(firstCycleHaps);
          const haps = pattern.queryArc(0, 4, { _cps: cps });
          const nearbyOnsets = collectOnsets(haps);

          warnIfPatternStartsSilent(firstCycleOnsets, nearbyOnsets);
          warnForUnknownSounds(nearbyOnsets);

          const onsetCount = nearbyOnsets.length;

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
            } else if (onsetCount > 0) {
              transport.setStatus(`playing · ${warmed} instruments ready`);
            } else {
              transport.setStatus("playing");
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
      _evalInProgress = false;
      if (evalRequestId === playbackRequestId) {
        transport.setPlaybackState("idle");
      }
      throw err;
    }
  };

  // ─── Patched stop ──────────────────────────────────────────────────────

  editor.stop = function patchedStop(...args) {
    const state = transportEl?.dataset.transportState ?? "idle";
    playbackRequestId += 1;
    const result = _editorStop(...args);
    clearError(editor.editor);
    resetRuntimeErrors();
    transport.setPlaybackState("idle");
    if (state === "queued" || state === "loading") {
      transport.setStatus("play canceled");
    } else {
      transport.setStatus("Stopped");
    }
    return result;
  };

  // ─── Strudel.log → console panel bridge ────────────────────────────────
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
      if (type === "error") {
        // Only count as runtime error when NOT mid-eval. Eval-time errors
        // land in strudel.log too (logger fires before onEvalError), but
        // those are handled by onEvalError → inline marks, not the badge.
        if (!_evalInProgress && editor.repl?.scheduler?.started) {
          // Try to show inline mark for runtime errors that carry line data
          // (e.g. mini-notation parse errors that surface mid-playback).
          const located = setError(editor.editor, { message });
          // Pass located line to the console so it can render a [line N]
          // badge even for errors found via the content-based heuristic.
          let entryData = data;
          if (located) {
            if (
              entryData &&
              typeof entryData === "object" &&
              !Array.isArray(entryData)
            ) {
              entryData = { ...entryData, line: located.line };
            } else {
              entryData = { line: located.line };
            }
            if (located.column != null) entryData.column = located.column;
          }
          const entryId = consolePanel.error(message, entryData);
          registerRuntimeError(entryId);
        } else {
          consolePanel.error(message, data);
        }
      } else if (type === "warning") consolePanel.warn(message, data);
      else consolePanel.log(message, data);
    } catch (panelErr) {
      console.warn("[strasbeat/console] dispatch failed:", panelErr);
    }
  });

  return {
    handleEvalError,
    resetRuntimeErrors,
    dismissRuntimeErrors,
    getActiveTransportError: () => activeTransportError,
  };
}
