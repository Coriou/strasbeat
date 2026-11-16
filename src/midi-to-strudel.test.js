// Run with: pnpm test
//
// Tests for the shared MIDI → Strudel translation core. Uses test-midi.mid
// (the "Piano Template" — 6/8 at 200 BPM, 87 bars, 3 tracks) as the primary
// fixture. Other tests build synthetic TranslationInput objects to exercise
// the codegen in isolation, or assemble small Standard MIDI Files byte by
// byte (buildSmf below) to exercise the file reader.

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
  translationInputToPattern,
  detectDrumTrack,
  estimateBpmFromCapture,
  captureBufferToTranslationInput,
  midiToName,
  MAX_IMPORT_BARS,
} from "./midi-to-strudel.js";
import { readSmf, makeTicksToSeconds, dominantTempo } from "./midi-smf.js";
import { transpiler } from "./transpiler-patch.js";
import "@strudel/mini"; // register the minilang so the mini() rewrite resolves

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

// ─── Standard MIDI File builder ──────────────────────────────────────────
// Tracks are lists of { ticks, bytes } events in absolute ticks; buildSmf
// sorts them, writes delta times, and appends the end-of-track meta.

function varLen(n) {
  const out = [n & 0x7f];
  while ((n = Math.floor(n / 128)) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const metaEvent = (ticks, type, data) => ({
  ticks,
  bytes: [0xff, type, ...varLen(data.length), ...data],
});
const nameEvent = (text) =>
  metaEvent(0, 0x03, [...text].map((c) => c.charCodeAt(0)));
const tempoEvent = (ticks, bpm) => {
  const us = Math.round(60000000 / bpm);
  return metaEvent(ticks, 0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]);
};
const timeSigEvent = (ticks, num, denom) =>
  metaEvent(ticks, 0x58, [num, Math.log2(denom), 24, 8]);
const programEvent = (channel, program) => ({
  ticks: 0,
  bytes: [0xc0 | channel, program],
});
function noteEvents(channel, notes) {
  const events = [];
  for (const { midi, ticks, dur, vel = 100 } of notes) {
    events.push({ ticks, bytes: [0x90 | channel, midi, vel] });
    events.push({ ticks: ticks + dur, bytes: [0x80 | channel, midi, 0], off: true });
  }
  return events;
}
function buildSmf({ format = 1, ppq = 480, tracks }) {
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, ...u32be(6),
    0, format, 0, tracks.length, (ppq >> 8) & 255, ppq & 255,
  ]; // prettier-ignore
  for (const events of tracks) {
    // Stable by ticks; at the same tick note-offs go first.
    const sorted = events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.ticks - b.e.ticks || !!b.e.off - !!a.e.off || a.i - b.i)
      .map(({ e }) => e);
    const body = [];
    let last = 0;
    for (const e of sorted) {
      body.push(...varLen(e.ticks - last), ...e.bytes);
      last = e.ticks;
    }
    body.push(0, 0xff, 0x2f, 0);
    bytes.push(0x4d, 0x54, 0x72, 0x6b, ...u32be(body.length));
    for (const b of body) bytes.push(b); // (no spread: bodies can be huge)
  }
  return new Uint8Array(bytes).buffer;
}
/** One named track on one channel, as most DAWs export it. */
function simpleTrack({ name, channel = 0, program, notes }) {
  return [
    ...(name != null ? [nameEvent(name)] : []),
    ...(program != null ? [programEvent(channel, program)] : []),
    ...noteEvents(channel, notes),
  ];
}
/** `count` notes on consecutive beats, cycling through `pitches`. */
function beatNotes(pitches, count = pitches.length, ppq = 480) {
  return Array.from({ length: count }, (_, i) => ({
    midi: pitches[i % pitches.length],
    ticks: i * ppq,
    dur: ppq,
  }));
}

