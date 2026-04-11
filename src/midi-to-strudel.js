// Shared inbound MIDI → Strudel translation core.
//
// Three-layer pipeline:
//   1. Adapter (parseMidiFile) — @tonejs/midi → TranslationInput
//   2. Analyzer (analyzeTranslationInput) — quantize, map instruments, build metadata
//   3. Code generator (generatePatternDraft) — emit readable Strudel pattern code
//
// Pure functions, no DOM, no Strudel runtime dependency. Testable with `node --test`.

// @tonejs/midi is CJS. In Node ESM the namespace lands on the default
// export; Vite's esbuild pre-bundle exposes named exports instead.
// Using `import *` and falling back covers both paths.
import * as _toneMidiNs from "@tonejs/midi";
const Midi = _toneMidiNs.Midi ?? _toneMidiNs.default?.Midi;
import { resolveGmInstrument, resolveGmDrum, GM_DRUM_MAP } from "./midi-gm.js";

// ─────────────────────────────────────────────────────────────────────────────
// Drum-track heuristic
// ─────────────────────────────────────────────────────────────────────────────
// Many DAWs export drum patterns on channel 0 with program 0 ("acoustic grand
// piano") rather than the GM-standard channel 10.  Detect this by checking
// whether the overwhelming majority of note pitches land on known GM drum
// keys — if they do, it's almost certainly a drum track regardless of channel.

const GM_DRUM_PITCHES = new Set(Object.keys(GM_DRUM_MAP).map(Number));

