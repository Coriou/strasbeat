// Run with: node --import ./scripts/test-register.mjs --test src/export.test.js

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

console.error = () => {};
console.warn = () => {};
console.log = () => {};

const {
  runExport,
  renderPatternToBuffer,
  isExportRunning,
  acquireExportLock,
  releaseExportLock,
  computeBufferStats,
  prewarmSounds,
  flushStaleNodePools,
} = await import("./export.js");

// A hap as the render loop sees it.
const hap = (value, begin = 0, context = {}) => ({
  value,
  context,
  whole: { begin: { valueOf: () => begin } },
  duration: 1,
  hasOnset: () => true,
});
const patternOf = (haps) => ({ queryArc: () => haps.slice() });

function fakeAudio() {
  const calls = [];
  const live = {
    state: "running",
    currentTime: 0,
    close: async () => {
      calls.push("live.close");
      live.state = "closed";
    },
  };
  return {
    calls,
    live,
    getAudioContext: () => live,
    getSound: () => null,
    setAudioContext: (ctx) =>
      calls.push(ctx ? "setAudioContext(offline)" : "setAudioContext(null)"),
    setSuperdoughAudioController: () => calls.push("setController(null)"),
    resetGlobalEffects: () => calls.push("resetGlobalEffects"),
    initAudio: async () => calls.push("initAudio"),
  };
}

function exportCtx({ outcome, pattern, cps = 0.5, audio = fakeAudio() }) {
  const panelLog = [];
  const status = { textContent: "" };
  return {
    audio,
    panelLog,
    status,
    ctx: {
      editor: {
        evaluate: async () => outcome,
        repl: {
          scheduler: { cps, stop() {} },
          state: { pattern },
        },
      },
      consolePanel: {
        log: (m) => panelLog.push(`log:${m}`),
        warn: (m) => panelLog.push(`warn:${m}`),
        error: (m) => panelLog.push(`error:${m}`),
      },
      exportPanel: { showProgress() {} },
      exportBtn: { disabled: false, querySelector: () => null },
      status,
      setLogger() {},
      superdough: async () => {},
      ...audio,
    },
  };
}

const OPTIONS = { cycles: 2, sampleRate: 48000, filename: "tune" };

beforeEach(() => {
  releaseExportLock();
});

describe("runExport() — refusing to render the wrong thing", () => {
  test("aborts when the current code failed to evaluate", async () => {
    // The repl still holds the previous good pattern after a failed eval.
    const { ctx, audio, status, panelLog } = exportCtx({
      outcome: { status: "error" },
      pattern: patternOf([hap({ s: "bd" })]),
    });
    await assert.rejects(runExport(OPTIONS, ctx), /has an error/);
    assert.match(status.textContent, /export failed: the pattern has an error/);
    assert.ok(panelLog.some((l) => /^error:export failed/.test(l)));
    assert.deepEqual(audio.calls, [], "the audio engine was never touched");
    assert.equal(isExportRunning(), false, "the lock is released");
  });

  test("aborts when the evaluate was cancelled or the buffer is empty", async () => {
    for (const [statusName, expected] of [
      ["cancelled", /interrupted/],
      ["superseded", /interrupted/],
      ["empty", /empty/],
    ]) {
      const { ctx, audio } = exportCtx({
        outcome: { status: statusName },
        pattern: patternOf([hap({ s: "bd" })]),
      });
      await assert.rejects(runExport(OPTIONS, ctx), expected);
      assert.deepEqual(audio.calls, []);
    }
  });

  test("a silent pattern fails without discarding the live audio context", async () => {
    const { ctx, audio } = exportCtx({
      outcome: { status: "ok" },
      pattern: patternOf([]),
    });
    await assert.rejects(runExport(OPTIONS, ctx), /no onset haps/);
    assert.deepEqual(audio.calls, []);
    assert.equal(audio.live.state, "running");
  });

  test("a second export is refused while one is running", async () => {
    assert.equal(acquireExportLock(), true);
    assert.equal(acquireExportLock(), false);
    const { ctx } = exportCtx({ outcome: { status: "ok" }, pattern: null });
    await assert.rejects(runExport(OPTIONS, ctx), /already in progress/);
    assert.equal(isExportRunning(), true, "the running export keeps its lock");
  });
});

describe("renderPatternToBuffer()", () => {
  class FakeOfflineAudioContext {
    constructor(channels, length, sampleRate) {
      this.length = length;
      this.sampleRate = sampleRate;
    }
    async startRendering() {
      return { rendered: true };
    }
  }

  test("counts haps superdough rejects and skips external-output layers", async () => {
    globalThis.OfflineAudioContext = FakeOfflineAudioContext;
    const audio = fakeAudio();
    const played = [];
    let swapped = 0;
    const result = await renderPatternToBuffer(
      patternOf([
        hap({ s: "bd" }, 0),
        hap({ s: "nope" }, 0.5),
        hap({ s: "sd" }, 1),
        // .midi()/.osc(): dominant trigger → no WebAudio output live either.
        hap({ note: "c" }, 1.5, { onTrigger() {}, dominantTrigger: true }),
        // .onTrigger(fn, false) keeps the default output.
        hap({ s: "hh" }, 1.75, { onTrigger() {}, dominantTrigger: false }),
      ]),
      1,
      2,
      48000,
      {
        ...audio,
        onContextSwap: () => swapped++,
        superdough: async (value) => {
          if (value.s === "nope") throw new Error("sound nope not found");
          if (value.gain === 0) return; // the silent pool-flush pass
          played.push(value.s ?? value.note);
        },
      },
    );
    assert.deepEqual(played, ["bd", "sd", "hh"]);
    assert.equal(result.scheduled, 3);
    assert.deepEqual(result.failures, ["sound nope not found"]);
    assert.equal(swapped, 1);
    // The lazy-controller order: context swapped, controller nulled, THEN init.
    assert.deepEqual(audio.calls, [
      "live.close",
      "setAudioContext(offline)",
      "setController(null)",
      "initAudio",
    ]);
  });
});

