// 05-chords — c maj7, f dim, c maj7, f#
// one chord per cycle, voiced via 'legacy' (handles triads + sevenths)

export default `setcps(160/60/4)

"<C^7 Fo7 C^7 F#>"
  .voicings('legacy')
  .note()
  .arp("0 1 2 3")
  .s('sawtooth')
  .release(2)
  .room(0.9)
  .chorus(0.6)
  .gain(isaw.range(0, 0.6).fast(4))
`;
