// Run with: node --test src/strudel-ext/hydra.test.js
//
// Pure tests for the guarded H(): empty haps must NOT throw — they return
// the last non-empty value seen, or 0 if none yet. No WebGL here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mini } from "@strudel/mini";
import {
  H,
  installNodeGlobalShim,
  initHydra,
  clearHydra,
  _setHydraTestHarness,
  _resetHydraTestHarness,
} from "./hydra.js";
import {
  computeVisualCanvasSize,
  holdVisualsForStart,
  setVisualsVisible,
  setVisualsChangeCallback,
  syncVisualsToRepl,
  _resetVisualsHost,
} from "./visuals-host.js";

// ─── Teardown / lifecycle harness ────────────────────────────────────────
// initHydra/clearHydra cannot run against the real hydra-synth in Node (it
// touches window/document/WebGL at construction). The wrapper exposes an
// injection seam (_setHydraTestHarness) so the TEARDOWN CONTRACT — the actual
// regression target for the "slow + crash" leak — is testable headlessly:
// a fake Hydra records whether its regl context was destroyed + lost, and a
// fake rAF lets us assert the render loop is stopped (no orphaned tick).
//
// This is the leak that made the feature crash-prone: hydra-synth starts a
// raf-loop whose handle it discards (hydra-synth.js:124) and hush() neither
// stops that loop nor destroys the regl WebGL context (hydra-synth.js:139).
// So each stop→play leaked a live GL context + an orphaned full-viewport
// render loop. clearHydra() must now: stop OUR loop, regl.destroy(), and
// loseContext() the GL.

// The render loop only runs while the scheduler plays AND the host reports the
// canvas on screen. Most lifecycle tests want exactly that state.
function hostPlayingAndVisible() {
  syncVisualsToRepl({ started: true, pending: false });
  setVisualsVisible(true);
}
function resetAll() {
  _resetHydraTestHarness();
  _resetVisualsHost();
}

function makeFakeHarness({
  throwOnTick = false,
  beforeMake,
  globals = {},
  playing = true,
} = {}) {
  if (playing) hostPlayingAndVisible();
  const calls = {
    constructed: 0,
    hush: 0,
    reglDestroy: 0,
    loseContext: 0,
    ticks: 0,
    canvasRemoved: 0,
  };
  let rafCallbacks = new Map();
  let rafId = 0;
  const canvas = {
    _removed: false,
    remove() {
      this._removed = true;
      calls.canvasRemoved++;
    },
  };
  const loseContextExt = {
    loseContext() {
      calls.loseContext++;
    },
  };
  const fakeHydra = {
    regl: {
      _gl: {
        getExtension(name) {
          return name === "WEBGL_lose_context" ? loseContextExt : null;
        },
      },
      destroy() {
        calls.reglDestroy++;
      },
    },
    hush() {
      calls.hush++;
    },
    tick(_dt) {
      calls.ticks++;
      if (throwOnTick) throw new Error("simulated GPU/render failure");
    },
  };

  _setHydraTestHarness({
    // Replaces the dynamic import('hydra-synth') + getDrawContext + new Hydra.
    beforeMake,
    makeHydra() {
      calls.constructed++;
      // hydra-synth's makeGlobal writes its synth onto window at construction.
      Object.assign(globalThis, globals);
      return { hydra: fakeHydra, canvas };
    },
    // Deterministic rAF: callbacks fire only when we call flushRaf().
    raf(cb) {
      const id = ++rafId;
      rafCallbacks.set(id, cb);
      return id;
    },
    caf(id) {
      rafCallbacks.delete(id);
    },
  });

  return {
    calls,
    canvas,
    flushRaf(times = 1) {
      for (let i = 0; i < times; i++) {
        const entries = [...rafCallbacks.entries()];
        rafCallbacks = new Map();
        for (const [, cb] of entries) cb(performance.now());
      }
    },
    pendingRafCount: () => rafCallbacks.size,
  };
}

