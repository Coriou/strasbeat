import { shouldIgnoreStrudelLog } from "./strudel-logger.js";
import { track } from "./analytics.js";
import {
  isExportRunning as defaultIsExportRunning,
  LIVE_MAX_POLYPHONY,
} from "./export.js";
import {
  classifyStrudelLog,
  createEvalSequencer,
  createMessageCoalescer,
  describeEvalError,
  hasExternalOutput,
  isVisualsCode,
  optInHintForError,
} from "./eval-state.js";
import { parseArrangements } from "./editor/arrange-parse.js";
import {
  primeArrangementParser,
  resetRegistry as resetArrangeRegistry,
  beginEvaluate as beginArrangeEvaluate,
  endEvaluate as endArrangeEvaluate,
  markEvalAppliedFor as markArrangeEvalAppliedFor,
} from "./strudel-ext/arrange.js";
import { holdVisualsForStart } from "./strudel-ext/visuals-host.js";

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
  getEvalOwner = () => null,
  getBootFailures = () => [],
  isExportRunning = defaultIsExportRunning,
  // The editor's first-frame evaluate (StrudelMirror.drawFirstFrame), which
  // goes into the repl at boot without passing through the patched evaluate.
  firstFrame = null,
  // Injectable for tests; see createEvalSequencer.
  abandonWaitMs,
}) {
  // ─── State ───────────────────────────────────────────────────────────────
  let _firstEvalDone = false;
  let runtimeErrorCount = 0;
  let activeTransportError = null;
  // Unknown sound name → console entry id of the warning already printed for
  // it, so re-evaluating the same typo doesn't repeat the console line.
  let warnedUnknownSounds = new Map();
  // The evaluate currently inside the repl, or null. handleEvalError marks
  // it failed (the repl catches eval errors internally and never throws);
  // while it is set, strudel.log errors are eval errors (handled by
  // onEvalError + inline marks), not runtime errors.
  let activeRun = null;
  // Which evaluate / stop request is the latest, and whose turn it is.
  const sequencer = createEvalSequencer({ after: firstFrame, abandonWaitMs });
  // Newest evaluate whose pattern reached the scheduler — see the
  // out-of-order guard in patchedEvaluate.
  let lastInstalled = null;
  // Sounds whose buffers have already been fetched + decoded this session.
  const warmedSounds = new Set();
  // Per-hap failures repeat many times a second; show each message once.
  // Errors and warnings are budgeted separately so a flood of distinct
  // warnings can never use up the room a later error needs.
  const runtimeErrors = createMessageCoalescer();
  const runtimeWarnings = createMessageCoalescer();
  let audioInit = null;
  // True while patchedEvaluate is starting the scheduler. The clock runs its
  // first tick synchronously inside start(), before `started` flips, and an
  // error raised by that tick is as much a playback error as any later one.
  let startingPlayback = false;
  // Start-intent holds on the visuals host taken by evaluates still in
  // flight (see holdVisualsForStart). A stop voids all of them.
  const visualsHolds = new Set();

  const _editorEvaluate = editor.evaluate.bind(editor);
  const _editorStop = editor.stop.bind(editor);

  // ─── Error tracking ─────────────────────────────────────────────────────

  function resetRuntimeErrors() {
    runtimeErrorCount = 0;
    runtimeErrors.reset();
    runtimeWarnings.reset();
    activeTransportError = null;
    transport?.clearErrorState();
  }

  function dismissRuntimeErrors() {
    runtimeErrorCount = 0;
    runtimeErrors.reset();
    runtimeWarnings.reset();
    if (activeTransportError?.source === "runtime") {
      activeTransportError = null;
      transport?.clearErrorState();
    }
  }

  function registerEvalError(err, entryId, located, hint = null) {
    const message = readErrorMessage(err);
    const isSyntaxError =
      err?.name === "SyntaxError" ||
      Boolean(err?.loc) ||
      /\[mini\]\s*parse error/i.test(message);

    showTransportError({
      source: "eval",
      kind: isSyntaxError ? "parse" : "eval",
      label: isSyntaxError ? "syntax error" : "eval error",
      title: `Open console: ${firstLine(message) || "error"}${hint ? ` — ${hint}` : ""}`,
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

  // Non-fatal findings from an evaluate that otherwise succeeded (unknown
  // sound, silent pattern, a helper's misuse warning). They reuse the error
  // badge so they are visible with the console panel closed; a real error
  // raised later replaces them.
  function showTransportWarning({ label, title, entryId = null }) {
    if (activeTransportError && activeTransportError.source !== "warning") {
      return;
    }
    showTransportError({
      source: "warning",
      kind: "warning",
      label,
      title,
      entryId,
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

  // Each returns a notice ({ label, message, entryId }) for the transport
  // badge + status, or null when there is nothing to report.

  function checkPatternStartsSilent(code, nearbyOnsets) {
    if (nearbyOnsets.length > 0) return null;
    if (isExplicitSilencePattern(code)) return null;
    // Visuals-only buffers (Hydra / shader) are silent on purpose.
    if (isVisualsCode(code)) return null;
    const message =
      "Pattern evaluated but produced no sound events in the first 4 cycles. Check your sound names and pattern structure.";
    const entryId = consolePanel?.warn(message) ?? null;
    return { label: "no sound", message: "no sound events", entryId };
  }

  function checkUnknownSounds(haps) {
    const soundMapObj = soundMap.get() ?? {};
    const unknownSounds = new Set();

    for (const hap of haps) {
      // `.midi()` / `.osc()` layers name sounds on the receiving device.
      if (hasExternalOutput(hap)) continue;
      const soundKey = soundKeyFromHap(hap);
      if (!soundKey) continue;
      if (!soundMapObj[soundKey.toLowerCase()]) {
        unknownSounds.add(soundKey);
      }
    }

    const nextWarned = new Map();
    for (const soundName of unknownSounds) {
      if (warnedUnknownSounds.has(soundName)) {
        nextWarned.set(soundName, warnedUnknownSounds.get(soundName));
        continue;
      }
      const suggestions = findSoundSuggestions(soundName);
      const message = suggestions.length
        ? `Sound "${soundName}" not found. Did you mean: ${suggestions.join(", ")}?`
        : `Sound "${soundName}" not found. Use strasbeat.findSounds('${soundName}') in the console to search.`;
      nextWarned.set(soundName, consolePanel?.warn(message) ?? null);
    }
    warnedUnknownSounds = nextWarned;

    if (unknownSounds.size === 0) return null;
    const [first] = unknownSounds;
    const summary =
      unknownSounds.size === 1
        ? `unknown sound "${first}"`
        : `${unknownSounds.size} unknown sounds`;
    return {
      label: unknownSounds.size === 1 ? "unknown sound" : summary,
      message: summary,
      entryId: nextWarned.get(first) ?? null,
    };
  }

  // ─── onEvalError handler (wired via forward-ref from StrudelMirror) ────

  function handleEvalError(err) {
    if (activeRun) activeRun.hadError = true;
    const located = setError(editor.editor, err);
    let entryId = null;
    const message = err?.message || String(err);
    // "x is not a function" for a function that lives in an opt-in package
    // is a dead end unless we say where to switch it on.
    const hint = optInHintForError(message);
    try {
      // When the content-based heuristic found a line, pass it as
      // structured data so the console panel can render a [line N] badge
      // even for errors that don't carry line numbers natively.
      const data = { error: err };
      if (located) data.line = located.line;
      if (located?.column != null) data.column = located.column;
      entryId =
        consolePanel?.error(hint ? `${message} — ${hint}` : message, data) ??
        null;
    } catch (panelErr) {
      console.warn("[strasbeat/console] error() failed:", panelErr);
    }
    registerEvalError(err, entryId, located, hint);
    // The status element is the app's polite live region, so this is also
    // what announces the failure to a screen reader.
    const summary = describeEvalError(
      firstLine(located?.message ?? message),
      located ?? extractErrorLine(err),
    );
    transport?.setStatus(hint ? `${summary} — ${hint}` : summary);
  }

  // ─── Audio init ────────────────────────────────────────────────────────
  // superdough's first-gesture hook (initAudioOnFirstClick, see boot.js)
  // only listens for `mousedown`. A keyboard-first play — Cmd/Ctrl+Enter in
  // an editor that already has focus — would otherwise run before the
  // AudioWorklets were ever registered, and a click on Play would race
  // their loading. initAudio is idempotent, so run it once ourselves and
  // let the first evaluate wait for it.
  function ensureAudioInit() {
    if (!audioInit) {
      audioInit = Promise.resolve()
        .then(() => initAudio({ maxPolyphony: LIVE_MAX_POLYPHONY }))
        .catch((err) => {
          audioInit = null;
          console.warn("[strasbeat] audio init failed:", err);
        });
    }
    return audioInit;
  }

  // ─── Patched evaluate ──────────────────────────────────────────────────
  //
  // Resolves to an outcome instead of the repl's (always undefined) result,
  // because the repl swallows eval errors and callers such as the WAV
  // export must be able to tell "evaluated" from "kept the previous pattern":
  //
  //   { status, started, owner }
  //     status  "ok"         the buffer was evaluated and installed
  //             "error"      the buffer failed to evaluate (see the badge)
  //             "empty"      nothing to evaluate
  //             "blocked"    refused: a WAV export owns the audio context
  //             "superseded" a newer evaluate replaced this one
  //             "cancelled"  stop was pressed before this one could start
  //     started whether the scheduler is running afterwards
  //     owner   getEvalOwner() at the moment the buffer was read
  //
  // The repl is always called with autostart = false; starting the scheduler
  // is decided here, after the user's (possibly slow, async) code has run,
  // and only for the request that is still the latest. That is what makes
  // stop / cancel during a slow evaluate final.

  editor.evaluate = async function patchedEvaluate(...args) {
    // Strudel's evaluate(play = true) — the export pipeline passes `false`
    // to compile without playing.
    const autostart = args[0] !== false;
    const schedulerStarted = () => !!editor.repl?.scheduler?.started;
    const outcome = (status, extra) => ({
      status,
      started: schedulerStarted(),
      owner: null,
      ...extra,
    });

    // While an export renders, superdough's audio context IS the offline
    // context being rendered: starting the scheduler now would schedule
    // live haps into the WAV. The export's own evaluate(false) still passes.
    if (autostart && isExportRunning()) {
      transport.setStatus("Export in progress — play again when it finishes");
      return outcome("blocked");
    }

    const token = sequencer.request();
    const dropped = () =>
      outcome(sequencer.wasStopped(token) ? "cancelled" : "superseded");
    // Only count true plays as engagement.
    if (autostart) track("pattern_played");

    let release = null;
    let releaseVisuals = null;
    try {
      // If prebake is still in progress, keep Play live and queue the start.
      if (!getBootReady()) {
        transport.setPlaybackState("queued");
        transport.setStatus("Loading sounds…");
        await bootPromise;
        if (!sequencer.isCurrent(token)) return dropped();
      }

      transport.setPlaybackState("loading");
      // Replace whatever the status said before ("Stopped", an old error) —
      // a slow evaluate can sit here for a while.
      if (autostart && !schedulerStarted()) transport.setStatus("starting…");
      // Queued behind an evaluate that is still running (slow or stalled
      // top-level await): say so, whatever the scheduler is doing, and how
      // to get out.
      if (sequencer.isBusy()) {
        transport.setStatus(
          "waiting for the previous evaluate to finish — stop to cancel",
        );
      }

      // One evaluate inside the repl at a time; a request that was replaced
      // while it waited for its turn never runs.
      release = await sequencer.enter();
      if (!sequencer.isCurrent(token)) return dropped();

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
          await initAudio({ maxPolyphony: LIVE_MAX_POLYPHONY });
        } else if (ac.state === "suspended") {
          await ac.resume();
        }
      } catch (err) {
        console.warn("[strasbeat] audio context health check failed:", err);
      }
      if (autostart) await ensureAudioInit();
      if (!sequencer.isCurrent(token)) return dropped();

      // Snapshot the buffer text driving this evaluate so we can tag
      // the arrange registry with it after success. The UI uses that tag
      // to decide whether to trust the registry or fall back to parser
      // preview when the buffer drifts from what was last played.
      const code = editor.code ?? "";
      const owner = getEvalOwner();

      // The repl throws on an empty buffer (outside its own error
      // handling), which used to surface as an unhandled rejection only.
      if (!code.trim()) {
        // Marks and badge from the previous buffer no longer apply.
        clearError(editor.editor);
        resetRuntimeErrors();
        transport.setPlaybackState(schedulerStarted() ? "playing" : "idle");
        transport.setStatus("Nothing to play — the editor is empty");
        return outcome("empty", { owner });
      }

      try {
        consolePanel?.divider(getCurrentName() || "eval");
      } catch (err) {
        console.warn("[strasbeat/console] divider failed:", err);
      }
      const run = { hadError: false, warnings: [] };
      activeRun = run;
      // Reset badge at eval start — new eval = fresh error slate.
      resetRuntimeErrors();

      // Arrange wrapper: parse source for labels, hand them to the
      // wrapper via a FIFO queue, reset the runtime registry. The
      // wrapper (src/strudel-ext/arrange.js) will dequeue one entry
      // per arrange() call during evaluate. Solo state is NOT reset —
      // it's sticky so users can iterate on a soloed section and so
      // WAV export respects the soloed selection. beginEvaluate() /
      // endEvaluate() bracket the call so validateSolo can't clear
      // a valid solo during the transient empty-registry window.
      try {
        const parsed = parseArrangements(code);
        primeArrangementParser(parsed);
        resetArrangeRegistry();
        beginArrangeEvaluate();
      } catch (err) {
        console.warn("[strasbeat/arrange] failed to prime parser:", err);
      }

      // The repl is about to report "evaluate settled, scheduler idle",
      // which is when the visuals host discards what a silent evaluate
      // built. A play is not a silent evaluate: hold the layers until the
      // start decision below has been made (released in the finally).
      if (autostart) {
        releaseVisuals = holdVisualsForStart();
        visualsHolds.add(releaseVisuals);
      }

      try {
        await _editorEvaluate(false, ...args.slice(1));
      } finally {
        if (activeRun === run) activeRun = null;
        try {
          endArrangeEvaluate();
          if (!run.hadError) markArrangeEvalAppliedFor(code);
        } catch (err) {
          console.warn("[strasbeat/arrange] endEvaluate failed:", err);
        }
      }

      if (run.hadError) {
        // Eval failed — skip post-eval diagnostics (prewarm, silence
        // detection, sound validation). The error is already surfaced by
        // handleEvalError. If the scheduler is still running the old
        // pattern, stay "playing"; otherwise revert to "idle".
        if (sequencer.isCurrent(token)) {
          transport.setPlaybackState(schedulerStarted() ? "playing" : "idle");
        }
        return outcome("error", { owner });
      }

      // Out-of-order guard. Evaluates normally finish in request order, but
      // a stop abandons the one in flight; if that one finishes after a
      // newer evaluate it has just put its (older) pattern into the
      // scheduler. Put the newer one back.
      if (lastInstalled && token.id < lastInstalled.id) {
        console.warn(
          "[strasbeat] a cancelled evaluate finished late — keeping the newer pattern",
        );
        try {
          await editor.repl.setPattern(lastInstalled.pattern, false);
        } catch (err) {
          console.warn("[strasbeat] failed to restore the newer pattern:", err);
        }
        return dropped();
      }
      lastInstalled = { id: token.id, pattern: editor.repl?.state?.pattern };

      // Replaced or cancelled while the user's code was running: the
      // pattern is installed, but this request no longer decides anything —
      // in particular it must not start the scheduler.
      if (!sequencer.isCurrent(token)) return dropped();

      if (autostart && !schedulerStarted()) {
        startingPlayback = true;
        try {
          await editor.repl.scheduler.start();
        } finally {
          startingPlayback = false;
        }
      }
      const started = schedulerStarted();
      transport.setPlaybackState(started ? "playing" : "idle");

      // Only clear inline marks on success — on failure, onEvalError
      // already called setError.
      clearError(editor.editor);

      try {
        soundBrowser.setBufferText(code);
      } catch (err) {
        console.warn("[strasbeat/sound-browser] in-use scan failed:", err);
      }
      try {
        referencePanel.setBufferText(code);
      } catch (err) {
        console.warn("[strasbeat/reference-panel] in-use scan failed:", err);
      }

      // Post-eval diagnostics + pre-warm. One query of the first 4 cycles
      // feeds the silence check, the unknown-sound check and the pre-warm.
      // The scheduler is already running at this point: the pre-warm does
      // not hold back cycle 1, it only front-loads the fetch + decode of
      // every sound in the lookahead so later cycles don't drop instruments
      // that are still loading.
      try {
        const pattern = editor.repl?.state?.pattern;
        const cps = editor.repl?.scheduler?.cps ?? 1;
        if (pattern) {
          const haps = pattern.queryArc(0, 4, { _cps: cps });
          const onsets = collectOnsets(haps);

          // Most specific first: a helper that explained its own misuse
          // beats the generic "no sound events" it usually causes.
          const notices = [
            ...run.warnings,
            checkUnknownSounds(onsets),
            checkPatternStartsSilent(code, onsets),
          ].filter(Boolean);
          const notice = notices[0] ?? null;
          if (notice) {
            showTransportWarning({
              label:
                notices.length === 1
                  ? notice.label
                  : `${notices.length} warnings`,
              title: `Open console: ${notices.map((n) => n.message).join(" · ")}`,
              entryId: notice.entryId,
            });
          }

          // Every successful evaluate rewrites the status so it can't go
          // stale ("Stopped" while playing, an old instrument count…).
          const playing = started && autostart;
          if (notice) {
            transport.setStatus(
              playing ? `playing · ${notice.message}` : notice.message,
            );
          } else if (playing) {
            transport.setStatus("playing");
          }

          // Sounds warmed earlier in the session are cached by superdough;
          // skip them so a live re-evaluate (beat grid, mute/solo, every
          // Cmd+Enter) doesn't build a throwaway voice per sound.
          const firstPlay = playing && !_firstEvalDone;
          if (firstPlay) {
            _firstEvalDone = true;
            if (!notice) transport.setStatus("loading instruments…");
          }
          prewarmSounds(
            haps,
            { getSound, getAudioContext },
            { skip: warmedSounds },
          )
            .then(({ warmed, failed, warmedKeys = [] }) => {
              for (const key of warmedKeys) warmedSounds.add(key);
              if (failed.length) {
                console.warn(
                  `[strasbeat/prewarm] ${failed.length} sound(s) failed to warm:`,
                  failed,
                );
              }
              if (!firstPlay || notice) return;
              if (!sequencer.isCurrent(token) || !schedulerStarted()) return;
              if (failed.length) {
                transport.setStatus(
                  `playing · ${failed.length} sound(s) couldn't load`,
                );
              } else if (warmed > 0) {
                transport.setStatus(`playing · ${warmed} instruments ready`);
              } else {
                transport.setStatus("playing");
              }
            })
            .catch((err) =>
              console.warn("[strasbeat/prewarm] background warm failed:", err),
            );
        }
      } catch (err) {
        console.warn("[strasbeat/prewarm] failed to kick off pre-warm:", err);
      }

      return outcome("ok", { owner });
    } catch (err) {
      // Anything that escapes the repl's own error handling (it reports
      // eval errors through onEvalError and does not throw). Most callers —
      // keymaps, toolbar buttons, the bars — don't await or catch, so a
      // rejection here would be an unhandled one with nothing on screen.
      console.error("[strasbeat] evaluate failed:", err);
      const message = readErrorMessage(err) || "evaluate failed";
      try {
        consolePanel?.error(message, { error: err });
      } catch (panelErr) {
        console.warn("[strasbeat/console] error() failed:", panelErr);
      }
      if (sequencer.isCurrent(token)) {
        transport.setPlaybackState(schedulerStarted() ? "playing" : "idle");
        transport.setStatus(describeEvalError(message));
      }
      return outcome("error");
    } finally {
      release?.();
      if (releaseVisuals) {
        visualsHolds.delete(releaseVisuals);
        releaseVisuals();
      }
    }
  };

  // ─── Patched stop ──────────────────────────────────────────────────────

  editor.stop = function patchedStop(...args) {
    const state = transportEl?.dataset.transportState ?? "idle";
    // Invalidates every evaluate requested so far: one that is still
    // waiting never runs, one that is mid-flight will not start playback.
    sequencer.stop();
    // Nothing still in flight is going to start playback any more — and an
    // evaluate that never settles must not keep its hold forever.
    for (const releaseHold of visualsHolds) releaseHold();
    visualsHolds.clear();
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
  // superdough's own messages arrive here too (strudel-logger.js forwards
  // them), so a sample that fails to load is no longer devtools-only.
  document.addEventListener("strudel.log", (e) => {
    if (!consolePanel) return;
    const detail = e?.detail ?? {};
    const type = typeof detail.type === "string" ? detail.type : "";
    const message = detail.message ?? "";
    const data = detail.data ?? null;
    if (shouldIgnoreStrudelLog(message)) return;
    try {
      // errorLogger() — every scheduler-time failure — logs WITHOUT a type,
      // so classify on the message shape as well.
      const level = classifyStrudelLog(message, type);
      if (level === "log") {
        consolePanel.log(message, data);
        return;
      }

      if (activeRun) {
        // Mid-eval. Errors land here too (logger fires before onEvalError)
        // but are handled by onEvalError → inline marks, not the badge.
        // Warnings raised by the pattern's own code (e.g. progression()
        // misuse) are collected so the evaluate can badge them.
        if (level === "error") {
          consolePanel.error(message, data);
        } else {
          const entryId = consolePanel.warn(message, data);
          activeRun.warnings.push({
            label: "warning",
            message: firstLine(message),
            entryId,
          });
        }
        return;
      }

      // Outside an evaluate these come from the scheduler / audio engine
      // and repeat for every hap of a broken pattern. Print each distinct
      // message once; repeats are only counted.
      const playing = startingPlayback || editor.repl?.scheduler?.started;
      if (level === "warning") {
        const seen = runtimeWarnings.note(message);
        if (seen === "first") {
          consolePanel.warn(message, data);
        } else if (seen === "overflow-first") {
          consolePanel.warn(
            "Too many different runtime warnings — further ones are hidden until the next evaluate or stop.",
          );
        }
        return;
      }

      const seen = runtimeErrors.note(message);
      if (seen === "repeat" || seen === "overflow") return;
      if (seen === "overflow-first") {
        // Never drop an error without a trace: say that some are hidden,
        // as an error row, and keep the badge up for them.
        const entryId = consolePanel.error(
          "Too many different runtime errors — further ones are hidden until the next evaluate or stop.",
        );
        if (playing) registerRuntimeError(entryId);
        return;
      }

      if (playing) {
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
    } catch (panelErr) {
      console.warn("[strasbeat/console] dispatch failed:", panelErr);
    }
  });

  // ─── Boot load failures ────────────────────────────────────────────────
  // The boot status line ("Ready with N load warnings") is overwritten by
  // the first play. Keep a durable record of what didn't load, and what
  // that silences, where the user will look when a sound is missing.
  Promise.resolve(bootPromise)
    .then(() => {
      const failures = getBootFailures() ?? [];
      if (!failures.length) return;
      let firstEntryId = null;
      for (const failure of failures) {
        const entryId = consolePanel?.warn(
          `Couldn't load ${failure.label}${failure.reason ? ` (${failure.reason})` : ""} — ${failure.affects} Reload the page to retry.`,
        );
        firstEntryId ??= entryId ?? null;
      }
      showTransportWarning({
        label:
          failures.length === 1
            ? "load warning"
            : `${failures.length} load warnings`,
        title: `Open console: couldn't load ${failures.map((f) => f.label).join(", ")}`,
        entryId: firstEntryId,
      });
    })
    .catch((err) =>
      console.warn("[strasbeat] failed to report boot failures:", err),
    );

  return {
    handleEvalError,
    resetRuntimeErrors,
    dismissRuntimeErrors,
    getActiveTransportError: () => activeTransportError,
  };
}
