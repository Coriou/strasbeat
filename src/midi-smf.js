// Standard MIDI File reader for the import pipeline.
//
// Reads only what the MIDI → Strudel translation needs: the tick resolution,
// the tempo and time-signature maps, and per-track notes with tick positions.
// Everything stays in ticks so the rhythm can be quantised independently of
// the tempo map (see midi-to-strudel.js).
//
// Why not @tonejs/midi: its track constructor pairs every note-on with its
// note-off by scanning (and splicing) the remaining note-offs, which is
// quadratic in notes-per-track — a 20 000-note track froze the tab for
// seconds. Pairing here is a per-pitch FIFO, so reading is linear.
//
// Pure, no DOM. Throws an Error with a human-readable message for anything
// that is not a readable tick-based Standard MIDI File.

/**
 * @typedef {object} SmfNote
 * @property {number} midi           0–127
 * @property {number} ticks          onset, in ticks from the start of the file
 * @property {number} durationTicks  always > 0
 * @property {number} velocity       0–1
 */

/**
 * @typedef {object} SmfTrack
 * @property {string} name          track name meta event ("" when absent)
 * @property {number} channel       0–15 (9 = GM percussion)
 * @property {number} program       first program change on the channel (0 when absent)
 * @property {boolean} hasProgram   whether the channel carried a program change at all
 * @property {SmfNote[]} notes      sorted by onset
 */

/**
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {{
 *   format: number,
 *   ppq: number,
 *   name: string,
 *   tempos: { ticks: number, bpm: number }[],
 *   timeSignatures: { ticks: number, timeSignature: [number, number] }[],
 *   tracks: SmfTrack[],
 * }}
 */
export function readSmf(buffer) {
  const bytes =
    buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(/** @type {ArrayBuffer} */ (buffer));

  if (bytes.length < 14 || chunkId(bytes, 0) !== "MThd") {
    throw new Error("not a Standard MIDI File (missing MThd header)");
  }
  const headerLength = u32(bytes, 4);
  const format = u16(bytes, 8);
  const division = u16(bytes, 12);
  if (division & 0x8000) {
    throw new Error("SMPTE-timed MIDI files are not supported");
  }
  if (division === 0) {
    throw new Error("invalid MIDI header (zero ticks per quarter note)");
  }

  const tempos = [];
  const timeSignatures = [];
  const rawTracks = [];
  let truncated = false;

  let pos = 8 + headerLength;
  while (pos + 8 <= bytes.length) {
    const id = chunkId(bytes, pos);
    const length = u32(bytes, pos + 4);
    const start = pos + 8;
    // A truncated final chunk is read as far as it goes.
    const end = Math.min(start + length, bytes.length);
    if (id === "MTrk" && start + length > bytes.length) truncated = true;
    if (id === "MTrk") {
      rawTracks.push(readTrack(bytes, start, end, tempos, timeSignatures));
    }
    pos = start + length;
  }

  if (rawTracks.length === 0) {
    throw new Error("MIDI file contains no tracks");
  }

  // Tempo / time-signature events can live in any track; the per-track reads
  // above append them track by track, so restore file order.
  tempos.sort((a, b) => a.ticks - b.ticks);
  timeSignatures.sort((a, b) => a.ticks - b.ticks);

  const tracks = [];
  rawTracks.forEach((raw, rawIndex) => {
    const channels = [...raw.channels.keys()]
      .filter((ch) => raw.channels.get(ch).notes.length > 0)
      .sort((a, b) => a - b);

    if (channels.length === 0) {
      // In a format-1 file the first track is the conductor track (tempo
      // map, no notes) — not something to offer for import.
      if (format === 1 && rawIndex === 0) return;
      const firstChannel = raw.channels.keys().next().value ?? 0;
      const state = raw.channels.get(firstChannel);
      tracks.push({
        name: raw.name,
        channel: firstChannel,
        program: state?.program ?? 0,
        hasProgram: state?.program != null,
        notes: [],
      });
      return;
    }

    // One output track per channel: a format-0 file keeps every instrument
    // in a single MTrk, and mixing them would produce one unreadable part.
    for (const channel of channels) {
      const state = raw.channels.get(channel);
      state.notes.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
      const base = raw.name;
      tracks.push({
        name:
          channels.length > 1
            ? `${base || "Track"} ch${channel + 1}`
            : base,
        channel,
        program: state.program ?? 0,
        hasProgram: state.program != null,
        notes: state.notes,
      });
    }
  });

  return {
    format,
    ppq: division,
    name: rawTracks[0].name,
    tempos,
    timeSignatures,
    tracks,
    truncated,
  };
}

