import * as strudelCore from "@strudel/core";
import * as strudelDraw from "@strudel/draw";
import * as strudelMini from "@strudel/mini";
import * as strudelTonal from "@strudel/tonal";
import * as strudelWebaudio from "@strudel/webaudio";
// `sliderWithID` is the function the Strudel transpiler rewrites
// `slider(value, min, max, step)` calls into. Without it in scope, any
// pattern using slider() throws "sliderWithID is not defined" at eval.
// It has to come from the package entry, the same module instance the editor
// (StrudelMirror) uses: the slider widgets post their value to that
// instance's store, and a second copy would never hear them.
import { slider, sliderWithID } from "@strudel/codemirror";
// In scope as a whole so `loadSoundfont(url)`, `setSoundfontUrl` and
// `soundfontList` work in patterns, as they do on strudel.cc.
import * as strudelSoundfonts from "@strudel/soundfonts";
import * as strudelExt from "./strudel-ext/index.js";
import {
  SAMPLE_NAME_OWNER,
  UZU_DRUMKIT,
  UPSTREAM_SAMPLE_MAPS,
  DRUM_MACHINE_ALIASES,
  DRUM_MACHINES_TAG,
  applyJsonAfter,
  createNamePrecedence,
  fetchJson,
} from "./default-samples.js";
import { runUserSetup } from "./user-setup.js";
import { LIVE_MAX_POLYPHONY } from "./export.js";

const { evalScope, controls } = strudelCore;
const { initAudioOnFirstClick, registerSynthSounds, registerZZFXSounds, samples, aliasBank } = strudelWebaudio; // prettier-ignore
const { registerSoundfonts } = strudelSoundfonts;
const strudelSlider = { slider, sliderWithID };

// What stops working when a boot phase fails to load, in the user's terms.
// Shown next to the failure in the in-app console (see eval-feedback.js).
const BOOT_PHASE_AFFECTS = {
  "synth sounds":
    "the built-in synths (sine, sawtooth, square, triangle, supersaw…) will be silent.",
  "ZZFX sounds": "the z_* ZZFX synths will be silent.",
  soundfonts: "every gm_* instrument (gm_piano, gm_epiano1…) will be silent.",
  "dirt-samples":
    "the default sample kit (bd, sd, hh, cp and friends) will be silent.",
  "tidal-drum-machines":
    'drum-machine banks (.bank("RolandTR909")…) will be silent.',
  "uzu-drumkit": "the uzu drum kit samples will be silent.",
  "user setup":
    "packages, samples or the setup script from the Setup panel may be missing.",
  ...Object.fromEntries(
    [...UPSTREAM_SAMPLE_MAPS, DRUM_MACHINE_ALIASES].map((m) => [
      m.label,
      m.affects,
    ]),
  ),
};

/**
 * Creates the boot state machine (progress tracking, prebake callback).
 *
 * Call before StrudelMirror construction. Returns:
 * - `bootPromise` — resolves when boot completes (success or failure)
 * - `getBootReady()` — returns true once boot is done
 * - `prebake` — pass to StrudelMirror's `prebake` option
 * - `getBootFailures()` — `[{ label, reason, affects }]` for every phase
 *   that failed to load (empty until boot completes)
 */
