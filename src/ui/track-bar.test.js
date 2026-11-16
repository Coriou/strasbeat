// Run with: node --import ./scripts/test-register.mjs --test src/ui/track-bar.test.js
//
// A mute or solo click always edits the buffer. It re-evaluates only when the
// host says the focused tab is the one playing — otherwise the click would
// start playback, or replace the pattern another tab is playing.

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mountTrackBar } from "./track-bar.js";
import { isTabPlaying } from "../tabs.js";
import { toggleMute, toggleSolo } from "../editor/track-labels.js";

// ─── Stand-in DOM: what the track bar touches, nothing more ──────────────

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.textContent = "";
    const classes = new Set();
    this.classes = classes;
    this.classList = { add: (...names) => names.forEach((n) => classes.add(n)) };
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  get childElementCount() {
    return this.children.length;
  }
  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  replaceChild(next, old) {
    this.children[this.children.indexOf(old)] = next;
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
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  click(event = {}) {
    for (const fn of this.listeners.click ?? []) fn({ shiftKey: false, ...event });
  }
}

// A CodeMirror view reduced to the text and a dispatch() that applies
// `{ from, to, insert }` changes and notifies docSync, as a tab's view does.
function makeView(initial) {
  let text = initial;
  const subscribers = [];
  const view = {
    state: { doc: { toString: () => text } },
    dispatch({ changes }) {
      const list = (Array.isArray(changes) ? changes : [changes])
        .slice()
        .sort((a, b) => b.from - a.from);
      for (const c of list) {
        text = text.slice(0, c.from) + (c.insert ?? "") + text.slice(c.to ?? c.from);
      }
      for (const fn of subscribers) fn({ immediate: true });
    },
    focus() {},
  };
  return { view, docSync: { subscribe: (fn) => subscribers.push(fn) } };
}

const CODE = 'drums: s("bd sd")\nbass: note("c2")\n';
const MUTED = toggleMute(CODE, "drums");
const MUTED_AND_SOLOED = toggleSolo(MUTED, "bass");

describe("track bar mute / solo click", () => {
  let container, view, docSync, evaluates, playing;
  const entry = (i) => container.children[1].children[i];

  beforeEach(() => {
    globalThis.document = { createElement: (tag) => new El(tag) };
    globalThis.requestAnimationFrame = (fn) => fn();
    container = new El("div");
    ({ view, docSync } = makeView(CODE));
    evaluates = 0;
    playing = true;
    mountTrackBar({
      container,
      view,
      docSync,
      onEvaluate: () => evaluates++,
      isPlaying: () => playing,
    });
  });

  test("in the playing tab the edit is applied live", () => {
    entry(0).click();
    assert.notEqual(MUTED, CODE);
    assert.equal(view.state.doc.toString(), MUTED);
    assert.equal(evaluates, 1);
    entry(1).click({ shiftKey: true });
    assert.equal(view.state.doc.toString(), MUTED_AND_SOLOED);
    assert.equal(evaluates, 2);
  });

  test("in any other tab it only edits the code", () => {
    playing = false;
    entry(0).click();
    entry(1).click({ shiftKey: true });
    assert.equal(view.state.doc.toString(), MUTED_AND_SOLOED);
    assert.equal(evaluates, 0);
    assert.ok(entry(0).classes.has("track-bar__entry--muted"), "the bar still shows the new state");
  });
});

describe("isTabPlaying()", () => {
  const tabs = (playing, active) => ({ getPlayingItem: () => playing, getActiveItem: () => active });
  const started = { started: true };

  test("true only while the focused tab is the one playing", () => {
    assert.equal(isTabPlaying({ scheduler: started, tabs: tabs("a", "a") }), true);
    assert.equal(isTabPlaying({ scheduler: started, tabs: tabs("a", "b") }), false);
  });
  test("false while stopped, whichever tab is focused", () => {
    assert.equal(isTabPlaying({ scheduler: { started: false }, tabs: tabs("a", "a") }), false);
    assert.equal(isTabPlaying({ scheduler: null, tabs: tabs("a", "a") }), false);
  });
  test("a playing pattern whose tab was closed belongs to no open tab", () => {
    assert.equal(isTabPlaying({ scheduler: started, tabs: tabs(null, "b") }), false);
  });
  test("follows the scheduler alone before the tab controller exists", () => {
    assert.equal(isTabPlaying({ scheduler: started, tabs: null }), true);
  });
});

// main.js cannot be imported under node (it boots the app), so the wiring is
// read from its source: the track bar and the beat grid are handed the same
// tab-aware predicate, not the bare "scheduler is running".
describe("main.js wiring", () => {
  const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
  const call = (name) => {
    const at = main.indexOf(`${name}({`);
    assert.ok(at >= 0, `${name}() call not found`);
    return main.slice(at, main.indexOf("\n});", at));
  };

  test("both bars use isActiveTabPlaying, which is isTabPlaying", () => {
    assert.match(main, /const isActiveTabPlaying = \(\) =>\s+isTabPlaying\(\{ scheduler: editor\.repl\?\.scheduler, tabs \}\);/);
    assert.match(call("mountTrackBar"), /\bisPlaying: isActiveTabPlaying,/);
    assert.match(call("mountBeatGrid"), /\bisPlaying: isActiveTabPlaying,/);
  });
});
