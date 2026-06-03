// 04-hydra-demo — Phase 1 smoke test: first-class offline Hydra
// concepts: initHydra(), Hydra source chains, $: pattern layers, RolandTR909 drums
//
// Hydra source chains use Hydra's OWN functions (osc, color, rotate, out, …) —
// NOT Strudel mini-notation. Any string passed to a strasbeat helper must be
// single-quoted (load-bearing for shader('…') — see CLAUDE.md the single-quote rule).
//
// To see the visuals: open the Visuals bottom-panel mode (appears after
// initHydra() runs), or toggle full-window via the command palette
// ("Visuals: toggle full-window").

export default `await initHydra()
osc(10, 0.1, 1.2).color(0.9, 0.3, 0.6).rotate(0.2).out()

setcpm(120/4)

$: s("bd*4, ~ sd, hh*8")
  .bank("RolandTR909")
  .gain(0.8)
`;
