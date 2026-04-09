// Sugar over the canonical chord().dict().voicing().arp().s() chain so a
// pattern file can sketch a tune from any chord chart in one line:
//
//   $: progression("Cm7 F7 Bb^7 Eb^7")
//   $: progression("Cm7 F7 Bb^7 Eb^7", { rhythm: "arp-up" })
//   $: progression("Cm7 F7 Bb^7", { bass: true })
//
// Voice leading, voicing dictionaries, and chord parsing all stay delegated
// to @strudel/tonal — this module owns nothing musical, only the choice of
// defaults and the rhythm preset table. See design/work/07-chord-progression.md
// for the spec this implements (Phase 1).

import { chord, silence, slowcat, stack } from "@strudel/core";
import { mini } from "@strudel/mini";
// Side-effect import: @strudel/tonal registers .voicing(), .dict() (the
// dictionary control comes from core/controls.mjs), and .rootNotes() on
// Pattern.prototype. main.js imports this transitively, but we re-import
// it here so progression.js works in any context that pulls in this file
// (notably node --test, which doesn't load main.js).
import "@strudel/tonal";
import { isRomanToken, romanToChord } from "./roman.js";
import { STYLES } from "./styles.js";

// Mini-notation arp index strings, one per rhythm preset. The chord pattern
// has its voicing computed first, then `.arp(...)` indexes into the resulting
// notes — `i % haps.length` in @strudel/core/pattern.mjs:1003 means these
// indices wrap modulo the voicing size, so they work for both 3- and 4-note
// dictionaries without per-dict tuning.
//
// `block` is special: no `.arp()` call at all, so the whole chord plays as
// one sustained event per cycle.
const RHYTHMS = {
  block: null,
  // 4 strums per cycle, each strum a fast 4-note ascending sweep.
  strum: "[0 1 2 3]*4",
  // Jazz-style offbeat comp: 8 8th-note steps, full chord stab on the
  // "and" of beat 2 and the "and" of beat 4 (the classic left-hand
  // anticipations).
  comp: "~ ~ ~ [0,1,2,3] ~ ~ ~ [0,1,2,3]",
  // Ascending arpeggio across the cycle.
  "arp-up": "0 1 2 3",
  // Descending.
  "arp-down": "3 2 1 0",
  // Alberti pattern (root-top-middle-top), classical left-hand figure.
  alberti: "0 2 1 2",
};

const DEFAULTS = {
  sound: "gm_epiano1",
  dict: "ireal",
  rhythm: "block",
  bass: false,
};

const DEFAULT_BASS_SOUND = "gm_acoustic_bass";