describe("guarded H()", () => {
  test("never throws on a pattern that is empty at the query instant", () => {
    // "~" is silence the whole cycle — queryArc returns [] at every instant.
    const fn = H(mini("~"));
    assert.equal(typeof fn, "function");
    assert.doesNotThrow(() => fn());
  });

  test("returns 0 before any non-empty value has been seen", () => {
    const fn = H(mini("~"));
    assert.equal(fn(), 0);
  });

  test("returns the active value when a hap is present", () => {
    // A pattern that is 0.5 for the whole cycle — always has an active hap.
    const fn = H(mini("0.5"));
    assert.equal(fn(), 0.5);
  });

  test("holds the last non-empty value across an empty instant", () => {
    // Drive H() through a value, then assert it does not reset to 0 / throw
    // when later queried during silence. We simulate by querying a dense
    // pattern (always-present) — the key property is: once a value is seen,
    // a subsequent empty query must return that held value, never throw.
    const dense = H(mini("0.7"));
    assert.equal(dense(), 0.7);
    assert.doesNotThrow(() => dense());
    assert.equal(dense(), 0.7);
  });
});

describe("computeVisualCanvasSize() — GPU-OOM resolution cap", () => {
  // The crash hypothesis: hydra-synth allocates ~12 full-res FBOs on first
  // render; an innerWidth×innerHeight×dpr canvas on a 4K/retina display is
  // hundreds of MB of VRAM in one burst → OOM → tab crash on the first tick
  // (which fires when Visuals mode is entered). The clamp removes that path.

  test("small viewport at dpr 1 is returned unscaled (no clamp needed)", () => {
    const r = computeVisualCanvasSize({ innerWidth: 800, innerHeight: 600 });
    assert.equal(r.width, 800);
    assert.equal(r.height, 600);
    assert.equal(r.pixelRatio, 1);
    assert.equal(r.clamped, false);
  });

  test("caps pixelRatio at 1 (a retina dpr=2 must not double the buffer)", () => {
    const r = computeVisualCanvasSize({
      innerWidth: 1000,
      innerHeight: 700,
      pixelRatio: 2,
    });
    assert.equal(r.pixelRatio, 1, "pixelRatio must be capped to 1");
    // 1000x700 already fits the 1280 cap, so size stays at the dpr-1 viewport.
    assert.equal(r.width, 1000);
    assert.equal(r.height, 700);
    assert.equal(r.clamped, true, "capping dpr counts as clamped");
  });

  test("clamps the long edge to the max while preserving aspect ratio", () => {
    // A 4K-ish landscape viewport: long edge must come down to 1280.
    const r = computeVisualCanvasSize({
      innerWidth: 3840,
      innerHeight: 2160,
      pixelRatio: 2,
    });
    assert.equal(r.width, 1280, "long edge clamped to the cap");
    // aspect 3840:2160 = 16:9 → height = 1280 * 2160/3840 = 720.
    assert.equal(r.height, 720, "aspect ratio preserved");
    assert.equal(r.clamped, true);
    assert.ok(
      Math.max(r.width, r.height) <= 1280,
      "no edge may exceed the cap",
    );
  });

  test("clamps a portrait viewport on its (vertical) long edge", () => {
    const r = computeVisualCanvasSize({ innerWidth: 1080, innerHeight: 2400 });
    assert.equal(r.height, 1280, "vertical long edge clamped");
    assert.ok(r.width < r.height);
    assert.equal(r.clamped, true);
  });

  test("respects a custom maxLongEdge", () => {
    const r = computeVisualCanvasSize({
      innerWidth: 2000,
      innerHeight: 1000,
      maxLongEdge: 800,
    });
    assert.equal(r.width, 800);
    assert.equal(r.height, 400);
  });

  test("degenerate 0/NaN viewport yields a valid 1x1, never 0x0 or NaN", () => {
    const z = computeVisualCanvasSize({ innerWidth: 0, innerHeight: 0 });
    assert.equal(z.width, 1);
    assert.equal(z.height, 1);
    const n = computeVisualCanvasSize({ innerWidth: NaN, innerHeight: NaN });
    assert.ok(Number.isFinite(n.width) && n.width >= 1);
    assert.ok(Number.isFinite(n.height) && n.height >= 1);
  });
});

