// Shared inbound MIDI → Strudel translation core.
//
// Three-layer pipeline:
//   1. Adapter (parseMidiFile) — Standard MIDI File → TranslationInput
//   2. Analyzer (analyzeTranslationInput) — quantize, map instruments, build metadata
//   3. Code generator (generatePatternDraft) — emit readable Strudel pattern code
//
// Pure functions, no DOM, no Strudel runtime dependency. Testable with `node --test`.

import { readSmf, makeTicksToSeconds, dominantTempo } from "./midi-smf.js";
import {
  resolveGmInstrument,
  resolveGmDrum,
  GM_DRUM_MAP,
  GM_FAMILY_NAMES,
} from "./midi-gm.js";

// A pattern is one editor buffer: past this many bars the generated source is
// too large to be a useful draft (and a single stray event hours into a file
// would otherwise emit thousands of rest bars).
export const MAX_IMPORT_BARS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Drum-track detection
// ─────────────────────────────────────────────────────────────────────────────
// GM reserves channel 10 for percussion, and that is the signal we trust.
//
// Some DAWs export a drum part on another channel, so there is a fallback —
// but it has to be conservative: GM drum keys cover B1–A3 and C4–F#4
// contiguously, so "every pitch is a drum key" is true of most bass lines and
// plenty of melodies. The fallback therefore needs all of:
//   - no melodic instrument assigned (no program change, or program 0), and
//   - every pitch is a GM drum key, and
//   - positive evidence: a drum-ish track name, or a kick + snare + hi-hat
//     together (which an actual melody essentially never spells).
// Anything it gets wrong can be flipped per track in the import dialog.

const GM_DRUM_PITCHES = new Set(Object.keys(GM_DRUM_MAP).map(Number));
const DRUM_NAME_RE =
  /drum|perc|\bkit\b|beat|kick|snare|hi-?hat|\bhats?\b|cymbal|\btoms?\b|clap/i;
const KICK_PITCHES = [35, 36];
const SNARE_PITCHES = [38, 40];
const HAT_PITCHES = [42, 44, 46];

/**
 * @param {{ name?: string, channel?: number, program?: number, notes: { midi: number }[] }} track
 * @returns {boolean}
 */
