// What the rig runs inside the page, before any application code: frame
// timing, counters, launch milestones and the eval stopwatch, all hung on
// `window.__perf`. `install` is serialised into an init script, so it must
// be self-contained (no imports, no closure over this module).
export function install({ counting }) {
  // A context-level init script also runs in a new page's initial
  // about:blank, where touching localStorage throws.
  if (!/^https?:$/.test(location.protocol)) return;
  localStorage.setItem("strasbeat:drum-kit-nudge", "seen");
  const p = (window.__perf = {
    active: false,
    frames: [],
    raf: 0,
    mutations: 0,
    transactions: 0,
    canvas: 0,
    timers: 0,
    longTasks: [],
    loaf: [],
    milestones: {},
    eval: null,
    clock: false,
  });
  const nativeRAF = window.requestAnimationFrame.bind(window);
  // Main-thread time of a frame: from its first rAF callback to the first
  // task after its rendering update. The message is posted from inside the
  // frame, so its task cannot run before style, layout and paint are done.
  // Records wait in a queue: each message closes the oldest open frame, so
  // a late message can never be credited to the frame that followed.
  let frameTimestamp = -1,
    current;
  const open = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const done = open.shift();
    if (done) done.ms = performance.now() - done.start;
  };
  function frame(timestamp, callback) {
    if (!p.active) return;
    if (timestamp !== frameTimestamp) {
      frameTimestamp = timestamp;
      current = { start: performance.now(), ms: 0, callbacks: 0 };
      p.frames.push(current);
      open.push(current);
      channel.port2.postMessage(0);
    }
    if (callback) {
      if (current) current.callbacks++;
      p.raf++;
    }
  }
  window.requestAnimationFrame = (fn) =>
    nativeRAF((timestamp) => {
      frame(timestamp, true);
      fn(timestamp);
    });
  let clockId;
  p.startClock = () => {
    if (p.clock) return;
    p.clock = true;
    clockId = nativeRAF(function tickTimed(t) {
      if (p.clock) {
        frame(t, false);
        clockId = nativeRAF(tickTimed);
      }
    });
  };
  p.stopClock = () => {
    p.clock = false;
    cancelAnimationFrame(clockId);
  };
  const mo = new MutationObserver((records) => {
    if (p.active) p.mutations += records.length;
    if (!p.milestones.editor && document.querySelector(".cm-content")) {
      p.milestones.editor = performance.now();
      const c = new MessageChannel();
      c.port1.onmessage = () => {
        p.milestones.interactive = performance.now();
        window.__perfMilestone?.("interactive");
        c.port1.close();
        c.port2.close();
      };
      c.port2.postMessage(0);
    }
    if (!p.milestones.ready && document.querySelector(".shell.is-ready")) {
      p.milestones.ready = performance.now();
      window.__perfMilestone?.("ready");
    }
  });
  mo.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  for (const [type, key] of [
    ["longtask", "longTasks"],
    ["long-animation-frame", "loaf"],
  ]) {
    if (PerformanceObserver.supportedEntryTypes.includes(type))
      new PerformanceObserver((l) => {
        if (p.active)
          p[key].push(
            ...l
              .getEntries()
              .map((e) => ({ start: e.startTime, duration: e.duration })),
          );
      }).observe({ type, buffered: true });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey && e.key === "Enter") p.eval = { start: performance.now() };
    },
    true,
  );
  // Some engines expose start on the concrete node as well as the base prototype.
  for (const proto of [
    AudioScheduledSourceNode.prototype,
    AudioBufferSourceNode.prototype,
    OscillatorNode.prototype,
  ]) {
    if (!Object.hasOwn(proto, "start")) continue;
    const original = proto.start;
    proto.start = function (when = 0, ...rest) {
      if (p.eval && p.eval.end == null) {
        p.eval.end = performance.now();
        p.eval.ahead = when - this.context.currentTime;
      }
      return original.call(this, when, ...rest);
    };
  }
  if (counting) {
    for (const name of ["setTimeout", "setInterval"]) {
      const original = window[name];
      window[name] = (fn, delay, ...args) =>
        original(
          typeof fn === "function"
            ? (...a) => {
                if (p.active) p.timers++;
                return fn(...a);
              }
            : fn,
          delay,
          ...args,
        );
    }
    for (const name of [
      "clearRect",
      "fillRect",
      "strokeRect",
      "fill",
      "stroke",
      "drawImage",
      "fillText",
      "strokeText",
      "putImageData",
      "beginPath",
      "closePath",
      "moveTo",
      "lineTo",
      "arc",
      "arcTo",
      "roundRect",
      "ellipse",
      "bezierCurveTo",
      "quadraticCurveTo",
      "rect",
      "save",
      "restore",
      "translate",
      "rotate",
      "scale",
      "setTransform",
      "resetTransform",
      "transform",
      "clip",
    ]) {
      const proto = CanvasRenderingContext2D.prototype,
        original = proto[name];
      if (original)
        proto[name] = function (...args) {
          if (p.active) p.canvas++;
          return original.apply(this, args);
        };
    }
  }
  p.reset = () => {
    mo.takeRecords();
    for (const k of ["raf", "mutations", "transactions", "canvas", "timers"])
      p[k] = 0;
    p.frames = [];
    p.longTasks = [];
    p.loaf = [];
    p.active = true;
  };
  p.snapshot = () => {
    if (p.active) p.mutations += mo.takeRecords().length;
    return {
      frames: p.frames,
      raf: p.raf,
      mutations: p.mutations,
      transactions: p.transactions,
      canvas: p.canvas,
      timers: p.timers,
      longTasks: p.longTasks,
      loaf: p.loaf,
    };
  };
  p.wrapEditor = () => {
    const view = window.editor?.editor;
    if (!view?.dispatch) return false;
    if (counting) {
      const dispatch = view.dispatch;
      view.dispatch = function (...args) {
        if (p.active) p.transactions += args.length;
        return dispatch.apply(this, args);
      };
    }
    return true;
  };
  p.reset();
}
