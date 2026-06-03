import { mountKeymapChip } from "./keymap-chip.js";

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

// Single transport button — its label / tooltip / aria-label per playback
// state. Idle invites play; every other state offers to stop (or cancel the
// pending start). The button's *icon* and *backlight* are pure CSS driven by
// the transport element's `data-transport-state`, so this table only owns the
// text. Shortcut hints are platform-aware: ⌘↵ plays, Ctrl+. stops (the stop
// binding is owned upstream by Strudel's keymap).
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const PLAY_HINT = IS_MAC ? "⌘↵" : "Ctrl+Enter";
const TOGGLE_PRESENTATION = {
  idle: {
    label: "Play",
    aria: `Play current pattern (${PLAY_HINT})`,
    title: `Play current pattern  ·  ${PLAY_HINT}`,
  },
  queued: {
    label: "Starting",
    aria: "Cancel queued playback",
    title: "Cancel queued playback",
  },
  loading: {
    label: "Starting",
    aria: "Cancel playback start",
    title: "Cancel playback start",
  },
  playing: {
    label: "Stop",
    aria: "Stop playback (Ctrl+.)",
    title: "Stop playback  ·  Ctrl+.",
  },
};

/**
 * @param {object} opts
 * @param {() => any} opts.getScheduler   returns editor.repl.scheduler (or null)
 * @param {() => AudioContext|null} [opts.getAudioContext]  returns the live AudioContext
 * @param {() => void} [opts.onErrorBadgeClick]  opens the current error context
 * @param {HTMLElement} [opts.rootEl]  element that should mirror the playback state as `data-playback` for cross-app CSS targeting (scope tint, roll dim, etc.)
 * @param {(state: "idle" | "queued" | "loading" | "playing") => void} [opts.onPlaybackStateChange]  fires when the visible playback state changes
 * @param {any} [opts.editor]  the StrudelMirror editor instance, forwarded to the keymap chip popover
 * @param {() => void} [opts.onEvaluate]  called to re-evaluate the pattern after a profile switch, forwarded to the chip
 * @param {(bank: string) => void} [opts.onBankChipClick]  called when the bank chip is clicked; receives the bank name
 * @returns {{ kick: () => void, setStatus: (s: string) => void, setMidiStatus: (s: {ok: boolean | null, msg: string, title?: string}) => void, setPlaybackState: (state: "idle" | "queued" | "loading" | "playing") => void, setErrorState: (s: {kind?: string, label: string, title?: string} | null) => void, clearErrorState: () => void, setBank: (name: string | null) => void, dispose: () => void }}
 */
