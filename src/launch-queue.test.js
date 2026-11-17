// Run with: node --import ./scripts/test-register.mjs --test src/launch-queue.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { listenForLaunches } from "./launch-queue.js";

console.warn = () => {};

// A launch queue as the browser keeps it: launches queued before the
// consumer is set are handed over synchronously inside setConsumer.
function fakeQueue(queued = []) {
  let consumer = null;
  return {
    setConsumer(fn) {
      consumer = fn;
      for (const targetURL of queued) fn({ targetURL });
    },
    launch(targetURL) {
      consumer({ targetURL });
    },
  };
}
const collect = (launches) => {
  const got = [];
  launches.setHandler((url) => got.push(url.href));
  return got;
};

const BOOT = "https://strasbeat.example/";

describe("listenForLaunches()", () => {
  test("a launch into the open window is delivered", () => {
    const q = fakeQueue([BOOT]);
    const got = collect(listenForLaunches(q, { bootHref: BOOT }));
    q.launch("https://strasbeat.example/?action=new");
    assert.deepEqual(got, ["https://strasbeat.example/?action=new"]);
  });

  test("the launch already queued when the page starts is skipped, whatever its URL", () => {
    // A reload of a window first opened by the New shortcut: boot ran the
    // action and removed it from the address, the queue still holds it.
    const q = fakeQueue(["https://strasbeat.example/?action=new"]);
    const got = collect(listenForLaunches(q, { bootHref: BOOT }));
    assert.deepEqual(got, []);
  });

  test("a boot launch queued after the consumer is skipped too, however its URL is spelled", () => {
    const q = fakeQueue();
    const got = collect(listenForLaunches(q, { bootHref: `${BOOT}?action=export` }));
    q.launch("https://strasbeat.example:443/?action=export#");
    assert.deepEqual(got, []);
    // The same shortcut used again later does run.
    q.launch(`${BOOT}?action=export`);
    assert.deepEqual(got, [`${BOOT}?action=export`]);
  });

  test("launches before the handler is set are held, then delivered in order", () => {
    const q = fakeQueue([BOOT]);
    const launches = listenForLaunches(q, { bootHref: BOOT });
    q.launch(`${BOOT}#code=a`);
    q.launch(`${BOOT}?action=new`);
    assert.deepEqual(collect(launches), [`${BOOT}#code=a`, `${BOOT}?action=new`]);
  });

  test("no launch queue (not an installed app, not Chromium): nothing happens", () => {
    assert.deepEqual(collect(listenForLaunches(undefined, { bootHref: BOOT })), []);
  });
});
