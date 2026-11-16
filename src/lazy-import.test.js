import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  LazyImportError,
  describeLazyFailure,
  lazyImport,
  once,
  setLazyImportReporter,
} from "./lazy-import.js";

// Keep the expected failures out of the test output.
const realWarn = console.warn;
console.warn = () => {};
process.on("exit", () => {
  console.warn = realWarn;
});

afterEach(() => setLazyImportReporter(null));

describe("describeLazyFailure", () => {
  test("names what failed and offers both remedies when online", () => {
    const msg = describeLazyFailure("the Vim keymap");
    assert.match(msg, /^Couldn't load the Vim keymap\./);
    assert.match(msg, /connection/);
    assert.match(msg, /reload the page/);
  });

  test("says so when the browser is offline", () => {
    const msg = describeLazyFailure("the Sound browser", { online: false });
    assert.match(msg, /^Couldn't load the Sound browser: you appear to be offline/);
    assert.doesNotMatch(msg, /reload the page/);
  });

  test("still reads as a sentence without a subject", () => {
    assert.match(describeLazyFailure(""), /^Couldn't load part of the app\./);
  });
});

describe("lazyImport", () => {
  test("resolves with the module and reports nothing", async () => {
    const seen = [];
    setLazyImportReporter((err) => seen.push(err));
    const mod = { default: 1 };
    assert.equal(await lazyImport(async () => mod, { what: "x" }), mod);
    assert.deepEqual(seen, []);
  });

  test("reports a failure once and rethrows it with the cause attached", async () => {
    const seen = [];
    setLazyImportReporter((err) => seen.push(err));
    const cause = new TypeError("Failed to fetch dynamically imported module");
    await assert.rejects(
      lazyImport(() => Promise.reject(cause), { what: "the Export panel" }),
      (err) => {
        assert.ok(err instanceof LazyImportError);
        assert.equal(err.cause, cause);
        assert.equal(err.what, "the Export panel");
        assert.match(err.message, /Couldn't load the Export panel/);
        return true;
      },
    );
    assert.equal(seen.length, 1);
    assert.ok(seen[0] instanceof LazyImportError);
  });

  test("a loader that throws synchronously is reported the same way", async () => {
    const seen = [];
    setLazyImportReporter((err) => seen.push(err));
    await assert.rejects(
      lazyImport(
        () => {
          throw new Error("boom");
        },
        { what: "x" },
      ),
      LazyImportError,
    );
    assert.equal(seen.length, 1);
  });

  test("silent failures reject but are not shown to the user", async () => {
    const seen = [];
    setLazyImportReporter((err) => seen.push(err));
    await assert.rejects(
      lazyImport(() => Promise.reject(new Error("nope")), {
        what: "x",
        silent: true,
      }),
      LazyImportError,
    );
    assert.deepEqual(seen, []);
  });

  test("failures from before a reporter exists are replayed to it", async () => {
    await assert.rejects(
      lazyImport(() => Promise.reject(new Error("early")), { what: "the docs" }),
    );
    const seen = [];
    setLazyImportReporter((err) => seen.push(err.what));
    assert.deepEqual(seen, ["the docs"]);
    // …and only once.
    setLazyImportReporter((err) => seen.push(err.what));
    assert.deepEqual(seen, ["the docs"]);
  });

  test("a throwing reporter does not replace the load error", async () => {
    setLazyImportReporter(() => {
      throw new Error("reporter bug");
    });
    await assert.rejects(
      lazyImport(() => Promise.reject(new Error("nope")), { what: "x" }),
      LazyImportError,
    );
  });
});

describe("once", () => {
  test("shares one in-flight attempt and keeps the result", async () => {
    let calls = 0;
    const load = once(async () => {
      calls++;
      return { n: calls };
    });
    assert.equal(load.loaded(), false);
    const [a, b] = await Promise.all([load(), load()]);
    assert.equal(a, b);
    assert.equal(calls, 1);
    assert.equal(load.loaded(), true);
    assert.equal(load.value(), a);
    assert.equal(await load(), a);
    assert.equal(calls, 1);
  });

  test("forgets a failed attempt so the next call retries", async () => {
    let calls = 0;
    const load = once(async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      return "ok";
    });
    await assert.rejects(load(), /offline/);
    assert.equal(load.loaded(), false);
    assert.equal(await load(), "ok");
    assert.equal(calls, 2);
  });

  test("passes the caller's options through to the loader", async () => {
    const seen = [];
    const load = once(async (opts) => {
      seen.push(opts);
      return 1;
    });
    await load({ silent: true });
    assert.deepEqual(seen, [{ silent: true }]);
  });
});
