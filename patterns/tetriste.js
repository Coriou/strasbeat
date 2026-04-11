export default `setcps(90 / 60 / 4)

drums: stack(
  sound("[bd ~ sd ~]*2"),
  sound("ht/2 ~ mt*2 mt/2"),
  sound("hh*4").pan(sine.slow(2)),
)

const melody = note(
  cat(
    "[e5 [b4 c5] d5 [c5 b4]]",
    "[a4 [a4 c5] e5 [d5 c5]]",
    "[b4 [~ c5] d5 e5]",
    "[c5 a4 a4 ~]",
    "[[~ d5] [~ f5] a5 [g5 f5]]",
    "[e5 [~ c5] e5 [d5 c5]]",
    "[b4 [b4 c5] d5 e5]",
    "[c5 a4 a4 ~]",
  ),
)

const bass = note(
  cat(
    "[[e2 e3]*4]",
    "[[a2 a3]*4]",
    "[[g#2 g#3]*2 [e2 e3]*2]",
    "[a2 a3 a2 a3 a2 a3 b1 c2]",
    "[[d2 d3]*4]",
    "[[c2 c3]*4]",
    "[[b1 b2]*2 [e2 e3]*2]",
    "[[a1 a2]*4]",
  ),
)

lead: stack(
  stack(melody, bass).s("gm_synth_choir"),
  stack(melody).s("gm_choir_aahs"),
  stack(melody).s("gm_pad_choir"),
)
  .room(0.7)
  .crush(12)
  .coarse(3)

bassrev: stack(bass)
  .s("gm_acoustic_bass")
  .rev()
  .delay(0.25)
  .sustain(0.75)
  .decay(0.75)
`;