describe("installNodeGlobalShim() — Node global() shim for the bundled hydra-synth", () => {
  // Regression for "[eval] error: global is not defined" when playing
  // patterns/04-hydra-demo.js. Root cause: hydra-synth's offline npm bundle
  // pulls in `right-now/browser.js`, whose top-level `global.performance`
  // reference assumes a browserify-style `global` shim (which the unpkg CDN
  // build had, but Vite's esbuild pre-bundle does NOT). initHydra() must
  // define `globalThis.global` before importing hydra-synth or the import
  // throws at module-eval time. This asserts the real shim used by
  // initHydra() — not a copy of it — restores `global` when absent.
  test("defines globalThis.global when it is missing (the browser case)", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "global");
    try {
      delete globalThis.global;
      assert.equal(
        typeof globalThis.global,
        "undefined",
        "precondition: global must be absent to prove the shim sets it",
      );

      installNodeGlobalShim();

      assert.equal(
        globalThis.global,
        globalThis,
        "after the shim, globalThis.global must point at globalThis",
      );
    } finally {
      // Restore whatever was there before (in Node `global` exists natively).
      if (saved) Object.defineProperty(globalThis, "global", saved);
    }
  });

  test("is a no-op when global already exists (does not clobber it)", () => {
    const sentinel = { iAmTheRealGlobal: true };
    const saved = Object.getOwnPropertyDescriptor(globalThis, "global");
    try {
      globalThis.global = sentinel;

      installNodeGlobalShim();

      assert.equal(
        globalThis.global,
        sentinel,
        "an existing global (e.g. Node's) must be left untouched",
      );
    } finally {
      if (saved) Object.defineProperty(globalThis, "global", saved);
      else delete globalThis.global;
    }
  });
});

