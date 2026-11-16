import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  exampleForTry,
  parseInlineDoc,
  plainInlineDoc,
} from "./reference-panel.js";
import {
  collectSounds,
  categorizeSounds,
  userSoundNames,
} from "./sound-browser.js";
import { parseCycles, fmtDb, computePeaks } from "./export-panel.js";
import { confirm, prompt, formModal, choiceModal } from "./modal.js";
import { tryReferenceExample } from "../editor-actions.js";

const docs = JSON.parse(
  readFileSync(new URL("../editor/strudel-docs.json", import.meta.url), "utf8"),
);

describe("reference panel: exampleForTry", () => {
  test("leaves examples that already make sound alone", () => {
    for (const ex of [
      's("bd sd")',
      'note("c e g")',
      'n("0 2 4").scale("C:major")',
      '"<1 1.5>*4".mul(150).freq()',
      "progression('Cm7 F7')",
    ]) {
      assert.equal(exampleForTry(ex), ex);
    }
  });

  test("gives a bare single-expression example a sound", () => {
    assert.equal(
      exampleForTry('slowcat("e5", "b4", ["d5", "c5"])'),
      'slowcat("e5", "b4", ["d5", "c5"]).s("piano")',
    );
  });

  test("never appends after a comment, a semicolon or a second statement", () => {
    for (const ex of [
      'gap(3) // "~@3"',
      'silence // "~"',
      'const line = drawLine("0 [1 2 3]", 10);\nconsole.log(line);\nsilence;',
      "// note\nclearScope() // removes myVar",
      "await initHydra()\nosc(10, 0.1, 1.2).out()",
      'osc(10).rotate(H("0 0.5 1"))',
    ]) {
      assert.equal(exampleForTry(ex), ex);
    }
  });

  test("every shipped first example comes out either untouched or as one expression + .s()", () => {
    for (const [name, entry] of Object.entries(docs)) {
      const ex = entry.examples?.[0];
      if (!ex) continue;
      const out = exampleForTry(ex);
      if (out === ex) continue;
      assert.equal(out, `${ex.trim()}.s("piano")`, name);
      assert.ok(!/[\n;]|\/\//.test(ex.trim()), `${name}: not a bare expression`);
    }
  });
});

describe("reference panel: inline doc markup", () => {
  test("bold, code, links and {@link} become runs; the rest stays text", () => {
    assert.deepEqual(parseInlineDoc("the **l**ow-**p**ass `lpf` filter"), [
      { type: "text", text: "the " },
      { type: "strong", text: "l" },
      { type: "text", text: "ow-" },
      { type: "strong", text: "p" },
      { type: "text", text: "ass " },
      { type: "code", text: "lpf" },
      { type: "text", text: " filter" },
    ]);
    assert.deepEqual(parseInlineDoc("see [here](https://strudel.cc/x) or {@link cat}"), [
      { type: "text", text: "see " },
      { type: "link", text: "here", href: "https://strudel.cc/x" },
      { type: "text", text: " or cat" },
    ]);
  });

  test("only http(s) links become links", () => {
    assert.deepEqual(parseInlineDoc("[x](javascript:alert(1))")[0].type, "text");
    assert.ok(
      parseInlineDoc("[x](javascript:alert(1))").every((r) => r.type !== "link"),
    );
  });

  test("plain reading drops the markers and keeps the words", () => {
    assert.equal(
      plainInlineDoc("Applies the **l**ow-**p**ass **f**ilter, see `hpf`."),
      "Applies the low-pass filter, see hpf.",
    );
    assert.equal(plainInlineDoc("2 * 3 * 4 and a_b"), "2 * 3 * 4 and a_b");
  });

  test("no shipped doc string keeps a bold marker after rendering", () => {
    for (const [name, entry] of Object.entries(docs)) {
      assert.ok(!plainInlineDoc(entry.doc ?? "").includes("**"), name);
    }
  });
});

describe("sound browser: kits and user sounds", () => {
  const map = {
    gm_piano: { data: { type: "soundfont" } },
    gm_pad_warm: { data: { type: "soundfont" } },
    gm_epiano1: { data: { type: "soundfont" } },
    wt_a: {},
    wt_b: {},
    wt_c: {},
    tr808_bd: { data: { type: "sample", samples: ["a.wav"] } },
    tr808_sd: { data: { type: "sample", samples: ["a.wav", "b.wav"] } },
    tr808_hh: { data: { type: "sample", samples: ["a.wav"] } },
    sawtooth: { data: { type: "synth" } },
    kick: { data: { type: "sample", samples: ["k.wav"] } },
  };

  test("soundfonts and wavetables are not drum kits", () => {
    const sounds = collectSounds(map);
    const kitOf = Object.fromEntries(sounds.map((s) => [s.name, s.kit]));
    assert.equal(kitOf.gm_piano, null);
    assert.equal(kitOf.wt_a, null);
    assert.equal(kitOf.tr808_bd, "tr808");
    assert.equal(kitOf.kick, null);
  });

  test("a bank alias is searchable on the original's row, not a second kit", () => {
    const machine = (file) => ({
      data: { type: "sample", samples: [file], tag: "drum-machines" },
    });
    const withAliases = {
      rolandtr909_bd: machine("bd.wav"),
      rolandtr909_sd: machine("sd.wav"),
      rolandtr909_hh: machine("hh.wav"),
    };
    // aliasBank() files the same entry object under the short name
    for (const name of Object.keys(withAliases)) {
      withAliases[name.replace("roland", "")] = withAliases[name];
    }
    const sounds = collectSounds(withAliases);
    assert.deepEqual(
      sounds.map((s) => [s.name, s.kit, s.aliases]),
      [
        ["rolandtr909_bd", "rolandtr909", ["tr909_bd"]],
        ["rolandtr909_sd", "rolandtr909", ["tr909_sd"]],
        ["rolandtr909_hh", "rolandtr909", ["tr909_hh"]],
      ],
    );
    assert.equal(categorizeSounds(withAliases).total, 3);
  });

  test("tagged instrument families are grouped by tag, not as kits", () => {
    const tagged = (tag, samples) => ({ data: { type: "sample", samples, tag } });
    const sounds = collectSounds({
      recorder_alto_sus: tagged("instruments", { c4: ["a.wav"] }),
      recorder_alto_vib: tagged("instruments", { c4: ["a.wav"] }),
      recorder_bass_sus: tagged("instruments", { c3: ["a.wav"] }),
      mridangam_ta: tagged("percussion", ["ta.wav"]),
      mridangam_ki: tagged("percussion", ["ki.wav"]),
      mridangam_dhin: tagged("percussion", ["dhin.wav"]),
      // untagged (user import, inline samples()): still judged by its names
      mykit_bd: tagged(undefined, ["bd.wav"]),
      mykit_sd: tagged(undefined, ["sd.wav"]),
      mykit_hh: tagged(undefined, ["hh.wav"]),
    });
    const by = Object.fromEntries(sounds.map((s) => [s.name, s]));
    assert.equal(by.recorder_alto_sus.kit, null);
    assert.equal(by.recorder_alto_sus.tag, "instruments");
    assert.equal(by.mridangam_ta.kit, null);
    assert.equal(by.mridangam_ta.tag, "percussion");
    assert.equal(by.mykit_bd.kit, "mykit");
    assert.equal(by.mykit_bd.tag, null);
  });

  test("user sounds are the manifest's keys, not the bank's name", () => {
    const banks = [
      { name: "strudel", sampleMap: { _base: "https://x/", kick: ["k.wav"], snare: ["s.wav"] } },
      { name: "broken" },
    ];
    const names = userSoundNames(banks);
    assert.deepEqual([...names].sort(), ["kick", "snare"]);
    assert.equal(categorizeSounds(map, names).user, 1);
    assert.equal(categorizeSounds(map).user, 0);
  });

  test("an empty or missing map yields no sounds", () => {
    assert.deepEqual(collectSounds({}), []);
    assert.deepEqual(userSoundNames(undefined), new Set());
  });
});

describe("export panel helpers", () => {
  test("cycles must be a whole number in range", () => {
    assert.equal(parseCycles("4"), 4);
    assert.equal(parseCycles(" 128 "), 128);
    for (const bad of ["4.7", "1e2", "0", "129", "-3", "", "abc", null]) {
      assert.equal(parseCycles(bad), null, String(bad));
    }
  });

  test("peak level always reads unambiguously", () => {
    assert.equal(fmtDb(0.5), "-6.0");
    assert.equal(fmtDb(2), "+6.0");
    assert.equal(fmtDb(1), "0.0");
    assert.equal(fmtDb(0), "-∞");
  });

  test("peaks keep each column's extremes without the samples", () => {
    const data = new Float32Array([0, 0.5, -0.25, 0, 1.5, -1, 0, 0]);
    const buffer = {
      length: data.length,
      numberOfChannels: 1,
      getChannelData: () => data,
    };
    const peaks = computePeaks(buffer, 2);
    assert.deepEqual([...peaks], [-0.25, 0.5, -1, 1.5]);
    assert.equal(computePeaks({ length: 0 }), null);
  });
});

describe("modal: option guard", () => {
  test("a bare string (the window.confirm calling convention) throws", () => {
    assert.throws(() => confirm("Delete everything?"), TypeError);
    assert.throws(() => prompt(undefined), TypeError);
    assert.throws(() => formModal({ fields: [] }), /title/);
    assert.throws(() => choiceModal({ title: "" }), /title/);
  });
});

describe("tryReferenceExample: examples open in the scratch pattern", () => {
  function setup({ current = "my-song", buffer = "my precious work", stored = {} } = {}) {
    const log = [];
    const records = { ...stored };
    const editor = {
      code: buffer,
      setCode(code) {
        this.code = code;
        log.push(["setCode", code]);
      },
      async evaluate() {
        log.push(["evaluate"]);
      },
    };
    const state = { current, confirmAnswer: true, confirms: [] };
    const ctx = {
      editor,
      getCurrentName: () => state.current,
      confirm: async (opts) => {
        state.confirms.push(opts);
        return state.confirmAnswer;
      },
      scratch: {
        name: "try-example",
        read: (name) => records[name] ?? null,
        write: (name, code) => {
          records[name] = code;
          log.push(["write", name]);
        },
        create: async (name, code) => {
          records[name] = code;
          state.current = name;
          editor.code = code;
          log.push(["create", name]);
          return { ok: true };
        },
        open: (name) => {
          state.current = name;
          editor.code = records[name];
          log.push(["open", name]);
        },
      },
    };
    return { ctx, editor, state, records, log };
  }

  test("first Try creates the scratch pattern and never touches the open buffer", async () => {
    const { ctx, state, records, log } = setup();
    assert.equal(await tryReferenceExample('s("bd")', ctx), true);
    assert.deepEqual(log, [["create", "try-example"], ["evaluate"]]);
    assert.equal(records["try-example"], 's("bd")');
    assert.equal(state.confirms.length, 0);
  });

  test("an edited scratch pattern is only replaced after an honest confirm", async () => {
    const { ctx, state, records, log } = setup({
      stored: { "try-example": "// my own tweaks" },
    });
    state.confirmAnswer = false;
    assert.equal(await tryReferenceExample('s("hh*8")', ctx), false);
    assert.equal(records["try-example"], "// my own tweaks");
    assert.deepEqual(log, []);
    assert.equal(state.confirms.length, 1);
    assert.equal(state.confirms[0].destructive, true);
    assert.match(state.confirms[0].title, /try-example/);

    state.confirmAnswer = true;
    assert.equal(await tryReferenceExample('s("hh*8")', ctx), true);
    assert.deepEqual(log, [["write", "try-example"], ["open", "try-example"], ["evaluate"]]);
  });

  test("with the scratch pattern in front, Try replaces its buffer in place", async () => {
    const { ctx, state, log } = setup({ current: "try-example", buffer: "" });
    assert.equal(await tryReferenceExample('note("c")', ctx), true);
    assert.deepEqual(log, [["setCode", 'note("c")'], ["evaluate"]]);
    assert.equal(state.confirms.length, 0);
  });

  test("a failed create surfaces as a rejection, not a silent success", async () => {
    const { ctx } = setup();
    ctx.scratch.create = async () => ({ ok: false, error: "storage full" });
    await assert.rejects(tryReferenceExample('s("bd")', ctx), /storage full/);
  });
});
