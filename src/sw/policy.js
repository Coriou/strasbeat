import { DEFAULT_MANIFESTS, CDN } from "../default-samples.js";

// Request classification and cache names for the service worker. Pure, so
// it is unit-tested under node; worker.js is the only thing that acts on it.
// Every cache name starts with CACHE_PREFIX: the kill switches delete by it.
export const CACHE_PREFIX = "strasbeat-";
export const MANIFEST_CACHE = `${CACHE_PREFIX}manifests-v1`;
export const AUDIO_CACHE = `${CACHE_PREFIX}audio-v1`;
export const ASSET_CACHE = `${CACHE_PREFIX}assets-v1`;
export const PRECACHE_PREFIX = `${CACHE_PREFIX}precache-`;
// At most 256 previously used default sounds, oldest insertion first. Skip
// bodies advertised above 16 MiB. User packs and manifests are never cached.
export const AUDIO_ENTRIES = 256;
export const AUDIO_MAX_BYTES = 16 * 1024 * 1024;

export function cacheable(response) {
  return response.ok && response.type !== "opaque" && response.status !== 206;
}

// Which rule a request falls under, or null to leave it to the browser:
// "shell" (the app's own page), "precache", "asset" (a hashed file outside
// the precache), "manifest" (a default sample map) or "audio" (a default
// sample). `precache` is the set of precached paths.
export function classify(request, origin, precache) {
  if (request.method !== "GET" || request.headers.has("range")) return null;
  // Re-issuing such a request from a worker throws (DevTools sends them).
  if (request.cache === "only-if-cached" && request.mode !== "same-origin")
    return null;
  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return null;
  const local = url.origin === origin;
  if (local && (url.pathname === "/sw.js" || url.pathname.startsWith("/api/")))
    return null;
  if (request.mode === "navigate") {
    return local && ["/", "/index.html"].includes(url.pathname)
      ? "shell"
      : null;
  }
  if (local && !url.search && precache.has(url.pathname)) return "precache";
  if (local && url.pathname.startsWith("/assets/")) return "asset";
  if (
    DEFAULT_MANIFESTS.some((value) => new URL(value, origin).href === url.href)
  )
    return "manifest";
  // These are the default bases emitted by superdough's github: resolver
  // and @strudel/soundfonts. GitHub repo/path casing varies by manifest.
  const githubAudio =
    url.origin === "https://raw.githubusercontent.com" &&
    /^\/(tidalcycles\/(dirt-samples|uzu-drumkit)|ritchse\/tidal-drum-machines)\//i.test(
      url.pathname,
    );
  const fontAudio =
    url.origin === "https://felixroos.github.io" &&
    url.pathname.toLowerCase().startsWith("/webaudiofontdata/sound/");
  const defaultAudio = githubAudio || fontAudio || url.origin === CDN;
  // A user-authored JSON manifest, even inside a default base, stays live.
  if (defaultAudio && !url.pathname.toLowerCase().endsWith(".json"))
    return "audio";
  return null;
}
