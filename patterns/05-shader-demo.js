// 05-shader-demo — Phase 2 smoke test: Shadertoy-style shader reacting to
// auto-uniforms (uKick/uSnare from bd/sd drum lanes) + explicit uMelody
// concepts: shader(), auto-uniforms, .uniform() override, note names, RolandTR909 drums
//
// Auto-uniform naming convention:
//   drum lanes:  bd → uKick, sd → uSnare, hh → uHat
//   any sound `name` → u_<name>  (non-alphanumerics become _)
//   note/n haps → uKeyVelocity
//   built-ins:   uTime, uResolution (always provided)
//   explicit:    .uniform({ dest: '<name>', gain, slow }) → named dest
//
// CRITICAL — THE SINGLE-QUOTE RULE (load-bearing):
//   shader('…')  and  { dest: '…' }  MUST use single quotes.
//   Strudel's transpiler rewrites every double-quoted string into mini('…'),
//   which would silently break string arguments to strasbeat helpers.
//   Drum/note mini-notation  s("…")  and  note("…")  stay DOUBLE-quoted
//   (the transpiler rewrite is correct for those). See CLAUDE.md.

export default `await shader('
  precision mediump float;
  uniform float uKick;
  uniform float uSnare;
  uniform float uMelody;
  uniform vec2 uResolution;
  uniform float uTime;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float r = 0.2 + uKick * 0.6;
    float g = 0.1 + uSnare * 0.5 + uMelody * 0.3;
    float b = 0.4 + 0.2 * sin(uTime + uv.x * 6.28);
    gl_FragColor = vec4(r, g, b, 1.0);
  }
')

setcpm(120/4)

$: s("bd*4, ~ sd, hh*8")
  .bank("RolandTR909")
  .gain(0.8)

$: note("c4 g4 f4 g4")
  .s("gm_lead_2_sawtooth")
  .decay(0.15).sustain(0)
  .gain(0.6)
  .uniform({ dest: 'uMelody', gain: 0.8, slow: 2 })
`;
