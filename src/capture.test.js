import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { handleCaptureClick } from "./capture.js";

// Everything handleCaptureClick touches is injected, so the whole
// stop-capture → preview → save/discard flow runs headlessly. `showPreview`
// stands in for the modal: it receives the same callbacks and decides how the
// dialog is "left".
function makeHarness({ buffer = "// my song\nnote(\"c e g\")", records = {}, userPatterns = [] } = {}) {
  const recs = new Map(Object.entries(records));
  let idx = { lastOpen: null, userPatterns: [...userPatterns] };
  const log = { setCode: [], evaluated: [], replEvaluated: [], stops: 0, statuses: [], opened: [], added: [], replCode: null };
  const editor = {
    code: buffer,
    setCode(code) { log.setCode.push(code); this.code = code; },
    evaluate() { log.evaluated.push(this.code); },
    stop() { log.stops++; },
    repl: {
      evaluate: async (code) => { log.replEvaluated.push(code); },
      setCode: (code) => { log.replCode = code; },
    },
  };
  const store = {
    get: (n) => (recs.has(n) ? recs.get(n) : null),
    set: (n, r) => { recs.set(n, r); return true; },
    delete: (n) => recs.delete(n),
    getIndex: () => structuredClone(idx),
    setIndex: (i) => { idx = structuredClone(i); },
  };
  const deps = {
    midi: {
      isCaptureEnabled: () => true,
      setCaptureEnabled: () => {},
      getCaptureCount: () => 4,
      isMetronomeEnabled: () => false,
      buildPatternFromCapture: ({ gridSubdivision }) => `note("c4 e4") // grid ${gridSubdivision ?? "auto"}`,
    },
    midiBar: { setCaptureState: () => {} },
    transport: { setStatus: (s) => log.statuses.push(s) },
    editor,
    store,
    leftRail: { addUserPattern: (n) => log.added.push(n) },
    prompt: async () => null,
    setCurrentName: () => {},
    openPattern: (n) => log.opened.push(n),
  };
  return { deps, log, editor, store, recs, idx: () => idx };
}

const ORIGINAL = "// my song\nnote(\"c e g\")";

describe("capture preview never touches the open pattern", () => {
  test("Play auditions the take without writing it into the editor buffer", async () => {
    const h = makeHarness();
    let bufferDuringPreview;
    await handleCaptureClick({
      ...h.deps,
      isProd: true,
      showPreview: async ({ initialCode, onPlay }) => {
        await onPlay(initialCode);
        bufferDuringPreview = h.editor.code;
        return null;
      },
    });
    assert.equal(bufferDuringPreview, ORIGINAL, "buffer untouched while previewing");
    assert.deepEqual(h.log.setCode, [], "the editor document was never replaced");
    assert.deepEqual(h.log.evaluated, [], "the buffer was never evaluated on the take's behalf");
    assert.deepEqual(h.log.replEvaluated, ['note("c4 e4") // grid auto']);
  });

  test("Play → Save (prod): the open pattern keeps its code; the take becomes its own pattern", async () => {
    const h = makeHarness({ records: { "my-song": { code: ORIGINAL, isUserPattern: true } }, userPatterns: ["my-song"] });
    await handleCaptureClick({
      ...h.deps,
      isProd: true,
      showPreview: async ({ initialCode, onPlay }) => {
        await onPlay(initialCode);
        return { code: initialCode };
      },
    });
    assert.equal(h.editor.code, ORIGINAL);
    assert.deepEqual(h.log.setCode, []);
    assert.equal(h.recs.get("my-song").code, ORIGINAL);
    const [captureName] = h.log.opened;
    assert.match(captureName, /^captured-\d{14}$/);
    assert.equal(h.recs.get(captureName).code, 'note("c4 e4") // grid auto');
    assert.deepEqual(h.idx().userPatterns, ["my-song", captureName]);
    assert.equal(h.log.stops, 1, "preview playback stopped before the new tab opens");
    assert.equal(h.log.replCode, ORIGINAL, "repl pointed back at the buffer");
  });

  test("Play → Discard / Escape: buffer untouched and the preview is stopped", async () => {
    const h = makeHarness();
    await handleCaptureClick({
      ...h.deps,
      isProd: true,
      showPreview: async ({ initialCode, onPlay }) => { await onPlay(initialCode); return null; },
    });
    assert.equal(h.editor.code, ORIGINAL);
    assert.equal(h.log.stops, 1);
    assert.deepEqual(h.log.opened, []);
    assert.equal(h.log.statuses.at(-1), "capture discarded");
  });

  test("leaving without ever pressing Play does not stop the user's own playback", async () => {
    const h = makeHarness();
    await handleCaptureClick({ ...h.deps, isProd: true, showPreview: async () => null });
    assert.equal(h.log.stops, 0);
  });

  test("a failing preview is reported and still leaves the buffer alone", async () => {
    const h = makeHarness();
    h.editor.repl.evaluate = async () => { throw new Error("boom"); };
    await handleCaptureClick({
      ...h.deps,
      isProd: true,
      showPreview: async ({ initialCode, onPlay }) => { await onPlay(initialCode); return null; },
    });
    assert.equal(h.editor.code, ORIGINAL);
    assert.ok(h.log.statuses.some((s) => /preview failed: boom/.test(s)));
  });

  test("the preview is stopped even when the dialog itself throws", async () => {
    const h = makeHarness();
    await assert.rejects(
      handleCaptureClick({
        ...h.deps,
        isProd: true,
        showPreview: async ({ initialCode, onPlay }) => { await onPlay(initialCode); throw new Error("dialog broke"); },
      }),
      /dialog broke/,
    );
    assert.equal(h.log.stops, 1);
    assert.equal(h.editor.code, ORIGINAL);
  });

  test("Play → Save (dev): buffer untouched on success, on a failed save, and on cancel", async () => {
    const h = makeHarness();
    const names = ["taken", "fresh"];
    const posted = [];
    await handleCaptureClick({
      ...h.deps,
      isProd: false,
      prompt: async () => names.shift() ?? null,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        posted.push(body);
        if (body.name === "taken") return { ok: false, status: 409, text: async () => "exists" };
        return { ok: true, status: 200, json: async () => ({ path: `patterns/${body.name}.js` }) };
      },
      showPreview: async ({ initialCode, onPlay }) => { await onPlay(initialCode); return { code: initialCode }; },
    });
    assert.equal(h.editor.code, ORIGINAL);
    assert.deepEqual(h.log.setCode, []);
    assert.deepEqual(posted.map((b) => b.name), ["taken", "fresh"], "asked again instead of dropping the take");
    assert.ok(posted.every((b) => b.overwrite !== true), "never asks the server to overwrite a file");
    assert.ok(h.log.statuses.some((s) => /already exists/.test(s)));
    assert.match(h.log.statuses.at(-1), /captured phrase → patterns\/fresh\.js/);
  });
});

