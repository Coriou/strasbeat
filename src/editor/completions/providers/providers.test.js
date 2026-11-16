// Provider-level tests: run the real completion sources against an
// EditorState with the JavaScript grammar, the way CodeMirror does.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { ensureSyntaxTree } from "@codemirror/language";
import { chord } from "@strudel/core";
import "@strudel/tonal";
import { mini } from "@strudel/mini";

import { functionsProvider, buildFunctionList } from "./functions.js";
import { chordProvider } from "./chord.js";
import { miniNotationProvider } from "./mini-notation.js";
import { setDocs } from "../../docs-store.js";

// The app fetches the docs index after the editor mounts; here it is read
// straight from disk.
setDocs(
  JSON.parse(
    readFileSync(new URL("../../strudel-docs.json", import.meta.url), "utf8"),
  ),
);

const NO_RECENCY = {
  score: () => 0,
  snapshot: () => ({ sound: [], bank: [], chord: [], function: [], note: [], mode: [] }),
};

// `|` marks the cursor.
function contextAt(marked, { explicit = false } = {}) {
  const pos = marked.indexOf("|");
  const doc = marked.slice(0, pos) + marked.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [javascriptLanguage] });
  ensureSyntaxTree(state, doc.length, 1000);
  return { state, pos, context: new CompletionContext(state, pos, explicit) };
}

function labels(result) {
  return result ? result.options.map((o) => o.label) : null;
}

describe("functionsProvider", () => {
  buildFunctionList(["note", "noise", "linger", "s", "n", "x", "stack", "constructor"]);
  const provider = functionsProvider({ recency: NO_RECENCY });

  test("completes identifiers in code", () => {
    const { context } = contextAt("no|");
    assert.ok(labels(provider(context)).includes("note"));
  });

  for (const marked of [
    "// the bass line|",
    "/* slow part| */",
    'x.vowel("a e|")',
    "progression('Cm7 F7 no|')",
    "progression('Cm7 F7 no|",
    "const re = /lin|/",
    "s(`bd no|`)",
  ]) {
    test(`stays quiet in ${JSON.stringify(marked)}`, () => {
      const { context } = contextAt(marked);
      assert.equal(provider(context), null);
      const explicit = contextAt(marked, { explicit: true }).context;
      assert.equal(provider(explicit), null);
    });
  }

  test("still completes right after a closed string or comment", () => {
    assert.ok(labels(provider(contextAt('s("bd").no|').context)).includes("note"));
    assert.ok(labels(provider(contextAt("/* x */ no|").context)).includes("note"));
    assert.ok(labels(provider(contextAt("s(`${no|}`)").context)).includes("note"));
  });

  test("does not complete a number literal", () => {
    assert.equal(provider(contextAt("x.gain(0|").context), null);
    assert.equal(provider(contextAt("sine.range(200|").context), null);
  });

  test("offers documented one-letter functions with their snippet, not undocumented ones", () => {
    const options = provider(contextAt("s|").context).options;
    const s = options.find((o) => o.label === "s");
    assert.ok(s, "s() is offered");
    assert.equal(typeof s.apply, "function", "s() expands its snippet");
    assert.ok(!labels(provider(contextAt("x|").context)).includes("x"));
  });

  test("an inherited Object.prototype name is not treated as documented", () => {
    const options = provider(contextAt("constr|").context).options;
    const c = options.find((o) => o.label === "constructor");
    assert.ok(c);
    assert.equal(c.info, undefined);
    assert.equal(c.apply, undefined);
  });
});

describe("chordProvider", () => {
  const provider = chordProvider({ recency: NO_RECENCY });

  // Apply an option the way CodeMirror would and return the resulting doc.
  function accept(state, result, option) {
    if (typeof option.apply === "function") {
      let next = state;
      const view = {
        state,
        dispatch(spec) {
          next = state.update(spec).state;
        },
      };
      option.apply(view, option, result.from, result.to);
      return next.doc.toString();
    }
    const insert = option.apply ?? option.label;
    return state.update({ changes: { from: result.from, to: result.to, insert } }).state.doc.toString();
  }

  test("every offered chord quality resolves to a voicing", () => {
    const { state, context } = contextAt('chord("C|")');
    const result = provider(context);
    assert.ok(result.options.length > 50);
    const seen = new Set();
    for (const option of result.options) {
      assert.ok(!seen.has(option.label), `duplicate row ${option.label}`);
      seen.add(option.label);
      const doc = accept(state, result, option);
      const symbol = doc.match(/^chord\("(.*)"\)$/)?.[1];
      assert.ok(symbol != null, `unexpected doc ${doc}`);
      // The symbol is typed inside a double-quoted string, which the
      // transpiler hands to the mini-notation parser.
      const parsed = mini(`C${symbol}`).queryArc(0, 1);
      assert.deepEqual(
        parsed.map((h) => h.value),
        [`C${symbol}`],
        `"C${symbol}" is not one mini-notation word`,
      );
      const haps = chord(symbol).voicing().queryArc(0, 1);
      assert.ok(haps.length > 0, `chord("${symbol}") (row "${option.label}") produced no notes`);
    }
  });

  test("the major row inserts a bare root, not the word 'major'", () => {
    const { state, context } = contextAt('chord("C|")');
    const result = provider(context);
    assert.equal(result.options[0].label, "major");
    assert.equal(accept(state, result, result.options[0]), 'chord("C")');
    // …and typing towards the word still lands on a valid chord.
    const typed = contextAt('chord("Cmaj|")');
    const r2 = provider(typed.context);
    const major = r2.options.find((o) => o.label === "major");
    assert.equal(accept(typed.state, r2, major), 'chord("C")');
  });
});

describe("miniNotationProvider", () => {
  const provider = miniNotationProvider({ recency: NO_RECENCY });

  test("offers nothing for operator operands and scale degrees", () => {
    for (const marked of ['s("hh*8|")', 's("bd(3|")', 's("bd(3,8|")', 'n("0 2|")', 's("bd?0|")']) {
      const result = provider(contextAt(marked).context);
      assert.ok(result, `${marked} should reserve the position`);
      assert.deepEqual(result.options, [], marked);
    }
  });

  test("still completes note names", () => {
    const result = provider(contextAt('note("c|")').context);
    assert.ok(labels(result).includes("c"));
  });
});
