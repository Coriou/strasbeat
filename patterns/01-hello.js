export default `setcps(110/60/4)

stack(
  s("bd*4").mask("<1 1 1 0>"),
  s("~ sd ~ sd").mask("<1 1 1 0>"),
  s("hh*8").gain(0.5).mask("<1 1 1 0>"),

  note("48 52 55 59").sound("gm_electric_guitar_muted").add("<0 <1 -1>>").gain(2),
  note("48 52 55 59").sound("gm_voice_oohs").gain(2),
  note("~ ~ ~ b5").sound("triangle").gain(0.5),
  note("~ 52 ~ b5").sound("gm_acoustic_bass").gain(2),

  note("[b5, 52, ~, 59]*8".add("<0 <1 -1>>")).sound("gm_acoustic_bass")
  .lpf(2400).attack(.1).decay(.1).sustain(.5).release(.2).room(.5).gain(2).mask("<0 0 0 1 1 1 1 1>")
)
`;
