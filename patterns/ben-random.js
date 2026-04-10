export default `// default cps

drums: stack(note("b5 c2 c2 b4").s("bd"), note("c2*8").s("hh"))

const notes = "[c4, c3] [a4, a3] [f4, f3] [e4, e3]"

lead: note(notes)
  .s("supersaw")
  .lpf("2400")
  .room("0.2")
  .delay("<0 0 0 0.25 0.25 0.25 0.25>")
  .attack("<0 0 0 0.75 0.5 0.25 0.25>")
  .pan(sine.slow(2))
  .mask("<0 0 0 1 1 1 1>")
  .gain("0.8")

leadrev: note(notes)
  .s("supersaw")
  .lpf("800")
  .room("0.2")
  .pan(sine.slow(1))
  .mask("<1 1 0 0>")
  .rev()

leaddel: note(notes)
  .s("supersaw")
  .lpf("800")
  .room("0.2")
  .pan(sine.slow(1))
  .delay("<0 .25 .25 0.5>")
  .scale("c:minor")

leadbis: note(notes)
  .s("gm_lead_6_voice")
  .attack("<0.9 0.9 0.9 0.8>")
  .gain("<1 1.75 1.75 1.25>")
  .lpf("800")
  .scale("c:major")
  .room("<0.5 0.75>")
`;
