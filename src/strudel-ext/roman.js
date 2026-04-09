// Roman-numeral → absolute chord symbol parser. Pure string manipulation —
// no Strudel imports — so it's trivially unit-testable in node --test.
//
// The output of romanToChord() is a chord symbol that's intended to be fed
// straight into @strudel/tonal's chord() control: "C", "Dm", "G7", "F^7",
// "Bo7", etc. Strudel's voicing dictionaries already understand all of
// these, so the helper's job is purely the symbol math, not the voicing.
//
// Spec: design/work/07-chord-progression.md, "Phase 3 — Roman numerals
// + key context".

// Pitch class index for every accepted spelling of a tonic. The values are
// chromatic semitone offsets from C, 0..11. Used both for parsing the key
// and for resolving Roman scale degrees back to absolute roots.
const TONIC_CHROMA = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
  // rare enharmonic spellings — accepted so we don't fail on F# major's E#, etc.
  Cb: 11,
  "B#": 0,
  "E#": 5,
  Fb: 4,
};

// Chromatic note tables — same chroma, different spelling. We pick one or
// the other based on the key signature (sharp keys → sharps, flat keys →
// flats), or based on an explicit accidental on the Roman numeral itself.
const FLAT_NAMES = [
  "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
];
const SHARP_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

// Diatonic scale degrees as semitone offsets from the tonic. Indexed
// 0..6 for degrees I..VII. Natural minor (Aeolian) per the spec —
// harmonic/melodic minor variants are not supported in Phase 3 (the
// user can write the substitute chord by hand if they want a #7).
const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];
const MINOR_DEGREES = [0, 2, 3, 5, 7, 8, 10];

// Keys whose signature uses sharps. Used as the default spelling
// preference when a Roman numeral has no explicit accidental. Anything
// not listed here defaults to flats — including C and Am, where the
// choice is academic since the diatonic notes have no accidentals.
const SHARP_KEYS = new Set([
  "G", "D", "A", "E", "B", "F#", "C#",
  "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m",
]);

// Map a Roman numeral letter sequence (uppercase) to its 1-indexed
// scale degree. Used after the alternation regex extracts the numeral.
const ROMAN_DEGREE = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7,
};

