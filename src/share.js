import { track } from "./analytics.js";
import { storageIsEphemeral } from "./storage-guard.js";

// ─── Shareable URL helpers ───────────────────────────────────────────────
// A share link is the editor buffer encoded into a URL hash. Opening one
// lands the code as a regular user pattern in the recipient's library (see
// adoptSharedPattern) and the hash is then removed from the address bar: from
// that point on the recipient's copy lives in the store like any other
// pattern, and a reload must restore THAT, not the original snapshot.
//
// We gzip the source before base64url-encoding it (`z:` prefix flags the
// compressed form). Real patterns are repetitive enough that a ~10KB file
// shrinks to ~1.5KB encoded — well under the 6KB cap. Bare (uncompressed)
// legacy URLs still decode so old share links keep working.
export const SHARE_MAX_ENCODED = 6000;
// Decode-side limits. A link is attacker-controlled input and gzip expands up
// to ~1000×, so a few kB of hash can otherwise inflate to gigabytes inside the
// boot-time await and hang the tab on every load of that URL. Both limits sit
// far above anything encodeShareCode's own cap can produce for real code.
export const SHARE_MAX_ENCODED_ACCEPTED = SHARE_MAX_ENCODED * 4;
export const SHARE_MAX_DECODED_BYTES = 512 * 1024;

export async function encodeShareCode(code) {
  const raw = new TextEncoder().encode(code);
  const gz = await gzipBytes(raw);
  return `z:${bytesToBase64Url(gz)}`;
}

export async function decodeShareCode(encoded) {
  if (encoded.length > SHARE_MAX_ENCODED_ACCEPTED) {
    throw new Error("shared code is too large");
  }
  if (encoded.startsWith("z:")) {
    const raw = await gunzipBytes(
      base64UrlToBytes(encoded.slice(2)),
      SHARE_MAX_DECODED_BYTES,
    );
    return new TextDecoder().decode(raw);
  }
  return new TextDecoder().decode(base64UrlToBytes(encoded));
}

export async function readSharedFromHash() {
  if (!location.hash) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const codeParam = params.get("code");
  if (!codeParam) return null;
  try {
    return {
      code: await decodeShareCode(codeParam),
      name: params.get("name") || "shared",
    };
  } catch (err) {
    console.warn("[strasbeat] failed to decode shared code from URL:", err);
    return null;
  }
}

// ─── Arrival: shared code → a user pattern in the store ─────────────────

const SHARED_NAME_MAX = 40;

function sanitizeSharedName(name) {
  return String(name ?? "").replace(/[^a-z0-9_-]/gi, "-");
}

/**
 * Decide where shared code lands. Pure: reads the store, writes nothing.
 *
 *   1. The link names a pattern this browser already has with exactly this
 *      code (the sharer reloading their own link, or a Demo everyone has)
 *      → open that one; there is nothing to import.
 *   2. Otherwise it becomes `shared-<name>`. If that name is taken by a record
 *      holding the same code (the same link opened again) it is reused; if it
 *      holds different code — the recipient's own edits, or another link with
 *      the same name — the arrival moves on to `shared-<name>-2`, `-3`, …
 *      An existing record is never overwritten.
 *
 * @returns {{ name: string, code: string, create: boolean }}
 *   create: true when a new record has to be written under `name`.
 */
export function resolveSharedArrival({ shared, store, patterns }) {
  const code = shared.code;
  const codeOf = (name) => {
    const rec = store.get(name);
    if (rec && typeof rec.code === "string") return rec.code;
    return name in patterns ? patterns[name] : undefined;
  };

  const original = sanitizeSharedName(shared.name);
  if (original && codeOf(original) === code) {
    return { name: original, code, create: false };
  }

  const base = `shared-${original || "shared"}`.slice(0, SHARED_NAME_MAX);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const existing = codeOf(candidate);
    if (existing === undefined && store.get(candidate) == null) {
      return { name: candidate, code, create: true };
    }
    if (existing === code) return { name: candidate, code, create: false };
  }
}

