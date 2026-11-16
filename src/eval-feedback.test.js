// Run with: node --import ./scripts/test-register.mjs --test src/eval-feedback.test.js
//
// Drives the patched editor.evaluate / editor.stop against the REAL
// @strudel/core repl + scheduler (no audio: the output is a no-op), with the
// UI collaborators stubbed. These are the lifecycle rules that are easy to
// break and impossible to see in a diff: cancel is final, evaluates don't
// overlap, a failed evaluate is not a success.

import { describe, test, before, afterEach } from "node:test";
import assert from "node:assert/strict";

// eval-feedback and Strudel's logger talk through DOM events on `document`.
const listeners = {};
globalThis.document = {
  addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
  dispatchEvent: (event) => {
    (listeners[event.type] ?? []).forEach((fn) => fn(event));
    return true;
  },
};
globalThis.CustomEvent = class {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};
globalThis.window = { addEventListener() {} };

// Strudel logs every message with a styled console.log, and console.error's
// eval errors in full — both are expected here and would bury the results.
const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("%c")) return;
  realLog(...args);
};
console.error = () => {};
console.warn = () => {};

const core = await import("@strudel/core");
const mini = await import("@strudel/mini");
const arrangeExt = await import("./strudel-ext/arrange.js");
const { transpiler } = await import("./transpiler-patch.js");
const { installEvalFeedback } = await import("./eval-feedback.js");
const { assertEvaluated } = await import("./export.js");
const visualsHost = await import("./strudel-ext/visuals-host.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emitLog = (message, type) =>
  document.dispatchEvent(
    new CustomEvent("strudel.log", { detail: { message, type } }),
  );

before(async () => {
  await core.evalScope(core.controls, core, mini, {
    arrange: arrangeExt.arrange,
  });
});

const schedulers = [];
afterEach(() => {
  // A running scheduler keeps an interval alive (and the process with it).
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  arrangeExt.clearSolo();
});

function setup(overrides = {}) {
  const t0 = performance.now();
  let feedback;
  const repl = core.repl({
    defaultOutput: async () => {},
    getTime: () => (performance.now() - t0) / 1000,
    transpiler,
    onEvalError: (err) => feedback?.handleEvalError(err),
    ...overrides.repl,
  });
  schedulers.push(repl.scheduler);
  // Same shape as StrudelMirror: evaluate(autostart) → repl.evaluate.
  const editor = {
    code: "",
    editor: {},
    repl,
    async evaluate(autostart = true) {
      await repl.evaluate(this.code, autostart);
    },
    async stop() {
      repl.scheduler.stop();
    },
  };
  const log = [];
  const statuses = [];
  let badge = null;
  let nextEntryId = 1;
  const transportEl = { dataset: { transportState: "idle" } };
  const transport = {
    // Mirrors transport.js: the scheduler's own state wins over the hint.
    setPlaybackState(state) {
      let next = state;
      if (repl.scheduler.started) next = "playing";
      else if (next === "playing") next = "idle";
      transportEl.dataset.transportState = next;
    },
    setStatus: (text) => statuses.push(text),
    setErrorState: (state) => (badge = state),
    clearErrorState: () => (badge = null),
  };
  const push = (level) => (message) => {
    log.push({ level, message: String(message) });
    return nextEntryId++;
  };
  const consolePanel = {
    divider: push("divider"),
    log: push("log"),
    warn: push("warn"),
    error: push("error"),
  };
  const prewarmCalls = [];
  feedback = installEvalFeedback({
    editor,
    transport,
    transportEl,
    consolePanel,
    soundBrowser: { setBufferText() {} },
    referencePanel: { setBufferText() {} },
    soundMap: { get: () => ({ bd: {}, sd: {}, triangle: {} }) },
    getSound: () => ({}),
    getAudioContext: () => ({ state: "running" }),
    setAudioContext() {},
    setSuperdoughAudioController() {},
    resetGlobalEffects() {},
    initAudio: async () => {},
    bootPromise: Promise.resolve(),
    getBootReady: () => true,
    clearError() {},
    setError: () => null,
    extractErrorLine: () => null,
    prewarmSounds: async (haps, deps, opts) => {
      prewarmCalls.push(opts);
      return { warmed: 0, failed: [], warmedKeys: [] };
    },
    getCurrentName: () => "test",
    getEvalOwner: () => overrides.owner?.() ?? "tab",
    isExportRunning: () => false,
    ...overrides.deps,
  });
  return {
    editor,
    repl,
    log,
    statuses,
    transportEl,
    feedback,
    prewarmCalls,
    getBadge: () => badge,
    lastStatus: () => statuses[statuses.length - 1],
    entries: (level) => log.filter((e) => e.level === level),
  };
}

const SLOW = (ms, body) =>
  `await new Promise(r => setTimeout(r, ${ms}));\n${body}`;
const onsetsPerCycle = (repl) =>
  repl.state.pattern.queryArc(0, 1).filter((h) => h.hasOnset()).length;

describe("evaluate → play", () => {
  test("a successful play starts the scheduler and reports ok", async () => {
    const { editor, repl, lastStatus } = setup();
    editor.code = `s("bd")`;
    const outcome = await editor.evaluate();
    assert.deepEqual(outcome, { status: "ok", started: true, owner: "tab" });
    assert.equal(repl.scheduler.started, true);
    assert.equal(lastStatus(), "playing");
  });

  test("evaluate(false) compiles without starting", async () => {
    const { editor, repl } = setup();
    editor.code = `s("bd")`;
    const outcome = await editor.evaluate(false);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.started, false);
    assert.equal(repl.scheduler.started, false);
    assert.ok(repl.state.pattern);
  });
});

