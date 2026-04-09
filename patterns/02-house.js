// 02-house — classic 909 house groove with a bassline
// concepts:
//   .bank('RolandTR909')   swap the drum machine (try TR808, TR707, …)
//   note("…")              pitched events; numbers are MIDI-style names
//   .s("sawtooth")         pick a synth waveform
//   .lpf / .lpq / .room    filter cutoff, resonance, reverb
//   <a b c>                alternates per cycle — bass note moves around

export default `setcps(124/60/4)

stack(
  // drums
  s("bd*4").bank('RolandTR909').gain(1.1),
  s("~ cp").bank('RolandTR909'),
  s("hh*8").bank('RolandTR909').gain(0.5),
  s("~ ~ ~ oh").bank('RolandTR909').gain(0.6),

  // bass — one note per 8th, alternating root every cycle
  note("<c2 c2 eb2 g2>*8")
    .s("sawtooth")
    .lpf(sine.range(400, 1400).slow(8))
    .lpq(8)
    .decay(0.12).sustain(0)
    .gain(0.7),
)
  .room(0.2)
`;