// Evaluate a generated pattern body with stand-ins for the Strudel globals
// it calls. Catches what a syntax check cannot: a `const note = note(…)`
// parses, then throws on its own temporal dead zone.
function evaluateDraft(body) {
  const chain = () =>
    new Proxy(function () {}, {
      get: () => chain(),
      apply: () => chain(),
    });
  new Function("note", "s", "cat", "setcpm", body)(
    chain(),
    chain(),
    chain(),
    chain(),
  );
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
    const input = parseMidiFile(
      buildSmf({
        tracks: [
          [tempoEvent(0, 120)],
          simpleTrack({ name: "Lead", notes: beatNotes([72, 74]) }),
          simpleTrack({ name: "Muted", notes: [] }),
        ],
      }),
    );

    assert.equal(input.tracks.length, 2);
    assert.equal(input.tracks[1].name, "Muted");
    assert.equal(input.tracks[1].notes.length, 0);
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

    // Track 2: Staff-1, strings, 195 notes. Its program change comes after
    // a few controller events; the name and the notes stay on one track.
    assert.equal(input.tracks.length, 3);
    assert.equal(input.tracks[2].name, "Staff-1");
    assert.equal(input.tracks[2].notes.length, 195);
    assert.equal(input.tracks[2].gmProgram, 48);
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
    const analysis = analyzeTranslationInput(input, { trackIndices: [0, 2] });

    assert.equal(analysis.tracks.length, 2);
    assert.equal(analysis.tracks[0].name, "Right Hand");
    assert.equal(analysis.tracks[1].name, "Staff-1");
  });

  test("drops empty tracks during analysis by default", () => {
    const input = parseMidiFile(
      buildSmf({
        tracks: [
          [tempoEvent(0, 120)],
          simpleTrack({ name: "Lead", notes: beatNotes([72, 74]) }),
          simpleTrack({ name: "Muted", notes: [] }),
        ],
      }),
    );
    const analysis = analyzeTranslationInput(input);

    assert.equal(analysis.tracks.length, 1);
    assert.ok(!analysis.tracks.some((track) => track.name === "Muted"));
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

describe("codegen accepts TranslationInput, not parser objects", () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// midiToName
// ─────────────────────────────────────────────────────────────────────────────

describe("midiToName", () => {
  test("converts middle C", () => {
    assert.equal(midiToName(60), "c4");
  });

  test("converts sharps and flats", () => {
    assert.equal(midiToName(61), "c#4");
    assert.equal(midiToName(63), "eb4");
    assert.equal(midiToName(66), "f#4");
    assert.equal(midiToName(70), "bb4");
  });

  test("handles octave boundaries", () => {
    assert.equal(midiToName(0), "c-1");
    assert.equal(midiToName(12), "c0");
    assert.equal(midiToName(127), "g9");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Capture adapter
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateBpmFromCapture", () => {
  test("returns 120 for fewer than 2 events", () => {
    assert.equal(estimateBpmFromCapture([]), 120);
    assert.equal(estimateBpmFromCapture([{ time: 0 }]), 120);
  });

  test("estimates 120 BPM from 8th-note intervals (0.25s)", () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ time: i * 0.25 }));
    assert.equal(estimateBpmFromCapture(events), 120);
  });

  test("estimates 100 BPM from 8th-note intervals (0.3s)", () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ time: i * 0.3 }));
    assert.equal(estimateBpmFromCapture(events), 100);
  });

  test("estimates BPM from quarter-note intervals when 8th is out of range", () => {
    // 0.4s gaps → 8th-note interpretation gives 75 BPM (in range), so it uses that
    // 0.8s gaps → 8th gives 37.5 (too slow), quarter gives 75
    const events = Array.from({ length: 5 }, (_, i) => ({ time: i * 0.8 }));
    assert.equal(estimateBpmFromCapture(events), 75);
  });

  test("ignores chord events (near-simultaneous)", () => {
    // Main notes at 0.25s apart (120 BPM 8th notes) with chord stacking
    const events = [
      { time: 0 },
      { time: 0.02 }, // chord
      { time: 0.25 },
      { time: 0.27 }, // chord
      { time: 0.5 },
      { time: 0.52 }, // chord
      { time: 0.75 },
      { time: 1.0 },
    ];
    assert.equal(estimateBpmFromCapture(events), 120);
  });

  test("falls back to 120 for very fast or very slow events", () => {
    // 0.01s gaps → all interpretations > 200
    const fast = Array.from({ length: 5 }, (_, i) => ({ time: i * 0.01 }));
    assert.equal(estimateBpmFromCapture(fast), 120);
  });
});

