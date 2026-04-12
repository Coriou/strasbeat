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
)

const chords = 'C Am C G'
const chords_alt_a = 'C ~ C ~'
const chords_alt_b = '~ Am ~ G'

melo: stack(
  progression(chords).room(0.7).roomsize(2).s("gm_lead_8_bass_lead").lpf(800),

  stack(
    progression(chords_alt_a)
      .s("gm_pad_poly")
      .lpf(sine.range(1000, 800))
      .pan(sine.slow(4)),
    progression(chords_alt_b)
      .s("gm_pad_poly")
      .lpf(sine.range(800, 1000))
      .pan(sine.slow(8)),
  )
    .lpdepth(0.25)
    .lpdc(2)
    .lpa(0.5)
    .lpenv("<3 2 1 0 -1 -2 -4>/4")
    .gain(sine.range(0.5, 0.75)),
)
  .slice(2, "0 1 <2 2> 3")
  .gain(sine.range(0.7, 0.9))

bells: progression(chords)
  .slice(2, "0 1 <2 2> 3")
  .decay(0.25)
  .sustain(0.9)
  .s("gm_tubular_bells")
  .lpf(sine.range(800, 1200))
  .pan(sine.slow(4))
  .gain(0.5)

choir: stack(
  progression(chords_alt_a)
    .slice(2, "0 1 <2 2> 3")
    .s("gm_choir_aahs")
    .pan(sine.slow(8)),
  progression(chords_alt_b)
    .slice(2, "0 1 <2 2> 3")
    .s("gm_choir_aahs")
    .decay(0.3)
    .sustain(0.9)
    .pan(sine.slow(2)),
).gain(0.5)
`;
