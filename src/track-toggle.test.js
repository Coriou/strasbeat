// Run with: node --import ./scripts/test-register.mjs --test src/track-toggle.test.js
//
// Mute / solo from the keyboard (Mod-M, Mod-Shift-S) and from the command
// palette. Like the track bar, they always edit the buffer and re-evaluate
// only while the focused tab is the one playing: stopped, that would start
// playback; from another tab, it would replace the pattern that is playing
// — which a bare "the scheduler is running" check let through.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";

import { toggleLabelAtCursor } from "./editor/keymap.js";
import { toggleMute, toggleSolo } from "./editor/track-labels.js";
import { evaluateIfPlaying } from "./editor-setup.js";
import { buildPaletteCommands } from "./command-palette-actions.js";
import { isTabPlaying } from "./tabs.js";

const CODE = 'drums: s("bd sd")\nbass: note("c2")\n';
const MUTED = toggleMute(CODE, "drums");
const SOLOED = toggleSolo(CODE, "drums");

// A CodeMirror view reduced to a real EditorState and a dispatch(); the
// cursor sits on the first line, inside the `drums:` track.
function makeView() {
  const view = {
    state: EditorState.create({ doc: CODE, selection: { anchor: 3 } }),
    dispatch(spec) {
      view.state = view.state.update(spec).state;
    },
    focus() {},
  };
  return view;
}
const text = (view) => view.state.doc.toString();

// The host's predicate, over a scheduler that is running throughout: what
// changes between the cases is only which tab is focused.
const tabsState = (playing, active) => ({ getPlayingItem: () => playing, getActiveItem: () => active });
const predicate = (tabs, started = true) => () => isTabPlaying({ scheduler: { started }, tabs });
const inPlayingTab = predicate(tabsState("a", "a"));
const inOtherTab = predicate(tabsState("a", "b"));
const stopped = predicate(tabsState("a", "a"), false);

describe("mute / solo keys", () => {
  const press = (isPlaying, toggle) => {
    const view = makeView();
    let evaluates = 0;
    const onEvaluate = evaluateIfPlaying(isPlaying, () => evaluates++);
    toggleLabelAtCursor(view, onEvaluate, toggle, "input.track-mute");
    return { code: text(view), evaluates };
  };

  test("in the playing tab the toggle is applied live", () => {
    assert.notEqual(MUTED, CODE);
    assert.deepEqual(press(inPlayingTab, toggleMute), { code: MUTED, evaluates: 1 });
    assert.deepEqual(press(inPlayingTab, toggleSolo), { code: SOLOED, evaluates: 1 });
  });

  test("in a tab that is not playing it only edits the code", () => {
    assert.deepEqual(press(inOtherTab, toggleMute), { code: MUTED, evaluates: 0 });
    assert.deepEqual(press(inOtherTab, toggleSolo), { code: SOLOED, evaluates: 0 });
  });

  test("while stopped it only edits the code", () => {
    assert.deepEqual(press(stopped, toggleMute), { code: MUTED, evaluates: 0 });
  });

  test("the predicate is read at each press, not when the keymap is built", () => {
    let playing = false;
    let evaluates = 0;
    const onEvaluate = evaluateIfPlaying(() => playing, () => evaluates++);
    onEvaluate();
    playing = true;
    onEvaluate();
    assert.equal(evaluates, 1);
  });
});

describe("palette mute / solo commands", () => {
  const run = (isPlaying, id) => {
    const view = makeView();
    let evaluates = 0;
    const commands = buildPaletteCommands({
      // The scheduler runs in every case: the old gate would evaluate each time.
      editor: { editor: view, evaluate: () => evaluates++, repl: { scheduler: { started: true } } },
      isTabPlaying: isPlaying,
    });
    const command = commands.find((c) => c.id === id);
    assert.ok(command, `palette command "${id}" not found`);
    command.run();
    return { code: text(view), evaluates };
  };

  test("in the playing tab the toggle is applied live", () => {
    assert.deepEqual(run(inPlayingTab, "mute"), { code: MUTED, evaluates: 1 });
    assert.deepEqual(run(inPlayingTab, "solo"), { code: SOLOED, evaluates: 1 });
  });

  test("in a tab that is not playing it only edits the code", () => {
    assert.deepEqual(run(inOtherTab, "mute"), { code: MUTED, evaluates: 0 });
    assert.deepEqual(run(inOtherTab, "solo"), { code: SOLOED, evaluates: 0 });
  });
});

// main.js and the keymap extension cannot be driven under node, so the wiring
// is read from source: one predicate, handed to every mute / solo path.
describe("wiring", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const main = read("./main.js");
  const call = (name) => {
    const at = main.indexOf(`${name}(`);
    assert.ok(at >= 0, `${name}() call not found`);
    return main.slice(at, main.indexOf("\n});", at));
  };

  test("main.js gives the keymap and the palette the shared predicate", () => {
    assert.match(call("dispatchEditorExtensions"), /\bisTabPlaying: isActiveTabPlaying,/);
    assert.match(call("buildPaletteCommands"), /\bisTabPlaying: isActiveTabPlaying,/);
  });

  test("no mute / solo path gates on the scheduler alone", () => {
    for (const path of ["./editor-setup.js", "./command-palette-actions.js"]) {
      const src = read(path);
      const gate = src.slice(src.indexOf("evaluateIfPlaying"));
      assert.doesNotMatch(
        gate.slice(0, gate.indexOf("\n}") + 2),
        /scheduler\?\.started/,
        `${path}: evaluateIfPlaying must ask the host's predicate`,
      );
    }
    const setup = read("./editor-setup.js");
    assert.equal(
      setup.match(/onEvaluate: evaluateIfBufferPlaying\(onEvaluate\)/g)?.length,
      2,
      "both places that build the overlay keymap use the gated evaluate",
    );
  });
});
