// Deterministic frames. A page created with begin-frame control renders
// nothing until the rig issues a frame, so "600 frames at 120 Hz" is exactly
// 600 frames whatever the runner's speed. While nothing is being measured a
// pump keeps frames coming (Playwright waits on them); a measured window
// stops the pump and steps frames itself, paced against the wall clock.
// Two beginFrame calls must never overlap.
import { sleep } from "./server.mjs";
export const frameFlags = [
  "--enable-begin-frame-control",
  "--run-all-compositor-stages-before-draw",
  "--disable-new-content-rendering-timeout",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-checker-imaging",
];
export async function controlledPage(browser, context) {
  const helper = await context.newPage(),
    hs = await context.newCDPSession(helper);
  const { targetInfo } = await hs.send("Target.getTargetInfo");
  const bs = await browser.newBrowserCDPSession();
  try {
    const promise = context.waitForEvent("page", { timeout: 15000 });
    await bs.send("Target.createTarget", {
      url: "about:blank",
      browserContextId: targetInfo.browserContextId,
      enableBeginFrameControl: true,
      width: 1440,
      height: 900,
    });
    return await promise;
  } finally {
    await helper.close();
    await bs.detach();
  }
}
export function frameDriver(cdp) {
  let pumping = false,
    done = Promise.resolve(),
    error,
    stepping = false;
  const begin = (hz) =>
    cdp.send("HeadlessExperimental.beginFrame", {
      interval: 1000 / hz,
      noDisplayUpdates: false,
    });
  return {
    pump() {
      if (pumping) return;
      if (stepping) throw new Error("Cannot pump during step");
      pumping = true;
      error = null;
      done = (async () => {
        try {
          while (pumping) {
            await begin(120);
            await sleep(8);
          }
        } catch (e) {
          error = e;
          pumping = false;
        }
      })();
    },
    async stop() {
      pumping = false;
      await done;
      if (error) {
        const e = error;
        error = null;
        throw e;
      }
    },
    async step(n, { hz = 120, paced = true } = {}) {
      if (pumping || stepping) throw new Error("Concurrent frame driver use");
      stepping = true;
      try {
        const t0 = performance.now(),
          interval = 1000 / hz,
          roundTrips = [];
        for (let k = 0; k < n; k++) {
          if (paced) await sleep(t0 + k * interval - performance.now());
          const t = performance.now();
          await begin(hz);
          roundTrips.push(performance.now() - t);
        }
        if (paced) await sleep(t0 + n * interval - performance.now());
        const wall = performance.now() - t0,
          nominal = n * interval;
        return {
          frames: n,
          hz,
          wall,
          nominal,
          roundTrips,
          paced,
          valid: !paced || Math.abs(wall - nominal) / nominal <= 0.01,
        };
      } finally {
        stepping = false;
      }
    },
  };
}
