// Run with:
//   node --import ./scripts/test-register.mjs --test src/midi-bridge.test.js
//
// The live MIDI bridge without hardware: the pure note-shaping helpers, and
// the connection / device bookkeeping driven through a stubbed Web MIDI.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { registerSound, setAudioContext } from "@strudel/webaudio";
import {
  MidiBridge,
  modWheelCutoff,
  liveNoteLpf,
  liveHoldSeconds,
  LIVE_VOICE_SOFT_LIMIT,
  LIVE_VOICE_HARD_LIMIT,
  presets,
} from "./midi-bridge.js";

// ─── Web MIDI stand-ins ──────────────────────────────────────────────────

function fakeInput(id, name = id) {
  return { id, name, onmidimessage: null };
}

function fakeAccess(inputs = []) {
  const listeners = [];
  return {
    inputs: new Map(inputs.map((i) => [i.id, i])),
    addEventListener: (type, fn) => listeners.push(fn),
    /** Change the device set and fire `statechange`, like a (un)plug. */
    setInputs(next) {
      this.inputs = new Map(next.map((i) => [i.id, i]));
      for (const fn of listeners) fn({});
    },
  };
}

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
function stubNavigator(nav) {
  Object.defineProperty(globalThis, "navigator", {
    value: nav,
    configurable: true,
    writable: true,
  });
}

function makeBridge() {
  const statuses = [];
  const bridge = new MidiBridge({
    getPreset: () => "piano",
    onStatus: (s) => statuses.push(s),
  });
  return { bridge, statuses, last: () => statuses[statuses.length - 1] };
}

const send = (input, ...bytes) => input.onmidimessage({ data: bytes });

let warnings;
let realWarn;
beforeEach(() => {
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
});
afterEach(() => {
  console.warn = realWarn;
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
});

// ─── Mod wheel ───────────────────────────────────────────────────────────

describe("mod wheel → filter", () => {
  test("a wheel at rest leaves the note unfiltered", () => {
    assert.equal(modWheelCutoff(0), null);
    // no preset filter, wheel never moved → no lpf at all
    assert.equal(liveNoteLpf(undefined, 0), undefined);
    // the preset's own filter is untouched
    assert.equal(liveNoteLpf(1200, 0), 1200);
  });

  test("every melodic preset plays with its own lpf (or none) by default", () => {
    for (const [key, preset] of Object.entries(presets)) {
      if (preset.drumMap) continue;
      assert.equal(liveNoteLpf(preset.lpf, 0), preset.lpf, key);
    }
  });

  test("raising the wheel closes the filter, exponentially, down to 200 Hz", () => {
    assert.ok(Math.abs(modWheelCutoff(127) - 200) < 1e-6);
    assert.ok(Math.abs(modWheelCutoff(63.5) - 2000) < 1e-6);
    let previous = Infinity;
    for (let v = 1; v <= 127; v++) {
      const cutoff = modWheelCutoff(v);
      assert.ok(cutoff < previous && cutoff >= 200 - 1e-6 && cutoff < 20000);
      previous = cutoff;
    }
  });

  test("the wheel only ever tightens a preset's filter", () => {
    assert.equal(liveNoteLpf(1200, 10), 1200); // wheel still above 1.2 kHz
    assert.ok(liveNoteLpf(1200, 127) < 1200);
    assert.ok(Math.abs(liveNoteLpf(undefined, 127) - 200) < 1e-6);
  });
});

// ─── Voice budget ────────────────────────────────────────────────────────

