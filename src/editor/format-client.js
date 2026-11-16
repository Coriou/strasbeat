// Lazy, session-long formatting worker client. Only the latest request may
// return text; infrastructure failures reject all callers and allow a retry.
// There must never be a main-thread formatter fallback.

export class FormatSupersededError extends Error {
  constructor() {
    super("format superseded by a newer request");
    this.name = "FormatSupersededError";
  }
}

export function createFormatClient({ createWorker, timeoutMs = 15_000 }) {
  let worker = null;
  let latestId = 0;
  const pending = new Map();

  function fail(cause) {
    const error = new Error("formatting is unavailable — reload the page", {
      cause,
    });
    console.warn("[strasbeat/format]", error.message, cause);
    worker?.terminate();
    worker = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    return error;
  }

  function startWorker() {
    const current = createWorker();
    worker = current;
    current.addEventListener("message", ({ data }) => {
      if (worker !== current) return;
      const request = pending.get(data?.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(data.id);
      if (data.id !== latestId) {
        // Settle the old promise without returning text or surfacing an old
        // parse error. runFormat treats supersession as a discarded result.
        request.reject(new FormatSupersededError());
      } else if (typeof data.error === "string") {
        request.reject(new Error(data.error));
      } else if (typeof data.formatted === "string") {
        request.resolve(data.formatted);
      } else {
        request.reject(fail(new Error("invalid formatting worker reply")));
      }
    });
    for (const type of ["error", "messageerror"]) {
      current.addEventListener(type, (event) => {
        if (worker === current) fail(event);
      });
    }
    return current;
  }

  return async function formatBuffer(code) {
    const id = ++latestId;
    let current;
    try {
      current = worker ?? startWorker();
    } catch (cause) {
      throw fail(cause);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new Error(`formatting worker timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        current.postMessage({ id, code });
      } catch (cause) {
        fail(cause);
      }
    });
  };
}
