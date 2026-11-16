import test from "node:test";
import assert from "node:assert/strict";
import {
  registerUpdates,
  disableWorker,
  UPDATE_INTERVAL,
} from "./app-update.js";
class Target extends EventTarget {
  emit(type) {
    this.dispatchEvent(new Event(type));
  }
}
function fixture({ controlled = true, waiting = false } = {}) {
  const sw = new Target();
  sw.controller = controlled ? {} : null;
  const worker = new Target();
  worker.state = "installing";
  worker.scriptURL = "https://example.test/sw.js";
  const messages = [];
  worker.postMessage = (value) => messages.push(value);
  const reg = new Target();
  reg.waiting = waiting ? worker : null;
  reg.installing = waiting ? null : worker;
  let checks = 0;
  reg.update = async () => {
    checks++;
  };
  const calls = [];
  sw.register = async (...args) => {
    calls.push(args);
    return reg;
  };
  const doc = new Target();
  doc.visibilityState = "visible";
  const notices = [];
  const errors = [];
  const logs = [];
  let reloads = 0;
  let tick;
  let time = 0;
  const deps = {
    serviceWorker: sw,
    document: doc,
    showNotice: (fn) => notices.push(fn),
    reload: () => reloads++,
    report: (...args) => errors.push(args),
    log: (...args) => logs.push(args),
    interval: (fn) => {
      tick = fn;
    },
    now: () => time,
  };
  return {
    sw,
    worker,
    reg,
    doc,
    notices,
    errors,
    logs,
    messages,
    calls,
    deps,
    reloads: () => reloads,
    checks: () => checks,
    tick: () => tick(),
    advance: () => {
      time += UPDATE_INTERVAL;
    },
    install() {
      reg.waiting = worker;
      worker.state = "installed";
      worker.emit("statechange");
    },
  };
}
test("first install never offers an update or reloads on claim", async () => {
  const f = fixture({ controlled: false });
  await registerUpdates(f.deps);
  f.install();
  f.sw.controller = {};
  f.sw.emit("controllerchange");
  assert.equal(f.notices.length, 0);
  assert.equal(f.reloads(), 0);
  assert.deepEqual(f.calls[0], [
    "/sw.js",
    { scope: "/", updateViaCache: "none" },
  ]);
});
test("controlled update waits for click and controllerchange, reloads exactly once", async () => {
  const f = fixture();
  await registerUpdates(f.deps);
  f.install();
  f.install();
  assert.equal(f.notices.length, 1);
  assert.equal(f.reloads(), 0);
  f.sw.emit("controllerchange");
  assert.equal(f.reloads(), 0);
  f.notices[0]();
  f.notices[0]();
  assert.deepEqual(f.messages, [{ type: "SKIP_WAITING" }]);
  assert.equal(f.reloads(), 0);
  f.sw.emit("controllerchange");
  f.sw.emit("controllerchange");
  assert.equal(f.reloads(), 1);
});
test("waiting at startup is offered", async () => {
  const f = fixture({ waiting: true });
  await registerUpdates(f.deps);
  assert.equal(f.notices.length, 1);
});
test("a registration failure is reported to the user, never thrown", async () => {
  const f = fixture();
  f.sw.register = async () => {
    throw new Error("registration");
  };
  assert.equal(await registerUpdates(f.deps), null);
  assert.equal(f.errors.length, 1);
});
test("a failed update check (offline) is logged, not shown", async () => {
  const g = fixture();
  g.reg.update = async () => {
    throw new Error("offline");
  };
  await registerUpdates(g.deps);
  await Promise.resolve();
  assert.equal(g.errors.length, 0);
  assert.equal(g.logs.length, 1);
});
test("visible hourly checks and return from a long hidden period", async () => {
  const f = fixture();
  await registerUpdates(f.deps);
  assert.equal(f.checks(), 1);
  f.tick();
  assert.equal(f.checks(), 1);
  f.advance();
  f.doc.visibilityState = "hidden";
  f.tick();
  assert.equal(f.checks(), 1);
  f.doc.visibilityState = "visible";
  f.doc.emit("visibilitychange");
  assert.equal(f.checks(), 2);
  f.advance();
  f.tick();
  assert.equal(f.checks(), 3);
});
test("unsupported browsers need no adapter", async () => {
  assert.equal(await registerUpdates({}), null);
});
test("browser kill switch unregisters only sw.js and deletes only our caches", async () => {
  const removed = [];
  const deleted = [];
  const sw = {
    getRegistrations: async () =>
      ["sw.js", "other.js"].map((file) => ({
        active: { scriptURL: `https://example.test/${file}` },
        unregister: async () => removed.push(file),
      })),
  };
  assert.equal(
    await disableWorker(sw, {
      keys: async () => ["strasbeat-precache-a", "strasbeat-audio-v1", "other"],
      delete: async (key) => deleted.push(key),
    }),
    true,
  );
  assert.deepEqual(removed, ["sw.js"]);
  assert.deepEqual(deleted, ["strasbeat-precache-a", "strasbeat-audio-v1"]);
});

test("a newer waiting worker replaces the notice, and an install failure is reported", async () => {
  const f = fixture({ waiting: true });
  let closed = 0;
  f.deps.showNotice = (apply) => {
    f.notices.push(apply);
    return () => closed++;
  };
  await registerUpdates(f.deps);
  const next = new Target();
  next.state = "installing";
  f.reg.installing = next;
  f.reg.emit("updatefound");
  f.reg.waiting = next;
  next.state = "installed";
  next.emit("statechange");
  assert.equal(f.notices.length, 2);
  assert.equal(closed, 1);
  f.notices[0]();
  assert.deepEqual(f.messages, []);
  next.state = "redundant";
  next.emit("statechange");
  assert.equal(
    f.errors.length,
    0,
    "a superseded waiting worker is not an install failure",
  );
  const failed = new Target();
  failed.state = "installing";
  f.reg.installing = failed;
  f.reg.emit("updatefound");
  failed.state = "redundant";
  failed.emit("statechange");
  assert.equal(f.errors.length, 1);
});
