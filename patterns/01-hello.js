export default `setcpm(110/4)

$: s("bd*4").mask("<1 1 1 0>")
$: s("~ sd ~ sd").mask("<1 1 1 0>")
$: s("hh*8").gain(0.5).mask("<1 1 1 0>")

$: note("c3 e3 g3 b3").s("gm_electric_guitar_muted").add("<0 <1 -1>>").gain(2)
$: note("c3 e3 g3 b3").s("gm_voice_oohs").gain(2)
$: note("~ ~ ~ b5").s("triangle").gain(0.5)
$: note("~ e3 ~ b5").s("gm_acoustic_bass").gain(2)

$: note("[b5, e3, ~, b3]*8".add("<0 <1 -1>>"))
  .s("gm_acoustic_bass")
  .lpf(sine.range(2200, 2600).slow(8))
  .attack(0.1).decay(0.1).sustain(0.5).release(0.2)
  .room(0.5)
  .gain(2)
  .mask("<0 0 0 1 1 1 1 1>")
`;