describe("clearHydra() teardown contract (the leak that crashed the tab)", () => {
  test("stops the render loop, destroys regl, and loses the WebGL context", async () => {
    const h = makeFakeHarness();
    try {
      await initHydra();
      // A live Hydra must be rendering: the loop scheduled a frame.
      assert.ok(h.pendingRafCount() > 0, "initHydra must start a render loop");
      h.flushRaf(3);
      assert.ok(h.calls.ticks >= 3, "the render loop must drive hydra.tick");

      clearHydra();

      // 1. regl context fully destroyed (frees FBOs/textures/programs).
      assert.equal(
        h.calls.reglDestroy,
        1,
        "clearHydra must call regl.destroy()",
      );
      // 2. WebGL context explicitly lost (browser reclaims the context slot —
      //    this is what prevents the ~16-context ceiling crash).
      assert.equal(
        h.calls.loseContext,
        1,
        "clearHydra must loseContext() so the browser reclaims the GL context",
      );
      // 3. canvas removed from the DOM.
      assert.equal(
        h.calls.canvasRemoved,
        1,
        "clearHydra must remove the canvas",
      );

      // 4. THE LEAK REGRESSION: after teardown the loop must be dead. Flushing
      //    any still-pending frame must NOT advance hydra.tick — an orphaned
      //    loop ticking a destroyed context is exactly the bug.
      const ticksAfterClear = h.calls.ticks;
      h.flushRaf(5);
      assert.equal(
        h.calls.ticks,
        ticksAfterClear,
        "no tick may fire after clearHydra — the render loop must be stopped",
      );
    } finally {
      resetAll();
    }
  });

  test("re-init after clear builds exactly one fresh instance (no orphan)", async () => {
    const h = makeFakeHarness();
    try {
      await initHydra();
      clearHydra();
      await initHydra();
      // Two full lifecycles → two constructions, two destroys after the second
      // clear. The point: clear truly reset state so init builds anew.
      assert.equal(
        h.calls.constructed,
        2,
        "each init after a clear constructs anew",
      );
      clearHydra();
      assert.equal(
        h.calls.reglDestroy,
        2,
        "each lifecycle destroys its own context",
      );
    } finally {
      resetAll();
    }
  });

  test("repeated initHydra() without clear does NOT build a second instance", async () => {
    // Re-eval (Ctrl+Enter) calls initHydra() every time; constructing a second
    // Hydra would orphan the first's loop + context (the multiply-leaked case).
    const h = makeFakeHarness();
    try {
      await initHydra();
      await initHydra();
      await initHydra();
      assert.equal(
        h.calls.constructed,
        1,
        "initHydra must be idempotent across re-eval — one instance only",
      );
    } finally {
      resetAll();
    }
  });

  test("a hidden canvas pauses the loop; showing it again resumes", async () => {
    // Efficiency: Hydra must not render a full-viewport frame every rAF when
    // its canvas is hidden (Visuals mode off). Pausing the loop drops the
    // idle cost to zero.
    const h = makeFakeHarness();
    try {
      await initHydra();
      h.flushRaf(2);
      const before = h.calls.ticks;

      setVisualsVisible(false);
      h.flushRaf(5);
      assert.equal(
        h.calls.ticks,
        before,
        "a paused Hydra must not tick while hidden",
      );

      setVisualsVisible(true);
      assert.ok(h.pendingRafCount() > 0, "resuming must reschedule the loop");
      h.flushRaf(2);
      assert.ok(h.calls.ticks > before, "resuming must drive ticks again");
    } finally {
      resetAll();
    }
  });

  test("a throwing render is non-fatal: the loop STOPS, does not respin or rethrow", async () => {
    // Crash-guard contract: a render error must surface as a stopped loop, NOT a
    // spinning loop hammering a broken context every frame, and NEVER an
    // exception that escapes the rAF (which would bubble as an uncaught error).
    const h = makeFakeHarness({ throwOnTick: true });
    try {
      await initHydra();
      // Flushing the queued frame triggers the throwing tick. It must not throw
      // out of flushRaf (the guard catches it).
      assert.doesNotThrow(() => h.flushRaf(1), "a render throw must be caught");
      assert.equal(h.calls.ticks, 1, "the throwing tick ran exactly once");
      // The loop must be stopped now — no pending frame, and further flushes do
      // not advance ticks (we are NOT respinning a throwing render).
      assert.equal(
        h.pendingRafCount(),
        0,
        "a throwing render must STOP the loop (no rescheduled frame)",
      );
      h.flushRaf(5);
      assert.equal(
        h.calls.ticks,
        1,
        "no further ticks after a throw — the loop stays stopped",
      );
    } finally {
      resetAll();
    }
  });
});

