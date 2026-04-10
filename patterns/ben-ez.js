export default `setcps(120 / 60 / 4)

drums: stack(
  s("bd sd bd sd").bank("akailinn"),
  s("bd sd bd sd")
    .bank("akaixr10")
    .pan(sine.slow(4))
    .gain("0.25"),
  s("hh*8"),
)

const chords = 'C^ Am7 Dm7 G7'

lead: progression(chords, { style: 'jazz-comp', bass: true })
  .s("gm_koto")
  .lpf("1200")
  .gain("1")

leadback: progression(chords, { style: 'jazz-comp', bass: true })
  .s("gm_english_horn")
  .lpf("2400")
  .gain("0.75")
  .pan(sine.slow(4))

chorus: progression(chords, { style: 'jazz-comp', bass: true })
  .s("gm_voice_oohs")
  .room("0.75")
  .lpf("800")
  .gain("1")
  .pan(sine.slow(2))

leadrev: progression(chords, { style: 'lo-fi', bass: false })
  .s("gm_synth_bass_2")
  .lpf("800")
  .gain("0.75")
  .pan(sine.slow(8))
  .rev()
`;
