// User setup layer — dynamic package loading, user setup scripts, and
// user sample management. See design/work/14-strudel-learning-and-extensibility.md
// Phase 2.
//
// Public API:
//   runUserSetup({ evalScope, samples, setBootProgress })
//     → called once during boot, after core prebake resolves.
//   getEnabledPackages() → string[]
//   setEnabledPackages(ids: string[])
//   getSetupScript() → string
//   setSetupScript(code: string)
//   loadOptInPackage(id: string) → Promise<module>
//   getUserSamples() → Promise<{name, files}[]>
//   importUserSamples(name: string, files: FileList) → Promise<void>
//   deleteUserSampleBank(name: string) → Promise<void>
//   deleteAllUserSamples() → Promise<void>

import { Pattern, logger } from "@strudel/core";

const PACKAGES_KEY = "strasbeat:enabled-packages";
const SCRIPT_KEY = "strasbeat:setup-script";
const MIDI_OUTPUT_KEY = "strasbeat:midi-output-device";
const IDB_NAME = "strasbeat-user-samples";
const IDB_VERSION = 1;
const IDB_STORE = "banks";

// ─── MIDI output state (populated after @strudel/midi loads) ────────────
//
//   off          @strudel/midi is not loaded
//   idle         loaded, but MIDI access has not been granted yet — the MIDI
//                bar offers an "Enable" button (see enableMidiOutput)
//   enabling     waiting on the browser (possibly on its permission prompt)
//   ready        WebMidi is enabled; getMidiOutputs() is live
//   blocked      the browser refused access — the MIDI bar offers "Retry"
//   unsupported  this browser has no Web MIDI

let _midiOutputModule = null; // { WebMidi, enableWebMidi }
let _midiOutputState = "off";
let _midiOutputEnabling = null;
const _midiOutputListeners = new Set();

/** @returns {'off'|'idle'|'enabling'|'ready'|'blocked'|'unsupported'} */
export function getMidiOutputState() {
  return _midiOutputState;
}

function _setMidiOutputState(state) {
  _midiOutputState = state;
  _notifyMidiOutputListeners();
}

/** Whether @strudel/midi has been loaded and WebMidi enabled. */
export function isMidiOutputReady() {
  return _midiOutputState === "ready";
}

/** Returns WebMidi.outputs array, or [] if not ready. */
export function getMidiOutputs() {
  if (_midiOutputState !== "ready" || !_midiOutputModule) return [];
  return Array.from(_midiOutputModule.WebMidi.outputs ?? []);
}

/**
 * Ask the browser for MIDI output access (with sysex, which is what
 * @strudel/midi requests) and enable WebMidi. May show a permission prompt,
 * so outside of boot it is called from a user gesture: the MIDI bar's
 * Enable / Retry button, or evaluating a pattern that calls `.midi()`.
 * Never rejects — the outcome is the state, which listeners are told about.
 *
 * @returns {Promise<boolean>} whether output is ready
 */
export function enableMidiOutput() {
  const mod = _midiOutputModule;
  if (!mod) return Promise.resolve(false);
  if (_midiOutputState === "ready") return Promise.resolve(true);
  if (_midiOutputEnabling) return _midiOutputEnabling;
  if (typeof navigator.requestMIDIAccess !== "function") {
    _setMidiOutputState("unsupported");
    return Promise.resolve(false);
  }
  _setMidiOutputState("enabling");
  _midiOutputEnabling = (async () => {
    try {
      await mod.enableWebMidi({
        onConnected: _notifyMidiOutputListeners,
        onDisconnected: _notifyMidiOutputListeners,
      });
      if (!mod.WebMidi.enabled) throw new Error("WebMidi did not enable");
      _midiOutputState = "ready";
      const outputs = Array.from(mod.WebMidi.outputs ?? []);
      console.log(
        `[user-setup] WebMidi enabled, ${outputs.length} output(s):`,
        outputs.map((o) => o.name).join(", ") || "(none)",
      );
      return true;
    } catch (err) {
      console.warn("[user-setup] MIDI output could not be enabled:", err);
      _midiOutputState = "blocked";
      return false;
    } finally {
      _midiOutputEnabling = null;
      _notifyMidiOutputListeners();
    }
  })();
  return _midiOutputEnabling;
}