function readTrack(bytes, start, end, tempos, timeSignatures) {
  /** @type {Map<number, { program: number | null, notes: SmfNote[], open: Map<number, {ticks: number, velocity: number}[]> }>} */
  const channels = new Map();
  let name = "";
  let hasName = false;
  let ticks = 0;
  let pos = start;
  let runningStatus = 0;

  const channelState = (ch) => {
    let state = channels.get(ch);
    if (!state) {
      state = { program: null, notes: [], open: new Map() };
      channels.set(ch, state);
    }
    return state;
  };

  const readVarInt = () => {
    let value = 0;
    while (pos < end) {
      const b = bytes[pos++];
      value = value * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return value;
  };

  const closeNote = (state, midi, offTicks) => {
    const queue = state.open.get(midi);
    if (!queue || queue.head >= queue.items.length) return;
    // Oldest unmatched note-on first, the same pairing a sequencer applies.
    // The queue is consumed through a head index: shift() would make a track
    // of unterminated note-ons quadratic.
    const on = queue.items[queue.head++];
    // Drum tracks routinely pair note-on and note-off on the same tick; such
    // a hit is still a note, so it keeps the shortest representable length.
    const durationTicks = Math.max(1, offTicks - on.ticks);
    state.notes.push({
      midi,
      ticks: on.ticks,
      durationTicks,
      velocity: on.velocity,
    });
  };

  while (pos < end) {
    ticks += readVarInt();
    if (pos >= end) break;
    let status = bytes[pos];

    if (status === 0xff) {
      // Meta event: type, length, data.
      const type = bytes[pos + 1];
      pos += 2;
      const length = readVarInt();
      const dataStart = pos;
      pos += length;
      if (pos > end) break;
      if (type === 0x03 && !hasName) {
        name = latin1(bytes, dataStart, length);
        hasName = true;
      } else if (type === 0x51 && length === 3) {
        const usPerBeat =
          (bytes[dataStart] << 16) |
          (bytes[dataStart + 1] << 8) |
          bytes[dataStart + 2];
        if (usPerBeat > 0) tempos.push({ ticks, bpm: 60000000 / usPerBeat });
      } else if (type === 0x58 && length >= 2) {
        timeSignatures.push({
          ticks,
          timeSignature: [bytes[dataStart], 1 << bytes[dataStart + 1]],
        });
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      // SysEx / escape: length-prefixed, skipped. It also cancels running
      // status. (The length must be read before advancing — `pos +=
      // readVarInt()` would add it to the position from before the read.)
      pos += 1;
      const length = readVarInt();
      pos += length;
      runningStatus = 0;
      continue;
    }

    if (status & 0x80) {
      pos += 1;
      runningStatus = status;
    } else {
      // Running status: this byte is already the first data byte.
      if (!runningStatus) {
        throw new Error("corrupt MIDI track (data byte without a status byte)");
      }
      status = runningStatus;
    }

    const kind = status & 0xf0;
    const channel = status & 0x0f;
    if (kind === 0xf0) {
      throw new Error(
        `corrupt MIDI track (unexpected status byte 0x${status.toString(16)})`,
      );
    }
    const data1 = bytes[pos++];
    // Program change and channel pressure carry one data byte, the rest two.
    const data2 = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[pos++];
    if (pos > end) break;

    if (kind === 0x90 && data2 > 0) {
      const state = channelState(channel);
      let queue = state.open.get(data1);
      if (!queue) {
        queue = { items: [], head: 0 };
        state.open.set(data1, queue);
      }
      queue.items.push({ ticks, velocity: data2 / 127 });
    } else if (kind === 0x80 || kind === 0x90) {
      closeNote(channelState(channel), data1, ticks);
    } else if (kind === 0xc0) {
      const state = channelState(channel);
      if (state.program == null) state.program = data1;
    }
  }

  // A note-on that never got its note-off rings until the end of the track
  // rather than vanishing from the import.
  for (const state of channels.values()) {
    for (const [midi, queue] of state.open) {
      while (queue.head < queue.items.length) closeNote(state, midi, ticks);
    }
  }

  return { name, channels };
}

/**
 * Build a ticks → seconds converter for a tempo map. Before the first tempo
 * event the MIDI default of 120 BPM applies.
 *
 * @param {{ ticks: number, bpm: number }[]} tempos sorted by ticks
 * @param {number} ppq
 * @returns {(ticks: number) => number}
 */
export function makeTicksToSeconds(tempos, ppq) {
  // Segment i covers [segTicks[i], segTicks[i+1]) at segRate[i] seconds/tick.
  const segTicks = [0];
  const segSeconds = [0];
  const segRate = [60 / (120 * ppq)];
  for (const { ticks, bpm } of tempos) {
    const last = segTicks.length - 1;
    const rate = 60 / (bpm * ppq);
    if (ticks <= segTicks[last]) {
      // Same tick as the previous event: the later one wins.
      segRate[last] = rate;
      continue;
    }
    segSeconds.push(
      segSeconds[last] + (ticks - segTicks[last]) * segRate[last],
    );
    segTicks.push(ticks);
    segRate.push(rate);
  }

  return (ticks) => {
    let lo = 0;
    let hi = segTicks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segTicks[mid] <= ticks) lo = mid;
      else hi = mid - 1;
    }
    return segSeconds[lo] + (ticks - segTicks[lo]) * segRate[lo];
  };
}

