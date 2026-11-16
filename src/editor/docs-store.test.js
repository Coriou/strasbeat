import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { syntaxTree } from "@codemirror/language";

import {
  areDocsLoaded,
  getDocs,
  onDocsLoaded,
  setDocs,
  shouldRetryDocs,
} from "./docs-store.js";
import { findCallContext } from "./signature-hint.js";
import { buildFunctionList, functionsProvider } from "./completions/providers/functions.js";
import { CompletionContext } from "@codemirror/autocomplete";

const NO_RECENCY = { score: () => 0 };

// CodeMirror gives the parse that runs inside EditorState.create a ~20 ms
// budget and stores whatever tree it has by then. On a busy machine a cold
// first parse can blow that and leave a truncated tree in the state, so
// build the state again until the stored tree covers the document.
function stateFor(doc) {
  for (let attempt = 0; ; attempt++) {
    const state = EditorState.create({ doc, extensions: [javascriptLanguage] });
    if (syntaxTree(state).length >= doc.length || attempt >= 50) return state;
  }
}

// One test, in order: the store is module state and the point is the
// before → after transition.
test("consumers have nothing to show before the index arrives, and work after", () => {
  const doc = "x.fast(2)";
  const state = stateFor(doc);
  const inCall = doc.indexOf("2");

  // Before: empty index, no hint, completions fall back to live exports.
  assert.equal(areDocsLoaded(), false);
  assert.deepEqual(getDocs(), {});
  assert.equal(findCallContext(state, inCall), null);

  const seen = [];
  const unsubscribe = onDocsLoaded((docs) => seen.push(Object.keys(docs)));
  assert.deepEqual(seen, []);

  buildFunctionList(["fast", "slow"]);
  const provider = functionsProvider({ recency: NO_RECENCY });
  const complete = () => {
    const s = stateFor("fa");
    return provider(new CompletionContext(s, 2, false)).options;
  };
  const before = complete().find((o) => o.label === "fast");
  assert.ok(before, "live export names complete without docs");
  assert.equal(before.info, undefined);

  // The index lands.
  setDocs({
    fast: {
      signature: "fast(factor)",
      doc: "Speed up a pattern.",
      params: [{ name: "factor", type: "number" }],
    },
    fastGap: { signature: "fastGap(factor)", doc: "Speed up, keep the cycle." },
  });
  assert.equal(areDocsLoaded(), true);
  assert.deepEqual(seen, [["fast", "fastGap"]]);

  // The same, untouched editor state now yields a hint.
  const ctx = findCallContext(state, inCall);
  assert.equal(ctx.name, "fast");
  assert.equal(ctx.argIndex, 0);

  // Rebuilding the list (what install.js does on load) adds doc text and
  // the documented-only names.
  buildFunctionList(["fast", "slow"]);
  const after = complete();
  assert.equal(typeof after.find((o) => o.label === "fast").info, "function");
  assert.ok(after.some((o) => o.label === "fastGap"));

  // A late subscriber is called straight away; an unsubscribed one is not
  // called again.
  let late = 0;
  onDocsLoaded(() => late++);
  assert.equal(late, 1);
  unsubscribe();
  setDocs({});
  assert.equal(seen.length, 1);
  assert.equal(late, 2);
});

test("a failed docs fetch is retried by a later read, after a pause", () => {
  const failedAt = 1_000;
  const ask = (now, extra = {}) =>
    shouldRetryDocs({ loaded: false, failedAt, now, retryAfterMs: 5_000, ...extra });
  assert.equal(ask(1_200), false, "not while the failure is fresh");
  assert.equal(ask(6_000), true);
  assert.equal(ask(6_000, { failedAt: null }), false, "nothing failed, or a retry is under way");
  assert.equal(ask(6_000, { loaded: true }), false);
});