describe("live voice budget", () => {
  test("normal playing: preset hold time, tripled by the pedal", () => {
    assert.equal(liveHoldSeconds(4, false, 0), 4);
    assert.equal(liveHoldSeconds(4, true, 0), 12);
    assert.equal(liveHoldSeconds(4, true, LIVE_VOICE_SOFT_LIMIT - 1), 12);
  });

  test("past the soft limit the pedal stops extending notes", () => {
    assert.equal(liveHoldSeconds(8, true, LIVE_VOICE_SOFT_LIMIT), 8);
    assert.equal(liveHoldSeconds(8, false, LIVE_VOICE_SOFT_LIMIT), 8);
  });

  test("past the hard limit new notes taper, so the pile drains", () => {
    assert.equal(liveHoldSeconds(8, true, LIVE_VOICE_HARD_LIMIT), 8);
    assert.equal(liveHoldSeconds(8, false, LIVE_VOICE_HARD_LIMIT * 2), 4);
    // never below the floor, however deep the pile
    assert.equal(liveHoldSeconds(8, false, LIVE_VOICE_HARD_LIMIT * 100), 0.5);
    // already-short notes (drums) are not lengthened
    assert.equal(liveHoldSeconds(0.2, true, LIVE_VOICE_HARD_LIMIT), 0.2);
  });
});

// ─── Connection ──────────────────────────────────────────────────────────

describe("MIDI permission flow", () => {
  test("first visit (permission 'prompt'): no request at boot, neutral invitation", async () => {
    let requests = 0;
    stubNavigator({
      requestMIDIAccess: async () => (requests++, fakeAccess()),
      permissions: { query: async () => ({ state: "prompt" }) },
    });
    const { bridge, last } = makeBridge();

    assert.equal(await bridge.startIfPermitted(), false);
    assert.equal(requests, 0);
    assert.equal(bridge.getConnectionState(), "idle");
    assert.equal(last().ok, null);
    assert.equal(last().msg, "Connect MIDI");
    assert.equal(last().action, true);

    // the click
    assert.equal(await bridge.start(), true);
    assert.equal(requests, 1);
    assert.equal(bridge.getConnectionState(), "connected");
    assert.equal(last().msg, "No MIDI device");
  });

  test("returning visitor (permission 'granted'): connects silently at boot", async () => {
    let requests = 0;
    const kbd = fakeInput("in-1", "Keystation");
    stubNavigator({
      requestMIDIAccess: async () => (requests++, fakeAccess([kbd])),
      permissions: { query: async () => ({ state: "granted" }) },
    });
    const { bridge, last } = makeBridge();

    assert.equal(await bridge.startIfPermitted(), true);
    assert.equal(requests, 1);
    assert.equal(last().ok, true);
    assert.equal(last().msg, "MIDI: Keystation");
    assert.equal(typeof kbd.onmidimessage, "function");
  });

  test("permission 'denied': no request, neutral 'blocked' with a way to retry", async () => {
    let requests = 0;
    let allow = false;
    stubNavigator({
      requestMIDIAccess: async () => {
        requests++;
        if (!allow) throw new DOMException("denied", "NotAllowedError");
        return fakeAccess();
      },
      permissions: { query: async () => ({ state: "denied" }) },
    });
    const { bridge, last } = makeBridge();

    await bridge.startIfPermitted();
    assert.equal(requests, 0);
    assert.equal(bridge.getConnectionState(), "blocked");
    assert.equal(last().ok, null, "blocked is not styled as an error");
    assert.equal(last().msg, "MIDI blocked");
    assert.match(last().title, /site settings/);
    assert.equal(last().action, true);

    // retry while still blocked → stays blocked, no throw
    assert.equal(await bridge.start(), false);
    assert.equal(bridge.getConnectionState(), "blocked");

    // user allowed MIDI in site settings, clicks again
    allow = true;
    assert.equal(await bridge.start(), true);
    assert.equal(bridge.getConnectionState(), "connected");
  });

  test("granting access in site settings connects without a reload", async () => {
    const permission = { state: "prompt", onchange: null };
    stubNavigator({
      requestMIDIAccess: async () => fakeAccess(),
      permissions: { query: async () => permission },
    });
    const { bridge } = makeBridge();
    await bridge.startIfPermitted();
    assert.equal(bridge.getConnectionState(), "idle");

    permission.state = "granted";
    permission.onchange();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(bridge.getConnectionState(), "connected");
  });

  test("Permissions API that does not know 'midi': wait for a click", async () => {
    let requests = 0;
    stubNavigator({
      requestMIDIAccess: async () => (requests++, fakeAccess()),
      permissions: {
        query: async () => {
          throw new TypeError("'midi' is not a valid PermissionName");
        },
      },
    });
    const { bridge } = makeBridge();
    await bridge.startIfPermitted();
    assert.equal(requests, 0);
    assert.equal(bridge.getConnectionState(), "idle");
  });

  test("browser without Web MIDI: says so, nothing to click", async () => {
    stubNavigator({});
    const { bridge, last } = makeBridge();
    assert.equal(await bridge.startIfPermitted(), false);
    assert.equal(bridge.getConnectionState(), "unsupported");
    assert.equal(last().ok, null);
    assert.match(last().title, /does not support Web MIDI/);
    assert.ok(!last().action);
    assert.equal(await bridge.start(), false);
  });

  test("concurrent start() calls share one permission request", async () => {
    let requests = 0;
    stubNavigator({
      requestMIDIAccess: async () => (requests++, fakeAccess()),
    });
    const { bridge } = makeBridge();
    const [a, b] = await Promise.all([bridge.start(), bridge.start()]);
    assert.deepEqual([a, b], [true, true]);
    assert.equal(requests, 1);
    await bridge.start();
    assert.equal(requests, 1);
  });
});

