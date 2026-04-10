export default `setcps(120 / 60 / 4)

$: note("b5 c2 c2 b4").s("bossdr55_bd")
$: note("c2*8").s("hh")

lead: progression('C^ Am7 Dm7 G7', { style: 'jazz-comp', bass: true })
  .s("gm_lead_2_sawtooth")
  .lpf("2400")
  .gain("1")

chorus: progression('C^ Am7 Dm7 G7', { style: 'jazz-comp', bass: true })
  .s("gm_lead_6_voice")
  .room("0.75")
  .lpf("800")
  .gain("1")

leadrev: progression('C^ Am7 Dm7 G7', { style: 'jazz-comp', bass: false })
  .s("gm_synth_bass_2")
  .lpf("800")
  .gain("0.75")
  .pan(sine.slow(2))
  .rev()


`;