export function mountTransport({
  getScheduler,
  getAudioContext,
  onErrorBadgeClick = () => {},
  rootEl = null,
  onPlaybackStateChange = () => {},
  editor = null,
  onEvaluate = null,
  onBankChipClick = null,
  onNowPlayingClick = null,
}) {
  const transportEl = mustEl("transport");
  const playBtn = mustEl("play");
  const playLabel = playBtn.querySelector(".transport__toggle-label");
  const bpmEl = mustEl("bpm-readout");
  const cycleEl = mustEl("cycle-readout");
  const playheadProgressEl = mustEl("playhead-progress");
  const playheadEl = mustEl("playhead-dot");
  const playheadBar = playheadEl.parentElement;
  const statusEl = mustEl("status");
  const midiPillEl = mustEl("midi-status");
  const rightGroupEl = midiPillEl.parentElement;

  const keymapChip = mountKeymapChip({ container: rightGroupEl, editor, onEvaluate });
  rightGroupEl.insertBefore(keymapChip.el, midiPillEl);

  const errorBadgeEl = document.createElement("button");
  errorBadgeEl.type = "button";
  errorBadgeEl.className = "transport__error-badge";
  errorBadgeEl.hidden = true;
  errorBadgeEl.addEventListener("click", () => onErrorBadgeClick());
  rightGroupEl.insertBefore(errorBadgeEl, midiPillEl);

  const bankChipEl = document.createElement("button");
  bankChipEl.type = "button";
  bankChipEl.className = "transport__bank-chip";
  bankChipEl.hidden = true;
  bankChipEl.addEventListener("click", () => onBankChipClick?.(bankChipEl.dataset.bank));
  rightGroupEl.insertBefore(bankChipEl, midiPillEl);

  // Now-playing chip — sibling to the bank chip. Names the tab that currently
  // owns scheduler audio when it differs from the focused tab (one-click jump),
  // or shows a "(closed)" orphan marker. Hidden when the playing tab is focused
  // or nothing plays. Visual treatment deferred to craft.
  const nowPlayingChipEl = document.createElement("button");
  nowPlayingChipEl.type = "button";
  nowPlayingChipEl.className = "transport__now-playing-chip";
  nowPlayingChipEl.hidden = true;
  // The name lives in its own span so it can ellipsize independently of the
  // CSS-drawn leading play glyph (a bare text node won't truncate in a flex
  // row). The "(closed)" orphan marker gets its own muted span.
  const nowPlayingLabelEl = document.createElement("span");
  nowPlayingLabelEl.className = "transport__now-playing-name";
  const nowPlayingOrphanEl = document.createElement("span");
  nowPlayingOrphanEl.className = "transport__now-playing-closed";
  nowPlayingOrphanEl.textContent = "closed";
  nowPlayingChipEl.append(nowPlayingLabelEl, nowPlayingOrphanEl);
  nowPlayingChipEl.addEventListener("click", () => onNowPlayingClick?.());
  rightGroupEl.insertBefore(nowPlayingChipEl, midiPillEl);

  // Last-rendered values, to skip unnecessary DOM writes.
  let lastBpm = NaN;
  let lastCycleText = "";
  let lastPct = -1;
  let lastIdle = null;
  let playbackState = "idle";
  let lastAppliedState = null;
  let lastAcWarning = ""; // debounce audio context health warnings
  let lastErrorSignature = "";

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

  function setErrorState(errorState) {
    const next = normalizeErrorState(errorState);
    if (!next) {
      clearErrorState();
      return;
    }

    const nextSignature = `${next.kind}|${next.label}|${next.title}`;
    if (nextSignature === lastErrorSignature) return;
    lastErrorSignature = nextSignature;

    errorBadgeEl.hidden = false;
    errorBadgeEl.dataset.errorKind = next.kind;
    errorBadgeEl.textContent = next.label;
    errorBadgeEl.setAttribute("aria-label", next.title);
    errorBadgeEl.title = next.title;
  }

  function clearErrorState() {
    if (!lastErrorSignature && errorBadgeEl.hidden) return;
    lastErrorSignature = "";
    errorBadgeEl.hidden = true;
    errorBadgeEl.textContent = "";
    errorBadgeEl.removeAttribute("data-error-kind");
    errorBadgeEl.removeAttribute("aria-label");
    errorBadgeEl.removeAttribute("title");
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
    if (rootEl) rootEl.dataset.playback = state;
    if (state !== lastAppliedState) {
      lastAppliedState = state;
      const pres = TOGGLE_PRESENTATION[state] ?? TOGGLE_PRESENTATION.idle;
      if (playLabel) playLabel.textContent = pres.label;
      playBtn.setAttribute("aria-label", pres.aria);
      playBtn.title = pres.title;
      try {
        onPlaybackStateChange(state);
      } catch (err) {
        console.warn("[strasbeat/transport] onPlaybackStateChange threw:", err);
      }
    }
  }

  function setBank(name) {
    if (!name) {
      bankChipEl.hidden = true;
      bankChipEl.removeAttribute("data-bank");
      return;
    }
    bankChipEl.hidden = false;
    bankChipEl.dataset.bank = name;
    bankChipEl.textContent = name;
    bankChipEl.title = `Active bank: ${name} — click to filter Sound browser`;
  }

  function setNowPlaying(info) {
    // info: null | { name: string, isFocused: boolean, isOrphan: boolean }
    if (!info || info.isFocused) {
      nowPlayingChipEl.hidden = true;
      nowPlayingChipEl.removeAttribute("data-orphan");
      return;
    }
    nowPlayingChipEl.hidden = false;
    nowPlayingChipEl.dataset.orphan = info.isOrphan ? "true" : "false";
    nowPlayingLabelEl.textContent = info.name;
    nowPlayingChipEl.title = info.isOrphan
      ? `Still playing "${info.name}" (closed) — click to reopen`
      : `Playing "${info.name}" — click to jump`;
  }

  function dispose() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
    clearInterval(poll);
    keymapChip.destroy();
  }

  return {
    kick,
    setStatus,
    setMidiStatus,
    setPlaybackState,
    setErrorState,
    clearErrorState,
    keymapChip,
    setBank,
    setNowPlaying,
    dispose,
  };
}

function normalizeErrorState(errorState) {
  if (!errorState || typeof errorState !== "object") return null;

  const label =
    typeof errorState.label === "string" ? errorState.label.trim() : "";
  if (!label) return null;

  const kind =
    typeof errorState.kind === "string" && errorState.kind.trim()
      ? errorState.kind.trim()
      : "runtime";
  const title =
    typeof errorState.title === "string" && errorState.title.trim()
      ? errorState.title.trim()
      : `Open console: ${label}`;

  return { kind, label, title };
}

function mustEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`transport.mount: missing #${id} in DOM`);
  return el;
}
