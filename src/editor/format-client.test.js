// Exercise the worker boundary without a browser. Stale text must never
// reach CodeMirror, and a failed worker must never poison the next attempt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { createFormatClient, FormatSupersededError } from "./format-client.js";
import { formatStatus, runFormat } from "./format.js";

class FakeWorker extends EventTarget {
  messages = [];
  terminated = false;

  postMessage(message) {
    this.messages.push(message);
  }

  reply(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  terminate() {
    this.terminated = true;
  }
}

function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const workers = [];
  const format = createFormatClient({
    createWorker() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { format, workers, warnings };
}

test("creates lazily, posts ids and text, and reuses one worker", async (t) => {
  const { format, workers } = setup(t);
  assert.equal(workers.length, 0);
  const first = format('s( "bd" )');
  const worker = workers[0];
  assert.deepEqual(worker.messages, [{ id: 1, code: 's( "bd" )' }]);
  worker.reply({ id: 1, formatted: 's("bd")\n' });
  assert.equal(await first, 's("bd")\n');
  const second = format("second");
  worker.reply({ id: 2, formatted: "formatted second" });
  assert.equal(await second, "formatted second");
  assert.equal(workers.length, 1);
  t.mock.timers.tick(15_000);
  assert.equal(worker.terminated, false, "settled timers are cleared");
});

for (const stale of [{ formatted: "old" }, { error: "old parse error" }]) {
  test(`ignores a stale ${stale.error ? "error" : "answer"}`, async (t) => {
    const { format, workers, warnings } = setup(t);
    const first = assert.rejects(format("first"), FormatSupersededError);
    const second = format("second");
    workers[0].reply({ id: 2, formatted: "new" });
    assert.equal(await second, "new");
    workers[0].reply({ id: 1, ...stale });
    await first;
    assert.deepEqual(warnings, []);
  });
}

test("preserves the parse error message and keeps the worker", async (t) => {
  const { format, workers } = setup(t);
  const message = "Unexpected token (1:7)\n> 1 | stack(";
  const failed = assert.rejects(format("stack("), { message });
  workers[0].reply({ id: 1, error: message });
  await failed;
  const retry = format("fixed");
  workers[0].reply({ id: 2, formatted: "fixed\n" });
  assert.equal(await retry, "fixed\n");
  assert.equal(workers.length, 1);
});

test("timeout rejects every pending request and replaces the worker", async (t) => {
  const { format, workers, warnings } = setup(t);
  const first = assert.rejects(format("first"), /unavailable.*reload/);
  const second = assert.rejects(format("second"), /unavailable.*reload/);
  t.mock.timers.tick(15_000);
  await Promise.all([first, second]);
  assert.equal(workers[0].terminated, true);
  assert.equal(warnings.length, 1);
  const retry = format("retry");
  assert.equal(workers.length, 2);
  workers[0].reply({ id: 3, formatted: "wrong worker" });
  workers[0].dispatchEvent(new Event("error"));
  workers[1].reply({ id: 3, formatted: "retry\n" });
  assert.equal(await retry, "retry\n");
});

for (const type of ["error", "messageerror"]) {
  test(`${type} rejects every pending request and permits restart`, async (t) => {
    const { format, workers } = setup(t);
    const first = assert.rejects(format("first"), /unavailable.*reload/);
    const second = assert.rejects(format("second"), /unavailable.*reload/);
    workers[0].dispatchEvent(new Event(type));
    await Promise.all([first, second]);
    assert.equal(workers[0].terminated, true);
    const retry = format("retry");
    workers[1].reply({ id: 3, formatted: "retry\n" });
    assert.equal(await retry, "retry\n");
  });
}

test("creation failure is loud and retries on the next request", async (t) => {
  const { warnings } = setup(t);
  const worker = new FakeWorker();
  let attempts = 0;
  const format = createFormatClient({
    createWorker() {
      if (++attempts === 1) throw new Error("blocked by CSP");
      return worker;
    },
  });
  await assert.rejects(format("first"), /unavailable.*reload/);
  assert.equal(warnings.length, 1);
  const retry = format("retry");
  worker.reply({ id: 2, formatted: "retry\n" });
  assert.equal(await retry, "retry\n");
});

test("postMessage failure discards the worker", async (t) => {
  const { format, workers } = setup(t);
  const first = format("first");
  workers[0].reply({ id: 1, formatted: "first\n" });
  await first;
  workers[0].postMessage = () => {
    throw new Error("cannot post");
  };
  await assert.rejects(format("second"), /unavailable.*reload/);
  assert.equal(workers[0].terminated, true);
  const retry = format("retry");
  workers[1].reply({ id: 3, formatted: "retry\n" });
  assert.equal(await retry, "retry\n");
});

test("runFormat applies only the latest answer and reports worker failures", async (t) => {
  const { format, workers } = setup(t);
  const statuses = [];
  const view = {
    state: EditorState.create({
      doc: 's( "bd" )',
      extensions: [formatStatus.of((message) => statuses.push(message))],
    }),
    dispatch(spec) {
      this.state = this.state.update(spec).state;
    },
  };
  const first = runFormat(view, format);
  const second = runFormat(view, format);
  workers[0].reply({ id: 1, formatted: "stale" });
  assert.equal(await first, false);
  assert.equal(view.state.doc.toString(), 's( "bd" )');
  assert.deepEqual(statuses, []);
  workers[0].reply({ id: 2, formatted: 's("bd")\n' });
  assert.equal(await second, true);
  assert.equal(view.state.doc.toString(), 's("bd")\n');
  const failed = runFormat(view, format);
  workers[0].dispatchEvent(new Event("error"));
  assert.equal(await failed, false);
  assert.match(
    statuses[0],
    /^format failed: formatting is unavailable.*reload/,
  );
  assert.equal(view.state.doc.toString(), 's("bd")\n');
});
