// Single import surface for runtime helpers exposed inside pattern strings.
//
// main.js loads this module as a namespace and hands it to evalScope() so
// every export here becomes a global inside Strudel pattern code (the same
// mechanism that makes `note`, `s`, `chord`, etc. callable). Anything added
// to this barrel is available in `patterns/*.js` with no extra wiring.

export { progression } from "./progression.js";
export { arrange } from "./arrange.js";
export {
  initHydra,
  clearHydra,
  H,
  setVisualsAvailabilityCallback,
} from "./hydra.js";
// shader() is the only shader export that belongs in pattern scope. The node
// teardown (clearShader) and the in-app error sink (setShaderErrorSink) are
// app-internal and stay direct imports in main.js (Task 5) — keeping them out
// of the barrel avoids leaking app plumbing into the pattern global namespace.
// Importing shader.js here also runs its Pattern.prototype.uniform side effect,
// registering the .uniform() Pattern method for every pattern file.
export { shader } from "./shader.js";
