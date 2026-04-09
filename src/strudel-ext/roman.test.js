// Run with: pnpm test
//
// Pure unit tests for the Roman-numeral parser. No Strudel imports — these
// just verify the string-math layer that progression() dispatches through
// when the user supplies `{ key }`.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { romanToChord, parseKey, parseRoman, isRomanToken } from "./roman.js";

let warnings;
let originalWarn;
beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
});
afterEach(() => {
  console.warn = originalWarn;
});

describe("parseKey()", () => {
  test("plain major keys", () => {
    assert.deepEqual(parseKey("C"), { tonic: "C", isMinor: false });
    assert.deepEqual(parseKey("G"), { tonic: "G", isMinor: false });
    assert.deepEqual(parseKey("F"), { tonic: "F", isMinor: false });
  });

  test("flats and sharps in the tonic", () => {
    assert.deepEqual(parseKey("Bb"), { tonic: "Bb", isMinor: false });
    assert.deepEqual(parseKey("Eb"), { tonic: "Eb", isMinor: false });
    assert.deepEqual(parseKey("F#"), { tonic: "F#", isMinor: false });
    assert.deepEqual(parseKey("C#"), { tonic: "C#", isMinor: false });
  });

  test("minor keys via the `m` suffix", () => {
    assert.deepEqual(parseKey("Am"), { tonic: "A", isMinor: true });
    assert.deepEqual(parseKey("Cm"), { tonic: "C", isMinor: true });
    assert.deepEqual(parseKey("F#m"), { tonic: "F#", isMinor: true });
    assert.deepEqual(parseKey("Bbm"), { tonic: "Bb", isMinor: true });
  });

  test("verbose qualifiers (maj/major/min/minor)", () => {
    assert.deepEqual(parseKey("Cmaj"), { tonic: "C", isMinor: false });
    assert.deepEqual(parseKey("Cmajor"), { tonic: "C", isMinor: false });
    assert.deepEqual(parseKey("Cmin"), { tonic: "C", isMinor: true });
    assert.deepEqual(parseKey("Cminor"), { tonic: "C", isMinor: true });
    // explicit uppercase M still means major
    assert.deepEqual(parseKey("CM"), { tonic: "C", isMinor: false });
  });

  test("lowercase tonic letter is normalised to uppercase", () => {
    assert.deepEqual(parseKey("c"), { tonic: "C", isMinor: false });
    assert.deepEqual(parseKey("am"), { tonic: "A", isMinor: true });
  });

  test("whitespace is trimmed", () => {
    assert.deepEqual(parseKey("  C  "), { tonic: "C", isMinor: false });
    assert.deepEqual(parseKey("\tAm\n"), { tonic: "A", isMinor: true });
  });

  test("empty / non-string / garbage input returns null", () => {
    assert.equal(parseKey(""), null);
    assert.equal(parseKey("   "), null);
    assert.equal(parseKey(null), null);
    assert.equal(parseKey(undefined), null);
    assert.equal(parseKey(42), null);
    assert.equal(parseKey("H"), null); // German notation, not supported
    assert.equal(parseKey("Cwhat"), null);
    assert.equal(parseKey("Z"), null);
  });
});

