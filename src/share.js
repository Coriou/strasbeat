// ─── Shareable URL helpers ───────────────────────────────────────────────
// In production we have no /api/save (Vercel filesystem is read-only), so
// the persistence story for visitors is "encode the editor buffer into a
// URL hash and copy it to the clipboard". The hash survives reload, and the
// initialiser below picks it up on next page load. base64url is binary-safe
// so multi-line patterns with backticks and ${} round-trip cleanly.
export const SHARE_MAX_ENCODED = 6000; // ~6KB hash, comfortably under URL limits

export function encodeShareCode(code) {
  const bytes = new TextEncoder().encode(code);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShareCode(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function readSharedFromHash() {
  if (!location.hash) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const codeParam = params.get("code");
  if (!codeParam) return null;
  try {
    return {
      code: decodeShareCode(codeParam),
      name: params.get("name") || "shared",
    };
  } catch (err) {
    console.warn("[strasbeat] failed to decode shared code from URL:", err);
    return null;
  }
}

// ─── Share current editor → URL with #code=... ──────────────────────────
// Encodes the editor buffer into a base64url hash, copies the resulting URL
// to the clipboard, and updates the address bar so a refresh keeps the work
// (and the user can fall back to copying from the URL bar). This is the
// production persistence story — see the dev-only save button above for the
// disk-backed alternative used in dev.
export async function shareCurrent({ getCode, getName, setStatus }) {
  const code = getCode() ?? "";
  if (!code.trim()) {
    setStatus("nothing to share — editor is empty");
    return;
  }
  let encoded;
  try {
    encoded = encodeShareCode(code);
  } catch (err) {
    console.warn("[strasbeat] share encode failed:", err);
    setStatus("share failed — could not encode pattern");
    return;
  }
  if (encoded.length > SHARE_MAX_ENCODED) {
    setStatus(
      `pattern too large to share via URL (${encoded.length} > ${SHARE_MAX_ENCODED} bytes encoded)`,
    );
    return;
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
}
