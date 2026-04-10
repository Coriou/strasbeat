export default `setcps(120 / 60 / 4)

drums: stack(
  sound("bd ~ sd ~"),
  sound("[mt ~ ht*2 ~]*2").pan(sine.slow(2)),
  sound("~ ~ sd ~").bank("akailinn").pan(sine.slow(2)),
  sound("[hh hh*2 hh*2 ~]*2"),
)

// F7/G Am7 Dm Bb
// F C Am G
// Abm Gb Db Db
// F Dm7 Gsus G
// Dm7	G7	C^	C^
// Cm7 G7 Cm7 G7
const chords = 'Abm Gb Db Db'

lead: progression(chords, {
  bass: true,
  rhythm: "block",
})
  .s("gm_lead_1_square")
  .room("0.25")
  .decay("0.25")
  .sus("0.9")
  .lpf("400")
  .pan(sine.slow(1))

leadback: progression(chords, {
  bass: true,
  rhythm: "block",
})
  .s("gm_bassoon")
  .room("0.5")
  .lpf("200")
  .pan(sine.slow(4))
  .mask("<1 1 1 0>")
  .gain(0.75)
  .rev()

choirs: progression(chords, {
  bass: true,
  rhythm: "strum",
})
  .s("gm_choir_aahs")
  .lpf("1200")

`;
