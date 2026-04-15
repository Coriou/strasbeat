export default `// https://www.strudelmarket.com/
// "spashiventur" @by Vigorous.Elbows
setcpm(20)

var chords = chord("<[Fm7 Fm Cm Gm]>".slow(4))

var start = n("0 1 2 3 4 5 6 7".fast(2)).s("gm_synth_bass_1:3")

var main = n("0 1 2 3 4 5 6 7".fast(2))
  .set(chords.anchor("c4"))
  .voicing()
  .s("gm_synth_bass_1:3")
  .orbit(2)
  .gain(0.6)
  .color("orange")
  .room(1)
  .delay(0.5)
//._punchcard()

var bass = n("2")
  .set(chords.anchor("c3"))
  .voicing()
  .s("gm_synth_bass_2:4")
  //.seg(16)
  .struct("- x x x x x x x".fast(2))
  .clip(0.9)
  .color("salmon")
  .orbit(2)
// ._punchcard()

var bass3 = n("2")
  .set(chords.anchor("c3"))
  .voicing()
  .s("gm_synth_bass_2:4")
  //.seg(16)
  .struct("- x - x - x - x".fast(2))
  .clip(0.9)
  .color("salmon")
  .orbit(2)
// ._punchcard()

var bass1 = n("2")
  .set(chords.anchor("c3"))
  .voicing()
  .s("gm_synth_bass_2:4")
  //.seg(16)
  .color("salmon")
  .orbit(2)
  .gain(1)
// ._punchcard()

var lead = n("8 [8 9] <8!3 [8 [9 8]]>")
  .set(chords.anchor("c3"))
  .superimpose((x) => x.anchor("c4").gain(0.5))
  .voicing()
  .s("supersaw, saw")
  .seg(16)
  .clip(0.9)
  .color("pink")
  .postgain(0.7)
  .room(0.7)
// ._punchcard()

var bd = s("bd:6").color("white")
// ._punchcard()

var drums = stack(
  s("bd:6").struct("x - - - x x - <-!7 x> x - - <-!7 x> x <x!7 -> - <x ->"),
  s("sd:9").struct("- - x - - - x - - <-!7 x> x - - <-!7 x> x <- <x!3 x*2>>"),
)
  .color("teal")
  .gain(0.6)
//._punchcard()

var hat = s("[hh:3 oh:2*<1!7 2> ]").fast(8).lpf(2900).pan(".3 .6".fast(4))

var snareOpen = s("sd:9").struct("<[-]!3 [- - - - - - - - - - - - - x x x*2]>")
//._punchcard()

$: s("- sd:9*<1!15 <2 4>>, [hh:3 oh:2 ]*2").fast(4).lpf(2000).color("gold")

// var chain = s("silence".fast(2)).duck(3)._punchcard()

$: stack(s("crackle").gain(2), s("pink").gain(0.3)).lpf("4000").slow(16)

$: arrange(
  //[1,stack(lead)],
  [1, stack(main, bass, lead, drums, bd).gain(0)],
  [4, main],
  [4, stack(main, bd.fast(2))],
  [4, stack(main, bass1, bd.fast(4))],
  [4, stack(main, bass1, snareOpen, bd.fast(8))],
  [4, stack(main, bass, drums, hat)],
  [4, stack(main, bass, drums, hat)],
  [4, stack(main.gain(0.3), lead, hat.slow(2)).room(1)],
  [4, stack(main, lead, drums.slow(2), hat.slow(2)).room(1)],
  [4, stack(main, bass3, lead, drums, hat)],
  [4, stack(main, bass3, lead, drums, hat)],
  [4, stack(drums, bass, main, hat)],
  [4, stack(drums, main)],
  [1, bd],
  [1, silence],
)
  .cutoff(perlin.range(2000, 5000).slow(4))
  .punchcard()
`;
