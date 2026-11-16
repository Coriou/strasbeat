// Loading code that isn't needed to show and use the editor.
//
// Everything outside the first-paint path (the docs index, the right-rail
// panels, the Vim and Emacs keymaps) is split into chunks that are fetched
// on demand. A fetch like that can fail in two ordinary ways: the network is
// gone, or a new version was deployed since this page loaded and the chunk's
// content-hashed file name no longer exists on the server. A bare `import()`
// turns either into an unhandled rejection and a feature that silently does
// nothing, so every on-demand import goes through `lazyImport`, which tells
// the user what failed and what to do about it, then rethrows so the caller
// can put its own UI back in a sane state. Nothing is cached on failure:
// calling again retries.

let reporter = null;
// Failures that happened before the app registered its reporter.
const unreported = [];

export class LazyImportError extends Error {
  constructor(what, cause, { online = true } = {}) {
    super(describeLazyFailure(what, { online }), { cause });
    this.name = "LazyImportError";
    this.what = what;
  }
}

/**
 * The user-facing sentence for a failed on-demand load.
 *
 * @param {string} what  the thing that failed, as a noun phrase that reads
 *   after "Couldn't load" — "the Vim keymap", "the Sound browser"
 * @param {{ online?: boolean }} [opts]  whether the browser believes it has
 *   a network connection
 */
export function describeLazyFailure(what, { online = true } = {}) {
  const subject = `Couldn't load ${what || "part of the app"}`;
  return online
    ? `${subject}. Check your connection and try again — if strasbeat was just updated, reload the page.`
    : `${subject}: you appear to be offline. Try again once you're back online.`;
}

/**
 * Where failed loads are shown to the user. Called once by the app as soon
 * as it has somewhere to show them; failures from before that are replayed.
 *
 * @param {((err: LazyImportError) => void) | null} fn
 */
export function setLazyImportReporter(fn) {
  reporter = typeof fn === "function" ? fn : null;
  if (!reporter) return;
  for (const err of unreported.splice(0)) report(err);
}

function report(err) {
  if (!reporter) {
    unreported.push(err);
    return;
  }
  try {
    reporter(err);
  } catch (reporterErr) {
    console.warn("[strasbeat/lazy] failure reporter threw:", reporterErr);
  }
}

/**
 * Run an on-demand import and surface its failure.
 *
 * @template T
 * @param {() => Promise<T>} load  the `() => import("…")` thunk — kept as a
 *   literal at the call site so the bundler can see the chunk boundary
 * @param {object} [opts]
 * @param {string} [opts.what]  what is being loaded, for the message
 * @param {boolean} [opts.silent]  don't tell the user (background warm-ups
 *   the user didn't ask for; the failure is still logged and rethrown)
 * @returns {Promise<T>}
 */
export async function lazyImport(load, { what = "", silent = false } = {}) {
  try {
    return await load();
  } catch (cause) {
    const online = globalThis.navigator?.onLine !== false;
    const err = new LazyImportError(what, cause, { online });
    console.warn(`[strasbeat/lazy] ${err.message}`, cause);
    if (!silent) report(err);
    throw err;
  }
}

/**
 * Wrap a loader so concurrent callers share one in-flight attempt and a
 * successful result is kept, while a failed attempt is forgotten so the next
 * call tries again.
 *
 * @template T
 * @param {(opts?: { silent?: boolean }) => Promise<T>} load
 * @returns {{
 *   (opts?: { silent?: boolean }): Promise<T>,
 *   loaded: () => boolean,
 *   value: () => T | undefined,
 * }}
 */
export function once(load) {
  let pending = null;
  let done = false;
  let result;
  const run = (opts) => {
    if (done) return Promise.resolve(result);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => load(opts))
        .then(
          (value) => {
            result = value;
            done = true;
            pending = null;
            return value;
          },
          (err) => {
            pending = null;
            throw err;
          },
        );
    }
    return pending;
  };
  run.loaded = () => done;
  run.value = () => result;
  return run;
}
