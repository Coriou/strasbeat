// Keeps a previous build's hashed files alive for the windows that are
// still running that build, after a newer worker has taken over.
import { CACHE_PREFIX, cacheable } from "./policy.js";

const PREFIX = `${CACHE_PREFIX}retired-`;
const OWNERS = "/__strasbeat_cache_owners__";

// skipWaiting replaces the controller in every window, not only the one
// whose user clicked. Preserve the old hashed assets for those window IDs
// before removing old precaches. New windows cannot use these leases.
export async function retainAssets(storage, name, sources, clientIds) {
  if (!clientIds.length) return;
  const retained = [];
  for (const { cache: source, keep } of sources) {
    for (const request of await source.keys()) {
      if (
        !new URL(request.url).pathname.startsWith("/assets/") ||
        !keep(request)
      )
        continue;
      const response = await source.match(request);
      if (response && cacheable(response)) retained.push([request, response]);
    }
  }
  // Nothing to hand over (a first install): no lease to keep track of.
  if (!retained.length) return;
  const cache = await storage.open(`${PREFIX}${name}`);
  const previous = await cache.match(OWNERS);
  const owners = new Set(previous ? await previous.json() : []);
  clientIds.forEach((id) => owners.add(id));
  await cache.put(OWNERS, new Response(JSON.stringify([...owners])));
  for (const [request, response] of retained)
    await cache.put(request, response);
}

export async function collectRetired(storage, clientIds) {
  const live = new Set(clientIds);
  for (const name of await storage.keys()) {
    if (!name.startsWith(PREFIX)) continue;
    const cache = await storage.open(name);
    const response = await cache.match(OWNERS);
    const owners = response
      ? (await response.json()).filter((id) => live.has(id))
      : [];
    if (!owners.length) await storage.delete(name);
    else await cache.put(OWNERS, new Response(JSON.stringify(owners)));
  }
}

// A request that names no client (browsers differ on whether the fetch of
// a `new Worker(...)` script names its window) is answered from any lease.
// That is safe: a hashed file is the same bytes whoever asks, and a lease
// only exists while a window of that build is open.
export async function matchRetired(storage, request, clientId) {
  for (const name of await storage.keys()) {
    if (!name.startsWith(PREFIX)) continue;
    const cache = await storage.open(name);
    const response = await cache.match(OWNERS);
    if (!response) continue;
    if (!clientId || (await response.json()).includes(clientId)) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
  }
}
