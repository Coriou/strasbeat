import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createCallRecorder, createLazyKeymaps } from "./lazy-keymaps.js";

// A loader whose promise the test settles by hand.
function deferredLoader() {
  const calls = [];
  const load = () =>
    new Promise((resolve, reject) => calls.push({ resolve, reject }));
  return { load, calls };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("createLazyKeymaps", () => {
  test("returns an empty extension and starts one fetch until the package is in", async () => {
    const { load, calls } = deferredLoader();
    const keymaps = createLazyKeymaps({
      vim: { load, extension: (mod, opts) => mod.vim(opts) },
    });
    const vim = keymaps.extension("vim");

    assert.deepEqual(vim(), []);
    assert.deepEqual(vim(), []);
    await tick();
    assert.equal(calls.length, 1, "concurrent uses share one fetch");
    assert.equal(keymaps.isLoaded("vim"), false);

    const loaded = [];
    keymaps.onLoaded((name) => {
      // By the time subscribers hear about it, asking again yields the
      // real extension — that is what lets the app simply re-apply.
      loaded.push([name, vim({ status: true })]);
    });
    calls[0].resolve({ vim: (opts) => ({ real: "vim", opts }) });
    await tick();

    assert.equal(keymaps.isLoaded("vim"), true);
    assert.deepEqual(loaded, [["vim", { real: "vim", opts: { status: true } }]]);
    assert.deepEqual(vim(), { real: "vim", opts: undefined });
    assert.equal(calls.length, 1, "no further fetches once loaded");
  });

  test("a failed fetch leaves the base keymap and is retried on the next use", async () => {
    const { load, calls } = deferredLoader();
    const keymaps = createLazyKeymaps({
      emacs: { load, extension: (mod) => mod.emacs() },
    });
    const emacs = keymaps.extension("emacs");
    const loaded = [];
    keymaps.onLoaded((name) => loaded.push(name));

    assert.deepEqual(emacs(), []);
    await tick();
    calls[0].reject(new Error("offline"));
    await tick();
    assert.equal(keymaps.isLoaded("emacs"), false);
    assert.deepEqual(loaded, []);

    // Still usable, and asking again tries again.
    assert.deepEqual(emacs(), []);
    await tick();
    assert.equal(calls.length, 2);
    calls[1].resolve({ emacs: () => "real emacs" });
    await tick();
    assert.equal(emacs(), "real emacs");
    assert.deepEqual(loaded, ["emacs"]);
  });

  test("status follows a keymap from asked-for to in force, through a failure", async () => {
    const { load, calls } = deferredLoader();
    const keymaps = createLazyKeymaps({
      vim: { load, extension: (mod) => mod.vim() },
    });
    const vim = keymaps.extension("vim");
    const seen = [];
    keymaps.onStatus((name, status) => seen.push(`${name}:${status}`));
    // What the app does on arrival: put the real keymap in the editor.
    let applied = null;
    keymaps.onLoaded(() => (applied = vim()));

    assert.equal(keymaps.status("vim"), "idle");
    assert.equal(keymaps.status("codemirror"), "ready", "built-in keymaps never wait");

    vim();
    assert.equal(keymaps.status("vim"), "loading");
    await tick();
    calls[0].reject(new Error("offline"));
    await tick();
    assert.equal(keymaps.status("vim"), "failed");

    vim();
    assert.equal(keymaps.status("vim"), "loading");
    await tick();
    keymaps.onStatus((_name, status) => {
      if (status === "ready") assert.equal(applied, "real vim", "applied before it is called ready");
    });
    calls[1].resolve({ vim: () => "real vim" });
    await tick();
    assert.equal(keymaps.status("vim"), "ready");
    assert.deepEqual(seen, ["vim:loading", "vim:failed", "vim:loading", "vim:ready"]);
  });

  test("keymaps load independently and run their onLoad hook first", async () => {
    const order = [];
    const keymaps = createLazyKeymaps({
      vim: {
        load: async () => ({ vim: () => "v" }),
        extension: (mod) => mod.vim(),
        onLoad: () => order.push("onLoad"),
      },
      emacs: {
        load: async () => ({ emacs: () => "e" }),
        extension: (mod) => mod.emacs(),
      },
    });
    keymaps.onLoaded((name) => order.push(`loaded:${name}`));
    await keymaps.ensure("vim");
    assert.deepEqual(order, ["onLoad", "loaded:vim"]);
    assert.equal(keymaps.isLoaded("emacs"), false);
    await assert.rejects(keymaps.ensure("helix"), /unknown keymap/);
  });

  test("an unsubscribed or throwing listener does not break loading", async () => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const keymaps = createLazyKeymaps({
        vim: { load: async () => ({}), extension: () => "x" },
      });
      const heard = [];
      const off = keymaps.onLoaded(() => heard.push("off"));
      keymaps.onLoaded(() => {
        throw new Error("listener bug");
      });
      keymaps.onLoaded(() => heard.push("on"));
      off();
      await keymaps.ensure("vim");
      assert.deepEqual(heard, ["on"]);
    } finally {
      console.warn = realWarn;
    }
  });
});

describe("createCallRecorder", () => {
  test("records configuration calls and replays them in order on the real object", () => {
    const { proxy, adopt } = createCallRecorder();
    // The guard upstream uses before configuring Vim.
    assert.equal(typeof proxy.defineEx, "function");
    const quit = () => {};
    proxy.defineAction("strudelToggleComment", quit);
    proxy.mapCommand("gc", "action", "strudelToggleComment", {}, { context: "normal" });
    proxy.defineEx("write", "w", quit);

    const seen = [];
    const real = {
      tag: "real",
      defineAction(...args) {
        seen.push(["defineAction", this.tag, args]);
      },
      mapCommand(...args) {
        seen.push(["mapCommand", this.tag, args.length]);
      },
      defineEx(...args) {
        seen.push(["defineEx", this.tag, args.slice(0, 2)]);
      },
    };
    adopt(real);
    assert.deepEqual(seen, [
      ["defineAction", "real", ["strudelToggleComment", quit]],
      ["mapCommand", "real", 5],
      ["defineEx", "real", ["write", "w"]],
    ]);

    // After adoption calls go straight through, bound to the real object.
    proxy.defineEx("quit", "q", quit);
    assert.deepEqual(seen.at(-1), ["defineEx", "real", ["quit", "q"]]);
    assert.equal(proxy.tag, "real");
  });

  test("one bad recorded call does not stop the rest from replaying", () => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const { proxy, adopt } = createCallRecorder();
      proxy.missing();
      proxy.ok(1);
      const seen = [];
      adopt({ ok: (n) => seen.push(n) });
      assert.deepEqual(seen, [1]);
    } finally {
      console.warn = realWarn;
    }
  });
});
