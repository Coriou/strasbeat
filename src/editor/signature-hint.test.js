import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { ensureSyntaxTree } from "@codemirror/language";

import { readFileSync } from "node:fs";

import { findCallContext } from "./signature-hint.js";
import { setDocs } from "./docs-store.js";

// The app fetches the docs index after the editor mounts; here it is read
// straight from disk.
const docs = JSON.parse(
  readFileSync(new URL("./strudel-docs.json", import.meta.url), "utf8"),
);
setDocs(docs);

// `|` marks the cursor.
function at(marked) {
  const pos = marked.indexOf("|");
  const doc = marked.slice(0, pos) + marked.slice(pos + 1);
  const created = EditorState.create({ doc, extensions: [javascriptLanguage] });
  // A fresh state parses on a ~20 ms budget and keeps whatever tree it got,
  // which on a loaded machine is a truncated one. Finish the parse, then
  // take an empty transaction so the state adopts the complete tree.
  ensureSyntaxTree(created, doc.length, 10_000);
  const state = created.update({}).state;
  return findCallContext(state, pos);
}

test("finds the call the cursor is inside, anchored at its paren", () => {
  const ctx = at('note("c e").fast(|2)');
  assert.equal(ctx.name, "fast");
  assert.equal(ctx.argIndex, 0);
  assert.equal(ctx.from, 'note("c e").fast'.length);
});

test("tracks the active argument", () => {
  assert.equal(at("x.euclid(3, |8)").argIndex, 1);
});

test("nothing once the cursor is past the closing paren", () => {
  assert.equal(at('note("c e").fast(2)|'), null);
});

test("past an inner call's paren, the enclosing call applies", () => {
  const ctx = at("x.euclid(saw.fast(2)|, 8)");
  assert.equal(ctx.name, "euclid");
  assert.equal(ctx.argIndex, 0);
});

test("an unclosed call still counts as inside", () => {
  assert.equal(at("x.fast(|").name, "fast");
  assert.equal(at("x.fast(2|").name, "fast");
});

test("Object.prototype names are not documented functions", () => {
  assert.equal(at("x.toString(|)"), null);
  assert.equal(at("x.constructor(|)"), null);
  assert.equal(at("x.hasOwnProperty(|)"), null);
});

test("two calls of the same function have distinct anchors", () => {
  const a = at("x.gain(|0.5)\ny.gain(0.3)");
  const b = at("x.gain(0.5)\ny.gain(|0.3)");
  assert.equal(a.name, b.name);
  assert.notEqual(a.from, b.from);
});
