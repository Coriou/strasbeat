// Run with:
//   node --import ./scripts/test-register.mjs --test src/patterns-transpile.test.js
//
// Patterns-wide transpile guard.
//
// Every patterns/*.js default-exports the WHOLE tune as a string (the
// "pattern file contract" in CLAUDE.md). That string is what Strudel's
// transpiler parses + rewrites before evaluation — so a tune that is valid
// as a JS template literal can still be broken Strudel source.
//
// The class of bug this catches (and `node --check` does NOT): a shader()
// source written as a MULTI-LINE single-quoted string. The outer template
// literal parses fine, so `node --check patterns/05-shader-demo.js` is happy,
// but the inner tune source has `shader('` opening a single-quoted string that
// spans many physical lines — illegal JS — so acorn (inside the transpiler)
// throws "Unterminated string constant" the instant you press play.
//
// We run the REAL transpiler strasbeat ships (src/transpiler-patch.js, the
// exact function main.js wires into the editor at main.js:265), not a bare
// acorn.parse. That makes this test faithful to runtime AND lets it catch a
// second failure mode: a string arg that gets silently rewritten into
// mini(...) and then fails to parse as mini-notation (e.g. backtick or
// double-quoted GLSL — both are mini-rewritten; see CLAUDE.md the
// single-quote rule). `import "@strudel/mini"` registers the minilang exactly
// as boot.js does, so the mini rewrite resolves the same way it does live.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transpiler } from "./transpiler-patch.js";
import "@strudel/mini"; // register the minilang so the mini() rewrite resolves

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const patternsDir = path.join(__dirname, "..", "patterns");

// Discover the directory rather than a fixed list so every current AND future
// pattern is guarded automatically — the same self-sustaining posture as
// share.test.js's directory walk.
const patternFiles = fs
  .readdirSync(patternsDir)
  .filter((f) => f.endsWith(".js"))
  .sort();

describe("every pattern's tune source transpiles", () => {
  // Sanity: if the glob ever yields nothing, the loop below would vacuously
  // "pass" and silently stop guarding anything. Fail loudly instead.
  test("discovers pattern files", () => {
    assert.ok(
      patternFiles.length > 0,
      `expected to find patterns/*.js, found none in ${patternsDir}`,
    );
  });

  for (const file of patternFiles) {
    test(`${file} transpiles without error`, async () => {
      const mod = await import(pathToFileURL(path.join(patternsDir, file)).href);
      const src = mod.default;
      assert.equal(
        typeof src,
        "string",
        `${file} must default-export the tune as a string (the pattern file contract)`,
      );
      // wrapAsync mirrors how the editor evaluates patterns that use top-level
      // await (e.g. `await shader(...)`, `await initHydra()`).
      assert.doesNotThrow(
        () => transpiler(src, { wrapAsync: true, addReturn: true }),
        `${file}: tune source failed to transpile — most likely a multi-line ` +
          `single-quoted string arg (illegal JS), or a string that was ` +
          `mini-rewritten and could not parse. See CLAUDE.md the single-quote rule.`,
      );
    });
  }
});
