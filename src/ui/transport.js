// Transport bar — owns the cps/bpm + cycle + playhead readouts and the
// status / midi pill text. The play, stop, capture and roll-toggle buttons
// already live in the static HTML (so main.js can attach the existing
// handlers without re-querying through this component); transport.js
// only owns the readouts that need a live data source.
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

/**
 * @param {object} opts
 * @param {() => any} opts.getScheduler   returns editor.repl.scheduler (or null)
 * @returns {{ kick: () => void, setStatus: (s: string) => void, setMidiStatus: (s: {ok: boolean, msg: string}) => void, setCaptureState: (s: {recording: boolean, count?: number}) => void, dispose: () => void }}
 */
export function mountTransport({ getScheduler }) {
  const bpmEl = mustEl("bpm-readout");
  const cycleEl = mustEl("cycle-readout");
  const playheadEl = mustEl("playhead-dot");
  const playheadBar = playheadEl.parentElement;
  const statusEl = mustEl("status");
  const midiPillEl = mustEl("midi-status");
  const captureBtn = mustEl("capture");
  const captureBadge = mustEl("capture-count");

  // Last-rendered values, to skip unnecessary DOM writes.
  let lastBpm = NaN;
  let lastCycleText = "";
  let lastPct = -1;
  let lastIdle = null;

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
      bpmEl.textContent = bpm > 0 ? `${bpm} bpm` : "– bpm";
    }
    // Cycle text — show 1 decimal so the eye sees motion.
    const cycText = started ? `cyc ${cycle.toFixed(1)}` : "cyc –";
    if (cycText !== lastCycleText) {
      lastCycleText = cycText;
      cycleEl.textContent = cycText;
    }
    // Playhead position within the current cycle, in [0, 1).
    const pos = ((cycle % 1) + 1) % 1;
    const pct = Math.round(pos * 1000) / 10; // 1-decimal % to keep DOM writes coarse
    if (pct !== lastPct) {
      lastPct = pct;
      playheadEl.style.left = `${pct}%`;
    }
    const idle = !started;
    if (idle !== lastIdle) {
      lastIdle = idle;
      playheadBar.classList.toggle("transport__playhead--idle", idle);
    }
  }

  function kick() {
    if (raf != null) return;
    raf = requestAnimationFrame(tick);
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setMidiStatus({ ok, msg }) {
    midiPillEl.textContent = msg;
    midiPillEl.classList.toggle("is-ok", ok === true);
    midiPillEl.classList.toggle("is-err", ok === false);
  }

  function setCaptureState({ recording, count }) {
    captureBtn.classList.toggle("recording", !!recording);
    captureBtn.setAttribute("aria-pressed", recording ? "true" : "false");
    if (count != null) captureBadge.textContent = String(count);
    if (!recording) captureBadge.textContent = "";
  }

  function dispose() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
    clearInterval(poll);
  }

  return { kick, setStatus, setMidiStatus, setCaptureState, dispose };
}

function mustEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`transport.mount: missing #${id} in DOM`);
  return el;
}
