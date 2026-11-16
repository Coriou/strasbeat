// Formatting must preserve Strudel quotes and never overwrite a changed document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";

import { formatStatus, runFormat } from "./format.js";
import { formatBuffer } from "./format-core.js";

// runFormat only needs `state` and `dispatch` from the view.
function fakeView(doc, { selection } = {}) {
  const statuses = [];
  const view = {
    statuses,
    dispatched: 0,
    state: EditorState.create({
      doc,
      selection,
      extensions: [formatStatus.of((msg) => statuses.push(msg))],
    }),
    dispatch(spec) {
      this.dispatched++;
      this.state = this.state.update(spec).state;
    },
  };
  return view;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("applies the formatted text when the buffer is unchanged", async () => {
  const view = fakeView('s( "bd" )');
  assert.equal(await runFormat(view, async () => 's("bd")'), true);
  assert.equal(view.state.doc.toString(), 's("bd")');
  assert.deepEqual(view.statuses, []);
});

test("drops the result when the user typed while formatting", async () => {
  const view = fakeView('s( "bd" )');
  const d = deferred();
  const pending = runFormat(view, () => d.promise);
  view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
  const dispatchedBefore = view.dispatched;
  d.resolve('s("bd")');
  assert.equal(await pending, false);
  assert.equal(view.dispatched, dispatchedBefore, "no format dispatch");
  assert.equal(view.state.doc.toString(), 's( "bd" )x');
  assert.equal(view.statuses.length, 1);
  assert.match(view.statuses[0], /skipped/);
});

test("drops the result when another tab's state was swapped in", async () => {
  const view = fakeView('s( "bd" )');
  const d = deferred();
  const pending = runFormat(view, () => d.promise);
  // A tab switch replaces the whole state; the other buffer is longer than
  // the one being formatted, which is the case that used to splice the two.
  const other = 'note("c e g").s("sawtooth").lpf(800)';
  view.state = EditorState.create({ doc: other });
  d.resolve('s("bd")');
  assert.equal(await pending, false);
  assert.equal(view.dispatched, 0);
  assert.equal(view.state.doc.toString(), other);
});

test("still applies after switching away and back to the same state", async () => {
  const view = fakeView('s( "bd" )');
  const home = view.state;
  const d = deferred();
  const pending = runFormat(view, () => d.promise);
  view.state = EditorState.create({ doc: "other" });
  view.state = home;
  d.resolve('s("bd")');
  assert.equal(await pending, true);
  assert.equal(view.state.doc.toString(), 's("bd")');
});

test("keeps the cursor on the token it was in", async () => {
  const doc = 'note(   "c e g"   ).fast( 2 )';
  const view = fakeView(doc, {
    selection: EditorSelection.cursor(doc.indexOf("fast") + 2),
  });
  await runFormat(view, async () => 'note("c e g").fast(2)');
  const after = view.state.doc.toString();
  assert.equal(view.state.selection.main.head, after.indexOf("fast") + 2);
});

test("reports a formatter failure through the status sink", async () => {
  const view = fakeView("stack(");
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await runFormat(view, formatBuffer), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(view.dispatched, 0);
  assert.equal(view.statuses.length, 1);
  assert.match(view.statuses[0], /^format failed: /);
  assert.ok(!view.statuses[0].includes("\n"));
});

test("formats object literals with quoted keys, preserving both quote styles", async () => {
  const out = await formatBuffer(
    `note("c").set({ 'gain': 0.5 })\nconst x = { "s": "bd",   n: 1 }\n`,
  );
  assert.equal(
    out,
    `note("c").set({ 'gain': 0.5 })\nconst x = { "s": "bd", n: 1 }\n`,
  );
});

test("formats template literals with interpolation", async () => {
  const out = await formatBuffer(
    "const k = 'bd'\ns(`${k}*4 ${pick( 'sd' , \"cp\" )}`).gain( 0.8 )\n",
  );
  assert.equal(
    out,
    "const k = 'bd'\ns(`${k}*4 ${pick('sd', \"cp\")}`).gain(0.8)\n",
  );
});
