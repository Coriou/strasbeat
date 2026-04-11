// Transport bar — owns the cps/bpm + cycle + playhead readouts and the
// status / midi pill text. The play, stop and roll-toggle buttons already
// live in the static HTML (so main.js can attach the existing handlers
// without re-querying through this component); transport.js only owns the
// readouts that need a live data source.
// Capture/preset controls live in the MIDI bar (src/ui/midi-bar.js).
//
// See design/SYSTEM.md §3 and design/work/01-shell.md.
//
// Cps → bpm assumption
// --------------------
// Strudel's scheduler tracks `cps` (cycles per second). It does NOT carry
// a "beats per cycle" value — that's a user convention. The patterns in
// /patterns use `setcps(BPM/60/4)`, i.e. 4 beats per cycle, so the BPM
// readout uses `cps × 60 × 4`. If a future pattern uses a different
// convention, the displayed BPM will be off; that's expected and fixing
// it requires a pattern-level annotation we don't yet have. The cycle
// readout is the authoritative one for non-4/4 patterns.

const BEATS_PER_CYCLE = 4; // see comment above
const PLAYBACK_STATES = new Set(["idle", "queued", "loading", "playing"]);

/**
 * @param {object} opts
 * @param {() => any} opts.getScheduler   returns editor.repl.scheduler (or null)
 * @param {() => AudioContext|null} [opts.getAudioContext]  returns the live AudioContext
 * @param {() => void} [opts.onErrorBadgeClick]  opens the console for runtime errors
 * @returns {{ kick: () => void, setStatus: (s: string) => void, setMidiStatus: (s: {ok: boolean | null, msg: string, title?: string}) => void, setPlaybackState: (state: "idle" | "queued" | "loading" | "playing") => void, setErrorCount: (count: number) => void, clearErrorCount: () => void, dispose: () => void }}
 */
