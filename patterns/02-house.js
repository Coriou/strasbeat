// 02-house — classic 909 house groove with a bassline
// concepts: .bank() drum machine, named blocks, signal-modulated lpf

export default `
setcpm(124/4)

drums: stack(
  s("bd*4").gain(1.1),
  s("~ cp"),
  s("hh*8").gain(0.5),
  s("~ ~ ~ oh").gain(0.6),
).bank("RolandTR909").room(0.2)

bass: note("<c2 c2 eb2 g2>*8")
  .s("sawtooth")
  .lpf(sine.range(400, 1400).slow(8))
  .lpq(8)
  .decay(0.12).sustain(0)
  .gain(0.7)
  .room(0.2)
`;