describe("parseRoman()", () => {
  test("plain numerals (uppercase = major, lowercase = minor)", () => {
    assert.deepEqual(parseRoman("I"), {
      accidentals: "",
      accidentalSemis: 0,
      numeralStr: "I",
      extension: "",
      isMajor: true,
      degree: 1,
    });
    assert.deepEqual(parseRoman("vi"), {
      accidentals: "",
      accidentalSemis: 0,
      numeralStr: "vi",
      extension: "",
      isMajor: false,
      degree: 6,
    });
  });

  test("all seven degrees, both qualities", () => {
    const cases = [
      ["I", 1, true],
      ["II", 2, true],
      ["III", 3, true],
      ["IV", 4, true],
      ["V", 5, true],
      ["VI", 6, true],
      ["VII", 7, true],
      ["i", 1, false],
      ["ii", 2, false],
      ["iii", 3, false],
      ["iv", 4, false],
      ["v", 5, false],
      ["vi", 6, false],
      ["vii", 7, false],
    ];
    for (const [input, degree, isMajor] of cases) {
      const parsed = parseRoman(input);
      assert.ok(parsed, `expected ${input} to parse`);
      assert.equal(parsed.degree, degree, `${input}.degree`);
      assert.equal(parsed.isMajor, isMajor, `${input}.isMajor`);
      assert.equal(parsed.extension, "", `${input}.extension`);
    }
  });

  test("accidentals on the numeral", () => {
    const flat = parseRoman("bIII");
    assert.equal(flat.accidentals, "b");
    assert.equal(flat.accidentalSemis, -1);
    assert.equal(flat.numeralStr, "III");

    const sharp = parseRoman("#iv");
    assert.equal(sharp.accidentals, "#");
    assert.equal(sharp.accidentalSemis, 1);
    assert.equal(sharp.numeralStr, "iv");

    const doubleFlat = parseRoman("bbVII");
    assert.equal(doubleFlat.accidentalSemis, -2);

    const doubleSharp = parseRoman("##I");
    assert.equal(doubleSharp.accidentalSemis, 2);
  });

  test("extensions follow the numeral", () => {
    assert.equal(parseRoman("ii7").extension, "7");
    assert.equal(parseRoman("V7").extension, "7");
    assert.equal(parseRoman("I^7").extension, "^7");
    assert.equal(parseRoman("vii°").extension, "°");
    assert.equal(parseRoman("vii°7").extension, "°7");
    assert.equal(parseRoman("I+").extension, "+");
    assert.equal(parseRoman("iim7b5").extension, "m7b5");
  });

  test("longest-numeral-wins (no truncation)", () => {
    // `vii` must not match as `vi` + leftover `i`
    assert.equal(parseRoman("vii").numeralStr, "vii");
    // `iv` must not match as `i` + leftover `v`
    assert.equal(parseRoman("iv").numeralStr, "iv");
    // `III` must not match as `II` + leftover `I`
    assert.equal(parseRoman("III").numeralStr, "III");
  });

  test("lookahead rejects sequences that aren't valid Roman numerals", () => {
    // After matching the numeral, the next char must not be another
    // Roman letter — otherwise we'd be silently truncating.
    assert.equal(parseRoman("viv"), null);
    assert.equal(parseRoman("Iv"), null);
  });

  test("non-Roman input returns null", () => {
    assert.equal(parseRoman(""), null);
    assert.equal(parseRoman("Cm7"), null);
    assert.equal(parseRoman("Bb"), null);
    assert.equal(parseRoman("hello"), null);
    assert.equal(parseRoman("8"), null);
    assert.equal(parseRoman(null), null);
    assert.equal(parseRoman(undefined), null);
    assert.equal(parseRoman(42), null);
  });
});

describe("isRomanToken()", () => {
  test("recognises Roman tokens", () => {
    for (const t of [
      "I", "ii", "iii", "IV", "V", "vi", "vii",
      "I7", "ii7", "V7", "I^7", "vii°", "vii°7",
      "bIII", "#iv", "bbVII", "##I",
      "iim7b5", "I+", "i+",
    ]) {
      assert.ok(isRomanToken(t), `expected ${t} to be Roman`);
    }
  });

  test("rejects absolute chord symbols", () => {
    for (const t of [
      "C", "Cm", "Cm7", "Bb", "Bb^7", "F#", "Gm7", "Db^9", "Cm7/G",
    ]) {
      assert.ok(!isRomanToken(t), `expected ${t} to NOT be Roman`);
    }
  });

  test("rejects empty / non-string", () => {
    assert.equal(isRomanToken(""), false);
    assert.equal(isRomanToken(null), false);
    assert.equal(isRomanToken(undefined), false);
    assert.equal(isRomanToken(7), false);
  });
});

