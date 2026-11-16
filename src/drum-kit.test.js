import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DRUM_KIT_KEY,
  DRUM_KIT_NUDGE_KEY,
  SHARED_DRUM_NAMES,
  createDrumKitController,
  pickKitSounds,
  readDrumKit,
  readStoredDrumKit,
  sharedDrumNames,
  storeDrumKit,
  usesDefaultDrumKit,
} from "./drum-kit.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    _data: data,
  };
}
const brokenStorage = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
};

const CLASSIC = {
  _base: "https://dirt.test/",
  bd: ["bd/a.wav", "bd/b.wav", "bd/c.wav"],
  sd: ["sd/a.wav"],
  hh: ["hh/a.wav"],
  sax: ["sax/a.wav"],
};
const STRUDEL = {
  _base: "https://uzu.test/",
  bd: ["bd/1.wav"],
  sd: ["sd/1.wav"],
  hh: ["hh/1.wav"],
  rd: ["rd/1.wav"],
};

// Haps as the scheduler sees them: `value` holds the controls.
const hap = (value) => ({ value });

function setup({ stored = {}, storage = memoryStorage(stored), manifests = true } = {}) {
  const registered = [];
  const controller = createDrumKitController({
    samples: (sampleMap) => registered.push(sampleMap),
    storage,
  });
  if (manifests) {
    controller.setManifest("classic", CLASSIC);
    controller.setManifest("strudel", STRUDEL);
  }
  let shown = 0;
  controller.setNudge(() => shown++);
  return { controller, registered, storage, shown: () => shown };
}

describe("usesDefaultDrumKit()", () => {
  test("a bare shared drum name counts", () => {
    assert.equal(usesDefaultDrumKit([hap({ s: "bd" })]), true);
    assert.equal(usesDefaultDrumKit([hap({ s: "piano" }), hap({ s: "hh", n: 3 })]), true);
    assert.equal(usesDefaultDrumKit([hap({ s: "BD" })]), true);
    assert.equal(usesDefaultDrumKit([hap({ s: "bd:3" })]), true);
  });

  test("an explicit bank never counts", () => {
    assert.equal(usesDefaultDrumKit([hap({ s: "bd", bank: "tr909" })]), false);
    assert.equal(
      usesDefaultDrumKit([hap({ s: "bd", bank: "RolandTR909" }), hap({ s: "sd", bank: "tr808" })]),
      false,
    );
  });

  test("names only one kit has, other sounds and notes do not count", () => {
    for (const value of [
      { s: "rd" }, // uzu-drumkit only
      { s: "sax" }, // dirt-samples and VCSL: not a drum-kit question
      { s: "bd_kick" },
      { s: "gm_piano", note: 60 },
      { note: "c3" },
      { s: 3 },
    ]) {
      assert.equal(usesDefaultDrumKit([hap(value)]), false, JSON.stringify(value));
    }
    assert.equal(usesDefaultDrumKit([]), false);
    assert.equal(usesDefaultDrumKit([hap("bd"), hap(null), {}]), false);
  });

  test("the name list is the caller's to give", () => {
    assert.equal(usesDefaultDrumKit([hap({ s: "bd" })], ["sd"]), false);
    assert.equal(usesDefaultDrumKit([hap({ s: "rd" })], ["rd"]), true);
  });
});

describe("the names the choice is about", () => {
  test("are the ones both manifests define", () => {
    assert.deepEqual(sharedDrumNames(CLASSIC, STRUDEL), ["bd", "sd", "hh"]);
  });

  test("fall back to the known list until both manifests are in", () => {
    assert.deepEqual(sharedDrumNames(CLASSIC, null), SHARED_DRUM_NAMES);
    assert.deepEqual(sharedDrumNames(null, null), SHARED_DRUM_NAMES);
    assert.deepEqual(sharedDrumNames({ _base: "x" }, STRUDEL), SHARED_DRUM_NAMES);
  });

  test("pickKitSounds keeps the base and nothing else", () => {
    assert.deepEqual(pickKitSounds(STRUDEL, ["bd", "hh"]), {
      _base: "https://uzu.test/",
      bd: ["bd/1.wav"],
      hh: ["hh/1.wav"],
    });
  });
});

describe("the stored choice", () => {
  test("defaults to classic; only the two kits are accepted", () => {
    assert.equal(readDrumKit(memoryStorage()), "classic");
    assert.equal(readStoredDrumKit(memoryStorage()), null);
    assert.equal(readDrumKit(memoryStorage({ [DRUM_KIT_KEY]: "strudel" })), "strudel");
    assert.equal(readDrumKit(memoryStorage({ [DRUM_KIT_KEY]: "tr909" })), "classic");
    assert.equal(storeDrumKit("tr909", memoryStorage()), false);
  });

  test("storage that throws reads as the default and reports the failed write", () => {
    assert.equal(readDrumKit(brokenStorage), "classic");
    assert.equal(storeDrumKit("strudel", brokenStorage), false);
    assert.equal(readDrumKit(null), "classic");
  });
});