/**
 * Turn a one-line chord progression into a playable Strudel pattern.
 *
 * Accepts either:
 *   - **absolute** chord symbols (`Cm7 F7 Bb^7`), or
 *   - **Roman numerals** (`ii7 V7 I^7`) when an `options.key` is supplied.
 *
 * Cycles through the chords at one per cycle and runs them through
 * `chord().dict().voicing()` from @strudel/tonal — so voice leading, slash
 * chord parsing (`Cm7/G`), and the voicing dictionaries (`ireal`,
 * `lefthand`, `triads`, `guidetones`, `legacy`) all come for free.
 *
 * Returns a real Strudel `Pattern`, so the result chains with `.slow()`,
 * `.gain()`, `.every()`, etc. like any other source.
 *
 * **Roman numeral input** (Phase 3): if the first whitespace-delimited
 * token looks like a Roman numeral (`I`, `ii`, `V7`, `bIII`, `vii°`,
 * `#iv`, …), the entire input is treated as Roman and dispatched
 * through `romanToChord()`. Mixing Roman and absolute tokens in the
 * same call is **not** supported — once detection picks Roman mode,
 * every token must parse as Roman or it produces silence + a warning.
 * Uppercase = major, lowercase = minor; minor keys use natural minor
 * (Aeolian).
 *
 * **Missing key**: if Roman input is detected but no `options.key` is
 * supplied, returns silence and warns — guessing a key would be worse
 * than failing audibly.
 *
 * @param {string} chords whitespace-separated chord symbols OR Roman numerals
 * @param {object} [options]
 * @param {string} [options.sound="gm_epiano1"] sound name (verify with `strasbeat.hasSound`)
 * @param {string} [options.dict="ireal"] voicing dictionary name
 * @param {string} [options.rhythm="block"] rhythm preset name OR a raw mini-notation arp string
 * @param {boolean|string} [options.bass=false] layer a bass line on the chord roots; pass a sound name to override `gm_acoustic_bass`
 * @param {string} [options.style] style preset that bundles sound + dict + rhythm + FX. Built-in styles: `jazz-comp`, `pop-pad`, `lo-fi`, `folk-strum`, `piano-bare`. Explicit options always override the style — `{ style: "jazz-comp", sound: "gm_piano" }` is "jazz comp on a real piano".
 * @param {string} [options.key] required when `chords` is in Roman-numeral form. Major (`"C"`, `"G"`, `"Bb"`) or minor (`"Am"`, `"Cm"`).
 * @returns {Pattern}
 *
 * @example
 * progression("Cm7 F7 Bb^7 Eb^7")
 * @example
 * progression("ii V I", { key: "C" })
 * @example
 * progression("ii7 V7 I^7", { key: "F", style: "jazz-comp" })
 * @example
 * progression("i iv v", { key: "Am", bass: true })
 * @example
 * progression("Cm7 F7 Bb^7", { style: "jazz-comp" })
 * @example
 * progression("C G Am F", { style: "folk-strum", bass: true })
 */