describe("stop / cancel", () => {
  test("stop during a slow evaluate cancels it for good", async () => {
    const { editor, repl, transportEl, lastStatus } = setup();
    editor.code = SLOW(80, `s("bd")`);
    const pending = editor.evaluate();
    await sleep(20);
    assert.equal(transportEl.dataset.transportState, "loading");
    editor.stop();
    assert.equal(lastStatus(), "play canceled");
    const outcome = await pending;
    await sleep(20);
    assert.equal(outcome.status, "cancelled");
    assert.equal(
      repl.scheduler.started,
      false,
      "the scheduler must not start after the user cancelled",
    );
    assert.equal(transportEl.dataset.transportState, "idle");
    assert.equal(lastStatus(), "play canceled");
  });

  test("stop while a slow re-evaluate is in flight stays stopped", async () => {
    const { editor, repl } = setup();
    editor.code = `s("bd")`;
    await editor.evaluate();
    editor.code = SLOW(60, `s("bd*2")`);
    const pending = editor.evaluate();
    await sleep(15);
    editor.stop();
    await pending;
    assert.equal(repl.scheduler.started, false);
  });

  test("a cancelled evaluate that finishes late cannot replace a newer pattern", async () => {
    const { editor, repl } = setup();
    editor.code = SLOW(80, `s("bd")`);
    const slow = editor.evaluate();
    await sleep(15);
    editor.stop(); // abandons the slow one
    editor.code = `s("bd*3")`;
    const fast = await editor.evaluate();
    assert.equal(fast.status, "ok");
    assert.equal(onsetsPerCycle(repl), 3);
    const late = await slow;
    assert.equal(late.status, "cancelled");
    assert.equal(repl.scheduler.started, true);
    const playing = repl.scheduler.pattern
      .queryArc(0, 1)
      .filter((h) => h.hasOnset()).length;
    assert.equal(playing, 3, "the scheduler keeps the newer pattern");
  });

  test("stop releases a compile-only evaluate queued behind one that never settles", async () => {
    // The WAV export compiles with evaluate(false) and holds the export lock
    // while it waits; behind a stalled top-level await it has to be let go.
    const { editor, statuses } = setup();
    editor.code = `await new Promise(() => {});\ns("bd")`;
    const stalled = editor.evaluate();
    await sleep(15);
    editor.code = `s("bd")`;
    const queued = editor.evaluate(false);
    await sleep(15);
    assert.ok(
      statuses.some((text) => /waiting for the previous evaluate/.test(text)),
      "the wait is announced",
    );
    editor.stop();
    const outcome = await Promise.race([queued, sleep(100).then(() => null)]);
    assert.equal(outcome?.status, "cancelled");
    assert.throws(() => assertEvaluated(outcome, editor), /interrupted/);
    void stalled; // never settles
  });

  test("status is refreshed on play → stop → play", async () => {
    const { editor, lastStatus } = setup();
    editor.code = `s("bd")`;
    await editor.evaluate();
    editor.stop();
    assert.equal(lastStatus(), "Stopped");
    await editor.evaluate();
    assert.equal(lastStatus(), "playing");
  });
});

