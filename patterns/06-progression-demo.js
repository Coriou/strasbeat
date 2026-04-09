// 06-progression-demo — one-line chord progressions via progression()
// concepts: progression() helper, rhythm presets (block / arp-up / comp), bass layer

// progression() turns a string of chord symbols into a playable Strudel
// pattern, with sensible defaults for voicing, sound, and rhythm. The
// helper lives in src/strudel-ext/progression.js — see
// design/work/07-chord-progression.md for the spec.
//
// Try editing the rhythm name (block / strum / comp / arp-up / arp-down /
// alberti) to audition different feels on the same chord progression.

export default `
setcpm(110/4)

// the 80% case: one line, one chord progression, audible chords.
keys: progression("Cm7 F7 Bb^7 Eb^7")
  .room(0.4)
  .gain(0.55)

// arp-up rhythm: each chord arpeggiates upward across the cycle.
lead: progression("Cm7 F7 Bb^7 Eb^7", { rhythm: "arp-up" })
  .slow(2)
  .delay(0.4).delaytime(0.375).delayfeedback(0.3)
  .gain(0.35)

// comp rhythm + bass layer: jazz-style off-beat stabs with a walking root.
// Pass a custom bass sound to override the default gm_acoustic_bass —
// gm_electric_bass_finger is the real GM name (gm_fingered_bass doesn't
// exist; see CLAUDE.md "Sound names are NOT 1:1 with General MIDI").
bass_and_comp: progression("Cm7 F7 Bb^7 Eb^7", {
  rhythm: "comp",
  bass: "gm_electric_bass_finger",
}).gain(0.6)

// drums round it out
drums: s("bd*2, ~ sd:1, hh*8")
  .bank("RolandTR909")
  .gain(0.7)
`;
