// Shared 10-step OKLCH palette for per-layer coloring.
// Used by both the piano roll (canvas) and the track bar (DOM).
//
// Hand-tuned at uniform L=0.70 / C≈0.13 so no single color screams louder
// than its neighbours; the rose at the start matches the default `--accent`
// hue (358) so the primary layer feels continuous with the rest of the chrome.
// Not derived from `--accent` at runtime: an accent override is one user
// signature, this palette is ten.
export const PALETTE = [
  'oklch(0.70 0.16 358)', // rose (default accent hue)
  'oklch(0.70 0.13 28)',  // coral
  'oklch(0.70 0.12 58)',  // amber
  'oklch(0.70 0.12 98)',  // olive
  'oklch(0.70 0.13 138)', // sage
  'oklch(0.70 0.13 178)', // teal
  'oklch(0.70 0.13 218)', // sky
  'oklch(0.70 0.13 258)', // indigo
  'oklch(0.70 0.13 298)', // lavender
  'oklch(0.70 0.13 328)', // mauve
];