// Boot-time counterpart of enableMidiOutput(): enable straight away only when
// the permission is already held, so loading the page never raises a
// permission prompt on its own.
async function _enableMidiOutputIfPermitted() {
  if (typeof navigator.requestMIDIAccess !== "function") {
    _setMidiOutputState("unsupported");
    return;
  }
  let permission = null;
  try {
    permission = await navigator.permissions?.query({
      name: "midi",
      sysex: true,
    });
  } catch {
    // Permissions API cannot answer for MIDI here — wait for a click.
  }
  if (permission?.state === "granted") {
    await enableMidiOutput();
  } else {
    _setMidiOutputState(permission?.state === "denied" ? "blocked" : "idle");
  }
}

/**
 * Which output a bare `.midi()` should use: the device picked in the MIDI
 * bar when it is connected, otherwise upstream's own default (the first IAC
 * bus, else the first output). `missing` is true when a picked device had to
 * be replaced.
 *
 * @param {string} stored  persisted device name ("" when never picked)
 * @param {string[]} outputNames  currently connected output names
 * @returns {{ name: string | undefined, missing: boolean }}
 */
export function resolveMidiOutputName(stored, outputNames) {
  if (stored && outputNames.includes(stored)) {
    return { name: stored, missing: false };
  }
  // Not enabled yet, so the device list is unknown: trust the stored name.
  if (outputNames.length === 0) {
    return { name: stored || undefined, missing: false };
  }
  const fallback = outputNames.find((n) => n.includes("IAC")) ?? outputNames[0];
  return { name: fallback, missing: !!stored };
}

/**
 * Make the MIDI bar's output selector real.
 *
 * Upstream `.midi(port)` resolves its device from the `port` argument alone
 * (default: first IAC bus, else first output) and exposes no setter for that
 * default, so the only place to apply the user's choice is the call itself:
 * this wraps `Pattern.prototype.midi` so that a call WITHOUT a port —
 * `.midi()` or `.midi({ midichannel: 2 })` — gets the selected device name as
 * its port. A call that names a port (`.midi('IAC')`, `.midi(1)`,
 * `.midi({ port })`) is passed through untouched.
 *
 * The device is resolved when the pattern is evaluated, so a new selection
 * applies from the next evaluate.
 *
 * @param {{ prototype: { midi: Function } }} PatternClass
 * @param {{ resolve: () => { name: string | undefined, missing: boolean, stored?: string }, onMissing?: (stored: string, fallback: string) => void, onCall?: () => void }} hooks
 */
export function installMidiOutputDefault(PatternClass, hooks) {
  const upstreamMidi = PatternClass.prototype.midi;
  if (typeof upstreamMidi !== "function" || upstreamMidi._strasbeatDefault) {
    return;
  }
  function midi(midiport, options) {
    hooks.onCall?.();
    const isOptionsObject =
      midiport !== null &&
      typeof midiport === "object" &&
      // a Pattern here is the double-quoted-string mistake; upstream has a
      // clear error for it
      midiport._Pattern !== true;
    const namesPort =
      midiport !== undefined && !(isOptionsObject && midiport.port == null);
    if (!namesPort) {
      const { name, missing, stored } = hooks.resolve();
      if (missing) hooks.onMissing?.(stored, name);
      if (name !== undefined) {
        midiport = isOptionsObject ? { ...midiport, port: name } : name;
      }
    }
    return options === undefined
      ? upstreamMidi.call(this, midiport)
      : upstreamMidi.call(this, midiport, options);
  }
  midi._strasbeatDefault = true;
  PatternClass.prototype.midi = midi;
}

const _warnedMissingOutputs = new Set();

