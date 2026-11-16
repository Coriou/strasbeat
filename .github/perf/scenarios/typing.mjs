// Journey: keystroke to painted frame. Start: a key goes down at the end of
// a ~180-line pattern. End: two frames later. 103 keys of ordinary Strudel
// code, one at a time.
import { open, setCode, play, synth, steady, Skip } from "../lib/browser.mjs";
import { windowMeasure } from "../lib/measure.mjs";
export const name = "typing";
export const description =
  "From first keydown at the end of captainmo to two frames after the final key; one key at a time.";
export const variants = ["default", "playing", "cpu4"];
const text =
  '\n$: s("bd*2 sd hh*4").bank("tr909").gain(0.8).room(0.2)\n$: note("c2 eb2 g2 bb2").s("sawtooth").lpf(800)';
export async function run(ctx) {
  await open(ctx);
  if (ctx.variant === "playing") {
    await setCode(ctx, synth());
    await play(ctx);
    await steady(ctx);
    ctx.driver.pump();
  }
  const original = await ctx.page.evaluate(() => window.patterns?.captainmo);
  if (!original) throw new Skip("captainmo fixture unavailable");
  await ctx.page.evaluate((code) => {
    window.editor.setCode(code);
    const v = window.editor.editor;
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    v.focus();
  }, original);
  await ctx.driver.stop();
  await ctx.driver.step(4, { paced: false });
  const perKey = [];
  const result = await windowMeasure(ctx, async () => {
    for (const ch of text) {
      if (ch === "\n") await ctx.page.keyboard.press("Enter");
      else await ctx.page.keyboard.type(ch);
      await ctx.driver.step(2, { paced: false });
    }
    return { keys: text.length };
  });
  // Aggregate per-key values avoid taking coverage 103 times, which would alter
  // timer scheduling. The raw two-frame samples retain the key timing series.
  const f = result.info.observed.frames;
  for (let i = 0; i < f.length; i += 2)
    perKey.push((f[i]?.ms ?? 0) + (f[i + 1]?.ms ?? 0));
  if (ctx.counting) {
    result.counts.perKey = Object.fromEntries(
      Object.entries(result.counts)
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => [k, v / text.length]),
    );
    result.counts.groupsPerKey = Object.fromEntries(
      Object.entries(result.counts.groups).map(([k, v]) => [
        k,
        v / text.length,
      ]),
    );
  }
  result.info.keys = text.length;
  result.info.mainThreadMsPerKey = perKey;
  await ctx.page.evaluate((c) => window.editor.setCode(c), original);
  return result;
}