// ─── Devices ─────────────────────────────────────────────────────────────

describe("device bookkeeping", () => {
  async function connected(inputs) {
    const access = fakeAccess(inputs);
    stubNavigator({ requestMIDIAccess: async () => access });
    const made = makeBridge();
    await made.bridge.start();
    return { ...made, access };
  }

  test("unplugging a controller releases its held pedal and mod wheel", async () => {
    const kbd = fakeInput("in-1");
    const { bridge, access } = await connected([kbd]);
    const events = [];
    bridge.on("sustain", (e) => events.push(["sustain", e.down]));
    bridge.on("modwheel", (e) => events.push(["mod", e.value]));

    send(kbd, 0xb0, 64, 127); // pedal down
    send(kbd, 0xb0, 1, 90); //   mod wheel up
    assert.equal(bridge.isSustainDown(), true);
    assert.equal(bridge.getModWheel(), 90);

    access.setInputs([]);
    assert.equal(bridge.isSustainDown(), false);
    assert.equal(bridge.getModWheel(), 0);
    assert.deepEqual(events.slice(-2), [
      ["sustain", false],
      ["mod", 0],
    ]);
  });

  test("a selected input that is unplugged is remembered and restored", async () => {
    const a = fakeInput("a", "Keys");
    const b = fakeInput("b", "Pads");
    const { bridge, access } = await connected([a, b]);

    bridge.setSelectedDevice("a");
    assert.equal(typeof a.onmidimessage, "function");
    assert.equal(b.onmidimessage, null);

    // "a" goes away: fall back to everything, loudly, but keep the choice
    access.setInputs([b]);
    assert.equal(bridge.getSelectedDevice(), null);
    assert.equal(bridge.getPreferredDevice(), "a");
    assert.equal(typeof b.onmidimessage, "function");
    assert.equal(warnings.filter((w) => /not connected/.test(w)).length, 1);

    // "a" comes back: it is the only input listened to again
    const a2 = fakeInput("a", "Keys");
    access.setInputs([a2, b]);
    assert.equal(bridge.getSelectedDevice(), "a");
    assert.equal(typeof a2.onmidimessage, "function");
    assert.equal(b.onmidimessage, null);
    assert.equal(warnings.filter((w) => /not connected/.test(w)).length, 1);
  });

  test("a persisted selection for an absent device does not get forgotten at connect", async () => {
    const b = fakeInput("b", "Pads");
    const access = fakeAccess([b]);
    stubNavigator({ requestMIDIAccess: async () => access });
    const { bridge } = makeBridge();
    bridge.setSelectedDevice("a"); // restored from localStorage before connecting
    await bridge.start();

    assert.equal(bridge.getSelectedDevice(), null);
    assert.equal(bridge.getPreferredDevice(), "a");
    assert.equal(typeof b.onmidimessage, "function");
  });
});

