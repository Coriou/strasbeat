export default `setcpm(120 / 4)

drums: stack(
  s("bd*2").bank("casiorz1").gain(0.9),
  s("~ sd ~ sd").bank("casiorz1"),
  s("~ ~ ~ oh").bank("RolandTR909").gain(0.3),
  s("hh*8").bank("doepferms404").gain(0.45).pan(sine.fast(4)),
)

const chords = 'Cm7 F7 Bb^7 Eb^7'

melody: stack(
  progression(chords).room(0.3).gain(0.5),
  progression(chords, { rhythm: 'arp-up' })
    .delay(0.3)
    .delaytime(0.375)
    .gain(0.35),
)

choir: stack(
  progression(chords, { rythm: "comp" })
    .s("gm_choir_aahs")
    .room(0.75)
    .gain(0.5)
    .pan(sine.slow(2)),
)

bass: stack(
  progression(chords, { rhythm: 'comp', bass: true }),
  progression(chords, { style: 'jazz-comp', bass: true }),
)
  .s("gm_piano")
  .attack("<0.75 0.5>")
  .sustain(0.75)
  .pan(sine.fast(2))
  .rev()
`;
