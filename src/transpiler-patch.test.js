import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { transpiler } from './transpiler-patch.js';

describe('transpiler silence-fallback', () => {
  test('appends silence when the pattern ends in a function declaration', () => {
    const { output } = transpiler(`
$: s("bd sd")
function helper(x) { return note(x) }
`);
    assert.match(output, /return silence/);
    assert.match(output, /\.p\('\$'\)/);
  });

  test('appends silence when the pattern ends in a variable declaration', () => {
    const { output } = transpiler(`
$: s("bd sd")
const drums = s("hh*8")
`);
    assert.match(output, /return silence/);
  });

  test('appends silence when the pattern ends in an if block', () => {
    const { output } = transpiler(`
$: s("bd sd")
if (true) { const x = 1 }
`);
    assert.match(output, /return silence/);
  });

  test('does not append silence for a plain expression pattern', () => {
    const { output } = transpiler('s("bd sd")');
    assert.doesNotMatch(output, /\bsilence\b/);
  });

  test('does not append silence for a trailing labeled statement', () => {
    const { output } = transpiler('$: s("bd sd")');
    assert.doesNotMatch(output, /\bsilence\b/);
  });

  test('handles the mario-flowhacker shape without throwing', () => {
    assert.doesNotThrow(() =>
      transpiler(`
setcpm(50)
const intro = \`<C E G>\`
$: arrange([4, note(intro)])
function sqr(x) { return note(x).s("square") }
function tri(x) { return note(x).s("triangle") }
`),
    );
  });

  test('lets the original transpiler surface a parse error', () => {
    // Not valid JS — acorn (in both our pre-parse and the transpiler's)
    // will throw. We must not swallow that.
    assert.throws(() => transpiler('function ('));
  });
});