describe("the nudge", () => {
  const drums = [hap({ s: "bd" }), hap({ s: "hh" })];

  test("is shown the first time an affected pattern plays, and only then", () => {
    const { controller, shown, storage } = setup();
    assert.equal(controller.notePlayed(drums), true);
    assert.equal(shown(), 1);
    assert.equal(controller.notePlayed(drums), false);
    assert.equal(shown(), 1);
    assert.equal(storage.getItem(DRUM_KIT_NUDGE_KEY), "seen");
  });

  test("is not used up by patterns it does not concern", () => {
    const { controller, shown } = setup();
    assert.equal(controller.notePlayed([hap({ s: "gm_piano", note: 60 })]), false);
    assert.equal(controller.notePlayed([hap({ s: "bd", bank: "tr909" })]), false);
    assert.equal(controller.notePlayed([]), false);
    assert.equal(shown(), 0);
    assert.equal(controller.notePlayed(drums), true);
    assert.equal(shown(), 1);
  });

  test("does not come back in a later session", () => {
    const first = setup();
    first.controller.notePlayed(drums);
    const second = setup({ storage: first.storage });
    assert.equal(second.controller.notePlayed(drums), false);
    assert.equal(second.shown(), 0);
  });

  test("is not shown to someone who already chose a kit", () => {
    for (const kit of ["classic", "strudel"]) {
      const { controller, shown } = setup({ stored: { [DRUM_KIT_KEY]: kit } });
      assert.equal(controller.notePlayed(drums), false, kit);
      assert.equal(shown(), 0);
    }
  });

  test("is not shown after a choice made in Settings this session", () => {
    const { controller, shown } = setup();
    controller.setKit("classic");
    assert.equal(controller.notePlayed(drums), false);
    assert.equal(shown(), 0);
  });

  test("is not shown when the other kit could not be offered", () => {
    const { controller, shown, storage } = setup({ manifests: false });
    controller.setManifest("classic", CLASSIC);
    assert.equal(controller.notePlayed(drums), false);
    assert.equal(shown(), 0);
    assert.equal(storage.getItem(DRUM_KIT_NUDGE_KEY), null, "kept for a session that can");
  });

  test("is not marked as seen before there is a card to show", () => {
    const { controller, storage } = setup();
    controller.setNudge(null);
    assert.equal(controller.notePlayed(drums), false);
    assert.equal(storage.getItem(DRUM_KIT_NUDGE_KEY), null);
  });

  test("with storage that throws: never shown rather than shown every time", () => {
    const { controller, shown } = setup({ storage: brokenStorage });
    assert.equal(controller.notePlayed(drums), false);
    assert.equal(shown(), 0);
  });

  test("uses the names the two manifests really share", () => {
    const { controller, shown } = setup();
    // `cp` is in the fallback list but not in these two manifests.
    assert.equal(controller.notePlayed([hap({ s: "cp" })]), false);
    assert.equal(shown(), 0);
  });
});

describe("switching kits", () => {
  test("re-registers the shared names from the chosen kit and remembers it", () => {
    const { controller, registered, storage } = setup();
    const changes = [];
    controller.onChange((kit) => changes.push(kit));

    assert.deepEqual(controller.setKit("strudel"), { ok: true, stored: true });
    assert.deepEqual(registered, [
      { _base: "https://uzu.test/", bd: ["bd/1.wav"], sd: ["sd/1.wav"], hh: ["hh/1.wav"] },
    ]);
    assert.equal(controller.getKit(), "strudel");
    assert.equal(storage.getItem(DRUM_KIT_KEY), "strudel");

    controller.setKit("classic");
    assert.deepEqual(registered[1], {
      _base: "https://dirt.test/",
      bd: ["bd/a.wav", "bd/b.wav", "bd/c.wav"],
      sd: ["sd/a.wav"],
      hh: ["hh/a.wav"],
    });
    assert.equal(storage.getItem(DRUM_KIT_KEY), "classic");
    assert.deepEqual(changes, ["strudel", "classic"]);
  });

  test("choosing the kit already in force registers nothing but is remembered", () => {
    const { controller, registered, storage } = setup();
    assert.deepEqual(controller.setKit("classic"), { ok: true, stored: true });
    assert.deepEqual(registered, []);
    assert.equal(storage.getItem(DRUM_KIT_KEY), "classic");
    assert.equal(storage.getItem(DRUM_KIT_NUDGE_KEY), "seen");
  });

  test("a kit whose manifest never loaded is refused and nothing changes", () => {
    const { controller, registered, storage } = setup({ manifests: false });
    controller.setManifest("classic", CLASSIC);
    assert.deepEqual(controller.setKit("strudel"), { ok: false, stored: false });
    assert.equal(controller.getKit(), "classic");
    assert.deepEqual(registered, []);
    assert.equal(storage.getItem(DRUM_KIT_KEY), null);
    assert.deepEqual(controller.setKit("tr909"), { ok: false, stored: false });
  });

  test("works for the session when the choice cannot be stored", () => {
    const { controller, registered } = setup({ storage: brokenStorage });
    assert.deepEqual(controller.setKit("strudel"), { ok: true, stored: false });
    assert.equal(controller.getKit(), "strudel");
    assert.equal(registered.length, 1);
  });
});

describe("the stored choice at boot", () => {
  test("classic: the maps are left as boot registered them", () => {
    const { controller, registered } = setup();
    assert.equal(controller.applyStored(), true);
    assert.deepEqual(registered, []);
  });

  test("strudel.cc: its sounds go over the shared names", () => {
    const { controller, registered } = setup({ stored: { [DRUM_KIT_KEY]: "strudel" } });
    assert.equal(controller.getKit(), "strudel");
    assert.equal(controller.applyStored(), true);
    assert.equal(registered.length, 1);
    assert.equal(registered[0]._base, "https://uzu.test/");
    assert.deepEqual(Object.keys(registered[0]).sort(), ["_base", "bd", "hh", "sd"]);
  });

  test("strudel.cc without its manifest: reported, classic sounds stay", () => {
    const { controller, registered } = setup({
      stored: { [DRUM_KIT_KEY]: "strudel" },
      manifests: false,
    });
    controller.setManifest("classic", CLASSIC);
    assert.equal(controller.applyStored(), false);
    assert.deepEqual(registered, []);
  });
});