function _installSelectedOutputDefault() {
  installMidiOutputDefault(Pattern, {
    // Evaluating a pattern is a user gesture, and upstream enables WebMidi
    // from `.midi()` itself — keep our state (and the MIDI bar) in step.
    onCall: () => {
      if (_midiOutputState !== "ready") enableMidiOutput();
    },
    resolve: () => {
      const stored = getMidiOutputDevice();
      const names = getMidiOutputs().map((o) => o.name);
      return { ...resolveMidiOutputName(stored, names), stored };
    },
    onMissing: (stored, fallback) => {
      if (_warnedMissingOutputs.has(stored)) return;
      _warnedMissingOutputs.add(stored);
      const msg = `[midi] selected output "${stored}" is not connected — .midi() is sending to "${fallback}" instead. Pick an output in the MIDI bar.`;
      console.warn(msg);
      logger(msg, "warning");
    },
  });
}

/** Get the persisted MIDI output device name. */
export function getMidiOutputDevice() {
  return localStorage.getItem(MIDI_OUTPUT_KEY) ?? "";
}

/** Persist the selected MIDI output device name. */
export function setMidiOutputDevice(name) {
  if (name) {
    localStorage.setItem(MIDI_OUTPUT_KEY, name);
  } else {
    localStorage.removeItem(MIDI_OUTPUT_KEY);
  }
  // A fresh choice gets a fresh "not connected" warning if it ever goes away.
  _warnedMissingOutputs.clear();
  _notifyMidiOutputListeners();
}

/** Subscribe to MIDI output state changes (device connect/disconnect). */
export function onMidiOutputChange(fn) {
  _midiOutputListeners.add(fn);
  return () => _midiOutputListeners.delete(fn);
}

function _notifyMidiOutputListeners() {
  for (const fn of _midiOutputListeners) {
    try {
      fn();
    } catch (e) {
      console.warn("[user-setup] midi output listener error:", e);
    }
  }
}

// ─── Opt-in package registry ────────────────────────────────────────────
// Each entry describes one package that can be dynamically imported.
// The `load` function returns the dynamic import — Vite will code-split
// these into separate chunks when they're installed in node_modules.
// NOTE: packages must be installed in package.json before their import()
// will resolve.

export const OPT_IN_PACKAGES = [
  {
    id: "xen",
    label: "@strudel/xen",
    description: "Xenharmonic / microtonal utilities",
    load: () => import("@strudel/xen"),
  },
  {
    id: "midi",
    label: "@strudel/midi",
    description: "MIDI pattern output (.midi())",
    load: () => import("@strudel/midi"),
  },
  {
    id: "osc",
    label: "@strudel/osc",
    description: "OSC output over WebSocket (.osc())",
    load: () => import("@strudel/osc"),
  },
  {
    id: "csound",
    label: "@strudel/csound",
    description: "Csound synthesis engine",
    load: () => import("@strudel/csound"),
  },
  {
    id: "serial",
    label: "@strudel/serial",
    description: "Serial port communication",
    load: () => import("@strudel/serial"),
  },
  {
    id: "vcsl",
    label: "VCSL",
    description: "Orchestral samples (CC0, ~60MB download)",
    sampleBank: true,
  },
  {
    id: "wavetables",
    label: "Wavetables",
    description: "uzu wavetable synthesis samples",
    sampleBank: true,
  },
];

// ─── Persistence ────────────────────────────────────────────────────────

