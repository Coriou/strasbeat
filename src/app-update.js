// App updates and offline, for the web: registering the service worker
// (src/sw/), noticing a new version, and applying it when the user asks.
//
// This is the one module that knows the app is delivered by a web server and
// kept by a service worker. A desktop shell would replace it with its own
// updater and leave boot, editing and playback as they are.
//
// The rules it keeps (docs/architecture.md, "Service worker, updates and
// offline"): nothing here runs before boot has finished; a new version never
// takes over a running session by itself; a failure to register or to
// install is shown, a failed check for updates is not (being offline is a
// supported state, not an error).
import { flagEnabled } from "./flags.js";
import { CACHE_PREFIX } from "./sw/policy.js";
import { mountUpdateNotice } from "./ui/app-update-notice.js";

export const UPDATE_INTERVAL = 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {ServiceWorkerContainer} [deps.serviceWorker]
 * @param {(apply: () => void) => (() => void) | void} deps.showNotice
 *   shows "a new version is ready"; `apply` is the user's go-ahead. May
 *   return a function that closes the notice.
 * @param {() => void} deps.reload
 * @param {(message: string, err: unknown) => void} deps.report  for the
 *   user: something they can act on
 * @param {(message: string, err: unknown) => void} [deps.log]  for the
 *   console only
 * @param {Document} deps.document
 */
export async function registerUpdates({
  serviceWorker,
  showNotice,
  reload,
  report,
  log = (message, err) => console.warn(`[strasbeat/update] ${message}`, err),
  document: doc,
  now = Date.now,
  interval = setInterval,
}) {
  if (!serviceWorker) return null;
  try {
    const registration = await serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    let requested = false;
    let reloaded = false;
    let offered = null;
    let closeNotice;
    serviceWorker.addEventListener("controllerchange", () => {
      if (!requested || reloaded) return;
      reloaded = true;
      reload();
    });
    const offer = () => {
      const worker = registration.waiting;
      if (!worker || !serviceWorker.controller || offered === worker) return;
      offered = worker;
      if (typeof closeNotice === "function") closeNotice();
      closeNotice = showNotice(() => {
        if (requested || reloaded || offered !== worker) return;
        if (registration.waiting !== worker) {
          // No longer waiting: another window applied this update (the new
          // worker took over every window, and only that one reloaded), or
          // the worker was discarded. There is nothing left to activate;
          // the reload the user asked for brings the page up to date.
          reloaded = true;
          reload();
          return;
        }
        requested = true;
        try {
          worker.postMessage({ type: "SKIP_WAITING" });
        } catch (err) {
          requested = false;
          report("Couldn't apply the app update. Try again.", err);
        }
      });
    };
    const watch = () => {
      const worker = registration.installing;
      if (!worker) return;
      let installed = ["installed", "activating", "activated"].includes(
        worker.state,
      );
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") {
          installed = true;
          offer();
        }
        if (worker.state === "redundant" && !installed)
          report(
            "The app update could not install. Your current version is still available.",
            new Error("Worker became redundant"),
          );
      });
      if (worker.state === "installed") offer();
    };
    registration.addEventListener("updatefound", watch);
    watch();
    offer();
    let lastCheck = now();
    const update = async () => {
      lastCheck = now();
      try {
        await registration.update();
      } catch (err) {
        // Offline, or the host is unreachable: the app in hand keeps
        // working and the next check will do.
        log("couldn't check for app updates", err);
      }
    };
    // register() checks the script too, but an explicit check ensures every
    // launch goes to the network regardless of the browser's check throttle.
    void update();
    const check = () => {
      if (
        doc.visibilityState === "visible" &&
        now() - lastCheck >= UPDATE_INTERVAL
      )
        void update();
    };
    doc.addEventListener("visibilitychange", check);
    interval(check, UPDATE_INTERVAL);
    return registration;
  } catch (err) {
    report(
      "Offline support could not start. Check your connection and reload to retry.",
      err,
    );
    return null;
  }
}

export async function disableWorker(serviceWorker, cacheStorage) {
  const registrations = (await serviceWorker?.getRegistrations()) ?? [];
  const ours = registrations.filter((registration) =>
    [registration.active, registration.waiting, registration.installing].some(
      (worker) => worker && new URL(worker.scriptURL).pathname === "/sw.js",
    ),
  );
  await Promise.all(ours.map((registration) => registration.unregister()));
  if (cacheStorage)
    await Promise.all(
      (await cacheStorage.keys())
        .filter((name) => name.startsWith(CACHE_PREFIX))
        .map((name) => cacheStorage.delete(name)),
    );
  return ours.length > 0;
}

/**
 * @param {object} deps
 * @param {Promise<void>} deps.bootPromise
 * @param {(text: string) => void} deps.setStatus  the transport's status line
 */
export function initAppUpdates({ bootPromise, setStatus }) {
  const report = (message, err) => {
    console.warn(`[strasbeat/update] ${message}`, err);
    setStatus(message);
  };
  const enabled = import.meta.env.PROD && __SW_ENABLED__;
  // Read flags even in an emergency build, so ?sb-sw=on can clear an old flag.
  const browserEnabled = flagEnabled("sw");
  if (!enabled || !browserEnabled) {
    void Promise.resolve()
      .then(() => disableWorker(navigator.serviceWorker, globalThis.caches))
      .then((removed) => {
        if (removed && navigator.serviceWorker?.controller) location.reload();
      })
      .catch((err) =>
        report(
          "Couldn't disable offline support. Close other strasbeat windows and retry.",
          err,
        ),
      );
    return;
  }
  if (!navigator.serviceWorker) return;
  void bootPromise
    .then(
      () =>
        new Promise((resolve) => {
          if (globalThis.requestIdleCallback)
            requestIdleCallback(resolve, { timeout: 5000 });
          else setTimeout(resolve, 1000);
        }),
    )
    .then(() =>
      registerUpdates({
        serviceWorker: navigator.serviceWorker,
        showNotice: (apply) => mountUpdateNotice(apply),
        reload: () => location.reload(),
        report,
        document,
      }),
    )
    .catch((err) => report("Offline support could not start.", err));
}
