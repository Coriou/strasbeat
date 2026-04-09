// 03-breakbeat — chopped amen + acid bass
// concepts:
//   n("0 1 2 …").s("amencutup")  step through slices of a sliced break
//   .sometimes(fn) / .rarely(fn) probabilistic transformation
//   .ply(2)                      stutter each event twice
//   .jux(rev)                    pan-split & reverse one side
//   sine.range(a,b)              continuous LFO between a and b

export default `setcps(140/60/4)

stack(
  // amen break, mangled
  n("0 1 2 3 4 5 6 7")
    .s("amencutup")
    .sometimes(x => x.ply(2))
    .rarely(x => x.speed("2 | -2"))
    .room(0.4),

  // acid 303-style bass
  note("c2 c2 eb2 c2 g1 c2 bb1 c2")
    .s("sawtooth")
    .lpf(sine.range(300, 2500).slow(6))
    .lpq(15)
    .decay(0.1).sustain(0)
    .gain(0.6),
)
  .jux(rev)
`;