describe("overlapping evaluates", () => {
  test("two evaluates in the same tick run one after the other", async () => {
    const { editor } = setup();
    editor.code = `arrange(\n  [2, s("bd")],\n  [2, s("bd*2")]\n)`;
    const [a, b] = await Promise.all([editor.evaluate(), editor.evaluate()]);
    assert.equal(a.status, "superseded");
    assert.equal(b.status, "ok");
    const registry = arrangeExt.getRegistry();
    assert.equal(registry.length, 1, "one arrange() → one registry entry");
    assert.equal(registry[0].arrangeIndex, 0);
  });

  test("the latest request wins even when an older one is slower", async () => {
    const { editor, repl } = setup();
    editor.code = SLOW(60, `s("bd")`);
    const older = editor.evaluate();
    await sleep(10);
    editor.code = `s("bd*4")`;
    const newer = editor.evaluate();
    const [a, b] = await Promise.all([older, newer]);
    assert.equal(a.status, "superseded");
    assert.equal(b.status, "ok");
    assert.equal(onsetsPerCycle(repl), 4);
    assert.equal(repl.scheduler.started, true);
  });

  test("a request replaced while it waits never runs", async () => {
    const { editor, entries } = setup();
    editor.code = SLOW(40, `s("bd")`);
    const inFlight = editor.evaluate();
    await sleep(10);
    const results = await Promise.all([
      inFlight,
      editor.evaluate(),
      editor.evaluate(),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["superseded", "superseded", "ok"],
    );
    assert.equal(entries("divider").length, 2, "the middle one was skipped");
  });

  test("one evaluate's failure is not blamed on the next", async () => {
    const { editor } = setup();
    editor.code = SLOW(30, `s("bd"`);
    const failing = editor.evaluate();
    await sleep(5);
    editor.code = `s("bd")`;
    const good = editor.evaluate();
    assert.equal((await failing).status, "error");
    assert.equal((await good).status, "ok");
  });
});

describe("failed and empty evaluates", () => {
  test("a failed evaluate reports error and keeps the engine state", async () => {
    const { editor, repl, getBadge, lastStatus, transportEl } = setup();
    editor.code = `s("bd")`;
    await editor.evaluate(false);
    const good = repl.state.pattern;
    editor.code = `s("bd"`;
    const outcome = await editor.evaluate(false);
    assert.equal(outcome.status, "error");
    assert.equal(repl.state.pattern, good, "the repl keeps the old pattern");
    assert.equal(getBadge().label, "syntax error");
    assert.match(lastStatus(), /^Error/);
    assert.equal(transportEl.dataset.transportState, "idle");
    // …which is exactly why the export must not trust state.pattern.
    assert.throws(() => assertEvaluated(outcome, editor), /has an error/);
  });

  test("a failed play from idle does not start the scheduler", async () => {
    const { editor, repl } = setup();
    editor.code = `s("bd"`;
    const outcome = await editor.evaluate();
    assert.equal(outcome.status, "error");
    assert.equal(outcome.started, false);
    assert.equal(repl.scheduler.started, false);
  });

  test("assertEvaluated accepts only a real evaluation", () => {
    const editor = { repl: { state: {} } };
    assert.doesNotThrow(() => assertEvaluated({ status: "ok" }, editor));
    assert.throws(() => assertEvaluated({ status: "empty" }, editor), /empty/);
    assert.throws(
      () => assertEvaluated({ status: "cancelled" }, editor),
      /interrupted/,
    );
    assert.throws(
      () => assertEvaluated({ status: "superseded" }, editor),
      /interrupted/,
    );
    assert.throws(
      () =>
        assertEvaluated(undefined, {
          repl: { state: { evalError: new Error("x is not defined") } },
        }),
      /x is not defined/,
    );
  });

  test("an empty buffer resolves with feedback instead of rejecting", async () => {
    const { editor, repl, lastStatus, transportEl } = setup();
    editor.code = "  \n";
    const outcome = await editor.evaluate();
    assert.equal(outcome.status, "empty");
    assert.equal(repl.scheduler.started, false);
    assert.match(lastStatus(), /empty/);
    assert.equal(transportEl.dataset.transportState, "idle");
  });

  test("a missing opt-in function explains where to enable it", async () => {
    const { editor, entries, lastStatus } = setup();
    editor.code = `s("bd").midi()`;
    const outcome = await editor.evaluate();
    assert.equal(outcome.status, "error");
    const shown = entries("error").map((e) => e.message).join("\n");
    assert.match(shown, /@strudel\/midi/);
    assert.match(shown, /Setup panel/);
    assert.match(lastStatus(), /@strudel\/midi/);
  });
});

describe("export lock", () => {
  test("play is refused while an export is rendering", async () => {
    let exporting = true;
    const { editor, repl, lastStatus, entries } = setup({
      deps: { isExportRunning: () => exporting },
    });
    editor.code = `s("bd")`;
    const outcome = await editor.evaluate();
    assert.equal(outcome.status, "blocked");
    assert.equal(repl.scheduler.started, false);
    assert.equal(repl.state.pattern, undefined, "nothing was evaluated");
    assert.match(lastStatus(), /Export in progress/);
    assert.equal(entries("divider").length, 0);

    // The export's own compile-only evaluate still goes through.
    assert.equal((await editor.evaluate(false)).status, "ok");
    exporting = false;
    assert.equal((await editor.evaluate()).status, "ok");
  });
});

describe("diagnostics", () => {
  test("an unknown sound raises the badge and the status", async () => {
    const { editor, getBadge, lastStatus, entries, feedback } = setup();
    editor.code = `s("bd, not_a_sound")`;
    const outcome = await editor.evaluate();
    assert.equal(outcome.status, "ok");
    assert.equal(getBadge().kind, "warning");
    assert.equal(getBadge().label, "unknown sound");
    assert.equal(lastStatus(), 'playing · unknown sound "not_a_sound"');
    assert.equal(entries("warn").length, 1);
    assert.equal(feedback.getActiveTransportError().source, "warning");

    // Re-evaluating the same typo keeps the badge without repeating the line.
    await editor.evaluate();
    assert.equal(getBadge().label, "unknown sound");
    assert.equal(entries("warn").length, 1);

    // Fixing it clears both.
    editor.code = `s("bd")`;
    await editor.evaluate();
    assert.equal(getBadge(), null);
    assert.equal(lastStatus(), "playing");
  });

  test("a silent pattern is flagged; a visuals-only buffer is not", async () => {
    const silent = setup();
    silent.editor.code = `s("~ ~")`;
    await silent.editor.evaluate();
    assert.equal(silent.getBadge().label, "no sound");
    assert.equal(silent.entries("warn").length, 1);

    const visuals = setup();
    visuals.editor.code = `const initHydra = () => {};\ninitHydra();\nsilence`;
    await visuals.editor.evaluate();
    assert.equal(visuals.getBadge(), null);
    assert.equal(visuals.entries("warn").length, 0);
  });

  test("layers sent to an external output are not checked against the sound map", async () => {
    const { editor, getBadge, entries } = setup();
    editor.code = `s("superpiano").onTrigger(() => {})`;
    await editor.evaluate();
    assert.equal(getBadge(), null);
    assert.equal(entries("warn").length, 0);
  });

  test("a warning logged by the pattern's own code is badged", async () => {
    const { editor, getBadge, entries } = setup();
    editor.code = `logger('[strasbeat] helper misuse', 'warning');\ns("bd")`;
    await editor.evaluate();
    assert.equal(getBadge().kind, "warning");
    assert.equal(entries("warn").length, 1);
  });

  test("sounds are pre-warmed with the set of already-warm keys", async () => {
    const { editor, prewarmCalls } = setup({
      deps: {
        prewarmSounds: async (haps, deps, opts) => {
          prewarmCalls.push([...opts.skip]);
          return { warmed: 1, failed: [], warmedKeys: ["bd"] };
        },
      },
    });
    editor.code = `s("bd")`;
    await editor.evaluate();
    await sleep(5);
    await editor.evaluate();
    assert.deepEqual(prewarmCalls, [[], ["bd"]]);
  });
});

describe("runtime errors", () => {
  test("an untyped scheduler error raises the badge while playing", async () => {
    const { editor, getBadge, feedback, entries } = setup();
    editor.code = `s("bd")`;
    await editor.evaluate();
    assert.equal(getBadge(), null);
    emitLog("[getTrigger] error: sound nope not found! Is it loaded?");
    assert.equal(getBadge().label, "runtime error");
    assert.equal(feedback.getActiveTransportError().source, "runtime");
    assert.equal(entries("error").length, 1);
  });

  test("a pattern that throws at query time is surfaced", async () => {
    const { editor, getBadge } = setup();
    editor.code = `s("bd*4").fmap(() => { throw new Error("boom at query time") })`;
    await editor.evaluate();
    await sleep(250);
    assert.equal(getBadge()?.label, "runtime error");
  });

  test("repeated per-hap errors are coalesced", async () => {
    const { editor, getBadge, entries } = setup();
    editor.code = `s("bd")`;
    await editor.evaluate();
    for (let i = 0; i < 200; i++) {
      emitLog("[getTrigger] error: sound a not found! Is it loaded?");
      emitLog("[getTrigger] error: sound b not found! Is it loaded?");
    }
    assert.equal(entries("error").length, 2);
    assert.equal(getBadge().label, "2 runtime errors");

    // A new evaluate starts from a clean slate.
    await editor.evaluate();
    assert.equal(getBadge(), null);
    emitLog("[getTrigger] error: sound a not found! Is it loaded?");
    assert.equal(entries("error").length, 3);
  });

  test("the console cannot be flooded by ever-changing messages", async () => {
    const { editor, entries } = setup();
    editor.code = `s("bd")`;
    await editor.evaluate();
    for (let i = 0; i < 500; i++) emitLog(`[cyclist] error: failure #${i}`);
    assert.ok(entries("error").length <= 41);
    assert.equal(
      entries("error").filter((e) => /Too many/.test(e.message)).length,
      1,
      "the cut-off is itself reported, as an error",
    );
  });

  test("a flood of distinct warnings cannot hide a later error", async () => {
    const { editor, getBadge, entries } = setup();
    editor.code = `s("bd")`;
    await editor.evaluate();
    for (let i = 0; i < 500; i++) {
      emitLog(`"x${i}" is not a number, falling back to 0`, "warning");
    }
    assert.ok(entries("warn").length <= 41);
    assert.equal(getBadge(), null);
    emitLog("[getTrigger] error: sound nope not found! Is it loaded?");
    assert.equal(entries("error").length, 1, "the error is printed");
    assert.equal(getBadge()?.label, "runtime error");
  });
});

describe("visuals follow a play that starts the scheduler after the evaluate", () => {
  // A stand-in layer driven through the real host, wired to the repl exactly
  // like main.js does (onUpdateState: syncVisualsToRepl).
  let live = false;
  let cleared = 0;
  visualsHost.registerVisualLayer("test-layer", {
    isLive: () => live,
    clear: () => {
      if (live) cleared++;
      live = false;
    },
    setRenderMode() {},
    getCanvas: () => null,
    resize() {},
  });
  before(async () => {
    await core.evalScope({
      testVisual: () => {
        live = true;
        visualsHost.markVisualRequested("test-layer");
        return core.silence;
      },
    });
  });
  const visualSetup = () => {
    visualsHost._resetVisualsHost();
    live = false;
    cleared = 0;
    return setup({ repl: { onUpdateState: visualsHost.syncVisualsToRepl } });
  };
  const VISUAL = `testVisual()\ns("bd")`;

  test("first play keeps the layer the evaluate built", async () => {
    const { editor, repl } = visualSetup();
    editor.code = VISUAL;
    const outcome = await editor.evaluate();
    assert.equal(outcome.status, "ok");
    assert.equal(repl.scheduler.started, true);
    assert.equal(live, true, "the layer survives until the scheduler runs");
    assert.equal(cleared, 0);
    editor.stop();
    assert.equal(live, false, "stop tears it down");
  });

  test("a compile-only evaluate leaves nothing behind", async () => {
    const { editor } = visualSetup();
    editor.code = VISUAL;
    await editor.evaluate(false);
    assert.equal(live, false);
    assert.equal(cleared, 1);
  });

  test("a play cancelled before it starts leaves nothing behind", async () => {
    const { editor, repl } = visualSetup();
    editor.code = `testVisual()\n${SLOW(60, `s("bd")`)}`;
    const pending = editor.evaluate();
    await sleep(15);
    assert.equal(live, true);
    editor.stop();
    assert.equal((await pending).status, "cancelled");
    assert.equal(repl.scheduler.started, false);
    assert.equal(live, false);
  });

  test("a play whose evaluate fails from idle leaves nothing behind", async () => {
    const { editor } = visualSetup();
    editor.code = `testVisual()\nnotDefinedAnywhere()`;
    assert.equal((await editor.evaluate()).status, "error");
    assert.equal(live, false);
  });
});

describe("boot failures", () => {
  test("each failed phase is logged with what it silences", async () => {
    const { entries, getBadge } = setup({
      deps: {
        getBootFailures: () => [
          {
            label: "dirt-samples",
            reason: "timed out",
            affects: "the default sample kit will be silent.",
          },
        ],
      },
    });
    await sleep(5);
    const [warning] = entries("warn");
    assert.match(warning.message, /dirt-samples/);
    assert.match(warning.message, /timed out/);
    assert.match(warning.message, /default sample kit/);
    assert.match(warning.message, /Reload/);
    assert.equal(getBadge().label, "load warning");
  });
});
