// Run with: node --test src/strudel-ext/progression.test.js
//
// These tests inspect the haps that progression() returns to verify the
// chord/dictionary/sound controls land where the spec says they do. They
// don't render audio — they're pure pattern-shape assertions.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { Pattern, silence } from "@strudel/core";
import { progression, RHYTHMS } from "./progression.js";

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

    const arpHaps = progression("Cm7 F7 Bb^7", { rhythm: "arp-up" }).firstCycle();
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
    const bassHits = values.filter(
      (v) => v.s === "gm_electric_bass_finger",
    );
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
    assert.equal(
      values.filter((v) => v.s === "gm_acoustic_bass").length,
      0,
    );
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
