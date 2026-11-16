import { logger } from "@strudel/core";
import { classifyStrudelLog } from "./eval-state.js";

const IGNORED_STRUDEL_LOG_SUBSTRINGS = [
  "[superdough] Deprecation warning: it seems your code path is setting 'node.onended = callback' instead of using the onceEnded helper",
];

export function shouldIgnoreStrudelLog(msg) {
  const text = typeof msg === "string" ? msg : String(msg ?? "");
  return IGNORED_STRUDEL_LOG_SUBSTRINGS.some((needle) =>
    text.includes(needle),
  );
}

// superdough has its own logger, separate from @strudel/core's. Problems it
// reports (a sample that failed to load, a control that isn't a number, a
// duck target that doesn't exist) are forwarded to core's `logger`, which
// dispatches the `strudel.log` event the in-app console panel listens to —
// otherwise they would only ever show up in devtools. Routine chatter
// (every sample fetch, "AudioWorklets loaded") stays in devtools.
export function installDefaultStrudelLogger(setLogger) {
  setLogger((msg, type) => {
    if (shouldIgnoreStrudelLog(msg)) return;
    const level = classifyStrudelLog(msg, type);
    if (level !== "log" || type === "highlight") logger(msg, type);
    else console.log(msg);
  });
}