export function progression(chords, options = {}) {
  // Empty input → return silence loudly. Patterns are re-evaluated live and
  // a thrown error would stop the scheduler entirely (CLAUDE.md "surface
  // silent failures loudly").
  if (typeof chords !== "string" || chords.trim() === "") {
    console.warn(
      '[strasbeat] progression(): empty chord input, returning silence',
    );
    return silence;
  }

  // Roman-numeral detection (Phase 3). If the first token looks like a
  // Roman numeral, treat the *entire* input as Roman and rewrite each
  // token to its absolute chord symbol via romanToChord(). The detection
  // is intentionally one-shot — mixing Roman and absolute tokens in a
  // single call would be a footgun (which mode wins on `Cm7 V7`?), so
  // the documented contract is "all-or-nothing" and any token that
  // fails to parse in Roman mode bails out to silence.
  //
  // We deliberately rewrite *before* style/options merging because the
  // rest of the function (cyclePat, voicing, FX) is identical regardless
  // of how the chord symbols arrived — keeping the dispatch shallow.
  const inputTokens = chords.trim().split(/\s+/);
  if (isRomanToken(inputTokens[0])) {
    if (options.key == null) {
      console.warn(
        "[strasbeat] progression(): Roman-numeral input requires options.key (e.g. { key: \"C\" } or { key: \"Am\" }), returning silence",
      );
      return silence;
    }
    const rewritten = [];
    for (const token of inputTokens) {
      const abs = romanToChord(token, options.key);
      if (abs == null) {
        // romanToChord already warned with a [strasbeat] prefix.
        console.warn(
          `[strasbeat] progression(): Roman-numeral token "${token}" failed to resolve in key "${options.key}", returning silence`,
        );
        return silence;
      }
      rewritten.push(abs);
    }
    chords = rewritten.join(" ");
  }

  // Resolve the style preset (Phase 2). When set, the style fills in
  // sound/dict/rhythm fields the user didn't override, and its `fx` block
  // is applied as the final chain step before returning. Unknown style
  // names warn loudly and continue with no style — same philosophy as
  // unknown rhythm names.
  let styleConfig = null;
  if (options.style != null) {
    if (options.style in STYLES) {
      styleConfig = STYLES[options.style];
    } else {
      console.warn(
        `[strasbeat] progression(): unknown style "${options.style}", ignoring. Known: ${Object.keys(STYLES).join(", ")}`,
      );
    }
  }

  // Merge precedence: defaults < style fields < explicit user options.
  // Pluck only the non-fx fields from the style — fx is applied later as
  // method chains, not as option values, so it must NOT leak into opts.
  const styleFields = styleConfig
    ? {
        sound: styleConfig.sound,
        dict: styleConfig.dict,
        rhythm: styleConfig.rhythm,
      }
    : {};
  const opts = { ...DEFAULTS, ...styleFields, ...options };

  // Resolve the rhythm: a known preset name → its arp string (or null for
  // `block`); an unknown preset name → warn + fall back to block; anything
  // else (including raw mini-notation strings like "0 [0,2] 1") is forwarded
  // verbatim as the escape hatch.
  let arpString;
  if (opts.rhythm in RHYTHMS) {
    arpString = RHYTHMS[opts.rhythm];
  } else if (typeof opts.rhythm === "string" && /[~\[\],]|\s/.test(opts.rhythm)) {
    // Looks like a raw mini-notation pattern (contains whitespace, brackets,
    // commas, or rests) — forward as-is.
    arpString = opts.rhythm;
  } else {
    console.warn(
      `[strasbeat] progression(): unknown rhythm "${opts.rhythm}", falling back to "block". Known: ${Object.keys(RHYTHMS).join(", ")}`,
    );
    arpString = RHYTHMS.block;
  }

  // Build the per-chord pattern using slowcat() — the JS equivalent of the
  // `<a b c>` mini-notation construct. We can't route the chord names
  // through mini() because mini reserves `/` as the slow operator, which
  // collides with slash-chord notation like `Cm7/G`. slowcat treats each
  // arg as a literal cycle, so the slash flows through unchanged and is
  // resolved later by tokenizeChord() inside @strudel/tonal.
  const tokens = chords.trim().split(/\s+/);
  const cyclePat = slowcat(...tokens);

  // chord(pat) attaches the chord control so .voicing() / .dict() / .arp()
  // know which symbol to render. Slash chords (`Cm7/G`) flow through
  // tokenizeChord in @strudel/tonal/tonleiter.mjs:22 — we don't reinvent
  // the parser.
  let chordPat = chord(cyclePat);

  // Only emit .dict() when the user picked something other than the Strudel
  // default — keeps the chain shorter for the 80% case.
  if (opts.dict !== DEFAULTS.dict) {
    chordPat = chordPat.dict(opts.dict);
  }

  chordPat = chordPat.voicing();

  if (arpString != null) {
    // mini() needed for the same reason as above: the inner mini-notation
    // string isn't auto-wrapped outside the transpiler.
    chordPat = chordPat.arp(mini(arpString));
  }

  chordPat = chordPat.s(opts.sound);

  // Stack the optional bass layer first so style FX apply uniformly to
  // both layers (room/lpf/etc. should be on the whole pattern, not just
  // the chords). rootNotes() comes from @strudel/tonal/voicings.mjs and
  // only reads the chord *symbol*, so slash chord bass notes (`Cm7/G`)
  // are ignored at this layer — the slash bass still appears in the
  // voicing itself.
  let result;
  if (opts.bass) {
    const bassSound =
      typeof opts.bass === "string" ? opts.bass : DEFAULT_BASS_SOUND;
    const bassPat = cyclePat.rootNotes(2).note().s(bassSound);
    result = stack(chordPat, bassPat);
  } else {
    result = chordPat;
  }

  // Apply style FX defaults last, so a user chain like
  // `progression(..., { style: "jazz-comp" }).gain(0.5)` still wins (the
  // outer .gain() replaces the style's gain via Strudel's control merge).
  if (styleConfig?.fx) {
    for (const [method, value] of Object.entries(styleConfig.fx)) {
      if (typeof result[method] !== "function") {
        console.warn(
          `[strasbeat] progression(): style "${options.style}" sets fx.${method} but Pattern has no .${method}() — skipping`,
        );
        continue;
      }
      result = result[method](value);
    }
  }

  return result;
}

// Re-exported so unit tests can assert against the canonical preset list
// without duplicating the keys.
export { RHYTHMS, STYLES };
