export default `setcpm(160 / 4)

drums: stack(
  s("bd hh sd oh"),
  s("hh*8").gain(0.5),
)

chords: chord("<C^7 Fo7 C^7 F#>")
  .s("sawtooth")
  .release(2)
  .room(0.9)
  .chorus(0.6)
  .gain(isaw.range(0, 0.6).fast(4))
`;