describe("visuals follow the repl (exist iff the evaluated code asked AND it plays)", () => {
  // The state objects below are what @strudel/core's repl hands onUpdateState.
  const evalStart = (started) => syncVisualsToRepl({ pending: true, started });
  const evalDone = (started, evalError) =>
    syncVisualsToRepl({ pending: false, started, evalError });

  test("a silent evaluate (boot first frame, WAV export) never renders and leaves nothing behind", async () => {
    const h = makeFakeHarness({ playing: false });
    try {
      setVisualsVisible(true);
      evalStart(false);
      await initHydra();
      assert.equal(h.pendingRafCount(), 0, "no render loop while idle");
      evalDone(false);
      assert.equal(h.calls.reglDestroy, 1, "the idle instance is torn down");
      assert.equal(h.calls.ticks, 0);
    } finally {
      resetAll();
    }
  });

  // The app evaluates with autostart off and starts the scheduler itself
  // afterwards, so a play from idle passes through "settled, not started".
  test("play: the layer survives the evaluate and renders once the scheduler runs", async () => {
    const h = makeFakeHarness({ playing: false });
    try {
      setVisualsVisible(true);
      const release = holdVisualsForStart();
      evalStart(false);
      await initHydra();
      evalDone(false); // evaluate(autostart = false) settled
      assert.equal(h.calls.reglDestroy, 0, "held: not torn down");
      assert.equal(h.pendingRafCount(), 0, "scheduler not started yet");
      syncVisualsToRepl({ pending: false, started: true }); // scheduler.start()
      release();
      assert.ok(h.pendingRafCount() > 0, "now rendering");
      assert.equal(h.calls.reglDestroy, 0);
      assert.equal(h.calls.constructed, 1);
    } finally {
      resetAll();
    }
  });

  test("play cancelled before the scheduler starts: releasing the hold tears down", async () => {
    const h = makeFakeHarness({ playing: false });
    try {
      setVisualsVisible(true);
      const release = holdVisualsForStart();
      evalStart(false);
      await initHydra();
      evalDone(false);
      assert.equal(h.calls.reglDestroy, 0);
      release(); // the start never happened
      assert.equal(h.calls.reglDestroy, 1);
      assert.equal(h.calls.canvasRemoved, 1);
      release(); // idempotent
      assert.equal(h.calls.reglDestroy, 1);
    } finally {
      resetAll();
    }
  });

  test("a hold released while another evaluate is in flight leaves the decision to it", async () => {
    const h = makeFakeHarness({ playing: false });
    try {
      const release = holdVisualsForStart();
      evalStart(false);
      await initHydra();
      release();
      assert.equal(h.calls.reglDestroy, 0, "evaluate still pending");
      evalDone(false);
      assert.equal(h.calls.reglDestroy, 1);
    } finally {
      resetAll();
    }
  });

  test("every stop tears down — the scheduler going idle is the only signal needed", async () => {
    const h = makeFakeHarness();
    try {
      await initHydra();
      h.flushRaf(1);
      syncVisualsToRepl({ pending: false, started: false });
      assert.equal(h.calls.reglDestroy, 1);
      assert.equal(h.calls.canvasRemoved, 1);
      assert.equal(h.pendingRafCount(), 0);
    } finally {
      resetAll();
    }
  });

  test("re-evaluating the same visual code while playing keeps the one instance", async () => {
    const h = makeFakeHarness();
    try {
      evalStart(true);
      await initHydra();
      evalDone(true);
      evalStart(true);
      await initHydra();
      evalDone(true);
      assert.equal(h.calls.constructed, 1);
      assert.equal(h.calls.reglDestroy, 0);
    } finally {
      resetAll();
    }
  });

  test("evaluating code that no longer calls initHydra() tears the old visuals down", async () => {
    const h = makeFakeHarness();
    try {
      evalStart(true);
      await initHydra();
      evalDone(true);
      evalStart(true); // new code: no initHydra()
      evalDone(true);
      assert.equal(h.calls.reglDestroy, 1);
      assert.equal(h.pendingRafCount(), 0);
    } finally {
      resetAll();
    }
  });

  test("a failed evaluate keeps the visuals of the pattern still playing", async () => {
    const h = makeFakeHarness();
    try {
      evalStart(true);
      await initHydra();
      evalDone(true);
      evalStart(true); // throws before reaching initHydra()
      evalDone(true, new Error("syntax"));
      assert.equal(h.calls.reglDestroy, 0);
      assert.ok(h.pendingRafCount() > 0);
    } finally {
      resetAll();
    }
  });

  test("the host is told when visuals appear and disappear", async () => {
    makeFakeHarness();
    const seen = [];
    try {
      setVisualsChangeCallback((available) => seen.push(available));
      await initHydra();
      clearHydra();
      assert.deepEqual(seen, [true, false]);
    } finally {
      resetAll();
    }
  });
});

