import * as strudelCore from "@strudel/core";
import * as strudelDraw from "@strudel/draw";
import * as strudelMini from "@strudel/mini";
import * as strudelTonal from "@strudel/tonal";
import * as strudelWebaudio from "@strudel/webaudio";
import * as strudelExt from "./strudel-ext/index.js";
import { registerSoundfonts } from "@strudel/soundfonts";
import { runUserSetup } from "./user-setup.js";

const { evalScope, controls } = strudelCore;
const { initAudioOnFirstClick, registerSynthSounds, registerZZFXSounds, samples } = strudelWebaudio; // prettier-ignore

/**
 * Creates the boot state machine (progress tracking, prebake callback).
 *
 * Call before StrudelMirror construction. Returns:
 * - `bootPromise` — resolves when boot completes (success or failure)
 * - `getBootReady()` — returns true once boot is done
 * - `prebake` — pass to StrudelMirror's `prebake` option
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
      initAudioOnFirstClick();
      setBootProgress(0.05, "loading modules…");
      const loadModules = evalScope(controls, strudelCore, strudelDraw, strudelMini, strudelTonal, strudelWebaudio, strudelExt); // prettier-ignore
      await loadModules;
      setBootProgress(0.15, "loading synth sounds…");

      const failures = [];
      const safe = (label, p) =>
        Promise.resolve(p).catch((e) => {
          console.warn(`[strasbeat] failed to load ${label}:`, e);
          failures.push(label);
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
      await Promise.all([
        withTimeout("dirt-samples", samples("github:tidalcycles/dirt-samples")),
        withTimeout('tidal-drum-machines', samples('/strudel-cc/tidal-drum-machines.json', 'github:ritchse/tidal-drum-machines/main/machines/')), // prettier-ignore
        withTimeout(
          "uzu-drumkit",
          samples(
            "https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json",
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
        console.warn("[strasbeat] boot completed with failures:", failures);
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
    prebake,
  };
}