describe("romanToChord() — major keys (acceptance criterion)", () => {
  test('progression("ii V I", { key: "C" }) maps to Dm-G-C', () => {
    assert.equal(romanToChord("ii", "C"), "Dm");
    assert.equal(romanToChord("V", "C"), "G");
    assert.equal(romanToChord("I", "C"), "C");
  });

  test('progression("ii7 V7 I^7", { key: "F" }) maps to Gm7-C7-F^7', () => {
    assert.equal(romanToChord("ii7", "F"), "Gm7");
    assert.equal(romanToChord("V7", "F"), "C7");
    assert.equal(romanToChord("I^7", "F"), "F^7");
  });

  test("I V vi IV in C → C G Am F", () => {
    assert.equal(romanToChord("I", "C"), "C");
    assert.equal(romanToChord("V", "C"), "G");
    assert.equal(romanToChord("vi", "C"), "Am");
    assert.equal(romanToChord("IV", "C"), "F");
  });

  test("I V vi IV in G → G D Em C (transposing acceptance criterion)", () => {
    assert.equal(romanToChord("I", "G"), "G");
    assert.equal(romanToChord("V", "G"), "D");
    assert.equal(romanToChord("vi", "G"), "Em");
    assert.equal(romanToChord("IV", "G"), "C");
  });

  test("Bb major: I IV V → Bb Eb F", () => {
    assert.equal(romanToChord("I", "Bb"), "Bb");
    assert.equal(romanToChord("IV", "Bb"), "Eb");
    assert.equal(romanToChord("V", "Bb"), "F");
  });

  test("D major (sharp key): I IV V vi → D G A Bm", () => {
    assert.equal(romanToChord("I", "D"), "D");
    assert.equal(romanToChord("IV", "D"), "G");
    assert.equal(romanToChord("V", "D"), "A");
    assert.equal(romanToChord("vi", "D"), "Bm");
  });
});

describe("romanToChord() — minor keys (acceptance criterion)", () => {
  test('progression("i iv v", { key: "Am" }) maps to Am-Dm-Em', () => {
    assert.equal(romanToChord("i", "Am"), "Am");
    assert.equal(romanToChord("iv", "Am"), "Dm");
    assert.equal(romanToChord("v", "Am"), "Em");
  });

  test("natural minor: i iv v VI VII in Am", () => {
    // Natural minor — no harmonic-minor #7. v is minor, not major.
    assert.equal(romanToChord("i", "Am"), "Am");
    assert.equal(romanToChord("iv", "Am"), "Dm");
    assert.equal(romanToChord("v", "Am"), "Em");
    assert.equal(romanToChord("VI", "Am"), "F");
    assert.equal(romanToChord("VII", "Am"), "G");
  });

  test("Cm: i iv v → Cm Fm Gm", () => {
    assert.equal(romanToChord("i", "Cm"), "Cm");
    assert.equal(romanToChord("iv", "Cm"), "Fm");
    assert.equal(romanToChord("v", "Cm"), "Gm");
  });

  test("Em: i iv v → Em Am Bm (sharp-side minor key)", () => {
    assert.equal(romanToChord("i", "Em"), "Em");
    assert.equal(romanToChord("iv", "Em"), "Am");
    assert.equal(romanToChord("v", "Em"), "Bm");
  });
});

describe("romanToChord() — accidentals on the numeral", () => {
  test("bIII in C major → Eb (Mixolydian-borrow flat-three)", () => {
    assert.equal(romanToChord("bIII", "C"), "Eb");
  });

  test("bVII in C major → Bb", () => {
    assert.equal(romanToChord("bVII", "C"), "Bb");
  });

  test("bVI in C major → Ab", () => {
    assert.equal(romanToChord("bVI", "C"), "Ab");
  });

  test("#iv in C major → F#m (raised four)", () => {
    assert.equal(romanToChord("#iv", "C"), "F#m");
  });

  test("#IV° in C major → F#o (sharp four diminished)", () => {
    assert.equal(romanToChord("#IV°", "C"), "F#o");
  });

  test("explicit accidental dictates spelling (sharp wins for #, flat wins for b)", () => {
    // Same chroma, two spellings — the explicit accidental drives it.
    assert.equal(romanToChord("#i", "C"), "C#m");
    assert.equal(romanToChord("bii", "C"), "Dbm");
  });

  test("double accidentals", () => {
    // bbV in C = -2 from G = F (double flat brings G back to F)
    assert.equal(romanToChord("bbV", "C"), "F");
    // ##I in C = +2 from C = D
    assert.equal(romanToChord("##I", "C"), "D");
  });

  test("bI in C wraps around chromatically (negative chroma handled)", () => {
    // bI lowers the tonic by a semitone — chromatically B, picked from
    // FLAT_NAMES because the explicit `b` accidental forces flat spelling.
    // The cleaner enharmonic spelling would be Cb, but the chroma table
    // doesn't carry Cb so we land on the equivalent B. The point of the
    // test is that the wrap-around math is right, not the spelling.
    assert.equal(romanToChord("bI", "C"), "B");
  });
});

