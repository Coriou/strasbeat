// Style presets for progression() — each one bundles a sound, a voicing
// dictionary, a rhythm preset, and a small set of FX defaults so the user
// can audition a "vibe" with one option.
//
// Adding a style: drop a new entry into STYLES with the same shape. The
// `fx` keys are Strudel chain method names (.room, .gain, .lpf, etc.) and
// the values are whatever those methods accept. progression.js applies
// them as the very last step in the chain, so anything the user appends
// (`.gain(0.5)` etc.) still wins.
//
// **Sound name verification (Phase 2 spec requirement):** every default
// sound below was probed at runtime via strasbeat.hasSound(...) in the
// dev server before this file was committed. The original spec listed
// `gm_acoustic_guitar` for `folk-strum`, but that name does NOT resolve
// in @strudel/soundfonts — only `gm_acoustic_guitar_nylon` and
// `gm_acoustic_guitar_steel` exist. Substituted to `_nylon` (more typical
// for folk strumming).
//
// Verified present in @strudel/soundfonts/gm.mjs (1046 sounds total):
//   gm_epiano1, gm_pad_warm, gm_acoustic_guitar_nylon, gm_piano

export const STYLES = {
  "jazz-comp": {
    sound: "gm_epiano1",
    dict: "ireal",
    rhythm: "comp",
    fx: { room: 0.4, gain: 0.65 },
  },
  "pop-pad": {
    sound: "gm_pad_warm",
    dict: "ireal",
    rhythm: "block",
    fx: { room: 0.6, attack: 0.4 },
  },
  "lo-fi": {
    sound: "gm_epiano1",
    dict: "lefthand",
    rhythm: "arp-up",
    fx: { room: 0.5, lpf: 1500 },
  },
  "folk-strum": {
    // spec listed gm_acoustic_guitar; that name doesn't exist — see header
    sound: "gm_acoustic_guitar_nylon",
    dict: "triads",
    rhythm: "strum",
    fx: { room: 0.2 },
  },
  "piano-bare": {
    sound: "gm_piano",
    dict: "ireal",
    rhythm: "block",
    fx: { room: 0.3 },
  },
};
