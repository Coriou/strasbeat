// 04-melody — chords + arpeggio + drums, using the soundfont GM bank
// concepts:
//   .scale("C:minor")    snap n() to a scale (n is scale-degree, not pitch)
//   .arp("…")            arpeggiate a chord using a step pattern
//   .voicings('lefthand') auto-voice chord symbols
//   gm_…                 General MIDI soundfont instruments

export default `setcps(96/60/4)

stack(
  // chord pad — voiced and arpeggiated
  "<Cm9 Fm9 Bb^7 Eb^7>"
    .voicings('lefthand')
    .note()
    .s('gm_epiano1')
    .arp("0 1 2 3 2 1")
    .release(0.4)
    .room(0.4)
    .gain(0.7),

  // melody on top
  n("<0 2 4 7 6 4 2 0>*2")
    .scale("C4:minor:pentatonic")
    .s('gm_lead_2_sawtooth')
    .lpf(2000)
    .gain(0.5)
    .delay(0.5).delaytime(0.375).delayfeedback(0.4),

  // light groove underneath
  s("bd ~ ~ bd, ~ sd ~ sd, hh*8").bank('RolandTR707').gain(0.7),
)
  .room(0.3)
`;
