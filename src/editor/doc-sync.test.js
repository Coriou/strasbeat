import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";

import { createDocSync } from "./doc-sync.js";
import { freshTabState } from "./build-editor-state.js";

// These tests exist because of design/work/27 BUG-2: three bottom-bar mounts
// installed their own updateListener via StateEffect.appendConfig *after*
// main.js had already captured the clean base EditorState that every fresh tab
// is derived from. Those listeners existed in exactly one tab's config and were
// silently dead in every other tab (measured: 8 listeners vs 5).

describe("createDocSync() — subscriber fan-out", () => {
  test("notifies a subscriber that registered after an earlier notify", () => {
    // The break this catches: a docSync that snapshots its subscribers (or is
    // otherwise registration-order sensitive) reproduces BUG-2 exactly —
    // mounts that come up late never hear about doc changes.
    const sync = createDocSync();
    sync.notify();

    let calls = 0;
    sync.subscribe(() => calls++);
    sync.notify();

    assert.equal(calls, 1);
  });

  test("notifies every subscriber, not just the first", () => {
    const sync = createDocSync();
    const seen = [];
    sync.subscribe(() => seen.push("track-bar"));
    sync.subscribe(() => seen.push("arrange-bar"));
    sync.subscribe(() => seen.push("beat-grid"));

    sync.notify();

    assert.deepEqual(seen, ["track-bar", "arrange-bar", "beat-grid"]);
  });

  test("a subscriber that throws does not stop the ones after it", () => {
    // One bar throwing on a malformed buffer must not take the other two
    // offline for the rest of the session.
    const sync = createDocSync();
    const seen = [];
    sync.subscribe(() => {
      throw new Error("track-bar blew up");
    });
    sync.subscribe(() => seen.push("beat-grid"));

    sync.notify();

    assert.deepEqual(seen, ["beat-grid"]);
  });
});

describe("createDocSync() — immediate vs coalesced", () => {
  test("a plain notify() asks subscribers to coalesce", () => {
    // Ordinary doc changes (keystrokes) should batch; a synchronous rebuild per
    // keystroke would be a regression against today's rAF debounce.
    const sync = createDocSync();
    let immediate = null;
    sync.subscribe((opts) => {
      immediate = opts.immediate;
    });

    sync.notify();

    assert.equal(immediate, false);
  });

  test("notify({ immediate: true }) tells subscribers to rebuild now", () => {
    // The tab swap path: setState() does not fire updateListeners at all, and
    // the new document must be on screen before the next user gesture — waiting
    // for a frame means the first click after a swap can hit the old tracks.
    const sync = createDocSync();
    let immediate = null;
    sync.subscribe((opts) => {
      immediate = opts.immediate;
    });

    sync.notify({ immediate: true });

    assert.equal(immediate, true);
  });
});

describe("createDocSync() — CodeMirror wiring", () => {
  test("the extension notifies subscribers only on doc changes", () => {
    const sync = createDocSync();
    let calls = 0;
    sync.subscribe(() => calls++);

    const listener = EditorState.create({ extensions: [sync.extension] }).facet(
      EditorView.updateListener,
    )[0];

    listener({ docChanged: false });
    assert.equal(calls, 0, "selection-only updates must not rebuild the bars");

    listener({ docChanged: true });
    assert.equal(calls, 1);
  });

  test("a subscriber registered after the clean base is captured still fires for a fresh tab (BUG-2)", () => {
    // This is the regression. main.js installs sync.extension into the editor's
    // base config, then captures that state as the clean base; the bottom bars
    // subscribe minutes later, from their mount calls. Every fresh tab derives
    // from the clean base, so the listener must both survive into the fresh
    // state AND reach subscribers that did not exist when the base was taken.
    const sync = createDocSync();
    const base = EditorState.create({
      doc: "boot",
      extensions: [history(), sync.extension],
    });

    let rebuilds = 0;
    sync.subscribe(() => rebuilds++);

    const fresh = freshTabState(base, 'alpha: s("bd")');

    const listeners = fresh.facet(EditorView.updateListener);
    assert.equal(listeners.length, 1, "the doc-sync listener travelled into the fresh tab state");

    // Fire it the way CodeMirror would. `docChanged` is the only field the
    // listener reads, so a minimal stand-in exercises the real code path.
    listeners[0]({ docChanged: true });
    assert.equal(rebuilds, 1, "the late subscriber heard the fresh tab's doc change");
  });

  test("StateEffect.appendConfig after the base capture does NOT reach a fresh tab", () => {
    // Characterization of the upstream behaviour that caused BUG-2, pinned here
    // so the reason doc-sync exists cannot quietly stop being true. A config
    // appended to the live state is absent from any state derived from the
    // earlier clean base.
    const base = EditorState.create({ doc: "boot", extensions: [history()] });
    const live = base.update({
      effects: StateEffect.appendConfig.of(EditorView.updateListener.of(() => {})),
    }).state;

    assert.equal(live.facet(EditorView.updateListener).length, 1);
    assert.equal(
      freshTabState(base, "x").facet(EditorView.updateListener).length,
      0,
      "appendConfig is why per-mount listeners were dead in every tab but one",
    );
  });
});
