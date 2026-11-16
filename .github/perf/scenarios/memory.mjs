// Journey: a long session. 120 evaluate/stop cycles, then 60 tab switches;
// heap (after GC), DOM nodes and listeners sampled every 20.
import { open, setCode, synth, play, clickDOM } from "../lib/browser.mjs";
import { heap, heapCensus, censusGrowth } from "../lib/measure.mjs";
import { tabNames } from "./tabs.mjs";
import { sleep } from "../lib/server.mjs";
import { slope } from "../lib/stats.mjs";
export const name = "memory";
export const description =
  "120 evaluate/300 ms/stop cycles, then 60 tab switches; heap after GC, nodes and listeners sampled every 20, slope over the cycles after the first 40.";
export const variants = ["default"];
const CYCLES = { evaluate: 120, tabs: 60 };
const SAMPLE_EVERY = 20;
const SETTLE = 40;
export async function run(ctx) {
  await open(ctx, { controlled: false });
  // The page-side counters keep one record per animation frame while they
  // are active. Nothing here reads them, and over 120 cycles of playback
  // they would be the largest thing the heap gained.
  await ctx.page.evaluate(() => {
    window.__perf.active = false;
  });
  await setCode(ctx, synth());
  const samples = { evaluate: [], tabs: [] };
  // `--trace memory`: what the evaluate/stop growth is made of, from a heap
  // census once the caches have settled and another at the end.
  let settled = null;
  let growth = null;
  for (const phase of ["evaluate", "tabs"]) {
    let names;
    if (phase === "tabs") {
      names = await tabNames(ctx);
      for (const n of names)
        await clickDOM(ctx, `[role="treeitem"][data-name="${n}"]`);
    }
    samples[phase].push({ cycle: 0, ...(await heap(ctx.cdp)) });
    const cycles = CYCLES[phase];
    for (let i = 1; i <= cycles; i++) {
      if (phase === "evaluate") {
        await play(ctx);
        await sleep(300);
        await ctx.page.evaluate(() => window.editor.stop());
      } else {
        await clickDOM(
          ctx,
          `#tab-strip [data-name="${names[i % 3]}"] [role="tab"]`,
        );
        await sleep(300);
      }
      if (i % SAMPLE_EVERY === 0) {
        console.log(`STEP ${ctx.label} ${phase} ${i}/${cycles}`);
        samples[phase].push({ cycle: i, ...(await heap(ctx.cdp)) });
      }
      if (ctx.traceRequested && phase === "evaluate") {
        if (i === SETTLE) settled = await heapCensus(ctx.cdp);
        if (i === cycles)
          growth = {
            cycles: cycles - SETTLE,
            kinds: censusGrowth(settled, await heapCensus(ctx.cdp)),
          };
      }
    }
  }
  const counts = {};
  for (const [phase, rows] of Object.entries(samples)) {
    // The first cycles fill caches and pools; a leak is what is still
    // growing after them.
    const last = rows.filter((r) => r.cycle >= SETTLE);
    counts[phase] = {
      heapKBPerCycle: slope(last.map((r) => [r.cycle, r.heapBytes / 1024])),
      nodesGrowth: last.at(-1).nodes - last[0].nodes,
      listenersGrowth: last.at(-1).listeners - last[0].listeners,
    };
  }
  return {
    counts,
    timings: {},
    info: {
      samples,
      ...(growth ? { heapGrowth: growth } : {}),
      hydra:
        "Not run: optional lifecycle stress omitted to bound total runner time.",
    },
  };
}