describe("flushStaleNodePools()", () => {
  const crossContext = () =>
    Object.assign(new Error("cannot connect to an AudioNode belonging to a different audio context"), {
      name: "InvalidAccessError",
    });
  const deps = (superdough) => ({
    superdough,
    getAudioContext: () => ({ currentTime: 0 }),
  });

  // Controls that reach past the voice: orbit effects, sidechain, busses.
  const SHARED_CONTROLS = [
    "orbit", "delay", "delaytime", "delayfeedback", "delaysync", "room",
    "roomsize", "duckorbit", "duckdepth", "djf", "bus", "analyze", "FX",
  ]; // prettier-ignore

  test("drains every pool whatever the pattern uses", async () => {
    // Stale nodes left by OTHER patterns: the rendered one is a bare kick.
    const stale = { filter: 3, compressor: 2, supersaw: 1 };
    const poolOf = (value) =>
      value.s === "supersaw"
        ? "supersaw"
        : "cutoff" in value
          ? "filter"
          : "compressor" in value
            ? "compressor"
            : null;
    const calls = [];
    const discarded = await flushStaleNodePools(
      [hap({ s: "bd" }, 0)],
      1,
      deps(async (value) => {
        calls.push(value);
        const pool = poolOf(value);
        if (pool && stale[pool] > 0) {
          stale[pool]--;
          throw crossContext();
        }
      }),
    );
    assert.equal(discarded, 6);
    assert.deepEqual(stale, { filter: 0, compressor: 0, supersaw: 0 });
    // One success after the failures, per pool.
    assert.equal(calls.filter((v) => poolOf(v) === "filter").length, 4);
    assert.equal(calls.filter((v) => poolOf(v) === "compressor").length, 3);
    assert.equal(calls.filter((v) => poolOf(v) === "supersaw").length, 2);
  });

  test("the probes are silent and touch nothing shared", async () => {
    const calls = [];
    await flushStaleNodePools(
      [
        // What the pattern does must not leak into the probes.
        hap({ s: "bd", duckorbit: 2, delay: 0.5, room: 0.8, djf: 0.3 }, 0),
        hap({ note: "c" }, 1.5, { onTrigger() {}, dominantTrigger: true }),
      ],
      1,
      deps(async (value, t, duration) => {
        calls.push({ value, t, duration });
      }),
    );
    assert.ok(calls.length >= 3);
    for (const { value } of calls) {
      assert.equal(value.gain, 0, "nothing audible is scheduled");
      for (const control of SHARED_CONTROLS) {
        assert.equal(control in value, false, `probe sets ${control}`);
      }
      assert.notEqual(value.s, "bd", "the pattern's own events are not replayed");
    }
  });

  test("a wavetable sound the pattern uses is probed too, bare", async () => {
    const calls = [];
    let staleWavetables = 2;
    const discarded = await flushStaleNodePools(
      [
        hap({ s: "wt_digital", n: 3, room: 0.5, duckorbit: 1 }, 0),
        hap({ s: "wt_digital", n: 5 }, 0.5),
        hap({ s: "bd" }, 1),
      ],
      1,
      {
        ...deps(async (value) => {
          calls.push(value);
          if (value.s === "wt_digital" && staleWavetables-- > 0) {
            throw crossContext();
          }
        }),
        getSound: (name) =>
          name === "wt_digital" ? { data: { type: "wavetable" } } : { data: {} },
      },
    );
    assert.equal(discarded, 2);
    const wavetable = calls.filter((v) => v.s === "wt_digital");
    assert.equal(wavetable.length, 3);
    assert.deepEqual(wavetable[0], { s: "wt_digital", n: 3, gain: 0 });
    assert.equal(calls.some((v) => v.s === "bd"), false);
  });

  test("gives up on a pool, loudly, on errors that are not about a foreign context", async () => {
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let calls = 0;
    let discarded;
    try {
      discarded = await flushStaleNodePools(
        [],
        1,
        deps(async () => {
          calls++;
          throw new Error("sound sawtooth not found! Is it loaded?");
        }),
      );
    } finally {
      console.warn = realWarn;
    }
    assert.equal(discarded, 0);
    assert.equal(calls, 3, "one attempt per pool, no retry loop");
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /could not flush/);
  });
});

describe("prewarmSounds() / computeBufferStats()", () => {
  test("already-warm sounds are skipped and new ones reported", async () => {
    const triggered = [];
    const deps = {
      getAudioContext: () => ({ currentTime: 0 }),
      getSound: (key) => ({
        onTrigger: async () => {
          triggered.push(key);
          return {};
        },
      }),
    };
    const haps = [hap({ s: "bd" }), hap({ s: "sd" }), hap({ s: "bd" })];
    const first = await prewarmSounds(haps, deps);
    assert.deepEqual(first.warmedKeys.sort(), ["bd", "sd"]);
    const second = await prewarmSounds(haps, deps, {
      skip: new Set(first.warmedKeys),
    });
    assert.equal(second.total, 0);
    assert.deepEqual(triggered.sort(), ["bd", "sd"]);
  });

  test("flags a mix that exceeds full scale", () => {
    const buffer = (samples) => ({
      numberOfChannels: 1,
      getChannelData: () => Float32Array.from(samples),
    });
    assert.equal(computeBufferStats(buffer([0, 0.5, -0.9])).clipped, false);
    assert.equal(computeBufferStats(buffer([0, 1.4, -0.9])).clipped, true);
  });
});
