// strasbeat's service worker: the app shell and its hashed files from a
// versioned precache, the default sample manifests stale-while-revalidate,
// default sample audio cache-first, everything else untouched. The rules
// for each kind of request are in policy.js; what must stay true across a
// change is in docs/architecture.md ("Service worker, updates and offline").
// Built into one classic script, /sw.js, by plugin.js, which also fills in
// the three __CONSTANTS__ below.
import { DEFAULT_MANIFESTS } from "../default-samples.js";
import {
  classify,
  cacheable,
  PRECACHE_PREFIX,
  MANIFEST_CACHE,
  ASSET_CACHE,
  AUDIO_CACHE,
  AUDIO_ENTRIES,
  AUDIO_MAX_BYTES,
} from "./policy.js";

import { retainAssets, collectRetired, matchRetired } from "./retired.js";

const PRECACHE = __PRECACHE__;
const ALL_ASSETS = new Set(__ALL_ASSETS__);
const CACHE = `${PRECACHE_PREFIX}${__SW_VERSION__}`;
const urls = new Set(PRECACHE.map((entry) => entry.url));
const warn = (err) => console.warn("[strasbeat/sw]", err);

async function warmManifest(url) {
  const response = await fetch(new URL(url, self.location.origin), {
    cache: "no-cache",
    signal: AbortSignal.timeout(15000),
  });
  if (!cacheable(response))
    throw new Error(`Manifest ${url}: HTTP ${response.status}`);
  await (await caches.open(MANIFEST_CACHE)).put(url, response);
}

// A response that arrived through a redirect cannot answer a navigation
// (the browser refuses it), so if the host ever redirects a shell URL the
// copy that goes into the cache is a plain one.
async function unredirected(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function precacheEntry(cache, url) {
  // A hashed file never changes under its name. Take it from any cache that
  // already holds it (the previous build's precache, a chunk fetched on
  // demand) or from the HTTP cache, so an update downloads what changed and
  // not every chunk again. The shell's unhashed files go to the network.
  const hashed = url.startsWith("/assets/");
  let response = hashed ? await caches.match(url) : undefined;
  if (!response || !cacheable(response)) {
    response = await fetch(
      new Request(url, { cache: hashed ? "default" : "reload" }),
    );
  }
  if (!cacheable(response))
    throw new Error(`Precache ${url}: HTTP ${response.status}`);
  await cache.put(url, await unredirected(response));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Written inside install, which is also when Chrome builds its code
      // cache for these scripts. A partial or opaque shell must fail the
      // installation, which leaves the previous worker and its app in place.
      await Promise.all(PRECACHE.map(({ url }) => precacheEntry(cache, url)));
      // Boot ran before registration, so those fetches were not intercepted.
      // Warm the manifests once here; an unavailable sample host must not
      // prevent the app shell from installing. Boot reports missing maps.
      await Promise.all(
        DEFAULT_MANIFESTS.map((url) => warmManifest(url).catch(warn)),
      );
    })(),
  );
});

// Drops what the previous builds left behind, after setting aside the hashed
// files that windows still running one of those builds may ask for.
async function retirePreviousBuilds() {
  const clients = (
    await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    })
  ).map((client) => client.id);
  await collectRetired(caches, clients);
  const old = (await caches.keys()).filter(
    (key) => key.startsWith(PRECACHE_PREFIX) && key !== CACHE,
  );
  const assets = await caches.open(ASSET_CACHE);
  const obsolete = (request) => !ALL_ASSETS.has(new URL(request.url).pathname);
  const sources = await Promise.all(
    old.map(async (key) => ({
      cache: await caches.open(key),
      keep: () => true,
    })),
  );
  sources.push({ cache: assets, keep: obsolete });
  await retainAssets(caches, __SW_VERSION__, sources, clients);
  await Promise.all(old.map((key) => caches.delete(key)));
  await Promise.all(
    (await assets.keys())
      .filter(obsolete)
      .map((request) => assets.delete(request)),
  );
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // A failure here (a full disk while copying, say) must not keep the
      // new worker from taking over: what was not cleaned up is cleaned up
      // by the next activation.
      await retirePreviousBuilds().catch(warn);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});

// Serialize audio writes and pruning: parallel sample loads must not all see
// a below-cap cache and then collectively exceed it. Reads never wait here.
let audioWrites = Promise.resolve();
function storeAudio(cache, request, response) {
  const copy = response.clone();
  const write = audioWrites.then(async () => {
    await cache.put(request, copy);
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - AUDIO_ENTRIES)))
      await cache.delete(key);
  });
  audioWrites = write.catch(warn);
  return audioWrites;
}

async function cacheFirst(event, name, key, audio = false) {
  let cache;
  try {
    cache = await caches.open(name);
    const hit = await cache.match(key);
    if (hit) return hit;
    if (name === ASSET_CACHE) {
      const retired = await matchRetired(caches, key, event.clientId);
      if (retired) return retired;
    }
  } catch (err) {
    warn(err);
  }
  const response = await fetch(event.request);
  if (
    cache &&
    cacheable(response) &&
    (!audio ||
      Number(response.headers.get("content-length") || 0) <= AUDIO_MAX_BYTES)
  ) {
    event.waitUntil(
      audio
        ? storeAudio(cache, key, response)
        : cache.put(key, response.clone()).catch(warn),
    );
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const kind = classify(event.request, self.location.origin, urls);
  if (!kind) return;
  if (kind === "shell") {
    event.waitUntil(
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) =>
          collectRetired(
            caches,
            clients.map((client) => client.id),
          ),
        )
        .catch(warn),
    );
  }
  if (kind === "manifest") {
    // Register lifetime work synchronously, even when the cached response
    // wins. A rejected refresh must not turn an offline cache hit into failure.
    const refresh = (async () => {
      const response = await fetch(
        new Request(event.request, { cache: "no-cache" }),
      );
      if (cacheable(response)) {
        try {
          await (
            await caches.open(MANIFEST_CACHE)
          ).put(event.request, response.clone());
        } catch (err) {
          warn(err);
        }
      }
      return response;
    })();
    event.waitUntil(refresh.catch(warn));
    event.respondWith(
      (async () => {
        try {
          const hit = await (
            await caches.open(MANIFEST_CACHE)
          ).match(event.request);
          if (hit) return hit;
        } catch (err) {
          warn(err);
        }
        return refresh;
      })(),
    );
  } else {
    const name =
      kind === "audio" ? AUDIO_CACHE : kind === "asset" ? ASSET_CACHE : CACHE;
    const key = kind === "shell" ? "/index.html" : event.request;
    event.respondWith(cacheFirst(event, name, key, kind === "audio"));
  }
});
