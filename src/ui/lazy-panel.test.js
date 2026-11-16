import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createLazyPanel } from "./lazy-panel.js";

const tick = () => new Promise((r) => setImmediate(r));

// The few DOM members the lazy panel touches.
function fakeSlot({ activeElement = null } = {}) {
  const doc = {
    body: { tag: "body" },
    activeElement,
    createElement: (tag) => ({
      tag,
      style: {},
      attrs: {},
      children: [],
      listeners: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      append(...els) {
        this.children.push(...els);
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
    }),
  };
  const rail = { contains: (el) => el?.inRail === true };
  return {
    ownerDocument: doc,
    children: [],
    replaceChildren(...els) {
      this.children = els;
    },
    closest: (sel) => (sel === ".right-rail" ? rail : null),
    // The text of the first line: the panel itself, or the status message.
    get text() {
      return this.children[0]?.textContent ?? "";
    },
    find(tag) {
      const walk = (els) =>
        els.flatMap((el) => [el, ...walk(el.children ?? [])]);
      return walk(this.children).find((el) => el.tag === tag) ?? null;
    },
  };
}

// A real panel that logs what happens to it.
function fakeRealPanel(log) {
  return {
    create: (slot) => {
      log.push("create");
      slot.replaceChildren({ textContent: "REAL" });
    },
    activate: (opts) => log.push(["activate", opts]),
    deactivate: () => log.push("deactivate"),
    setBufferText: (t) => log.push(["setBufferText", t]),
    scrollTo: (name) => {
      log.push(["scrollTo", name]);
      return "scrolled";
    },
    autoExport: () => log.push("autoExport"),
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup({ placeholderDelayMs = 10_000 } = {}) {
  const log = [];
  const loads = [];
  const panel = createLazyPanel({
    id: "reference",
    icon: "book-open",
    label: "API reference",
    methods: ["setBufferText", "scrollTo", "autoExport"],
    placeholderDelayMs,
    load: (opts) => {
      const d = deferred();
      loads.push({ ...d, opts });
      return d.promise;
    },
  });
  return { log, loads, panel };
}

describe("createLazyPanel", () => {
  test("is a complete rail spec before anything has loaded", () => {
    const { panel, loads } = setup();
    assert.equal(panel.id, "reference");
    assert.equal(panel.icon, "book-open");
    assert.equal(panel.label, "API reference");
    for (const m of ["create", "activate", "deactivate", "setBufferText", "scrollTo"]) {
      assert.equal(typeof panel[m], "function");
    }
    assert.equal(loads.length, 0, "registering a panel fetches nothing");
    assert.equal(panel.isLoaded(), false);
  });

  test("method calls alone do not fetch the module", async () => {
    const { panel, loads } = setup();
    panel.setBufferText("a");
    panel.setBufferText("b");
    await tick();
    assert.equal(loads.length, 0);
  });

  test("first open loads, mounts, activates, then replays the latest calls", async () => {
    const { panel, loads, log } = setup();
    const slot = fakeSlot();
    panel.setBufferText("old");
    panel.setBufferText("new");

    // What the rail does on a tab click, followed by a deep link.
    panel.create(slot);
    panel.activate({ focus: true });
    panel.scrollTo("lpf");
    await tick();
    assert.equal(loads.length, 1, "create + activate share one fetch");
    assert.deepEqual(loads[0].opts, { silent: false });
    assert.deepEqual(log, []);

    loads[0].resolve(fakeRealPanel(log));
    await tick();
    assert.deepEqual(log, [
      "create",
      ["activate", { focus: true }],
      ["setBufferText", "new"],
      ["scrollTo", "lpf"],
    ]);
    assert.equal(slot.text, "REAL");
    assert.equal(panel.isLoaded(), true);

    // From here on it is a pass-through, return values included.
    assert.equal(panel.scrollTo("hpf"), "scrolled");
    panel.deactivate();
    panel.activate({ focus: false });
    assert.deepEqual(log.slice(-3), [
      ["scrollTo", "hpf"],
      "deactivate",
      ["activate", { focus: false }],
    ]);
  });

  test("does not activate a panel the user has already left", async () => {
    const { panel, loads, log } = setup();
    panel.create(fakeSlot());
    panel.activate({ focus: true });
    panel.deactivate();
    await tick();
    loads[0].resolve(fakeRealPanel(log));
    await tick();
    assert.deepEqual(log, ["create"]);
  });

  test("does not take focus if the user moved on while it was loading", async () => {
    const { panel, loads, log } = setup();
    const slot = fakeSlot({ activeElement: { inRail: false } }); // e.g. the editor
    panel.create(slot);
    panel.activate({ focus: true });
    await tick();
    loads[0].resolve(fakeRealPanel(log));
    await tick();
    assert.deepEqual(log, ["create", ["activate", { focus: false }]]);
  });

  test("takes focus when it is still on the rail tab that was clicked", async () => {
    const { panel, loads, log } = setup();
    const slot = fakeSlot({ activeElement: { inRail: true } });
    panel.create(slot);
    panel.activate({ focus: true });
    await tick();
    loads[0].resolve(fakeRealPanel(log));
    await tick();
    assert.deepEqual(log, ["create", ["activate", { focus: true }]]);
  });

  test("a preloaded panel mounts synchronously on first open", async () => {
    const { panel, loads, log } = setup();
    panel.setBufferText("buffer");
    const warmed = panel.preload();
    await tick();
    assert.deepEqual(loads[0].opts, { silent: true });
    loads[0].resolve(fakeRealPanel(log));
    assert.equal(await warmed, true);
    // Calls made so far reach the (unmounted) panel, as they would have
    // reached an eagerly constructed one.
    assert.deepEqual(log, [["setBufferText", "buffer"]]);

    const slot = fakeSlot();
    panel.create(slot);
    assert.equal(slot.text, "REAL");
    panel.activate({ focus: true });
    assert.deepEqual(log.slice(1), ["create", ["activate", { focus: true }]]);
    assert.equal(loads.length, 1);
  });

  test("a failed preload is silent and the next open retries", async () => {
    const { panel, loads, log } = setup();
    const warmed = panel.preload();
    await tick();
    loads[0].reject(new Error("offline"));
    assert.equal(await warmed, false);

    const slot = fakeSlot();
    panel.create(slot);
    panel.activate({ focus: true });
    await tick();
    assert.equal(loads.length, 2);
    loads[1].resolve(fakeRealPanel(log));
    await tick();
    assert.equal(slot.text, "REAL");
  });

  test("a failed load says so in the panel and reopening retries", async () => {
    const { panel, loads, log } = setup();
    const slot = fakeSlot();
    panel.create(slot);
    panel.activate({ focus: true });
    await tick();
    loads[0].reject(new Error("Couldn't load the API reference."));
    await tick();
    assert.equal(slot.text, "Couldn't load the API reference.");
    assert.equal(slot.children[0].attrs.role, "status");
    assert.equal(slot.find("button").textContent, "Retry");
    assert.equal(panel.isLoaded(), false);

    // Handle methods stay safe to call in this state.
    assert.doesNotThrow(() => panel.setBufferText("x"));

    // The rail collapses and reopens the tab.
    panel.deactivate();
    panel.activate({ focus: true });
    assert.equal(slot.text, "", "the stale error is cleared while retrying");
    await tick();
    assert.equal(loads.length, 2);
    loads[1].resolve(fakeRealPanel(log));
    await tick();
    assert.equal(slot.text, "REAL");
    assert.deepEqual(log, [
      "create",
      ["activate", { focus: true }],
      ["setBufferText", "x"],
    ]);
  });

  test("the Retry button in a failed panel loads it again", async () => {
    const { panel, loads, log } = setup();
    const slot = fakeSlot();
    panel.create(slot);
    panel.activate({ focus: true });
    await tick();
    loads[0].reject(new Error("Couldn't load the API reference."));
    await tick();

    slot.find("button").listeners.click();
    assert.equal(slot.find("button"), null, "the stale error is cleared while retrying");
    await tick();
    assert.equal(loads.length, 2);
    loads[1].resolve(fakeRealPanel(log));
    await tick();
    assert.equal(slot.text, "REAL");
    assert.deepEqual(log, ["create", ["activate", { focus: true }]]);
  });

  test("requests made before a failed load are not carried out on a later one", async () => {
    const { panel, loads, log } = setup();
    const slot = fakeSlot();
    panel.setBufferText("buffer");
    // The toolbar's WAV button and a docs deep link, while offline.
    panel.create(slot);
    panel.activate({ focus: true });
    panel.autoExport();
    panel.scrollTo("lpf");
    await tick();
    loads[0].reject(new Error("offline"));
    await tick();

    // Later the tab is opened for its own sake.
    panel.deactivate();
    panel.activate({ focus: true });
    await tick();
    loads[1].resolve(fakeRealPanel(log));
    await tick();
    assert.deepEqual(log, [
      "create",
      ["activate", { focus: true }],
      ["setBufferText", "buffer"],
    ]);
  });

  test("a failed background warm-up drops stale requests too", async () => {
    const { panel, loads, log } = setup();
    panel.setBufferText("buffer");
    panel.scrollTo("lpf");
    const warmed = panel.preload();
    await tick();
    loads[0].reject(new Error("offline"));
    assert.equal(await warmed, false);

    panel.create(fakeSlot());
    panel.activate({ focus: true });
    await tick();
    loads[1].resolve(fakeRealPanel(log));
    await tick();
    assert.deepEqual(log.slice(2), [["setBufferText", "buffer"]]);
  });

  test("shows a loading line only when the load is slow", async () => {
    const { panel, loads, log } = setup({ placeholderDelayMs: 5 });
    const slot = fakeSlot();
    panel.create(slot);
    assert.equal(slot.text, "");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(slot.text, "Loading API reference…");
    loads[0].resolve(fakeRealPanel(log));
    await tick();
    assert.equal(slot.text, "REAL");
  });

  test("a panel whose create() throws reports it and can be retried", async () => {
    const realError = console.error;
    console.error = () => {};
    try {
      const { panel, loads } = setup();
      let attempts = 0;
      const real = {
        create: (slot) => {
          attempts++;
          if (attempts === 1) throw new Error("render bug");
          slot.replaceChildren({ textContent: "REAL" });
        },
        activate: () => {},
      };
      const slot = fakeSlot();
      panel.create(slot);
      panel.activate({ focus: false });
      await tick();
      loads[0].resolve(real);
      await tick();
      assert.match(slot.text, /failed to open/);
      panel.activate({ focus: false });
      assert.equal(slot.text, "REAL");
    } finally {
      console.error = realError;
    }
  });
});
