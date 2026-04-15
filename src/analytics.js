// Thin wrapper around Umami's `window.umami.track()` so every call site is
// a one-liner that can never throw, never block, and never surface a
// tracking failure to the user. If the Umami script isn't loaded (env vars
// missing at build time, blocked by an extension, offline, not-yet-loaded
// at the moment of the call), track() silently no-ops.
//
// Set `window.__STRASBEAT_ANALYTICS_DEBUG__ = true` in the devtools console
// to log every track call locally. Nothing is persisted — the flag resets
// on reload.

const DEBUG_FLAG = "__STRASBEAT_ANALYTICS_DEBUG__";

export function track(event, data) {
  try {
    window.umami?.track?.(event, data);
    if (window[DEBUG_FLAG]) {
      console.log("[analytics]", event, data ?? "");
    }
  } catch (err) {
    console.warn("[analytics] track failed:", err);
  }
}
