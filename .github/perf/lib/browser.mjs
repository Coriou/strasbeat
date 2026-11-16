// Opening the app in a measured page, and the handful of interactions the
// scenarios share. Everything here uses only what an older build of the app
// already exposes; a missing hook raises Skip, which is recorded, not failed.
import { controlledPage, frameDriver } from "./frames.mjs";
import { install } from "./instrument.mjs";
import { routeExternal, sleep } from "./server.mjs";
export class Skip extends Error {}
export async function open(
  ctx,
  { controlled = true, navigate = true, context } = {},
) {
  context ??= await ctx.browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "allow",
  });
  ctx.contexts.add(context);
  if (!ctx.configuredContexts.has(context)) {
    await context.addInitScript({
      content: `(${install.toString()})(${JSON.stringify({ counting: ctx.counting })});\n//# sourceURL=__perf-instrument.js`,
    });
    await routeExternal(
      context,
      ctx.server.origin,
      ctx.fixture,
      ctx.unexpectedRequests,
      ctx.delay,
    );
    ctx.configuredContexts.add(context);
  }
  const page = controlled
    ? await controlledPage(ctx.browser, context)
    : await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => ctx.pageErrors.push(e.message));
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type()))
      ctx.console.push(`${m.type()}: ${m.text()}`);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  // Playwright routing disables cache globally. Restore it explicitly for this page.
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: ctx.variant.includes("cpu4") ? 4 : 1,
  });
  const driver = controlled ? frameDriver(cdp) : null;
  ctx.drivers.add(driver);
  Object.assign(ctx, { page, cdp, context, driver });
  if (navigate) {
    driver?.pump();
    await page.goto(ctx.server.origin, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await ready(ctx);
  }
  return ctx;
}
export async function ready(ctx) {
  await ctx.page.waitForFunction(
    () => !!window.__perf?.milestones.ready,
    null,
    { polling: 50, timeout: 90000 },
  );
  const status = await ctx.page.locator("#status").textContent();
  if (/warning|failed/i.test(status ?? ""))
    throw new Error(`Boot degraded: ${status}`);
  if (!(await ctx.page.evaluate(() => window.__perf.wrapEditor())))
    throw new Skip("window.editor.editor.dispatch unavailable");
}
export async function setCode(ctx, code) {
  if (
    !(await ctx.page.evaluate(
      () => typeof window.editor?.setCode === "function",
    ))
  )
    throw new Skip("editor.setCode unavailable");
  await ctx.page.evaluate((c) => {
    window.editor.stop();
    window.editor.setCode(c);
    window.editor.editor.focus();
  }, code);
}
export async function play(ctx) {
  const r = await ctx.page.evaluate(() => window.editor.evaluate());
  if (r?.status !== "ok") throw new Error(`evaluate: ${JSON.stringify(r)}`);
  await ctx.page.waitForFunction(
    () => window.editor?.repl?.scheduler?.started,
    null,
    { polling: 25, timeout: 15000 },
  );
}
export const layers = [
  '$: note("c2 eb2 g2 bb2 c3 eb3 g3 bb3").s("sawtooth").lpf(800).gain(0.3)',
  '$: note("<c4 eb4 g4 bb4>*8").s("triangle").gain(0.2)',
  '$: s("sine*16").note("c5").gain(0.1)',
  '$: note("c3*4").s("square").lpf(400).gain(0.2)',
];
export const synth = (n = 4) =>
  "setcps(0.5)\n" +
  Array.from({ length: n }, (_, i) => layers[i % 4]).join("\n");
export async function clickDOM(ctx, selector) {
  if (
    !(await ctx.page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.click();
      return true;
    }, selector))
  )
    throw new Skip(`Missing UI hook: ${selector}`);
}
export async function steady(ctx) {
  const cps = await ctx.page.evaluate(() => window.editor.repl.scheduler.cps);
  if (!(cps > 0)) throw new Error(`Invalid scheduler cps: ${cps}`);
  // The roll shows four cycles; per-frame work keeps growing until that
  // window is full, and call counts drift by several percent before it is.
  const ms = Math.max(8000, (4 / cps) * 1000);
  console.log(`STEP ${ctx.label} steady state ${Math.round(ms)} ms`);
  await sleep(ms);
  await ctx.driver.stop();
}
