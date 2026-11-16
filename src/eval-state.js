// Pure state + classification helpers behind the patched evaluate/stop in
// eval-feedback.js. Nothing here touches the DOM, the audio context or the
// repl, so the rules that decide "may this evaluate start the scheduler?"
// can be unit-tested without a browser.

/**
 * Sequencer for evaluate / stop requests.
 *
 * Every evaluate request and every stop bumps one generation counter. A
 * request is "current" while nothing newer has been asked for; only a
 * current request is allowed to start the scheduler or write its result to
 * the UI. A stop additionally remembers the generation it happened at, so a
 * request can tell "replaced by a newer evaluate" from "the user cancelled".
 *
 * Requests also run one at a time: `enter()` resolves when the previous
 * evaluate has finished. Two evaluates inside the repl at once would share
 * its `$:` pattern table and the arrange registry and corrupt both. A stop
 * abandons whatever is still in flight and wakes every request waiting for
 * its turn (see `stop()`), so an evaluate whose top-level `await` never
 * settles cannot lock the transport — or anything queued behind it, such as
 * the WAV export's compile-only evaluate.
 */
export function createEvalSequencer() {
  let generation = 0;
  let stopGeneration = 0;
  let tail = Promise.resolve();
  let tailOpen = false; // is the tail an evaluate that has not finished?
  // Resolved (and replaced) by every stop; `enter()` races it so requests
  // already waiting behind a stalled evaluate are let go as well.
  let wakeWaiters;
  let stopped = new Promise((resolve) => {
    wakeWaiters = resolve;
  });

  return {
    /** Register a new evaluate request and return its token. */
    request() {
      return { id: ++generation };
    },
    /** Register a stop. Supersedes every request made so far. */
    stop() {
      stopGeneration = ++generation;
      // Don't make the next play wait behind an evaluate the user just
      // cancelled — it may be stuck on a fetch that never returns.
      tail = Promise.resolve();
      tailOpen = false;
      // Requests already waiting hold the old tail; wake them too. They are
      // no longer current, so their callers drop them as cancelled.
      wakeWaiters();
      stopped = new Promise((resolve) => {
        wakeWaiters = resolve;
      });
    },
    /** True while no newer evaluate or stop has been requested. */
    isCurrent(token) {
      return token.id === generation;
    },
    /** True when a stop was requested after this evaluate. */
    wasStopped(token) {
      return token.id < stopGeneration;
    },
    /**
     * Wait for the previous evaluate to finish, or for a stop. Resolves to
     * a `release` function the caller MUST invoke (in a finally) when it is
     * done. After a stop the request is no longer current: check
     * `isCurrent()` before doing anything.
     */
    async enter() {
      const previous = tail;
      let finish;
      const mine = new Promise((resolve) => {
        finish = resolve;
      });
      tail = mine;
      tailOpen = true;
      await Promise.race([previous, stopped]);
      return () => {
        finish();
        if (tail === mine) tailOpen = false;
      };
    },
    /** True while a new request would have to wait for an earlier one. */
    isBusy() {
      return tailOpen;
    },
  };
}

/**
 * Should a tab take ownership of the scheduler after an evaluate?
 * Only when that evaluate was a play request, actually succeeded, and the
 * engine is running — a failed, cancelled or replaced evaluate started
 * nothing, so it must not mark its tab as the one playing.
 */
export function shouldClaimPlayback({ autostart, outcome, started }) {
  return Boolean(autostart && started && outcome?.status === "ok");
}

// Strudel's errorLogger() reports scheduler-time failures as an UNTYPED log
// line shaped "[origin] error: message" (core/logger.mjs, superdough/
// logger.mjs), so the log type alone can't tell an error from chatter.
const UNTYPED_ERROR_RE = /^\[[\w-]+\]\s*error\b/i;

