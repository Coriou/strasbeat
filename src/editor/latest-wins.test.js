import { test } from "node:test";
import assert from "node:assert/strict";

import { createLatestWinsRunner } from "./latest-wins.js";

// A hand-cranked clock + timer queue so the tests control time exactly.
function harness({ maxGapMs } = {}) {
  let time = 0;
  const timers = [];
  const runs = [];
  const request = createLatestWinsRunner(
    () => {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      runs.push({ startedAt: time, finish: resolve });
      return promise;
    },
    {
      maxGapMs,
      now: () => time,
      setTimer: (fn, ms) => timers.push({ fn, at: time + ms }),
    },
  );
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    request,
    runs,
    timers,
    advance(ms) {
      time += ms;
    },
    async finish(i) {
      runs[i].finish();
      await settle();
    },
    async runTimers() {
      for (const t of timers.splice(0)) {
        if (t.at > time) time = t.at;
        t.fire = t.fn();
      }
      await settle();
    },
  };
}

test("an idle runner starts synchronously", () => {
  const h = harness();
  h.request();
  assert.equal(h.runs.length, 1);
});

test("requests during a run collapse into one trailing run", async () => {
  const h = harness();
  h.request();
  for (let i = 0; i < 20; i++) h.request();
  assert.equal(h.runs.length, 1, "nothing queued while in flight");
  h.advance(100);
  await h.finish(0);
  // The trailing run waits out the cool-down, then fires exactly once.
  assert.equal(h.runs.length, 1);
  assert.equal(h.timers.length, 1);
  await h.runTimers();
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1].startedAt, 200, "idle for as long as the run took");
  await h.finish(1);
  assert.equal(h.timers.length, 0, "no further run without a new request");
});

test("requests during the cool-down arm a single timer", async () => {
  const h = harness();
  h.request();
  h.advance(40);
  await h.finish(0);
  h.advance(10);
  h.request();
  h.request();
  h.request();
  assert.equal(h.runs.length, 1);
  assert.equal(h.timers.length, 1);
  await h.runTimers();
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1].startedAt, 80);
});

test("a cheap run does not delay the next request", async () => {
  const h = harness();
  h.request();
  await h.finish(0); // took 0 ms
  h.request();
  assert.equal(h.runs.length, 2);
});

test("the cool-down is capped", async () => {
  const h = harness({ maxGapMs: 50 });
  h.request();
  h.request();
  h.advance(1000);
  await h.finish(0);
  await h.runTimers();
  assert.equal(h.runs[1].startedAt, 1050);
});

test("a throwing run is reported and does not wedge the runner", async () => {
  const errors = [];
  let calls = 0;
  const request = createLatestWinsRunner(
    () => {
      calls++;
      throw new Error("boom");
    },
    { now: () => 0, onError: (e) => errors.push(e.message) },
  );
  request();
  await new Promise((r) => setImmediate(r));
  request();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.deepEqual(errors, ["boom", "boom"]);
});