describe("romanToChord() — extensions", () => {
  test("dominant 7 on uppercase numeral", () => {
    assert.equal(romanToChord("V7", "C"), "G7");
    assert.equal(romanToChord("I7", "C"), "C7");
  });

  test("major 7 (^7) on uppercase numeral", () => {
    assert.equal(romanToChord("I^7", "C"), "C^7");
    assert.equal(romanToChord("IV^7", "C"), "F^7");
  });

  test("minor 7 on lowercase numeral (extension prepended with m)", () => {
    assert.equal(romanToChord("ii7", "C"), "Dm7");
    assert.equal(romanToChord("vi7", "C"), "Am7");
    assert.equal(romanToChord("iii7", "C"), "Em7");
  });

  test("minor-major 7 (i^7) — prepends m to keep both qualities", () => {
    // lowercase + ^7 → m^7 (which is mM7 — tonic minor with major 7)
    assert.equal(romanToChord("i^7", "Cm"), "Cm^7");
  });

  test("diminished triad and 7th (° → o)", () => {
    assert.equal(romanToChord("vii°", "C"), "Bo");
    assert.equal(romanToChord("vii°7", "C"), "Bo7");
  });

  test("augmented (+ passes through unchanged)", () => {
    assert.equal(romanToChord("I+", "C"), "C+");
    assert.equal(romanToChord("i+", "Cm"), "C+");
  });

  test("explicit minor extension is not double-prepended (iim7b5 → Dm7b5)", () => {
    assert.equal(romanToChord("iim7b5", "C"), "Dm7b5");
  });

  test("9 / 11 / 13 extensions stick to the numeral", () => {
    assert.equal(romanToChord("V9", "C"), "G9");
    assert.equal(romanToChord("ii9", "C"), "Dm9");
    assert.equal(romanToChord("V13", "C"), "G13");
  });

  test("add9", () => {
    assert.equal(romanToChord("Iadd9", "C"), "Cadd9");
    assert.equal(romanToChord("iiadd9", "C"), "Dmadd9");
  });
});

describe("romanToChord() — error paths", () => {
  test("missing key returns null and warns", () => {
    const result = romanToChord("ii", "");
    assert.equal(result, null);
    assert.ok(
      warnings.some(
        (w) => w.includes("[strasbeat]") && w.toLowerCase().includes("key"),
      ),
      `expected a key warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test("invalid key warns and returns null", () => {
    const result = romanToChord("ii", "Z");
    assert.equal(result, null);
    assert.ok(
      warnings.some(
        (w) => w.includes("[strasbeat]") && w.toLowerCase().includes("key"),
      ),
    );
  });

  test("malformed numeral warns and returns null", () => {
    const result = romanToChord("hello", "C");
    assert.equal(result, null);
    assert.ok(
      warnings.some(
        (w) => w.includes("[strasbeat]") && w.toLowerCase().includes("parse"),
      ),
    );
  });

  test("empty numeral returns null and warns", () => {
    assert.equal(romanToChord("", "C"), null);
    assert.ok(warnings.length > 0);
  });

  test("non-string numeral returns null and warns", () => {
    assert.equal(romanToChord(undefined, "C"), null);
    assert.equal(romanToChord(null, "C"), null);
    assert.equal(romanToChord(42, "C"), null);
    assert.ok(warnings.length > 0);
  });
});

describe("romanToChord() — same numerals, different keys (transposition)", () => {
  test("ii V I in three keys produces three different chord roots", () => {
    const inC = ["ii", "V", "I"].map((r) => romanToChord(r, "C"));
    const inG = ["ii", "V", "I"].map((r) => romanToChord(r, "G"));
    const inF = ["ii", "V", "I"].map((r) => romanToChord(r, "F"));
    assert.deepEqual(inC, ["Dm", "G", "C"]);
    assert.deepEqual(inG, ["Am", "D", "G"]);
    assert.deepEqual(inF, ["Gm", "C", "F"]);
  });
});
