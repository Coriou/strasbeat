// Run with: node --test src/strudel-ext/progression.test.js
//
// These tests inspect the haps that progression() returns to verify the
// chord/dictionary/sound controls land where the spec says they do. They
// don't render audio — they're pure pattern-shape assertions.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { Pattern, silence } from "@strudel/core";
import { mini } from "@strudel/mini";
import { progression, RHYTHMS, STYLES } from "./progression.js";

// Capture console.warn so we can assert on the [strasbeat] warnings without
// polluting the test output.
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

// Helper: pull the unique values seen in the first cycle. Patterns from
// .voicing() emit multiple stacked notes per chord, so we collapse on
// JSON.stringify to dedupe.
function firstCycleValues(pat) {
  return pat.firstCycle().map((hap) => hap.value);
}
function uniqueValues(pat) {
  const seen = new Map();
  for (const hap of pat.firstCycle()) {
    seen.set(JSON.stringify(hap.value), hap.value);
  }
  return [...seen.values()];
}

describe("progression() — return type", () => {
  test("returns a Strudel Pattern with the default rhythm", () => {
    const pat = progression("Cm7 F7 Bb^7 Eb^7");
    assert.ok(pat instanceof Pattern, "expected an instance of Pattern");
  });

  test("the returned pattern is chainable like any other Strudel source", () => {
    // .slow() and .gain() should be no-throw — confirms the result is a
    // real Pattern, not a static structure.
    const pat = progression("Cm7 F7 Bb^7").slow(2).gain(0.5);
    assert.ok(pat instanceof Pattern);
    // .gain(0.5) should land on every emitted hap.
    const values = firstCycleValues(pat);
    assert.ok(values.length > 0, "expected at least one hap");
    for (const v of values) {
      assert.equal(v.gain, 0.5);
    }
  });
});

describe("progression() — defaults", () => {
  test("default sound is gm_epiano1", () => {
    const pat = progression("Cm7 F7 Bb^7");
    const values = firstCycleValues(pat);
    assert.ok(values.length > 0);
    for (const v of values) {
      assert.equal(v.s, "gm_epiano1");
    }
  });

  test("explicit sound option propagates through every hap", () => {
    const pat = progression("Cm7 F7 Bb^7", { sound: "gm_pad_warm" });
    const values = firstCycleValues(pat);
    for (const v of values) {
      assert.equal(v.s, "gm_pad_warm");
    }
  });

  test("default rhythm = block produces the same haps as omitting rhythm", () => {
    const a = uniqueValues(progression("Cm7 F7 Bb^7"));
    const b = uniqueValues(progression("Cm7 F7 Bb^7", { rhythm: "block" }));
    assert.deepEqual(a, b);
  });
});

