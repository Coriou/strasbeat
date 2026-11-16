// Run with:
//   node --import ./scripts/test-register.mjs --test src/user-setup.test.js
//
// MIDI output routing: which device a bare `.midi()` goes to, and the wrapper
// that applies the MIDI bar's selection to upstream's `Pattern.prototype.midi`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  resolveMidiOutputName,
  installMidiOutputDefault,
} from "./user-setup.js";

describe("resolveMidiOutputName()", () => {
  const outputs = ["IAC Driver Bus 1", "Minilogue", "USB MIDI Interface"];

  test("the picked device wins when it is connected", () => {
    assert.deepEqual(resolveMidiOutputName("Minilogue", outputs), {
      name: "Minilogue",
      missing: false,
    });
  });

  test("nothing picked → upstream's default: first IAC bus, else first output", () => {
    assert.deepEqual(resolveMidiOutputName("", outputs), {
      name: "IAC Driver Bus 1",
      missing: false,
    });
    assert.deepEqual(resolveMidiOutputName("", ["Minilogue", "Other"]), {
      name: "Minilogue",
      missing: false,
    });
  });

  test("a picked device that is gone is reported, with the fallback", () => {
    assert.deepEqual(resolveMidiOutputName("Prophet", outputs), {
      name: "IAC Driver Bus 1",
      missing: true,
    });
  });

  test("before the device list is known the stored name is trusted", () => {
    assert.deepEqual(resolveMidiOutputName("Prophet", []), {
      name: "Prophet",
      missing: false,
    });
    assert.deepEqual(resolveMidiOutputName("", []), {
      name: undefined,
      missing: false,
    });
  });
});

describe("installMidiOutputDefault()", () => {
  // Stand-in for upstream: records what `.midi()` was called with.
  function setup(resolved) {
    const calls = [];
    class FakePattern {
      midi(...args) {
        calls.push({ self: this, args });
        return "upstream-result";
      }
    }
    const missing = [];
    let onCalls = 0;
    installMidiOutputDefault(FakePattern, {
      resolve: () => resolved,
      onMissing: (stored, fallback) => missing.push([stored, fallback]),
      onCall: () => onCalls++,
    });
    return { FakePattern, calls, missing, onCalls: () => onCalls };
  }

  test("a bare .midi() is sent to the selected device", () => {
    const { FakePattern, calls } = setup({ name: "Minilogue", missing: false });
    const pat = new FakePattern();
    assert.equal(pat.midi(), "upstream-result");
    assert.equal(calls[0].self, pat);
    assert.deepEqual(calls[0].args, ["Minilogue"]);
  });

  test("an options object without a port gets the selected device as its port", () => {
    const { FakePattern, calls } = setup({ name: "Minilogue", missing: false });
    new FakePattern().midi({ midichannel: 3 });
    new FakePattern().midi(undefined, { isController: true });
    assert.deepEqual(calls[0].args, [{ midichannel: 3, port: "Minilogue" }]);
    assert.deepEqual(calls[1].args, ["Minilogue", { isController: true }]);
  });

  test("a call that names its port is passed through untouched", () => {
    const { FakePattern, calls, missing } = setup({
      name: "Minilogue",
      missing: true,
      stored: "Prophet",
    });
    const p = new FakePattern();
    p.midi("IAC");
    p.midi(1);
    p.midi(0);
    p.midi({ port: "USB", midichannel: 2 });
    assert.deepEqual(
      calls.map((c) => c.args),
      [["IAC"], [1], [0], [{ port: "USB", midichannel: 2 }]],
    );
    assert.deepEqual(missing, []);
  });

  test("a Pattern argument (double-quoted name) reaches upstream's own error", () => {
    const { FakePattern, calls } = setup({ name: "Minilogue", missing: false });
    const patternArg = { _Pattern: true };
    new FakePattern().midi(patternArg);
    assert.equal(calls[0].args[0], patternArg);
  });

  test("a selected device that is gone is reported, and the fallback is used", () => {
    const { FakePattern, calls, missing } = setup({
      name: "IAC Driver Bus 1",
      missing: true,
      stored: "Prophet",
    });
    new FakePattern().midi();
    assert.deepEqual(calls[0].args, ["IAC Driver Bus 1"]);
    assert.deepEqual(missing, [["Prophet", "IAC Driver Bus 1"]]);
  });

  test("nothing selected and no device list yet: upstream picks its default", () => {
    const { FakePattern, calls } = setup({ name: undefined, missing: false });
    new FakePattern().midi();
    assert.deepEqual(calls[0].args, [undefined]);
  });

  test("every call pings onCall, and installing twice wraps once", () => {
    const { FakePattern, calls, onCalls } = setup({ name: "A", missing: false });
    installMidiOutputDefault(FakePattern, {
      resolve: () => ({ name: "B", missing: false }),
    });
    new FakePattern().midi();
    assert.equal(onCalls(), 1);
    assert.deepEqual(calls[0].args, ["A"]);
  });
});
