// Journey: launch. Start: navigation start. End points, timestamped in the
// page: the editor is in the document, the task that put it there has
// ended (a key press is handled from here on), and boot reports ready.
// launch-warm reuses this for a second and third launch of one context.
import fs from "node:fs/promises";
import path from "node:path";
import { open, ready } from "../lib/browser.mjs";
import { metrics, delta, heap, network } from "../lib/measure.mjs";
import { census, profileTable } from "../lib/symbols.mjs";
export const name = "launch-cold";
export const description =
  "Navigation start in a fresh context to editor insertion, the following MessageChannel task (interactive), and .shell.is-ready.";
export const variants = ["default", "cpu4", "net150"];
export async function launch(ctx, warm = 0) {
  await open(ctx, { controlled: false, navigate: false });
  for (let i = 0; i < warm; i++) {
    await ctx.page.goto(ctx.server.origin, { waitUntil: "domcontentloaded" });
    await ready(ctx);
    // A build with a service worker registers it only once boot is over
    // and the page is idle, then installs and claims the page. Wait for
    // that, or the measured launch would be an uncontrolled one; the
    // measured page records whether it really was controlled.
    if (ctx.hasServiceWorker)
      await ctx.page.waitForFunction(
        () => !!navigator.serviceWorker?.controller,
        null,
        { polling: 100, timeout: 60000 },
      );
    await ctx.page.close();
    await open(ctx, {
      controlled: false,
      navigate: false,
      context: ctx.context,
    });
  }
  ctx.server.reset();
  const net = network(ctx.cdp),
    before = await metrics(ctx.cdp),
    marks = {};
  let queue = Promise.resolve();
  await ctx.page.exposeBinding("__perfMilestone", (_, milestone) => {
    queue = queue.then(async () => {
      marks[milestone] = { metrics: await metrics(ctx.cdp) };
      if (ctx.counting)
        marks[milestone].coverage = (
          await ctx.cdp.send("Profiler.takePreciseCoverage")
        ).result;
    });
    return queue;
  });
  await ctx.cdp.send("Profiler.enable");
  if (ctx.counting) {
    await ctx.cdp.send("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: false,
    });
    await ctx.cdp.send("Profiler.takePreciseCoverage");
  } else {
    await ctx.cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await ctx.cdp.send("Profiler.start");
  }
  if (ctx.trace)
    await ctx.browser.startTracing(ctx.page, {
      categories: ["devtools.timeline", "v8", "blink.user_timing"],
    });
  await ctx.page.goto(ctx.server.origin, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await ready(ctx);
  await queue;
  const data = await ctx.page.evaluate(() => ({
    milestones: window.__perf.milestones,
    observed: window.__perf.snapshot(),
    fcp:
      performance.getEntriesByName("first-contentful-paint")[0]?.startTime ??
      null,
    controlled: !!navigator.serviceWorker?.controller,
  }));
  if (!marks.interactive || !marks.ready)
    throw new Error("Launch milestone binding did not record both boundaries");
  const counts = {},
    info = {
      ...data,
      network: [...net.rows.values()],
      boundaryPrecision:
        "DOM timestamps are in-page; coverage/Performance snapshots follow the milestone binding over CDP and include its delivery latency.",
    };
  if (ctx.counting) {
    await ctx.cdp.send("Profiler.stopPreciseCoverage");
    const interactive = census(marks.interactive.coverage, ctx.symbols),
      remaining = census(marks.ready.coverage, ctx.symbols);
    // takePreciseCoverage resets counts. Merge counts by script/function before
    // calculating unused bytes so functions called in either segment are used.
    const merged = new Map();
    for (const s of [...marks.interactive.coverage, ...marks.ready.coverage]) {
      const dest = merged.get(s.scriptId) ?? { ...s, functions: new Map() };
      for (const f of s.functions) {
        const key = f.ranges[0].startOffset,
          old = dest.functions.get(key);
        if (old) old.ranges[0].count += f.ranges[0].count;
        else dest.functions.set(key, structuredClone(f));
      }
      merged.set(s.scriptId, dest);
    }
    const all = census(
      [...merged.values()].map((s) => ({
        ...s,
        functions: [...s.functions.values()],
      })),
      ctx.symbols,
    );
    Object.assign(counts, {
      interactive: {
        calls: interactive.calls,
        network: net.at(data.milestones.interactive),
      },
      ready: {
        calls: interactive.calls + remaining.calls,
        network: net.at(data.milestones.ready),
        unusedBytes: all.unusedBytes,
        ...(await heap(ctx.cdp)),
      },
    });
    info.top = all.top;
    info.groups = all.groups;
  } else {
    const profile = (await ctx.cdp.send("Profiler.stop")).profile;
    info.profile = profileTable(profile, ctx.symbols);
    await fs.mkdir(path.join(ctx.out, "profiles"), { recursive: true });
    await fs.writeFile(
      path.join(
        ctx.out,
        "profiles",
        `${ctx.target}-${ctx.scenario}-${ctx.variant}-${ctx.repeat}.cpuprofile`,
      ),
      JSON.stringify(profile),
    );
  }
  if (ctx.trace) {
    const trace = await ctx.browser.stopTracing();
    await fs.mkdir(path.join(ctx.out, "traces"), { recursive: true });
    await fs.writeFile(
      path.join(
        ctx.out,
        "traces",
        `${ctx.target}-${ctx.scenario}-${ctx.variant}-${ctx.repeat}.json`,
      ),
      trace,
    );
  }
  const d = delta(before, marks.ready.metrics);
  counts.serverRequests = ctx.server.log.length;
  counts.serverByClass = ctx.server.log.reduce(
    (a, r) => {
      const k = r.path.startsWith("/assets/")
        ? "assets"
        : r.path.startsWith("/strudel-cc/")
          ? "fixtures"
          : "other";
      a[k] = (a[k] ?? 0) + 1;
      return a;
    },
    { assets: 0, fixtures: 0, other: 0 },
  );
  return {
    counts,
    timings: {
      ...data.milestones,
      fcp: data.fcp,
      scriptMs: d.ScriptDuration * 1000,
      taskMs: d.TaskDuration * 1000,
      longTasks: data.observed.longTasks.length,
    },
    info,
  };
}
export const run = (ctx) => launch(ctx);