describe("progression() — rhythm presets", () => {
  test("RHYTHMS exposes the documented preset names", () => {
    const expected = [
      "block",
      "strum",
      "comp",
      "arp-up",
      "arp-down",
      "alberti",
    ];
    for (const name of expected) {
      assert.ok(name in RHYTHMS, `expected RHYTHMS.${name} to exist`);
    }
  });

  test("block plays voicing notes simultaneously; arp-up plays them sequentially", () => {
    // Block plays the whole voicing as a single sustained chord, so every
    // hap in the cycle starts at time 0. arp-up walks the voicing across
    // the cycle, so the haps start at distinct times.
    const blockHaps = progression("Cm7 F7 Bb^7").firstCycle();
    const blockBegins = new Set(blockHaps.map((h) => h.whole.begin.toString()));
    assert.ok(
      blockBegins.size < blockHaps.length,
      "block should stack notes (some haps share a start time)",
    );

    const arpHaps = progression("Cm7 F7 Bb^7", {
      rhythm: "arp-up",
    }).firstCycle();
    const arpBegins = new Set(arpHaps.map((h) => h.whole.begin.toString()));
    assert.equal(
      arpBegins.size,
      arpHaps.length,
      "arp-up should sequence notes (every hap has a unique start time)",
    );
  });

  test("an unknown rhythm warns and falls back to block", () => {
    const fallback = uniqueValues(
      progression("Cm7 F7", { rhythm: "wat-no-such" }),
    );
    const baseline = uniqueValues(progression("Cm7 F7"));
    assert.deepEqual(fallback, baseline);
    assert.ok(
      warnings.some(
        (w) =>
          w.includes("[strasbeat]") &&
          w.includes("wat-no-such") &&
          w.toLowerCase().includes("rhythm"),
      ),
      `expected a [strasbeat] rhythm warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test("a raw mini-notation rhythm string is forwarded to .arp() as the escape hatch", () => {
    // "0 2" is two whitespace-separated indices — clearly mini-notation,
    // not a typo'd preset name. Should NOT warn and should produce more
    // events than block.
    const pat = progression("Cm7 F7", { rhythm: "0 2" });
    assert.equal(warnings.length, 0, "raw mini-notation should not warn");
    const arpHaps = pat.firstCycle().length;
    const blockHaps = progression("Cm7 F7").firstCycle().length;
    assert.ok(
      arpHaps !== blockHaps,
      "raw mini-notation rhythm should change the hap layout",
    );
  });
});

describe("progression() — bass option", () => {
  test("bass=true layers gm_acoustic_bass on the chord roots", () => {
    const pat = progression("Cm7 F7 Bb^7", { bass: true });
    const values = firstCycleValues(pat);
    const bassHits = values.filter((v) => v.s === "gm_acoustic_bass");
    assert.ok(bassHits.length > 0, "expected at least one bass hap");
    for (const hit of bassHits) {
      // root note in octave 2 — first letter is the chord root
      assert.match(
        String(hit.note),
        /^[A-G][b#]?2$/,
        `bass note should be a root note in octave 2, got ${hit.note}`,
      );
    }
  });

  test("bass=string overrides the default bass sound", () => {
    const pat = progression("Cm7 F7 Bb^7", { bass: "gm_electric_bass_finger" });
    const values = firstCycleValues(pat);
    const bassHits = values.filter((v) => v.s === "gm_electric_bass_finger");
    assert.ok(
      bassHits.length > 0,
      "expected the supplied bass sound to be used on at least one hap",
    );
    // and no defaults left over from the bass layer
    assert.equal(
      values.filter((v) => v.s === "gm_acoustic_bass").length,
      0,
      "default bass sound should be replaced when a custom one is given",
    );
  });

  test("bass=false (default) emits no bass haps at all", () => {
    const values = firstCycleValues(progression("Cm7 F7 Bb^7"));
    assert.equal(values.filter((v) => v.s === "gm_acoustic_bass").length, 0);
  });
});

describe("progression() — slash chords", () => {
  test("slash chord input is accepted (parser delegates to @strudel/tonal)", () => {
    // Just confirm no throw and we get a pattern-shaped result. Voice
    // leading correctness for slash bass is the responsibility of
    // tonal/voicings.mjs, not this helper.
    const pat = progression("Cm7/G F7/A Bb^7");
    assert.ok(pat instanceof Pattern);
    assert.ok(pat.firstCycle().length > 0);
  });
});

describe("progression() — empty / invalid input", () => {
  test("empty string returns silence and warns", () => {
    const pat = progression("");
    assert.equal(pat, silence);
    assert.ok(
      warnings.some(
        (w) => w.includes("[strasbeat]") && w.toLowerCase().includes("empty"),
      ),
      `expected an empty-input warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test("whitespace-only string returns silence and warns", () => {
    const pat = progression("   ");
    assert.equal(pat, silence);
    assert.ok(warnings.length > 0);
  });

  test("non-string input returns silence and warns (defensive)", () => {
    const pat = progression(undefined);
    assert.equal(pat, silence);
    assert.ok(warnings.length > 0);
  });

  test("Pattern input returns silence and warns about double quotes", () => {
    // Reproduces the browser-only failure mode: Strudel's transpiler rewrites
    // double-quoted string literals in pattern files into mini(...) calls,
    // so progression() ends up receiving a Pattern instead of a string. The
    // warning has to name the fix (single quotes) so the failure is
    // diagnosable from the console.
    const pat = progression(mini("Cm7 F7"));
    assert.equal(pat, silence);
    assert.ok(
      warnings.some(
        (w) =>
          w.includes("[strasbeat]") &&
          w.includes("Pattern") &&
          w.includes("single quotes"),
      ),
      `expected a [strasbeat] Pattern-input warning naming single quotes, got: ${JSON.stringify(warnings)}`,
    );
  });
});

describe("progression() — style presets (Phase 2)", () => {
  test("STYLES exposes all five documented presets", () => {
    const expected = [
      "jazz-comp",
      "pop-pad",
      "lo-fi",
      "folk-strum",
      "piano-bare",
    ];
    for (const name of expected) {
      assert.ok(name in STYLES, `expected STYLES.${name} to exist`);
    }
  });

  test("each style has sound, dict, rhythm, fx fields", () => {
    for (const [name, cfg] of Object.entries(STYLES)) {
      assert.equal(typeof cfg.sound, "string", `${name}.sound`);
      assert.equal(typeof cfg.dict, "string", `${name}.dict`);
      assert.equal(typeof cfg.rhythm, "string", `${name}.rhythm`);
      assert.equal(typeof cfg.fx, "object", `${name}.fx`);
    }
  });

  test("style sets sound, dict, rhythm, and fx defaults", () => {
    // jazz-comp: sound gm_epiano1, rhythm comp, fx { room: 0.4, gain: 0.65 }
    const pat = progression("Cm7 F7 Bb^7 Eb^7", { style: "jazz-comp" });
    const values = firstCycleValues(pat);
    assert.ok(values.length > 0);
    for (const v of values) {
      assert.equal(v.s, "gm_epiano1", "style.sound should land on every hap");
      assert.equal(v.room, 0.4, "style fx.room should land on every hap");
      assert.equal(v.gain, 0.65, "style fx.gain should land on every hap");
    }
  });

  test("style produces an audibly distinct pattern from default options", () => {
    const styled = uniqueValues(
      progression("Cm7 F7 Bb^7", { style: "jazz-comp" }),
    );
    const baseline = uniqueValues(progression("Cm7 F7 Bb^7"));
    // jazz-comp uses the comp rhythm, so the hap layout is different from
    // block (block stacks notes simultaneously; comp distributes across
    // 8 8th-note steps).
    assert.notDeepEqual(
      styled.map((v) => v.note).sort(),
      baseline.map((v) => v.note).sort(),
    );
  });

  test("explicit option overrides style field (sound)", () => {
    // jazz-comp normally uses gm_epiano1; explicit sound should win.
    const pat = progression("Cm7 F7 Bb^7", {
      style: "jazz-comp",
      sound: "gm_piano",
    });
    const values = firstCycleValues(pat);
    for (const v of values) {
      assert.equal(v.s, "gm_piano");
    }
  });

  test("explicit option overrides style field (rhythm)", () => {
    // jazz-comp uses comp rhythm; explicit rhythm: arp-up should win and
    // produce sequential single-note haps instead of stacked stabs.
    const pat = progression("Cm7 F7 Bb^7", {
      style: "jazz-comp",
      rhythm: "arp-up",
    });
    const haps = pat.firstCycle();
    const begins = new Set(haps.map((h) => h.whole.begin.toString()));
    assert.equal(
      begins.size,
      haps.length,
      "arp-up should sequence (every hap distinct begin)",
    );
  });

  test("style fx is preserved when only sound is overridden", () => {
    const pat = progression("Cm7 F7 Bb^7", {
      style: "jazz-comp",
      sound: "gm_piano",
    });
    const values = firstCycleValues(pat);
    for (const v of values) {
      assert.equal(v.room, 0.4, "fx.room should still apply");
      assert.equal(v.gain, 0.65, "fx.gain should still apply");
    }
  });

  test("user .gain() chained on the result wins over style fx.gain", () => {
    // Strudel's control merge replaces gain when set twice — verify the
    // user's outer chain takes precedence over the style's defaults.
    const pat = progression("Cm7 F7 Bb^7", { style: "jazz-comp" }).gain(0.2);
    const values = firstCycleValues(pat);
    for (const v of values) {
      assert.equal(v.gain, 0.2);
    }
  });

  test("unknown style warns and falls back to no style", () => {
    const pat = progression("Cm7 F7 Bb^7", { style: "wat-no-such" });
    // Falls back to defaults: gm_epiano1, no fx
    const values = firstCycleValues(pat);
    for (const v of values) {
      assert.equal(v.s, "gm_epiano1");
      assert.equal(v.room, undefined, "unknown style must not apply fx");
      assert.equal(v.gain, undefined);
    }
    assert.ok(
      warnings.some(
        (w) =>
          w.includes("[strasbeat]") &&
          w.includes("wat-no-such") &&
          w.toLowerCase().includes("style"),
      ),
      `expected a [strasbeat] style warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test("style + bass option still composes", () => {
    const pat = progression("C F G", { style: "folk-strum", bass: true });
    const values = firstCycleValues(pat);
    const hasBass = values.some((v) => v.s === "gm_acoustic_bass");
    const hasGuitar = values.some((v) => v.s === "gm_acoustic_guitar_nylon");
    assert.ok(hasBass, "expected the bass layer");
    assert.ok(hasGuitar, "expected the folk-strum guitar sound");
    // folk-strum's room should land on both layers
    for (const v of values) {
      assert.equal(v.room, 0.2);
    }
  });

  test("each documented style produces a distinct sound or rhythm signature", () => {
    // Audition every style on a simple progression and verify they don't
    // collapse to the same output. This guards against accidental dupes
    // when a future style is added.
    const sigs = new Set();
    for (const name of Object.keys(STYLES)) {
      const pat = progression("C F G", { style: name });
      const haps = pat.firstCycle();
      // Sig = sound + first few notes + hap count → loose but enough to
      // distinguish the five built-ins.
      const sig = JSON.stringify({
        s: haps[0]?.value?.s,
        notes: haps.slice(0, 4).map((h) => h.value.note),
        count: haps.length,
      });
      sigs.add(sig);
    }
    assert.equal(
      sigs.size,
      Object.keys(STYLES).length,
      "every style should produce a unique signature on the same chords",
    );
  });
});

describe("progression() — voicing dictionary", () => {
  test("custom dict propagates through the chain", () => {
    // After .voicing() the dictionary control has been consumed, so we
    // can't read it directly from output haps — instead we compare the
    // emitted notes between two dictionaries on the same chord input
    // and expect them to differ. Use plain triads (C F G) so both dicts
    // (`ireal` and `triads`) can voice every chord — `triads` has no
    // m7 entry, so passing Cm7 here would warn even though we'd still
    // see different output.
    const ireal = uniqueValues(progression("C F G"));
    const triads = uniqueValues(progression("C F G", { dict: "triads" }));
    const irealNotes = ireal.map((v) => v.note).sort();
    const triadsNotes = triads.map((v) => v.note).sort();
    assert.notDeepEqual(
      irealNotes,
      triadsNotes,
      "expected ireal and triads dictionaries to voice the same chords differently",
    );
  });
});

describe("progression() — Roman-numeral input (Phase 3)", () => {
  // The roman.test.js suite covers the parser exhaustively. These tests
  // are integration-level: they verify that Roman input flowing through
  // progression() produces the *same haps* as the equivalent absolute
  // input — i.e. the Roman path doesn't drop or warp the chord stack.

  // Helper: pull the sorted unique note set from the first cycle, ignoring
  // begin times (block rhythm stacks notes simultaneously, so position
  // doesn't matter).
  function noteSet(pat) {
    return [...new Set(pat.firstCycle().map((h) => h.value.note))].sort();
  }

  test('progression("ii V I", { key: "C" }) plays Dm-G-C', () => {
    const roman = noteSet(progression("ii V I", { key: "C" }));
    const absolute = noteSet(progression("Dm G C"));
    assert.deepEqual(
      roman,
      absolute,
      "Roman ii V I in C should produce the same notes as Dm G C",
    );
    assert.equal(warnings.length, 0, "no warnings expected on valid input");
  });

  test('progression("ii7 V7 I^7", { key: "F" }) plays Gm7-C7-F^7', () => {
    const roman = noteSet(progression("ii7 V7 I^7", { key: "F" }));
    const absolute = noteSet(progression("Gm7 C7 F^7"));
    assert.deepEqual(
      roman,
      absolute,
      "Roman ii7 V7 I^7 in F should produce the same notes as Gm7 C7 F^7",
    );
  });

  test('progression("i iv v", { key: "Am" }) plays Am-Dm-Em (natural minor)', () => {
    const roman = noteSet(progression("i iv v", { key: "Am" }));
    const absolute = noteSet(progression("Am Dm Em"));
    assert.deepEqual(
      roman,
      absolute,
      "Roman i iv v in Am should produce the same notes as Am Dm Em",
    );
  });

  test("transposition: same numerals in different keys produce different pitches", () => {
    const inC = noteSet(progression("I V vi IV", { key: "C" }));
    const inG = noteSet(progression("I V vi IV", { key: "G" }));
    assert.notDeepEqual(
      inC,
      inG,
      "I V vi IV in C should differ from I V vi IV in G",
    );
    // Sanity check: both should produce non-empty note sets.
    assert.ok(inC.length > 0);
    assert.ok(inG.length > 0);
  });

  test("Roman input without `key` returns silence and warns", () => {
    const pat = progression("ii V I");
    assert.equal(pat, silence);
    assert.ok(
      warnings.some(
        (w) => w.includes("[strasbeat]") && w.toLowerCase().includes("key"),
      ),
      `expected a missing-key warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test("absolute input is NOT misclassified as Roman (Cm7 stays absolute)", () => {
    // Cm7 starts with C, not [ivIVb#] — must take the absolute path,
    // even when no `key` is supplied.
    const pat = progression("Cm7 F7 Bb^7");
    assert.ok(pat instanceof Pattern);
    assert.ok(pat.firstCycle().length > 0);
    assert.equal(warnings.length, 0, "absolute input should not warn");
  });

  test("absolute Bb chord starting with B (not lowercase b) stays absolute", () => {
    // Tricky edge case: `Bb7` starts with uppercase `B` which is NOT in
    // [ivIVb#], so the regex must treat it as absolute. If the detection
    // ever gets confused, this would silently route through the Roman
    // path and produce a warning.
    const pat = progression("Bb7 Eb7");
    assert.ok(pat.firstCycle().length > 0);
    assert.equal(warnings.length, 0);
  });

  test("Roman input with options.key passes through Roman dispatch even when style is set", () => {
    // Make sure style/options merging happens AFTER Roman rewriting, so
    // a styled Roman call still produces the correct chord notes.
    const roman = noteSet(
      progression("ii V I", { key: "C", style: "jazz-comp" }),
    );
    const absolute = noteSet(progression("Dm G C", { style: "jazz-comp" }));
    assert.deepEqual(roman, absolute);
  });

  test("a later Roman token that fails to resolve returns silence and warns", () => {
    // First token `I` triggers Roman detection. The second token `viv`
    // is malformed — the parser's lookahead rejects it — so the whole
    // call bails out to silence rather than producing partially-correct
    // output. Mixing modes is unsupported (per the JSDoc) and silence
    // is the documented failure mode.
    const pat = progression("I viv", { key: "C" });
    assert.equal(pat, silence);
    assert.ok(
      warnings.some((w) => w.includes("[strasbeat]")),
      `expected a [strasbeat] warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test("accidental Roman numerals (bIII, #iv) round-trip correctly", () => {
    const roman = noteSet(progression("I bIII IV", { key: "C" }));
    const absolute = noteSet(progression("C Eb F"));
    assert.deepEqual(roman, absolute);
  });

  test("Roman + bass option still layers a bass line", () => {
    const pat = progression("ii V I", { key: "C", bass: true });
    const values = firstCycleValues(pat);
    const bassHits = values.filter((v) => v.s === "gm_acoustic_bass");
    assert.ok(bassHits.length > 0, "expected at least one bass hap");
  });

  test("Roman input is detected by the first token, not the whole string", () => {
    // Detection rule: if the FIRST whitespace-delimited token starts
    // with [ivIVb#] and matches the Roman regex, the whole input is
    // Roman. This test pins that contract.
    const pat = progression("I V vi IV", { key: "C" });
    assert.ok(pat instanceof Pattern);
    assert.equal(warnings.length, 0);
  });
});

// One chord symbol per onset, in time order, over cycles [0, n).
function chordOnsets(pat, n) {
  return pat
    .queryArc(0, n)
    .filter((h) => h.hasOnset())
    .map((h) => ({
      begin: h.whole.begin.valueOf(),
      end: h.whole.end.valueOf(),
      note: h.value.note,
    }))
    .sort((x, y) => x.begin - y.begin);
}
function onsetTimes(pat, n) {
  return [...new Set(chordOnsets(pat, n).map((h) => h.begin))];
}

describe("progression() — @N weight modifier", () => {
  test("'Am F C G@2' keeps one chord per cycle and holds G for two", () => {
    const pat = progression("Am F C G@2");
    assert.ok(pat instanceof Pattern);
    // Five cycles in total: Am, F, C each one cycle, G two.
    assert.deepEqual(onsetTimes(pat, 5), [0, 1, 2, 3]);
    const g = chordOnsets(pat, 5).filter((h) => h.begin === 3);
    assert.ok(g.length > 0, "expected the G chord at cycle 3");
    for (const hap of g) assert.equal(hap.end, 5, "G should last 2 cycles");
    // …and then the progression loops.
    assert.deepEqual(onsetTimes(pat, 10), [0, 1, 2, 3, 5, 6, 7, 8]);
  });

  test("a weight does not speed the other chords up", () => {
    // The unweighted chords must sit exactly where they do without `@2`.
    const plain = chordOnsets(progression("Am F C G"), 3);
    const weighted = chordOnsets(progression("Am F C G@2"), 3);
    assert.deepEqual(weighted, plain);
  });

  test("@1 is a no-op (same as no modifier)", () => {
    const baseline = progression("Am F C G");
    const withAt1 = progression("Am F C G@1");
    assert.deepEqual(chordOnsets(withAt1, 4), chordOnsets(baseline, 4));
  });

  test("mixed weights: 'Am@2 F C G' holds Am for two cycles", () => {
    const pat = progression("Am@2 F C G");
    assert.deepEqual(onsetTimes(pat, 5), [0, 2, 3, 4]);
  });

  test("@N with bass: bass layer inherits the same time structure", () => {
    const pat = progression("Am F C G@2", { bass: true });
    const bass = pat
      .queryArc(0, 5)
      .filter((h) => h.hasOnset() && h.value.s === "gm_acoustic_bass")
      .map((h) => h.whole.begin.valueOf())
      .sort((x, y) => x - y);
    assert.deepEqual(bass, [0, 1, 2, 3]);
  });

  test("@N with style composes correctly", () => {
    const pat = progression("Cm7 F7@2 Bb^7", { style: "jazz-comp" });
    assert.ok(pat instanceof Pattern);
    const values = pat.queryArc(0, 4).map((h) => h.value);
    // comp = two 4-note stabs per cycle, on every one of the four cycles.
    assert.equal(values.length, 4 * 2 * 4);
    for (const v of values) {
      assert.equal(v.room, 0.4, "style fx should still apply with weights");
    }
  });
});

// "time:note" for every onset in [from, to), in time order. `step` splits
// the range into consecutive queries of that length — the pattern must not
// care how it is asked (the WAV export asks for everything at once, the
// scheduler for a few hundredths of a cycle at a time).
function noteSequence(pat, from, to, step = to - from) {
  const out = [];
  for (let t = from; t < to - 1e-9; t += step) {
    for (const h of pat.queryArc(t, Math.min(t + step, to))) {
      if (!h.hasOnset()) continue;
      out.push([h.whole.begin.valueOf(), String(h.value.note)]);
    }
  }
  return out
    .sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
    .map(([begin, note]) => `${Number(begin.toFixed(6))}:${note}`);
}
// The same sequence, moved by a whole number of cycles.
const shifted = (sequence, by) =>
  sequence.map((entry) => {
    const [begin, note] = entry.split(":");
    return `${Number((Number(begin) + by).toFixed(6))}:${note}`;
  });

describe("progression() — @N with a rhythm re-plays the figure on every held cycle", () => {
  test("'Am G@2' arp-up: G's arpeggio on both held cycles, note for note", () => {
    const pat = progression("Am G@2", { rhythm: "arp-up" });
    assert.deepEqual(noteSequence(pat, 1, 3), [
      "1:G3", "1.25:D4", "1.5:G4", "1.75:B4",
      "2:G3", "2.25:D4", "2.5:G4", "2.75:B4",
    ]); // prettier-ignore
    // …and the loop is three cycles long: Am comes back at cycle 3.
    assert.deepEqual(
      noteSequence(pat, 3, 4),
      shifted(noteSequence(pat, 0, 1), 3),
    );
  });

  const cases = [
    ["arp-up", { rhythm: "arp-up" }],
    ["arp-down", { rhythm: "arp-down" }],
    ["strum", { rhythm: "strum" }],
    ["comp", { rhythm: "comp" }],
    ["alberti", { rhythm: "alberti" }],
    ["raw mini-notation", { rhythm: "0 [1,2] ~ 3" }],
    ["style jazz-comp", { style: "jazz-comp" }],
    // The lefthand dictionary only voices seventh chords.
    ["style lo-fi", { style: "lo-fi" }, ["Am7", "G7", "F^7"]],
    ["style folk-strum", { style: "folk-strum" }],
    ["arp-up + bass", { rhythm: "arp-up", bass: true }],
  ];
  for (const [name, options, [a, b, c] = ["Am", "G", "F"]] of cases) {
    test(`${name}: each held cycle sounds like the chord's own cycle`, () => {
      const held = progression(`${a} ${b}@2 ${c}`, options);
      const plain = progression(`${a} ${b} ${c}`, options);
      const g = noteSequence(plain, 1, 2);
      assert.ok(g.length >= 4, "the reference cycle has notes");
      if (!options.bass) {
        assert.deepEqual(noteSequence(held, 1, 2), g);
        assert.deepEqual(noteSequence(held, 2, 3), shifted(g, 1));
      }
      // F is pushed back by exactly the one extra cycle.
      assert.deepEqual(
        noteSequence(held, 3, 4),
        shifted(noteSequence(plain, 2, 3), 1),
      );
    });

    test(`${name}: one 2-cycle query, two 1-cycle queries and scheduler-sized windows agree`, () => {
      const pat = progression(`${a} ${b}@2 ${c}`, options);
      const whole = noteSequence(pat, 1, 3);
      assert.ok(whole.length >= 8);
      assert.deepEqual(noteSequence(pat, 1, 3, 1), whole);
      assert.deepEqual(noteSequence(pat, 0, 8), noteSequence(pat, 0, 8, 1));
      // Windows that straddle the cycle boundary inside the held chord
      // (0.05 s at 110 BPM, as the scheduler asks).
      assert.deepEqual(
        noteSequence(pat, 0, 4, 0.05 * (110 / 240)),
        noteSequence(pat, 0, 4),
      );
    });
  }

  test("the bass under a held, arpeggiated chord is still one held note", () => {
    const pat = progression("Am G@2", { rhythm: "arp-up", bass: true });
    const bass = pat
      .queryArc(0, 3)
      .filter((h) => h.hasOnset() && h.value.s === "gm_acoustic_bass")
      .map((h) => [h.whole.begin.valueOf(), h.whole.end.valueOf()]);
    assert.deepEqual(bass.sort((x, y) => x[0] - y[0]), [[0, 1], [1, 3]]); // prettier-ignore
  });
});

describe("progression() — *N repeat modifier", () => {
  test("'Am F C G*2' plays G twice inside its one cycle", () => {
    const pat = progression("Am F C G*2");
    assert.ok(pat instanceof Pattern);
    // Still a 4-cycle loop; only the G cycle is subdivided.
    assert.deepEqual(onsetTimes(pat, 4), [0, 1, 2, 3, 3.5]);
    assert.deepEqual(onsetTimes(pat, 8).slice(5), [4, 5, 6, 7, 7.5]);
    const g = chordOnsets(pat, 4).filter((h) => h.begin >= 3);
    const first = g.filter((h) => h.begin === 3).map((h) => h.note);
    const second = g.filter((h) => h.begin === 3.5).map((h) => h.note);
    assert.deepEqual(second.sort(), first.sort(), "both hits are the G chord");
  });

  test("*1 is a no-op (same as no modifier)", () => {
    const baseline = progression("Am F C G");
    const withStar1 = progression("Am F C G*1");
    assert.deepEqual(chordOnsets(withStar1, 4), chordOnsets(baseline, 4));
  });

  test("*N with bass: bass layer repeats with the chord", () => {
    const pat = progression("Am F C G*2", { bass: true });
    const bass = pat
      .queryArc(0, 4)
      .filter((h) => h.hasOnset() && h.value.s === "gm_acoustic_bass")
      .map((h) => h.whole.begin.valueOf())
      .sort((x, y) => x - y);
    assert.deepEqual(bass, [0, 1, 2, 3, 3.5]);
  });
});

describe("progression() — *N with a rhythm runs the figure N times in the cycle", () => {
  test("'Am G*2' arp-up: G's arpeggio twice inside its one cycle", () => {
    const pat = progression("Am G*2", { rhythm: "arp-up" });
    assert.deepEqual(noteSequence(pat, 1, 2), [
      "1:G3", "1.125:D4", "1.25:G4", "1.375:B4",
      "1.5:G3", "1.625:D4", "1.75:G4", "1.875:B4",
    ]); // prettier-ignore
    // Am is untouched, and the loop is still two cycles.
    const plain = progression("Am G", { rhythm: "arp-up" });
    assert.deepEqual(noteSequence(pat, 0, 1), noteSequence(plain, 0, 1));
    assert.deepEqual(noteSequence(pat, 2, 4), shifted(noteSequence(pat, 0, 2), 2));
  });

  test("comp: the stabs come twice as often on the repeated chord only", () => {
    const pat = progression("Am G*2", { rhythm: "comp" });
    const times = (from, to) => [
      ...new Set(noteSequence(pat, from, to).map((e) => Number(e.split(":")[0]))),
    ];
    assert.deepEqual(times(0, 1), [0.375, 0.875]);
    assert.deepEqual(times(1, 2), [1.1875, 1.4375, 1.6875, 1.9375]);
  });

  test("query windows agree, alone and mixed with @N", () => {
    for (const chords of ["Am G*2 F", "Am@2 F C*3 G"]) {
      for (const options of [{ rhythm: "strum" }, { style: "jazz-comp" }]) {
        const pat = progression(chords, options);
        const whole = noteSequence(pat, 0, 6);
        assert.deepEqual(noteSequence(pat, 0, 6, 1), whole);
        assert.deepEqual(noteSequence(pat, 0, 6, 0.05 * (110 / 240)), whole);
      }
    }
  });
});

describe("progression() — mixed @N and *N in one string", () => {
  test("'Am@2 F C*2 G' = Am for 2 cycles, F, C twice in one cycle, G", () => {
    const pat = progression("Am@2 F C*2 G");
    assert.ok(pat instanceof Pattern);
    assert.deepEqual(onsetTimes(pat, 5), [0, 2, 3, 3.5, 4]);
  });
});

describe("progression() — option edge cases", () => {
  test("a double-quoted (Pattern) option warns with the single-quote fix", () => {
    // Inside a pattern file the transpiler turns "arp-up" into mini("arp-up").
    for (const name of ["rhythm", "style", "key", "bass"]) {
      warnings = [];
      const pat = progression("Am F", { [name]: mini("x") });
      assert.ok(pat instanceof Pattern);
      assert.ok(
        warnings.some(
          (w) => w.includes(`option "${name}"`) && w.includes("single quotes"),
        ),
        `expected a single-quote warning for ${name}, got: ${JSON.stringify(warnings)}`,
      );
    }
  });

  test("a Pattern bass falls back to no bass layer rather than a wrong sound", () => {
    const pat = progression("Am F", { bass: mini("gm_synth_bass_1") });
    const sounds = new Set(pat.firstCycle().map((h) => h.value.s));
    assert.deepEqual([...sounds], ["gm_epiano1"]);
  });

  test("names inherited from Object.prototype are not presets", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      warnings = [];
      const byRhythm = progression("Am F", { rhythm: name });
      assert.ok(byRhythm.firstCycle().length > 0, "falls back to block");
      assert.ok(warnings.some((w) => w.includes("unknown rhythm")));
      warnings = [];
      const byStyle = progression("Am F", { style: name });
      assert.ok(byStyle.firstCycle().length > 0);
      assert.ok(warnings.some((w) => w.includes("unknown style")));
    }
  });
});

describe("progression() — Roman numerals with @N/*N modifiers", () => {
  // Helper: same note-set comparison as the Roman describe block above.
  function noteSet(pat) {
    return [...new Set(pat.firstCycle().map((h) => h.value.note))].sort();
  }

  test("'ii V@2 I' in C matches 'Dm G@2 C'", () => {
    const roman = noteSet(progression("ii V@2 I", { key: "C" }));
    const absolute = noteSet(progression("Dm G@2 C"));
    assert.deepEqual(
      roman,
      absolute,
      "Roman ii V@2 I in C should produce the same notes as Dm G@2 C",
    );
    assert.equal(warnings.length, 0);
  });

  test("'I IV*2 V' in G matches 'G C*2 D'", () => {
    const roman = noteSet(progression("I IV*2 V", { key: "G" }));
    const absolute = noteSet(progression("G C*2 D"));
    assert.deepEqual(
      roman,
      absolute,
      "Roman I IV*2 V in G should produce the same notes as G C*2 D",
    );
    assert.equal(warnings.length, 0);
  });
});