// Match a single Roman-numeral chord token. Captures:
//   1: accidentals prefix (any number of b/# in any combination)
//   2: the Roman numeral itself, longest-first so III isn't truncated to I
//   3: the chord-quality extension (everything after the numeral)
// The negative lookahead `(?![ivIV])` after the numeral ensures we
// match the *maximal* Roman numeral — e.g. `vii` doesn't truncate to
// `vi` and leave `i` as the extension.
const ROMAN_RE =
  /^([b#]*)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(?![ivIV])(.*)$/;

/**
 * Parse a key string into `{ tonic, isMinor }`. Accepts the forms the
 * spec calls out (`"C"`, `"G"`, `"Bb"`, `"Am"`, `"Cm"`) plus a few
 * common variants (`"Cmaj"`, `"Cmin"`, `"CM"`, `"cm"`). Returns null
 * for any input the parser can't make sense of — callers warn and
 * fall back to silence rather than guessing a key.
 */
export function parseKey(key) {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (trimmed === "") return null;
  // [letter][accidental][optional quality]
  const m = trimmed.match(/^([A-Ga-g])([b#]?)(.*)$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2];
  const qualStr = m[3].trim();
  const tonic = letter + acc;
  if (TONIC_CHROMA[tonic] === undefined) return null;
  let isMinor;
  if (qualStr === "" || /^(maj|major|M)$/.test(qualStr)) {
    isMinor = false;
  } else if (/^(m|min|minor)$/.test(qualStr)) {
    isMinor = true;
  } else {
    // unknown qualifier — bail rather than guess
    return null;
  }
  return { tonic, isMinor };
}

/**
 * Decompose a Roman-numeral chord token into its parts. Returns null
 * if the token doesn't look like a Roman numeral at all (so the
 * caller can decide whether to warn or treat the token as absolute).
 */
export function parseRoman(numeral) {
  if (typeof numeral !== "string") return null;
  const m = numeral.match(ROMAN_RE);
  if (!m) return null;
  const accidentals = m[1];
  const numeralStr = m[2];
  const extension = m[3];
  const isMajor = numeralStr === numeralStr.toUpperCase();
  const degree = ROMAN_DEGREE[numeralStr.toUpperCase()];
  // +1 semitone per #, -1 per b. The accidentals string is small (~2
  // chars in practice) so a linear scan is fine.
  let accidentalSemis = 0;
  for (const ch of accidentals) {
    if (ch === "#") accidentalSemis += 1;
    else if (ch === "b") accidentalSemis -= 1;
  }
  return { accidentals, accidentalSemis, numeralStr, extension, isMajor, degree };
}

/**
 * Quick predicate: does this token *look* like a Roman numeral chord?
 * Used by progression() to decide whether to dispatch the whole input
 * through romanToChord() or treat it as absolute chord symbols. Cheap
 * because it just runs the same regex parseRoman() does.
 */
export function isRomanToken(token) {
  if (typeof token !== "string" || token === "") return false;
  // Cheap first-character filter so we don't run the regex on
  // obviously-absolute chord symbols like "Cm7" or "Bb^7".
  if (!/^[ivIVb#]/.test(token)) return false;
  return ROMAN_RE.test(token);
}

/**
 * Convert a Roman-numeral chord (e.g. "ii7", "V7", "I^7", "bIII",
 * "vii°") plus a key string ("C", "G", "Bb", "Am", "Cm") into an
 * absolute chord symbol that @strudel/tonal can voice ("Dm7", "G7",
 * "F^7", "Eb", "Bo").
 *
 * Returns null on any parse failure — callers should `[strasbeat]`
 * warn and fall back rather than throwing, because the scheduler is
 * live and any throw stops playback.
 *
 * Conventions:
 *   - Uppercase numeral → major triad   (I → C in C, V → G in C)
 *   - Lowercase numeral → minor triad   (ii → Dm in C, vi → Am in C)
 *   - Accidentals on the numeral lower/raise the root chromatically
 *     (bIII → Eb, #iv → F#)
 *   - Extensions stick to the numeral (ii7 → Dm7, V7 → G7, I^7 → C^7)
 *   - Diminished `°` is translated to Strudel's `o` symbol
 *     (vii° → Bo, vii°7 → Bo7)
 *   - Augmented `+` passes through (I+ → C+)
 *   - Minor keys use the *natural* minor scale (Aeolian) — degree v
 *     is minor, not major; harmonic/melodic minor are out of scope
 */
export function romanToChord(numeral, key) {
  const keyInfo = parseKey(key);
  if (!keyInfo) {
    console.warn(`[strasbeat] roman: invalid key "${key}"`);
    return null;
  }
  const parsed = parseRoman(numeral);
  if (!parsed) {
    console.warn(`[strasbeat] roman: could not parse numeral "${numeral}"`);
    return null;
  }

  const tonicChroma = TONIC_CHROMA[keyInfo.tonic];
  const scale = keyInfo.isMinor ? MINOR_DEGREES : MAJOR_DEGREES;
  const degreeChroma = scale[parsed.degree - 1];
  // +12 + %12 to keep the result in [0, 11] even for negative offsets
  // (e.g. bI in C → -1 → 11 → B).
  const rootChroma =
    ((tonicChroma + degreeChroma + parsed.accidentalSemis) % 12 + 12) % 12;

  // Spelling preference: explicit accidental on the numeral wins
  // (the user's intent is clear), then key signature, then flats by
  // default. Flats are the more common jazz convention, which is
  // what the spec's example progressions are written in.
  let useSharps;
  if (parsed.accidentalSemis > 0) {
    useSharps = true;
  } else if (parsed.accidentalSemis < 0) {
    useSharps = false;
  } else {
    const keyName = keyInfo.tonic + (keyInfo.isMinor ? "m" : "");
    useSharps = SHARP_KEYS.has(keyName);
  }
  const root = (useSharps ? SHARP_NAMES : FLAT_NAMES)[rootChroma];

  // Translate `°` (the canonical diminished glyph) to `o`, which is
  // the symbol Strudel's voicing dictionaries actually key on. Doing
  // it here keeps the input convention idiomatic and the output
  // playable.
  const ext = parsed.extension.replace(/°/g, "o");

  let symbol;
  if (parsed.isMajor) {
    // Uppercase Roman = major-quality triad. The extension is the
    // chord type as-is — `V7` is a dominant 7 (major triad + b7),
    // `I^7` is a major 7, `I+` is augmented.
    symbol = ext;
  } else if (ext === "") {
    // Lowercase Roman, no extension → minor triad.
    symbol = "m";
  } else if (/^[m\-o+h]/.test(ext)) {
    // Lowercase Roman with an extension that already specifies a
    // chord quality (m/-/o/+/h). Use the extension verbatim — don't
    // double-prepend `m`.
    //   iim7b5 → m7b5  (Dm7b5)
    //   vii°   → o     (Bo)
    //   vii°7  → o7    (Bo7)
    //   i+     → +     (C+)
    symbol = ext;
  } else {
    // Lowercase Roman with a numeric/major extension (`7`, `9`,
    // `^7`, `M7`, `add9`, …). Prepend `m` so the chord is
    // unambiguously a minor variant.
    //   ii7  → m7   (Dm7)
    //   i^7  → m^7  (Cm^7 — minor with major 7th)
    //   iiM7 → mM7  (Dm with major 7)
    symbol = "m" + ext;
  }

  return root + symbol;
}
