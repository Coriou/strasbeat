// Which kit the bare drum names play.
//
// Two of the default sample maps define the same short names — `bd sd hh cp
// cb cr ht lt mt`: dirt-samples (what those names have always played here)
// and uzu-drumkit (what they play on strudel.cc). The default stays
// dirt-samples, so existing patterns sound as they did; this module is the
// one place that knows there is a choice:
//
//   - the stored preference ("classic" | "strudel"), read once at boot and
//     changed from Settings or from the nudge;
//   - `applyDrumKit`, which re-registers the shared names from the chosen
//     kit's manifest. Registering a sample map only records names and URLs,
//     so the switch is immediate and costs nothing until a sound plays. The
//     WAV export renders through the same sound map, so it follows;
//   - the rule for the one-time nudge: the first time a pattern that is
//     actually playing uses one of those names without a `.bank(...)`.
//
// Nothing here touches the DOM (the card is src/ui/drum-kit-nudge.js).

export const DRUM_KIT_KEY = "strasbeat:drum-kit";
export const DRUM_KIT_NUDGE_KEY = "strasbeat:drum-kit-nudge";

export const DRUM_KITS = {
  classic: { label: "Classic", source: "dirt-samples" },
  strudel: { label: "strudel.cc", source: "uzu-drumkit" },
};
export const DEFAULT_DRUM_KIT = "classic";

// What the two manifests share today. Used until both have been fetched
// (and if one of them fails to load); after that the real intersection is.
export const SHARED_DRUM_NAMES = ["bd", "sd", "hh", "cp", "cb", "cr", "ht", "lt", "mt"]; // prettier-ignore

const isKit = (value) => Object.hasOwn(DRUM_KITS, value);
// The key superdough's registerSound() files a sample name under.
const soundKey = (name) => String(name).toLowerCase().replace(/\s+/g, "_");

