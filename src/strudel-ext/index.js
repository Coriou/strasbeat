// Single import surface for runtime helpers exposed inside pattern strings.
//
// main.js loads this module as a namespace and hands it to evalScope() so
// every export here becomes a global inside Strudel pattern code (the same
// mechanism that makes `note`, `s`, `chord`, etc. callable). Anything added
// to this barrel is available in `patterns/*.js` with no extra wiring.

export { progression } from "./progression.js";
export { arrange } from "./arrange.js";