function looksLikeDrumTrack(notes) {
  if (notes.length < 2) return false;
  const distinct = new Set(notes.map((n) => n.midi));
  const matchCount = [...distinct].filter((m) => GM_DRUM_PITCHES.has(m)).length;
  // All distinct pitches must be known GM drum notes.
  return matchCount === distinct.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. File adapter: @tonejs/midi → TranslationInput
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a MIDI file ArrayBuffer and normalize it into the shared
 * TranslationInput model.
 *
 * @param {ArrayBuffer} buffer - Raw .mid file bytes
 * @returns {TranslationInput}
 */
export function parseMidiFile(buffer) {
  const midi = new Midi(buffer);

  const tempos = midi.header.tempos;
  const bpm = tempos.length > 0 ? tempos[0].bpm : 120;

  const timeSigs = midi.header.timeSignatures;
  const timeSignature =
    timeSigs.length > 0
      ? /** @type {[number, number]} */ (timeSigs[0].timeSignature)
      : [4, 4];

  const tracks = midi.tracks.map((track, i) => {
    const isDrum =
      track.instrument.percussion ||
      track.channel === 9 ||
      looksLikeDrumTrack(track.notes);
    return {
      name: track.name || `Track ${i + 1}`,
      channel: track.channel,
      isDrum,
      gmInstrument: track.instrument.name || "acoustic grand piano",
      gmProgram: track.instrument.number,
      notes: track.notes.map((n) => ({
        name: n.name.toLowerCase(),
        midi: n.midi,
        time: n.time,
        duration: n.duration,
        velocity: n.velocity,
      })),
    };
  });

  return {
    sourceName: midi.name || "untitled",
    bpm: Math.round(bpm * 100) / 100,
    timeSignature,
    ppq: midi.header.ppq,
    hasTempoChanges: tempos.length > 1,
    hasTimeSigChanges: timeSigs.length > 1,
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
  const barDuration = beatsPerBar * (60 / bpm);

  // Find the total duration across all tracks
  let maxTime = 0;
  for (const track of input.tracks) {
    for (const note of track.notes) {
      const end = note.time + note.duration;
      if (end > maxTime) maxTime = end;
    }
  }

  const totalBars = Math.max(1, Math.ceil(maxTime / barDuration));
  const warnings = [];

  if (input.hasTempoChanges) {
    warnings.push(
      `Tempo changes detected — using first tempo (${input.bpm} BPM). Multi-tempo support is planned for Phase 2.`,
    );
  }
  if (input.hasTimeSigChanges) {
    warnings.push(
      `Time signature changes detected — using first (${tsNum}/${tsDenom}). Multi-time-sig support is planned for Phase 2.`,
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
    autoDetectGrid(input.tracks, barDuration, timeSignature);

  const slotsPerBar = gridSubdivision;
  const gridUnit = barDuration / slotsPerBar;

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

    const strudelSound = track.isDrum
      ? null
      : resolveGmInstrument(track.gmProgram ?? 0);

    const { notes: normalizedNotes, overlapCount } =
      dropOverlappingSamePitchNotes(track.notes);
    const polyphonicOverlapCount = countPolyphonicOverlaps(normalizedNotes);

    const unmappedDrums = track.isDrum
      ? [...new Set(normalizedNotes.map((note) => note.midi))].filter(
          (midi) => resolveGmDrum(midi) == null,
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

    for (const note of normalizedNotes) {
      let bar = Math.floor(note.time / barDuration);
      if (bar >= totalBars) continue;

      const timeInBar = clampToZero(note.time - bar * barDuration);
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
      const rawGridDur = note.duration / gridUnit;
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
    const vels = quantized.length >= 2 ? quantized.map((n) => n.velocity) : [];
    const velMin = vels.length ? Math.min(...vels) : 0;
    const velMax = vels.length ? Math.max(...vels) : 0;
    const hasVelocityVariation = velMax - velMin > 0.2;

    return {
      name: track.name,
      channel: track.channel,
      isDrum: track.isDrum,
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
  const usedVarNames = new Set();
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
  const input = parseMidiFile(buffer);
  const analysis = analyzeTranslationInput(input, options);

  const patternName = sanitizePatternName(
    options.patternName || input.sourceName,
  );

  // Build header comment
  const trackSummary = analysis.tracks
    .map((t) => `${t.name} (${t.isDrum ? "drums" : t.strudelSound})`)
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
 * @param {Array<{ midi: number, velocity: number, time: number }>} events
 * @param {{ presetName?: string }} [options]
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
        isDrum: false,
        gmInstrument: "acoustic grand piano",
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

  for (let bar = 0; bar < totalBars; bar++) {
    const barNotes = track.notes.filter((n) => n.bar === bar);

    if (barNotes.length === 0) {
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

  for (let bar = 0; bar < totalBars; bar++) {
    const barNotes = track.notes.filter((n) => n.bar === bar);

    if (barNotes.length === 0) {
      noteBars.push(buildRestBar(slotsPerBar));
      velocityBars.push(buildRestBar(slotsPerBar));
      continue;
    }

    const events = buildDrumBarEvents(barNotes, slotsPerBar, drumWarnings);
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
      // Chord: sort low to high, max 6 notes
      const sorted = notes
        .slice()
        .sort((a, b) => a.midi - b.midi)
        .slice(0, 6);
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

function buildDrumBarEvents(barNotes, slotsPerBar, drumWarnings) {
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
      const name = resolveGmDrum(n.midi);
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
      const name = nextVarName(usedVarNames);
      usedVarNames.add(name);
      uniqueContents.set(bar, name);
      consts.push({ name, content: bar });
      sequence.push({ type: "var", name });
    }
  }

  return { consts, sequence };
}

function nextVarName(usedNames) {
  for (let i = 0; i < 26; i++) {
    const name = String.fromCharCode(65 + i);
    if (!usedNames.has(name)) return name;
  }
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const name = String.fromCharCode(65 + i) + String.fromCharCode(65 + j);
      if (!usedNames.has(name)) return name;
    }
  }
  return "_section";
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
function autoDetectGrid(tracks, barDuration, timeSignature) {
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
      onsets.push(note.time);
    }
  }

  if (onsets.length === 0) return candidates[0];

  // Score each candidate, pick the coarsest grid meeting >=95%
  let bestGrid = candidates[candidates.length - 1]; // fallback to finest
  let bestScore = 0;

  for (const gridSlots of candidates) {
    const gridUnit = barDuration / gridSlots;
    const tolerance = gridUnit * 0.1;
    let snapped = 0;

    for (const onset of onsets) {
      const bar = Math.floor(onset / barDuration);
      const timeInBar = onset - bar * barDuration;
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

function sanitizeIdentifier(name, usedIdentifiers) {
  // Convert to camelCase-friendly identifier
  let id = name
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
