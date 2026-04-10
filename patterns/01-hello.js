export default `setcpm(110 / 4)

drums: stack(
  s("bd*4"),
  s("~ sd ~ sd"),
  s("hh*8").gain(0.5),
).mask("<1 1 1 0>")

bass: note("[b2, e3, ~, b3]*8".add("<0 <1 -1>>"))
  .s("gm_acoustic_bass")
  .lpf(sine.range(2200, 2600).slow(8))
  .attack(0.1)
  .decay(0.1)
  .sustain(0.5)
  .release(0.2)
  .room(0.5)

lead: stack(
  note("c3 e3 g3 b3".add("<0 <1 -1>>")).s("gm_electric_guitar_muted").gain(2),
  note("c3 e3 g3 b3").s("gm_voice_oohs").gain(2),
  note("~ ~ ~ b5").s("triangle").gain(0.05),
  note("~ e2 ~ b2").s("gm_acoustic_bass").gain(2),
)

leadrev: note("c3 e3 g3 b3")
  .s("gm_voice_oohs")
  .gain(0.5)
  .pan(sine.slow(2))
  .rev()
`;
