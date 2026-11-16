// Run with:
//   node --import ./scripts/test-register.mjs --test src/default-samples.test.js
//
// The sample maps and bank aliases boot registers on top of the core kits so
// that strudel.cc snippets find the same names, and the ordering rules they
// rely on. No network: fetch is stubbed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { note, seq } from "@strudel/core";
import { aliasBank, registerSound, samples, soundMap } from "@strudel/webaudio";

import {
  SAMPLE_NAME_OWNER,
  UZU_DRUMKIT,
  UPSTREAM_SAMPLE_MAPS,
  DRUM_MACHINE_ALIASES,
  applyJsonAfter,
  createNamePrecedence,
  fetchJson,
} from "./default-samples.js";
import "./strudel-ext/index.js";

// The phases boot.js starts by name and that an entry may wait for.
const BOOT_PHASES = ["dirt-samples", "tidal-drum-machines"];

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

describe("UPSTREAM_SAMPLE_MAPS", () => {
  test("covers the maps strudel.cc prebakes that the core kits lack", () => {
    assert.deepEqual(
      UPSTREAM_SAMPLE_MAPS.map((m) => m.label),
      ["piano", "VCSL", "wavetables", "mridangam"],
    );
  });

  test("every entry is fetchable same-origin and says what it silences", () => {
    for (const m of [...UPSTREAM_SAMPLE_MAPS, DRUM_MACHINE_ALIASES]) {
      assert.match(m.manifest, /^\/strudel-cc\/[\w-]+\.json$/, m.label);
      assert.ok(m.affects.length > 10, `${m.label} has no "affects" text`);
    }
    assert.ok(BOOT_PHASES.includes(DRUM_MACHINE_ALIASES.after));
    for (const m of UPSTREAM_SAMPLE_MAPS) {
      assert.match(m.base, /^https:\/\/.+\/$/, m.label);
    }
    const labels = UPSTREAM_SAMPLE_MAPS.map((m) => m.label);
    assert.equal(new Set(labels).size, labels.length);
  });
});

describe("names more than one default map defines", () => {
  // Trimmed copies of the real manifests: the names that overlap, plus one
  // that does not.
  const DIRT = {
    _base: "https://dirt.test/",
    bd: ["bd/a.wav", "bd/b.wav", "bd/c.wav"],
    sax: ["sax/000.wav", "sax/001.wav"],
    amencutup: ["amencutup/000.wav"],
  };
  const UZU = { _base: "https://uzu.test/", bd: ["bd/1.wav"], rim: ["rim/1.wav"] };
  const VCSL = { sax: { c3: "sax/c3.wav" }, kalimba: ["kalimba/1.wav"] };
  const VCSL_BASE = "https://vcsl.test/";

  const loaders = (names) => ({
    [SAMPLE_NAME_OWNER.label]: () => samples(names.claim(DIRT)),
    [UZU_DRUMKIT.label]: () => samples(names.yieldTo(UZU)),
    VCSL: () => samples(names.yieldTo(VCSL), VCSL_BASE),
  });
  const baseOf = (name) => soundMap.get()[name]?.data.baseUrl;

  test("dirt-samples is the owner", () => {
    assert.equal(SAMPLE_NAME_OWNER.label, "dirt-samples");
    assert.ok(UPSTREAM_SAMPLE_MAPS.every((m) => !("after" in m)));
  });

  const arrivals = [
    ["dirt-samples", "uzu-drumkit", "VCSL"],
    ["uzu-drumkit", "VCSL", "dirt-samples"],
    ["VCSL", "dirt-samples", "uzu-drumkit"],
  ];
  for (const order of arrivals) {
    test(`dirt-samples keeps bd and sax when maps arrive as ${order.join(" → ")}`, async () => {
      soundMap.set({});
      const load = loaders(createNamePrecedence());
      for (const label of order) await load[label]();
      assert.equal(baseOf("bd"), DIRT._base);
      assert.equal(baseOf("sax"), DIRT._base);
      assert.equal(soundMap.get().bd.data.samples.length, 3);
      // names only one map has are untouched, with their own base url
      assert.equal(baseOf("amencutup"), DIRT._base);
      assert.equal(baseOf("rim"), UZU._base);
      assert.equal(baseOf("kalimba"), VCSL_BASE);
    });
  }

  test("without the owner (failed to load) the other maps register whole", async () => {
    soundMap.set({});
    const load = loaders(createNamePrecedence());
    await load["uzu-drumkit"]();
    await load.VCSL();
    assert.equal(baseOf("bd"), UZU._base);
    assert.equal(baseOf("sax"), VCSL_BASE);
  });

  test("names are compared the way the sound map keys them", () => {
    const names = createNamePrecedence();
    names.claim({ _base: "x/", "Big Kick": ["a.wav"] });
    assert.deepEqual(names.yieldTo({ _base: "y/", big_kick: ["b.wav"], hat: ["c.wav"] }), {
      _base: "y/",
      hat: ["c.wav"],
    });
  });
});

describe("applyJsonAfter()", () => {
  test("fetches at once, applies only after the dependency settles", async () => {
    const order = [];
    let release;
    const dependency = new Promise((r) => (release = r)).then(() =>
      order.push("dependency"),
    );
    const fetchStub = async (url) => {
      order.push(`fetch ${url}`);
      return jsonResponse({ a: 1 });
    };
    const done = applyJsonAfter(
      "/x.json",
      dependency,
      (json) => {
        order.push("apply");
        return json.a;
      },
      fetchStub,
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(order, ["fetch /x.json"]);
    release();
    assert.equal(await done, 1);
    assert.deepEqual(order, ["fetch /x.json", "dependency", "apply"]);
  });

  test("an HTTP error rejects with the url, and nothing is applied", async () => {
    let applied = false;
    await assert.rejects(
      applyJsonAfter(
        "/missing.json",
        Promise.resolve(),
        () => (applied = true),
        async () => jsonResponse(null, { ok: false, status: 404 }),
      ),
      /\/missing\.json: HTTP 404/,
    );
    assert.equal(applied, false);
    await assert.rejects(
      fetchJson("/down.json", async () => {
        throw new TypeError("Failed to fetch");
      }),
      /Failed to fetch/,
    );
  });
});

describe("drum-machine bank aliases", () => {
  test("aliasBank() only aliases sounds that are already registered", async () => {
    const trigger = () => {};
    registerSound("RolandTR909_bd", trigger);
    await aliasBank({ RolandTR909: "TR909", AkaiLinn: "Linn" });
    // registered before the alias pass → short name resolves
    assert.equal(soundMap.get().tr909_bd?.onTrigger, trigger);
    // registered after it → no short name, hence the `after` in the data
    registerSound("AkaiLinn_bd", trigger);
    assert.equal(soundMap.get().linn_bd, undefined);
    assert.equal(DRUM_MACHINE_ALIASES.after, "tidal-drum-machines");
  });
});

describe(".piano()", () => {
  const values = (pat) => pat.firstCycle().map((h) => h.value);

  test("selects the piano sound, clips to the step and pans by pitch", () => {
    const [low, high] = values(note(seq("c2", "c7")).piano());
    assert.equal(low.s, "piano");
    assert.equal(low.clip, 1);
    assert.equal(low.release, 0.1);
    assert.ok(low.pan < 0.5 && high.pan > 0.5, `${low.pan} / ${high.pan}`);
  });

  test("keeps a clip the pattern already set", () => {
    assert.equal(values(note("c3").clip(0.5).piano())[0].clip, 0.5);
  });
});