export function getEnabledPackages() {
  try {
    const raw = localStorage.getItem(PACKAGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function setEnabledPackages(ids) {
  localStorage.setItem(PACKAGES_KEY, JSON.stringify(ids));
}

export function getSetupScript() {
  return localStorage.getItem(SCRIPT_KEY) ?? "";
}

export function setSetupScript(code) {
  localStorage.setItem(SCRIPT_KEY, code);
}

// ─── Dynamic package loading ────────────────────────────────────────────

export async function loadOptInPackage(id) {
  const entry = OPT_IN_PACKAGES.find((p) => p.id === id);
  if (!entry) {
    console.warn(`[user-setup] unknown package id: ${id}`);
    return null;
  }
  if (entry.sampleBank) {
    console.warn(`[user-setup] ${id} is a sample bank, use _loadSampleBank()`);
    return null;
  }
  try {
    const mod = await entry.load();
    return mod;
  } catch (err) {
    console.warn(`[user-setup] failed to load ${entry.label}:`, err);
    return null;
  }
}

const SAMPLE_BANK_URLS = {
  vcsl: [
    "https://strudel.b-cdn.net/vcsl.json",
    "https://strudel.b-cdn.net/VCSL/",
  ],
  wavetables: [
    "https://strudel.b-cdn.net/uzu-wavetables.json",
    "https://strudel.b-cdn.net/uzu-wavetables/",
  ],
};

async function _loadSampleBank(id, samples) {
  const urls = SAMPLE_BANK_URLS[id];
  if (!urls) {
    console.warn(`[user-setup] unknown sample bank id: ${id}`);
    return;
  }
  try {
    await samples(...urls);
    console.log(`[user-setup] loaded sample bank: ${id}`);
  } catch (err) {
    console.warn(`[user-setup] failed to load sample bank ${id}:`, err);
  }
}

// ─── Boot integration ───────────────────────────────────────────────────

export async function runUserSetup({ evalScope, samples }) {
  const enabledIds = getEnabledPackages();
  const script = getSetupScript();

  // 1. Load enabled opt-in packages
  if (enabledIds.length > 0) {
    const loadResults = await Promise.allSettled(
      enabledIds.map(async (id) => {
        // Sample-bank packages load via samples() URLs, not dynamic import.
        const entry = OPT_IN_PACKAGES.find((p) => p.id === id);
        if (entry?.sampleBank) {
          await _loadSampleBank(id, samples);
          return null;
        }
        const mod = await loadOptInPackage(id);
        if (mod) {
          await evalScope(mod);
          console.log(`[user-setup] loaded ${id}`);

          // When @strudel/midi loads: route bare `.midi()` calls to the
          // device picked in the MIDI bar, and enable WebMidi right away if
          // the permission is already held so the selector is populated.
          if (id === "midi" && mod.enableWebMidi && mod.WebMidi) {
            _midiOutputModule = mod;
            _installSelectedOutputDefault();
            await _enableMidiOutputIfPermitted();
          }
        }
        return mod;
      }),
    );
    for (let i = 0; i < loadResults.length; i++) {
      if (loadResults[i].status === "rejected") {
        console.warn(
          `[user-setup] package ${enabledIds[i]} failed:`,
          loadResults[i].reason,
        );
      }
    }
  }

  // 2. Register user samples from IndexedDB
  try {
    const banks = await getUserSamples();
    for (const bank of banks) {
      try {
        // Re-register the stored sample map with Strudel.
        // bank.sampleMap is { bankName: { sampleName: [urls] } }
        if (bank.sampleMap && typeof samples === "function") {
          await samples(bank.sampleMap);
          console.log(`[user-setup] registered user sample bank: ${bank.name}`);
        }
      } catch (err) {
        console.warn(
          `[user-setup] failed to register user samples "${bank.name}":`,
          err,
        );
      }
    }
  } catch (err) {
    console.warn("[user-setup] failed to load user samples from IDB:", err);
  }

  // 3. Execute user setup script
  if (script.trim()) {
    try {
      // The setup script runs in the same scope as pattern code — same
      // trust model as upstream's prebake editor. Functions exported from
      // the script could be wired into evalScope, but for v1 we keep it
      // simple: the script runs for side effects (registering samples,
      // configuring things).
      const AsyncFunction = Object.getPrototypeOf(
        async function () {},
      ).constructor;
      const fn = new AsyncFunction("samples", script);
      await fn(samples);
      console.log("[user-setup] setup script executed");
    } catch (err) {
      console.error("[user-setup] setup script error:", err);
    }
  }
}

// ─── IndexedDB user samples ─────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getUserSamples() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function importUserSamples(name, sampleMap) {
  if (!name || !sampleMap) throw new Error("name and sampleMap required");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.put({ name, sampleMap, addedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteUserSampleBank(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteAllUserSamples() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
