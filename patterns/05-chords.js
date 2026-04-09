// 05-chords — C^7, Fo7, C^7, F# arpeggiated through 'legacy' voicings
// concepts: chord().dict().voicing() chain, .arp() chord stepping, isaw gain swell

export default `
setcpm(160/4)

chords: chord("<C^7 Fo7 C^7 F#>")
  .dict("legacy")
  .voicing()
  .arp("0 1 2 3")
  .s("sawtooth")
  .release(2)
  .room(0.9)
  .chorus(0.6)
  .gain(isaw.range(0, 0.6).fast(4))
`;
