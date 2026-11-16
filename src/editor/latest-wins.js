// Latest-wins runner for work that is too expensive to do once per frame.
//
// The numeric scrubber wants the audio to follow a drag, and "following"
// means a full transpile + evaluate of the buffer — 25–140 ms on a
// 100–450-line pattern. Firing that from every animation frame makes each
// frame block for the whole evaluate, so the dragged number itself updates
// at evaluate speed instead of pointer speed.
//
// This runner keeps at most one run in flight and never queues more than
// one: requests that arrive while it is busy collapse into a single trailing
// run, which reads the then-current state (so the latest value always wins
// and the final value of a drag is always applied). After each run it stays
// idle for as long as that run took, capped at `maxGapMs` — a cheap run
// re-fires on the next request, an expensive one leaves at least half the
// main thread free for the editor to keep painting.

const DEFAULT_MAX_GAP_MS = 250;

/**
 * @param {() => unknown} run  May return a promise; a run counts as in
 *   flight until it settles.
 * @param {object} [opts]
 * @param {number} [opts.maxGapMs]
 * @param {() => number} [opts.now]  Clock injection for tests.
 * @param {(fn: () => void, ms: number) => unknown} [opts.setTimer]
 * @param {(err: unknown) => void} [opts.onError]
 * @returns {() => void} request — ask for a run; safe to call at any rate.
 */
export function createLatestWinsRunner(
  run,
  {
    maxGapMs = DEFAULT_MAX_GAP_MS,
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    onError = (err) => console.warn("[strasbeat/latest-wins] run failed:", err),
  } = {},
) {
  let running = false;
  let waiting = false; // a timer is armed for the trailing run
  let pending = false; // a request arrived while running
  let idleUntil = -Infinity;

  function fire() {
    waiting = false;
    pending = false;
    running = true;
    const startedAt = now();
    let result;
    try {
      result = run();
    } catch (err) {
      result = Promise.reject(err);
    }
    Promise.resolve(result)
      .catch(onError)
      .then(() => {
        const finishedAt = now();
        idleUntil = finishedAt + Math.min(maxGapMs, finishedAt - startedAt);
        running = false;
        if (pending) request();
      });
  }

  function request() {
    if (running) {
      pending = true;
      return;
    }
    if (waiting) return;
    const wait = idleUntil - now();
    if (wait > 0) {
      waiting = true;
      setTimer(fire, wait);
      return;
    }
    fire();
  }

  return request;
}
