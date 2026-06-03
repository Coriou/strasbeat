// Pure derivation: onDraw haps → decay-envelope → uniform map. No WebGL, no
// DOM — that purity is what makes it unit-testable. The source is the existing
// onDraw(haps, time) hook (main.js). An onset = a hap present this frame that
// was NOT present last frame (compare hap identity across frames) — this gives
// per-event pulses WITHOUT a global onTrigger/event bus (out of scope for
// Phase 2). Borrows PR #1196's decayModulation concept (not its code).
//
// Real hap shape (verified against src/ui/piano-roll.js getValue/getGroupKey
// and the dynamics path, and against s()/note() output in Node):
//   - hap.value is an object after a control is applied: { s, n, note, freq,
//     velocity, gain, ... }. A bare scalar pattern can also surface a non-object
//     value (mini("0 7") → value 0), which we treat defensively.
//   - hap.value.s        sound name ("bd", "sd", "hh", "gm_pad_warm", …)
//   - hap.value.note/.n  pitch (note name or MIDI number)
//   - hap.value.velocity / hap.value.gain   dynamics (default 1)
//   - hap.whole.begin    timing (cycles), a Fraction — String()'d for identity
//
// The .uniform() Pattern method (shader.js) tags hap.value._uniformDest (all
// Strudel controls live in hap.value). uniformsForHap reads that AND a
// top-level h.dest, so the unit-test stub and the real Pattern method route
// identically.

// Canonical lanes for the conventional mini-notation drum names. bd/sd/hh are
// the standard Strudel drum sound names (CLAUDE.md: verify a name resolves —
// these are the documented percussion conventions). Everything else falls back
// to the sanitized per-sound uniform.
const LANE_MAP = { bd: "uKick", sd: "uSnare", hh: "uHat" };
export function laneToUniform(name) {
  return LANE_MAP[name] ?? null;
}

// u + name with every char outside [A-Za-z0-9_] → _ (leading _ so a name that
// starts with a digit, e.g. "909-clap", stays a legal GLSL identifier).
export function sanitizeGlslIdentifier(name) {
  return "u_" + String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

const DECAY_TAU = 0.12; // value *= exp(-dt/TAU); snappy percussive envelope (tune later)

export function createUniformDeriver() {
  let prevIds = new Set();
  const values = {};
  const overrides = {};

  function setOverride(dest, opts = {}) {
    // gain is applied in frame() (it scales the pulse height). slow/onTrigger
    // are accepted + stored for the .uniform() API surface but NOT yet applied
    // here — Phase 2 acceptance only needs gain-scaled pulses, so the stored-
    // but-unused fields are deferred, not a bug.
    overrides[dest] = { gain: 1, slow: 1, ...opts };
  }

  function hapId(h) {
    const v = h?.value;
    const name =
      (v && typeof v === "object" ? (v.s ?? v.note ?? v.n) : v) ??
      JSON.stringify(v);
    // whole.begin is a Fraction in the app; String() gives a stable key.
    return `${name}@${String(h?.whole?.begin)}`;
  }

  // Resolve the explicit-override dest from either the top-level h.dest (test
  // stub) or hap.value._uniformDest (what the .uniform() Pattern method tags).
  function destOf(h) {
    return (
      h?.dest ??
      (h?.value && typeof h.value === "object"
        ? h.value._uniformDest
        : undefined)
    );
  }

  // Returns [uniformName, peak] pairs to (re)pulse for a single onset hap.
  function uniformsForHap(h) {
    const dest = destOf(h);
    if (dest) {
      const cfg = overrides[dest] ?? { gain: 1 };
      // A numeric value (e.g. note number) scales the pulse; otherwise full gain.
      const raw =
        typeof h.value === "number"
          ? h.value
          : h?.value && typeof h.value === "object"
            ? h.value.note
            : undefined;
      const peak =
        typeof raw === "number" ? Math.abs(raw) * cfg.gain : cfg.gain;
      return [[dest, Math.min(1, peak)]];
    }

    const out = [];
    const v = h?.value;
    const s = v && typeof v === "object" ? v.s : undefined;
    if (s) {
      const lane = laneToUniform(s);
      if (lane) out.push([lane, 1]);
      out.push([sanitizeGlslIdentifier(s), 1]);
    }
    if (v && typeof v === "object" && (v.note != null || v.n != null)) {
      const vel = v.velocity ?? v.gain ?? 1;
      out.push(["uKeyVelocity", Math.min(1, vel)]);
    }
    return out;
  }

  // One frame: decay every live uniform, then pulse the uniforms of any hap
  // that is new this frame. dt is seconds since the previous frame.
  function frame(haps, time, dt) {
    const safeHaps = Array.isArray(haps) ? haps : [];
    const ids = new Set(safeHaps.map(hapId));

    // Decay first so a uniform re-pulsed this frame keeps its fresh peak.
    const k = Math.exp(-dt / DECAY_TAU);
    for (const name of Object.keys(values)) {
      values[name] *= k;
      if (values[name] < 1e-4) values[name] = 0;
    }

    for (const h of safeHaps) {
      if (prevIds.has(hapId(h))) continue; // present last frame → not a new onset
      for (const [name, peak] of uniformsForHap(h)) {
        values[name] = Math.max(values[name] ?? 0, peak);
      }
    }

    prevIds = ids;
    return { ...values };
  }

  return { frame, setOverride };
}

// ─── Shared singleton ────────────────────────────────────────────────────
// One deriver is reached by all three consumers: shader() (entry point), the
// .uniform() Pattern method (sets overrides), and main.js onDraw (feeds frames
// + pushes the map into the node). Lazy so importing this module is side-effect
// free for the unit tests.
let _shared = null;
export function getDeriver() {
  if (!_shared) _shared = createUniformDeriver();
  return _shared;
}
// Teardown reset: drop the singleton so a fresh deriver is built next call.
// Called from clearShader() on stop / re-init / HMR dispose so the deriver's
// prevIds/values/overrides don't survive a stop→restart (symmetric with how
// clearHydra nulls its singletons). Also used as the unit-test seam.
export function _resetDeriver() {
  _shared = null;
}
