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
import {
  createVisualCanvas,
  markVisualRequested,
  registerVisualLayer,
  visualsChanged,
} from "./visuals-host.js";

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
    setRenderMode: () => {},
    resize: () => {},
    destroy: () => {},
    hasProgram: () => false,
    canvasEl: null,
  };
}

function createNode() {
  // Full-viewport, fixed, hidden until the host places it, backing store
  // capped — the same canvas posture as #hydra-canvas (see visuals-host.js),
  // so the Visuals panel clip and full-window mode host both identically.
  const canvas = createVisualCanvas(CANVAS_ID);
  const gl = canvas.getContext("webgl");
  if (!gl) {
    canvas.remove();
    reportShaderError(
      "WebGL unavailable — shader node disabled (getContext('webgl') returned null)",
    );
    return noopNode();
  }

  let program = null;
  let lastGoodSrc = null;
  let uniformLocs = {};
  let aPos = -1;
  let rafId = null;
  let loopOnce = false; // the queued frame is a single still frame
  let uniformMap = {}; // fed each frame by Task 6
  let lost = false;
  let destroyed = false;

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
    aPos = gl.getAttribLocation(prog, "aPos");
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

  function drawFrame() {
    if (!program || lost) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    if (uloc("uTime")) gl.uniform1f(uloc("uTime"), shaderTime());
    if (uloc("uResolution"))
      gl.uniform2f(uloc("uResolution"), canvas.width, canvas.height);
    for (const name in uniformMap) {
      const loc = uloc(name);
      if (loc) gl.uniform1f(loc, uniformMap[name]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function stop() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // once=true renders a single frame (the reduced-motion still) and stops.
  function start(once = false) {
    if (destroyed) return;
    if (rafId != null) {
      if (loopOnce === once) return;
      stop();
    }
    loopOnce = once;
    const frame = () => {
      rafId = once ? null : requestAnimationFrame(frame);
      drawFrame();
    };
    rafId = requestAnimationFrame(frame);
  }

  const onContextLost = (e) => {
    e.preventDefault(); // allow restore
    lost = true;
    reportShaderError("shader WebGL context lost");
  };
  const onContextRestored = () => {
    console.error("[strasbeat] shader WebGL context restored — recompiling");
    lost = false;
    // After a restore, every GL object created against the old context is
    // dead. Drop stale handles, then re-create geometry + recompile the
    // last-good program so we render again instead of a dead canvas.
    uniformLocs = {};
    program = null;
    setupGeometry();
    if (lastGoodSrc) setProgram(lastGoodSrc);
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  setupGeometry();

  return {
    // Re-evaluating an unchanged shader keeps the linked program — no
    // recompile, no relink. A source that last FAILED is always retried so its
    // error is reported again, and so is one whose program was lost (context
    // restored but the recompile failed).
    setFragment: (src) =>
      src === lastGoodSrc && program ? true : setProgram(src),
    setUniformMap: (m) => {
      uniformMap = m || {};
    },
    // mode: "live" | "still" | "off" — decided by visuals-host.js.
    setRenderMode: (mode) => {
      if (mode === "live") start();
      else if (mode === "still") start(true);
      else stop();
    },
    resize: ({ width, height }) => {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    },
    // Deterministic GPU teardown (mirrors clearHydra): free the program, then
    // ask the browser to reclaim the WebGL context immediately rather than
    // waiting for GC. Without this, each stop→play strands a context until the
    // GC runs, compounding the ~16-context ceiling that hydra's canvas also
    // pushes on. Loud-failure-safe: wrapped so a teardown hiccup can't throw.
    destroy: () => {
      destroyed = true;
      stop();
      // Our own loss handlers go first: the forced loss below is a normal
      // teardown, not a failure to report.
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      try {
        if (program) {
          gl.deleteProgram(program);
          program = null;
        }
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* never let teardown throw */
      }
      canvas.remove();
    },
    hasProgram: () => program != null,
    canvasEl: canvas,
  };
}

// Teardown — stops the loop, frees the GL context, removes the canvas. Called
// by visuals-host.js (every stop path, every evaluate that no longer calls
// shader()) and on HMR dispose (mirrors clearHydra).
export function clearShader() {
  const wasLive = node !== null;
  node?.destroy?.();
  node = null;
  // Reset the shared deriver too so teardown is symmetric: otherwise a
  // stop→restart leaves overrides growing unbounded and stale envelope state
  // that would bleed into the first frames of the next play.
  _resetDeriver();
  if (wasLive) visualsChanged();
}

export function _getShaderNode() {
  return node;
}
// A node that could not get a WebGL context is not kept: the next shader()
// call retries (and reports again) instead of silently no-opping forever.
export function _ensureNode() {
  if (node) return node;
  const created = createNode();
  if (created.canvasEl) node = created;
  return created;
}

registerVisualLayer("shader", {
  isLive: () => node !== null,
  clear: () => clearShader(),
  setRenderMode: (mode) => node?.setRenderMode(mode),
  getCanvas: () => node?.canvasEl ?? null,
  resize: (size) => node?.resize(size),
});

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
 * MULTI-LINE SHADERS: a single-quoted string can't span multiple physical
 * lines, and the transpiler ALSO rewrites backtick template literals into
 * mini(...) — so a `multi-line backtick` source is NOT safe either. Write a
 * readable multi-line shader by concatenating single-quoted lines with '+',
 * each ending in '\n':
 *   await shader(
 *     'precision mediump float;\n' +
 *     'uniform float uKick;\n' +
 *     'void main(){ gl_FragColor = vec4(uKick, 0., 0., 1.); }\n'
 *   )
 * Every piece stays single-quoted (none gets mini-rewritten), it parses as
 * plain JS, and the \n keep GLSL line numbers intact in compile errors.
 *
 * @param {string} src single-quoted GLSL fragment shader source (concatenate
 *   single-quoted '…\n' lines with '+' for multi-line shaders)
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
  // Tell the host this evaluate still wants the shader, so the post-evaluate
  // sweep keeps it.
  markVisualRequested("shader");
  const isNew = node === null;
  const n = _ensureNode();
  n.setFragment(src); // compile failure keeps last-good program (logged loudly)
  // The host places the canvas and decides whether the loop runs (scheduler
  // playing + canvas on screen) — shader() itself never starts rendering.
  if (isNew && node) visualsChanged();

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