describe("initHydra() is safe across its async chunk load", () => {
  function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  }

  test("two overlapping calls build ONE instance", async () => {
    const gate = deferred();
    const h = makeFakeHarness({ beforeMake: () => gate.promise });
    try {
      const a = initHydra();
      const b = initHydra();
      gate.resolve();
      const [ha, hb] = await Promise.all([a, b]);
      assert.equal(h.calls.constructed, 1);
      assert.equal(ha, hb);
    } finally {
      resetAll();
    }
  });

  test("a silent evaluate settling during the load abandons the build", async () => {
    // initHydra() without `await`: the evaluate settles while the chunk is
    // still loading, so there is no live layer yet for the host to clear.
    const gate = deferred();
    const h = makeFakeHarness({ playing: false, beforeMake: () => gate.promise });
    try {
      syncVisualsToRepl({ pending: true, started: false });
      const pending = initHydra();
      syncVisualsToRepl({ pending: false, started: false });
      gate.resolve();
      assert.equal(await pending, null);
      assert.equal(h.calls.constructed, 0, "nothing is built while stopped");
    } finally {
      resetAll();
    }
  });

  test("an evaluate that no longer asks for Hydra abandons a build still loading", async () => {
    const gate = deferred();
    const h = makeFakeHarness({ beforeMake: () => gate.promise });
    try {
      syncVisualsToRepl({ pending: true, started: true });
      const pending = initHydra(); // not awaited by the pattern
      syncVisualsToRepl({ pending: false, started: true });
      syncVisualsToRepl({ pending: true, started: true }); // new code, no visuals
      syncVisualsToRepl({ pending: false, started: true });
      gate.resolve();
      assert.equal(await pending, null);
      assert.equal(h.calls.constructed, 0);
    } finally {
      resetAll();
    }
  });

  test("a build still loading survives the evaluate that asked for it", async () => {
    const gate = deferred();
    const h = makeFakeHarness({ beforeMake: () => gate.promise });
    try {
      syncVisualsToRepl({ pending: true, started: true });
      const pending = initHydra();
      syncVisualsToRepl({ pending: false, started: true });
      gate.resolve();
      assert.notEqual(await pending, null);
      assert.equal(h.calls.constructed, 1);
    } finally {
      resetAll();
    }
  });

  test("a teardown during the load abandons the build (no start-after-stop)", async () => {
    const gate = deferred();
    const h = makeFakeHarness({ beforeMake: () => gate.promise });
    try {
      const pending = initHydra();
      clearHydra();
      gate.resolve();
      assert.equal(await pending, null);
      assert.equal(h.calls.constructed, 0);
      assert.equal(h.pendingRafCount(), 0);
    } finally {
      resetAll();
    }
  });
});

describe("clearHydra() restores every global hydra-synth overwrote", () => {
  test("Strudel's time/noise/src/hush/speed/shape come back; Hydra-only names are removed", async () => {
    const names = ["time", "noise", "src", "hush", "speed", "shape"];
    const saved = Object.fromEntries(
      names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]),
    );
    const strudel = Object.fromEntries(names.map((n) => [n, () => n]));
    Object.assign(globalThis, strudel);
    const hydraGlobals = Object.fromEntries(names.map((n) => [n, () => "h"]));
    hydraGlobals.time = 0;
    hydraGlobals.osc = () => "osc";
    makeFakeHarness({ globals: hydraGlobals });
    try {
      await initHydra();
      assert.equal(globalThis.noise, hydraGlobals.noise, "Hydra owns it live");
      globalThis.time = 12.5; // hydra-synth rewrites window.time every tick

      clearHydra();
      for (const n of names) {
        assert.equal(globalThis[n], strudel[n], `${n} must be Strudel's again`);
      }
      assert.equal("osc" in globalThis, false, "Hydra-only global removed");
    } finally {
      resetAll();
      delete globalThis.osc;
      for (const n of names) {
        if (saved[n]) Object.defineProperty(globalThis, n, saved[n]);
        else delete globalThis[n];
      }
    }
  });
});