describe("capture save errors are surfaced", () => {
  const save = { showPreview: async ({ initialCode }) => ({ code: initialCode }) };

  test("prod: a non-quota storage failure is reported, not swallowed", async () => {
    const h = makeHarness();
    h.store.set = () => { throw new Error("denied"); };
    await handleCaptureClick({ ...h.deps, ...save, isProd: true });
    assert.match(h.log.statuses.at(-1), /couldn’t save the capture: denied/);
    assert.deepEqual(h.log.opened, []);
  });

  test("prod: a full storage is reported", async () => {
    const h = makeHarness();
    h.store.set = () => { const e = new Error("q"); e.name = "QuotaExceededError"; throw e; };
    await handleCaptureClick({ ...h.deps, ...save, isProd: true });
    assert.match(h.log.statuses.at(-1), /storage full/);
  });

  test("prod: two takes saved in the same second get distinct records", async () => {
    const h = makeHarness();
    await handleCaptureClick({ ...h.deps, ...save, isProd: true });
    await handleCaptureClick({ ...h.deps, ...save, isProd: true });
    assert.equal(new Set(h.log.opened).size, 2);
    assert.equal(h.recs.size, 2);
  });

  test("dev: a rejected fetch is reported and the prompt returns", async () => {
    const h = makeHarness();
    let prompts = 0;
    await handleCaptureClick({
      ...h.deps,
      ...save,
      isProd: false,
      prompt: async () => (++prompts === 1 ? "take" : null),
      fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
    });
    assert.equal(prompts, 2);
    assert.ok(h.log.statuses.some((s) => /save failed: Failed to fetch/.test(s)));
    assert.equal(h.log.statuses.at(-1), "capture discarded");
  });

  test("dev: the name of a pattern already in the library is refused by the prompt", async () => {
    const h = makeHarness({ records: { "my-song": { code: ORIGINAL, isUserPattern: true } } });
    let validate;
    await handleCaptureClick({
      ...h.deps,
      ...save,
      isProd: false,
      prompt: async (opts) => { validate = opts.validate; return null; },
    });
    assert.match(validate("my-song"), /already exists/);
    assert.equal(validate("brand-new"), null);
    assert.match(validate("no spaces"), /letters/);
    assert.equal(h.recs.get("my-song").code, ORIGINAL);
  });
});

describe("a take the translator refuses", () => {
  test("is reported in the status line instead of throwing out of the click", async () => {
    const h = makeHarness();
    let previewShown = false;
    await assert.doesNotReject(
      handleCaptureClick({
        ...h.deps,
        midi: {
          ...h.deps.midi,
          buildPatternFromCapture: () => {
            throw new Error("this MIDI spans 2084 bars");
          },
        },
        showPreview: async () => {
          previewShown = true;
        },
      }),
    );
    assert.equal(previewShown, false);
    assert.match(h.log.statuses.at(-1), /capture couldn.t be turned into a pattern: this MIDI spans 2084 bars/);
    assert.equal(h.editor.code, ORIGINAL);
  });
});

describe("capture preview during a WAV export", () => {
  test("Play does not start the scheduler while an export renders", async () => {
    const h = makeHarness();
    await handleCaptureClick({
      ...h.deps,
      isProd: true,
      isExportRunning: () => true,
      showPreview: async ({ initialCode, onPlay }) => {
        await onPlay(initialCode);
      },
    });
    assert.deepEqual(h.log.replEvaluated, []);
    assert.equal(h.log.stops, 0, "nothing was started, so nothing is stopped");
    assert.ok(h.log.statuses.some((s) => /Export in progress/.test(s)));
  });
});
