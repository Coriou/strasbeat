// 04-melody — chords + arpeggio + drums on a soundfont bank
// concepts: .voicing() chord auto-voicing, .scale() scale-degree melodies, signal-modulated lpf

export default `
setcpm(96/4)

keys: chord("<Cm9 Fm9 Bb^7 Eb^7>")
  .dict("lefthand")
  .voicing()
  .arp("0 1 2 3 2 1")
  .s("gm_epiano1")
  .release(0.4)
  .room(0.4)
  .gain(0.7)

lead: n("<0 2 4 7 6 4 2 0>*2")
  .scale("C4:minor:pentatonic")
  .s("gm_lead_2_sawtooth")
  .lpf(perlin.range(1200, 2800).slow(8))
  .delay(0.5).delaytime(0.375).delayfeedback(0.4)
  .gain(0.5)
  .room(0.3)

drums: s("bd ~ ~ bd, ~ sd ~ sd, hh*8")
  .bank("RolandTR707")
  .gain(0.7)
  .room(0.3)
`;
