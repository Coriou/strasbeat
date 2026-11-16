// Journey: opening and switching pattern tabs. Start: the click. End: three
// frames later.
import { open, settle, clickDOM, Skip } from "../lib/browser.mjs";
import { windowMeasure } from "../lib/measure.mjs";
export const name = "tabs";
export const description =
  "Three first tree-item opens and twenty tab-strip switches, ending three frames after each click.";
export const variants = ["default"];
export async function tabNames(ctx) {
  const names = await ctx.page.evaluate(() => {
    const opened = new Set(
      [...document.querySelectorAll("#tab-strip [data-name]")].map(
        (e) => e.dataset.name,
      ),
    );
    return [...document.querySelectorAll('[role="treeitem"][data-name]')]
      .map((e) => e.dataset.name)
      .filter((n) => !opened.has(n) && typeof window.patterns?.[n] === "string")
      .slice(0, 3);
  });
  if (names.length < 3)
    throw new Skip("Three shipped pattern tree items unavailable");
  return names;
}
export async function run(ctx) {
  await open(ctx);
  await settle(ctx);
  const names = await tabNames(ctx);
  await ctx.driver.stop();
  const opens = [],
    switches = [];
  for (const n of names)
    opens.push(
      await windowMeasure(ctx, async () => {
        await clickDOM(ctx, `[role="treeitem"][data-name="${n}"]`);
        return ctx.driver.step(3, { paced: false });
      }),
    );
  for (let i = 0; i < 20; i++)
    switches.push(
      await windowMeasure(
        ctx,
        async () => {
          await clickDOM(
            ctx,
            `#tab-strip [data-name="${names[i % 3]}"] [role="tab"]`,
          );
          return ctx.driver.step(3, { paced: false });
        },
        { diagnostics: i === 0 },
      ),
    );
  const average = (rows, category) =>
    Object.fromEntries(
      [
        "calls",
        "mutations",
        "layouts",
        "styleRecalcs",
        "scriptMs",
        "taskMs",
      ].flatMap((k) =>
        rows[0][category][k] == null
          ? []
          : [[k, rows.reduce((s, r) => s + r[category][k], 0) / rows.length]],
      ),
    );
  return {
    counts: {
      firstOpen: average(opens, "counts"),
      switch: average(switches, "counts"),
    },
    timings: {
      firstOpen: average(opens, "timings"),
      switch: average(switches, "timings"),
    },
    info: { opens, switches },
  };
}
