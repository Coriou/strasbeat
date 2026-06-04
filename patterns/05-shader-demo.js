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
//
// …BUT a single-quoted string can't span multiple physical lines, and the
// transpiler ALSO rewrites backtick template literals into mini('…') — so a
// `multi-line backtick` shader source is NOT safe either. The transpiler-safe
// way to write a readable multi-line shader is to CONCATENATE single-quoted
// lines with '+', each line ending in '\n'. Every piece stays single-quoted
// (so none gets mini-rewritten), it parses as plain JS, and the \n keep GLSL
// line numbers intact in compile errors. See shader()'s JSDoc + CLAUDE.md.

export default `await shader(
  'precision mediump float;\\n' +
  'uniform float uKick;\\n' +
  'uniform float uSnare;\\n' +
  'uniform float uMelody;\\n' +
  'uniform vec2 uResolution;\\n' +
  'uniform float uTime;\\n' +
  'void main() {\\n' +
  '  vec2 uv = gl_FragCoord.xy / uResolution;\\n' +
  '  float r = 0.2 + uKick * 0.6;\\n' +
  '  float g = 0.1 + uSnare * 0.5 + uMelody * 0.3;\\n' +
  '  float b = 0.4 + 0.2 * sin(uTime + uv.x * 6.28);\\n' +
  '  gl_FragColor = vec4(r, g, b, 1.0);\\n' +
  '}\\n'
)

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
