# Intellisense v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take strasbeat's autocomplete from "useful POC" to "feels like VS Code IntelliSense" — a fuzzy ranking kernel with buffer/recency awareness, snippet placeholders, audition, sample-variant completion, bank-aware ranking, and a reveal-in-browser shortcut.

**Architecture:** Replace the current monolithic `src/editor/completions/sounds.js` with a four-layer module under `src/editor/completions/`: pure scoring kernel (`score.js`), buffer + recency context (`context.js`), per-category providers (`providers/*.js`), and a single `install.js` that wires CM6 with `filter: false` so the kernel owns ranking end-to-end. Each phase builds on the prior: ranking → ergonomics → sample/bank coherence → nice-to-haves. Phases are independently shippable; ship Phase 1 if nothing else.

**Tech Stack:** CodeMirror 6 (`@codemirror/autocomplete`, `@codemirror/state`, `@codemirror/view`, `@codemirror/language`), Strudel's `soundMap` (nanostore from `@strudel/webaudio`), `@strudel/tonal` (chord dictionary), Node `--test` for unit tests, `localStorage` for recency persistence. **No new dependencies** — fuzzy kernel is hand-rolled (~150 LOC).

**Spec:** `design/work/22-intellisense-v2.md` (read this end-to-end before starting; the plan below assumes you have).

---

## Pre-flight reading (do this once before Task 1)

Read these files in order. They are the entire context the plan assumes.

