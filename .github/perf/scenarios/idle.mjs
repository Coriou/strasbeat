// Journey: doing nothing. Ten seconds after boot, stopped: what still runs,
// and what the page holds on to.
import { open } from "../lib/browser.mjs";
import { windowMeasure, heap } from "../lib/measure.mjs";
import { sleep } from "../lib/server.mjs";
export const name = "idle";
export const description =
  "After ready and a two-second settling period, stopped for ten seconds without a measurement rAF loop.";
export const variants = ["default"];
export async function run(ctx) {
  await open(ctx, { controlled: false });
  await ctx.page.evaluate(() => window.editor.stop());
  await sleep(2000);
  const r = await windowMeasure(ctx, () => sleep(10000), { clock: false });
  Object.assign(r.counts, await heap(ctx.cdp));
  return r;
}
