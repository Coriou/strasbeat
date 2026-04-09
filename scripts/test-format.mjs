#!/usr/bin/env node
//
// Round-trip every pattern under /patterns through formatBuffer.
//
// What this guards against (per design/work/02-format-and-keybindings.md):
//   1. Prettier crashing on real pattern source.
//   2. Prettier mangling the *contents* of mini-notation strings (the things
//      inside `s("…")`, `note("…")`, `n("…")`, etc.). The exact characters
//      between the quotes have to survive byte-for-byte, because that's what
//      Strudel's transpiler turns into mini-notation calls.
//   3. Prettier swapping quote styles. Strudel's transpiler discriminates
//      `"foo"` (mini-notation, gets wrapped in `mini(...)`) from `'foo'`
//      (plain string, left as-is) by checking `node.raw[0] === '"'`. Swapping
//      a double-quoted mini string to single quotes silently breaks the
//      transpiler path; swapping a single-quoted plain string to double
//      quotes wraps it in `mini(...)` and breaks call sites that expect a
//      literal name (`.voicings('lefthand')`, `.bank('RolandTR909')`, …).
//      The bug is invisible from JavaScript's POV but fatal at runtime.
//   4. Idempotency: format(format(x)) === format(x). If the second pass
//      changes anything, the config is unstable and the user would see
//      flicker-y diffs on every save.
//
// What this does NOT do:
//   - Run Strudel's transpiler. We can't load `@strudel/transpiler` in a
//     Node-only context cleanly (it pulls in browser globals). Instead we
//     assert structural invariants on the formatted text — every quoted
//     string the original contained must still appear, contents intact, in
//     the output. That's tighter than just "Strudel didn't throw" because it
//     catches silent corruption that wouldn't surface as a parse error.
//
// Run with: `node scripts/test-format.mjs`. Exits non-zero on failure so it
// can be wired into CI later without changes.

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

import { formatBuffer, iterateStringLiterals } from '../src/editor/format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const patternsDir = join(repoRoot, 'patterns');

// The walker lives in src/editor/format.js so the test and the formatter
// are guaranteed to agree on what counts as a string literal. If the
// formatter's quote-restoration logic and the test diverge here, we'd be
// asserting one thing and shipping another.
function extractStringLiterals(source) {
  return [...iterateStringLiterals(source)];
}

/**
 * Verify that every literal in `before` appears in `after` with the same
 * body *and* the same quote character. Order is preserved: literal #k in
 * the input must map to literal #k in the output. This catches reordering,
 * body mangling, and quote-style flips — the last of which would silently
 * change Strudel's mini-notation classification (see comment at the top of
 * this file for the full reasoning).
 */
function assertLiteralsPreserved(before, after) {
  if (before.length !== after.length) {
    throw new Error(
      `string-literal count changed: ${before.length} → ${after.length}`,
    );
  }
  for (let k = 0; k < before.length; k++) {
    if (before[k].body !== after[k].body) {
      throw new Error(
        `string literal #${k} body mangled:\n  before: ${JSON.stringify(before[k].body)}\n  after:  ${JSON.stringify(after[k].body)}`,
      );
    }
    if (before[k].quote !== after[k].quote) {
      throw new Error(
        `string literal #${k} quote style flipped: ${before[k].quote}${before[k].body}${before[k].quote} → ${after[k].quote}${after[k].body}${after[k].quote} (Strudel transpiler treats " and ' differently)`,
      );
    }
  }
}

/**
 * Pattern files default-export a string of Strudel source. We import them
 * dynamically so we get the *evaluated* template literal — the thing the
 * editor would actually load.
 */
async function loadPattern(filePath) {
  const url = new URL('file://' + filePath);
  const mod = await import(url.href);
  if (typeof mod.default !== 'string') {
    throw new Error(
      `${filePath}: default export is not a string (got ${typeof mod.default})`,
    );
  }
  return mod.default;
}

async function runOne(filePath) {
  const rel = relative(repoRoot, filePath);
  const source = await loadPattern(filePath);

  let formatted;
  try {
    formatted = await formatBuffer(source);
  } catch (err) {
    return { rel, ok: false, reason: `prettier threw: ${err.message}` };
  }

  // (1) Literal preservation.
  let beforeLits, afterLits;
  try {
    beforeLits = extractStringLiterals(source);
    afterLits = extractStringLiterals(formatted);
    assertLiteralsPreserved(beforeLits, afterLits);
  } catch (err) {
    return { rel, ok: false, reason: err.message };
  }

  // (2) Idempotency.
  let formattedTwice;
  try {
    formattedTwice = await formatBuffer(formatted);
  } catch (err) {
    return {
      rel,
      ok: false,
      reason: `prettier threw on second pass: ${err.message}`,
    };
  }
  if (formattedTwice !== formatted) {
    return {
      rel,
      ok: false,
      reason: 'format is not idempotent — second pass produced a different result',
    };
  }

  return {
    rel,
    ok: true,
    literalCount: beforeLits.length,
    bytesIn: source.length,
    bytesOut: formatted.length,
  };
}

async function main() {
  const entries = await readdir(patternsDir);
  const files = entries
    .filter((e) => e.endsWith('.js'))
    .map((e) => join(patternsDir, e))
    .sort();

  if (files.length === 0) {
    console.error('no .js files found in /patterns — nothing to test');
    process.exit(2);
  }

  const results = [];
  for (const file of files) {
    results.push(await runOne(file));
  }

  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(
        `  ok   ${r.rel}  (${r.literalCount} literals, ${r.bytesIn}B → ${r.bytesOut}B)`,
      );
    } else {
      failed++;
      console.error(`  FAIL ${r.rel}  ${r.reason}`);
    }
  }

  console.log('');
  if (failed) {
    console.error(`${failed} of ${results.length} pattern(s) failed.`);
    process.exit(1);
  }
  console.log(`all ${results.length} patterns formatted cleanly.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