/**
 * Land shared code in the library: write the record if one is needed, make
 * sure the pattern is listed in the index (so it shows up in the rail and
 * stays reachable after its tab is closed), then drop the hash from the URL.
 *
 * The hash is only cleared once the pattern is safely stored. If the write
 * fails (storage full) the link stays in the address bar so nothing is lost,
 * and `saved` is false so the caller can say so. It also stays when storage is
 * the in-memory stand-in (see storage-guard.js): the write "succeeds" there
 * but lasts only for the session, so the link is still the one durable copy.
 *
 * @returns {{ name: string, code: string, saved: boolean, created: boolean }}
 */
export function adoptSharedPattern({
  shared,
  store,
  patterns,
  clearHash = clearShareHash,
  isEphemeral = storageIsEphemeral,
  now = () => new Date(),
}) {
  const { name, code, create } = resolveSharedArrival({ shared, store, patterns });
  try {
    if (create) {
      const ok = store.set(name, {
        code,
        modified: now().toISOString(),
        isUserPattern: true,
      });
      if (ok === false) throw new Error("storage refused the write");
    }
    if (!(name in patterns)) {
      const idx = store.getIndex();
      if (!(idx.userPatterns ?? []).includes(name)) {
        store.setIndex({
          ...idx,
          userPatterns: [...(idx.userPatterns ?? []), name],
        });
      }
    }
  } catch (err) {
    console.warn("[strasbeat] couldn't store the shared pattern:", err);
    return { name, code, saved: false, created: false };
  }
  if (!isEphemeral()) clearHash();
  return { name, code, saved: true, created: create };
}

/** Remove the #code=… fragment from the address bar without navigating. */
export function clearShareHash() {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch (err) {
    console.warn("[strasbeat] couldn't clear the share link from the URL:", err);
  }
}

// ─── Share current editor → URL with #code=... ──────────────────────────
// Encodes the editor buffer into a gzipped base64url hash and copies the
// resulting URL to the clipboard. The sharer's own address bar is left alone:
// writing the hash there would make their next reload open the link as an
// arrival instead of resuming the pattern they were working on. Only when the
// clipboard is unavailable does the hash go into the URL bar, as the one place
// left to copy it from.
// Returns true when a share URL was generated (regardless of clipboard
// permission), false when nothing was shared. Callers use this to decide
// whether to flash success or error feedback.
export async function shareCurrent({ getCode, getName, setStatus }) {
  const code = getCode() ?? "";
  if (!code.trim()) {
    setStatus("nothing to share — editor is empty");
    return false;
  }
  let encoded;
  try {
    encoded = await encodeShareCode(code);
  } catch (err) {
    console.warn("[strasbeat] share encode failed:", err);
    setStatus("share failed — could not encode pattern");
    return false;
  }
  if (encoded.length > SHARE_MAX_ENCODED) {
    const kb = (n) => `${(n / 1024).toFixed(1)}kB`;
    setStatus(
      `pattern too large to share — ${kb(encoded.length)} compressed, ${kb(SHARE_MAX_ENCODED)} max`,
    );
    return false;
  }
  const currentName = getName();
  const params = new URLSearchParams({ code: encoded });
  if (currentName) params.set("name", currentName);
  const hash = `#${params.toString()}`;
  const url = `${location.origin}${location.pathname}${hash}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus("share link copied to clipboard");
  } catch {
    history.replaceState(null, "", hash);
    setStatus("share link is in the URL bar — copy from there");
  }
  track("pattern_shared");
  return true;
}

// ─── Byte / base64url plumbing ───────────────────────────────────────────

async function gzipBytes(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Inflate with a byte budget: read chunk by chunk and abort as soon as the
// output passes `maxBytes`, so an oversized payload is never materialised.
async function gunzipBytes(bytes, maxBytes) {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("shared code is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
