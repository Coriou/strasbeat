// The Strudel function docs index (strudel-docs.json), loaded after the
// editor is on screen instead of with it.
//
// The index is a couple of hundred kB of JSON that nothing needs in order to
// paint the editor or take the first keystroke, so it lives in its own chunk.
// Hover docs, the signature hint and function completions read it through
// `getDocs()` at the moment they need it: until the chunk has arrived that is
// an empty object, so they simply have nothing to show yet, and they start
// working on the next hover / keystroke after it lands — no reload, no
// re-installation of editor extensions. Code that derives something from the
// index once (the completion list, the reference panel) subscribes with
// `onDocsLoaded`.
//
// If the fetch fails (it is reported once, where it was asked for), the next
// read of the index after a short pause quietly tries again, so hover docs
// come back by themselves once the network does.

import { lazyImport, once } from "../lazy-import.js";

const RETRY_AFTER_MS = 5000;

let docs = {};
let loaded = false;
// When the last fetch failed, if nothing has retried since.
let failedAt = null;
const listeners = new Set();

/**
 * Whether a read of the still-empty index should start another fetch.
 *
 * @param {{ loaded: boolean, failedAt: number | null, now: number, retryAfterMs?: number }} s
 */
export function shouldRetryDocs({
  loaded,
  failedAt,
  now,
  retryAfterMs = RETRY_AFTER_MS,
}) {
  return !loaded && failedAt != null && now - failedAt >= retryAfterMs;
}

/** The docs index: `{ [functionName]: entry }`. Empty until loaded. */
export function getDocs() {
  if (shouldRetryDocs({ loaded, failedAt, now: Date.now() })) {
    // The first failure was shown to the user; this one need not be.
    loadDocs({ silent: true }).catch(() => {});
  }
  return docs;
}

export function areDocsLoaded() {
  return loaded;
}

/**
 * Install the index and notify subscribers. Called by `loadDocs`; tests call
 * it directly with the JSON read from disk.
 *
 * @param {Record<string, object>} next
 */
export function setDocs(next) {
  docs = next && typeof next === "object" ? next : {};
  loaded = true;
  for (const fn of [...listeners]) {
    try {
      fn(docs);
    } catch (err) {
      console.warn("[strasbeat/docs] docs listener threw:", err);
    }
  }
}

/**
 * Run `fn(docs)` once the index is available — immediately if it already
 * is, and again if it is ever replaced. Returns an unsubscribe function.
 *
 * @param {(docs: Record<string, object>) => void} fn
 */
export function onDocsLoaded(fn) {
  listeners.add(fn);
  if (loaded) fn(docs);
  return () => listeners.delete(fn);
}

/**
 * Fetch the index (once; a failed attempt is retried by the next call).
 * Resolves with the docs object.
 *
 * @type {(opts?: { silent?: boolean }) => Promise<Record<string, object>>}
 */
export const loadDocs = once(async ({ silent = false } = {}) => {
  failedAt = null;
  let mod;
  try {
    mod = await lazyImport(() => import("./strudel-docs.json"), {
      what: "the function docs (hover docs, signature hints, API reference)",
      silent,
    });
  } catch (err) {
    failedAt = Date.now();
    throw err;
  }
  setDocs(mod.default);
  return docs;
});