export function createBoot({ shellEl, exportBtn, status }) {
  let bootReady = false;
  let bootFailures = [];
  let _bootResolve;
  const bootPromise = new Promise((r) => {
    _bootResolve = r;
  });

  // Progress bar — thin accent line across the top of the shell.
  const progressBar = document.createElement("div");
  progressBar.className = "boot-progress";
  shellEl.prepend(progressBar);

  function setBootProgress(fraction, label) {
    progressBar.style.setProperty("--boot-pct", fraction.toFixed(2));
    if (label) status.textContent = label;
  }

  // Gate export/share until boot completes.
  exportBtn.disabled = true;
  shellEl.classList.add("is-booting");

  const prebake = async () => {
    try {
      initAudioOnFirstClick({ maxPolyphony: LIVE_MAX_POLYPHONY });
      setBootProgress(0.05, "loading modules…");
      const loadModules = evalScope(controls, strudelCore, strudelDraw, strudelMini, strudelTonal, strudelWebaudio, strudelSlider, strudelSoundfonts, strudelExt); // prettier-ignore
      await loadModules;
      setBootProgress(0.15, "loading synth sounds…");

      const failures = [];
      const safe = (label, p) =>
        Promise.resolve(p).catch((e) => {
          console.warn(`[strasbeat] failed to load ${label}:`, e);
          failures.push({
            label,
            reason: /timed out/i.test(e?.message ?? "") ? "timed out" : "",
            affects:
              BOOT_PHASE_AFFECTS[label] ?? "sounds from it will be silent.",
          });
        });

      // Timeout wrapper — if a phase takes longer than `ms`, continue with
      // whatever loaded rather than hanging the boot sequence forever. The
      // CDN (strudel.cc, GitHub) can be slow or unreachable; the user
      // should still get a working editor with degraded sound coverage.
      const BOOT_TIMEOUT_MS = 15_000;
      const withTimeout = (label, p, ms = BOOT_TIMEOUT_MS) =>
        safe(
          label,
          Promise.race([
            p,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`${label}: timed out after ${ms}ms`)),
                ms,
              ),
            ),
          ]),
        );

      // Phase 1: synth sounds + ZZFX (small, fast — no timeout needed)
      await safe("synth sounds", registerSynthSounds());
      safe("ZZFX sounds", registerZZFXSounds());
      setBootProgress(0.3, "loading soundfonts…");

      // Phase 2: soundfonts (medium — timeout protects against CDN issues)
      await withTimeout("soundfonts", registerSoundfonts());
      setBootProgress(0.5, "loading samples…");

      // Phase 3: sample banks (large, in parallel as they're independent)
      // strudel.cc has no CORS headers, so we proxy via vite.config.js
      // Several of these maps define the same names (bd, sd, hh… and sax);
      // dirt-samples keeps them, whichever manifest arrives first.
      const names = createNamePrecedence();
      const drumMachines = samples('/strudel-cc/tidal-drum-machines.json', 'github:ritchse/tidal-drum-machines/main/machines/', { tag: DRUM_MACHINES_TAG }); // prettier-ignore
      const phases = {
        "dirt-samples": withTimeout(SAMPLE_NAME_OWNER.label, fetchJson(SAMPLE_NAME_OWNER.manifest).then((json) => samples(names.claim(json)))), // prettier-ignore
        'tidal-drum-machines': withTimeout('tidal-drum-machines', drumMachines), // prettier-ignore
      };
      await Promise.all([
        ...Object.values(phases),
        withTimeout(
          UZU_DRUMKIT.label,
          fetchJson(UZU_DRUMKIT.manifest).then((json) =>
            samples(names.yieldTo(json)),
          ),
        ),
        // The rest of what strudel.cc registers by default (piano, VCSL,
        // wavetables, mridangam) — manifests only, audio loads on first use.
        ...UPSTREAM_SAMPLE_MAPS.map((m) =>
          withTimeout(
            m.label,
            fetchJson(m.manifest).then((json) =>
              samples(names.yieldTo(json), m.base, { tag: m.tag }),
            ),
          ),
        ),
        // aliasBank() walks the sounds registered so far, so the
        // drum-machine map has to be in before the short names are added.
        // That means the map itself, not its boot phase: the phase gives up
        // after the timeout, and a manifest that arrives later than that
        // would otherwise get its long names but never its aliases.
        withTimeout(
          DRUM_MACHINE_ALIASES.label,
          applyJsonAfter(
            DRUM_MACHINE_ALIASES.manifest,
            Promise.resolve(drumMachines).catch(() => {}),
            (aliases) => aliasBank(aliases),
          ),
        ),
      ]);
      setBootProgress(0.9, "running user setup…");

      // Phase 4: user setup — opt-in packages, user samples, setup script.
      // Runs after core prebake so everything the user's code might reference
      // is already available.
      await safe("user setup", runUserSetup({ evalScope, samples }));
      setBootProgress(1.0);

      // ── Finalize boot state ──
      bootFailures = failures;
      bootReady = true;
      exportBtn.disabled = false;
      shellEl.classList.remove("is-booting");
      shellEl.classList.add("is-ready");

      if (failures.length === 0) {
        status.textContent = "Ready to play";
      } else {
        status.textContent = `Ready with ${failures.length} load warning${failures.length === 1 ? "" : "s"}`;
        console.warn(
          "[strasbeat] boot completed with failures:",
          failures.map((f) => f.label),
        );
      }

      // Fade out progress bar.
      progressBar.classList.add("boot-progress--done");
      setTimeout(() => progressBar.remove(), 600);

      _bootResolve();
    } catch (fatalErr) {
      // Top-level error boundary — boot must ALWAYS resolve so the
      // editor is at least usable (even if sounds didn't load). Without
      // this, an unhandled throw leaves the boot promise hanging forever.
      console.error("[strasbeat] fatal boot error:", fatalErr);
      bootFailures = [
        {
          label: "the sound engine",
          reason: fatalErr?.message ?? "",
          affects: "some or all sounds may be silent.",
        },
      ];
      bootReady = true;
      exportBtn.disabled = false;
      shellEl.classList.remove("is-booting");
      shellEl.classList.add("is-ready");
      status.textContent = "Boot failed. Check console.";
      progressBar.classList.add("boot-progress--done");
      setTimeout(() => progressBar.remove(), 600);
      _bootResolve();
    }
  };

  return {
    bootPromise,
    getBootReady: () => bootReady,
    getBootFailures: () => bootFailures,
    prebake,
  };
}
