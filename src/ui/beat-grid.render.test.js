// Run with: node --import ./scripts/test-register.mjs --test src/ui/beat-grid.render.test.js
//
// The grid's rendering rules — build nothing while out of sight, touch only
// what changed while in view — and the two input guards (keys aimed at other
// controls, auto-replay from a buffer that is not playing), exercised
// against a minimal stand-in DOM.

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  isCellTarget,
  laneFrameSignature,
  mountBeatGrid,
  shouldAutoReplay,
  stepSignature,
} from "./beat-grid.js";
import { parseDrumLanes } from "../editor/drum-parse.js";

// ─── Stand-in DOM ────────────────────────────────────────────────────────

let created = 0;

class El {
  constructor(tag) {
    created++;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.style = {
      setProperty(key, value) {
        this[key] = value;
      },
    };
    this.listeners = {};
    this.hidden = false;
    this.textContent = "";
    this.scrollTop = 0;
    const classes = new Set();
    this.classes = classes;
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
    };
  }
  set className(value) {
    this.classes.clear();
    for (const n of String(value).split(/\s+/).filter(Boolean)) this.classes.add(n);
  }
  get className() {
    return [...this.classes].join(" ");
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  get tabIndex() {
    return Number(this.attrs.tabindex ?? -1);
  }
  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  replaceChild(next, old) {
    const at = this.children.indexOf(old);
    assert.ok(at >= 0, "replaceChild: not a child");
    next.remove();
    this.children[at] = next;
    next.parentNode = this;
    old.parentNode = null;
    return old;
  }
  removeChild(child) {
    child.remove();
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type, event = {}) {
    const e = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }
  focus() {
    document.activeElement = this;
    this.emit("focus");
  }
  // Class selectors only — all the grid uses.
  querySelectorAll(selector) {
    assert.match(selector, /^\.[\w-]+$/);
    const name = selector.slice(1);
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.classes.has(name)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function installDom() {
  const observers = [];
  globalThis.document = {
    activeElement: null,
    body: new El("body"),
    createElement: (tag) => new El(tag),
    createTextNode: (text) => {
      const node = new El("#text");
      node.textContent = text;
      return node;
    },
    addEventListener() {},
  };
  globalThis.HTMLInputElement = class {};
  globalThis.HTMLTextAreaElement = class {};
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.targets = new Set();
      observers.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  return observers;
}

// A CodeMirror view reduced to what the grid touches: the text, and
// dispatch() applying `{ from, to, insert }` changes and notifying.
function makeView(initial) {
  let text = initial;
  const subscribers = [];
  const view = {
    dispatches: 0,
    state: { doc: { toString: () => text } },
    dispatch({ changes }) {
      view.dispatches++;
      const list = (Array.isArray(changes) ? changes : [changes])
        .slice()
        .sort((a, b) => b.from - a.from);
      for (const c of list) {
        text = text.slice(0, c.from) + (c.insert ?? "") + text.slice(c.to ?? c.from);
      }
      for (const fn of subscribers) fn({ immediate: false });
    },
    setText(next) {
      text = next;
      for (const fn of subscribers) fn({ immediate: false });
    },
    focus() {},
  };
  const docSync = { subscribe: (fn) => subscribers.push(fn) };
  return { view, docSync };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const CODE = `setcpm(30)
$: s("bd ~ sd ~")
$: s("hh hh hh hh")
`;

describe("signatures", () => {
  const lanes = parseDrumLanes(CODE);

  test("an edit above a lane leaves its signatures alone", () => {
    const shifted = "// a comment\n" + CODE;
    const after = parseDrumLanes(shifted);
    assert.notEqual(after[0].stepStart, lanes[0].stepStart);
    assert.equal(
      laneFrameSignature(after[0], 0, shifted),
      laneFrameSignature(lanes[0], 0, CODE),
    );
    assert.deepEqual(after[0].steps.map(stepSignature), lanes[0].steps.map(stepSignature));
  });

  test("a flipped step changes that step's signature only", () => {
    const flipped = parseDrumLanes(CODE.replace("bd ~ sd ~", "bd bd sd ~"));
    const before = lanes[0].steps.map(stepSignature);
    const after = flipped[0].steps.map(stepSignature);
    assert.notEqual(after[1], before[1]);
    assert.deepEqual([after[0], after[2], after[3]], [before[0], before[2], before[3]]);
  });

  test("mute, position and a read-only lane's source text are part of the frame", () => {
    const base = laneFrameSignature(lanes[0], 0, CODE);
    assert.notEqual(laneFrameSignature(lanes[0], 1, CODE), base);
    assert.notEqual(laneFrameSignature({ ...lanes[0], muted: true }, 0, CODE), base);
    const ro = 'x\n$: s("hh*8")\n';
    const roLane = parseDrumLanes(ro)[0];
    assert.equal(roLane.editable, false);
    assert.notEqual(
      laneFrameSignature(roLane, 0, ro),
      laneFrameSignature(parseDrumLanes('x\n$: s("hh*4")\n')[0], 0, 'x\n$: s("hh*4")\n'),
    );
  });
});

describe("isCellTarget()", () => {
  test("only step cells qualify", () => {
    const cell = new El("button");
    cell.className = "beat-grid__cell beat-grid__cell--on";
    const mute = new El("button");
    mute.className = "beat-grid__state beat-grid__state--button";
    assert.equal(isCellTarget(cell), true);
    assert.equal(isCellTarget(mute), false);
    assert.equal(isCellTarget(null), false);
  });
});

describe("shouldAutoReplay()", () => {
  test("defers to the host's predicate when there is one", () => {
    const scheduler = { started: true };
    assert.equal(shouldAutoReplay({ isPlaying: () => false, scheduler }), false);
    assert.equal(shouldAutoReplay({ isPlaying: () => true, scheduler: null }), true);
  });
  test("otherwise follows the scheduler", () => {
    assert.equal(shouldAutoReplay({ isPlaying: null, scheduler: { started: true } }), true);
    assert.equal(shouldAutoReplay({ isPlaying: null, scheduler: { started: false } }), false);
    assert.equal(shouldAutoReplay({ isPlaying: null, scheduler: null }), false);
  });
});

describe("mountBeatGrid()", () => {
  let container, view, docSync, grid, root, laneCounts, evaluates, playing;

  const rows = () => root.querySelectorAll(".beat-grid__lane");
  const cells = (lane = 0) => rows()[lane].querySelectorAll(".beat-grid__cell");

  beforeEach(() => {
    installDom();
    container = new El("div");
    ({ view, docSync } = makeView(CODE));
    laneCounts = [];
    evaluates = 0;
    playing = true;
    grid = mountBeatGrid({
      container,
      view,
      docSync,
      onLanesChange: (n) => laneCounts.push(n),
      onEvaluate: () => {
        evaluates++;
      },
      isPlaying: () => playing,
    });
    root = container.children[0];
  });

  test("builds nothing while hidden, yet reports that lanes exist", () => {
    assert.equal(rows().length, 0);
    assert.deepEqual(laneCounts, [2]);
  });

  test("edits made while hidden cost no DOM and show up on show()", async () => {
    const before = created;
    view.setText(CODE.replace("bd ~ sd ~", "bd bd sd ~"));
    view.setText(CODE.replace("bd ~ sd ~", "bd bd sd sd"));
    await settle();
    assert.equal(created, before, "no element was created while hidden");
    grid.show();
    assert.equal(rows().length, 2);
    assert.deepEqual(
      cells(0).map((c) => c.attrs["aria-pressed"]),
      ["true", "true", "true", "true"],
    );
  });

  test("losing the last lane while hidden withdraws the view", async () => {
    view.setText("setcpm(30)\n");
    await settle();
    assert.deepEqual(laneCounts, [2, 0]);
  });

  test("renders a valid grid: rows of a row header and cells, one Tab stop", () => {
    grid.show();
    const lanesEl = root.querySelector(".beat-grid__lanes");
    assert.equal(lanesEl.attrs.role, "grid");
    assert.equal(root.attrs.role, undefined);
    for (const child of lanesEl.children) assert.equal(child.attrs.role, "row");
    for (const row of rows()) {
      assert.deepEqual(
        row.children.map((c) => c.attrs.role),
        ["rowheader", "gridcell", "gridcell"],
      );
    }
    const all = root.querySelectorAll(".beat-grid__cell");
    assert.equal(all.length, 8);
    for (const cell of all) assert.equal(cell.attrs.role, undefined, "cells stay plain buttons");
    assert.deepEqual(
      all.map((c) => c.attrs.tabindex),
      ["0", "-1", "-1", "-1", "-1", "-1", "-1", "-1"],
    );
    assert.deepEqual(
      cells(0).map((c) => c.attrs["aria-pressed"]),
      ["true", "false", "true", "false"],
    );
  });

  test("a read-only lane's stripe sits in a grid cell of its own", () => {
    view.setText('$: s("hh*8")\n');
    grid.show();
    const [row] = rows();
    assert.deepEqual(
      row.children.map((c) => c.attrs.role),
      ["rowheader", "gridcell", "gridcell"],
    );
    assert.ok(row.children[1].children[0].classes.has("beat-grid__stripe"));
  });

  test("typing elsewhere in the buffer keeps every row and cell", async () => {
    grid.show();
    const rowsBefore = rows();
    const cellsBefore = root.querySelectorAll(".beat-grid__cell");
    const before = created;
    view.setText("// a comment\n" + CODE);
    await settle();
    assert.equal(created, before, "nothing was built");
    assert.deepEqual(rows(), rowsBefore);
    assert.deepEqual(root.querySelectorAll(".beat-grid__cell"), cellsBefore);
  });

  test("flipping a step swaps that one cell", async () => {
    grid.show();
    const rowsBefore = rows();
    const before = cells(0);
    before[1].emit("click", { button: 0 });
    await settle();
    assert.equal(view.dispatches, 1);
    assert.deepEqual(rows(), rowsBefore, "rows are kept");
    const after = cells(0);
    assert.notEqual(after[1], before[1]);
    assert.equal(after[1].attrs["aria-pressed"], "true");
    assert.deepEqual([after[0], after[2], after[3]], [before[0], before[2], before[3]]);
    assert.deepEqual(cells(1), rowsBefore[1].querySelectorAll(".beat-grid__cell"));
  });

  test("a removed lane drops its row; the rest stay", async () => {
    grid.show();
    const [first] = rows();
    view.setText('setcpm(30)\n$: s("bd ~ sd ~")\n');
    await settle();
    assert.deepEqual(rows(), [first]);
  });

  test("focus follows a replaced cell and the Tab stop moves with it", async () => {
    grid.show();
    const target = cells(1)[2];
    target.focus();
    assert.equal(target.attrs.tabindex, "0");
    assert.equal(cells(0)[0].attrs.tabindex, "-1");
    target.emit("click", { button: 0 });
    await settle();
    const replaced = cells(1)[2];
    assert.notEqual(replaced, target);
    assert.equal(document.activeElement, replaced);
    assert.equal(replaced.attrs.tabindex, "0");
  });

  test("Enter on a cell toggles it; Enter on another control is left alone", async () => {
    grid.show();
    cells(0)[1].focus();
    const mute = rows()[1].querySelector(".beat-grid__state");
    assert.ok(mute);
    let prevented = false;
    root.emit("keydown", { key: "Enter", target: mute, preventDefault: () => (prevented = true) });
    root.emit("keydown", { key: " ", target: mute, preventDefault: () => (prevented = true) });
    root.emit("keydown", { key: "v", target: mute, preventDefault: () => (prevented = true) });
    assert.equal(view.dispatches, 0, "no cell was toggled");
    assert.equal(prevented, false, "the control keeps its own key handling");

    root.emit("keydown", { key: "Enter", target: cells(0)[1] });
    assert.equal(view.dispatches, 1);
  });

  test("an edit replays only while this buffer is the one playing", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    grid.show();
    grid.setPlaybackState("playing");

    cells(0)[1].emit("click", { button: 0 });
    t.mock.timers.tick(200);
    assert.equal(evaluates, 1);

    playing = false; // another tab owns playback, or nothing plays
    cells(0)[3].emit("click", { button: 0 });
    t.mock.timers.tick(200);
    assert.equal(evaluates, 1);
  });

  test("Stop inside the replay debounce cancels the replay", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    grid.show();
    grid.setPlaybackState("playing");
    cells(0)[1].emit("click", { button: 0 });
    grid.setPlaybackState("idle");
    t.mock.timers.tick(200);
    assert.equal(evaluates, 0);
  });

  test("a tab switch inside the replay debounce cancels it too", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    grid.show();
    grid.setPlaybackState("playing");
    cells(0)[1].emit("click", { button: 0 });
    playing = false;
    t.mock.timers.tick(200);
    assert.equal(evaluates, 0);
  });
});
