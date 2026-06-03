// strasbeat-original raw-WebGL shader node. Drop in a Shadertoy-style
// fragment shader; it compiles against a full-screen triangle and exposes
// named uniforms (built-in uTime/uResolution always; auto + explicit pattern
// uniforms wired in uniforms.js / Task 6).
//
// Discipline mirrors src/ui/scope.js and the Phase 1 hydra resource: lazy,
// idempotent, explicit teardown on stop / re-init / HMR dispose.
//
// Surface-failures-loudly (CLAUDE.md): compile failure logs loudly AND keeps
// the last-good program (no black screen, no teardown); WebGL context loss
// logs loudly and recompiles on restore.
//
// The single-quote rule + Pattern-input guard live in Task 6's edits to this
// file's exported shader() entry point.

import { getTime, Pattern } from "@strudel/core"; // uTime built-in; Pattern for .uniform()
import { getDeriver, _resetDeriver } from "./uniforms.js"; // shared onset→decay→uniform deriver

const CANVAS_ID = "strasbeat-shader-canvas";

const VERTEX_SRC = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// Full-screen triangle (3 verts covering the viewport).
const TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

let node = null; // singleton live node

// Time source for the uTime built-in. getTime() (the Strudel scheduler /
// audio-context clock) is the intended source — but it THROWS "no time set"
// until the scheduler has started (i.e. before the autoplay-unlock click),
// and draw() runs every rAF frame, so a raw call would throw on every frame
// of a bare shader. Mirror hydra.js's H() guard: try the scheduler clock,
// else fall back to a wall-clock seconds value so a bare shader still
// animates pre-scheduler instead of freezing or throwing.
// Consequence: uTime steps once (wall-clock → audio-context time) the instant
// the scheduler starts on first play. This is expected, not a glitch — a bare
// shader animating pre-play is worth the one-frame discontinuity.
function shaderTime() {
  try {
    return getTime();
  } catch {
    return performance.now() / 1000;
  }
}

function getOrCreateCanvas() {
  let cv = document.getElementById(CANVAS_ID);
  if (!cv) {
    cv = document.createElement("canvas");
    cv.id = CANVAS_ID;
    // Full-viewport, fixed, pointer-events:none — same posture as #hydra-canvas
    // so the same Visuals-mode clip approach can host it later.
    cv.style.cssText =
      "pointer-events:none;width:100%;height:100%;position:fixed;top:0;left:0;display:block;";
    document.body.prepend(cv);
  }
  return cv;
}

// Loud error reporting — console AND (when reachable) the in-app console panel.
let shaderErrorSink = null;
export function setShaderErrorSink(fn) {
  if (typeof fn === "function") shaderErrorSink = fn;
}
function reportShaderError(msg) {
  console.error(`[strasbeat] ${msg}`);
  try {
    shaderErrorSink?.(msg);
  } catch {
    /* never let logging crash the node */
  }
}

// Benign no-op node — returned when WebGL is unavailable so the editor never
// crashes (surface-failures-loudly: we log, we don't throw). Same shape as a
// live node; every method is a safe no-op.
function noopNode() {
  return {
    setFragment: () => false,
    setUniformMap: () => {},
    start: () => {},
    stop: () => {},
    hasProgram: () => false,
    canvasEl: null,
  };
}

