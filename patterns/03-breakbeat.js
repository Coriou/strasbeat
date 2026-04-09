// 03-breakbeat — chopped amen + acid bass
// concepts: amencutup slicing, .sometimes/.rarely probabilistic transforms, .jux(rev) stereo split

export default `
setcpm(140/4)

amen: n("0 1 2 3 4 5 6 7")
  .s("amencutup")
  .sometimes(x => x.ply(2))
  .rarely(x => x.speed("2 | -2"))
  .room(0.4)
  .jux(rev)

bass: note("c2 c2 eb2 c2 g1 c2 bb1 c2")
  .s("sawtooth")
  .lpf(sine.range(300, 2500).slow(6))
  .lpq(15)
  .decay(0.1).sustain(0)
  .gain(0.6)
  .jux(rev)
`;
