export default `setcps(140 / 60 / 4)

drums: stack(
  sound("bd ~ sd ~"),
  sound("[mt,ht] ~ [mt,ht] ~"),

  sound("bd ~ rim ~").bank("oberheimdmx"),
  sound("hh*4"),

  // Jungle pattern
  sound("<bd ~ ~ bd>*8")
    .bank("sakatadpm48")
    .room(0.9)
    .roomdim(8000)
    .lpf(200)
    .pan(sine.slow(2)),
)

keys: progression('Cm7 F7 Bb^7 Eb^7')
  .velocity(sine.range(0.25, 0.75))
  .vib(0.025)
  .room(0.5)
  .gain(0.55)
  .hpf(400)
  .speed(0.5)

keysback: progression('Cm7 F7 Bb^7 Eb^7')
  .velocity(sine.range(0.25, 0.75))
  .s("gm_electric_guitar_clean")
  .vib(0.025)
  .room(0.5)
  .sustain(1)
  .gain(0.25)
  .lpf(1600)
  .speed(0.5)
  .delay(0.25)

keysrev: progression('Cm7 F7 Bb^7 Eb^7').gain(0.25).pan(sine.slow(2)).rev()
`;
