// The sample maps strudel.cc's own REPL registers at startup (upstream
// website/src/repl/prebake.mjs) that strasbeat did not load, as data, so a
// snippet pasted from strudel.cc finds the same sound names here.
//
// Registering a map only fetches its manifest (a few kB to ~180 kB of JSON);
// the audio files themselves are fetched lazily the first time a sound plays.
//
// Manifests come through the same-origin /strudel-cc proxy (vite.config.js in
// dev, vercel.json in production) like the drum-machine manifest in boot.js;
// the audio is served by Strudel's CDN, which sends CORS headers.

export const CDN = "https://strudel.b-cdn.net";

/**
 * The default map whose sounds win wherever another default map defines the
 * same name: `bd sd hh cp cb cr ht lt mt` (also in uzu-drumkit) and `sax`
 * (also in VCSL). dirt-samples is what those names have always played here,
 * and patterns index into its larger folders (`bd:7`, `sax:3`).
 */
export const SAMPLE_NAME_OWNER = {
  label: "dirt-samples",
  // what superdough resolves "github:tidalcycles/dirt-samples" to
  manifest:
    "https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json",
};

export const UZU_DRUMKIT = {
  label: "uzu-drumkit",
  manifest:
    "https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json",
};

/**
 * `tag` ends up on every sound of the map (`data.tag`); the sound browser
 * groups by it instead of guessing from the names.
 */
export const DRUM_MACHINES = {
  manifest: "/strudel-cc/tidal-drum-machines.json",
  base: "github:ritchse/tidal-drum-machines/main/machines/",
};

export const DRUM_MACHINES_TAG = "drum-machines";

export const UPSTREAM_SAMPLE_MAPS = [
  {
    // Salamander Grand Piano V3 — CC-BY 3.0, Alexander Holm
    label: "piano",
    manifest: "/strudel-cc/piano.json",
    base: `${CDN}/piano/`,
    tag: "instruments",
    affects: 's("piano") and .piano() will be silent.',
  },
  {
    // Versilian Community Sample Library — CC0
    label: "VCSL",
    manifest: "/strudel-cc/vcsl.json",
    base: `${CDN}/VCSL/`,
    tag: "instruments",
    affects:
      "the VCSL instruments (kalimba, gong, marimba, glockenspiel, recorder_*…) will be silent.",
  },
  {
    label: "wavetables",
    manifest: "/strudel-cc/uzu-wavetables.json",
    base: `${CDN}/uzu-wavetables/`,
    affects: "the wt_* wavetable sounds will be silent.",
  },
  {
    label: "mridangam",
    manifest: "/strudel-cc/mridangam.json",
    base: `${CDN}/mrid/`,
    tag: "percussion",
    affects: "the mridangam_* samples will be silent.",
  },
];

// The key superdough's registerSound() files a sample name under.
const soundKey = (name) => name.toLowerCase().replace(/\s+/g, "_");

/**
 * Keeps one map's sounds in place whatever order the manifests arrive in.
 * A map registered later replaces same-named sounds, and arrival order
 * differs from one page load to the next, so the owner's names are recorded
 * when it registers (`claim`) and taken out of every other map that
 * registers after it (`yieldTo`); a map that got in earlier is simply
 * overwritten by the owner.
 */
export function createNamePrecedence() {
  const claimed = new Set();
  return {
    /** @param {object} sampleMap the owner's manifest; returned as is */
    claim(sampleMap) {
      for (const name of Object.keys(sampleMap)) {
        if (name !== "_base") claimed.add(soundKey(name));
      }
      return sampleMap;
    },
    /** @param {object} sampleMap any other manifest, minus claimed names */
    yieldTo(sampleMap) {
      if (claimed.size === 0) return sampleMap;
      return Object.fromEntries(
        Object.entries(sampleMap).filter(
          ([name]) => !claimed.has(soundKey(name)),
        ),
      );
    },
  };
}

/**
 * Short names for the drum-machine banks: `.bank("tr909")` for
 * `.bank("RolandTR909")`, `"linn"` for `"AkaiLinn"`, and so on.
 */
export const DRUM_MACHINE_ALIASES = {
  label: "drum-machine aliases",
  manifest: "/strudel-cc/tidal-drum-machines-alias.json",
  after: "tidal-drum-machines",
  affects:
    'short bank names (.bank("tr909"), .bank("tr808")…) will be silent — the long names (.bank("RolandTR909")) still work.',
};

// Shared by boot and the worker; includes the alias table boot also fetches.
export const DEFAULT_MANIFESTS = [
  SAMPLE_NAME_OWNER.manifest, UZU_DRUMKIT.manifest, DRUM_MACHINES.manifest,
  ...UPSTREAM_SAMPLE_MAPS.map((map) => map.manifest), DRUM_MACHINE_ALIASES.manifest,
];

export async function fetchJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Start fetching `url` immediately, but hand the JSON to `apply` only once
 * `after` has settled — so the download overlaps with the phase it depends
 * on while the registration order stays fixed.
 *
 * @param {string} url
 * @param {Promise<unknown>} after  must not reject (boot's `safe()` wrappers don't)
 * @param {(json: object) => unknown} apply
 * @param {typeof fetch} [fetchImpl]
 */
export async function applyJsonAfter(url, after, apply, fetchImpl = fetch) {
  const [json] = await Promise.all([fetchJson(url, fetchImpl), after]);
  return apply(json);
}
