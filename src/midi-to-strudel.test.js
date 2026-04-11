// Run with: pnpm test
//
// Tests for the shared MIDI → Strudel translation core. Uses test-midi.mid
// (the "Piano Template" — 6/8 at 200 BPM, 87 bars, 3 non-empty tracks) as
// the primary fixture. Other tests build synthetic TranslationInput objects
// to exercise the codegen in isolation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseMidiFile,
  analyzeTranslationInput,
  generatePatternDraft,
  midiFileToPattern,
} from "./midi-to-strudel.js";

import {
  GM_INSTRUMENT_MAP,
  GM_DRUM_MAP,
  resolveGmInstrument,
  resolveGmDrum,
} from "./midi-gm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, "..");

function loadFixture(filename) {
  const buf = readFileSync(resolve(fixtureDir, filename));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ─────────────────────────────────────────────────────────────────────────────
// GM mapping module
// ─────────────────────────────────────────────────────────────────────────────

describe("midi-gm.js", () => {
  test("resolveGmInstrument returns mapped name for known programs", () => {
    assert.equal(resolveGmInstrument(0), "gm_piano");
    assert.equal(resolveGmInstrument(4), "gm_epiano1");
    assert.equal(resolveGmInstrument(48), "gm_string_ensemble_1");
    assert.equal(resolveGmInstrument(65), "gm_alto_sax");
    assert.equal(resolveGmInstrument(89), "gm_pad_warm");
  });

  test("resolveGmInstrument falls back to gm_piano for unknown programs", () => {
    assert.equal(resolveGmInstrument(999), "gm_piano");
    assert.equal(resolveGmInstrument(-1), "gm_piano");
  });

  test("resolveGmDrum maps standard kit pieces", () => {
    assert.equal(resolveGmDrum(36), "bd");
    assert.equal(resolveGmDrum(38), "sd");
    assert.equal(resolveGmDrum(42), "hh");
    assert.equal(resolveGmDrum(46), "oh");
    assert.equal(resolveGmDrum(49), "cr");
    assert.equal(resolveGmDrum(51), "ride");
    assert.equal(resolveGmDrum(39), "cp");
    assert.equal(resolveGmDrum(56), "cb");
  });

  test("resolveGmDrum returns null for unmapped notes", () => {
    assert.equal(resolveGmDrum(0), null);
    assert.equal(resolveGmDrum(200), null);
  });

  test("GM_INSTRUMENT_MAP covers all 128 programs", () => {
    for (let i = 0; i < 128; i++) {
      assert.ok(
        GM_INSTRUMENT_MAP[i] !== undefined,
        `GM program ${i} is not mapped`,
      );
      assert.ok(
        typeof GM_INSTRUMENT_MAP[i] === "string" &&
          GM_INSTRUMENT_MAP[i].length > 0,
        `GM program ${i} has invalid mapping: ${GM_INSTRUMENT_MAP[i]}`,
      );
    }
  });

  test("mapped GM soundfont names exist in the installed Strudel soundfont table", () => {
    const gmTable = readFileSync(
      resolve(fixtureDir, "node_modules/@strudel/soundfonts/gm.mjs"),
      "utf8",
    );
    const available = new Set(
      [...gmTable.matchAll(/^[ \t]*([a-z0-9_]+): \[/gm)].map(
        (match) => match[1],
      ),
    );

    for (const [program, soundName] of Object.entries(GM_INSTRUMENT_MAP)) {
      assert.ok(
        available.has(soundName),
        `GM program ${program} maps to missing soundfont name ${soundName}`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// File adapter: parseMidiFile
// ─────────────────────────────────────────────────────────────────────────────

describe("parseMidiFile()", () => {
  test("parses test-midi.mid into TranslationInput", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);

    assert.equal(input.sourceName, "Piano Template");
    assert.equal(input.bpm, 200);
    assert.deepEqual(input.timeSignature, [6, 8]);
    assert.equal(input.ppq, 192);
    assert.equal(input.hasTempoChanges, false);
    assert.equal(input.hasTimeSigChanges, false);
  });

  test("preserves empty tracks so the UI can show them disabled", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);

    assert.equal(input.tracks.length, 4);
    assert.equal(input.tracks[2].name, "Staff-1");
    assert.equal(input.tracks[2].notes.length, 0);
  });

  test("normalizes note names to lowercase", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);

    for (const track of input.tracks) {
      for (const note of track.notes) {
        assert.match(
          note.name,
          /^[a-g][b#]?\d+$/,
          `Note name "${note.name}" is not lowercase/normalized`,
        );
      }
    }
  });

  test("track metadata is correct", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);

    // Track 0: Right Hand, piano, 560 notes
    assert.equal(input.tracks[0].name, "Right Hand");
    assert.equal(input.tracks[0].notes.length, 560);
    assert.equal(input.tracks[0].isDrum, false);
    assert.equal(input.tracks[0].gmProgram, 0);

    // Track 1: Left Hand, piano, 698 notes
    assert.equal(input.tracks[1].name, "Left Hand");
    assert.equal(input.tracks[1].notes.length, 698);

    // Track 2: empty Staff-1 preserved for the UI
    assert.equal(input.tracks[2].name, "Staff-1");
    assert.equal(input.tracks[2].notes.length, 0);

    // Track 3: strings, 195 notes
    assert.equal(input.tracks[3].notes.length, 195);
    assert.equal(input.tracks[3].gmProgram, 48);
  });

  test("note times and durations are positive numbers", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);

    for (const track of input.tracks) {
      for (const note of track.notes) {
        assert.ok(note.time >= 0, `Negative time: ${note.time}`);
        assert.ok(note.duration > 0, `Non-positive duration: ${note.duration}`);
        assert.ok(
          note.velocity > 0 && note.velocity <= 1,
          `Invalid velocity: ${note.velocity}`,
        );
        assert.ok(
          note.midi >= 0 && note.midi <= 127,
          `Invalid MIDI number: ${note.midi}`,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Analyzer: analyzeTranslationInput
// ─────────────────────────────────────────────────────────────────────────────

describe("analyzeTranslationInput()", () => {
  test("analyzes test-midi.mid correctly", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);

    assert.equal(analysis.name, "Piano Template");
    assert.equal(analysis.bpm, 200);
    assert.deepEqual(analysis.timeSignature, [6, 8]);
    assert.equal(analysis.ppq, 192);
    assert.ok(
      analysis.totalBars > 80,
      `Expected 87+ bars, got ${analysis.totalBars}`,
    );
    assert.equal(analysis.tracks.length, 3);
  });

  test("maps GM instruments to Strudel sounds", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);

    // Track 0 & 1: piano → gm_piano
    assert.equal(analysis.tracks[0].strudelSound, "gm_piano");
    assert.equal(analysis.tracks[1].strudelSound, "gm_piano");
    // Track 2: string ensemble 1 → gm_string_ensemble_1
    assert.equal(analysis.tracks[2].strudelSound, "gm_string_ensemble_1");
  });

  test("sanitizes track identifiers", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);

    // Identifiers should be valid JS names
    for (const track of analysis.tracks) {
      assert.match(
        track.identifier,
        /^[a-z][a-zA-Z0-9]*$/,
        `Invalid identifier: "${track.identifier}"`,
      );
    }
  });

  test("deduplicates identifiers", () => {
    const input = {
      sourceName: "test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
          ],
        },
        {
          name: "Piano",
          channel: 1,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "e4", midi: 64, time: 0, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    assert.equal(analysis.tracks[0].identifier, "piano");
    assert.equal(analysis.tracks[1].identifier, "piano2");
  });

  test("auto-detects grid subdivision", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);

    // 6/8 time, should detect a compound grid
    assert.ok(
      analysis.gridSubdivision >= 6,
      `Expected grid >= 6 for 6/8, got ${analysis.gridSubdivision}`,
    );
  });

  test("respects gridSubdivision override", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input, { gridSubdivision: 12 });

    assert.equal(analysis.gridSubdivision, 12);
  });

  test("respects trackIndices filter", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input, { trackIndices: [0, 3] });

    assert.equal(analysis.tracks.length, 2);
    assert.equal(analysis.tracks[0].name, "Right Hand");
    assert.equal(analysis.tracks[1].name, "Track 4");
  });

  test("drops empty tracks during analysis by default", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);

    assert.equal(analysis.tracks.length, 3);
    assert.ok(!analysis.tracks.some((track) => track.name === "Staff-1"));
  });

  test("warns when drum notes are unmapped", () => {
    const input = {
      sourceName: "drum-warning",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Drums",
          channel: 9,
          isDrum: true,
          gmInstrument: "percussion",
          gmProgram: 0,
          notes: [
            { name: "c2", midi: 36, time: 0, duration: 0.1, velocity: 0.9 },
            { name: "c1", midi: 24, time: 0.5, duration: 0.1, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    assert.ok(
      analysis.warnings.some((warning) => warning.includes("unmapped GM drum")),
      "Expected an unmapped drum warning in analysis.warnings",
    );
  });

  test("warns when overlapping same-pitch notes are collapsed", () => {
    const input = {
      sourceName: "overlap-warning",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Lead",
          channel: 0,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 1, velocity: 0.8 },
            { name: "c4", midi: 60, time: 0.5, duration: 0.5, velocity: 0.7 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    assert.ok(
      analysis.warnings.some((warning) =>
        warning.includes("overlapping same-pitch"),
      ),
      "Expected an overlap warning in analysis.warnings",
    );
  });

  test("warns when many notes are truncated at the bar boundary", () => {
    const input = {
      sourceName: "truncation-warning",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Pads",
          channel: 0,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 3, velocity: 0.8 },
            { name: "e4", midi: 64, time: 0.25, duration: 3, velocity: 0.8 },
            { name: "g4", midi: 67, time: 0.5, duration: 3, velocity: 0.8 },
            { name: "b4", midi: 71, time: 0.75, duration: 3, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    assert.ok(
      analysis.warnings.some((warning) =>
        warning.includes("crossing bar boundaries"),
      ),
      "Expected a truncation warning in analysis.warnings",
    );
  });

  test("warns when staggered polyphony will be simplified", () => {
    const input = {
      sourceName: "polyphony-warning",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Keys",
          channel: 0,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 1.5, velocity: 0.8 },
            { name: "g4", midi: 67, time: 0.5, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    assert.ok(
      analysis.warnings.some((warning) =>
        warning.includes("staggered polyphonic overlap"),
      ),
      "Expected a staggered polyphony warning in analysis.warnings",
    );
  });

  test("warns on tempo changes", () => {
    const input = {
      sourceName: "test",
      bpm: 120,
      timeSignature: [4, 4],
      hasTempoChanges: true,
      tracks: [
        {
          name: "track",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    const tempoWarning = analysis.warnings.find((w) =>
      w.includes("Tempo changes"),
    );
    assert.ok(tempoWarning, "Expected a tempo change warning");
  });

  test("computes pitch range", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);

    // Right Hand: D4-C6 range (MIDI 53-84 roughly)
    assert.ok(
      analysis.tracks[0].pitchRange.includes("–"),
      `Expected pitch range format "X–Y", got "${analysis.tracks[0].pitchRange}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Code generator: generatePatternDraft
// ─────────────────────────────────────────────────────────────────────────────

describe("generatePatternDraft()", () => {
  test("generates valid Strudel pattern from test-midi.mid", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    // Must start with setcpm
    assert.ok(
      code.startsWith("setcpm("),
      `Should start with setcpm, got: ${code.slice(0, 40)}`,
    );

    // Must contain note() for melodic tracks
    assert.ok(code.includes("note("), "Should contain note()");

    // Must contain .s() for sound assignment
    assert.ok(code.includes('.s("gm_piano")'), 'Should contain .s("gm_piano")');
    assert.ok(
      code.includes('.s("gm_string_ensemble_1")'),
      'Should contain .s("gm_string_ensemble_1")',
    );

    // Must contain named block labels
    assert.ok(code.includes("rightHand:"), "Should contain rightHand: label");
    assert.ok(code.includes("leftHand:"), "Should contain leftHand: label");
  });

  test("uses setcpm not setcps", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    assert.ok(!code.includes("setcps"), "Should use setcpm, not setcps");
    assert.ok(code.includes("setcpm("), "Should use setcpm");
  });

  test("uses note names not MIDI numbers", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    // Pattern body should contain note names like "c4 e4 g4"
    // With repetition detection, names may be in const declarations
    // rather than inline in cat(). Check the full code.
    assert.match(
      code,
      /[a-g][b#]?\d/,
      "Generated code should contain note names",
    );

    // Should not contain standalone MIDI numbers as note content
    assert.ok(
      !code.match(/note\(\s*cat\(\s*"[\d\s]+"/),
      "Should use note names, not MIDI numbers",
    );
  });

  test("uses s() not .sound()", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    assert.ok(!code.includes(".sound("), "Should use .s(), not .sound()");
  });

  test("uses double-quoted mini strings", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    // Mini-notation strings inside cat() should be double-quoted
    const catContent = code.match(/cat\(\n([\s\S]*?)\n\s*\)/g);
    assert.ok(catContent, "Should have cat() blocks");

    for (const block of catContent) {
      // Each line inside cat should use double quotes
      const lines = block
        .split("\n")
        .filter((l) => l.trim() && !l.includes("cat(") && !l.includes(")"));
      for (const line of lines) {
        if (line.includes('"')) {
          assert.ok(
            !line.includes("'"),
            `Mini strings should use double quotes, not single: ${line.trim()}`,
          );
        }
      }
    }
  });

  test("uses cat() for bar sequencing (not seq)", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    assert.ok(code.includes("cat("), "Should use cat() for bar sequencing");
    // Shouldn't use seq() for the same purpose
    assert.ok(!code.includes("seq("), "Should not use seq()");
  });

  test("applies .room(0.2) as default reverb on pitched tracks", () => {
    const buffer = loadFixture("test-midi.mid");
    const input = parseMidiFile(buffer);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    assert.ok(code.includes(".room(0.2)"), "Should apply default reverb");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drum track generation
// ─────────────────────────────────────────────────────────────────────────────

describe("drum track generation", () => {
  test("generates s() for drum tracks, not note()", () => {
    const input = {
      sourceName: "drums-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Drums",
          channel: 9,
          isDrum: true,
          gmInstrument: "percussion",
          gmProgram: 0,
          notes: [
            { name: "c2", midi: 36, time: 0, duration: 0.1, velocity: 0.9 },
            { name: "d2", midi: 38, time: 0.5, duration: 0.1, velocity: 0.8 },
            { name: "f#2", midi: 42, time: 0, duration: 0.1, velocity: 0.6 },
            { name: "f#2", midi: 42, time: 0.5, duration: 0.1, velocity: 0.6 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    // Drum tracks use s(), not note()
    assert.ok(code.includes("s("), "Drum track should use s()");
    assert.ok(!code.includes("note("), "Drum track should not use note()");

    // Should use sample names, not note names
    assert.ok(code.includes("bd"), "Should contain bd (bass drum)");
    assert.ok(code.includes("sd"), "Should contain sd (snare)");
    assert.ok(code.includes("hh"), "Should contain hh (hihat)");
  });

  test("layers simultaneous drum hits with comma", () => {
    const input = {
      sourceName: "drums-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Drums",
          channel: 9,
          isDrum: true,
          gmInstrument: "percussion",
          gmProgram: 0,
          notes: [
            { name: "c2", midi: 36, time: 0, duration: 0.1, velocity: 0.9 },
            { name: "f#2", midi: 42, time: 0, duration: 0.1, velocity: 0.6 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    // Simultaneous bd + hh should be [bd,hh] or [hh,bd]
    assert.ok(
      code.includes("[bd,hh]") || code.includes("[hh,bd]"),
      `Should layer simultaneous drums with comma, got: ${code}`,
    );
  });

  test("warns on unmapped drum notes", () => {
    const input = {
      sourceName: "drums-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Drums",
          channel: 9,
          isDrum: true,
          gmInstrument: "percussion",
          gmProgram: 0,
          notes: [
            { name: "c2", midi: 36, time: 0, duration: 0.1, velocity: 0.9 },
            { name: "c1", midi: 24, time: 0.5, duration: 0.1, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    // MIDI 24 is not in GM_DRUM_MAP
    assert.ok(
      code.includes("unmapped drum notes"),
      `Should warn about unmapped drum MIDI 24, got: ${code}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chord notation
// ─────────────────────────────────────────────────────────────────────────────

describe("chord notation", () => {
  test("simultaneous notes produce comma-separated brackets", () => {
    const input = {
      sourceName: "chord-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c3", midi: 48, time: 0, duration: 1, velocity: 0.8 },
            { name: "e3", midi: 52, time: 0, duration: 1, velocity: 0.8 },
            { name: "g3", midi: 55, time: 0, duration: 1, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    // Should produce [c3,e3,g3] chord notation
    assert.ok(
      code.includes("[c3,e3,g3]"),
      `Should produce sorted chord [c3,e3,g3], got: ${code}`,
    );
  });

  test("chord tones sorted low to high", () => {
    const input = {
      sourceName: "chord-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            // Insert in high-to-low order
            { name: "g4", midi: 67, time: 0, duration: 1, velocity: 0.8 },
            { name: "c4", midi: 60, time: 0, duration: 1, velocity: 0.8 },
            { name: "e4", midi: 64, time: 0, duration: 1, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    assert.ok(
      code.includes("[c4,e4,g4]"),
      `Chord tones should be sorted low to high, got: ${code}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Duration notation (@N)
// ─────────────────────────────────────────────────────────────────────────────

describe("duration notation", () => {
  test("uses @N for held notes", () => {
    const input = {
      sourceName: "dur-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Melody",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            // Half note (2 seconds at 120 BPM, with 4 beats/bar, 1 beat = 0.5s)
            // That's 4 grid slots at 8th-note grid
            { name: "c4", midi: 60, time: 0, duration: 2, velocity: 0.8 },
            { name: "e4", midi: 64, time: 2, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 8 });
    const code = generatePatternDraft(analysis);

    // c4 held for 4 grid units should get @4
    assert.ok(
      code.includes("c4@"),
      `Should use @N for held notes, got: ${code}`,
    );
  });

  test("omits @1 (default duration)", () => {
    const input = {
      sourceName: "dur-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Melody",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.25, velocity: 0.8 },
            { name: "d4", midi: 62, time: 0.25, duration: 0.25, velocity: 0.8 },
            { name: "e4", midi: 64, time: 0.5, duration: 0.25, velocity: 0.8 },
            { name: "f4", midi: 65, time: 0.75, duration: 0.25, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 8 });
    const code = generatePatternDraft(analysis);

    // None of these notes should need @1
    assert.ok(!code.includes("@1"), `Should not include @1, got: ${code}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rest handling
// ─────────────────────────────────────────────────────────────────────────────

describe("rest handling", () => {
  test("generates ~ for silent grid positions", () => {
    const input = {
      sourceName: "rest-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Sparse",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            // Only one note at the start of bar 1
            { name: "c4", midi: 60, time: 0, duration: 0.25, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis);

    assert.ok(code.includes("~"), "Should contain rest symbols");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full pipeline: midiFileToPattern
// ─────────────────────────────────────────────────────────────────────────────

describe("midiFileToPattern()", () => {
  test("produces complete pattern file for test-midi.mid", () => {
    const buffer = loadFixture("test-midi.mid");
    const result = midiFileToPattern(buffer);

    assert.equal(result.name, "piano-template");
    assert.ok(
      result.code.includes("export default `"),
      "Should have export default",
    );
    assert.ok(result.code.includes("setcpm("), "Should contain setcpm");
    assert.ok(
      result.code.includes("// piano-template"),
      "Should have header comment",
    );
    assert.ok(
      result.code.includes("Piano Template"),
      "Should reference original name",
    );
  });

  test("header comment includes provenance metadata", () => {
    const buffer = loadFixture("test-midi.mid");
    const result = midiFileToPattern(buffer);

    assert.ok(
      result.code.includes("imported from MIDI"),
      "Should note import origin",
    );
    assert.ok(result.code.includes("3 tracks"), "Should note track count");
    assert.ok(result.code.includes("6/8"), "Should note time signature");
    assert.ok(result.code.includes("200 BPM"), "Should note tempo");
    assert.ok(result.code.includes("grid"), "Should note grid used");
  });

  test("respects patternName override", () => {
    const buffer = loadFixture("test-midi.mid");
    const result = midiFileToPattern(buffer, { patternName: "my-import" });

    assert.equal(result.name, "my-import");
    assert.ok(
      result.code.includes("// my-import"),
      "Should use custom name in header",
    );
  });

  test("sanitizes pattern name", () => {
    const buffer = loadFixture("test-midi.mid");
    const result = midiFileToPattern(buffer, {
      patternName: "My Song!! (Final Mix).mid",
    });

    assert.match(
      result.name,
      /^[a-z0-9_-]+$/,
      `Pattern name should be sanitized: "${result.name}"`,
    );
    // Should not contain .mid extension
    assert.ok(!result.name.includes(".mid"), "Should strip .mid extension");
  });

  test("returns warnings array", () => {
    const buffer = loadFixture("test-midi.mid");
    const result = midiFileToPattern(buffer);

    assert.ok(Array.isArray(result.warnings), "Should return warnings array");
  });

  test("returns analysis object", () => {
    const buffer = loadFixture("test-midi.mid");
    const result = midiFileToPattern(buffer);

    assert.ok(result.analysis, "Should return analysis object");
    assert.equal(result.analysis.tracks.length, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TranslationInput model isolation (codegen accepts model, not raw parser)
// ─────────────────────────────────────────────────────────────────────────────

describe("codegen accepts TranslationInput, not @tonejs/midi objects", () => {
  test("analyzeTranslationInput works with hand-built input", () => {
    const input = {
      sourceName: "synthetic",
      bpm: 140,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Lead",
          channel: 0,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
            { name: "e4", midi: 64, time: 0.5, duration: 0.5, velocity: 0.7 },
            { name: "g4", midi: 67, time: 1.0, duration: 0.5, velocity: 0.9 },
            { name: "c5", midi: 72, time: 1.5, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    assert.equal(analysis.name, "synthetic");
    assert.equal(analysis.bpm, 140);
    assert.equal(analysis.tracks.length, 1);
    assert.equal(analysis.tracks[0].strudelSound, "gm_piano");

    const code = generatePatternDraft(analysis);
    assert.ok(code.includes("setcpm(140/"), "Should set tempo");
    assert.ok(code.includes("note("), "Should use note()");
    assert.ok(code.includes("c4"), "Should contain note names");
  });

  test("future capture adapter can feed same model", () => {
    // Simulate what a capture adapter would produce
    const captureInput = {
      sourceName: "live-capture",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "MIDI Capture",
          channel: 0,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "c3", midi: 48, time: 0, duration: 0.4, velocity: 0.85 },
            { name: "eb3", midi: 51, time: 0.5, duration: 0.4, velocity: 0.75 },
            { name: "g3", midi: 55, time: 1.0, duration: 0.4, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(captureInput);
    const code = generatePatternDraft(analysis);

    assert.ok(code.includes("setcpm("), "Should generate valid pattern");
    assert.ok(code.includes("note("), "Should use note()");
    assert.ok(code.includes("eb3"), "Eb should appear as eb3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Simple 4/4 test case
// ─────────────────────────────────────────────────────────────────────────────

describe("simple 4/4 patterns", () => {
  test("four quarter notes in 4/4 produces clean bar", () => {
    const input = {
      sourceName: "simple-44",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Melody",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
            { name: "d4", midi: 62, time: 0.5, duration: 0.5, velocity: 0.8 },
            { name: "e4", midi: 64, time: 1.0, duration: 0.5, velocity: 0.8 },
            { name: "f4", midi: 65, time: 1.5, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis);

    // With 4 slots per bar and 4 quarter notes, should be "c4 d4 e4 f4"
    assert.ok(
      code.includes("c4 d4 e4 f4"),
      `Expected "c4 d4 e4 f4", got: ${code}`,
    );
  });

  test("two bars of 4/4 produce two cat entries", () => {
    const input = {
      sourceName: "two-bars",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Melody",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            // Bar 1: C D E F
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
            { name: "d4", midi: 62, time: 0.5, duration: 0.5, velocity: 0.8 },
            { name: "e4", midi: 64, time: 1.0, duration: 0.5, velocity: 0.8 },
            { name: "f4", midi: 65, time: 1.5, duration: 0.5, velocity: 0.8 },
            // Bar 2: G A B C
            { name: "g4", midi: 67, time: 2.0, duration: 0.5, velocity: 0.8 },
            { name: "a4", midi: 69, time: 2.5, duration: 0.5, velocity: 0.8 },
            { name: "b4", midi: 71, time: 3.0, duration: 0.5, velocity: 0.8 },
            { name: "c5", midi: 72, time: 3.5, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis);

    assert.ok(code.includes("c4 d4 e4 f4"), "Bar 1 should be c4 d4 e4 f4");
    assert.ok(code.includes("g4 a4 b4 c5"), "Bar 2 should be g4 a4 b4 c5");
    assert.ok(code.includes("cat("), "Should use cat() for bars");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("empty-ish MIDI (all tracks have 0 notes) still produces valid output", () => {
    const input = {
      sourceName: "empty",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [],
    };

    const analysis = analyzeTranslationInput(input);
    assert.equal(analysis.tracks.length, 0);

    const code = generatePatternDraft(analysis);
    assert.ok(code.includes("setcpm("), "Should still emit tempo");
  });

  test("single note produces a minimal pattern", () => {
    const input = {
      sourceName: "single-note",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "One Note",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    assert.ok(code.includes("c4"), "Should include the note");
    assert.ok(code.includes("note("), "Should use note()");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Repetition detection
// ─────────────────────────────────────────────────────────────────────────────

describe("repetition detection", () => {
  test("repeated bars produce const variables and cat references", () => {
    // A A B A pattern (4 bars, bar 1 and 2 identical, bar 4 = bar 1)
    const input = {
      sourceName: "repeat-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Melody",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            // Bar 1: C D E F
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
            { name: "d4", midi: 62, time: 0.5, duration: 0.5, velocity: 0.8 },
            { name: "e4", midi: 64, time: 1.0, duration: 0.5, velocity: 0.8 },
            { name: "f4", midi: 65, time: 1.5, duration: 0.5, velocity: 0.8 },
            // Bar 2: same as bar 1
            { name: "c4", midi: 60, time: 2.0, duration: 0.5, velocity: 0.8 },
            { name: "d4", midi: 62, time: 2.5, duration: 0.5, velocity: 0.8 },
            { name: "e4", midi: 64, time: 3.0, duration: 0.5, velocity: 0.8 },
            { name: "f4", midi: 65, time: 3.5, duration: 0.5, velocity: 0.8 },
            // Bar 3: G A B C
            { name: "g4", midi: 67, time: 4.0, duration: 0.5, velocity: 0.8 },
            { name: "a4", midi: 69, time: 4.5, duration: 0.5, velocity: 0.8 },
            { name: "b4", midi: 71, time: 5.0, duration: 0.5, velocity: 0.8 },
            { name: "c5", midi: 72, time: 5.5, duration: 0.5, velocity: 0.8 },
            // Bar 4: same as bar 1
            { name: "c4", midi: 60, time: 6.0, duration: 0.5, velocity: 0.8 },
            { name: "d4", midi: 62, time: 6.5, duration: 0.5, velocity: 0.8 },
            { name: "e4", midi: 64, time: 7.0, duration: 0.5, velocity: 0.8 },
            { name: "f4", midi: 65, time: 7.5, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis);

    // Should have const A = "c4 d4 e4 f4"
    assert.ok(
      code.includes('const A = "c4 d4 e4 f4"'),
      `Expected const A for repeated bar, got: ${code}`,
    );
    // Should have const B = "g4 a4 b4 c5"
    assert.ok(
      code.includes('const B = "g4 a4 b4 c5"'),
      `Expected const B for unique bar, got: ${code}`,
    );
    // Should have cat(A, A, B, A) sequence (with commas and bar comments)
    assert.ok(
      code.includes("A, // bar 1"),
      `Expected A at bar 1, got: ${code}`,
    );
    assert.ok(
      code.includes("A, // bar 2"),
      `Expected A at bar 2, got: ${code}`,
    );
    assert.ok(
      code.includes("B, // bar 3"),
      `Expected B at bar 3, got: ${code}`,
    );
    assert.ok(
      code.includes("A, // bar 4"),
      `Expected A at bar 4, got: ${code}`,
    );
  });

  test("no repetition when all bars are unique", () => {
    const input = {
      sourceName: "unique-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Melody",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            // Bar 1
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
            // Bar 2
            { name: "d4", midi: 62, time: 2.0, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis);

    // No const declarations for bar variables.
    assert.ok(
      !code.includes("const A"),
      `Should not extract consts when no bars repeat, got: ${code}`,
    );
    // Should still use inline strings.
    assert.ok(
      code.includes('"c4 ~@3"'),
      `Should have inline bar strings, got: ${code}`,
    );
  });

  test("drum tracks also get repetition detection", () => {
    const input = {
      sourceName: "drum-repeat",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Drums",
          channel: 9,
          isDrum: true,
          gmInstrument: "percussion",
          gmProgram: 0,
          notes: [
            // Bar 1: bd sd bd sd
            { name: "c2", midi: 36, time: 0, duration: 0.1, velocity: 0.9 },
            { name: "d2", midi: 38, time: 0.5, duration: 0.1, velocity: 0.8 },
            { name: "c2", midi: 36, time: 1.0, duration: 0.1, velocity: 0.9 },
            { name: "d2", midi: 38, time: 1.5, duration: 0.1, velocity: 0.8 },
            // Bar 2: same
            { name: "c2", midi: 36, time: 2.0, duration: 0.1, velocity: 0.9 },
            { name: "d2", midi: 38, time: 2.5, duration: 0.1, velocity: 0.8 },
            { name: "c2", midi: 36, time: 3.0, duration: 0.1, velocity: 0.9 },
            { name: "d2", midi: 38, time: 3.5, duration: 0.1, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis);

    assert.ok(
      code.includes('const A = "bd sd bd sd"'),
      `Expected drum repetition const, got: ${code}`,
    );
    assert.ok(
      code.includes("A, // bar 1"),
      `Expected A at bar 1, got: ${code}`,
    );
    assert.ok(
      code.includes("A, // bar 2"),
      `Expected A at bar 2, got: ${code}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Velocity preservation
// ─────────────────────────────────────────────────────────────────────────────

describe("velocity preservation", () => {
  test("generates .velocity() when variation is significant", () => {
    const input = {
      sourceName: "velocity-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.9 },
            { name: "d4", midi: 62, time: 0.5, duration: 0.5, velocity: 0.5 },
            { name: "e4", midi: 64, time: 1.0, duration: 0.5, velocity: 0.8 },
            { name: "f4", midi: 65, time: 1.5, duration: 0.5, velocity: 0.6 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis, { preserveVelocity: true });

    assert.ok(
      code.includes(".velocity("),
      `Expected .velocity() in output, got: ${code}`,
    );
    // Should contain velocity values
    assert.ok(
      code.includes("0.9") && code.includes("0.5"),
      `Expected velocity values 0.9 and 0.5, got: ${code}`,
    );
  });

  test("no .velocity() when variation is below threshold", () => {
    const input = {
      sourceName: "flat-velocity",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
            { name: "d4", midi: 62, time: 0.5, duration: 0.5, velocity: 0.85 },
            { name: "e4", midi: 64, time: 1.0, duration: 0.5, velocity: 0.82 },
            { name: "f4", midi: 65, time: 1.5, duration: 0.5, velocity: 0.78 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis, { preserveVelocity: true });

    assert.ok(
      !code.includes(".velocity("),
      `Should not emit .velocity() when variation < 0.2, got: ${code}`,
    );
  });

  test("preserveVelocity: false suppresses .velocity()", () => {
    const input = {
      sourceName: "vel-suppressed",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.9 },
            { name: "d4", midi: 62, time: 0.5, duration: 0.5, velocity: 0.4 },
            { name: "e4", midi: 64, time: 1.0, duration: 0.5, velocity: 0.8 },
            { name: "f4", midi: 65, time: 1.5, duration: 0.5, velocity: 0.3 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input, { gridSubdivision: 4 });
    const code = generatePatternDraft(analysis, { preserveVelocity: false });

    assert.ok(
      !code.includes(".velocity("),
      `Should not emit .velocity() when preserveVelocity is false, got: ${code}`,
    );
  });

  test("velocity warning only when preserveVelocity is false", () => {
    const input = {
      sourceName: "vel-warn",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.9 },
            { name: "d4", midi: 62, time: 0.5, duration: 0.5, velocity: 0.4 },
          ],
        },
      ],
    };

    // With velocity preservation on: no warning.
    const analysisOn = analyzeTranslationInput(input, {
      preserveVelocity: true,
    });
    assert.ok(
      !analysisOn.warnings.some((w) => w.includes("velocity variation")),
      "Should not warn about velocity when preserveVelocity is true",
    );

    // With velocity preservation off: warning present.
    const analysisOff = analyzeTranslationInput(input, {
      preserveVelocity: false,
    });
    assert.ok(
      analysisOff.warnings.some((w) => w.includes("velocity variation")),
      "Should warn about velocity when preserveVelocity is false",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sound overrides
// ─────────────────────────────────────────────────────────────────────────────

describe("sound overrides", () => {
  test("soundOverrides changes the .s() call in generated code", () => {
    const input = {
      sourceName: "override-test",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
            { name: "e4", midi: 64, time: 0.5, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis, {
      soundOverrides: { 0: "gm_epiano1" },
    });

    assert.ok(
      code.includes('.s("gm_epiano1")'),
      `Expected .s("gm_epiano1") override, got: ${code}`,
    );
    assert.ok(
      !code.includes('.s("gm_piano")'),
      `Should not contain original .s("gm_piano"), got: ${code}`,
    );
  });

  test("soundOverrides does not affect tracks without an override", () => {
    const input = {
      sourceName: "partial-override",
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: "Piano",
          channel: 0,
          isDrum: false,
          gmInstrument: "acoustic grand piano",
          gmProgram: 0,
          notes: [
            { name: "c4", midi: 60, time: 0, duration: 0.5, velocity: 0.8 },
          ],
        },
        {
          name: "Strings",
          channel: 1,
          isDrum: false,
          gmInstrument: "string ensemble 1",
          gmProgram: 48,
          notes: [
            { name: "g3", midi: 55, time: 0, duration: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };

    const analysis = analyzeTranslationInput(input);
    // Override only track 0 (Piano).
    const code = generatePatternDraft(analysis, {
      soundOverrides: { 0: "gm_harpsichord" },
    });

    assert.ok(
      code.includes('.s("gm_harpsichord")'),
      `Expected override for Piano, got: ${code}`,
    );
    assert.ok(
      code.includes('.s("gm_string_ensemble_1")'),
      `Expected unchanged Strings sound, got: ${code}`,
    );
  });

  test("soundOverrides via midiFileToPattern convenience", () => {
    const buffer = loadFixture("test-midi.mid");
    const result = midiFileToPattern(buffer, {
      soundOverrides: { 0: "gm_epiano2" },
    });

    assert.ok(
      result.patternBody.includes('.s("gm_epiano2")'),
      `Expected override in patternBody, got snippet: ${result.patternBody.slice(0, 200)}`,
    );
  });
});
