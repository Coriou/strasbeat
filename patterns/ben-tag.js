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
const chords = 'Abm Gb Db Db'

lead: progression(chords, {
  bass: true,
  rythm: "block",
})
  .s("gm_lead_1_square")
  .room("0.75")
  .decay("0.25")
  .sus("0.9")
  .lpf("800")
  .pan(sine.slow(1))
  .gain("1")

choirs: progression(chords, {
  bass: true,
  rythm: "strum",
})
  .s("gm_choir_aahs")
  .lpf("1200")

`;
