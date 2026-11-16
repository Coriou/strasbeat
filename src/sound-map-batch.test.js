// Run with:
//   node --import ./scripts/test-register.mjs --test src/sound-map-batch.test.js
//
// Batched sound registration, against superdough's real sound map: the store
// and `registerSound` are the installed ones, so an upgrade that changes how
// sounds are registered fails here instead of quietly making boot slow again.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  registerSound,
  getSound,
  soundMap,
  aliasBank,
} from "@strudel/webaudio";

import { installSoundMapBatching } from "./sound-map-batch.js";

const upstreamSetKey = soundMap.setKey;
const trigger = () => {};

// Counts how often the map's value is replaced by a new object — the copy
// that made registration quadratic.
function countReplacements(store) {
  let replacements = 0;
  let current = store.value;
  Object.defineProperty(store, "value", {
    configurable: true,
    get: () => current,
    set: (next) => {
      replacements++;
      current = next;
    },
  });
  return {
    count: () => replacements,
    restore() {
      Object.defineProperty(store, "value", {
        configurable: true,
        writable: true,
        enumerable: true,
        value: current,
      });
    },
  };
}

beforeEach(() => {
  soundMap.setKey = upstreamSetKey;
  soundMap.set({});
});

describe("the installed sound map", () => {
  test("is the store the batching relies on", () => {
    assert.equal(typeof soundMap.setKey, "function");
    assert.equal(typeof soundMap.set, "function");
    assert.equal(typeof soundMap.lc, "number");
    assert.equal(typeof soundMap.value, "object");
  });

  test("upstream copies the whole map for every registered sound", () => {
    // The behaviour this module exists for. If it stops being true, upstream
    // fixed it and sound-map-batch.js can go.
    const probe = countReplacements(soundMap);
    try {
      for (let i = 0; i < 50; i++) registerSound(`up_${i}`, trigger);
      assert.equal(probe.count(), 50);
    } finally {
      probe.restore();
    }
  });
});

describe("installSoundMapBatching", () => {
  test("registerSound goes through the batched setKey", () => {
    assert.equal(installSoundMapBatching(soundMap), true);
    let calls = 0;
    const batched = soundMap.setKey;
    soundMap.setKey = (key, value) => {
      calls++;
      batched(key, value);
    };
    registerSound("Probe Sound", trigger, { tag: "x" });
    assert.equal(calls, 1);
    assert.equal(getSound("probe_sound").data.tag, "x");
  });

  test("2,000 registrations replace the map object zero times", () => {
    installSoundMapBatching(soundMap);
    const probe = countReplacements(soundMap);
    try {
      for (let i = 0; i < 2000; i++) registerSound(`s_${i}`, trigger, { i });
      assert.equal(probe.count(), 0);
    } finally {
      probe.restore();
    }
    assert.equal(Object.keys(soundMap.get()).length, 2000);
    assert.equal(getSound("s_1999").data.i, 1999);
  });

  test("a sound is readable as soon as it is registered", () => {
    installSoundMapBatching(soundMap);
    registerSound("now", trigger);
    assert.equal(typeof soundMap.get().now.onTrigger, "function");
  });

  test("listeners get one fresh object per burst, not one per sound", async () => {
    installSoundMapBatching(soundMap);
    const seen = [];
    const unlisten = soundMap.listen((value) => seen.push(value));
    try {
      const before = soundMap.get();
      for (let i = 0; i < 100; i++) registerSound(`l_${i}`, trigger);
      assert.equal(seen.length, 0, "nothing is published inside the burst");
      await Promise.resolve();
      assert.equal(seen.length, 1);
      assert.notEqual(seen[0], before, "the published object is a new one");
      assert.equal(Object.keys(seen[0]).length, 100);

      registerSound("l_late", trigger);
      await Promise.resolve();
      assert.equal(seen.length, 2);
    } finally {
      unlisten();
    }
  });

  test("registering the same sound object again publishes nothing", async () => {
    installSoundMapBatching(soundMap);
    registerSound("same", trigger);
    const sound = getSound("same");
    const seen = [];
    const unlisten = soundMap.listen((value) => seen.push(value));
    try {
      soundMap.setKey("same", sound);
      await Promise.resolve();
      assert.equal(seen.length, 0);
    } finally {
      unlisten();
    }
  });

  test("setKey(name, undefined) still removes a sound", () => {
    installSoundMapBatching(soundMap);
    registerSound("gone", trigger);
    soundMap.setKey("gone", undefined);
    assert.equal("gone" in soundMap.get(), false);
    soundMap.setKey("never_there", undefined); // no throw
  });

  test("aliasBank and a later reset keep working", () => {
    installSoundMapBatching(soundMap);
    registerSound("RolandTR909_bd", trigger);
    aliasBank({ RolandTR909: "tr909" });
    assert.equal(getSound("tr909_bd"), getSound("rolandtr909_bd"));
    registerSound("after_alias", trigger);
    assert.ok(getSound("after_alias"));
    soundMap.set({});
    registerSound("after_reset", trigger);
    assert.deepEqual(Object.keys(soundMap.get()), ["after_reset"]);
  });

  test("installing twice keeps one patch", () => {
    installSoundMapBatching(soundMap);
    const first = soundMap.setKey;
    assert.equal(installSoundMapBatching(soundMap), true);
    assert.equal(soundMap.setKey, first);
  });

  test("an unexpected store is left alone, with a warning", () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const odd = { setKey() {}, set() {} }; // no `value`, no `lc`
      const original = odd.setKey;
      assert.equal(installSoundMapBatching(odd), false);
      assert.equal(odd.setKey, original);
      assert.equal(installSoundMapBatching(null), false);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /sound map/);
  });
});
