// Run with: node --import ./scripts/test-register.mjs --test src/eval-state.test.js

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyStrudelLog,
  createEvalSequencer,
  createMessageCoalescer,
  describeEvalError,
  hasExternalOutput,
  isVisualsCode,
  optInHintForError,
  shouldClaimPlayback,
} from "./eval-state.js";

describe("createEvalSequencer()", () => {
  test("only the latest request is current", () => {
    const seq = createEvalSequencer();
    const a = seq.request();
    assert.ok(seq.isCurrent(a));
    const b = seq.request();
    assert.ok(!seq.isCurrent(a));
    assert.ok(seq.isCurrent(b));
    assert.ok(!seq.wasStopped(a), "replaced by an evaluate, not by a stop");
  });

  test("a stop supersedes every earlier request and marks it stopped", () => {
    const seq = createEvalSequencer();
    const a = seq.request();
    seq.stop();
    assert.ok(!seq.isCurrent(a));
    assert.ok(seq.wasStopped(a));
    const b = seq.request();
    assert.ok(seq.isCurrent(b));
    assert.ok(!seq.wasStopped(b), "a play after the stop is not cancelled");
  });

  test("enter() runs requests one at a time, in order", async () => {
    const seq = createEvalSequencer();
    const order = [];
    const run = async (name, ms) => {
      const release = await seq.enter();
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      release();
    };
    await Promise.all([run("a", 20), run("b", 1), run("c", 1)]);
    assert.deepEqual(order, [
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  test("a stop lets the next request in past an evaluate that never finishes", async () => {
    const seq = createEvalSequencer({ abandonWaitMs: 5 });
    await seq.enter(); // never released — a hung top-level await
    seq.stop();
    const entered = await Promise.race([
      seq.enter().then(() => true),
      new Promise((r) => setTimeout(() => r(false), 50)),
    ]);
    assert.equal(entered, true);
  });

  test("after a stop the next request waits for the abandoned evaluate to get out", async () => {
    // Long bound: only the abandoned evaluate finishing can let it in.
    const seq = createEvalSequencer({ abandonWaitMs: 60_000, setTimer: () => {} });
    const order = [];
    const abandoned = await seq.enter(); // still inside the repl
    seq.stop();
    const next = seq.enter().then((release) => {
      order.push("next in");
      release();
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(order, [], "not in beside the abandoned evaluate");
    order.push("abandoned out");
    abandoned();
    await next;
    assert.deepEqual(order, ["abandoned out", "next in"]);
  });

  test("the wait for an abandoned evaluate is bounded", async () => {
    let fire;
    const delays = [];
    const seq = createEvalSequencer({
      abandonWaitMs: 1234,
      setTimer: (fn, ms) => {
        delays.push(ms);
        fire = fn;
      },
    });
    await seq.enter(); // hung for good
    seq.stop();
    let entered = false;
    const next = seq.enter().then(() => {
      entered = true;
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(entered, false);
    assert.deepEqual(delays, [1234]);
    fire();
    await next;
    assert.equal(entered, true);
  });

  test("requests woken by a stop do not hide the evaluate they were behind", async () => {
    const seq = createEvalSequencer({ abandonWaitMs: 60_000, setTimer: () => {} });
    const abandoned = await seq.enter();
    const waiters = [seq.enter(), seq.enter()];
    seq.stop();
    for (const release of await Promise.all(waiters)) release();
    let entered = false;
    const next = seq.enter().then(() => {
      entered = true;
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(entered, false, "the abandoned evaluate is still ahead");
    abandoned();
    await next;
    assert.equal(entered, true);
  });

  test("the first request waits for an evaluate started outside the sequencer", async () => {
    let finishFirstFrame;
    const firstFrame = new Promise((resolve) => {
      finishFirstFrame = resolve;
    });
    const seq = createEvalSequencer({
      after: firstFrame,
      abandonWaitMs: 60_000,
      setTimer: () => {},
    });
    assert.equal(seq.isBusy(), false);
    let entered = false;
    const first = seq.enter().then((release) => {
      entered = true;
      release();
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(entered, false);
    finishFirstFrame();
    await first;
    // …and only the first: nothing is left to wait for afterwards.
    (await seq.enter())();
  });

  test("an outside evaluate that rejects still lets requests in", async () => {
    const seq = createEvalSequencer({ after: Promise.reject(new Error("x")) });
    (await seq.enter())();
  });

  test("a stop releases requests already waiting behind an evaluate that never finishes", async () => {
    const seq = createEvalSequencer();
    await seq.enter(); // never released — a hung top-level await
    const waiters = [seq.request(), seq.request()].map((token) =>
      seq.enter().then((release) => {
        release();
        return token;
      }),
    );
    const timeout = (ms) => new Promise((r) => setTimeout(() => r("stuck"), ms));
    assert.equal(
      await Promise.race([Promise.all(waiters), timeout(20)]),
      "stuck",
      "they wait while nothing was stopped",
    );
    seq.stop();
    const woken = await Promise.race([Promise.all(waiters), timeout(50)]);
    assert.notEqual(woken, "stuck", "every waiter is let go");
    for (const token of woken) {
      assert.ok(!seq.isCurrent(token), "a woken waiter must not run");
      assert.ok(seq.wasStopped(token), "it reports as cancelled");
    }
  });

  test("isBusy() tells whether a new request would have to wait", async () => {
    const seq = createEvalSequencer();
    assert.equal(seq.isBusy(), false);
    const release = await seq.enter();
    assert.equal(seq.isBusy(), true);
    release();
    assert.equal(seq.isBusy(), false);
    await seq.enter(); // hung
    seq.stop();
    assert.equal(seq.isBusy(), false, "a stop abandons the hung evaluate");
  });

  test("requests made after a stop queue normally again", async () => {
    const seq = createEvalSequencer({ abandonWaitMs: 5 });
    await seq.enter(); // hung
    seq.stop();
    const order = [];
    const first = await seq.enter();
    const second = seq.enter().then((release) => {
      order.push("second");
      release();
    });
    await new Promise((r) => setTimeout(r, 10));
    order.push("first done");
    first();
    await second;
    assert.deepEqual(order, ["first done", "second"]);
  });
});

describe("shouldClaimPlayback()", () => {
  const ok = { status: "ok" };
  test("a successful play that left the engine running claims", () => {
    assert.equal(
      shouldClaimPlayback({ autostart: true, outcome: ok, started: true }),
      true,
    );
  });
  test("a compile-only evaluate never claims", () => {
    assert.equal(
      shouldClaimPlayback({ autostart: false, outcome: ok, started: true }),
      false,
    );
  });
  test("failed, cancelled, replaced, empty or blocked evaluates never claim", () => {
    for (const status of ["error", "cancelled", "superseded", "empty", "blocked"]) {
      assert.equal(
        shouldClaimPlayback({
          autostart: true,
          outcome: { status },
          started: true,
        }),
        false,
        status,
      );
    }
    assert.equal(
      shouldClaimPlayback({ autostart: true, outcome: null, started: true }),
      false,
    );
  });
  test("nothing claims while the engine is stopped", () => {
    assert.equal(
      shouldClaimPlayback({ autostart: true, outcome: ok, started: false }),
      false,
    );
  });
});

describe("classifyStrudelLog()", () => {
  test("typed entries keep their type", () => {
    assert.equal(classifyStrudelLog("[eval] error: x", "error"), "error");
    assert.equal(classifyStrudelLog("careful", "warning"), "warning");
  });
  test("errorLogger's untyped '[origin] error:' lines are errors", () => {
    for (const origin of ["cyclist", "getTrigger", "query", "superdough"]) {
      assert.equal(
        classifyStrudelLog(`[${origin}] error: sound x not found`, undefined),
        "error",
      );
    }
  });
  test("ordinary chatter stays a log", () => {
    assert.equal(classifyStrudelLog("[cyclist] start"), "log");
    assert.equal(classifyStrudelLog("[eval] code updated"), "log");
    assert.equal(classifyStrudelLog("[sampler] load bd:0..", "load-sample"), "log");
    assert.equal(classifyStrudelLog("no error here"), "log");
  });
});

describe("createMessageCoalescer()", () => {
  test("reports each distinct message once and counts repeats", () => {
    const c = createMessageCoalescer();
    assert.equal(c.note("a"), "first");
    assert.equal(c.note("a"), "repeat");
    assert.equal(c.note("b"), "first");
    assert.equal(c.note("a"), "repeat");
    assert.equal(c.count("a"), 3);
    assert.equal(c.distinct(), 2);
  });
  test("caps the number of distinct messages and says so once", () => {
    const c = createMessageCoalescer({ maxDistinct: 2 });
    c.note("a");
    c.note("b");
    assert.equal(c.note("c"), "overflow-first");
    assert.equal(c.note("d"), "overflow");
    assert.equal(c.note("a"), "repeat", "known messages are still counted");
  });
  test("reset() starts over", () => {
    const c = createMessageCoalescer({ maxDistinct: 1 });
    c.note("a");
    c.note("b");
    c.reset();
    assert.equal(c.note("b"), "first");
  });
});

describe("optInHintForError()", () => {
  test("names the package for a missing opt-in method", () => {
    const hint = optInHintForError("note(...).midi is not a function");
    assert.match(hint, /@strudel\/midi/);
    assert.match(hint, /Setup panel/);
    assert.match(hint, /reload/);
    assert.match(optInHintForError("s(...).osc is not a function"), /@strudel\/osc/);
    assert.match(optInHintForError("note(...).tune is not a function"), /@strudel\/xen/);
    assert.match(optInHintForError("note(...).csound is not a function"), /@strudel\/csound/);
  });
  test("names the package for a missing opt-in global", () => {
    assert.match(optInHintForError("midin is not defined"), /@strudel\/midi/);
    assert.match(optInHintForError("loadOrc is not defined"), /@strudel\/csound/);
  });
  test("stays quiet for ordinary typos and prototype names", () => {
    assert.equal(optInHintForError("note(...).lpff is not a function"), null);
    assert.equal(optInHintForError("foo is not defined"), null);
    assert.equal(optInHintForError("constructor is not defined"), null);
    assert.equal(optInHintForError("Unexpected token"), null);
    assert.equal(optInHintForError(undefined), null);
  });
});

describe("isVisualsCode() / hasExternalOutput()", () => {
  test("detects Hydra and shader buffers", () => {
    assert.ok(isVisualsCode("await initHydra()\nosc(10).out()"));
    assert.ok(isVisualsCode("shader(`void main(){}`)"));
    assert.ok(!isVisualsCode('s("bd*4")'));
    assert.ok(!isVisualsCode("// initHydra is nice\nmyshader = 1"));
  });
  test("a dominant trigger marks an external output", () => {
    assert.ok(
      hasExternalOutput({ context: { onTrigger() {}, dominantTrigger: true } }),
    );
    assert.ok(
      !hasExternalOutput({ context: { onTrigger() {}, dominantTrigger: false } }),
    );
    assert.ok(!hasExternalOutput({ context: {} }));
    assert.ok(!hasExternalOutput(null));
  });
});

describe("describeEvalError()", () => {
  test("includes the line when known", () => {
    assert.equal(
      describeEvalError("Unexpected token\n  at foo", { line: 3 }),
      "Error on line 3: Unexpected token",
    );
    assert.equal(describeEvalError("boom", null), "Error: boom");
    assert.equal(describeEvalError("", null), "Error: error");
  });
});
