import { track } from "./analytics.js";

// ─── Shareable URL helpers ───────────────────────────────────────────────
// In production we have no /api/save (Vercel filesystem is read-only), so
// the persistence story for visitors is "encode the editor buffer into a
// URL hash and copy it to the clipboard". The hash survives reload, and the
// initialiser below picks it up on next page load.
//
// We gzip the source before base64url-encoding it (`z:` prefix flags the
// compressed form). Real patterns are repetitive enough that a ~10KB file
// shrinks to ~1.5KB encoded — well under the 6KB cap. Bare (uncompressed)
// legacy URLs still decode so old share links keep working.
export const SHARE_MAX_ENCODED = 6000;

export async function encodeShareCode(code) {
  const raw = new TextEncoder().encode(code);
  const gz = await gzipBytes(raw);
  return `z:${bytesToBase64Url(gz)}`;
}

export async function decodeShareCode(encoded) {
  if (encoded.startsWith("z:")) {
    const raw = await gunzipBytes(base64UrlToBytes(encoded.slice(2)));
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

// ─── Share current editor → URL with #code=... ──────────────────────────
// Encodes the editor buffer into a gzipped base64url hash, copies the
// resulting URL to the clipboard, and updates the address bar so a refresh
// keeps the work (and the user can fall back to copying from the URL bar).
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
  // Update the address bar so refresh keeps the work and the user has a
  // visible copy even if the clipboard write fails.
  history.replaceState(null, "", hash);
  const url = `${location.origin}${location.pathname}${hash}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus("share link copied to clipboard");
  } catch {
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

async function gunzipBytes(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
