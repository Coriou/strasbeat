export default `setcpm(120 / 4)

drums: stack(
  s("bd ~ sd ~"),
  s("~ ~ ~ hh*2")
    .lpq(12)
    .decay("<.2 .3 .4 .5>")
    .sustain(0)
    .mask("<0 0 1 0 1 0 0 0 1 0 0 1 0 0 0 1>")
    .gain(0.25),
  s("[hh]/2 hh hh/2 hh"),
  s("808bd*2 ~ 808bd*1 808bd*2")
    .n("<C^7 Fo7 C^7 F#>")
    .add(sine.range(0, 2))
    .pan(sine.slow(2))
    .gain(0.25),
)

melo: progression('Am F C G')
  .slice(2, "0 1 <2 2> 3")
  .room(0.7)
  .roomsize(2)
  .s("bytebeat")
  .lpf(800)
`;
