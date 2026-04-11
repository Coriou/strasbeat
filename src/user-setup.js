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

const PACKAGES_KEY = "strasbeat:enabled-packages";
const SCRIPT_KEY = "strasbeat:setup-script";
const MIDI_OUTPUT_KEY = "strasbeat:midi-output-device";
const IDB_NAME = "strasbeat-user-samples";
const IDB_VERSION = 1;
const IDB_STORE = "banks";

// ─── MIDI output state (populated after @strudel/midi loads) ────────────

let _midiOutputModule = null; // { WebMidi, enableWebMidi }
let _midiOutputReady = false;
const _midiOutputListeners = new Set();

/** Whether @strudel/midi has been loaded and WebMidi enabled. */
export function isMidiOutputReady() {
  return _midiOutputReady;
}

/** Returns WebMidi.outputs array, or [] if not ready. */
export function getMidiOutputs() {
  if (!_midiOutputReady || !_midiOutputModule) return [];
  return Array.from(_midiOutputModule.WebMidi.outputs ?? []);
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
    id: "hydra",
    label: "@strudel/hydra",
    description: "Hydra shader visuals",
    load: () => import("@strudel/hydra"),
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
  try {
    const mod = await entry.load();
    return mod;
  } catch (err) {
    console.warn(`[user-setup] failed to load ${entry.label}:`, err);
    return null;
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
        const mod = await loadOptInPackage(id);
        if (mod) {
          await evalScope(mod);
          console.log(`[user-setup] loaded ${id}`);

          // Proactively enable WebMidi when @strudel/midi loads so the
          // output device selector can be populated immediately.
          if (id === "midi" && mod.enableWebMidi && mod.WebMidi) {
            _midiOutputModule = mod;
            try {
              await mod.enableWebMidi({
                onConnected: () => {
                  _notifyMidiOutputListeners();
                },
                onDisconnected: () => {
                  _notifyMidiOutputListeners();
                },
              });
              _midiOutputReady = true;
              _notifyMidiOutputListeners();
              const outputs = Array.from(mod.WebMidi.outputs ?? []);
              console.log(
                `[user-setup] WebMidi enabled, ${outputs.length} output(s):`,
                outputs.map((o) => o.name).join(", ") || "(none)",
              );
            } catch (err) {
              console.warn("[user-setup] enableWebMidi failed:", err);
            }
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
