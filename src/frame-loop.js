// StrudelMirror's Drawer surface, backed by our numeric hap window. Only a
// running scheduler owns an animation callback. Highlight transactions follow
// decoration changes, with a 250 ms refresh for editor states replaced elsewhere.
import { HapWindow } from "./hap-window.js";

export function highlightSignature(records) {
  const winners = new Map();
  for (const record of records) {
    for (const { start, end } of record.hap.context?.locations ?? []) {
      const id = `${start}:${end}`;
      if (!winners.has(id) || winners.get(id).begin < record.begin) {
        winners.set(id, record);
      }
    }
  }
  const entries = [];
  for (const [id, { hap }] of winners) {
    const color = hap.value?.color ?? "var(--foreground)";
    entries.push([id, hap.value?.markcss || `outline: solid 2px ${color}`]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}

export class FrameLoop {
  constructor({
    editor,
    drawTime,
    afterInvalidate = () => {},
    onError,
    requestFrame = (fn) => requestAnimationFrame(fn),
    cancelFrame = (id) => cancelAnimationFrame(id),
  }) {
    this.editor = editor;
    this.window = new HapWindow(drawTime);
    this.afterInvalidate = afterInvalidate;
    this.onError = onError;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.frameId = null;
    this.running = false;
    this.reportedError = false;
    this.resetHighlight();
    this.tick = (timestamp) => {
      this.frameId = null;
      if (!this.running) return;
      if (!this.scheduler.started) {
        this.stop();
        return;
      }
      try {
        const time = this.scheduler.now();
        this.window.advance(this.scheduler.pattern, time, this.scheduler.cps);
        if (this.activeSnapshot !== this.window.activeHaps) {
          this.activeSnapshot = this.window.activeHaps;
          this.signature = highlightSignature(this.window.activeRecords);
        }
        if (
          this.signature !== this.dispatchedSignature ||
          timestamp - this.lastHighlight >= 250
        ) {
          this.editor.highlight(this.window.activeHaps, time);
          this.dispatchedSignature = this.signature;
          this.lastHighlight = timestamp;
        }
        this.editor.onDraw(this.visibleHaps, time, this.painters);
      } catch (error) {
        this.reportError(error);
      } finally {
        if (this.running) this.frameId = this.requestFrame(this.tick);
      }
    };
  }

  get visibleHaps() {
    return this.window.visibleHaps;
  }
  get painters() {
    return this.window.painters;
  }
  get drawTime() {
    return this.window.drawTime;
  }

  reportError(error) {
    if (this.reportedError) return;
    this.reportedError = true;
    console.warn("[strasbeat] playback frame failed:", error);
    this.onError?.(error);
  }

  resetHighlight() {
    this.activeSnapshot = null;
    this.signature = null;
    this.dispatchedSignature = null;
    this.lastHighlight = -Infinity;
  }

  setDrawTime(dt) {
    this.window.setDrawTime(dt);
  }

  invalidate(scheduler = this.scheduler, time) {
    if (!scheduler) return;
    this.scheduler = scheduler;
    time ??= scheduler.now();
    this.resetHighlight();
    this.reportedError = false;
    this.window.invalidate(scheduler.pattern, time, scheduler.cps);
    this.afterInvalidate(time, false);
  }

  setHapDemand(wide, { hasFrame, time }) {
    const scheduler = this.scheduler;
    try {
      if (
        !this.window.setRollDemand(
          wide,
          scheduler?.pattern,
          scheduler?.started ? scheduler.now() : time,
          scheduler?.cps,
          { playing: !!scheduler?.started, hasFrame },
        )
      )
        return;
      this.resetHighlight();
      this.afterInvalidate(this.window.time, true);
      this.editor.onDraw(this.visibleHaps, this.window.time, this.painters);
    } catch (error) {
      this.reportError(error);
    }
  }

  start(scheduler) {
    if (this.running) return;
    this.invalidate(scheduler);
    this.running = true;
    this.frameId = this.requestFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
    this.resetHighlight();
    this.editor.highlight([], this.window.time ?? 0);
  }
}

// Reading the flag belongs at startup. Keeping this seam explicit also lets
// tests verify that the escape hatch leaves the upstream instance untouched.
export function installFrameLoop(editor, { enabled, ...options }) {
  if (enabled) editor.drawer = new FrameLoop({ editor, ...options });
  return editor.drawer;
}