export function mountTransport({
  getScheduler,
  getAudioContext,
  onErrorBadgeClick = () => {},
}) {
  const transportEl = mustEl("transport");
  const stopBtn = mustEl("stop");
  const bpmEl = mustEl("bpm-readout");
  const cycleEl = mustEl("cycle-readout");
  const playheadProgressEl = mustEl("playhead-progress");
  const playheadEl = mustEl("playhead-dot");
  const playheadBar = playheadEl.parentElement;
  const statusEl = mustEl("status");
  const midiPillEl = mustEl("midi-status");
  const rightGroupEl = midiPillEl.parentElement;

  const errorBadgeEl = document.createElement("button");
  errorBadgeEl.type = "button";
  errorBadgeEl.className = "transport__error-badge";
  errorBadgeEl.hidden = true;
  errorBadgeEl.addEventListener("click", () => onErrorBadgeClick());
  rightGroupEl.insertBefore(errorBadgeEl, midiPillEl);

  // Last-rendered values, to skip unnecessary DOM writes.
  let lastBpm = NaN;
  let lastCycleText = "";
  let lastPct = -1;
  let lastIdle = null;
  let playbackState = "idle";
  let lastAcWarning = ""; // debounce audio context health warnings
  let lastErrorCount = 0;

  let raf = null;
  // Safety-net poll: catches the case where the scheduler starts via the
  // editor's Cmd+Enter keymap, which doesn't go through our play button.
  // 4Hz is plenty — once we detect started, we promote to rAF (60Hz).
  // Note: when the rAF chain is active, kick() no-ops because raf is
  // kept non-null through the chain (see tick()). The poll is harmless
  // while rAF is running.
  const POLL_INTERVAL_MS = 250;
  const poll = setInterval(() => {
    const sched = getScheduler();
    if (sched && sched.started && raf == null) {
      kick();
    } else if (!sched || !sched.started) {
      // Even when stopped, refresh once so the BPM readout matches the
      // last `setcps(...)` result and the playhead is parked.
      tick();
    }
  }, POLL_INTERVAL_MS);

  // Initial paint, so we don't show "– bpm" forever if the user never plays.
  tick();
  setPlaybackState("idle");

  function tick() {
    // Don't null raf at the top — keep it non-null so kick()'s guard
    // prevents the poll from spawning a second rAF chain (see Phase 3,
    // design/work/11-ui-hardening.md).
    const sched = getScheduler();
    if (!sched) {
      raf = null;
      writeReadouts({ cps: 0, cycle: 0, started: false });
      return;
    }
    const cps = typeof sched.cps === "number" ? sched.cps : 0;
    const cycle = typeof sched.now === "function" ? sched.now() : 0;
    const started = !!sched.started;
    writeReadouts({ cps, cycle, started });
    if (started) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = null;
    }
  }

  function writeReadouts({ cps, cycle, started }) {
    // BPM
    const bpm = Math.round(cps * 60 * BEATS_PER_CYCLE);
    if (bpm !== lastBpm) {
      lastBpm = bpm;
      bpmEl.textContent = bpm > 0 ? String(bpm) : "—";
    }
    // Cycle text — show 1 decimal so the eye sees motion.
    const cycText = started ? cycle.toFixed(1) : "—";
    if (cycText !== lastCycleText) {
      lastCycleText = cycText;
      cycleEl.textContent = cycText;
    }
    // Playhead position within the current cycle, in [0, 1).
    const pos = Number.isFinite(cycle) ? ((cycle % 1) + 1) % 1 : 0;
    const pct = Math.round(pos * 1000) / 10; // 1-decimal % to keep DOM writes coarse
    if (pct !== lastPct) {
      lastPct = pct;
      playheadProgressEl.style.width = `${pct}%`;
      playheadEl.style.left = `${pct}%`;
    }
    const idle = !started;
    if (idle !== lastIdle) {
      lastIdle = idle;
      playheadBar.classList.toggle("transport__playhead--idle", idle);
    }
    syncPlaybackState(started);

    // AudioContext health check — detect the "playing but no sound" state
    // where the scheduler reports started but the audio context is not
    // running (suspended by autoplay policy, closed after export, etc.).
    if (started && getAudioContext) {
      try {
        const ac = getAudioContext();
        if (ac && ac.state === "suspended" && lastAcWarning !== "suspended") {
          lastAcWarning = "suspended";
          setStatus("audio suspended — click the page to enable sound");
          console.warn(
            "[strasbeat/transport] scheduler is started but AudioContext is suspended",
          );
        } else if (ac && ac.state === "closed" && lastAcWarning !== "closed") {
          lastAcWarning = "closed";
          setStatus("audio context closed — reload to restore sound");
          console.warn(
            "[strasbeat/transport] scheduler is started but AudioContext is closed",
          );
        } else if (ac && ac.state === "running") {
          lastAcWarning = "";
        }
      } catch {
        // getAudioContext itself can throw during init — ignore.
      }
    }
  }

  function kick() {
    if (raf != null) return;
    raf = requestAnimationFrame(tick);
  }

  function setStatus(text) {
    statusEl.textContent = text;
    statusEl.title = text;
  }

  function setMidiStatus({ ok, msg, title }) {
    midiPillEl.textContent = msg;
    midiPillEl.title = title ?? msg;
    midiPillEl.setAttribute("aria-label", title ?? msg);
    midiPillEl.classList.toggle("is-idle", ok !== true && ok !== false);
    midiPillEl.classList.toggle("is-ok", ok === true);
    midiPillEl.classList.toggle("is-err", ok === false);
  }

  function setErrorCount(count) {
    const nextCount = Math.max(
      0,
      Number.isFinite(count) ? Math.trunc(count) : 0,
    );
    if (nextCount === lastErrorCount) return;
    lastErrorCount = nextCount;
    errorBadgeEl.hidden = nextCount === 0;
    if (nextCount === 0) {
      errorBadgeEl.textContent = "";
      errorBadgeEl.removeAttribute("aria-label");
      errorBadgeEl.removeAttribute("title");
      return;
    }
    const label = `${nextCount} error${nextCount === 1 ? "" : "s"}`;
    errorBadgeEl.textContent = label;
    errorBadgeEl.setAttribute("aria-label", `Open console: ${label}`);
    errorBadgeEl.title = `Open console: ${label}`;
  }

  function clearErrorCount() {
    setErrorCount(0);
  }

  function syncPlaybackState(started) {
    if (started && playbackState !== "playing") {
      playbackState = "playing";
    } else if (!started && playbackState === "playing") {
      playbackState = "idle";
    }
    applyPlaybackState(playbackState);
  }

  function setPlaybackState(state) {
    playbackState = PLAYBACK_STATES.has(state) ? state : "idle";
    syncPlaybackState(!!getScheduler()?.started);
  }

  function applyPlaybackState(state) {
    transportEl.dataset.transportState = state;
    stopBtn.disabled = state === "idle";
    if (state === "queued") {
      stopBtn.title = "Cancel queued playback";
      stopBtn.setAttribute("aria-label", "Cancel queued playback");
    } else if (state === "loading") {
      stopBtn.title = "Cancel playback start";
      stopBtn.setAttribute("aria-label", "Cancel playback start");
    } else {
      stopBtn.title = "Stop playback (Ctrl+. or Alt+.)";
      stopBtn.setAttribute("aria-label", "Stop playback");
    }
  }

  function dispose() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
    clearInterval(poll);
  }

  return {
    kick,
    setStatus,
    setMidiStatus,
    setPlaybackState,
    setErrorCount,
    clearErrorCount,
    dispose,
  };
}

function mustEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`transport.mount: missing #${id} in DOM`);
  return el;
}