function defaultStorage() {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * The kit the user chose, or null when they never chose one. Storage that
 * throws or holds something else counts as "never chose".
 */
export function readStoredDrumKit(storage = defaultStorage()) {
  try {
    const value = storage?.getItem(DRUM_KIT_KEY);
    return isKit(value) ? value : null;
  } catch {
    return null;
  }
}

/** The kit in force: the stored choice, or the default. */
export function readDrumKit(storage = defaultStorage()) {
  return readStoredDrumKit(storage) ?? DEFAULT_DRUM_KIT;
}

/** @returns {boolean} false when the choice could not be stored */
export function storeDrumKit(kit, storage = defaultStorage()) {
  if (!isKit(kit)) return false;
  try {
    storage.setItem(DRUM_KIT_KEY, kit);
    return true;
  } catch {
    return false;
  }
}

/** The names both manifests define — the ones the choice is about. */
export function sharedDrumNames(classicMap, strudelMap) {
  if (!classicMap || !strudelMap) return SHARED_DRUM_NAMES.slice();
  const inStrudel = new Set(
    Object.keys(strudelMap)
      .filter((name) => name !== "_base")
      .map(soundKey),
  );
  const shared = Object.keys(classicMap)
    .filter((name) => name !== "_base")
    .map(soundKey)
    .filter((name) => inStrudel.has(name));
  return shared.length > 0 ? shared : SHARED_DRUM_NAMES.slice();
}

/** A manifest cut down to `names` (plus its `_base`), ready for samples(). */
export function pickKitSounds(sampleMap, names) {
  const wanted = new Set(names.map(soundKey));
  return Object.fromEntries(
    Object.entries(sampleMap).filter(
      ([name]) => name === "_base" || wanted.has(soundKey(name)),
    ),
  );
}

/**
 * Does this pattern lean on the default kit? True when a hap that sounds
 * names one of the shared drums and no bank: with `.bank("tr909")` the name
 * resolves to `tr909_bd` and the default kit is not involved.
 *
 * @param {Array<{ value?: unknown }>} haps  the onsets about to be played
 * @param {string[]} [names]
 */
export function usesDefaultDrumKit(haps, names = SHARED_DRUM_NAMES) {
  const shared = new Set(names);
  for (const hap of haps ?? []) {
    const value = hap?.value;
    if (!value || typeof value !== "object") continue;
    if (value.bank) continue;
    if (typeof value.s !== "string") continue;
    // `s("bd:3")` normally arrives as s "bd", n 3 — but be sure.
    if (shared.has(soundKey(value.s.split(":")[0]))) return true;
  }
  return false;
}

/**
 * The live side: holds the two manifests once boot has fetched them, applies
 * a kit to the sound map, and decides when the nudge is due.
 *
 * @param {object} deps
 * @param {(sampleMap: object) => unknown} deps.samples  superdough's samples()
 * @param {Storage | null} [deps.storage]
 */
export function createDrumKitController({
  samples,
  storage = defaultStorage(),
}) {
  const manifests = { classic: null, strudel: null };
  const listeners = new Set();
  let current = readDrumKit(storage);
  let nudgeSeen = readNudgeSeen();
  let showNudge = null;

  function readNudgeSeen() {
    try {
      return storage?.getItem(DRUM_KIT_NUDGE_KEY) != null;
    } catch {
      // Storage that cannot be read cannot remember either; rather never
      // nudge than nudge on every visit.
      return true;
    }
  }
  function markNudgeSeen() {
    nudgeSeen = true;
    try {
      storage?.setItem(DRUM_KIT_NUDGE_KEY, "seen");
    } catch {
      // Still seen for this session.
    }
  }

  const names = () => sharedDrumNames(manifests.classic, manifests.strudel);

  // Put `kit`'s sounds under the shared names. False when that kit's
  // manifest never loaded — the names then keep what they had.
  function register(kit) {
    const sampleMap = manifests[kit];
    if (!sampleMap) return false;
    samples(pickKitSounds(sampleMap, names()));
    return true;
  }

  return {
    /** Boot hands over each manifest as it arrives. */
    setManifest(kit, sampleMap) {
      if (isKit(kit)) manifests[kit] = sampleMap;
    },
    /**
     * Once every default map is registered (dirt-samples owns the shared
     * names at that point): put the stored choice in force.
     */
    applyStored() {
      if (current === DEFAULT_DRUM_KIT) return true;
      return register(current);
    },
    getKit: () => current,
    getSharedNames: names,
    /**
     * Switch kits, now and for later sessions. Choosing — either way — is an
     * answer to the nudge, so it is not shown afterwards.
     *
     * @returns {{ ok: boolean, stored: boolean }} ok: false when the kit's
     *   samples are not available (its manifest failed to load)
     */
    setKit(kit) {
      if (!isKit(kit)) return { ok: false, stored: false };
      markNudgeSeen();
      if (kit !== current && !register(kit)) return { ok: false, stored: false };
      current = kit;
      const stored = storeDrumKit(kit, storage);
      for (const fn of [...listeners]) fn(kit);
      return { ok: true, stored };
    },
    /** `fn(kit)` whenever the kit changes, from wherever. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The card to show; without one nothing is ever marked as seen. */
    setNudge(show) {
      showNudge = show;
    },
    /**
     * Call with the onsets of a pattern that has just started playing.
     * Shows the nudge at most once per browser, and only to someone who has
     * not chosen a kit, is on the default one, could actually switch, and is
     * hearing a pattern the choice changes.
     *
     * @returns {boolean} whether the nudge was shown
     */
    notePlayed(haps) {
      if (nudgeSeen || !showNudge) return false;
      if (current !== DEFAULT_DRUM_KIT) return false;
      if (readStoredDrumKit(storage) != null) return false;
      if (!manifests.strudel) return false;
      if (!usesDefaultDrumKit(haps, names())) return false;
      markNudgeSeen();
      showNudge();
      return true;
    },
  };
}