describe("captureBufferToTranslationInput", () => {
  test("returns valid TranslationInput for simple sequence", () => {
    const events = [
      { midi: 60, velocity: 0.8, time: 0 },
      { midi: 64, velocity: 0.7, time: 0.25 },
      { midi: 67, velocity: 0.9, time: 0.5 },
      { midi: 72, velocity: 0.6, time: 0.75 },
    ];
    const input = captureBufferToTranslationInput(events);

    assert.equal(input.tracks.length, 1);
    assert.equal(input.tracks[0].isDrum, false);
    assert.equal(input.tracks[0].notes.length, 4);
    assert.deepStrictEqual(input.timeSignature, [4, 4]);
    assert.equal(input.hasTempoChanges, false);
    assert.equal(input.hasTimeSigChanges, false);
  });

  test("uses note names instead of MIDI numbers", () => {
    const events = [
      { midi: 60, velocity: 0.8, time: 0 },
      { midi: 64, velocity: 0.7, time: 0.5 },
    ];
    const input = captureBufferToTranslationInput(events);

    assert.equal(input.tracks[0].notes[0].name, "c4");
    assert.equal(input.tracks[0].notes[1].name, "e4");
  });

  test("infers duration from gap to next note", () => {
    const events = [
      { midi: 60, velocity: 0.8, time: 0 },
      { midi: 64, velocity: 0.7, time: 0.3 },
      { midi: 67, velocity: 0.9, time: 0.8 },
    ];
    const input = captureBufferToTranslationInput(events);
    const notes = input.tracks[0].notes;

    assert.equal(notes[0].duration, 0.3);
    assert.equal(notes[1].duration, 0.5);
    // Last note gets fallback duration (median IOI)
    assert.ok(notes[2].duration > 0);
  });

  test("groups near-simultaneous events as chords", () => {
    const events = [
      { midi: 60, velocity: 0.8, time: 0 },
      { midi: 64, velocity: 0.7, time: 0.02 }, // chord with previous
      { midi: 67, velocity: 0.9, time: 0.5 },
    ];
    const input = captureBufferToTranslationInput(events);
    const notes = input.tracks[0].notes;

    // Both chord notes share the same duration (gap to next group)
    assert.equal(notes[0].duration, 0.5);
    assert.equal(notes[1].duration, 0.5);
  });

  test("preserves velocity values", () => {
    const events = [
      { midi: 60, velocity: 0.4, time: 0 },
      { midi: 64, velocity: 0.9, time: 0.25 },
    ];
    const input = captureBufferToTranslationInput(events);

    assert.equal(input.tracks[0].notes[0].velocity, 0.4);
    assert.equal(input.tracks[0].notes[1].velocity, 0.9);
  });

  test("passes presetName into track and sourceName", () => {
    const events = [{ midi: 60, velocity: 0.8, time: 0 }];
    const input = captureBufferToTranslationInput(events, {
      presetName: "piano",
    });

    assert.equal(input.sourceName, "captured-piano");
    assert.equal(input.tracks[0].name, "piano");
  });

  test("estimates BPM and produces valid analysis", () => {
    // 8 notes at 0.25s intervals → 120 BPM 8th notes
    const events = Array.from({ length: 8 }, (_, i) => ({
      midi: 60 + (i % 4),
      velocity: 0.8,
      time: i * 0.25,
    }));
    const input = captureBufferToTranslationInput(events);
    assert.equal(input.bpm, 120);

    const analysis = analyzeTranslationInput(input);
    assert.equal(analysis.bpm, 120);
    assert.ok(analysis.tracks.length === 1);
    assert.ok(analysis.totalBars >= 1);
  });

  test("full pipeline produces valid pattern code", () => {
    // C major arpeggio, 8th notes at 120 BPM
    const events = [
      { midi: 60, velocity: 0.8, time: 0 },
      { midi: 64, velocity: 0.7, time: 0.25 },
      { midi: 67, velocity: 0.9, time: 0.5 },
      { midi: 72, velocity: 0.8, time: 0.75 },
      { midi: 60, velocity: 0.8, time: 1.0 },
      { midi: 64, velocity: 0.7, time: 1.25 },
      { midi: 67, velocity: 0.9, time: 1.5 },
      { midi: 72, velocity: 0.8, time: 1.75 },
    ];
    const input = captureBufferToTranslationInput(events, {
      sound: "gm_piano",
      presetName: "piano",
    });
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis, {
      soundOverrides: { 0: "gm_piano" },
    });

    // Should use note names, not MIDI numbers
    assert.ok(code.includes("c4"), `Expected c4 in output: ${code}`);
    assert.ok(!code.includes(" 60"), `Expected no MIDI number 60 in output: ${code}`);

    // Should have setcpm
    assert.ok(code.includes("setcpm("), `Expected setcpm in output: ${code}`);

    // Should use the sound override
    assert.ok(
      code.includes('.s("gm_piano")'),
      `Expected .s("gm_piano") in output: ${code}`,
    );

    // Should have note() call (melodic track)
    assert.ok(code.includes("note("), `Expected note() in output: ${code}`);
  });

  test("repetition detection works on repeated capture phrases", () => {
    // Two identical bars of C-E-G-C at 120 BPM
    const bar = [
      { midi: 60, velocity: 0.8 },
      { midi: 64, velocity: 0.8 },
      { midi: 67, velocity: 0.8 },
      { midi: 72, velocity: 0.8 },
    ];
    const events = [];
    for (let rep = 0; rep < 4; rep++) {
      for (let i = 0; i < bar.length; i++) {
        events.push({
          midi: bar[i].midi,
          velocity: bar[i].velocity,
          time: rep * 1.0 + i * 0.25,
        });
      }
    }
    const input = captureBufferToTranslationInput(events);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    // With 4 identical bars, repetition detection should fire — look for const
    assert.ok(
      code.includes("const A"),
      `Expected repetition variable in output: ${code}`,
    );
  });

  test("single note capture produces valid output", () => {
    const events = [{ midi: 60, velocity: 0.8, time: 0 }];
    const input = captureBufferToTranslationInput(events);
    const analysis = analyzeTranslationInput(input);
    const code = generatePatternDraft(analysis);

    assert.ok(code.includes("c4"), `Expected c4: ${code}`);
    assert.ok(code.includes("setcpm("), `Expected setcpm: ${code}`);
  });

  test("varying velocity is preserved through pipeline", () => {
    const events = [
      { midi: 60, velocity: 0.3, time: 0 },
      { midi: 64, velocity: 0.9, time: 0.25 },
      { midi: 60, velocity: 0.3, time: 0.5 },
      { midi: 64, velocity: 0.9, time: 0.75 },
    ];
    const input = captureBufferToTranslationInput(events);
    const analysis = analyzeTranslationInput(input);

    // The track should detect velocity variation
    assert.ok(
      analysis.tracks[0].hasVelocityVariation,
      "Expected velocity variation to be detected",
    );

    const code = generatePatternDraft(analysis, { preserveVelocity: true });
    assert.ok(
      code.includes(".velocity("),
      `Expected .velocity() in output: ${code}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Standard MIDI File reader
// ─────────────────────────────────────────────────────────────────────────────

describe("readSmf()", () => {
  test("reads header, tempo map, names, programs and notes", () => {
    const smf = readSmf(
      buildSmf({
        ppq: 96,
        tracks: [
          [nameEvent("Song"), tempoEvent(0, 100), timeSigEvent(0, 3, 4)],
          simpleTrack({
            name: "Lead",
            channel: 2,
            program: 73,
            notes: [
              { midi: 60, ticks: 0, dur: 96, vel: 127 },
              { midi: 64, ticks: 96, dur: 48, vel: 64 },
            ],
          }),
        ],
      }),
    );

    assert.equal(smf.ppq, 96);
    assert.equal(smf.name, "Song");
    assert.deepEqual(smf.tempos, [{ ticks: 0, bpm: 100 }]);
    assert.deepEqual(smf.timeSignatures, [{ ticks: 0, timeSignature: [3, 4] }]);
    // the note-less conductor track of a format-1 file is not a track to import
    assert.equal(smf.tracks.length, 1);
    const [lead] = smf.tracks;
    assert.equal(lead.name, "Lead");
    assert.equal(lead.channel, 2);
    assert.equal(lead.program, 73);
    assert.deepEqual(lead.notes, [
      { midi: 60, ticks: 0, durationTicks: 96, velocity: 1 },
      { midi: 64, ticks: 96, durationTicks: 48, velocity: 64 / 127 },
    ]);
  });

  test("understands running status and note-on with velocity 0 as note-off", () => {
    // One MTrk: 0x90 status once, then data bytes only.
    const body = [
      0, 0x90, 60, 100, // on C4
      0x60, 60, 0, //      +96: off (velocity 0), running status
      0, 62, 100, //       on D4, running status
      0x60, 62, 0, //      +96: off
      0, 0xff, 0x2f, 0,
    ]; // prettier-ignore
    const bytes = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
      0x4d, 0x54, 0x72, 0x6b, ...u32be(body.length), ...body,
    ]); // prettier-ignore
    const smf = readSmf(bytes.buffer);

    assert.deepEqual(
      smf.tracks[0].notes.map((n) => [n.midi, n.ticks, n.durationTicks]),
      [
        [60, 0, 96],
        [62, 96, 96],
      ],
    );
  });

  test("splits a single-track (format 0) file into one track per channel", () => {
    const smf = readSmf(
      buildSmf({
        format: 0,
        tracks: [
          [
            nameEvent("Band"),
            programEvent(0, 33),
            ...noteEvents(0, beatNotes([40, 43])),
            ...noteEvents(9, beatNotes([36, 38])),
          ],
        ],
      }),
    );

    assert.deepEqual(
      smf.tracks.map((t) => [t.name, t.channel, t.program, t.notes.length]),
      [
        ["Band ch1", 0, 33, 2],
        ["Band ch10", 9, 0, 2],
      ],
    );
  });

  test("a note-on without a note-off rings to the end of the track", () => {
    const smf = readSmf(
      buildSmf({
        format: 0,
        tracks: [
          [
            { ticks: 0, bytes: [0x90, 60, 100] },
            ...noteEvents(0, [{ midi: 64, ticks: 480, dur: 480 }]),
          ],
        ],
      }),
    );
    const hanging = smf.tracks[0].notes.find((n) => n.midi === 60);
    assert.equal(hanging.durationTicks, 960);
  });

  test("re-struck notes pair first-on with first-off", () => {
    const smf = readSmf(
      buildSmf({
        format: 0,
        tracks: [
          [
            { ticks: 0, bytes: [0x90, 60, 100] },
            { ticks: 100, bytes: [0x90, 60, 100] },
            { ticks: 200, bytes: [0x80, 60, 0] },
            { ticks: 300, bytes: [0x80, 60, 0] },
          ],
        ],
      }),
    );
    assert.deepEqual(
      smf.tracks[0].notes.map((n) => [n.ticks, n.durationTicks]),
      [
        [0, 200],
        [100, 200],
      ],
    );
  });

  test("skips SysEx and escape events without shifting what follows", () => {
    // The usual first event of a GM file: F0 <len> 7E 7F 09 01 F7.
    const gmReset = { ticks: 0, bytes: [0xf0, 5, 0x7e, 0x7f, 0x09, 0x01, 0xf7] };
    const escape = { ticks: 0, bytes: [0xf7, 2, 0x01, 0x02] };
    const smf = readSmf(
      buildSmf({
        format: 0,
        tracks: [
          [
            gmReset,
            escape,
            ...noteEvents(0, [
              { midi: 60, ticks: 0, dur: 480 },
              { midi: 62, ticks: 480, dur: 480 },
            ]),
          ],
        ],
      }),
    );
    assert.deepEqual(
      smf.tracks[0].notes.map((n) => [n.midi, n.ticks, n.durationTicks]),
      [
        [60, 0, 480],
        [62, 480, 480],
      ],
    );
  });

  test("keeps notes whose on and off share a tick", () => {
    const smf = readSmf(
      buildSmf({
        format: 0,
        tracks: [
          [
            { ticks: 0, bytes: [0x99, 36, 100] },
            { ticks: 0, bytes: [0x89, 36, 0] },
            { ticks: 480, bytes: [0x99, 38, 100] },
            { ticks: 480, bytes: [0x99, 38, 0] },
          ],
        ],
      }),
    );
    assert.deepEqual(
      smf.tracks[0].notes.map((n) => [n.midi, n.ticks, n.durationTicks]),
      [
        [36, 0, 1],
        [38, 480, 1],
      ],
    );
  });

  test("a track of unterminated note-ons stays linear", () => {
    const events = [];
    for (let i = 0; i < 40000; i++) events.push({ ticks: i, bytes: [0x90, 60, 100] });
    const started = performance.now();
    const smf = readSmf(buildSmf({ format: 0, tracks: [events] }));
    assert.equal(smf.tracks[0].notes.length, 40000);
    assert.ok(performance.now() - started < 3000);
  });

  test("strips control characters from track names", () => {
    const smf = readSmf(
      buildSmf({
        format: 0,
        tracks: [[nameEvent("Lead\nalert(1)"), ...noteEvents(0, [{ midi: 60, ticks: 0, dur: 96 }])]],
      }),
    );
    assert.equal(smf.tracks[0].name, "Lead alert(1)");
  });

  test("rejects non-MIDI input with a readable message", () => {
    for (const bytes of [[], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]]) {
      assert.throws(
        () => readSmf(new Uint8Array(bytes).buffer),
        (err) => err instanceof Error && /not a Standard MIDI File/.test(err.message),
      );
    }
    // header only, no track chunks
    assert.throws(
      () => readSmf(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 1, 0xe0]).buffer),
      /no tracks/,
    );
    // SMPTE time division
    assert.throws(
      () => readSmf(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0xe7, 40]).buffer),
      /SMPTE/,
    );
  });

  test("reads a truncated file as far as it goes", () => {
    const full = new Uint8Array(
      buildSmf({
        format: 0,
        tracks: [noteEvents(0, beatNotes([60, 62, 64, 65], 40))],
      }),
    );
    const smf = readSmf(full.slice(0, full.length - 60).buffer);
    assert.ok(smf.tracks[0].notes.length > 20);
    assert.ok(smf.tracks[0].notes.length < 40);
    assert.equal(smf.truncated, true);
    assert.equal(readSmf(full.buffer).truncated, false);
  });

  test("makeTicksToSeconds follows the tempo map", () => {
    const toSeconds = makeTicksToSeconds(
      [
        { ticks: 0, bpm: 120 },
        { ticks: 1920, bpm: 60 },
      ],
      480,
    );
    assert.equal(toSeconds(0), 0);
    assert.equal(toSeconds(480), 0.5);
    assert.equal(toSeconds(1920), 2);
    assert.equal(toSeconds(2400), 3);
    // no tempo events at all → the MIDI default of 120 BPM
    assert.equal(makeTicksToSeconds([], 480)(960), 1);
  });

  test("dominantTempo picks the tempo most of the music plays at", () => {
    // a one-beat count-in at 60, then the song at 140
    assert.equal(
      dominantTempo(
        [
          { ticks: 0, bpm: 60 },
          { ticks: 480, bpm: 140 },
        ],
        480 * 64,
      ),
      140,
    );
    // a final ritardando does not decide the tempo
    assert.equal(
      dominantTempo(
        [
          { ticks: 0, bpm: 120 },
          { ticks: 480 * 60, bpm: 90 },
          { ticks: 480 * 62, bpm: 70 },
        ],
        480 * 64,
      ),
      120,
    );
    assert.equal(dominantTempo([], 1000), 120);
    assert.equal(dominantTempo([{ ticks: 0, bpm: 97 }], 0), 97);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drum-track detection
// ─────────────────────────────────────────────────────────────────────────────

describe("drum-track detection", () => {
  const parseOne = (track) =>
    parseMidiFile(buildSmf({ tracks: [[tempoEvent(0, 120)], simpleTrack(track)] }))
      .tracks[0];

  test("a bass line inside the GM drum-key range stays melodic", () => {
    // finger bass on channel 2: E2 G2 A2 B2 E2 G2 A2 D3 — all GM drum keys
    const track = parseOne({
      name: "Bass",
      channel: 1,
      program: 33,
      notes: beatNotes([40, 43, 45, 47, 40, 43, 45, 50]),
    });
    assert.equal(track.isDrum, false);
    assert.equal(track.gmProgram, 33);

    const { patternBody } = midiFileToPattern(
      buildSmf({
        tracks: [
          [tempoEvent(0, 120)],
          simpleTrack({
            name: "Bass",
            channel: 1,
            program: 33,
            notes: beatNotes([40, 43, 45, 47, 40, 43, 45, 50]),
          }),
        ],
      }),
    );
    assert.match(patternBody, /const bass = note\(/);
    assert.match(patternBody, /"e2 g2 a2 b2"/);
    assert.doesNotMatch(patternBody, /\bsd\b|\blt\b/);
  });

  test("a flute melody on C4–F4 stays melodic", () => {
    const track = parseOne({
      name: "Melody",
      channel: 0,
      program: 73,
      notes: beatNotes([60, 62, 64, 65, 64, 62, 60, 62]),
    });
    assert.equal(track.isDrum, false);
  });

  test("a piano part with no program change is not drums just for its range", () => {
    // program 0, no name hint, pitches all inside the drum-key range but
    // not a kick + snare + hat spelling
    const track = parseOne({
      name: "Left Hand",
      notes: beatNotes([48, 52, 55, 52, 48, 52, 57, 52]),
    });
    assert.equal(track.isDrum, false);
  });

  test("channel 10 is drums whatever it is called", () => {
    const track = parseOne({
      name: "Track 7",
      channel: 9,
      notes: beatNotes([36, 42, 38, 42]),
    });
    assert.equal(track.isDrum, true);
  });

  test("off-channel drums still detected from a drum name or a kick/snare/hat kit", () => {
    assert.equal(
      parseOne({ name: "Drums", notes: beatNotes([36, 36, 38, 36]) }).isDrum,
      true,
    );
    assert.equal(
      parseOne({ name: "MIDI 03", notes: beatNotes([36, 42, 38, 42]) }).isDrum,
      true,
    );
    // …but not once the track has a melodic program assigned
    assert.equal(
      parseOne({ name: "Drums", program: 30, notes: beatNotes([36, 42, 38, 42]) })
        .isDrum,
      false,
    );
  });

  test("detectDrumTrack needs every pitch to be a GM drum key", () => {
    assert.equal(
      detectDrumTrack({
        name: "Drum Machine",
        channel: 0,
        program: 0,
        notes: [{ midi: 36 }, { midi: 38 }, { midi: 100 }],
      }),
      false,
    );
  });

  test("drumOverrides flips a track either way", () => {
    const input = parseMidiFile(
      buildSmf({
        tracks: [
          [tempoEvent(0, 120)],
          simpleTrack({ name: "Perc", channel: 9, notes: beatNotes([36, 42, 38, 42]) }),
          simpleTrack({ name: "Keys", channel: 1, program: 4, notes: beatNotes([36, 42, 38, 42]) }),
        ],
      }),
    );
    assert.deepEqual(
      input.tracks.map((t) => t.isDrum),
      [true, false],
    );

    const flipped = analyzeTranslationInput(input, {
      drumOverrides: { 0: false, 1: true },
    });
    assert.equal(flipped.tracks[0].isDrum, false);
    assert.ok(flipped.tracks[0].strudelSound, "melodic track needs a sound");
    assert.equal(flipped.tracks[1].isDrum, true);
    assert.equal(flipped.tracks[1].strudelSound, null);

    const code = generatePatternDraft(flipped);
    assert.match(code, /const perc = note\(/);
    assert.match(code, /const keys = s\(/);
    assert.match(code, /"bd hh sd hh"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tempo maps
// ─────────────────────────────────────────────────────────────────────────────

describe("files with tempo changes", () => {
  // 16 quarter notes on consecutive beats; the tempo drops at bar 2.
  const buffer = buildSmf({
    tracks: [
      [tempoEvent(0, 120), tempoEvent(480 * 4, 90)],
      simpleTrack({
        name: "Lead",
        program: 80,
        notes: beatNotes([72, 73, 74, 75], 16),
      }),
    ],
  });

  test("rhythm is quantised from ticks, not from seconds at the first tempo", () => {
    const result = midiFileToPattern(buffer);

    assert.equal(result.analysis.totalBars, 4);
    assert.equal(result.analysis.gridSubdivision, 4);
    assert.match(result.patternBody, /const A = "c5 c#5 d5 eb5"/);
    assert.doesNotMatch(result.patternBody, /@/);
    assert.equal(result.analysis.tracks[0].quantizationAccuracy, 1);
  });

  test("the pattern plays at the tempo most of the file uses, and says so", () => {
    const input = parseMidiFile(buffer);
    assert.equal(input.hasTempoChanges, true);
    assert.equal(input.bpm, 90);

    const result = midiFileToPattern(buffer);
    assert.match(result.patternBody, /^setcpm\(90\/4\)/);
    assert.ok(
      result.warnings.some((w) => /Tempo changes/.test(w) && /90 BPM/.test(w)),
      `expected a tempo warning, got ${JSON.stringify(result.warnings)}`,
    );
  });

  test("a repeated identical tempo event is not a tempo change", () => {
    const input = parseMidiFile(
      buildSmf({
        tracks: [
          [tempoEvent(0, 120), tempoEvent(480 * 4, 120)],
          simpleTrack({ name: "Lead", notes: beatNotes([72, 74], 8) }),
        ],
      }),
    );
    assert.equal(input.hasTempoChanges, false);
  });

  test("seconds still follow the tempo map", () => {
    const { notes } = parseMidiFile(buffer).tracks[0];
    assert.equal(notes[4].time, 2); // bar 2 starts after 4 beats at 120
    // (tempo is stored as whole microseconds per beat, hence the tolerance)
    assert.ok(Math.abs(notes[5].time - (2 + 60 / 90)) < 1e-5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Track identifiers
// ─────────────────────────────────────────────────────────────────────────────

describe("track identifiers", () => {
  const fileWithTracks = (names) =>
    buildSmf({
      tracks: [
        [tempoEvent(0, 120)],
        ...names.map((name, i) =>
          simpleTrack({
            name,
            channel: i % 8,
            program: 80,
            notes: beatNotes([72, 84, 90, 96]),
          }),
        ),
      ],
    });
  const identifiersFor = (names) =>
    midiFileToPattern(fileWithTracks(names)).analysis.tracks.map(
      (t) => t.identifier,
    );

  test("reserved words and Strudel globals never become the const name", () => {
    assert.deepEqual(
      identifiersFor(["Default", "New", "class", "Note", "S", "N", "Cat", "Sound", "Stack", "Setcpm"]),
      ["defaultTrack", "newTrack", "classTrack", "noteTrack", "sTrack", "nTrack", "catTrack", "soundTrack", "stackTrack", "setcpmTrack"],
    );
  });

  test("leading digits, symbols-only and empty names get a usable name", () => {
    assert.deepEqual(identifiersFor(["808 Kit", "!?!", "", "   "]), [
      "track808Kit",
      "track",
      "track3",
      "track4",
    ]);
  });

  test("duplicates stay unique, including after the reserved-word suffix", () => {
    assert.deepEqual(identifiersFor(["Note", "note", "Note Track", "Lead", "Lead"]), [
      "noteTrack",
      "noteTrack2",
      "noteTrack3",
      "lead",
      "lead2",
    ]);
  });

  test("generated code evaluates for every awkward track name", () => {
    const names = ["Default", "Note", "S", "Cat", "New", "class", "Setcpm", "808", "", "Lead", "Lead"];
    const { patternBody } = midiFileToPattern(fileWithTracks(names));
    assert.doesNotThrow(() => evaluateDraft(patternBody), patternBody);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Generated code is valid Strudel source
// ─────────────────────────────────────────────────────────────────────────────

describe("generated patterns transpile", () => {
  const transpiles = (body) =>
    assert.doesNotThrow(
      () => transpiler(body, { wrapAsync: true, addReturn: true }),
      body,
    );

  test("test-midi.mid", () => {
    const { patternBody } = midiFileToPattern(loadFixture("test-midi.mid"));
    transpiles(patternBody);
    assert.doesNotThrow(() => evaluateDraft(patternBody));
  });

  test("drums + melodic + velocity dynamics + awkward names", () => {
    const { patternBody } = midiFileToPattern(
      buildSmf({
        tracks: [
          [tempoEvent(0, 96), timeSigEvent(0, 3, 4)],
          simpleTrack({
            name: "Default",
            program: 4,
            notes: beatNotes([60, 64, 67], 12).map((n, i) => ({
              ...n,
              vel: i % 2 ? 40 : 120,
            })),
          }),
          simpleTrack({
            name: "Note",
            channel: 9,
            notes: beatNotes([36, 42, 38], 12).map((n, i) => ({
              ...n,
              vel: i % 3 ? 50 : 127,
            })),
          }),
          simpleTrack({
            name: "s",
            channel: 2,
            program: 48,
            notes: [
              { midi: 48, ticks: 0, dur: 1440 },
              { midi: 55, ticks: 0, dur: 1440 },
              { midi: 64, ticks: 0, dur: 1440 },
            ],
          }),
        ],
      }),
    );
    transpiles(patternBody);
    assert.doesNotThrow(() => evaluateDraft(patternBody), patternBody);
    // PATTERN-STYLE: setcpm, named labelled layers, note names
    assert.match(patternBody, /^setcpm\(96\/3\)/);
    assert.match(patternBody, /^defaultTrack: defaultTrack$/m);
    assert.match(patternBody, /^noteTrack: noteTrack$/m);
  });

  test("live capture output (melodic and drum-pad)", () => {
    const events = [36, 42, 38, 42, 36, 42, 38, 42].map((midi, i) => ({
      midi,
      velocity: 0.8,
      time: i * 0.25,
    }));
    for (const options of [
      { presetName: "epiano" },
      { presetName: "drums", drumMap: { 36: "bd", 38: "sd", 42: "hh" } },
    ]) {
      const analysis = analyzeTranslationInput(
        captureBufferToTranslationInput(events, options),
      );
      transpiles(generatePatternDraft(analysis, { soundOverrides: { 0: "gm_epiano1" } }));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Large files
// ─────────────────────────────────────────────────────────────────────────────

describe("large files", () => {
  test("a 20 000-note single track imports in linear time", () => {
    const N = 20000;
    const notes = Array.from({ length: N }, (_, i) => ({
      midi: 20 + ((i * 7) % 90),
      ticks: i * 60,
      dur: 55,
      vel: 10 + ((i * 13) % 110),
    }));
    const buffer = buildSmf({
      tracks: [[tempoEvent(0, 120)], simpleTrack({ name: "Piano", notes })],
    });

    // Warm-up on a small file so JIT/first-call costs are not what is timed.
    midiFileToPattern(
      buildSmf({ tracks: [[tempoEvent(0, 120)], simpleTrack({ name: "w", notes: notes.slice(0, 200) })] }),
    );

    // Best of three, so a busy machine does not fail the test.
    let result;
    let elapsed = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      result = midiFileToPattern(buffer);
      elapsed = Math.min(elapsed, performance.now() - t0);
    }

    assert.equal(result.analysis.tracks[0].noteCount, N);
    assert.equal(result.analysis.totalBars, (N * 60) / (480 * 4));
    // Linear work: ~100 ms on an idle machine. The bound is generous for a
    // loaded CI box; the quadratic note pairing this guards against took
    // ~8 s for the same file.
    assert.ok(elapsed < 2000, `import took ${Math.round(elapsed)} ms`);
  });

  test("a pre-parsed input generates the same pattern without re-parsing", () => {
    const buffer = loadFixture("test-midi.mid");
    const options = { patternName: "x", trackIndices: [0, 2], gridSubdivision: 12 };
    const fromBuffer = midiFileToPattern(buffer, options);
    const fromInput = translationInputToPattern(parseMidiFile(buffer), options);
    assert.equal(fromInput.code, fromBuffer.code);
    assert.equal(fromInput.name, "x");
  });

  test("repeated-bar const names never collide, however many there are", () => {
    // 1500 bars alternating so every distinct bar repeats once → 750 consts,
    // past the 702 one- and two-letter names.
    const bars = 1500;
    const notes = [];
    for (let bar = 0; bar < bars; bar++) {
      const variant = Math.floor(bar / 2);
      notes.push({
        name: midiToName(24 + (variant % 60)),
        midi: 24 + (variant % 60),
        time: bar * 2,
        duration: 0.5 + (Math.floor(variant / 60) % 3) * 0.5,
        velocity: 0.8,
      });
      notes.push({
        name: midiToName(30 + (Math.floor(variant / 180) % 60)),
        midi: 30 + (Math.floor(variant / 180) % 60),
        time: bar * 2 + 1.5,
        duration: 0.5,
        velocity: 0.8,
      });
    }
    const code = generatePatternDraft(
      analyzeTranslationInput({
        sourceName: "long",
        bpm: 120,
        timeSignature: [4, 4],
        tracks: [{ name: "Lead", channel: 0, isDrum: false, gmProgram: 0, notes }],
      }),
    );
    const names = [...code.matchAll(/^const ([A-Z]+) = "/gm)].map((m) => m[1]);
    assert.ok(names.length > 702, `expected > 702 consts, got ${names.length}`);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("AAA"));
  });

  test("a file spanning an absurd number of bars is refused with a clear message", () => {
    const buffer = buildSmf({
      tracks: [
        [tempoEvent(0, 120)],
        simpleTrack({
          name: "x",
          notes: [
            { midi: 60, ticks: 0, dur: 240 },
            { midi: 62, ticks: 480 * 4 * (MAX_IMPORT_BARS + 50), dur: 240 },
          ],
        }),
      ],
    });
    assert.throws(() => midiFileToPattern(buffer), /too long to import/);
  });

  test("chords wider than six notes are clipped with a warning", () => {
    const { warnings, patternBody } = midiFileToPattern(
      buildSmf({
        tracks: [
          [tempoEvent(0, 120)],
          simpleTrack({
            name: "Cluster",
            notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi) => ({
              midi,
              ticks: 0,
              dur: 1920,
            })),
          }),
        ],
      }),
    );
    assert.ok(warnings.some((w) => /more than 6 notes/.test(w)), warnings.join("\n"));
    assert.match(patternBody, /\[c4,d4,e4,f4,g4,a4\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Capture on a drum-pad preset
// ─────────────────────────────────────────────────────────────────────────────

describe("capture from a drum preset", () => {
  const events = [36, 42, 38, 42, 36, 42, 38, 51].map((midi, i) => ({
    midi,
    velocity: 0.8,
    time: i * 0.25,
  }));
  const drumMap = { 36: "bd", 38: "sd", 42: "hh", 51: "rd" };

  test("is written as a drum pattern with the preset's own sounds", () => {
    const input = captureBufferToTranslationInput(events, {
      presetName: "drums",
      drumMap,
    });
    assert.equal(input.tracks[0].isDrum, true);

    const code = generatePatternDraft(analyzeTranslationInput(input), {
      soundOverrides: { 0: "sawtooth" },
    });
    assert.match(code, /const drums = s\(/);
    assert.match(code, /bd hh sd hh/);
    // the preset maps key 51 to "rd"; the GM table would have said "ride"
    assert.match(code, /\brd\b/);
    assert.doesNotMatch(code, /note\(|sawtooth|ride/);
  });

  test("without a drum map the capture is still a melody", () => {
    const input = captureBufferToTranslationInput(events, { presetName: "epiano" });
    assert.equal(input.tracks[0].isDrum, false);
    assert.match(
      generatePatternDraft(analyzeTranslationInput(input)),
      /const epiano = note\(/,
    );
  });
});