// ─── Note-on guards ──────────────────────────────────────────────────────
// A stand-in AudioContext is enough: these paths return (or hand over to
// superdough, whose failure on the fake context is caught and logged) after
// the bookkeeping under test has run.

describe("note-on guards", () => {
  const audio = { state: "running", currentTime: 10 };
  async function playable() {
    setAudioContext(audio);
    audio.state = "running";
    const kbd = fakeInput("in-1", "Keystation");
    stubNavigator({ requestMIDIAccess: async () => fakeAccess([kbd]) });
    const made = makeBridge();
    await made.bridge.start();
    return { ...made, kbd };
  }
  const noteOn = (input, midi = 60) => send(input, 0x90, midi, 100);

  test("a preset whose sound is not loaded is skipped on every note, warned once", async () => {
    const { bridge, kbd, last } = await playable();
    const heard = [];
    bridge.on("noteon", (e) => heard.push(e.midi));

    noteOn(kbd);
    noteOn(kbd);
    noteOn(kbd);
    await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(heard, [], "no note may reach superdough");
    assert.equal(warnings.filter((w) => /not in the loaded soundMap/.test(w)).length, 1);
    assert.equal(warnings.filter((w) => /superdough failed/.test(w)).length, 0);
    assert.equal(last().msg, "MIDI preset unavailable");
  });

  test("'MIDI needs audio' clears as soon as a note can sound", async () => {
    registerSound("gm_piano", () => undefined);
    const { bridge, kbd, last } = await playable();
    const heard = [];
    bridge.on("noteon", (e) => heard.push(e.midi));

    audio.state = "suspended";
    noteOn(kbd);
    assert.equal(last().msg, "MIDI needs audio");
    assert.deepEqual(heard, []);

    audio.state = "running"; // the user clicked the page
    noteOn(kbd, 64);
    assert.deepEqual(heard, [64]);
    assert.equal(last().msg, "MIDI: Keystation");
    assert.equal(last().ok, true);
  });

  test("voices past the hard limit taper new notes instead of piling up", async () => {
    registerSound("gm_piano", () => undefined);
    const { bridge, kbd } = await playable();
    const holds = [];
    const realSetTimeout = globalThis.setTimeout;
    // the bridge schedules the key-release visual after the hold time
    globalThis.setTimeout = (fn, ms) => (holds.push(ms), 0);
    try {
      send(kbd, 0xb0, 64, 127); // pedal down: piano holds 4 s × 3
      for (let i = 0; i < LIVE_VOICE_HARD_LIMIT + 3; i++) noteOn(kbd, 30 + i);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.equal(holds[0], 12000);
    assert.equal(holds[LIVE_VOICE_SOFT_LIMIT - 1], 12000);
    assert.equal(holds[LIVE_VOICE_SOFT_LIMIT], 4000);
    assert.equal(holds[LIVE_VOICE_HARD_LIMIT], 4000);
    assert.ok(holds[LIVE_VOICE_HARD_LIMIT + 1] < 4000);
    assert.ok(holds[LIVE_VOICE_HARD_LIMIT + 1] > 3800);
    assert.equal(warnings.filter((w) => /live voices are sounding/.test(w)).length, 1);

    // once the earlier voices have decayed, notes are full length again
    audio.currentTime += 60;
    globalThis.setTimeout = (fn, ms) => (holds.push(ms), 0);
    try {
      noteOn(kbd, 90);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      audio.currentTime -= 60;
    }
    assert.equal(holds.at(-1), 12000);
  });

  test("a capture on the drum-pad preset is saved as a drum pattern", async () => {
    setAudioContext(audio);
    const bridge = new MidiBridge({ getPreset: () => "drums" });
    bridge.captureBuffer = [36, 42, 38, 42, 36, 42, 38, 42].map((midi, i) => ({
      midi,
      velocity: 0.8,
      time: i * 0.25,
    }));
    const code = bridge.buildPatternFromCapture();
    assert.match(code, /const drums = s\(/);
    assert.match(code, /bd hh sd hh/);
    assert.doesNotMatch(code, /sawtooth|note\(/);
  });
});
