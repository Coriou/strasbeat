// The worker a STRASBEAT_SW=off build ships as /sw.js: the deployable kill
// switch. It replaces whatever worker a browser has, deletes strasbeat's
// caches, unregisters itself and reloads the open windows from the network.
import { CACHE_PREFIX } from "./policy.js";

// It must take over even while windows running the old worker are open.
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(
        (await caches.keys())
          .filter((key) => key.startsWith(CACHE_PREFIX))
          .map((key) => caches.delete(key)),
      );
      await self.registration.unregister();
      await Promise.all(
        (
          await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
          })
        ).map((client) =>
          client
            .navigate(client.url)
            .catch((err) =>
              console.warn("[strasbeat/sw] emergency reload failed", err),
            ),
        ),
      );
    })(),
  );
});