export function detectDrumTrack(track) {
  if (track.channel === 9) return true;
  if (track.notes.length < 2) return false;
  if ((track.program ?? 0) !== 0) return false;

  const distinct = new Set();
  for (const note of track.notes) distinct.add(note.midi);
  for (const midi of distinct) {
    if (!GM_DRUM_PITCHES.has(midi)) return false;
  }

  if (DRUM_NAME_RE.test(track.name ?? "")) return true;
  const has = (pitches) => pitches.some((p) => distinct.has(p));
  return has(KICK_PITCHES) && has(SNARE_PITCHES) && has(HAT_PITCHES);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. File adapter: Standard MIDI File → TranslationInput
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a MIDI file ArrayBuffer and normalize it into the shared
 * TranslationInput model.
 *
 * Notes carry both seconds (`time`/`duration`, through the file's tempo map)
 * and ticks (`ticks`/`durationTicks`). The analyzer quantises from ticks, so
 * the rhythm does not depend on the tempo map; `bpm` is the single tempo the
 * generated pattern plays at (see dominantTempo in midi-smf.js).
 *
 * @param {ArrayBuffer} buffer - Raw .mid file bytes
 * @returns {TranslationInput}
 */
export function parseMidiFile(buffer) {
  const smf = readSmf(buffer);
  const toSeconds = makeTicksToSeconds(smf.tempos, smf.ppq);

  let endTicks = 0;
  for (const track of smf.tracks) {
    for (const n of track.notes) {
      const end = n.ticks + n.durationTicks;
      if (end > endTicks) endTicks = end;
    }
  }

  const bpm = dominantTempo(smf.tempos, endTicks);
  const distinctTempos = new Set(smf.tempos.map((t) => t.bpm));

  const timeSigs = smf.timeSignatures;
  const timeSignature =
    timeSigs.length > 0
      ? /** @type {[number, number]} */ (timeSigs[0].timeSignature)
      : [4, 4];
  const distinctTimeSigs = new Set(
    timeSigs.map((t) => t.timeSignature.join("/")),
  );

  const tracks = smf.tracks.map((track, i) => {
    const isDrum = detectDrumTrack(track);
    return {
      name: track.name || `Track ${i + 1}`,
      channel: track.channel,
      isDrum,
      gmInstrument: isDrum
        ? "percussion"
        : (GM_FAMILY_NAMES[Math.floor(track.program / 8)] ?? "piano"),
      gmProgram: track.program,
      notes: track.notes.map((n) => {
        const time = toSeconds(n.ticks);
        return {
          name: midiToName(n.midi),
          midi: n.midi,
          time,
          duration: toSeconds(n.ticks + n.durationTicks) - time,
          velocity: n.velocity,
          ticks: n.ticks,
          durationTicks: n.durationTicks,
        };
      }),
    };
  });

  return {
    sourceName: smf.name || "untitled",
    bpm: Math.round(bpm * 100) / 100,
    timeSignature,
    ppq: smf.ppq,
    hasTempoChanges: distinctTempos.size > 1,
    truncated: smf.truncated,
    hasTimeSigChanges: distinctTimeSigs.size > 1,
    tracks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Analyzer: TranslationInput → MidiAnalysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze normalized note tracks and return the information needed for
 * readable code generation.
 *
 * @param {TranslationInput} input
 * @param {ImportOptions} [options]
 * @returns {MidiAnalysis}
 */
export function analyzeTranslationInput(input, options = {}) {
  const { bpm, timeSignature } = input;
  const [tsNum, tsDenom] = timeSignature;

  const beatsPerBar = tsNum * (4 / tsDenom);
  const ppq = input.ppq ?? 480;

  // Musical position in quarter-note beats. File notes carry ticks, which
  // place a note on the beat grid whatever the tempo map does; quantising
  // their wall-clock seconds against one tempo would smear every note after
  // a tempo change across the grid. Live-capture notes only have seconds,
  // and a single tempo, so the conversion is exact for them.
  const onsetBeats = (note) =>
    note.ticks != null ? note.ticks / ppq : (note.time * bpm) / 60;
  const lengthBeats = (note) =>
    note.durationTicks != null
      ? note.durationTicks / ppq
      : (note.duration * bpm) / 60;

  // Find the total duration across all tracks
  let maxTime = 0;
  let maxBeats = 0;
  for (const track of input.tracks) {
    for (const note of track.notes) {
      const end = note.time + note.duration;
      if (end > maxTime) maxTime = end;
      const endBeats = onsetBeats(note) + lengthBeats(note);
      if (endBeats > maxBeats) maxBeats = endBeats;
    }
  }

  // The epsilon keeps float fuzz on an exact bar boundary from adding a bar.
  const totalBars = Math.max(1, Math.ceil(maxBeats / beatsPerBar - 1e-9));
  if (totalBars > MAX_IMPORT_BARS) {
    throw new Error(
      `this MIDI spans ${totalBars} bars — too long to import as one pattern (limit ${MAX_IMPORT_BARS}). Trim it to a section first.`,
    );
  }
  const warnings = [];

  if (input.truncated) {
    warnings.push(
      "This file ends mid-track — it looks cut off. Everything up to that point was imported; the ending may be missing.",
    );
  }
  if (input.hasTempoChanges) {
    warnings.push(
      `Tempo changes detected — a pattern has one tempo, so this plays at ${input.bpm} BPM throughout (the tempo most of the file uses). Notes keep their positions on the beat; speed-ups and slow-downs are flattened.`,
    );
  }
  if (input.hasTimeSigChanges) {
    warnings.push(
      `Time signature changes detected — bars are laid out in the first one (${tsNum}/${tsDenom}), so bar lines after a change will not match the original.`,
    );
  }
  if (totalBars > 200) {
    warnings.push(
      `Long MIDI (${totalBars} bars) — consider trimming to a section.`,
    );
  }

  // Choose quantization grid
  const gridSubdivision =
    options.gridSubdivision ??
    autoDetectGrid(input.tracks, onsetBeats, beatsPerBar, timeSignature);

  const slotsPerBar = gridSubdivision;
  const gridUnit = beatsPerBar / slotsPerBar;

  // Filter tracks by trackIndices if specified
  const trackIndices = options.trackIndices;
  const selectedTracks = input.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track, index }) => {
      if (trackIndices) {
        return trackIndices.includes(index) && track.notes.length > 0;
      }
      return track.notes.length > 0;
    })
    .map(({ track, index }) => ({ track, originalIndex: index }));

  // Build analyzed tracks
  const usedIdentifiers = new Set();
  const analyzedTracks = selectedTracks.map(({ track, originalIndex }) => {
    const identifier = sanitizeIdentifier(track.name, usedIdentifiers);
    usedIdentifiers.add(identifier);

    // The per-track choice from the import dialog wins over detection.
    const isDrum = options.drumOverrides?.[originalIndex] ?? track.isDrum;

    const strudelSound = isDrum
      ? null
      : resolveGmInstrument(track.gmProgram ?? 0);

    const { notes: normalizedNotes, overlapCount } =
      dropOverlappingSamePitchNotes(track.notes);
    const polyphonicOverlapCount = countPolyphonicOverlaps(normalizedNotes);

    const drumName = (midi) =>
      track.drumMap ? (track.drumMap[midi] ?? null) : resolveGmDrum(midi);
    const unmappedDrums = isDrum
      ? [...new Set(normalizedNotes.map((note) => note.midi))].filter(
          (midi) => drumName(midi) == null,
        )
      : [];

    if (overlapCount > 0) {
      warnings.push(
        `Track "${track.name}" contains ${overlapCount} overlapping same-pitch note${overlapCount === 1 ? "" : "s"}; kept the later note in each overlap.`,
      );
    }

    if (unmappedDrums.length > 0) {
      warnings.push(
        `Track "${track.name}" contains unmapped GM drum note${unmappedDrums.length === 1 ? "" : "s"}: ${unmappedDrums.sort((a, b) => a - b).join(", ")}. Those slots import as rests.`,
      );
    }

    if (polyphonicOverlapCount > 0) {
      warnings.push(
        `Track "${track.name}" contains ${polyphonicOverlapCount} staggered polyphonic overlap${polyphonicOverlapCount === 1 ? "" : "s"}; the Phase 1 draft keeps the output readable, but sustained inner voices may be simplified.`,
      );
    }

    // Quantize notes
    const quantized = [];
    let snappedCount = 0;
    let truncatedCount = 0;
    const tolerance = gridUnit * 0.1;

    // slot key (bar, gridPosition) → simultaneous melodic notes
    const chordSizes = new Map();

    for (const note of normalizedNotes) {
      const onset = onsetBeats(note);
      let bar = Math.floor(onset / beatsPerBar);
      if (bar >= totalBars) continue;

      const timeInBar = clampToZero(onset - bar * beatsPerBar);
      const rawGridPos = timeInBar / gridUnit;
      let gridPosition = Math.round(rawGridPos);

      // Notes that land on the barline belong to the next bar, not the last slot.
      if (gridPosition >= slotsPerBar) {
        bar += 1;
        gridPosition = 0;
      }

      if (bar >= totalBars) continue;

      // Check snap quality
      const snapError = Math.abs(rawGridPos - gridPosition) * gridUnit;
      if (snapError <= tolerance) snappedCount++;

      // Duration in grid units (minimum 1)
      const rawGridDur = lengthBeats(note) / gridUnit;
      let gridDuration = Math.max(1, Math.round(rawGridDur));

      // Clamp to bar boundary
      const remaining = slotsPerBar - gridPosition;
      if (gridDuration > remaining) {
        truncatedCount++;
        gridDuration = remaining;
      }

      quantized.push({
        name: note.name,
        midi: note.midi,
        bar,
        gridPosition,
        gridDuration,
        velocity: note.velocity,
      });

      const slotKey = bar * slotsPerBar + gridPosition;
      chordSizes.set(slotKey, (chordSizes.get(slotKey) ?? 0) + 1);
    }

    if (!isDrum) {
      let clippedChords = 0;
      for (const size of chordSizes.values()) {
        if (size > MAX_CHORD_NOTES) clippedChords++;
      }
      if (clippedChords > 0) {
        warnings.push(
          `Track "${track.name}" has ${clippedChords} chord${clippedChords === 1 ? "" : "s"} with more than ${MAX_CHORD_NOTES} notes; only the lowest ${MAX_CHORD_NOTES} of each are kept.`,
        );
      }
    }

    const accuracy =
      normalizedNotes.length > 0 ? snappedCount / normalizedNotes.length : 1;
    if (accuracy < 0.95) {
      warnings.push(
        `Track "${track.name}": ${Math.round((1 - accuracy) * normalizedNotes.length)} of ${normalizedNotes.length} notes didn't snap cleanly to the ${gridSubdivision}-slot grid (${Math.round(accuracy * 100)}% accuracy).`,
      );
    }

    if (
      normalizedNotes.length > 0 &&
      truncatedCount / normalizedNotes.length > 0.1
    ) {
      warnings.push(
        `Track "${track.name}" has ${truncatedCount} note${truncatedCount === 1 ? "" : "s"} crossing bar boundaries; those notes were truncated at the bar edge for readable output.`,
      );
    }

    // Pitch range
    let minMidi = 127,
      maxMidi = 0;
    for (const n of normalizedNotes) {
      if (n.midi < minMidi) minMidi = n.midi;
      if (n.midi > maxMidi) maxMidi = n.midi;
    }
    const pitchRange =
      normalizedNotes.length > 0
        ? `${midiToName(minMidi)}–${midiToName(maxMidi)}`
        : "";

    // Velocity variation
    // (a loop, not Math.min(...array): spreading a very large track
    // overflows the argument limit)
    let velMin = 0;
    let velMax = 0;
    if (quantized.length >= 2) {
      velMin = Infinity;
      velMax = -Infinity;
      for (const n of quantized) {
        if (n.velocity < velMin) velMin = n.velocity;
        if (n.velocity > velMax) velMax = n.velocity;
      }
    }
    const hasVelocityVariation = velMax - velMin > 0.2;

    return {
      name: track.name,
      channel: track.channel,
      isDrum,
      drumMap: track.drumMap ?? null,
      gmInstrument: track.gmInstrument,
      strudelSound,
      noteCount: track.notes.length,
      pitchRange,
      notes: quantized,
      quantizationAccuracy: accuracy,
      identifier,
      slotsPerBar,
      originalIndex,
      hasVelocityVariation,
      velMin,
      velMax,
    };
  });

  // Check for velocity variation
  for (const track of analyzedTracks) {
    if (!track.hasVelocityVariation) continue;
    if (options.preserveVelocity === false) {
      warnings.push(
        `Track "${track.name}" has meaningful velocity variation (${Math.round(track.velMin * 127)}–${Math.round(track.velMax * 127)}) that is not preserved in the generated pattern.`,
      );
    }
  }

  return {
    name: input.sourceName,
    bpm: input.bpm,
    timeSignature,
    ppq: input.ppq ?? 480,
    totalBars,
    duration: maxTime,
    hasTempoChanges: !!input.hasTempoChanges,
    hasTimeSigChanges: !!input.hasTimeSigChanges,
    tracks: analyzedTracks,
    warnings,
    gridSubdivision,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Code generator: MidiAnalysis → pattern source string
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a Strudel pattern source string from an analyzed MIDI file.
 *
 * @param {MidiAnalysis} analysis
 * @param {ImportOptions} [options]
 * @returns {string} - Complete pattern file content (the export default `...` body)
 */
export function generatePatternDraft(analysis, options = {}) {
  const { bpm, timeSignature, totalBars, tracks } = analysis;
  const [tsNum, tsDenom] = timeSignature;
  const beatsPerCycle = tsNum * (4 / tsDenom);
  const preserveVelocity = options.preserveVelocity !== false;

  const lines = [];
  const usedVarNames = makeVarNamer();
  const trackVelocityBars = new Map(); // identifier → velocityBars[]

  // Tempo
  lines.push(`setcpm(${cleanNumber(bpm)}/${cleanNumber(beatsPerCycle)})`);
  lines.push("");

  // Generate const declarations for each track
  for (const track of tracks) {
    let result;
    if (track.isDrum) {
      result = generateDrumTrack(track, totalBars, usedVarNames);
    } else {
      result = generateMelodicTrack(track, totalBars, usedVarNames);
    }
    lines.push(...result.lines);
    if (preserveVelocity && track.hasVelocityVariation && result.velocityBars) {
      trackVelocityBars.set(track.identifier, result.velocityBars);
    }
    lines.push("");
  }

  // Generate named block labels with sound assignments
  for (const track of tracks) {
    const velBars = trackVelocityBars.get(track.identifier);
    if (track.isDrum) {
      if (velBars) {
        lines.push(
          `${track.identifier}: ${track.identifier}\n  .velocity(${formatVelocityCat(velBars)})`,
        );
      } else {
        lines.push(`${track.identifier}: ${track.identifier}`);
      }
    } else {
      const sound =
        options.soundOverrides?.[track.originalIndex] ?? track.strudelSound;
      const fx = [`.s("${sound}")`];
      if (velBars) {
        fx.push(`.velocity(${formatVelocityCat(velBars)})`);
      }
      fx.push(".room(0.2)");
      lines.push(
        `${track.identifier}: ${track.identifier}\n  ${fx.join("\n  ")}`,
      );
    }
    lines.push("");
  }

  // Trim trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}

/**
 * Convenience: parse + analyze + generate in one call for MIDI files.
 *
 * @param {ArrayBuffer} buffer
 * @param {ImportOptions} [options]
 * @returns {{ name: string, code: string, warnings: string[] }}
 */
export function midiFileToPattern(buffer, options = {}) {
  return translationInputToPattern(parseMidiFile(buffer), options);
}

/**
 * Analyze + generate from an already-parsed file, so a caller that parsed
 * once to show the track list (the import dialog) does not parse again.
 *
 * @param {TranslationInput} input
 * @param {ImportOptions} [options]
 * @returns {{ name: string, code: string, patternBody: string, warnings: string[], analysis: MidiAnalysis }}
 */
export function translationInputToPattern(input, options = {}) {
  const analysis = analyzeTranslationInput(input, options);

  const patternName = sanitizePatternName(
    options.patternName || input.sourceName,
  );

  // Build header comment
  const trackSummary = analysis.tracks
    .map(
      (t) =>
        `${t.name} (${t.isDrum ? "drums" : (options.soundOverrides?.[t.originalIndex] ?? t.strudelSound)})`,
    )
    .join(", ");
  const gridLabel = gridSubdivisionLabel(
    analysis.gridSubdivision,
    analysis.timeSignature,
  );
  const header = [
    `// ${patternName} — imported from MIDI file`,
    `// original: "${input.sourceName}" · ${analysis.tracks.length} track${analysis.tracks.length === 1 ? "" : "s"} · ${analysis.timeSignature[0]}/${analysis.timeSignature[1]} at ${analysis.bpm} BPM`,
    `// tracks: ${trackSummary}`,
    `// quantized to ${gridLabel} grid · ${analysis.totalBars} bar${analysis.totalBars === 1 ? "" : "s"}`,
  ];

  const code = generatePatternDraft(analysis, options);
  const fullCode =
    header.join("\n") + "\n\n" + `export default \`\n${code}\n\`;\n`;

  return {
    name: patternName,
    code: fullCode,
    patternBody: code,
    warnings: analysis.warnings,
    analysis,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Capture adapter: live MIDI buffer → TranslationInput
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate BPM from an array of capture events by analyzing the median
 * inter-onset interval (IOI).
 *
 * Assumes the median IOI corresponds to an 8th note. Falls back to
 * quarter-note or 16th-note interpretation if that gives an out-of-range
 * BPM. Returns 120 if estimation fails.
 *
 * @param {Array<{ time: number }>} events — time in seconds from capture start
 * @returns {number}
 */
export function estimateBpmFromCapture(events) {
  if (events.length < 2) return 120;

  // Group near-simultaneous events (chords) and compute IOIs between onsets
  const chordWindow = 0.06;
  const onsets = [events[0].time];
  for (let i = 1; i < events.length; i++) {
    if (events[i].time - events[i - 1].time > chordWindow) {
      onsets.push(events[i].time);
    }
  }

  if (onsets.length < 2) return 120;

  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    iois.push(onsets[i] - onsets[i - 1]);
  }

  // Median IOI
  const sorted = iois.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Try as 8th note: one 8th = 30/BPM seconds → BPM = 30/median
  const bpm8th = 30 / median;
  if (bpm8th >= 60 && bpm8th <= 200) return Math.round(bpm8th);

  // Try as quarter note: BPM = 60/median
  const bpmQtr = 60 / median;
  if (bpmQtr >= 60 && bpmQtr <= 200) return Math.round(bpmQtr);

  // Try as 16th note: BPM = 15/median
  const bpm16th = 15 / median;
  if (bpm16th >= 60 && bpm16th <= 200) return Math.round(bpm16th);

  return 120;
}

/**
 * Convert a live MIDI capture buffer into a TranslationInput suitable for
 * the shared analysis + codegen pipeline.
 *
 * The capture buffer has no noteoff events (the bridge uses trigger-and-decay),
 * so duration is inferred from the gap to the next onset, with a minimum floor.
 *
 * A capture made on a drum-pad preset is a drum track: pass `drumMap` (the
 * preset's MIDI note → sound name table) so the pattern is written with the
 * sounds that were actually heard, not as a melody.
 *
 * @param {Array<{ midi: number, velocity: number, time: number }>} events
 * @param {{ presetName?: string, drumMap?: Record<number, string> }} [options]
 * @returns {TranslationInput}
 */
export function captureBufferToTranslationInput(events, options = {}) {
  const bpm = estimateBpmFromCapture(events);

  // Group near-simultaneous events into chords (same window as the bridge)
  const chordWindow = 0.06;
  const groups = [];
  for (const ev of events) {
    const last = groups[groups.length - 1];
    if (last && ev.time - last[0].time < chordWindow) {
      last.push(ev);
    } else {
      groups.push([ev]);
    }
  }

  // Compute median IOI for fallback duration (last note, isolated notes)
  let fallbackDuration = 0.25; // sensible default
  if (groups.length >= 2) {
    const iois = [];
    for (let i = 1; i < groups.length; i++) {
      iois.push(groups[i][0].time - groups[i - 1][0].time);
    }
    iois.sort((a, b) => a - b);
    fallbackDuration = iois[Math.floor(iois.length / 2)];
  }

  // Build notes with inferred durations
  const MIN_DURATION = 0.05;
  const notes = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const onset = group[0].time;
    const nextOnset = i + 1 < groups.length ? groups[i + 1][0].time : null;
    const duration =
      nextOnset != null
        ? Math.max(MIN_DURATION, nextOnset - onset)
        : fallbackDuration;

    for (const ev of group) {
      notes.push({
        name: midiToName(ev.midi),
        midi: ev.midi,
        time: ev.time,
        duration,
        velocity: ev.velocity,
      });
    }
  }

  return {
    sourceName: options.presetName
      ? `captured-${options.presetName}`
      : "captured",
    bpm,
    timeSignature: /** @type {[number, number]} */ ([4, 4]),
    ppq: 480,
    hasTempoChanges: false,
    hasTimeSigChanges: false,
    tracks: [
      {
        name: options.presetName ?? "capture",
        channel: 0,
        isDrum: !!options.drumMap,
        ...(options.drumMap && { drumMap: options.drumMap }),
        gmInstrument: options.drumMap ? "percussion" : "acoustic grand piano",
        gmProgram: 0,
        notes,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateMelodicTrack(track, totalBars, usedVarNames) {
  const noteBars = [];
  const velocityBars = [];
  const slotsPerBar = track.slotsPerBar;

  const notesByBar = groupNotesByBar(track.notes);

  for (let bar = 0; bar < totalBars; bar++) {
    const barNotes = notesByBar.get(bar);

    if (!barNotes) {
      noteBars.push(buildRestBar(slotsPerBar));
      velocityBars.push(buildRestBar(slotsPerBar));
      continue;
    }

    const events = buildMelodicBarEvents(barNotes, slotsPerBar);
    noteBars.push(eventsToMiniNotation(events));
    velocityBars.push(eventsToVelocityNotation(events));
  }

  // Trim trailing all-rest bars
  while (noteBars.length > 1 && isAllRest(noteBars[noteBars.length - 1])) {
    noteBars.pop();
    velocityBars.pop();
  }

  const lines = [];
  const repetition = detectBarRepetitions(noteBars, usedVarNames);

  if (repetition) {
    for (const { name, content } of repetition.consts) {
      lines.push(`const ${name} = "${content}"`);
    }
    lines.push("");
    lines.push(`const ${track.identifier} = note(`);
    lines.push(`  cat(`);
    const indent = "    ";
    for (let i = 0; i < repetition.sequence.length; i++) {
      const entry = repetition.sequence[i];
      const comma = ",";
      const barComment = ` // bar ${i + 1}`;
      if (entry.type === "var") {
        lines.push(`${indent}${entry.name}${comma}${barComment}`);
      } else {
        lines.push(`${indent}"${entry.content}"${comma}${barComment}`);
      }
    }
    lines.push(`  ),`);
    lines.push(`)`);
  } else {
    const indent = "    ";
    lines.push(`const ${track.identifier} = note(`);
    lines.push(`  cat(`);
    for (let i = 0; i < noteBars.length; i++) {
      const comma = ",";
      const barComment = ` // bar ${i + 1}`;
      lines.push(`${indent}"${noteBars[i]}"${comma}${barComment}`);
    }
    lines.push(`  ),`);
    lines.push(`)`);
  }

  return {
    lines,
    velocityBars: track.hasVelocityVariation ? velocityBars : null,
  };
}

function generateDrumTrack(track, totalBars, usedVarNames) {
  const slotsPerBar = track.slotsPerBar;

  // Collect all unique drum names used
  const drumWarnings = new Set();
  const noteBars = [];
  const velocityBars = [];

  const notesByBar = groupNotesByBar(track.notes);

  for (let bar = 0; bar < totalBars; bar++) {
    const barNotes = notesByBar.get(bar);

    if (!barNotes) {
      noteBars.push(buildRestBar(slotsPerBar));
      velocityBars.push(buildRestBar(slotsPerBar));
      continue;
    }

    const events = buildDrumBarEvents(
      barNotes,
      slotsPerBar,
      drumWarnings,
      track.drumMap,
    );
    noteBars.push(eventsToMiniNotation(events));
    velocityBars.push(eventsToVelocityNotation(events));
  }

  // Trim trailing all-rest bars
  while (noteBars.length > 1 && isAllRest(noteBars[noteBars.length - 1])) {
    noteBars.pop();
    velocityBars.pop();
  }

  const lines = [];

  if (drumWarnings.size > 0) {
    lines.push(
      `// ⚠ unmapped drum notes (MIDI): ${[...drumWarnings].sort((a, b) => a - b).join(", ")}`,
    );
  }

  const repetition = detectBarRepetitions(noteBars, usedVarNames);

  if (repetition) {
    for (const { name, content } of repetition.consts) {
      lines.push(`const ${name} = "${content}"`);
    }
    lines.push("");
    lines.push(`const ${track.identifier} = s(`);
    lines.push(`  cat(`);
    const indent = "    ";
    for (let i = 0; i < repetition.sequence.length; i++) {
      const entry = repetition.sequence[i];
      const comma = ",";
      const barComment = ` // bar ${i + 1}`;
      if (entry.type === "var") {
        lines.push(`${indent}${entry.name}${comma}${barComment}`);
      } else {
        lines.push(`${indent}"${entry.content}"${comma}${barComment}`);
      }
    }
    lines.push(`  ),`);
    lines.push(`)`);
  } else {
    const indent = "    ";
    lines.push(`const ${track.identifier} = s(`);
    lines.push(`  cat(`);
    for (let i = 0; i < noteBars.length; i++) {
      const comma = ",";
      const barComment = ` // bar ${i + 1}`;
      lines.push(`${indent}"${noteBars[i]}"${comma}${barComment}`);
    }
    lines.push(`  ),`);
    lines.push(`)`);
  }

  return {
    lines,
    velocityBars: track.hasVelocityVariation ? velocityBars : null,
  };
}

function buildMelodicBarEvents(barNotes, slotsPerBar) {
  // Group notes by grid position
  const slots = new Map();
  for (const note of barNotes) {
    const pos = note.gridPosition;
    if (!slots.has(pos)) slots.set(pos, []);
    slots.get(pos).push(note);
  }

  // Build sequential events across the grid
  const events = [];
  let pos = 0;

  // Get all positions sorted
  const positions = [...slots.keys()].sort((a, b) => a - b);

  for (const notePos of positions) {
    // Fill gap with rest if needed
    if (notePos > pos) {
      const gap = notePos - pos;
      events.push({ type: "rest", duration: gap });
    }

    const notes = slots.get(notePos);
    // Use the longest duration among simultaneous notes
    const maxDur = Math.max(...notes.map((n) => n.gridDuration));

    if (notes.length === 1) {
      events.push({
        type: "note",
        name: notes[0].name,
        duration: maxDur,
        velocity: notes[0].velocity,
      });
    } else {
      // Chord: sort low to high, capped (the analyzer warns when it clips)
      const sorted = notes
        .slice()
        .sort((a, b) => a.midi - b.midi)
        .slice(0, MAX_CHORD_NOTES);
      events.push({
        type: "chord",
        names: sorted.map((n) => n.name),
        duration: maxDur,
        velocity: sorted.reduce((s, n) => s + n.velocity, 0) / sorted.length,
      });
    }

    pos = notePos + maxDur;
  }

  // Fill remaining with rest
  if (pos < slotsPerBar) {
    events.push({ type: "rest", duration: slotsPerBar - pos });
  }

  return events;
}

function buildDrumBarEvents(barNotes, slotsPerBar, drumWarnings, drumMap) {
  // Group notes by grid position
  const slots = new Map();
  for (const note of barNotes) {
    const pos = note.gridPosition;
    if (!slots.has(pos)) slots.set(pos, []);
    slots.get(pos).push(note);
  }

  const events = [];
  let pos = 0;

  const positions = [...slots.keys()].sort((a, b) => a - b);

  for (const notePos of positions) {
    if (notePos > pos) {
      const gap = notePos - pos;
      events.push({ type: "rest", duration: gap });
    }

    const notes = slots.get(notePos);
    const drumNames = [];
    const drumVelocities = [];
    for (const n of notes) {
      // A live-capture track brings the drum map of the preset it was played
      // on; a file track uses the GM kit.
      const name = drumMap ? (drumMap[n.midi] ?? null) : resolveGmDrum(n.midi);
      if (name) {
        // Deduplicate: don't repeat the same drum name in a chord
        if (!drumNames.includes(name)) {
          drumNames.push(name);
          drumVelocities.push(n.velocity);
        }
      } else {
        drumWarnings.add(n.midi);
      }
    }

    if (drumNames.length === 0) {
      // All unmapped
      events.push({ type: "rest", duration: 1 });
    } else if (drumNames.length === 1) {
      events.push({
        type: "note",
        name: drumNames[0],
        duration: 1,
        velocity: drumVelocities[0],
      });
    } else {
      events.push({
        type: "chord",
        names: drumNames,
        duration: 1,
        velocity:
          drumVelocities.reduce((s, v) => s + v, 0) / drumVelocities.length,
      });
    }

    pos = notePos + 1;
  }

  if (pos < slotsPerBar) {
    events.push({ type: "rest", duration: slotsPerBar - pos });
  }

  return events;
}

const MAX_CHORD_NOTES = 6;

function groupNotesByBar(notes) {
  const byBar = new Map();
  for (const note of notes) {
    const list = byBar.get(note.bar);
    if (list) list.push(note);
    else byBar.set(note.bar, [note]);
  }
  return byBar;
}

function eventsToMiniNotation(events) {
  const parts = [];

  for (const event of events) {
    const dur = event.duration;
    const weight = dur > 1 ? `@${dur}` : "";

    if (event.type === "rest") {
      parts.push(`~${weight}`);
    } else if (event.type === "note") {
      parts.push(`${event.name}${weight}`);
    } else if (event.type === "chord") {
      const chord = `[${event.names.join(",")}]`;
      parts.push(`${chord}${weight}`);
    }
  }

  return parts.join(" ");
}

function buildRestBar(slotsPerBar) {
  if (slotsPerBar === 1) return "~";
  return `~@${slotsPerBar}`;
}

function isAllRest(barStr) {
  return /^~(@\d+)?$/.test(barStr);
}

// ─── Repetition detection ────────────────────────────────────────────────

function detectBarRepetitions(bars, usedVarNames) {
  // Only look for repetitions among non-rest bars with at least one duplicate.
  const contentCounts = new Map();
  for (const bar of bars) {
    if (isAllRest(bar)) continue;
    contentCounts.set(bar, (contentCounts.get(bar) || 0) + 1);
  }

  if (![...contentCounts.values()].some((c) => c > 1)) return null;

  const uniqueContents = new Map(); // content → varName
  const consts = [];
  const sequence = [];

  for (const bar of bars) {
    if (isAllRest(bar)) {
      sequence.push({ type: "literal", content: bar });
      continue;
    }

    if (uniqueContents.has(bar)) {
      sequence.push({ type: "var", name: uniqueContents.get(bar) });
    } else {
      const name = usedVarNames.next();
      uniqueContents.set(bar, name);
      consts.push({ name, content: bar });
      sequence.push({ type: "var", name });
    }
  }

  return { consts, sequence };
}

// Names for repeated-bar consts: A … Z, AA … ZZ, AAA … — never runs out and
// never repeats, however many distinct bars a long import has.
function makeVarNamer() {
  let count = 0;
  return {
    next() {
      let n = count++;
      let name = "";
      do {
        name = String.fromCharCode(65 + (n % 26)) + name;
        n = Math.floor(n / 26) - 1;
      } while (n >= 0);
      return name;
    },
  };
}

// ─── Velocity notation ──────────────────────────────────────────────────

function eventsToVelocityNotation(events) {
  const parts = [];

  for (const event of events) {
    const dur = event.duration;
    const weight = dur > 1 ? `@${dur}` : "";

    if (event.type === "rest") {
      parts.push(`~${weight}`);
    } else {
      parts.push(`${formatVelocity(event.velocity)}${weight}`);
    }
  }

  return parts.join(" ");
}

function formatVelocity(v) {
  const rounded = Math.round(v * 100) / 100;
  // Avoid trailing zeros: 0.80 → 0.8, 1.00 → 1
  return String(rounded);
}

function formatVelocityCat(velocityBars) {
  if (velocityBars.length === 1) {
    return `"${velocityBars[0]}"`;
  }
  const indent = "    ";
  const items = velocityBars.map((b) => `${indent}"${b}",`).join("\n");
  return `cat(\n${items}\n  )`;
}

// Auto-detect the coarsest quantization grid that captures >=95% of note onsets.
// Start from the coarsest candidate and use it if it meets the threshold. Only
// step to a finer grid when coarser ones lose too many notes. This keeps the
// output readable (8th notes instead of 32nd notes for typical MIDI).
function autoDetectGrid(tracks, onsetBeats, beatsPerBar, timeSignature) {
  const [tsNum, tsDenom] = timeSignature;

  // Build candidate grids based on time signature, coarsest to finest
  let candidates;
  if (tsDenom === 8 && tsNum % 3 === 0) {
    // Compound time: 6/8, 9/8, 12/8
    candidates = [tsNum, tsNum * 2, tsNum * 4];
  } else if (tsNum === 3) {
    // 3/4
    candidates = [3, 6, 9, 12, 18, 24];
  } else {
    // 4/4 and similar simple time
    candidates = [4, 8, 12, 16, 24, 32];
  }

  // Collect all note onsets across tracks
  const onsets = [];
  for (const track of tracks) {
    for (const note of track.notes) {
      onsets.push(onsetBeats(note));
    }
  }

  if (onsets.length === 0) return candidates[0];

  // Score each candidate, pick the coarsest grid meeting >=95%
  let bestGrid = candidates[candidates.length - 1]; // fallback to finest
  let bestScore = 0;

  for (const gridSlots of candidates) {
    const gridUnit = beatsPerBar / gridSlots;
    const tolerance = gridUnit * 0.1;
    let snapped = 0;

    for (const onset of onsets) {
      const bar = Math.floor(onset / beatsPerBar);
      const timeInBar = onset - bar * beatsPerBar;
      const rawGridPos = timeInBar / gridUnit;
      const snapError =
        Math.abs(rawGridPos - Math.round(rawGridPos)) * gridUnit;
      if (snapError <= tolerance) snapped++;
    }

    const score = snapped / onsets.length;

    if (score >= 0.95) {
      // First (coarsest) grid meeting the threshold wins
      return gridSlots;
    }

    // Track the best fallback if nothing meets 95%
    if (score > bestScore) {
      bestGrid = gridSlots;
      bestScore = score;
    }
  }

  return bestGrid;
}

// MIDI note number → note name (e.g. 60 → "C4")
const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];

export function midiToName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const note = NOTE_NAMES[midi % 12];
  return `${note}${octave}`.toLowerCase();
}

// Names a generated `const <id> = …` / `<id>: …` must not take.
//
// JS reserved words are syntax errors ("Default" → `const default`). The
// Strudel globals are worse because they parse: `const note = note(…)` reads
// its own binding before initialisation and throws at evaluation, and a
// track called "S" or "Stack" would shadow the function for the rest of the
// buffer. The list covers what the generated code calls plus the globals a
// user is most likely to type next into an imported pattern.
const RESERVED_IDENTIFIERS = new Set([
  // JavaScript
  "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "arguments", "eval", "undefined", "NaN", "Infinity", "async", "of",
  // Strudel
  "note", "n", "s", "sound", "cat", "seq", "stack", "silence", "setcpm",
  "setcps", "mini", "m", "chord", "scale", "voicing", "arrange", "all",
  "hush", "samples", "sine", "saw", "square", "tri", "cosine", "rand",
  "perlin", "irand", "choose", "pure", "reify", "slowcat", "fastcat",
  "sequence", "polymeter", "polyrhythm", "timecat", "stepcat", "run",
  "progression", "gain", "room", "delay", "lpf", "hpf", "pan", "bank",
  "velocity", "struct", "mask", "euclid", "fast", "slow", "rev", "jux",
  "superimpose", "layer", "off", "every", "sometimes", "ref", "register",
  "controls", "time", "id",
]); // prettier-ignore

function sanitizeIdentifier(name, usedIdentifiers) {
  // Convert to camelCase-friendly identifier
  let id = String(name ?? "")
    .replace(/[^a-zA-Z0-9\s_-]/g, "")
    .trim()
    .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/[-_\s]+/g, "");

  // Ensure starts with a letter
  if (!id || !/^[a-zA-Z]/.test(id)) {
    id = "track" + (id || "");
  }

  // Make first char lowercase
  id = id[0].toLowerCase() + id.slice(1);

  // Reserved word or Strudel global → make it unmistakably a track name.
  if (RESERVED_IDENTIFIERS.has(id)) {
    id = id + "Track";
  }

  // Deduplicate
  if (usedIdentifiers.has(id)) {
    let n = 2;
    while (usedIdentifiers.has(id + n)) n++;
    id = id + n;
  }

  return id;
}

export function sanitizePatternName(name) {
  return (
    name
      .toLowerCase()
      .replace(/\.midi?$/i, "")
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "imported-midi"
  );
}

export function gridSubdivisionLabel(gridSlots, timeSignature) {
  const [tsNum, tsDenom] = timeSignature;
  const beatsPerBar = tsNum * (4 / tsDenom);

  // Try to name common grids
  const ratio = gridSlots / beatsPerBar;
  if (ratio === 1) return "quarter note";
  if (ratio === 2) return "8th note";
  if (ratio === 3) return "8th note triplet";
  if (ratio === 4) return "16th note";
  if (ratio === 6) return "16th note triplet";
  if (ratio === 8) return "32nd note";
  return `${gridSlots}-slot`;
}

function cleanNumber(n) {
  // Avoid unnecessary decimals: 120.0 → 120
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function clampToZero(n) {
  return Math.abs(n) < 1e-9 ? 0 : n;
}

function dropOverlappingSamePitchNotes(notes) {
  const sorted = notes
    .slice()
    .sort(
      (a, b) => a.time - b.time || a.midi - b.midi || a.duration - b.duration,
    );
  const kept = [];
  const lastIndexByMidi = new Map();
  let overlapCount = 0;

  for (const note of sorted) {
    const lastIndex = lastIndexByMidi.get(note.midi);
    if (lastIndex != null) {
      const previous = kept[lastIndex];
      const previousEnd = previous.time + previous.duration;
      if (note.time < previousEnd) {
        kept[lastIndex] = note;
        overlapCount++;
        continue;
      }
    }

    lastIndexByMidi.set(note.midi, kept.length);
    kept.push(note);
  }

  return { notes: kept, overlapCount };
}

function countPolyphonicOverlaps(notes) {
  const sorted = notes
    .slice()
    .sort(
      (a, b) => a.time - b.time || a.midi - b.midi || b.duration - a.duration,
    );
  const active = [];
  let overlapCount = 0;

  for (const note of sorted) {
    const stillActive = active.filter(
      (other) => other.time + other.duration > note.time,
    );
    if (
      stillActive.some(
        (other) => other.midi !== note.midi && other.time !== note.time,
      )
    ) {
      overlapCount++;
    }
    stillActive.push(note);
    active.length = 0;
    active.push(...stillActive);
  }

  return overlapCount;
}