/**
 * The tempo that is in force for the largest share of the music, measured in
 * ticks between the start of the file and `endTicks`. A pattern has a single
 * `setcpm`, so this is the tempo an imported multi-tempo file is played at:
 * a short count-in or a final ritardando does not decide the tempo of the
 * whole piece. Ties go to the earlier tempo; no tempo events means 120.
 *
 * @param {{ ticks: number, bpm: number }[]} tempos sorted by ticks
 * @param {number} endTicks
 * @returns {number}
 */
export function dominantTempo(tempos, endTicks) {
  if (tempos.length === 0) return 120;
  /** @type {Map<number, number>} bpm → ticks in force */
  const share = new Map();
  let best = null;
  let bestTicks = -1;
  let prevTicks = 0;
  let prevBpm = 120;
  const account = (bpm, from, to) => {
    const span = Math.max(0, Math.min(to, endTicks) - from);
    if (span <= 0) return;
    const total = (share.get(bpm) ?? 0) + span;
    share.set(bpm, total);
    if (total > bestTicks) {
      bestTicks = total;
      best = bpm;
    }
  };
  for (const { ticks, bpm } of tempos) {
    account(prevBpm, prevTicks, ticks);
    prevTicks = ticks;
    prevBpm = bpm;
  }
  account(prevBpm, prevTicks, endTicks);
  // Nothing sounded for a measurable span (empty or single-instant file).
  return best ?? tempos[0].bpm;
}

function chunkId(bytes, pos) {
  return String.fromCharCode(
    bytes[pos],
    bytes[pos + 1],
    bytes[pos + 2],
    bytes[pos + 3],
  );
}

function u16(bytes, pos) {
  return (bytes[pos] << 8) | bytes[pos + 1];
}

function u32(bytes, pos) {
  return (
    bytes[pos] * 0x1000000 +
    ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3])
  );
}

function latin1(bytes, start, length) {
  let out = "";
  for (let i = start; i < start + length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  // Names end up in generated code comments and labels: a control character
  // (a newline above all) must not be able to break out of the line.
  return out.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}
