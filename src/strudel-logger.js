const IGNORED_STRUDEL_LOG_SUBSTRINGS = [
  "[superdough] Deprecation warning: it seems your code path is setting 'node.onended = callback' instead of using the onceEnded helper",
];

export function shouldIgnoreStrudelLog(msg) {
  const text = typeof msg === "string" ? msg : String(msg ?? "");
  return IGNORED_STRUDEL_LOG_SUBSTRINGS.some((needle) =>
    text.includes(needle),
  );
}

export function installDefaultStrudelLogger(setLogger) {
  setLogger((msg, type) => {
    if (shouldIgnoreStrudelLog(msg)) return;
    if (type === "error" || type === "warning") console.warn(msg);
    else console.log(msg);
  });
}
