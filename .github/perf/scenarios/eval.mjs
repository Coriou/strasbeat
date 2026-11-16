// Journey: Ctrl+Enter to the first scheduled sound. Start: the keydown.
// End: the first AudioScheduledSourceNode.start() call after it. The app
// is at rest first: pressed the instant boot reports ready, the key shares
// its window with the lazy panels still loading.
import { open, settle, setCode, synth, play } from "../lib/browser.mjs";
import { windowMeasure, network } from "../lib/measure.mjs";
import { sleep } from "../lib/server.mjs";
export const name = "eval";
export const description =
  "Capture-phase Ctrl+Enter keydown to the first AudioScheduledSourceNode.start call; also report scheduled audio lead.";
export const variants = ["first", "again", "cpu4"];
export async function run(ctx) {
  await open(ctx, { controlled: false });
  await settle(ctx);
  await setCode(ctx, synth());
  if (ctx.variant === "again") {
    await play(ctx);
    await sleep(500);
    await ctx.page.evaluate(() => window.editor.stop());
  }
  ctx.server.reset();
  const requests = network(ctx.cdp);
  const r = await windowMeasure(
    ctx,
    async () => {
      await ctx.page.keyboard.press("Control+Enter");
      await ctx.page.waitForFunction(
        () => window.__perf.eval?.end != null,
        null,
        { polling: 10, timeout: 15000 },
      );
      return ctx.page.evaluate(() => window.__perf.eval);
    },
    { clock: false },
  );
  r.timings.delayMs = r.info.action.end - r.info.action.start;
  r.timings.audioAheadMs = r.info.action.ahead * 1000;
  if (ctx.counting) r.counts.requests = requests.rows.size;
  r.info.requests = [...requests.rows.values()];
  r.info.taskCount =
    "CDP Performance has no total task count; long-task entries and TaskDuration are reported instead.";
  return r;
}