function createNode() {
  const canvas = getOrCreateCanvas();
  const gl = canvas.getContext("webgl");
  if (!gl) {
    reportShaderError(
      "WebGL unavailable — shader node disabled (getContext('webgl') returned null)",
    );
    return noopNode();
  }

  let program = null;
  let lastGoodSrc = null;
  let uniformLocs = {};
  let rafId = null;
  let uniformMap = {}; // fed each frame by Task 6
  let lost = false;

  function compile(fragSrc) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VERTEX_SRC);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      reportShaderError(`fragment shader compile failed:\n${log}`);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      reportShaderError(`shader link failed:\n${gl.getProgramInfoLog(prog)}`);
      // Clean up everything we created on the failure path — otherwise a
      // run of failed compiles (live-editing a broken shader) leaks a
      // program + two shaders per attempt.
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(prog);
      return null;
    }
    // Link succeeded: the program retains the compiled code, so the shader
    // objects can be detached + freed. Without this, each successful
    // recompile (every keystroke once the shader is valid) leaks two shader
    // objects.
    gl.detachShader(prog, vs);
    gl.detachShader(prog, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  function setProgram(fragSrc) {
    const prog = compile(fragSrc);
    if (!prog) return false; // keep last-good program rendering
    // Free the previous program before swapping in the new one.
    if (program) gl.deleteProgram(program);
    program = prog;
    lastGoodSrc = fragSrc;
    uniformLocs = {};
    return true;
  }

  function setupGeometry() {
    // Buffer lifetime == the GL context's lifetime: reclaimed when clearShader
    // drops the canvas/context, so no explicit deleteBuffer is needed (unlike
    // the per-recompile shader/program churn in compile(), which is freed
    // eagerly).
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, TRIANGLE, gl.STATIC_DRAW);
  }

  function uloc(name) {
    if (!(name in uniformLocs))
      uniformLocs[name] = gl.getUniformLocation(program, name);
    return uniformLocs[name];
  }

  function draw() {
    rafId = requestAnimationFrame(draw);
    if (!program || lost) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    if (uloc("uTime")) gl.uniform1f(uloc("uTime"), shaderTime());
    if (uloc("uResolution"))
      gl.uniform2f(uloc("uResolution"), canvas.width, canvas.height);
    for (const [name, value] of Object.entries(uniformMap)) {
      const loc = uloc(name);
      if (loc) gl.uniform1f(loc, value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault(); // allow restore
    lost = true;
    console.error("[strasbeat] shader WebGL context lost");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    console.error("[strasbeat] shader WebGL context restored — recompiling");
    lost = false;
    // After a restore, every GL object created against the old context is
    // dead. Drop stale handles, then re-create geometry + recompile the
    // last-good program so we render again instead of a dead canvas.
    uniformLocs = {};
    program = null;
    setupGeometry();
    if (lastGoodSrc) setProgram(lastGoodSrc);
  });

  setupGeometry();

  return {
    setFragment: (src) => setProgram(src),
    setUniformMap: (m) => {
      uniformMap = m || {};
    },
    start: () => {
      if (rafId == null) draw();
    },
    stop: () => {
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
    hasProgram: () => program != null,
    canvasEl: canvas,
  };
}

// Teardown — removes the canvas + stops the loop. Called on stop / re-init /
// HMR dispose (mirrors clearHydra).
export function clearShader() {
  node?.stop?.();
  document.getElementById(CANVAS_ID)?.remove();
  node = null;
  // Reset the shared deriver too so teardown is symmetric: otherwise a
  // stop→restart leaves overrides growing unbounded and a stale prevIds that
  // swallows the first re-pulse for any hap whose name@begin matches a
  // pre-stop one.
  _resetDeriver();
}

export function _getShaderNode() {
  return node;
}
export function _ensureNode() {
  if (!node) node = createNode();
  return node;
}

// Vite HMR dispose: strasbeat reloads the page on pattern-file change. Without
// this a stale shader canvas / WebGL context survives the reload and they pile
// up. clearShader() removing the canvas is what makes this safe (mirrors
// hydra.js).
if (import.meta.hot) {
  import.meta.hot.dispose(() => clearShader());
}

// ─── Public entry point (Task 6) ─────────────────────────────────────────

// Benign no-op API — returned from the guard / empty-source paths so a chained
// .uniform() never crashes the editor (surface-failures-loudly: we warn, we
// don't throw). Shaped like the live api below.
function noopShaderApi() {
  const api = {
    uniform() {
      return api;
    },
  };
  return api;
}

/**
 * Compile and render a drop-in fragment shader, with named uniforms driven by
 * the playing pattern's events. Built-in uTime / uResolution are always
 * provided. Auto-uniforms derive from the pattern automatically — type these
 * verbatim into your GLSL:
 *   - drum lanes bd / sd / hh → uKick / uSnare / uHat
 *   - every active sound `name` → u_<name>, with each non-alphanumeric char
 *     replaced by _ and a leading _ so digit-leading names stay legal GLSL
 *     (gm_pad_warm → u_gm_pad_warm, 909-clap → u_909_clap)
 *   - any note/n hap → uKeyVelocity
 * Override/extend any of these with .uniform({ dest, gain }).
 *
 * SINGLE-QUOTE RULE: the shader source MUST be single-quoted. Strudel's
 * transpiler rewrites every DOUBLE-quoted string literal into a mini(...)
 * call, which would turn your GLSL into a Pattern and break the node. Drum/
 * note patterns in the same file still use double quotes (correct for s("…")).
 * See CLAUDE.md "the single-quote rule".
 *
 * @param {string} src single-quoted GLSL fragment shader source
 * @example
 * await shader('precision mediump float; uniform float uKick; void main(){ gl_FragColor = vec4(uKick,0.,0.,1.); }')
 */
export async function shader(src) {
  // Pattern-input guard — must run BEFORE any document/WebGL access (mirrors
  // progression()'s _Pattern detector). Double-quoted GLSL becomes a Pattern
  // via the transpiler; warn with the actionable fix and return a no-op.
  if (src?._Pattern === true) {
    console.warn(
      "[strasbeat] shader() received a Pattern instead of a string — the shader source was double-quoted (\"...\") and Strudel's transpiler converted it to mini-notation. Use single quotes: shader('precision mediump float; …'). See CLAUDE.md the single-quote rule.",
    );
    return noopShaderApi(); // no-op node, does not crash the editor
  }
  if (typeof src !== "string" || src.trim() === "") {
    console.warn(
      "[strasbeat] shader() received empty source — nothing to render.",
    );
    return noopShaderApi();
  }

  // Ensure the shared deriver exists so the .uniform() override below and the
  // onDraw feed both talk to the same instance.
  getDeriver();
  const n = _ensureNode();
  n.setFragment(src); // compile failure keeps last-good program (logged loudly)
  n.start();

  const api = {
    /**
     * Override or extend the auto uniform map for one destination. Drives the
     * named uniform from the active pattern (gain scales the pulse height).
     * @noAutocomplete
     */
    uniform({ dest, gain = 1, slow = 1, onTrigger } = {}) {
      if (dest?._Pattern === true) {
        console.warn(
          "[strasbeat] .uniform({dest}) received a Pattern — the dest name was double-quoted. Use single quotes: .uniform({ dest: 'uMelody' }). See CLAUDE.md the single-quote rule.",
        );
        return api;
      }
      if (typeof dest === "string") {
        getDeriver().setOverride(dest, { gain, slow, onTrigger });
      }
      return api;
    },
  };
  return api;
}

// ─── .uniform() Pattern method ───────────────────────────────────────────
// `note('0 7 5 7').uniform({ dest: 'uMelody', gain: 0.8, slow: 2 })` drives a
// named uniform from the pattern's own events. Implemented as a pure Pattern
// transform (withValue tags hap.value._uniformDest — the same place every
// Strudel control lives) PLUS a call-time side effect that registers the
// override on the shared deriver. We deliberately do NOT use Strudel's
// register(): that machinery patternifies positional args and adds a curried
// arity contract, which fights an options-object signature. Attaching to
// Pattern.prototype is the documented, lower-risk path (it's how Strudel's own
// withValue-based helpers extend the prototype), and withValue is a public API.
//
// Defensive: if a future Strudel version ships its own Pattern.prototype.uniform
// we'd be shadowing it — there is none today (grepped @strudel/core), and this
// is a strasbeat-only name. If that ever changes, this single assignment is the
// one place to revisit.
Pattern.prototype.uniform = function uniform(opts = {}) {
  // Single-quote guard: a double-quoted dest is a Pattern, not a string.
  if (opts?.dest?._Pattern === true) {
    console.warn(
      "[strasbeat] .uniform({dest}) received a Pattern — the dest name was double-quoted. Use single quotes: .uniform({ dest: 'uMelody' }). See CLAUDE.md the single-quote rule.",
    );
    return this;
  }
  const { dest, gain = 1, slow = 1, onTrigger } = opts;
  if (typeof dest !== "string" || dest === "") {
    console.warn(
      "[strasbeat] .uniform() needs a string dest, e.g. .uniform({ dest: 'uMelody' }) — ignoring.",
    );
    return this;
  }
  // Register the override (gain/slow/onTrigger) on the shared deriver so the
  // onDraw feed scales this dest's pulses, then tag every hap so uniformsForHap
  // routes it to `dest` (see uniforms.js destOf()).
  getDeriver().setOverride(dest, { gain, slow, onTrigger });
  return this.withValue((v) => {
    const base = v && typeof v === "object" ? v : { value: v };
    return { ...base, _uniformDest: dest };
  });
};

// onDraw needs the shared deriver; re-export the accessor so main.js can reach
// it through the same module it already imports the node accessor from.
export { getDeriver as _getDeriver } from "./uniforms.js";
