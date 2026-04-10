export default `// untitled-mnt2bya1
setcps(120 / 60 / 4)

drums: stack(
  sound("bd ~ sd ~"),
  sound("~ [bd*2,bd] [bd*2] ~").s("808bd").pan(sine.slow(2)),
  sound("~ [sd*2,sd] [sd*2] ~").s("808sd").pan(sine.slow(2)),
  sound("[hh*2] hh [hh,hh] [hh]*2")
    .pan(sine.slow(2))
    .hpf(800)
    .crush("<16 8 8 6 6 8 8 8>"),
  sound("hh*8")
    .gain("0.25")
    .sometimesBy(0.25, (x) => x.gain("0.5"))
    .sometimesBy(0.25, (x) => x.pan("2")),
)

const chords = 'Am F C G'

choirs: progression(chords)
  .sound("gm_choir_aahs")
  .room(0.25)
  .roomfade(1)
  .lpf(400)
  .rev()

choirsback: progression(chords)
  .sound("gm_fx_echoes")
  .room(0.9)
  .roomfade(1)
  .lpf(800)
  .pan(sine.slow(2))
  .gain(0.5)
  .delay(0.25)
  .rev()

bass: progression(chords)
  .s("gm_acoustic_bass")
  .gain(0.25)
  .room(0.75)
  .roomfade(0.5)
  .lpf(1200)
  .lpenv(4)

bassroom: progression(chords)
  .s("<[gm_acoustic_bass, gm_alto_sax]*8 [gm_acoustic_bass]*4>")
  .rev()
  .room(0.25)
  .roomfade(1)
  .lpf(200)
  .lpskew(2)
  .lpd(0.5)
  .lps("<0.25 .25 .5 1>*4")
  .lpenv(4)
  .attack("<0.25 0.5 0.25>")
  .sustain("<0.85 0.7 0.85>")
  .gain(0.75)
  .delay(1)
`;
