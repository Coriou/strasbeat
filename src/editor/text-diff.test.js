import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";

import { diffChanges } from "./text-diff.js";

function apply(a, changes) {
  let out = "";
  let cursor = 0;
  for (const c of changes) {
    assert.ok(c.from >= cursor, "changes are sorted and non-overlapping");
    assert.ok(c.to >= c.from);
    out += a.slice(cursor, c.from) + c.insert;
    cursor = c.to;
  }
  return out + a.slice(cursor);
}

test("identical strings produce no changes", () => {
  assert.deepEqual(diffChanges("abc", "abc"), []);
});

test("pure insertion and pure deletion collapse to one change", () => {
  assert.deepEqual(diffChanges("s()", 's("bd")'), [
    { from: 2, to: 2, insert: '"bd"' },
  ]);
  assert.deepEqual(diffChanges('s("bd")', "s()"), [
    { from: 2, to: 6, insert: "" },
  ]);
});

test("whitespace-only reformat leaves string literals untouched", () => {
  const a = 'stack(s("bd*4"),s("hh*8")  ,\n   note("c e g"))';
  const b = 'stack(\n  s("bd*4"),\n  s("hh*8"),\n  note("c e g"),\n)';
  const changes = diffChanges(a, b);
  assert.equal(apply(a, changes), b);
  // No change may overlap the inside of a mini-notation string: that is what
  // keeps highlight marks and slider widgets alive across a format.
  for (const lit of ['"bd*4"', '"hh*8"', '"c e g"']) {
    const from = a.indexOf(lit);
    const to = from + lit.length;
    for (const c of changes) {
      assert.ok(
        c.to <= from || c.from >= to,
        `change ${JSON.stringify(c)} overlaps ${lit}`,
      );
    }
  }
});

test("a cursor inside an untouched token maps through the changes", () => {
  const a = 'note( "c e g" ).fast( 2 )';
  const b = 'note("c e g").fast(2)';
  const state = EditorState.create({ doc: a });
  const tr = state.update({ changes: diffChanges(a, b) });
  assert.equal(tr.state.doc.toString(), b);
  const cursor = a.indexOf("e g");
  assert.equal(tr.changes.mapPos(cursor), b.indexOf("e g"));
});

test("falls back to a single trimmed change past the edit-distance cap", () => {
  const a = "keep " + "a".repeat(50) + " tail";
  const b = "keep " + "b".repeat(50) + " tail";
  const changes = diffChanges(a, b, { maxEditDistance: 10 });
  assert.deepEqual(changes, [{ from: 5, to: 55, insert: "b".repeat(50) }]);
});

test("round-trips random edits", () => {
  // Deterministic LCG so a failure is reproducible.
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = 'ab \n"(),';
  const randomString = (len) =>
    Array.from({ length: len }, () => alphabet[rnd(alphabet.length)]).join("");
  for (let i = 0; i < 300; i++) {
    const a = randomString(rnd(60));
    let b = a;
    for (let e = rnd(6); e > 0; e--) {
      const at = rnd(b.length + 1);
      b =
        rnd(2) === 0
          ? b.slice(0, at) + randomString(rnd(4)) + b.slice(at)
          : b.slice(0, at) + b.slice(at + rnd(4));
    }
    const changes = diffChanges(a, b);
    assert.equal(apply(a, changes), b, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    // CodeMirror must accept the spec as-is.
    const tr = EditorState.create({ doc: a }).update({ changes });
    assert.equal(tr.state.doc.toString(), b);
  }
});