/** Classify a strudel.log entry as "error" | "warning" | "log". */
export function classifyStrudelLog(message, type) {
  if (type === "error") return "error";
  if (type === "warning") return "warning";
  if (UNTYPED_ERROR_RE.test(String(message ?? ""))) return "error";
  return "log";
}

/**
 * Collapses repeated messages. A broken pattern raises the same error for
 * every hap (many per second); only the first occurrence of each distinct
 * message should reach the console panel and the badge.
 *
 * `note(message)` returns "first" for a new message, "repeat" for one seen
 * before, and "overflow" once more than `maxDistinct` different messages
 * have been seen (the first overflow returns "overflow-first" so the caller
 * can say so exactly once).
 */
export function createMessageCoalescer({ maxDistinct = 40 } = {}) {
  let counts = new Map();
  let overflowed = false;
  return {
    note(message) {
      const key = String(message ?? "");
      const seen = counts.get(key);
      if (seen != null) {
        counts.set(key, seen + 1);
        return "repeat";
      }
      if (counts.size >= maxDistinct) {
        if (overflowed) return "overflow";
        overflowed = true;
        return "overflow-first";
      }
      counts.set(key, 1);
      return "first";
    },
    count(message) {
      return counts.get(String(message ?? "")) ?? 0;
    },
    distinct() {
      return counts.size;
    },
    reset() {
      counts = new Map();
      overflowed = false;
    },
  };
}

// Functions that only exist once an opt-in package has been enabled in the
// Setup panel (src/user-setup.js OPT_IN_PACKAGES). Without the package they
// fail as a bare "x is not a function" / "x is not defined".
const OPT_IN_NAMES = {
  midi: "@strudel/midi",
  midin: "@strudel/midi",
  midikeys: "@strudel/midi",
  midimaps: "@strudel/midi",
  osc: "@strudel/osc",
  csound: "@strudel/csound",
  csoundm: "@strudel/csound",
  loadOrc: "@strudel/csound",
  loadCsound: "@strudel/csound",
  loadcsound: "@strudel/csound",
  loadCSound: "@strudel/csound",
  serial: "@strudel/serial",
  tune: "@strudel/xen",
  tuning: "@strudel/xen",
  xen: "@strudel/xen",
  edo: "@strudel/xen",
};

/**
 * If an eval error is a missing opt-in function, return a sentence telling
 * the user where to turn it on; otherwise null.
 */
export function optInHintForError(message) {
  const text = String(message ?? "");
  const match =
    text.match(/(?:^|[.\s(])(\w+) is not a function/) ??
    text.match(/(?:^|\s)(\w+) is not defined/);
  if (!match) return null;
  const name = match[1];
  if (!Object.hasOwn(OPT_IN_NAMES, name)) return null;
  return `"${name}" comes from the opt-in package ${OPT_IN_NAMES[name]} — enable it under Opt-in Packages in the Setup panel, then reload the page.`;
}

// Calls that produce picture rather than sound. A buffer built around them
// is legitimately silent, so the "no sound events" warning would be noise.
const VISUAL_CALL_RE = /\b(?:initHydra|shader)\s*\(/;

/** True when the code is expected to be silent (visuals-only buffers). */
export function isVisualsCode(code) {
  return VISUAL_CALL_RE.test(String(code ?? ""));
}

/**
 * True when a hap is routed to an external output (`.midi()`, `.osc()`,
 * `.csound()`…). Those set a dominant trigger, which makes the repl skip
 * the WebAudio output — their `s` names address the remote device, not our
 * sound map.
 */
export function hasExternalOutput(hap) {
  return Boolean(hap?.context?.onTrigger && hap.context.dominantTrigger);
}

/** One-line summary of an eval error for the transport status region. */
export function describeEvalError(message, location) {
  const text =
    String(message ?? "")
      .split(/\r?\n/, 1)[0]
      .trim() || "error";
  return Number.isInteger(location?.line)
    ? `Error on line ${location.line}: ${text}`
    : `Error: ${text}`;
}