1. **`design/work/22-intellisense-v2.md`** — the spec being implemented.
2. **`CLAUDE.md`** — pay attention to the "Conventions" section (no backwards-compat shims, surface silent failures loudly, defer features the user didn't ask for) and the foot-gun about silent sound-name failures.
3. **`src/editor/completions/sounds.js`** — the monolith being replaced. Note especially the `combinedAutocomplete` chain and the rich `renderCompletionInfo` panel renderer — that DOM builder must survive the refactor.
4. **`src/editor/completions/mini-notation.js`** — the existing tree-based provider whose `findMiniContext` walker is the prototype for the new bank-detection algorithm.
5. **`src/editor/mini-notation-tokens.js`** — the tiny tokeniser the colon-aware fragment work extends.
6. **`src/editor/signature-hint.js`** + **`src/editor/hover-docs.js`** — Phase 2 of the original Intellisense v1; survives unchanged. Note the `findCallContext` walker — the new `context.js` shares the same syntax-tree walking idiom.
7. **`src/editor-setup.js`** — where `dispatchEditorExtensions` mounts every CM6 extension. Phase 1 keeps the call site stable; Phase 2/3 may add to it.
8. **`src/main.js`** — see the `installSoundCompletion` call (~line 271). The replacement is a near-identical shape.
9. **`src/editor-actions.js`** — `previewSoundName(name, ctx)` is the audio path Phase 2 audition reuses; Phase 3 extends it with an optional `n` arg.
10. **`src/ui/sound-browser.js`** — `paintActive()` and `flatVisible` are the surface Phase 3.C reveal-in-browser hooks into via a new `focusSound(name)` method.
11. **`src/editor/keymap-universal.js`** — Layer 2 always-on keymap. Phase 2's Tab binding, Phase 3.C's `Cmd+Shift+B`, and Phase 4.C's `Cmd+J` all land here.
12. **`design/work/21-keybindings.md`** — the layered keymap model. Phase 2's Tab-accept must respect insert-mode-only firing; the spec's "Vim/keymap-profile interface" section explains why no special wiring is needed.
13. **`strudel-source/packages/superdough/superdough.mjs:59-170`** — `soundMap` is a nanostore `map()`; `getSound(s) → soundMap.get()[s.toLowerCase()]`. Each entry is `{ onTrigger, data }` where `data.samples` is array form (kits) or object form keyed by MIDI number (chromatic soundfonts). Phase 3.A treats them differently.
14. **`strudel-source/packages/webaudio/supradough.mjs:27-35`** — confirms `s` resolution: `(hap.value.bank ? hap.value.bank + '_' : '') + hap.value.s`, and `urls[n % urls.length]` for variant lookup.

---

## File map (across all phases)

```
NEW
  src/editor/completions/score.js                        Phase 1
  src/editor/completions/score.test.js                   Phase 1
  src/editor/completions/context.js                      Phase 1
  src/editor/completions/context.test.js                 Phase 1
  src/editor/completions/install.js                      Phase 1
  src/editor/completions/info.js                         Phase 1 (extracted from old sounds.js)
  src/editor/completions/providers/sounds.js             Phase 1, extended Phase 3
  src/editor/completions/providers/sounds.test.js        Phase 1
  src/editor/completions/providers/bank.js               Phase 1
  src/editor/completions/providers/chord.js              Phase 1
  src/editor/completions/providers/mode.js               Phase 1
  src/editor/completions/providers/mini-notation.js      Phase 1, colon-aware Phase 3
  src/editor/completions/providers/mini-notation.test.js Phase 1
  src/editor/completions/providers/functions.js          Phase 1, snippets Phase 2

MODIFIED
  src/editor/mini-notation-tokens.js                     Phase 3 (colon-aware return shape)
  src/editor/mini-notation-tokens.test.js                Phase 3 (NEW test for colon awareness)
  src/editor/keymap-universal.js                         Phase 2 (Tab/Alt-Arrow), Phase 3 (Cmd+Shift+B), Phase 4.C (Cmd+J)
  src/ui/sound-browser.js                                Phase 3 (focusSound), Phase 4.A (drag handle)
  src/ui/transport.js                                    Phase 4.B (bank chip)
  src/main.js                                            Phase 1 (install + reveal-event listener)
  src/command-palette-actions.js                         Phase 3 (reveal entry), Phase 4.C (focus-browser entry)
  src/ui/command-palette.js                              Phase 3 (Reveal sound in browser command), Phase 4.C
  src/editor-actions.js                                  Phase 3 (previewSoundName accepts optional n)
  src/editor-setup.js                                    Phase 2 (thread audition ctx through dispatchEditorExtensions)
  src/debug.js                                           Phase 1 (window.strasbeat.completions helpers)
  package.json                                           Phase 1, 3 (new test files registered with test script)

DELETED
  src/editor/completions/sounds.js                       Phase 1 (superseded — split into providers/)
  src/editor/completions/mini-notation.js                Phase 1 (superseded — moved to providers/)
```

---

## Coding ground rules

- **No backwards-compat shims.** Per `CLAUDE.md`: this is a personal tool. Delete the old `sounds.js` / `mini-notation.js` outright when the new modules land. Don't re-export, don't proxy.
- **TDD for pure modules.** `score.js`, `context.js`, `mini-notation-tokens.js` (modified), and each provider's score-and-rank logic — all tested via `node --test` against fixtures. Write the failing test first, run it, see it fail, implement, run again, commit.
- **Surface silent failures loudly.** `localStorage` quota errors are intentionally swallowed (recency is best-effort) — but log them with `console.warn`. Anywhere we read from `soundMap` and find unexpected shapes, log a warning rather than silently returning `[]`.
- **Recency caps are first-cut.** The spec's per-category recency caps (0.30 for sound/bank/function, 0.20 for note/chord, 0.10 for mode) are "first cuts ... tuned against the fixture set during implementation" (spec line 324). The plan implements a single universal `0.30` max in `createRecency.score()` to keep the table simple. After Phase 1 acceptance, if rankings feel off in a particular category (e.g. mode keywords overpowering more relevant function fragments), clamp per-category in the providers (not in the kernel). Don't over-engineer up front.
- **Provider overlap is intentional.** Both `mini-notation.js` and `sounds.js` providers fire inside `s("…")` strings — mini-notation via syntax-tree walking (more accurate, handles edge cases like template literals), sounds via regex `matchBefore` (cheaper fallback). The combined-source order in `install.js` puts mini-notation first, so it wins; the sounds regex path fires only when the syntax tree isn't ready (rare — first paint, tree errors). Both providers must stay bank-aware after Phase 3 to avoid a regression on the fallback path.
- **Don't comment what the code says.** Per repo convention, comments only for non-obvious WHY. Don't write `// this is the kernel` above a function called `score`.
- **Each test file gets registered in `package.json`.** The `test` script lists them explicitly — `pnpm test` won't discover new files automatically.
- **Single-quote literal Strudel strings only when the user would write them in a pattern.** Inside test fixtures and inside this codebase's JS, normal double quotes are fine (the transpiler only runs on user pattern code).

---

# Phase 1 — Ranking engine

After Phase 1, the popup looks identical to today but the order and contents are substantially better. No new UI. Foundational for everything else.

---

## Task 1: Scaffold completions directory

**Files:**
- Create: `src/editor/completions/providers/.gitkeep` (empty placeholder so `git add` picks up the directory before any provider lands)

- [ ] **Step 1: Create the providers subdirectory**

```bash
mkdir -p src/editor/completions/providers
touch src/editor/completions/providers/.gitkeep
```

- [ ] **Step 2: Verify the existing files are still in place**

Run: `ls src/editor/completions/`
Expected output: `mini-notation.js  providers  sounds.js` (the two old files plus the new directory).

- [ ] **Step 3: Commit**

```bash
git add src/editor/completions/providers/.gitkeep
git commit -m "chore(intellisense): scaffold providers directory"
```

---

## Task 2: Score kernel — failing test fixtures

**Files:**
- Create: `src/editor/completions/score.test.js`

The kernel is pure and the spec gives a worked-trace fixture table (spec lines 196-206). We translate that table directly into the test file before writing any kernel code. Runs under `node --test`.

- [ ] **Step 1: Write the test file with all fixtures from the spec**

```js
// src/editor/completions/score.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { score, segment } from "./score.js";

// Worked-trace fixtures from design/work/22-intellisense-v2.md (lines 196-206).
// Numbers are derived from the constants in score.js — when tuning weights,
// regenerate these by hand (they are intentionally rigid so weight changes
// surface as test failures, forcing a deliberate update).
const FIXTURES = [
  { q: "gmpw", c: "gm_pad_warm", expect: "match", min: 1.18, max: 1.20 },
  { q: "pia",  c: "piano",       expect: "match", min: 0.94, max: 0.96 },
  { q: "pia",  c: "gm_piano",    expect: "match", min: 0.53, max: 0.55 },
  { q: "pia",  c: "gm_pad_choir", expect: "null" },
  { q: "bd",   c: "bd_kick",     expect: "match", min: 0.88, max: 0.90 },
  { q: "bd",   c: "808bd_kick",  expect: "match", min: 0.48, max: 0.50 },
];

describe("score(query, candidate)", () => {
  for (const { q, c, expect, min, max } of FIXTURES) {
    test(`${JSON.stringify(q)} vs ${JSON.stringify(c)} → ${expect}`, () => {
      const result = score(q, c);
      if (expect === "null") {
        assert.equal(result, null);
        return;
      }
      assert.ok(result, "expected match, got null");
      assert.ok(typeof result.score === "number", "score must be number");
      assert.ok(Array.isArray(result.matched), "matched must be array");
      assert.equal(result.matched.length, q.length, "matched.length === q.length");
      assert.ok(
        result.score >= min && result.score <= max,
        `score ${result.score} out of [${min}, ${max}]`,
      );
    });
  }

  test("empty query returns score 0 with empty matched", () => {
    const r = score("", "anything");
    assert.deepEqual(r, { score: 0, matched: [] });
  });

  test("ordering: bd < bd_kick < 808bd_kick by length tiebreaker", () => {
    const a = score("bd", "bd").score;
    const b = score("bd", "bd_kick").score;
    const c = score("bd", "808bd_kick").score;
    assert.ok(a > b, `bd (${a}) should outrank bd_kick (${b})`);
    assert.ok(b > c, `bd_kick (${b}) should outrank 808bd_kick (${c})`);
  });

  test("case-insensitive match", () => {
    const a = score("BD", "bd_kick");
    const b = score("bd", "BD_KICK");
    assert.ok(a, "uppercase query matches lowercase candidate");
    assert.ok(b, "lowercase query matches uppercase candidate");
  });

  test("no match when query chars not in subsequence", () => {
    assert.equal(score("xyz", "abc"), null);
    assert.equal(score("ba", "abc"), null);
  });

  test("matched indices are strictly increasing", () => {
    const r = score("gmpw", "gm_pad_warm");
    assert.ok(r);
    for (let i = 1; i < r.matched.length; i++) {
      assert.ok(r.matched[i] > r.matched[i - 1], "matched must be strictly increasing");
    }
  });
});

describe("segment(candidate, matched)", () => {
  test("splits candidate into hit / non-hit runs", () => {
    const r = score("gmpw", "gm_pad_warm");
    assert.ok(r);
    const segs = segment("gm_pad_warm", r.matched);
    const reconstituted = segs.map((s) => s.text).join("");
    assert.equal(reconstituted, "gm_pad_warm");
    const hits = segs.filter((s) => s.hit).map((s) => s.text).join("");
    assert.equal(hits, "gmpw");
  });

  test("empty matched returns single non-hit segment", () => {
    const segs = segment("anything", []);
    assert.deepEqual(segs, [{ text: "anything", hit: false }]);
  });
});
```

- [ ] **Step 2: Register the test in package.json**

Edit `package.json`. Find the `"test"` script and append `src/editor/completions/score.test.js` to the file list:

```json
"test": "node --import ./scripts/test-register.mjs --test src/editor/error-marks.test.js src/editor/track-labels.test.js src/editor/arrange-parse.test.js src/editor/drum-parse.test.js src/editor/drum-write.test.js src/strudel-ext/progression.test.js src/strudel-ext/roman.test.js src/strudel-ext/arrange.test.js src/midi-to-strudel.test.js src/ui/beat-grid.playhead.test.js src/ui/beat-grid.keyboard.test.js src/transpiler-patch.test.js src/share.test.js src/editor/keymap-profiles.test.js src/ui/keymap-chip.test.js src/editor/completions/score.test.js"
```

- [ ] **Step 3: Run test to confirm it fails (no module)**

Run: `pnpm test 2>&1 | grep -E "(FAIL|PASS|score|cannot find)" | head -20`
Expected: failure mentioning `Cannot find module './score.js'` or similar import error. The test runner exits non-zero. This is intentional — confirms tests are wired up.

- [ ] **Step 4: Commit the failing tests**

```bash
git add src/editor/completions/score.test.js package.json
git commit -m "test(intellisense): score.js fixture table from spec"
```

---

## Task 3: Score kernel — implementation

**Files:**
- Create: `src/editor/completions/score.js`

Implement the kernel from the spec's outline (spec lines 213-258). Pure module — no DOM, no CM6 imports.

- [ ] **Step 1: Write the kernel**

```js
// src/editor/completions/score.js
//
// Pure fuzzy-subsequence scoring kernel. Returns null when query is not a
// case-insensitive subsequence of candidate; otherwise returns a score in
// [0, ~1.5] plus the matched character indices for highlight rendering.
//
// Weights are tuned against the fixture table in score.test.js — adjust
// both together.

const W_BASE       = 0.30;  // floor for any subsequence match
const W_PREFIX     = 0.40;  // first query char hit candidate[0]
const W_BOUNDARY   = 0.15;  // each hit landing on a word boundary
const W_RUN        = 0.05;  // each additional contiguous-run char beyond the first
const W_LEN_PEN    = 0.001; // per-character length penalty (tiebreaker)

/**
 * @param {string} query
 * @param {string} candidate
 * @returns {{ score: number, matched: number[] } | null}
 */
export function score(query, candidate) {
  const q = query.toLowerCase();
  if (!q) return { score: 0, matched: [] };

  const cLow = candidate.toLowerCase();
  const matched = [];
  let qi = 0;
  let ci = 0;
  let lastMatched = -1;
  let runBonus = 0;
  let boundaryBonus = 0;
  let isPrefix = false;

  while (qi < q.length && ci < cLow.length) {
    if (q[qi] === cLow[ci]) {
      matched.push(ci);
      if (qi === 0 && ci === 0) isPrefix = true;
      // Spec line 230: count ci === 0 as a boundary too. The fixture
      // ranges in score.test.js were derived from this form.
      if (ci === 0 || isWordBoundary(candidate, ci)) boundaryBonus += W_BOUNDARY;
      if (lastMatched !== -1 && ci - lastMatched === 1) runBonus += W_RUN;
      lastMatched = ci;
      qi++;
    }
    ci++;
  }
  if (qi < q.length) return null;

  const total =
    W_BASE +
    (isPrefix ? W_PREFIX : 0) +
    boundaryBonus +
    runBonus -
    candidate.length * W_LEN_PEN;

  return { score: total, matched };
}

/**
 * Split candidate into alternating hit / non-hit runs for highlighting.
 * @param {string} candidate
 * @param {number[]} matched
 * @returns {Array<{ text: string, hit: boolean }>}
 */
export function segment(candidate, matched) {
  if (!matched || matched.length === 0) {
    return [{ text: candidate, hit: false }];
  }
  const out = [];
  let cursor = 0;
  let i = 0;
  while (i < matched.length) {
    const runStart = matched[i];
    let runEnd = runStart + 1;
    while (i + 1 < matched.length && matched[i + 1] === runEnd) {
      runEnd++;
      i++;
    }
    if (cursor < runStart) {
      out.push({ text: candidate.slice(cursor, runStart), hit: false });
    }
    out.push({ text: candidate.slice(runStart, runEnd), hit: true });
    cursor = runEnd;
    i++;
  }
  if (cursor < candidate.length) {
    out.push({ text: candidate.slice(cursor), hit: false });
  }
  return out;
}

/**
 * @param {string} s — original-case candidate
 * @param {number} i — index inside s (i > 0 caller-guaranteed)
 */
function isWordBoundary(s, i) {
  const prev = s[i - 1];
  if (prev === "_" || prev === "-") return true;
  if (prev >= "0" && prev <= "9" && /[a-zA-Z]/.test(s[i])) return true;
  return prev === prev.toLowerCase() && s[i] !== s[i].toLowerCase();
}
```

- [ ] **Step 2: Run tests**

Run: `pnpm test 2>&1 | grep -E "(score|fail|pass)" | tail -20`
Expected: every fixture passes. If any score is outside its `[min, max]` range, hand-verify the math — the constants and the fixture ranges must agree. Adjust either side to match (the spec's worked traces are approximate; fixture ranges of width 0.02 absorb rounding).

- [ ] **Step 3: Commit**

```bash
git add src/editor/completions/score.js
git commit -m "feat(intellisense): pure fuzzy-subsequence scoring kernel"
```

---

## Task 4: Context module — buffer-token extraction (TDD)

**Files:**
- Create: `src/editor/completions/context.test.js`
- Create: `src/editor/completions/context.js` (skeleton — tests drive the API surface)

Two things in one module: buffer-token extraction (sync, doc-driven) and a recency table (async, persisted). Test the extraction first; recency comes in Task 5.

The extraction reads from a CM6 `EditorState`. For unit testing without booting a full editor, `extractBufferTokens(text)` accepts a plain string (the buffer) and runs a regex-based fallback walker that produces equivalent results for well-formed JS — the production code wraps this in a CM6 `ViewPlugin` that uses `syntaxTree(state)` for accurate parsing. Both paths share the same return shape.

- [ ] **Step 1: Write the test file**

```js
// src/editor/completions/context.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extractBufferTokens } from "./context.js";

describe("extractBufferTokens(text)", () => {
  test("returns a Map keyed by category", () => {
    const tokens = extractBufferTokens("");
    assert.ok(tokens instanceof Map);
    for (const cat of ["sound", "bank", "chord", "function"]) {
      assert.ok(tokens.has(cat), `missing category ${cat}`);
      assert.ok(tokens.get(cat) instanceof Set);
    }
  });

  test("extracts sound names from s() and sound() calls", () => {
    const text = `s("bd sd hh*4").bank("RolandTR909")\nsound("piano")`;
    const tokens = extractBufferTokens(text);
    assert.deepEqual(
      [...tokens.get("sound")].sort(),
      ["bd", "hh", "piano", "sd"],
    );
  });

  test("extracts bank names from bank() calls", () => {
    const text = `s("bd").bank("RolandTR909")\nbank("tr808").s("kick")`;
    const tokens = extractBufferTokens(text);
    assert.deepEqual([...tokens.get("bank")].sort(), ["RolandTR909", "tr808"]);
  });

  test("extracts chord symbols from chord() calls", () => {
    const text = `chord("<C^7 Dm7 G7>")`;
    const tokens = extractBufferTokens(text);
    assert.ok(tokens.get("chord").has("C^7"));
    assert.ok(tokens.get("chord").has("Dm7"));
    assert.ok(tokens.get("chord").has("G7"));
  });

  test("extracts bare function callees", () => {
    const text = `stack(s("bd"), note("c4").room(0.5))`;
    const tokens = extractBufferTokens(text);
    const fns = tokens.get("function");
    assert.ok(fns.has("stack"));
    assert.ok(fns.has("s"));
    assert.ok(fns.has("note"));
  });

  test("strips mini-notation operators from token splits", () => {
    const text = `s("bd*4 [sd cp]")`;
    const tokens = extractBufferTokens(text);
    const sounds = tokens.get("sound");
    assert.ok(sounds.has("bd"));
    assert.ok(sounds.has("sd"));
    assert.ok(sounds.has("cp"));
    // The operator chars themselves should not become "sounds"
    assert.ok(!sounds.has("*"));
    assert.ok(!sounds.has("["));
  });

  test("strips colon variant suffix when extracting sound tokens", () => {
    const text = `s("bd:2 sd:0")`;
    const tokens = extractBufferTokens(text);
    assert.ok(tokens.get("sound").has("bd"));
    assert.ok(tokens.get("sound").has("sd"));
  });

  test("ignores rest token ~", () => {
    const text = `s("bd ~ sd ~")`;
    const tokens = extractBufferTokens(text);
    const sounds = tokens.get("sound");
    assert.ok(!sounds.has("~"));
  });

  test("ignores empty buffer cleanly", () => {
    const tokens = extractBufferTokens("");
    for (const cat of ["sound", "bank", "chord", "function"]) {
      assert.equal(tokens.get(cat).size, 0);
    }
  });
});
```

- [ ] **Step 2: Register the test in package.json**

Append `src/editor/completions/context.test.js` to the `test` script's file list:

```json
"test": "node --import ./scripts/test-register.mjs --test ... src/editor/completions/score.test.js src/editor/completions/context.test.js"
```

- [ ] **Step 3: Write the context.js skeleton with `extractBufferTokens` only**

```js
// src/editor/completions/context.js
//
// Two responsibilities, one module (they share the doc-walk debounce in
// production):
//
//   1. extractBufferTokens — pure regex walker over a buffer string.
//      Recovers the categories the ranker uses for buffer-presence boost.
//      The CM6 ViewPlugin (createBufferContextPlugin, below) wraps this
//      and uses syntaxTree() when available, falling back to the regex
//      walker if the tree isn't ready (rare — only at first paint).
//
//   2. Recency table — LRU per category, persisted to localStorage,
//      cross-tab sync via the storage event. Implemented in Task 5.

const CATEGORIES = ["sound", "bank", "chord", "function"];

const SOUND_CALL_RE = /\b(?:s|sound)\(\s*['"`]([^'"`]*)['"`]/g;
const BANK_CALL_RE  = /\bbank\(\s*['"`]([^'"`]*)['"`]/g;
const CHORD_CALL_RE = /\bchord\(\s*['"`]([^'"`]*)['"`]/g;
const FN_CALL_RE    = /\b([a-z][a-zA-Z0-9_]*)\s*\(/g;

const MINI_SEPARATOR_RE = /[\s[\]<>{},|!@?*/~]+/;

/**
 * Extract buffer-presence tokens for each ranker category from a JS source
 * string. Pure — used directly in tests; the production CM6 ViewPlugin
 * (see createBufferContextPlugin) calls this as its fallback.
 *
 * @param {string} text
 * @returns {Map<"sound" | "bank" | "chord" | "function", Set<string>>}
 */
export function extractBufferTokens(text) {
  const out = new Map();
  for (const cat of CATEGORIES) out.set(cat, new Set());
  if (!text) return out;

  collectInsideQuotes(text, SOUND_CALL_RE, out.get("sound"), splitMiniTokens);
  collectInsideQuotes(text, BANK_CALL_RE,  out.get("bank"),  (s) => [s.trim()]);
  collectInsideQuotes(text, CHORD_CALL_RE, out.get("chord"), splitMiniTokens);

  let m;
  FN_CALL_RE.lastIndex = 0;
  while ((m = FN_CALL_RE.exec(text)) !== null) {
    out.get("function").add(m[1]);
  }
  return out;
}

function collectInsideQuotes(text, re, dest, splitFn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const tok of splitFn(m[1])) {
      if (!tok || tok === "~") continue;
      dest.add(stripVariantSuffix(tok));
    }
  }
}

function splitMiniTokens(content) {
  return content.split(MINI_SEPARATOR_RE).filter(Boolean);
}

function stripVariantSuffix(tok) {
  const i = tok.indexOf(":");
  return i > 0 ? tok.slice(0, i) : tok;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test 2>&1 | grep -E "(extractBufferTokens|fail|pass)" | tail -20`
Expected: all extraction tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/editor/completions/context.js src/editor/completions/context.test.js package.json
git commit -m "feat(intellisense): buffer-token extraction with regex fallback"
```

---

## Task 5: Context module — recency table

**Files:**
- Modify: `src/editor/completions/context.js`
- Modify: `src/editor/completions/context.test.js`

Add the recency LRU + persistence + decay scoring on top of the extraction module.

- [ ] **Step 1: Append recency tests**

Add to the bottom of `src/editor/completions/context.test.js`:

```js
import { createRecency } from "./context.js";

function makeMockStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _store: store,
  };
}

describe("createRecency()", () => {
  test("bump records label with current time, score returns ~0.3 fresh", () => {
    globalThis.localStorage = makeMockStorage();
    const rec = createRecency({ now: () => 1000 });
    rec.bump("sound", "bd");
    const s = rec.score("sound", "bd", { now: 1000 });
    assert.ok(s > 0.29 && s <= 0.30, `expected ~0.3, got ${s}`);
  });

  test("score decays linearly to 0 over 30 days", () => {
    globalThis.localStorage = makeMockStorage();
    const t0 = 0;
    const day = 86400 * 1000;
    const rec = createRecency({ now: () => t0 });
    rec.bump("sound", "bd");
    assert.ok(rec.score("sound", "bd", { now: t0 + day * 15 }) > 0.14);
    assert.ok(rec.score("sound", "bd", { now: t0 + day * 15 }) < 0.16);
    assert.equal(rec.score("sound", "bd", { now: t0 + day * 30 }), 0);
    assert.equal(rec.score("sound", "bd", { now: t0 + day * 45 }), 0);
  });

  test("evicts at index 32, keeps most recent", () => {
    globalThis.localStorage = makeMockStorage();
    let t = 0;
    const rec = createRecency({ now: () => t });
    for (let i = 0; i < 40; i++) {
      t = i * 1000;
      rec.bump("sound", `s${i}`);
    }
    assert.equal(rec.score("sound", "s0", { now: t + 1 }) > 0, false,
      "s0 should be evicted");
    assert.ok(rec.score("sound", "s39", { now: t + 1 }) > 0,
      "s39 should still be present");
  });

  test("persists to localStorage on bump (after debounce flush)", () => {
    const storage = makeMockStorage();
    globalThis.localStorage = storage;
    const rec = createRecency({ now: () => 1000, debounceMs: 0 });
    rec.bump("sound", "bd");
    rec.flush();
    const raw = storage.getItem("strasbeat:completions-recency");
    assert.ok(raw, "expected localStorage entry after flush");
    const parsed = JSON.parse(raw);
    assert.ok(parsed.sound.find((e) => e.label === "bd"));
  });

  test("hydrates from localStorage on construction", () => {
    const storage = makeMockStorage();
    storage.setItem(
      "strasbeat:completions-recency",
      JSON.stringify({ sound: [{ label: "bd", t: 5000 }], bank: [], chord: [], function: [], note: [], mode: [] }),
    );
    globalThis.localStorage = storage;
    const rec = createRecency({ now: () => 5000 });
    assert.ok(rec.score("sound", "bd", { now: 5000 }) > 0.29);
  });

  test("ignores corrupt JSON in storage", () => {
    const storage = makeMockStorage();
    storage.setItem("strasbeat:completions-recency", "not json {{");
    globalThis.localStorage = storage;
    const rec = createRecency({ now: () => 1 });
    assert.equal(rec.score("sound", "bd", { now: 1 }), 0);
  });
});
```

- [ ] **Step 2: Implement createRecency in context.js**

Append to `src/editor/completions/context.js`:

```js
const RECENCY_KEY = "strasbeat:completions-recency";
const RECENCY_CAP = 32;
const RECENCY_DECAY_DAYS = 30;
const RECENCY_MAX_BOOST = 0.3;
const RECENCY_DAY_MS = 86400 * 1000;
const RECENCY_CATEGORIES = ["sound", "bank", "chord", "function", "note", "mode"];

/**
 * Create a recency table with linear time-decay scoring and localStorage
 * persistence. Each category caps at 32 entries (LRU eviction).
 *
 * @param {{ now?: () => number, debounceMs?: number }} [opts]
 *   - now: clock injection for tests (default Date.now)
 *   - debounceMs: write delay for localStorage (default 1000)
 */
export function createRecency({ now = Date.now, debounceMs = 1000 } = {}) {
  const tables = hydrate();
  let writeTimer = null;

  function bump(category, label) {
    if (!RECENCY_CATEGORIES.includes(category)) return;
    if (!label || typeof label !== "string") return;
    const list = tables[category];
    const existing = list.findIndex((e) => e.label === label);
    if (existing >= 0) list.splice(existing, 1);
    list.unshift({ label, t: now() });
    if (list.length > RECENCY_CAP) list.length = RECENCY_CAP;
    scheduleWrite();
  }

  function score(category, label, { now: nowOpt } = {}) {
    const list = tables[category];
    if (!list) return 0;
    const entry = list.find((e) => e.label === label);
    if (!entry) return 0;
    const age = (nowOpt ?? now()) - entry.t;
    const days = age / RECENCY_DAY_MS;
    if (days >= RECENCY_DECAY_DAYS) return 0;
    return Math.max(0, (1 - days / RECENCY_DECAY_DAYS) * RECENCY_MAX_BOOST);
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(tables));
  }

  function flush() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    write();
  }

  function scheduleWrite() {
    if (debounceMs <= 0) {
      write();
      return;
    }
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      write();
    }, debounceMs);
  }

  function write() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(RECENCY_KEY, JSON.stringify(tables));
    } catch (err) {
      console.warn("[strasbeat/completions] recency write failed:", err);
    }
  }

  function syncFromStorage() {
    const fresh = hydrate();
    for (const cat of RECENCY_CATEGORIES) tables[cat] = fresh[cat];
  }

  return { bump, score, snapshot, flush, syncFromStorage };
}

function hydrate() {
  const empty = Object.fromEntries(RECENCY_CATEGORIES.map((c) => [c, []]));
  if (typeof localStorage === "undefined") return empty;
  let raw;
  try {
    raw = localStorage.getItem(RECENCY_KEY);
  } catch {
    return empty;
  }
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return empty;
    for (const cat of RECENCY_CATEGORIES) {
      if (!Array.isArray(parsed[cat])) parsed[cat] = [];
    }
    return parsed;
  } catch {
    console.warn("[strasbeat/completions] recency parse failed, resetting");
    return empty;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm test 2>&1 | grep -E "(createRecency|fail|pass)" | tail -25`
Expected: all recency tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/editor/completions/context.js src/editor/completions/context.test.js
git commit -m "feat(intellisense): recency LRU table with linear decay + localStorage"
```

---

## Task 6: CM6 buffer-context plugin

**Files:**
- Modify: `src/editor/completions/context.js`

Wrap `extractBufferTokens` in a CM6 `ViewPlugin` that re-extracts on debounced doc-change. The plugin exposes its current token map via a getter that the providers will read at completion time.

This step is integration-glue only — no new tests (the plugin's logic is "call extractBufferTokens, debounce 150ms, expose result"; the extraction itself is already tested).

- [ ] **Step 1: Append the ViewPlugin to context.js**

```js
// Append to src/editor/completions/context.js

import { ViewPlugin } from "@codemirror/view";

const BUFFER_DEBOUNCE_MS = 150;

/**
 * CM6 ViewPlugin: maintains a debounced buffer-token cache. The exported
 * `getBufferTokens()` reads the latest cache; providers call it during
 * completion fire to add buffer-presence boosts.
 *
 * Multiple editors are unsupported (strasbeat has one); the cache is
 * keyed on the most recently updated view.
 */
let activeTokens = new Map();
for (const cat of ["sound", "bank", "chord", "function"]) {
  activeTokens.set(cat, new Set());
}

export function getBufferTokens() {
  return activeTokens;
}

export const bufferContextPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.timer = null;
      this.refresh(view);
    }
    update(update) {
      if (!update.docChanged) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.refresh(update.view);
      }, BUFFER_DEBOUNCE_MS);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
    refresh(view) {
      const text = view.state.doc.toString();
      activeTokens = extractBufferTokens(text);
    }
  },
);
```

- [ ] **Step 2: Verify nothing broke**

Run: `pnpm test 2>&1 | tail -5`
Expected: previous tests still pass (importing `ViewPlugin` from `@codemirror/view` works at module load time without mounting an editor — but the test loader uses Vite's resolver, so node should handle the import without crashing on the side-effect of the `ViewPlugin.fromClass` call).

If the import crashes the test runner, mark this step as "investigate" and add a `try/catch` guard around the import, or move the ViewPlugin to a separate file (`context-cm6.js`) imported only at runtime. The pure module's tests must keep passing.

- [ ] **Step 3: Commit**

```bash
git add src/editor/completions/context.js
git commit -m "feat(intellisense): CM6 buffer-context view plugin"
```

---

## Task 7: Functions provider

**Files:**
- Create: `src/editor/completions/info.js` (extracted from old `sounds.js`'s `renderCompletionInfo`)
- Create: `src/editor/completions/providers/functions.js`

The functions provider replaces `fallbackHandler` from the old monolith. It exposes a list of all known Strudel function names (built from the union of live exports + docs index keys) with rich `info` panels for documented entries.

- [ ] **Step 1: Move renderCompletionInfo into info.js**

Read the existing implementation at `src/editor/completions/sounds.js:42-110` (the `renderCompletionInfo` function). Create `src/editor/completions/info.js`:

```js
// src/editor/completions/info.js
//
// Lifted from the old sounds.js monolith — same DOM shape, same class
// names, same CSS hooks (autocomplete-info-*). Renders the rich info
// panel that CodeMirror displays beside a selected completion.

/**
 * @param {string} label
 * @param {{
 *   signature?: string,
 *   doc?: string,
 *   params?: Array<{ name: string, type?: string, doc?: string }>,
 *   examples?: string[]
 * }} entry
 * @returns {HTMLElement}
 */
export function renderCompletionInfo(label, entry) {
  const container = document.createElement("div");
  container.className = "autocomplete-info-container";

  const tooltip = document.createElement("div");
  tooltip.className = "autocomplete-info-tooltip";
  container.appendChild(tooltip);

  const name = document.createElement("h3");
  name.className = "autocomplete-info-function-name";
  name.textContent = entry.signature || `${label}()`;
  tooltip.appendChild(name);

  if (entry.doc) {
    const desc = document.createElement("div");
    desc.className = "autocomplete-info-function-description";
    desc.textContent = entry.doc;
    tooltip.appendChild(desc);
  }

  if (entry.params && entry.params.length > 0) {
    const params = document.createElement("div");
    params.className = "autocomplete-info-params-section";
    for (const p of entry.params) {
      const item = document.createElement("div");
      item.className = "autocomplete-info-param-item";
      const pname = document.createElement("span");
      pname.className = "autocomplete-info-param-name";
      pname.textContent = p.name;
      item.appendChild(pname);
      if (p.type) {
        const ptype = document.createElement("span");
        ptype.className = "autocomplete-info-param-type";
        ptype.textContent = p.type;
        item.appendChild(ptype);
      }
      if (p.doc) {
        const pdesc = document.createElement("div");
        pdesc.className = "autocomplete-info-param-desc";
        pdesc.textContent = p.doc;
        item.appendChild(pdesc);
      }
      params.appendChild(item);
    }
    tooltip.appendChild(params);
  }

  if (entry.examples && entry.examples.length > 0) {
    const ex = document.createElement("div");
    ex.className = "autocomplete-info-examples-section";
    for (const code of entry.examples) {
      const pre = document.createElement("pre");
      pre.className = "autocomplete-info-example-code";
      pre.textContent = code;
      ex.appendChild(pre);
    }
    tooltip.appendChild(ex);
  }

  return container;
}
```

- [ ] **Step 2: Write providers/functions.js**

```js
// src/editor/completions/providers/functions.js
//
// Bare-identifier completion: function names from the union of live
// Strudel exports + docs.json keys, scored against the cursor's word
// fragment. Snippets for known function templates land in Phase 2.

import docs from "../../strudel-docs.json";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";
import { renderCompletionInfo } from "../info.js";

const CATEGORY_BASE = 0.0;
const BUFFER_BOOST = 0.4;
const RECENCY_BOOST_MAX = 0.3;
const MAX_RESULTS = 60;

let functionList = [];

/**
 * Build the function list once at install time. Names from `liveExports`
 * (the union of all @strudel/* package exports) seed the list; names that
 * also have a docs entry get the rich info panel.
 *
 * @param {string[]} liveExports
 */
export function buildFunctionList(liveExports) {
  const seen = new Set();
  const out = [];
  const consider = (name) => {
    if (seen.has(name)) return;
    if (!/^[a-z]/.test(name) || name.length < 2) return;
    seen.add(name);
    const entry = docs[name];
    if (entry) {
      out.push({ label: name, type: "function", entry });
    } else {
      out.push({ label: name, type: "function", entry: null });
    }
  };
  for (const name of liveExports) consider(name);
  for (const name of Object.keys(docs)) consider(name);
  functionList = out;
}

export function functionsProvider({ recency }) {
  return function provider(context) {
    const word = context.matchBefore(/\w*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    const fragment = word.text;
    const buffer = getBufferTokens().get("function");
    const ranked = [];
    for (const fn of functionList) {
      const m = score(fragment, fn.label);
      if (!m) continue;
      const finalScore =
        m.score +
        (buffer.has(fn.label) ? BUFFER_BOOST : 0) +
        recency.score("function", fn.label) +
        CATEGORY_BASE;
      ranked.push({ fn, finalScore });
    }
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    const top = ranked.slice(0, MAX_RESULTS);

    return {
      from: word.from,
      to: word.to,
      filter: false,
      options: top.map(({ fn, finalScore }) => completionFor(fn, finalScore)),
    };
  };
}

function completionFor(fn, finalScore) {
  const opt = {
    label: fn.label,
    type: "function",
    boost: finalScore,
  };
  if (fn.entry) {
    if (fn.entry.doc) {
      const first = fn.entry.doc.split(/[.!?]\s/)[0];
      opt.detail = first.length > 60 ? first.slice(0, 57) + "..." : first;
    }
    opt.info = () => renderCompletionInfo(fn.label, fn.entry);
  }
  return opt;
}
```

- [ ] **Step 3: Verify it imports cleanly**

Run: `node -e "import('/Users/ben/Projects/strasbeat/src/editor/completions/providers/functions.js').then(m => console.log(Object.keys(m)))" 2>&1 | head -10`
Expected: prints `[ 'buildFunctionList', 'functionsProvider' ]` (or fails — if node's ESM resolver chokes on the JSON import / CM6 packages, that's OK; the production code runs through Vite which handles both. Skip this verification step in that case.)

- [ ] **Step 4: Commit**

```bash
git add src/editor/completions/info.js src/editor/completions/providers/functions.js
git commit -m "feat(intellisense): functions provider with score-and-rank"
```

---

## Task 8: Sounds provider (cold path — no bank context yet)

**Files:**
- Create: `src/editor/completions/providers/sounds.js`
- Create: `src/editor/completions/providers/sounds.test.js`

Phase 1 sounds provider: completes inside `s("…")` / `sound("…")` calls on the bare-identifier-fragment path. Bank-context detection (Phase 3.B) is added later — Phase 1 just keeps the existing "all sounds, ranked by query" behavior with the new kernel.

The "starter shelf" with the 12 curated defaults is included now.

- [ ] **Step 1: Write the sounds provider**

```js
// src/editor/completions/providers/sounds.js

import { soundMap } from "@strudel/webaudio";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";

const CATEGORY_BASE = 1.0;
const BUFFER_BOOST = 0.5;
const RECENCY_BOOST_MAX = 0.3;
const MAX_RESULTS = 80;

const STARTER_SHELF = [
  "bd", "sd", "hh", "oh", "cp", "ride",
  "gm_piano", "gm_pad_warm", "gm_strings",
  "sine", "saw", "tri",
];

const SOUND_NO_QUOTES = /(?:^|[^\w])(?:s|sound)\(\s*$/;
const SOUND_WITH_QUOTES = /(?:^|[^\w])(?:s|sound)\(\s*['"][^'"]*$/;
const SOUND_FRAGMENT = /(?:[\s[{(<])([\w]*)$|^([\w]*)$/;

let cachedSoundKeys = [];
let cachedSnapshot = null;

function getSoundKeys() {
  const current = soundMap.get();
  if (current !== cachedSnapshot) {
    cachedSnapshot = current;
    cachedSoundKeys = Object.keys(current);
  }
  return cachedSoundKeys;
}

export function soundsProvider({ recency }) {
  return function provider(context) {
    const noQuotes = context.matchBefore(SOUND_NO_QUOTES);
    if (noQuotes) {
      // Cursor at `s(` with no quote yet — defer to ergonomics phase
      // for snippet expansion; for now, no completions here.
      return null;
    }

    const ctx = context.matchBefore(SOUND_WITH_QUOTES);
    if (!ctx) return null;

    const text = ctx.text;
    const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
    if (quoteIdx === -1) return null;
    const inside = text.slice(quoteIdx + 1);

    const fragMatch = inside.match(SOUND_FRAGMENT);
    const fragment = fragMatch ? fragMatch[1] ?? fragMatch[2] ?? "" : "";

    return rank({
      fragment,
      from: ctx.to - fragment.length,
      to: ctx.to,
      explicit: context.explicit,
      recency,
    });
  };
}

/**
 * Pure ranking — exported for tests and for the mini-notation provider
 * to reuse on the inside-string path.
 */
export function rankSounds({ fragment, buffer, recency, allKeys }) {
  if (!fragment) {
    return rankStarterShelf({ buffer, recency, allKeys });
  }
  const out = [];
  for (const name of allKeys) {
    const m = score(fragment, name);
    if (!m) continue;
    const finalScore =
      m.score +
      (buffer.has(name) ? BUFFER_BOOST : 0) +
      recency.score("sound", name) +
      CATEGORY_BASE;
    const bank = bankPrefix(name);
    out.push({ label: name, finalScore, bank });
  }
  out.sort((a, b) => b.finalScore - a.finalScore);
  return out.slice(0, MAX_RESULTS);
}

function rankStarterShelf({ buffer, recency, allKeys }) {
  const keys = new Set(allKeys);
  const present = STARTER_SHELF.filter((n) => keys.has(n));
  const seen = new Set(present);
  const bufferEntries = [...buffer].filter((n) => keys.has(n) && !seen.has(n));
  bufferEntries.forEach((n) => seen.add(n));
  const recent = recency.snapshot
    ? recency.snapshot().sound.map((e) => e.label).filter((n) => keys.has(n) && !seen.has(n))
    : [];

  const out = [];
  for (const name of [...present, ...bufferEntries, ...recent]) {
    const finalScore =
      0.5 +
      (buffer.has(name) ? BUFFER_BOOST : 0) +
      recency.score("sound", name) +
      CATEGORY_BASE;
    out.push({ label: name, finalScore, bank: bankPrefix(name) });
  }
  return out.slice(0, 20);
}

function rank({ fragment, from, to, explicit, recency }) {
  const buffer = getBufferTokens().get("sound");
  const allKeys = getSoundKeys();
  if (!fragment && !explicit) {
    // Don't auto-trigger an empty starter shelf during normal typing —
    // only on Ctrl+Space (explicit). The mini-notation provider handles
    // space-inside-string as a separate auto-trigger.
    return null;
  }
  const ranked = rankSounds({ fragment, buffer, recency, allKeys });
  return {
    from,
    to,
    filter: false,
    options: ranked.map((r) => ({
      label: r.label,
      type: "sound",
      detail: r.bank,
      boost: r.finalScore,
    })),
  };
}

function bankPrefix(name) {
  const i = name.indexOf("_");
  return i > 0 ? name.slice(0, i) : "";
}
```

- [ ] **Step 2: Write the sounds tests**

```js
// src/editor/completions/providers/sounds.test.js
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { rankSounds } from "./sounds.js";

const ALL_KEYS = [
  "bd", "bd_kick", "808bd_kick", "RolandTR909_bd",
  "sd", "hh", "piano", "gm_piano", "gm_pad_warm", "gm_pad_choir",
];

const NO_RECENCY = {
  score: () => 0,
  snapshot: () => ({ sound: [], bank: [], chord: [], function: [], note: [], mode: [] }),
};

const NO_BUFFER = new Set();

describe("rankSounds", () => {
  test("query 'pian' surfaces piano + gm_piano in top 2", () => {
    const ranked = rankSounds({
      fragment: "pian",
      buffer: NO_BUFFER,
      recency: NO_RECENCY,
      allKeys: ALL_KEYS,
    });
    const top2 = ranked.slice(0, 2).map((r) => r.label);
    assert.ok(top2.includes("piano"), `top2 missing piano: ${top2}`);
    assert.ok(top2.includes("gm_piano"), `top2 missing gm_piano: ${top2}`);
  });

  test("query 'gmpw' surfaces gm_pad_warm in top 3", () => {
    const ranked = rankSounds({
      fragment: "gmpw",
      buffer: NO_BUFFER,
      recency: NO_RECENCY,
      allKeys: ALL_KEYS,
    });
    const top3 = ranked.slice(0, 3).map((r) => r.label);
    assert.ok(top3.includes("gm_pad_warm"), `top3 missing gm_pad_warm: ${top3}`);
  });

  test("buffer presence boosts an in-buffer name above its sibling", () => {
    const buffer = new Set(["bd_kick"]);
    const ranked = rankSounds({
      fragment: "bd",
      buffer,
      recency: NO_RECENCY,
      allKeys: ALL_KEYS,
    });
    const bdKickIdx = ranked.findIndex((r) => r.label === "bd_kick");
    const bd808Idx = ranked.findIndex((r) => r.label === "808bd_kick");
    assert.ok(bdKickIdx >= 0 && bd808Idx >= 0);
    assert.ok(bdKickIdx < bd808Idx, "bd_kick (in buffer) should outrank 808bd_kick");
  });

  test("recency boost overrides cold ordering", () => {
    const recency = {
      score: (cat, label) => (label === "808bd_kick" ? 0.3 : 0),
      snapshot: () => ({ sound: [], bank: [], chord: [], function: [], note: [], mode: [] }),
    };
    const ranked = rankSounds({
      fragment: "bd",
      buffer: NO_BUFFER,
      recency,
      allKeys: ALL_KEYS,
    });
    const bd808Idx = ranked.findIndex((r) => r.label === "808bd_kick");
    const bdKickIdx = ranked.findIndex((r) => r.label === "bd_kick");
    assert.ok(bd808Idx < bdKickIdx, "recently-used 808bd_kick should outrank cold bd_kick");
  });

  test("respects MAX_RESULTS cap", () => {
    const big = Array.from({ length: 500 }, (_, i) => `s${i}`);
    const ranked = rankSounds({
      fragment: "s",
      buffer: NO_BUFFER,
      recency: NO_RECENCY,
      allKeys: big,
    });
    assert.ok(ranked.length <= 80, `ranked ${ranked.length} should be ≤ 80`);
  });
});
```

- [ ] **Step 3: Register the test in package.json**

Append `src/editor/completions/providers/sounds.test.js` to the test file list.

- [ ] **Step 4: Run tests**

Run: `pnpm test 2>&1 | grep -E "(rankSounds|fail|pass)" | tail -15`
Expected: all rank tests pass. If `pian` doesn't surface `piano` and `gm_piano` in the top 2, hand-trace the scores: `piano` should win on prefix-match + length, `gm_piano` should be second-best via word-boundary match on the `p`. Adjust `CATEGORY_BASE` only if you need cross-category tie-breaking (Phase 1 doesn't — there's no functions-vs-sounds collision yet in this test).

- [ ] **Step 5: Commit**

```bash
git add src/editor/completions/providers/sounds.js src/editor/completions/providers/sounds.test.js package.json
git commit -m "feat(intellisense): sounds provider with starter shelf"
```

---

## Task 9: Bank, chord, mode providers

**Files:**
- Create: `src/editor/completions/providers/bank.js`
- Create: `src/editor/completions/providers/chord.js`
- Create: `src/editor/completions/providers/mode.js`

These three are smaller because their universes are smaller (banks: ~15-30 unique prefixes; chord symbols: ~30 from `complex`; modes: 4 keywords). No starter shelf needed — empty query returns the whole list ranked by recency + buffer + base.

- [ ] **Step 1: Write providers/bank.js**

```js
// src/editor/completions/providers/bank.js

import { soundMap } from "@strudel/webaudio";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";

const CATEGORY_BASE = 0.8;
const BUFFER_BOOST = 0.4;

const BANK_NO_QUOTES = /\bbank\(\s*$/;
const BANK_WITH_QUOTES = /\bbank\(\s*['"][^'"]*$/;

let cachedBanks = [];
let cachedSnapshot = null;

function getBankList() {
  const current = soundMap.get();
  if (current !== cachedSnapshot) {
    cachedSnapshot = current;
    const banks = new Set();
    for (const key of Object.keys(current)) {
      const i = key.indexOf("_");
      if (i > 0) banks.add(key.slice(0, i));
    }
    cachedBanks = [...banks].sort();
  }
  return cachedBanks;
}

export function bankProvider({ recency }) {
  return function provider(context) {
    const noQuotes = context.matchBefore(BANK_NO_QUOTES);
    if (noQuotes) return null;
    const ctx = context.matchBefore(BANK_WITH_QUOTES);
    if (!ctx) return null;

    const text = ctx.text;
    const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
    if (quoteIdx === -1) return null;
    const fragment = text.slice(quoteIdx + 1);

    const buffer = getBufferTokens().get("bank");
    const ranked = [];
    for (const name of getBankList()) {
      const m = score(fragment, name);
      if (!m) continue;
      const finalScore =
        m.score +
        (buffer.has(name) ? BUFFER_BOOST : 0) +
        recency.score("bank", name) +
        CATEGORY_BASE;
      ranked.push({ label: name, finalScore });
    }
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    return {
      from: ctx.to - fragment.length,
      to: ctx.to,
      filter: false,
      options: ranked.map((r) => ({
        label: r.label,
        type: "namespace",
        detail: "bank",
        boost: r.finalScore,
      })),
    };
  };
}
```

- [ ] **Step 2: Write providers/chord.js**

Lift the pitch-name table and `complex` chord-dictionary handling from the old `sounds.js:197-302`, but route through the kernel:

```js
// src/editor/completions/providers/chord.js

import { complex } from "@strudel/tonal";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";

const CATEGORY_BASE = 0.5;
const BUFFER_BOOST = 0.3;

const PITCH_NAMES = [
  "C", "C#", "Db", "D", "D#", "Eb", "E", "E#", "Fb",
  "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb",
  "B", "B#", "Cb",
];

const CHORD_SYMBOLS = ["", ...Object.keys(complex)].sort();

const CHORD_NO_QUOTES = /\bchord\(\s*$/;
const CHORD_WITH_QUOTES = /\bchord\(\s*['"][^'"]*$/;
const CHORD_FRAGMENT = /(?:[\s[{(<])([\w#b+^:-]*)$|^([\w#b+^:-]*)$/;

export function chordProvider({ recency }) {
  return function provider(context) {
    const noQuotes = context.matchBefore(CHORD_NO_QUOTES);
    if (noQuotes) return null;
    const ctx = context.matchBefore(CHORD_WITH_QUOTES);
    if (!ctx) return null;

    const text = ctx.text;
    const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
    if (quoteIdx === -1) return null;
    const inside = text.slice(quoteIdx + 1);
    const fragMatch = inside.match(CHORD_FRAGMENT);
    const fragment = fragMatch ? fragMatch[1] ?? fragMatch[2] ?? "" : "";

    let rootMatch = null;
    let symbolFragment = fragment;
    for (const pitch of PITCH_NAMES) {
      if (fragment.toLowerCase().startsWith(pitch.toLowerCase())) {
        if (!rootMatch || pitch.length > rootMatch.length) {
          rootMatch = pitch;
          symbolFragment = fragment.slice(pitch.length);
        }
      }
    }

    const buffer = getBufferTokens().get("chord");

    if (rootMatch) {
      const ranked = scoreList(CHORD_SYMBOLS, symbolFragment, buffer, recency);
      return {
        from: ctx.to - symbolFragment.length,
        to: ctx.to,
        filter: false,
        options: ranked.map((r) => ({
          label: r.label === "" ? "major" : r.label,
          apply: r.label,
          type: "type",
          detail: "chord quality",
          boost: r.finalScore,
        })),
      };
    }

    const ranked = scoreList(PITCH_NAMES, fragment, buffer, recency);
    return {
      from: ctx.to - fragment.length,
      to: ctx.to,
      filter: false,
      options: ranked.map((r) => ({
        label: r.label,
        type: "pitch",
        boost: r.finalScore,
      })),
    };
  };
}

function scoreList(items, fragment, buffer, recency) {
  const out = [];
  for (const name of items) {
    const m = fragment ? score(fragment, name) : { score: 0.3, matched: [] };
    if (!m) continue;
    const finalScore =
      m.score +
      (buffer.has(name) ? BUFFER_BOOST : 0) +
      recency.score("chord", name) +
      CATEGORY_BASE;
    out.push({ label: name, finalScore });
  }
  out.sort((a, b) => b.finalScore - a.finalScore);
  return out;
}
```

- [ ] **Step 3: Write providers/mode.js**

```js
// src/editor/completions/providers/mode.js

import { score } from "../score.js";
import { getBufferTokens } from "../context.js";

const CATEGORY_BASE = 0.5;
const BUFFER_BOOST = 0.2;

const MODES = [
  { label: "below", detail: "voice below anchor" },
  { label: "above", detail: "voice above anchor" },
  { label: "duck",  detail: "avoid root note" },
  { label: "root",  detail: "root position" },
];

const PITCH_NAMES = [
  "C", "C#", "Db", "D", "D#", "Eb", "E", "F",
  "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B",
];

const MODE_NO_QUOTES = /\bmode\(\s*$/;
const MODE_AFTER_COLON = /\bmode\(\s*['"][^'"]*:[^'"]*$/;
const MODE_PRE_COLON = /\bmode\(\s*['"][^'"]*$/;

export function modeProvider({ recency }) {
  return function provider(context) {
    if (context.matchBefore(MODE_NO_QUOTES)) return null;

    const afterColon = context.matchBefore(MODE_AFTER_COLON);
    if (afterColon) {
      const text = afterColon.text;
      const colonIdx = text.lastIndexOf(":");
      const fragment = text.slice(colonIdx + 1);
      const ranked = PITCH_NAMES
        .map((p) => {
          const m = fragment ? score(fragment, p) : { score: 0.3, matched: [] };
          return m ? { label: p, finalScore: m.score + CATEGORY_BASE } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.finalScore - a.finalScore);
      return {
        from: afterColon.from + colonIdx + 1,
        to: afterColon.to,
        filter: false,
        options: ranked.map((r) => ({
          label: r.label, type: "pitch", boost: r.finalScore,
        })),
      };
    }

    const ctx = context.matchBefore(MODE_PRE_COLON);
    if (!ctx) return null;
    const text = ctx.text;
    const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
    if (quoteIdx === -1) return null;
    const fragment = text.slice(quoteIdx + 1);

    const buffer = getBufferTokens().get("function"); // mode words bleed into fn ns
    const ranked = MODES
      .map((mode) => {
        const m = fragment ? score(fragment, mode.label) : { score: 0.3, matched: [] };
        if (!m) return null;
        return {
          ...mode,
          finalScore:
            m.score +
            (buffer.has(mode.label) ? BUFFER_BOOST : 0) +
            recency.score("mode", mode.label) +
            CATEGORY_BASE,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.finalScore - a.finalScore);

    return {
      from: ctx.to - fragment.length,
      to: ctx.to,
      filter: false,
      options: ranked.map((r) => ({
        label: r.label,
        type: "keyword",
        detail: r.detail,
        boost: r.finalScore,
      })),
    };
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/editor/completions/providers/bank.js src/editor/completions/providers/chord.js src/editor/completions/providers/mode.js
git commit -m "feat(intellisense): bank, chord, mode providers"
```

---

## Task 10: Mini-notation provider (Phase 1 shape)

**Files:**
- Create: `src/editor/completions/providers/mini-notation.js`
- Create: `src/editor/completions/providers/mini-notation.test.js`

The new mini-notation provider replaces the old one. It uses the existing `tokenAtOffset` and `miniContext` helpers from `src/editor/mini-notation-tokens.js` (untouched in Phase 1) and reuses `rankSounds` from the sounds provider for the inside-string sound completion. Note completion uses a small local pitch table (no kernel needed — short universe).

- [ ] **Step 1: Write providers/mini-notation.js**

```js
// src/editor/completions/providers/mini-notation.js

import { syntaxTree } from "@codemirror/language";
import { soundMap } from "@strudel/webaudio";
import { tokenAtOffset, miniContext } from "../../mini-notation-tokens.js";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";
import { rankSounds } from "./sounds.js";

const NOTE_NAMES = ["c", "d", "e", "f", "g", "a", "b"];
const ACCIDENTALS = ["", "#", "b"];
const OCTAVES = ["0", "1", "2", "3", "4", "5", "6", "7", "8"];

const NOTE_COMPLETIONS = (() => {
  const opts = [];
  for (const n of NOTE_NAMES) {
    for (const acc of ACCIDENTALS) opts.push({ label: `${n}${acc}` });
  }
  for (const n of NOTE_NAMES) {
    for (const acc of ACCIDENTALS) {
      for (const oct of OCTAVES) opts.push({ label: `${n}${acc}${oct}` });
    }
  }
  return opts;
})();

let cachedKeys = [];
let cachedSnapshot = null;
function getSoundKeys() {
  const current = soundMap.get();
  if (current !== cachedSnapshot) {
    cachedSnapshot = current;
    cachedKeys = Object.keys(current);
  }
  return cachedKeys;
}

/**
 * @param {{ recency: ReturnType<typeof import("../context.js").createRecency> }} deps
 */
export function miniNotationProvider({ recency }) {
  return function provider(context) {
    const ctx = findMiniContext(context.state, context.pos);
    if (!ctx) return null;
    const kind = miniContext(ctx.fnName);
    if (kind === "other") return null;

    const tok = tokenAtOffset(ctx.content, ctx.cursorOffset);
    if (!tok && !context.explicit) return null;

    const fragment = tok ? tok.token : "";
    const from = tok ? ctx.contentFrom + tok.from : context.pos;
    const to = tok ? ctx.contentFrom + tok.to : context.pos;

    if (kind === "sound") {
      const buffer = getBufferTokens().get("sound");
      const ranked = rankSounds({
        fragment,
        buffer,
        recency,
        allKeys: getSoundKeys(),
      });
      if (ranked.length === 0) return null;
      return {
        from, to, filter: false,
        options: ranked.map((r) => ({
          label: r.label,
          type: "sound",
          detail: r.bank,
          boost: r.finalScore,
        })),
      };
    }

    // note context
    const buffer = getBufferTokens().get("function");
    const ranked = NOTE_COMPLETIONS
      .map((n) => {
        const m = fragment ? score(fragment, n.label) : { score: 0.3, matched: [] };
        if (!m) return null;
        return {
          label: n.label,
          finalScore: m.score + (buffer.has(n.label) ? 0.3 : 0) + 0.6,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.finalScore - a.finalScore);

    if (ranked.length === 0) return null;
    return {
      from, to, filter: false,
      options: ranked.slice(0, 60).map((r) => ({
        label: r.label, type: "constant", boost: r.finalScore,
      })),
    };
  };
}

/**
 * Walk up from cursor to find an enclosing string literal that is a direct
 * argument to a function call. Returns the function name + content range +
 * cursor offset within content. Lifted from the old mini-notation.js with
 * no behavior change in Phase 1; Phase 3 extends with bank-detection.
 */
function findMiniContext(state, pos) {
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);

  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name !== "String" && cur.name !== "TemplateString") continue;
    const strFrom = cur.from;
    const strTo = cur.to;
    const raw = state.sliceDoc(strFrom, strTo);
    if (!(raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`"))) continue;
    const contentFrom = strFrom + 1;
    const contentTo = strTo - (raw.endsWith(raw[0]) ? 1 : 0);
    if (pos < contentFrom || pos > contentTo) continue;

    let fnName = null;
    for (let p = cur.parent; p; p = p.parent) {
      if (p.name === "CallExpression") {
        const callee = p.firstChild;
        if (!callee) break;
        if (callee.name === "VariableName" || callee.name === "Identifier") {
          fnName = state.sliceDoc(callee.from, callee.to);
        } else if (callee.name === "MemberExpression" || callee.name === "MemberAccess") {
          let prop = callee.lastChild;
          if (prop && prop.name === ".") prop = prop.nextSibling;
          if (prop) fnName = state.sliceDoc(prop.from, prop.to);
        }
        break;
      }
      if (p.name === "ArrowFunction" || p.name === "FunctionDeclaration" || p.name === "FunctionExpression") break;
    }
    if (!fnName) continue;

    return {
      fnName,
      contentFrom,
      contentTo,
      content: state.sliceDoc(contentFrom, contentTo),
      cursorOffset: pos - contentFrom,
    };
  }
  return null;
}
```

- [ ] **Step 2: Write a smoke test that exercises rankSounds wiring**

```js
// src/editor/completions/providers/mini-notation.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// We can't unit-test the CM6 provider (it depends on syntaxTree), but we
// can smoke-test that the module loads cleanly and re-exports nothing it
// shouldn't.

describe("mini-notation provider module", () => {
  test("imports cleanly", async () => {
    const m = await import("./mini-notation.js");
    assert.equal(typeof m.miniNotationProvider, "function");
  });
});
```

- [ ] **Step 3: Register the test in package.json**

Append `src/editor/completions/providers/mini-notation.test.js` to the test script's file list.

- [ ] **Step 4: Run tests**

Run: `pnpm test 2>&1 | tail -10`
Expected: previous tests still pass; the new smoke test runs (or skips if node ESM resolver can't load CM6 modules — that's acceptable; the production path runs through Vite). If the smoke test fails because of the CM6 import, comment it out and rely on the integration check at Phase 1 acceptance.

- [ ] **Step 5: Commit**

```bash
git add src/editor/completions/providers/mini-notation.js src/editor/completions/providers/mini-notation.test.js package.json
git commit -m "feat(intellisense): mini-notation provider routed through ranker"
```

---

## Task 11: install.js + main.js wiring + delete old monoliths

**Files:**
- Create: `src/editor/completions/install.js`
- Modify: `src/main.js`
- Delete: `src/editor/completions/sounds.js`
- Delete: `src/editor/completions/mini-notation.js`

This is the Phase 1 wire-up. install.js builds the function list, instantiates providers with a shared recency, mounts the buffer-context plugin, and reconfigures Strudel's autocompletion compartment.

- [ ] **Step 1: Write install.js**

```js
// src/editor/completions/install.js
//
// Wires the new completion stack into the live editor:
//
//   1. Builds the function name list from live exports + docs.
//   2. Instantiates a shared recency table (one per editor).
//   3. Composes all providers into a single CompletionSource that runs
//      them in order and returns the first non-null result.
//   4. Reconfigures Strudel's `compartments.isAutoCompletionEnabled`
//      compartment with our overrides + the buffer-context plugin.
//   5. Wraps the autocompletion config so accepted completions bump
//      the recency table.
//
// The combined-source ordering matches the spec's category-precedence:
// mini-notation first (string-context), then explicit-quoted-arg
// providers (sound/bank/chord/mode), then bare-identifier function
// fallback. Each provider returns null when its context predicate
// doesn't match, and the chain falls through.

import { autocompletion, pickedCompletion } from "@codemirror/autocomplete";
import { compartments } from "@strudel/codemirror";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createRecency, bufferContextPlugin } from "./context.js";
import { miniNotationProvider } from "./providers/mini-notation.js";
import { soundsProvider } from "./providers/sounds.js";
import { bankProvider } from "./providers/bank.js";
import { chordProvider } from "./providers/chord.js";
import { modeProvider } from "./providers/mode.js";
import { functionsProvider, buildFunctionList } from "./providers/functions.js";

let installedRecency = null;

/**
 * @param {import("@codemirror/view").EditorView} view
 * @param {string[]} liveExports
 * @returns {{ recency: ReturnType<typeof createRecency> }}
 */
export function installCompletions(view, liveExports) {
  buildFunctionList(liveExports);
  const recency = createRecency();
  installedRecency = recency;

  const providers = [
    miniNotationProvider({ recency }),
    soundsProvider({ recency }),
    bankProvider({ recency }),
    chordProvider({ recency }),
    modeProvider({ recency }),
    functionsProvider({ recency }),
  ];

  const combined = (context) => {
    for (const p of providers) {
      const result = p(context);
      if (result) return result;
    }
    return null;
  };

  // Listen for cross-tab recency updates.
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === "strasbeat:completions-recency") recency.syncFromStorage();
    });
  }

  // The recency-bump update listener: every accepted completion records
  // its label + category in the recency table.
  const recencyBumpListener = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      const picked = tr.annotation(pickedCompletion);
      if (!picked) continue;
      const cat = mapCmTypeToCategory(picked.type);
      if (cat) recency.bump(cat, picked.label);
    }
  });

  view.dispatch({
    effects: [
      compartments.isAutoCompletionEnabled.reconfigure([
        autocompletion({
          override: [combined],
          closeOnBlur: false,
          activateOnTyping: true,
          activateOnTypingDelay: 80,
        }),
      ]),
      StateEffect.appendConfig.of([bufferContextPlugin, recencyBumpListener]),
    ],
  });

  return { recency };
}

/** Exposes the live recency for the debug helpers (window.strasbeat.completions). */
export function getInstalledRecency() {
  return installedRecency;
}

function mapCmTypeToCategory(cmType) {
  switch (cmType) {
    case "sound":     return "sound";
    case "namespace": return "bank";
    case "type":      return "chord";   // chord-symbol completions are type:"type"
    case "pitch":     return "chord";   // pitch-name completions also bump chord
    case "keyword":   return "mode";
    case "function":  return "function";
    case "constant":  return "note";
    default:          return null;
  }
}
```

- [ ] **Step 2: Update main.js**

In `src/main.js`, find the existing import + call:

```js
import { installSoundCompletion } from "./editor/completions/sounds.js";
// ...
installSoundCompletion(editor.editor, [...]);
```

Replace with:

```js
import { installCompletions } from "./editor/completions/install.js";
// ...
installCompletions(editor.editor, [
  ...new Set([
    ...Object.keys(strudelCore),
    ...Object.keys(strudelMini),
    ...Object.keys(strudelTonal),
    ...Object.keys(strudelWebaudio),
    ...Object.keys(strudelExt),
  ]),
]);
```

- [ ] **Step 3: Delete the old monoliths**

```bash
git rm src/editor/completions/sounds.js src/editor/completions/mini-notation.js
```

If `sounds.js` is imported anywhere else (search with `grep -rn "completions/sounds" src/`), update those imports to point at `completions/install.js`. As of pre-flight reading, the only consumer is `main.js`.

- [ ] **Step 4: Boot the dev server and smoke-test**

Run `pnpm dev` and open `http://localhost:5173`. Click the page to enable audio. Verify:

- [ ] Type `s("p` and confirm `piano` is at or near the top.
- [ ] Type `s("gmpw` and confirm `gm_pad_warm` appears in the top 3.
- [ ] Open devtools → check `localStorage` for `strasbeat:completions-recency` after accepting a completion (Enter on a sound name).
- [ ] Type `bank("` and confirm bank names appear.
- [ ] Type `chord("C` and confirm chord symbols appear after the root.
- [ ] Type `note("c4` inside an existing `note(...)` — should show note completions.
- [ ] Bare function call: type `setcp` and confirm `setcpm`, `setcps` appear with rich info panels (boost should bring documented entries to the top).

If any of these fail, do **not** proceed — diagnose via `window.strasbeat.completions` (added in Task 12) or by adding `console.log` inside `combined()` to inspect provider returns.

- [ ] **Step 5: Commit**

```bash
git add src/editor/completions/install.js src/main.js
git commit -m "feat(intellisense): wire new ranker stack, drop old sounds.js monolith"
```

---

## Task 12: Console helpers for debugging

**Files:**
- Modify: `src/debug.js`

Add `window.strasbeat.completions` helpers per spec lines 833-841. Useful for tuning weights live in devtools without rebuilding.

- [ ] **Step 1: Read existing debug.js to find the export shape**

Run: `head -40 src/debug.js`. Note the function signature and the object it returns.

- [ ] **Step 2: Add completion helpers**

Append to `src/debug.js`:

```js
import { score as completionScore } from "./editor/completions/score.js";
import { getBufferTokens } from "./editor/completions/context.js";
import { getInstalledRecency } from "./editor/completions/install.js";
import { rankSounds } from "./editor/completions/providers/sounds.js";
import { soundMap } from "@strudel/webaudio";

// Inside the existing mountDebugHelpers return object, merge in:
//   completions: {
//     score: (q, c) => completionScore(q, c),
//     recency: () => getInstalledRecency()?.snapshot?.() ?? null,
//     bufferTokens: () => getBufferTokens(),
//     rank: (fragment, category) => {
//       if (category !== "sound") {
//         console.warn("[debug] only 'sound' category exposed for now");
//         return [];
//       }
//       const recency = getInstalledRecency();
//       return rankSounds({
//         fragment,
//         buffer: getBufferTokens().get("sound"),
//         recency: recency ?? { score: () => 0, snapshot: () => ({ sound: [] }) },
//         allKeys: Object.keys(soundMap.get()),
//       });
//     },
//   },
```

Edit the actual return statement of `mountDebugHelpers` to include this block. Show the user the diff before committing.

- [ ] **Step 3: Smoke test in devtools**

After `pnpm dev`, in the browser console:

```js
strasbeat.completions.score("gmpw", "gm_pad_warm")
// → { score: ~1.19, matched: [0, 1, 3, 7] }
strasbeat.completions.rank("pian", "sound").slice(0, 3)
// → [{ label: "piano", finalScore: ... }, { label: "gm_piano", ... }, ...]
```

- [ ] **Step 4: Commit**

```bash
git add src/debug.js
git commit -m "feat(intellisense): window.strasbeat.completions debug helpers"
```

---

## Phase 1 acceptance gate

Run through the spec's Phase 1 acceptance criteria (spec lines 354-368) before opening Phase 2. Each line maps to a concrete check:

- `gmpw` returns `gm_pad_warm` in the top 3 for `s("…")` → manual editor test.
- `pian` returns `piano` first, `gm_piano` second → manual + `strasbeat.completions.rank` check.
- A sound used elsewhere ranks above an unused sibling → in a buffer with `s("bd_kick ~")` typed somewhere, type `s("bd"` elsewhere; verify `bd_kick` rises.
- Recency: accept `gm_piano`, reload, type `s("gm` — `gm_piano` should rank above untouched siblings.
- Empty `Ctrl+Space` inside `s("…")` → starter shelf appears.
- Function fallback never outranks contextual category match → inside `s("…")`, fragment that matches both a sound and a function (e.g. `n` matches both `n()` function and `noise` sound) — sound wins because of `+1.0` base vs `+0.0`.
- Unit test suite passes: `pnpm test`.
- Cross-tab recency: open two tabs, accept in one, the other tab's `strasbeat.completions.recency()` updates.

If any criterion fails, fix in place before moving on. Don't carry "follow-up" debt into Phase 2.

---

# Phase 2 — Editor ergonomics

Snippet placeholders, Tab-to-accept, modifier-held audition, ▶ icon.

---

## Task 13: Tab-to-accept binding (with snippet gate)

**Files:**
- Modify: `src/editor/keymap-universal.js`

CM6's `completionKeymap` only binds `Enter` to accept (verified in `node_modules/@codemirror/autocomplete/dist/index.cjs:2060-2070`). We add an explicit Tab binding at `Prec.highest` that gates on "popup open AND no active snippet" — the snippet gate lets CM6's stock `Tab → nextSnippetField` keep working during placeholder navigation.

This binding lives in Layer 2 so it works in every profile. Insert-mode-only firing in Vim/Helix happens automatically (modal forwarders only see Tab in insert mode).

- [ ] **Step 1: Add the Tab binding to keymap-universal.js**

Replace the contents of `src/editor/keymap-universal.js` with:

```js
// Layer-2 always-on CodeMirror keymap. Bindings here are loaded
// unconditionally regardless of which profile (Strudel / VSCode / Vim /
// Emacs / Helix) the user has selected — they are app-shell shortcuts
// that don't conflict with strudel.cc muscle memory because strudel.cc
// doesn't have them.
//
// See design/work/21-keybindings.md §"Mental model" for the layered model
// and design/work/22-intellisense-v2.md §"Editor ergonomics" for the
// completion-related bindings.

import { keymap } from "@codemirror/view";
import {
  acceptCompletion,
  completionStatus,
  hasNextSnippetField,
  moveCompletionSelection,
  currentCompletions,
  selectedCompletionIndex,
} from "@codemirror/autocomplete";

export function createUniversalKeymap({ onEvaluate, onAuditionSelected }) {
  return keymap.of([
    {
      key: "Mod-Enter",
      preventDefault: true,
      run: () => {
        onEvaluate();
        return true;
      },
    },
    {
      key: "Tab",
      run: (view) => {
        if (completionStatus(view.state) !== "active") return false;
        if (hasNextSnippetField(view.state)) return false;
        return acceptCompletion(view);
      },
    },
    {
      key: "Alt-ArrowDown",
      run: (view) => {
        if (completionStatus(view.state) !== "active") return false;
        moveCompletionSelection(true)(view);
        if (onAuditionSelected) onAuditionSelected(view);
        return true;
      },
    },
    {
      key: "Alt-ArrowUp",
      run: (view) => {
        if (completionStatus(view.state) !== "active") return false;
        moveCompletionSelection(false)(view);
        if (onAuditionSelected) onAuditionSelected(view);
        return true;
      },
    },
  ]);
}

/**
 * Read the currently-selected completion's label + type. Returns null if
 * the popup is closed or nothing is selected. Used by audition handlers.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {{ label: string, type: string | undefined } | null}
 */
export function readSelectedCompletion(state) {
  if (completionStatus(state) !== "active") return null;
  const idx = selectedCompletionIndex(state);
  if (idx == null || idx < 0) return null;
  const all = currentCompletions(state);
  const c = all[idx];
  if (!c) return null;
  return { label: c.label, type: c.type };
}
```

- [ ] **Step 2: Thread `onAuditionSelected` through dispatchEditorExtensions**

In `src/editor-setup.js`, modify the `dispatchEditorExtensions` signature and call:

```js
export function dispatchEditorExtensions(editor, { onOpenReference, onAuditionSelected }) {
  // ... existing body ...
  Prec.highest(createUniversalKeymap({ onEvaluate, onAuditionSelected })),
  // ... rest unchanged ...
}
```

- [ ] **Step 3: Wire onAuditionSelected from main.js**

In `src/main.js`, where `dispatchEditorExtensions` is called, pass:

```js
import { readSelectedCompletion } from "./editor/keymap-universal.js";
import { previewSoundName } from "./editor-actions.js";

// ... near where dispatchEditorExtensions is called:
const setStatus = (s) => transport?.setStatus(s);

dispatchEditorExtensions(editor, {
  onOpenReference: (name) => { /* existing */ },
  onAuditionSelected: (view) => {
    const sel = readSelectedCompletion(view.state);
    if (!sel) return;
    if (sel.type !== "sound") return;
    previewSoundName(sel.label, {
      getAudioContext, getSound, superdough, setStatus,
    });
  },
});
```

Order matters: `transport` must be defined before `dispatchEditorExtensions` is called. If it isn't, capture the reference in a closure that reads the variable lazily (`setStatus: (s) => transport?.setStatus(s)` already does this if defined later).

- [ ] **Step 4: Smoke-test Tab and Alt+ArrowDown**

Reload the dev server and try in the editor:

- [ ] Type `s("p` — popup opens. Press Tab — top completion accepted (no longer inserts a literal tab character).
- [ ] Type `s("p` — popup opens. Hold Alt and press ArrowDown — selection moves AND a sound plays.
- [ ] Press Esc to close the popup. Press Tab — should now indent the current line (insert mode default).
- [ ] In Vim profile, switch to NORMAL mode. Press Tab — Vim's default Tab handling kicks in (no popup interference).

If Tab still inserts a literal tab when popup is open, the Prec.highest is missing — confirm `dispatchEditorExtensions` wraps the universal keymap in `Prec.highest`. If audition fires for a function completion, the type filter is wrong — re-check `sel.type === "sound"`.

- [ ] **Step 5: Commit**

```bash
git add src/editor/keymap-universal.js src/editor-setup.js src/main.js
git commit -m "feat(intellisense): tab-to-accept + alt-arrow audition"
```

---

## Task 14: Snippet placeholders for function templates

**Files:**
- Modify: `src/editor/completions/providers/functions.js`

Functions that take a single string literal get a snippet template that drops the cursor inside the quotes. Per spec lines 423-432, the templates list:

| Trigger | Snippet | Cursor lands |
| ------- | ------- | ------------ |
| `s` | `s("${1}")` | inside quotes |
| `sound` | `sound("${1}")` | inside quotes |
| `note` | `note("${1}")` | inside quotes |
| `n` | `n("${1}")` | inside quotes |
| `bank` | `bank("${1}")` | inside quotes |
| `chord` | `chord("${1}")` | inside quotes |
| `stack` | `stack(${1})` | inside parens |
| `setcpm` | `setcpm(${1})` | inside parens |
| `cat` | `cat(${1})` | inside parens |

- [ ] **Step 1: Add the template map and snippet apply to functions.js**

Edit `src/editor/completions/providers/functions.js`:

```js
import { snippet } from "@codemirror/autocomplete";
// ... existing imports ...

const SNIPPET_TEMPLATES = {
  s:       's("${1}")',
  sound:   'sound("${1}")',
  note:    'note("${1}")',
  n:       'n("${1}")',
  bank:    'bank("${1}")',
  chord:   'chord("${1}")',
  stack:   "stack(${1})",
  setcpm:  "setcpm(${1})",
  cat:     "cat(${1})",
};

// In completionFor, add the snippet apply when the label is in the map:
function completionFor(fn, finalScore) {
  const opt = {
    label: fn.label,
    type: "function",
    boost: finalScore,
  };
  const tpl = SNIPPET_TEMPLATES[fn.label];
  if (tpl) opt.apply = snippet(tpl);
  if (fn.entry) {
    if (fn.entry.doc) {
      const first = fn.entry.doc.split(/[.!?]\s/)[0];
      opt.detail = first.length > 60 ? first.slice(0, 57) + "..." : first;
    }
    opt.info = () => renderCompletionInfo(fn.label, fn.entry);
  }
  return opt;
}
```

- [ ] **Step 2: Smoke-test**

Reload. In an empty buffer:

- [ ] Type `s` then Tab — should expand to `s("|")` with cursor between quotes.
- [ ] Type `bd` (cursor was between quotes, so the typing extends `s("bd|")`).
- [ ] Type `stack` then Tab — should expand to `stack(|)` with cursor between parens.

- [ ] **Step 3: Test format-during-snippet edge**

While a snippet is active (cursor in placeholder), press `Cmd+Shift+F` to format. Per spec lines 437-442: the snippet cancels gracefully (markers don't survive the wholesale doc replace), no crash, well-formed output. If it crashes, wrap the format dispatch in a try/catch and log.

- [ ] **Step 4: Commit**

```bash
git add src/editor/completions/providers/functions.js
git commit -m "feat(intellisense): snippet placeholders for s/sound/note/bank/chord/stack/setcpm/cat"
```

---

## Task 15: Auto-trigger on `.`, `(`, `"`, `'`, space-inside-string

**Files:**
- (verification only — Phase 2 auto-trigger is mostly emergent)

Per spec lines 444-465: CM6 `activateOnTyping: true` fires the providers on every word-character keystroke. For non-word triggers (`.`, `(`, `"`, `'`), each provider returns a non-null result when the cursor's preceding character matches and the position is meaningful. The mini-notation provider already returns a result on space-inside-string when `context.explicit` OR a fragment exists — but during normal typing, a typed space triggers a re-fire and the next typed char becomes the fragment. So the only new work is making sure the explicit-trigger ergonomics feel right.

- [ ] **Step 1: Verify current behavior**

In dev server:

- [ ] Inside `s("bd ` (with trailing space, cursor after space), type any letter — popup should appear with sounds.
- [ ] Inside `stack().` (cursor after the dot) — function completions should fire on the next keystroke.
- [ ] Type `s("` (just opened the quote) — should fire on the next char.

If any of these don't work, the provider's regex isn't matching the empty-fragment case correctly. Walk through the provider's `matchBefore` patterns and adjust.

- [ ] **Step 2: Document any gaps in spec language**

If a discovered gap requires a code change, add a small fix and a test fixture. Otherwise commit a no-op confirming verification.

- [ ] **Step 3: Commit (only if changes were needed)**

```bash
git add -p
git commit -m "fix(intellisense): auto-trigger refinements for non-word characters"
```

---

## Task 16: ▶ icon in completion rows

**Files:**
- Modify: `src/editor/completions/providers/sounds.js`
- Modify: `src/editor/completions/providers/mini-notation.js`

For sound-typed completions, `Completion.info` returns a DOM node containing a small ▶ button. Click → `previewSoundName(label)`. The icon is a click-only overlay (`mousedown` + `e.preventDefault()` to avoid blurring the popup).

The audition wiring needs the same ctx the Alt-arrow audition uses. Plumb it through the providers' factory.

- [ ] **Step 1: Extend the providers with an audition ctx**

```js
// providers/sounds.js
export function soundsProvider({ recency, audition }) {
  // ... in the rank() function, when building options:
  return {
    from, to, filter: false,
    options: ranked.map((r) => ({
      label: r.label,
      type: "sound",
      detail: r.bank,
      boost: r.finalScore,
      info: audition ? () => buildAuditionInfo(r.label, audition) : undefined,
    })),
  };
}

function buildAuditionInfo(label, audition) {
  const wrap = document.createElement("div");
  wrap.className = "completion-info-audition";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "completion-info-audition__btn";
  btn.setAttribute("aria-label", `Preview ${label}`);
  btn.title = "Preview sound";
  btn.textContent = "▶";
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault(); // don't blur the popup
    audition(label);
  });
  wrap.appendChild(btn);
  const meta = document.createElement("div");
  meta.className = "completion-info-audition__meta";
  meta.textContent = label;
  wrap.appendChild(meta);
  return wrap;
}
```

Apply the same `info: audition ? () => buildAuditionInfo(r.label, audition) : undefined` shape to `mini-notation.js`'s sound options. Extract `buildAuditionInfo` into the existing `src/editor/completions/info.js` so both providers share the helper.

- [ ] **Step 2: Plumb the audition callback through install.js → main.js**

In `src/editor/completions/install.js`:

```js
export function installCompletions(view, liveExports, { audition } = {}) {
  // ...
  const providers = [
    miniNotationProvider({ recency, audition }),
    soundsProvider({ recency, audition }),
    // ... others (no audition needed)
  ];
  // ...
}
```

In `src/main.js`, where `installCompletions` is called:

```js
installCompletions(editor.editor, [...], {
  audition: (name) => previewSoundName(name, {
    getAudioContext, getSound, superdough,
    setStatus: (s) => transport?.setStatus(s),
  }),
});
```

- [ ] **Step 3: Add a small CSS rule for the audition button**

Append to `src/styles/autocomplete.css` (find the file path with `find src/styles -name "*.css"`):

```css
.completion-info-audition {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
}
.completion-info-audition__btn {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  font-size: var(--text-md);
}
.completion-info-audition__btn:hover {
  background: var(--surface-3);
}
.completion-info-audition__meta {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
```

If `src/styles/autocomplete.css` doesn't exist, search `src/styles/` for the file that already styles `.autocomplete-info-*` and append there. The exact selectors and tokens may need to match the existing design-system pattern — confirm against `design/SYSTEM.md` and follow `impeccable` if visuals are off.

- [ ] **Step 4: Smoke-test**

Reload. Inside `s("p` — verify:
- The info panel shows beside the popup with ▶ and the sound name.
- Click ▶ — sound plays, popup stays open.
- Function completions still get the rich docs panel (different shape, both render via `info`).

- [ ] **Step 5: Commit**

```bash
git add src/editor/completions/info.js src/editor/completions/install.js src/editor/completions/providers/sounds.js src/editor/completions/providers/mini-notation.js src/main.js src/styles/autocomplete.css
git commit -m "feat(intellisense): audition button in sound completion info panel"
```

---

## Phase 2 acceptance gate

Walk the spec's Phase 2 acceptance (lines 562-577):

- Tab accepts when popup open; falls through to indent / Vim default when closed → manual.
- `s` + Tab inserts `s("|")` with cursor inside quotes → manual.
- Auto-trigger fires on `.`, `(`, `"`, `'`, space inside known mini-notation literals → manual.
- `Alt+↓` moves selection AND auditions sound → manual.
- `Alt+↓` on non-audible completion moves selection silently → manual (try inside a function-name completion).
- ▶ click previews without closing the popup → manual.
- All five profiles produce same popup behavior in insert mode → switch profile via the chip, repeat the smoke tests.
- Vim normal-mode `j`/`k` does not fire popup → switch to Vim, press Esc, press `j` → no popup.
- Format-during-snippet doesn't crash → manual.

---

# Phase 3 — Sample/bank coherence

Variant completion `s("bd:N")`, bank-aware ranking, `Cmd+Shift+B` reveal.

---

## Task 17: Colon-aware tokenizer + tests

**Files:**
- Modify: `src/editor/mini-notation-tokens.js`
- Create: `src/editor/mini-notation-tokens.test.js`

The tokenizer's `tokenAtOffset` currently treats `:` as a separator (correct — splits `bd:2` into two tokens). Phase 3.A needs to know whether the cursor's token is "after a colon" so the provider can pivot to numeric variant completion. Add a `prevSeparator` field to the return shape.

- [ ] **Step 1: Write failing tests**

```js
// src/editor/mini-notation-tokens.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { tokenAtOffset, miniContext } from "./mini-notation-tokens.js";

describe("tokenAtOffset", () => {
  test("returns null for empty string", () => {
    assert.equal(tokenAtOffset("", 0), null);
  });

  test("identifies token at cursor", () => {
    const r = tokenAtOffset("bd sd hh", 1);
    assert.deepEqual(r, { token: "bd", from: 0, to: 2, prevSeparator: null });
  });

  test("returns null at separator", () => {
    assert.equal(tokenAtOffset("bd sd", 2), null);
  });

  test("prevSeparator is ':' when cursor is in token after a colon", () => {
    // "bd:2" with cursor after the colon (at position 3, on "2")
    const r = tokenAtOffset("bd:2", 3);
    assert.equal(r.token, "2");
    assert.equal(r.prevSeparator, ":");
  });

  test("prevSeparator is null when cursor is in first token", () => {
    const r = tokenAtOffset("bd:2", 1);
    assert.equal(r.token, "bd");
    assert.equal(r.prevSeparator, null);
  });

  test("prevSeparator is ':' for empty fragment after colon", () => {
    // "bd:" with cursor at end (position 3)
    const r = tokenAtOffset("bd:", 3);
    // No token (cursor at separator end), but the spec wants this to
    // return a special "empty fragment after colon" signal so the
    // provider can offer variants. Encoding: prevSeparator: ':' with
    // token: '', from: 3, to: 3.
    assert.deepEqual(r, { token: "", from: 3, to: 3, prevSeparator: ":" });
  });

  test("prevSeparator is null at empty separator (e.g. trailing space)", () => {
    // "bd " with cursor at end (position 3) — same as bare empty cursor
    assert.equal(tokenAtOffset("bd ", 3), null);
  });
});

describe("miniContext", () => {
  test("recognises s/sound as sound context", () => {
    assert.equal(miniContext("s"), "sound");
    assert.equal(miniContext("sound"), "sound");
  });
  test("recognises note/n as note context", () => {
    assert.equal(miniContext("note"), "note");
    assert.equal(miniContext("n"), "note");
  });
  test("everything else is other", () => {
    assert.equal(miniContext("chord"), "other");
    assert.equal(miniContext("xyz"), "other");
  });
});
```

- [ ] **Step 2: Register the test in package.json**

Append `src/editor/mini-notation-tokens.test.js` to the test script.

- [ ] **Step 3: Run tests to confirm failure**

Run: `pnpm test 2>&1 | grep -E "tokenAtOffset|fail|pass" | tail -15`
Expected: most tests fail (existing return shape lacks `prevSeparator`).

- [ ] **Step 4: Update tokenAtOffset**

Replace the existing function in `src/editor/mini-notation-tokens.js`:

```js
export function tokenAtOffset(text, offset) {
  if (text == null || offset < 0 || offset > text.length) return null;
  const SEP = /[\s[\]<>{},|!@?*/:~]/;

  // Special: empty fragment after a colon — surface for variant completion.
  // (cursor sits immediately after a `:` with no following token char yet.)
  if (offset > 0 && text[offset - 1] === ":") {
    const charAt = text[offset];
    if (charAt === undefined || SEP.test(charAt)) {
      return { token: "", from: offset, to: offset, prevSeparator: ":" };
    }
  }

  let from = offset;
  while (from > 0 && !SEP.test(text[from - 1])) from--;

  let to = offset;
  while (to < text.length && !SEP.test(text[to])) to++;

  if (from === to) return null;

  const prevSeparator = from > 0 && text[from - 1] === ":" ? ":" : null;
  return { token: text.slice(from, to), from, to, prevSeparator };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test 2>&1 | grep -E "tokenAtOffset|fail|pass" | tail -15`
Expected: all tokenAtOffset tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/editor/mini-notation-tokens.js src/editor/mini-notation-tokens.test.js package.json
git commit -m "feat(intellisense): colon-aware mini-notation tokenizer"
```

---

## Task 18: Variant completion (Phase 3.A)

**Files:**
- Modify: `src/editor/completions/providers/mini-notation.js`
- Modify: `src/editor-actions.js` — extend `previewSoundName` with optional `n`

Per spec lines 593-632:

- After a `:` inside `s("…")` mini-notation, walk back to find the prior token (the sound name).
- Apply bank context if any (Phase 3.B). Phase 3.A treats bank as "if a sibling `bank()` is in scope", but the bank-detection algorithm doesn't land until Task 19 — so Phase 3.A initially uses the bare token name and a TODO. We'll re-wire when Task 19 lands.
- Read `data.samples` from the resolved soundMap entry.
- Array form → emit numeric variants `0..n-1` with detail showing the sample filename.
- Object form (chromatic soundfont) → emit nothing.
- Each variant auditionable via Alt+arrow with the correct `n` value.

- [ ] **Step 1: Extend previewSoundName**

```js
// src/editor-actions.js — change signature
export async function previewSoundName(name, ctx, opts = {}) {
  // ... existing body ...
  const value = {
    s: name,
    note: 60,
    gain: 0.8,
    attack: 0.005,
    decay: 0.4,
    sustain: 0,
    release: 0.3,
  };
  if (opts.n != null) value.n = opts.n;
  if (opts.bank) value.bank = opts.bank;
  // ... rest unchanged
}
```

- [ ] **Step 2: Add variant completion to mini-notation provider**

In `src/editor/completions/providers/mini-notation.js`, after the `findMiniContext` block, before the sound branch:

```js
// Variant fragment (after a colon) — emit numeric variants of the prior
// sound. Bank-context resolution lands in Task 19.
if (kind === "sound" && tok && tok.prevSeparator === ":") {
  const variants = computeVariants({
    content: ctx.content,
    tokFrom: tok.from,
    fragment: tok.token,
    bankInScope: null, // wired in Task 19
    audition,
  });
  if (variants) return {
    from: ctx.contentFrom + tok.from,
    to: ctx.contentFrom + tok.to,
    filter: false,
    options: variants,
  };
}
```

Then implement `computeVariants`:

```js
function computeVariants({ content, tokFrom, fragment, bankInScope, audition }) {
  // Walk back from the colon to find the prior token (the sound name).
  let i = tokFrom - 1;
  if (i < 0 || content[i] !== ":") return null;
  i--;
  const SEP = /[\s[\]<>{},|!@?*/:~]/;
  let priorEnd = i + 1;
  while (i >= 0 && !SEP.test(content[i])) i--;
  const priorStart = i + 1;
  const priorToken = content.slice(priorStart, priorEnd);
  if (!priorToken) return null;

  const resolvedName = bankInScope ? `${bankInScope}_${priorToken}` : priorToken;
  const entry = soundMap.get()[resolvedName.toLowerCase()];
  if (!entry || !entry.data) return null;
  const samples = entry.data.samples;
  if (!Array.isArray(samples)) return null;  // skip object form (chromatic)

  const lowFrag = fragment.toLowerCase();
  const out = [];
  for (let n = 0; n < samples.length; n++) {
    const label = String(n);
    if (lowFrag && !label.startsWith(lowFrag)) continue;
    const fileName = describeSample(samples[n]);
    out.push({
      label,
      type: "constant",
      detail: fileName,
      apply: label,
      info: audition ? () => buildVariantInfo(resolvedName, n, audition, bankInScope) : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

function describeSample(sample) {
  if (typeof sample === "string") {
    const slash = sample.lastIndexOf("/");
    return slash >= 0 ? sample.slice(slash + 1) : sample;
  }
  return "";
}

function buildVariantInfo(resolvedName, n, audition, bank) {
  const wrap = document.createElement("div");
  wrap.className = "completion-info-audition";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "completion-info-audition__btn";
  btn.textContent = "▶";
  btn.title = `Preview ${resolvedName}:${n}`;
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    audition(resolvedName, { n, bank });
  });
  wrap.appendChild(btn);
  return wrap;
}
```

Update the `audition` callback in `src/main.js` to forward the optional `n`/`bank`:

```js
audition: (name, opts) => previewSoundName(name, {
  getAudioContext, getSound, superdough,
  setStatus: (s) => transport?.setStatus(s),
}, opts),
```

Also update the audition call in `src/editor/completions/info.js`'s `buildAuditionInfo` (Task 16) to call `audition(label, {})` so the signature is consistent.

- [ ] **Step 3: Update onAuditionSelected to pass n through**

Variants need their `n` value when Alt+ArrowDown auditions. Extend `readSelectedCompletion` in `src/editor/keymap-universal.js` to surface the completion's full object so callers can inspect properties beyond label/type. For variant completions, we need to pull `n` from the label (it's a numeric string). In `main.js`'s `onAuditionSelected`:

```js
onAuditionSelected: (view) => {
  const sel = readSelectedCompletion(view.state);
  if (!sel) return;
  if (sel.type === "sound") {
    audition(sel.label);
    return;
  }
  if (sel.type === "constant" && /^\d+$/.test(sel.label)) {
    // Variant — but we don't know which sound's variant from the type alone.
    // For now, the audition is best-effort: skip unless we can reliably
    // resolve. The ▶ icon in the info panel handles the variant audition
    // path correctly.
    return;
  }
},
```

Document this as a known limitation in a comment. The ▶ icon path works correctly because it captures `resolvedName` + `n` at completion-build time.

- [ ] **Step 4: Smoke test**

Reload. Find a sample bank with array-form variants — try `bd:` inside `s("bd:|")`:

- Popup shows variants `0`, `1`, `2`, ... with the sample filename in `detail`.
- Click ▶ on any variant — that exact variant plays.
- An object-form sound (`gm_piano`) inside `s("gm_piano:` shows nothing (no variant completion).

Use `strasbeat.findSounds('bd')` in devtools to find a name with multiple samples (e.g. `808bd` has many).

- [ ] **Step 5: Commit**

```bash
git add src/editor/completions/providers/mini-notation.js src/editor-actions.js src/editor/keymap-universal.js src/main.js
git commit -m "feat(intellisense): sample-variant completion s(\"bd:N\") with audition"
```

---

## Task 19: Bank-aware ranking (Phase 3.B)

**Files:**
- Modify: `src/editor/completions/providers/mini-notation.js`
- Modify: `src/editor/completions/providers/sounds.js`

Per spec lines 634-705: when the cursor's `s("…")` literal is part of a chain containing a `bank("X")` call, the sounds provider re-scores prefix-matched candidates against their suffix and adds an in-bank boost. Display the short suffix as label, the resolved full name as detail, insert the short suffix on accept.

- [ ] **Step 1: Extract `findBankInScope` from the syntax tree**

Add to `src/editor/completions/providers/mini-notation.js`:

```js
/**
 * Walk the chain containing the given String node to find the most recent
 * (rightmost) bank("X") call. Returns the bank name or null.
 *
 * Per spec §3.B detection algorithm: walk both directions of the
 * MemberExpression chain and inspect each CallExpression's callee.
 */
function findBankInScope(state, stringNode) {
  // Find the CallExpression that contains this String.
  let call = stringNode.parent;
  while (call && call.name !== "CallExpression") call = call.parent;
  if (!call) return null;

  const banks = [];

  // Walk DOWN the callee chain.
  let cur = call;
  while (cur && cur.name === "CallExpression") {
    const callee = cur.firstChild;
    if (!callee) break;
    if (callee.name === "VariableName" || callee.name === "Identifier") {
      const name = state.sliceDoc(callee.from, callee.to);
      if (name === "bank") {
        const arg = readFirstStringArg(state, cur);
        if (arg) banks.push({ name: arg, pos: cur.from });
      }
      break;
    }
    if (callee.name === "MemberExpression" || callee.name === "MemberAccess") {
      // The member's first child is the prior CallExpression.
      const prop = callee.lastChild;
      if (prop) {
        const propName = state.sliceDoc(prop.from, prop.to).replace(/^\./, "");
        if (propName === "bank") {
          const arg = readFirstStringArg(state, cur);
          if (arg) banks.push({ name: arg, pos: cur.from });
        }
      }
      cur = callee.firstChild;
    } else {
      break;
    }
  }

  // Walk UP from the s() call.
  let parent = call.parent;
  while (parent) {
    if (parent.name === "MemberExpression" || parent.name === "MemberAccess") {
      const prop = parent.lastChild;
      const propName = prop ? state.sliceDoc(prop.from, prop.to).replace(/^\./, "") : "";
      const callParent = parent.parent;
      if (callParent && callParent.name === "CallExpression" && propName === "bank") {
        const arg = readFirstStringArg(state, callParent);
        if (arg) banks.push({ name: arg, pos: callParent.from });
      }
      parent = callParent ? callParent.parent : null;
      continue;
    }
    break;
  }

  if (banks.length === 0) return null;
  banks.sort((a, b) => b.pos - a.pos);
  return banks[0].name;
}

function readFirstStringArg(state, callNode) {
  for (let c = callNode.firstChild; c; c = c.nextSibling) {
    if (c.name === "ArgList" || c.name === "ArgumentList") {
      const first = c.firstChild?.nextSibling; // skip "("
      if (!first) return null;
      // first might be String / TemplateString
      if (first.name === "String" || first.name === "TemplateString") {
        const raw = state.sliceDoc(first.from, first.to);
        if ((raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`")) && raw.length >= 2) {
          return raw.slice(1, -1);
        }
      }
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 2: Wire findBankInScope into the sound branch**

Replace the sound branch in `miniNotationProvider`:

```js
if (kind === "sound" && tok && tok.prevSeparator === ":") {
  const bankInScope = findBankInScopeForCursor(context.state, context.pos);
  const variants = computeVariants({
    content: ctx.content,
    tokFrom: tok.from,
    fragment: tok.token,
    bankInScope,
    audition,
  });
  // ... unchanged
}

if (kind === "sound") {
  const bankInScope = findBankInScopeForCursor(context.state, context.pos);
  const buffer = getBufferTokens().get("sound");
  const ranked = rankSounds({
    fragment,
    buffer,
    recency,
    allKeys: getSoundKeys(),
    bankInScope,
  });
  if (ranked.length === 0) return null;
  return {
    from, to, filter: false,
    options: ranked.map((r) => ({
      label: r.label,
      detail: r.detail,
      apply: r.apply,
      type: "sound",
      boost: r.finalScore,
      info: audition ? () => buildAuditionInfo(r.apply ?? r.label, audition, { bank: bankInScope }) : undefined,
    })),
  };
}
```

Add the helper that finds the enclosing String node first, then calls `findBankInScope`:

```js
function findBankInScopeForCursor(state, pos) {
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name === "String" || cur.name === "TemplateString") {
      return findBankInScope(state, cur);
    }
  }
  return null;
}
```

- [ ] **Step 3: Extend rankSounds with bank scoring**

In `src/editor/completions/providers/sounds.js`, modify `rankSounds`:

```js
const IN_BANK_BOOST = 0.2;

export function rankSounds({ fragment, buffer, recency, allKeys, bankInScope = null }) {
  if (!fragment) {
    return rankStarterShelf({ buffer, recency, allKeys });
  }
  const out = [];
  const bankPrefix_ = bankInScope ? `${bankInScope}_`.toLowerCase() : null;

  for (const name of allKeys) {
    let scoreTarget = name;
    let inBank = false;
    let displayLabel = name;
    let displayDetail = bankPrefix(name);
    let applyText = name;

    if (bankPrefix_ && name.toLowerCase().startsWith(bankPrefix_)) {
      const suffix = name.slice(bankInScope.length + 1);
      scoreTarget = suffix;
      inBank = true;
      displayLabel = suffix;
      displayDetail = name;
      applyText = suffix;
    }

    const m = score(fragment, scoreTarget);
    if (!m) continue;
    const finalScore =
      m.score +
      (buffer.has(name) ? BUFFER_BOOST : 0) +
      recency.score("sound", name) +
      (inBank ? IN_BANK_BOOST : 0) +
      CATEGORY_BASE;
    out.push({ label: displayLabel, detail: displayDetail, apply: applyText, finalScore, bank: bankPrefix(name) });
  }
  out.sort((a, b) => b.finalScore - a.finalScore);
  return out.slice(0, MAX_RESULTS);
}
```

The function signature now returns objects with `{ label, detail, apply, finalScore, bank }`. Update existing tests in `providers/sounds.test.js` that destructure `r.label` only — the smoke tests just need `r.label` and the ranking shape, which still works.

Add a new test to `providers/sounds.test.js`:

```js
test("bank-in-scope: bank candidate scored by suffix wins with in-bank boost", () => {
  const ranked = rankSounds({
    fragment: "bd",
    buffer: NO_BUFFER,
    recency: NO_RECENCY,
    allKeys: ["RolandTR909_bd", "bd_kick", "808bd_kick"],
    bankInScope: "RolandTR909",
  });
  assert.equal(ranked[0].label, "bd", "label should be short suffix");
  assert.equal(ranked[0].detail, "RolandTR909_bd", "detail should be resolved name");
  assert.equal(ranked[0].apply, "bd", "apply should be short suffix");
});

test("bank-in-scope: out-of-bank candidates still appear, just below in-bank ones", () => {
  const ranked = rankSounds({
    fragment: "bd",
    buffer: NO_BUFFER,
    recency: NO_RECENCY,
    allKeys: ["RolandTR909_bd", "bd_kick"],
    bankInScope: "RolandTR909",
  });
  const labels = ranked.map((r) => r.label);
  assert.ok(labels.includes("bd_kick"), "out-of-bank still listed");
  assert.equal(labels[0], "bd", "in-bank wins top slot");
});

test("bank-in-scope: typo'd bank produces no in-bank boost (graceful fallback)", () => {
  const ranked = rankSounds({
    fragment: "bd",
    buffer: NO_BUFFER,
    recency: NO_RECENCY,
    allKeys: ["bd_kick", "808bd_kick"],
    bankInScope: "Typo909",
  });
  assert.ok(ranked.length > 0, "still returns matches");
  assert.equal(ranked[0].label, "bd_kick", "ranking unchanged from no-bank case");
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm test 2>&1 | grep -E "rankSounds|bank-in-scope|fail|pass" | tail -20`
Expected: all rank tests pass, including the three new bank-aware ones.

- [ ] **Step 5: Smoke-test bank context end-to-end**

Reload. In a new pattern:

```js
bank("RolandTR909").s("|")
```

Type `bd` after the `s("`:
- Top result label is `bd`, detail is `RolandTR909_bd`.
- Accept (Enter) → buffer becomes `bank("RolandTR909").s("bd")` (short suffix inserted).

Move to the form with bank suffixed (`s("…").bank("X")`):

```js
s("|").bank("RolandTR909")
```

Type `bd` — same behavior (top is `bd` with detail `RolandTR909_bd`).

Two banks in stack siblings:

```js
stack(
  bank("RolandTR909").s("|"),
  bank("tr808").s("|"),
)
```

Each chain's `s("|")` should resolve to its own bank's siblings — the detection walks the local chain only.

- [ ] **Step 6: Commit**

```bash
git add src/editor/completions/providers/mini-notation.js src/editor/completions/providers/sounds.js src/editor/completions/providers/sounds.test.js
git commit -m "feat(intellisense): bank-aware ranking with suffix scoring"
```

---

## Task 20: Reveal-in-browser (`Cmd+Shift+B`)

**Files:**
- Modify: `src/editor/keymap-universal.js`
- Modify: `src/ui/sound-browser.js` — add `focusSound(name)`
- Modify: `src/main.js` — listen for `strasbeat:reveal-sound` custom event
- Modify: `src/command-palette-actions.js` + `src/ui/command-palette.js` — palette entry

Per spec lines 706-748.

- [ ] **Step 1: Add focusSound to sound browser**

In `src/ui/sound-browser.js`:

```js
return {
  id: "sounds",
  icon: "music",
  label: "Sound browser",
  create, activate, deactivate,
  refresh, setBufferText,
  focusSound,    // NEW
};

function focusSound(name) {
  if (!mounted) return;
  const sound = allSounds.find((s) => s.name === name);
  if (!sound) {
    console.warn(`[sound-browser] focusSound: "${name}" not in allSounds`);
    return;
  }
  if (sound.kit && collapsedGroups.has(sound.kit)) {
    collapsedGroups.delete(sound.kit);
    render();
  }
  activeIndex = flatVisible.findIndex((s) => s.name === name);
  paintActive();
}
```

Surface `focusSound` from the `registerPanels` return so `main.js` can call it. Find the `panels.js` `registerPanels` function — it already returns `soundBrowser` (the panel object). The new method on the panel object means `soundBrowser.focusSound(name)` just works.

- [ ] **Step 2: Add the keybinding**

Extend `createUniversalKeymap` to accept `onRevealSound` and add the binding:

```js
export function createUniversalKeymap({ onEvaluate, onAuditionSelected, onRevealSound }) {
  return keymap.of([
    // ... existing bindings ...
    {
      key: "Mod-Shift-b",
      preventDefault: true,
      run: (view) => {
        if (!onRevealSound) return false;
        const name = resolveSoundUnderCursor(view.state);
        if (name) onRevealSound(name);
        return true;
      },
    },
  ]);
}

function resolveSoundUnderCursor(state) {
  const pos = state.selection.main.head;
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);

  // Inside a String? Use mini-notation tokenizer to find the token, apply
  // bank context if any.
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name === "String" || cur.name === "TemplateString") {
      const raw = state.sliceDoc(cur.from, cur.to);
      if (!(raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`"))) continue;
      const contentFrom = cur.from + 1;
      const contentTo = cur.to - 1;
      if (pos < contentFrom || pos > contentTo) continue;
      const content = state.sliceDoc(contentFrom, contentTo);
      const tok = tokenAtOffset(content, pos - contentFrom);
      if (!tok) return null;
      const bank = findBankInScope(state, cur); // see Task 19
      const candidate = bank ? `${bank}_${tok.token}` : tok.token;
      const all = soundMap.get();
      if (all[candidate.toLowerCase()]) return candidate;
      if (all[tok.token.toLowerCase()]) return tok.token;
      return null;
    }
  }

  // Bare identifier check.
  if (node.name === "VariableName" || node.name === "Identifier") {
    const text = state.sliceDoc(node.from, node.to);
    if (soundMap.get()[text.toLowerCase()]) return text;
  }
  return null;
}
```

You'll need to import `syntaxTree`, `tokenAtOffset`, `findBankInScope`, and `soundMap` here. `findBankInScope` was defined in Task 19 in `providers/mini-notation.js` — promote it to a shared helper file `src/editor/completions/bank-detect.js` and re-export from both call sites:

```js
// src/editor/completions/bank-detect.js
// (extract findBankInScope and readFirstStringArg from providers/mini-notation.js)
```

Update `providers/mini-notation.js` to import from `../bank-detect.js` (note the path: `bank-detect.js` lives under `src/editor/completions/`, so the import from `keymap-universal.js` is `./completions/bank-detect.js`).

- [ ] **Step 3: Listen for the reveal event in main.js**

In `src/main.js`, the `dispatchEditorExtensions` call on line ~262 runs BEFORE `rightRail` and `soundBrowser` are defined (~line 467+). The existing `onOpenReference` callback works because it's a closure body that runs *later* when called — by then the variables are bound. Mirror that pattern:

```js
dispatchEditorExtensions(editor, {
  onOpenReference: (name) => {
    if (!referencePanel) return;
    rightRail.activate("reference");
    referencePanel.scrollTo(name);
  },
  onAuditionSelected: (view) => {
    /* defined in Task 13 */
  },
  onRevealSound: (name) => {
    // rightRail and soundBrowser are declared later in main.js — this
    // closure reads them lazily at call time, same pattern as
    // onOpenReference above.
    if (!soundBrowser) return;
    rightRail.activate("sounds");
    soundBrowser.focusSound(name);
  },
});
```

No reorder needed — the closures don't run during `dispatchEditorExtensions` itself, only when the user fires the binding.

- [ ] **Step 4: Add command palette entry**

In `src/command-palette-actions.js`, extend `buildPaletteCommands` with:

```js
onRevealSound: () => {
  document.dispatchEvent(new CustomEvent("strasbeat:reveal-sound-from-palette"));
},
```

In `main.js`, add:

```js
document.addEventListener("strasbeat:reveal-sound-from-palette", () => {
  // The palette doesn't know the cursor — it just opens the browser.
  rightRail.activate("sounds");
});
```

In `src/ui/command-palette.js`, add a new command in `buildCommands` (find the existing pattern for similar entries):

```js
{
  id: "reveal-sound",
  label: "Reveal sound in browser",
  group: "View",
  key: "Mod-Shift-B",
  run: () => onRevealSound(),
},
```

- [ ] **Step 5: Smoke-test**

Reload. Open a pattern with a sound name. Place cursor on it. Press `Cmd+Shift+B`:
- Right rail opens to Sound browser.
- The sound is highlighted (green dot / `is-active` class), kit group expanded if collapsed.
- Press `↓` then `Enter` — swaps to the next sibling sound (`insertSoundName` runs).

Then test from the palette:
- `Cmd+Shift+P` → "Reveal sound in browser" → opens the panel.

- [ ] **Step 6: Commit**

```bash
git add src/editor/keymap-universal.js src/editor/completions/bank-detect.js src/editor/completions/providers/mini-notation.js src/ui/sound-browser.js src/main.js src/command-palette-actions.js src/ui/command-palette.js
git commit -m "feat(intellisense): Cmd+Shift+B reveal sound in browser"
```

---

## Phase 3 acceptance gate

Walk spec lines 749-766:

- `s("bd:")` shows numeric variants with sample-filename detail → manual.
- Each variant auditionable via Alt+↓ — partial: ▶ icon path is reliable; Alt+↓ on a variant is a known limitation, documented.
- Object-form sounds emit no variant completions → `s("gm_piano:` shows nothing.
- `bank("RolandTR909").s("…")` shows short suffixes at top with resolved-name detail → manual.
- Accept inserts short suffix → manual.
- Suffix bank (`s("…").bank("X")`) works the same → manual.
- Typo'd bank gracefully falls back → manual + unit test.
- Sibling chains in `stack(...)` have independent bank scope → manual fixture.
- `Cmd+Shift+B` reveals sound + highlight → manual.
- Palette entry shows the shortcut → manual.
- Round-trip swap works → manual.

---

# Phase 4 — Nice-to-haves

Lowest priority. Each sub-task is independent — implement them in any order, drop any that aren't worth the code.

---

## Task 21: 4.A — Drag-from-browser → editor

**Files:**
- Modify: `src/ui/sound-browser.js`
- Modify: `src/main.js` (CodeMirror DOM drop listener)

Per spec lines 769-779. ~40 lines.

- [ ] **Step 1: Make sound rows draggable**

In `src/ui/sound-browser.js`'s `buildSoundItem`:

```js
item.draggable = true;
item.addEventListener("dragstart", (e) => {
  e.dataTransfer.setData("text/x-strasbeat-sound", sound.name);
  e.dataTransfer.effectAllowed = "copyLink";
});
```

- [ ] **Step 2: Listen for drop on the editor DOM**

In `src/main.js`:

```js
import { insertSoundName } from "./editor-actions.js";

editorRoot.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("text/x-strasbeat-sound")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
});
editorRoot.addEventListener("drop", (e) => {
  const name = e.dataTransfer.getData("text/x-strasbeat-sound");
  if (!name) return;
  e.preventDefault();
  // Insert at the editor cursor (or replace the cursor's `s("…")` literal).
  insertSoundName(name, editor.editor);
});
```

This listener is in addition to the existing MIDI file dragover/drop listeners — the conditional on `text/x-strasbeat-sound` keeps them independent. The MIDI listener should only fire when `Files` is in `dataTransfer.types`.

- [ ] **Step 3: Smoke-test**

Reload. Drag a sound row from the browser → drop into the editor. Verify a `s("name")` is inserted (or the cursor's existing literal updated, per `insertSoundName`'s context detection).

- [ ] **Step 4: Commit**

```bash
git add src/ui/sound-browser.js src/main.js
git commit -m "feat(intellisense): drag sounds from browser into editor"
```

---

## Task 22: 4.B — Bank chip in transport

**Files:**
- Modify: `src/ui/transport.js`
- Modify: `src/main.js` (wire bufferTokens → chip update)

Per spec lines 781-787.

- [ ] **Step 1: Add a bank chip element**

In `src/ui/transport.js`, in the constructor section near `errorBadgeEl`:

```js
const bankChipEl = document.createElement("button");
bankChipEl.type = "button";
bankChipEl.className = "transport__bank-chip";
bankChipEl.hidden = true;
bankChipEl.addEventListener("click", () => onBankChipClick?.(bankChipEl.dataset.bank));
rightGroupEl.insertBefore(bankChipEl, midiPillEl);
```

Accept `onBankChipClick` in the `mountTransport` signature; expose `setBank(name)` from the returned object:

```js
function setBank(name) {
  if (!name) {
    bankChipEl.hidden = true;
    bankChipEl.removeAttribute("data-bank");
    return;
  }
  bankChipEl.hidden = false;
  bankChipEl.dataset.bank = name;
  bankChipEl.textContent = name;
  bankChipEl.title = `Active bank: ${name} — click to filter Sound browser`;
}

return { kick, setStatus, setMidiStatus, setPlaybackState, setErrorState, clearErrorState, keymapChip, setBank, dispose };
```

- [ ] **Step 2: Wire bufferTokens → chip update from main.js**

Don't depend on the buffer-context plugin's debounce — read banks directly with a small regex on doc-change. Cheap (~2KB buffer × tens of regex finds) and avoids race conditions with the plugin's internal debounce.

```js
const BANK_DETECT_RE = /\bbank\(\s*['"]([^'"]+)['"]/g;

let bankUpdateTimer = null;
editor.editor.dispatch({
  effects: StateEffect.appendConfig.of([
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (bankUpdateTimer) clearTimeout(bankUpdateTimer);
      bankUpdateTimer = setTimeout(() => {
        bankUpdateTimer = null;
        const text = update.view.state.doc.toString();
        BANK_DETECT_RE.lastIndex = 0;
        let m, last = null;
        while ((m = BANK_DETECT_RE.exec(text)) !== null) last = m[1];
        transport?.setBank(last ?? null);
      }, 200);
    }),
  ]),
});
```

The "most recently edited" bank rule from the spec is approximated by "last in source order" — close enough; tracking actual edit recency would need per-bank position memory and isn't worth the code.

Pass the click handler to `mountTransport`:

```js
transport = mountTransport({
  // ... existing options ...
  onBankChipClick: (name) => {
    rightRail.activate("sounds");
    // Pre-fill search field (use the existing focus + selectAll path).
    if (soundBrowser?.focusSound) {
      // No specific sound to focus — just open and pre-filter.
      // Sound browser's `setBufferText` doesn't filter; instead, dispatch
      // into the panel's search input (find via DOM query on the panel root).
      const searchInput = document.querySelector(".sound-browser__search-input");
      if (searchInput) {
        searchInput.value = name;
        searchInput.dispatchEvent(new Event("input"));
      }
    }
  },
});
```

- [ ] **Step 3: Style the chip**

Append to `src/styles/transport.css` (or wherever the keymap chip is styled — match its pattern):

```css
.transport__bank-chip {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-muted);
  cursor: pointer;
}
.transport__bank-chip:hover {
  background: var(--surface-3);
  color: var(--text);
}
```

If visual results aren't right, defer styling to `polish` per CLAUDE.md aesthetics rule.

- [ ] **Step 4: Smoke-test**

Open a pattern containing `bank("RolandTR909").s("…")`. Verify:
- Chip appears in transport with text "RolandTR909".
- Click the chip → Sound browser opens, search field pre-filled with "RolandTR909".

- [ ] **Step 5: Commit**

```bash
git add src/ui/transport.js src/main.js src/styles/transport.css
git commit -m "feat(intellisense): bank chip in transport bar"
```

---

## Task 23: 4.C — Cmd+J focus browser with token

**Files:**
- Modify: `src/editor/keymap-universal.js`
- Modify: `src/main.js`
- Modify: `src/ui/sound-browser.js` (add `focusSearch(prefilledQuery)`)

Per spec lines 789-798.

- [ ] **Step 1: Add focusSearch to sound browser**

In `src/ui/sound-browser.js`:

```js
return {
  // ... existing surface ...
  focusSearch,    // NEW
};

function focusSearch(prefilledQuery = "") {
  if (!mounted) return;
  if (searchInput) {
    searchInput.value = prefilledQuery;
    searchInput.focus();
    searchInput.select();
    if (prefilledQuery) searchInput.dispatchEvent(new Event("input"));
  }
}
```

- [ ] **Step 2: Add Cmd+J binding**

In `src/editor/keymap-universal.js`, extend the keymap (similar shape to `Mod-Shift-b`):

```js
{
  key: "Mod-j",
  preventDefault: true,
  run: (view) => {
    if (!onFocusBrowser) return false;
    const word = readWordUnderCursor(view.state);
    onFocusBrowser(word ?? "");
    return true;
  },
},
```

Add `readWordUnderCursor`:

```js
function readWordUnderCursor(state) {
  const pos = state.selection.main.head;
  // Walk back over word characters, then forward.
  const doc = state.doc;
  const line = doc.lineAt(pos);
  const text = line.text;
  const local = pos - line.from;
  const isWord = (c) => /[a-zA-Z0-9_]/.test(c);
  let from = local;
  while (from > 0 && isWord(text[from - 1])) from--;
  let to = local;
  while (to < text.length && isWord(text[to])) to++;
  return text.slice(from, to) || null;
}
```

Accept `onFocusBrowser` in the `createUniversalKeymap` signature and thread through `dispatchEditorExtensions` → `main.js`:

```js
// main.js
onFocusBrowser: (word) => {
  rightRail.activate("sounds");
  soundBrowser.focusSearch(word);
},
```

- [ ] **Step 3: Smoke-test**

Reload. Place cursor inside `s("piano")`. Press `Cmd+J`:
- Sound browser opens.
- Search field pre-filled with "piano".
- Search field is focused, text selected.
- Type a single letter → replaces the "piano" search.

- [ ] **Step 4: Commit**

```bash
git add src/editor/keymap-universal.js src/ui/sound-browser.js src/main.js
git commit -m "feat(intellisense): Cmd+J focus sound browser with cursor word"
```

---

## Phase 4 acceptance gate

- Drag from browser → editor inserts the sound (4.A).
- Bank chip appears + click filters browser (4.B).
- `Cmd+J` opens browser pre-filled with cursor word (4.C).
- 4.D `note()` colon-variant remains deferred unless requested.

---

## Final integration sweep

After Phase 4, do one full pass through the spec's overall acceptance + non-goals:

- [ ] No new dependencies added (`pnpm install` produces an unchanged lockfile vs. before Phase 1).
- [ ] No reference to upstream `renderPatternAudio` (per CLAUDE.md WAV gotcha) — none of this work touches export.
- [ ] No commented-out code from the deleted `sounds.js` left behind.
- [ ] All `pnpm test` tests pass.
- [ ] `pnpm build` produces a clean dist.
- [ ] Manually verify a non-trivial pattern (one of the user's actual `patterns/*.js`) loads, plays, and the popup behaves correctly while editing.

---

## Out-of-scope reminders

The following are intentionally NOT in this plan:

- LSP server, type inference, multi-file go-to-definition.
- Replacing Strudel's mini-notation parser.
- Any change to the keymap-profile system from `21-keybindings.md`.
- Any change to `signature-hint.js` or `hover-docs.js` (they survive unchanged).
- 4.D `note("c4:3")` colon-variant completion — deferred until requested.

---

## Open questions

The spec leaves one open question (line 871-875): `note()` colon-variant completion (Task 4.D). The mechanism is parallel to 3.A — when a user asks, the implementation is a small extension of `computeVariants` to dispatch on `kind === "note"`. Treat as backlog.
