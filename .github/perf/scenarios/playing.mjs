// Journey: frame cost while a pattern plays.
// Start: playback has reached a steady state (the roll's window is full).
// End: 600 frames later, stepped at exactly 120 Hz (five seconds).
import {
  open,
  setCode,
  play,
  synth,
  clickDOM,
  steady,
  Skip,
} from "../lib/browser.mjs";
import { windowMeasure } from "../lib/measure.mjs";
import { median, stats } from "../lib/stats.mjs";

export const name = "playing";
export const description =
  "Steady playback, then 600 frames stepped at exactly 120 Hz (5 s). Modes: roll visible, roll collapsed, scope, beat grid; Hydra and shader at 30 Hz (300 frames); plus the same synth pattern with 1, 2 and 8 layers (roll is the 4-layer point) as a dose-response series.";
export const variants = [
  "roll",
  "collapsed",
  "scope",
  "beats",
  "hydra",
  "shader",
  "layers1",
  "layers2",
  "layers8",
];

// The WebGL modes are stepped at 30 Hz: under software GL a frame of theirs
// takes about 17 ms, so a 120 Hz pace cannot be held, and a window that does
// not hold pace has no deterministic count. Their frame times say nothing
// about a real GPU; their counts per frame are comparable between builds.
const pacing = (visual) =>
  visual ? { hz: 30, frames: 300 } : { hz: 120, frames: 600 };
// Wall-clock is noisy on a shared runner: the timing pass measures three
// windows and reports their median. A count is the same every time.
const TIMING_WINDOWS = 3;

export async function run(ctx) {
  await open(ctx);
  const v = ctx.variant,
    visual = ["hydra", "shader"].includes(v);
  let fixtureAdjustment;
  let code = synth(v.startsWith("layers") ? Number(v.slice(6)) : 4);
  if (v === "beats")
    code = 'setcps(0.5)\n$: s("bd*2")\n$: s("hh*4")\n$: s("~ sd")';
  if (visual) {
    if (
      !(await ctx.page.evaluate(
        () => !!document.createElement("canvas").getContext("webgl"),
      ))
    )
      throw new Error("WebGL context unavailable");
    code = await ctx.page.evaluate(
      (key) => window.patterns?.[key],
      v === "hydra" ? "04-hydra-demo" : "05-shader-demo",
    );
    if (!code) throw new Skip(`${v} shipped fixture unavailable`);
    if (v === "shader" && code.includes("gm_lead_2_sawtooth")) {
      code = code.replaceAll("gm_lead_2_sawtooth", "sawtooth");
      fixtureAdjustment =
        "In-memory shader demo: gm_lead_2_sawtooth replaced with sawtooth; soundfonts fetch external JS, which the fixture policy forbids.";
    }
  }
  const { hz, frames: FRAMES } = pacing(visual);
  const SECONDS = FRAMES / hz;
  await setCode(ctx, code);
  await play(ctx);
  if (v === "collapsed") await clickDOM(ctx, "#roll-toggle");
  if (["scope", "beats"].includes(v) || visual) {
    const selector = `.bottom-panel__modes button[data-mode="${visual ? "visuals" : v}"]`;
    if (
      !(await ctx.page.evaluate((s) => {
        const el = document.querySelector(s);
        return el && !el.hidden;
      }, selector))
    )
      throw new Skip(`Mode unavailable: ${v}`);
    await clickDOM(ctx, selector);
    if (
      (await ctx.page.locator(selector).getAttribute("aria-selected")) !==
      "true"
    )
      throw new Error(`Mode did not activate: ${v}`);
  }
  if (
    v === "collapsed" &&
    (await ctx.page.locator("#roll-toggle").getAttribute("aria-expanded")) !==
      "false"
  )
    throw new Error("Roll did not collapse");
  await steady(ctx);

  // A window only counts if it held pace (see frames.mjs); one that did not
  // is measured again, up to three times.
  const attempts = [];
  const windows = [];
  const wanted = ctx.counting ? 1 : TIMING_WINDOWS;
  for (let w = 0; w < wanted; w++) {
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`STEP ${ctx.label} window ${w + 1}.${attempt}`);
      result = await windowMeasure(ctx, () => ctx.driver.step(FRAMES, { hz }), {
        diagnostics: w === 0 && attempt === 1,
      });
      const frame = result.info.action;
      attempts.push({
        calls: result.counts.calls,
        wall: frame.wall,
        nominal: frame.nominal,
        valid: frame.valid,
      });
      if (frame.valid) break;
    }
    windows.push(result);
    if (!result.info.action.valid) break;
  }

  const result = windows[0];
  const c = result.counts;
  if (ctx.counting)
    Object.assign(c, {
      callsPerFrame: c.calls / FRAMES,
      groupsPerFrame: Object.fromEntries(
        Object.entries(c.groups).map(([k, n]) => [k, n / FRAMES]),
      ),
      canvasPerFrame: c.canvas / FRAMES,
      rafPerFrame: c.raf / FRAMES,
      transactionsPerSecond: c.transactions / SECONDS,
      layoutsPerSecond: c.layouts / SECONDS,
      styleRecalcsPerSecond: c.styleRecalcs / SECONDS,
      mutationsPerSecond: c.mutations / SECONDS,
    });
  else {
    const valid = windows.filter((w) => w.info.action.valid);
    const each = (pick) => valid.map(pick);
    const frames = valid.flatMap((w) =>
      w.info.observed.frames.map((f) => f.ms),
    );
    result.timings = {
      scriptMsPerSecond: median(each((w) => w.timings.scriptMs / SECONDS)),
      taskMsPerSecond: median(each((w) => w.timings.taskMs / SECONDS)),
      frameMs: stats(frames),
      framesOverBudget: median(each((w) => w.timings.framesOverBudget)),
      longTasks: median(each((w) => w.timings.longTasks)),
      windows: valid.length,
    };
    result.info.windowTimings = each((w) => ({
      scriptMsPerSecond: w.timings.scriptMs / SECONDS,
      taskMsPerSecond: w.timings.taskMs / SECONDS,
      framesOverBudget: w.timings.framesOverBudget,
      frameMsMedian: w.timings.frameMs.median,
      frameMsMax: w.timings.frameMs.max,
    }));
  }
  result.info.attempts = attempts;
  result.info.frames = FRAMES;
  result.info.hz = hz;
  if (fixtureAdjustment) result.info.fixtureAdjustment = fixtureAdjustment;
  result.pacingValid = windows.every((w) => w.info.action.valid);
  return result;
}
