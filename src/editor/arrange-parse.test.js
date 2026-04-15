import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArrangements, locatePlayhead } from './arrange-parse.js';

describe('parseArrangements()', () => {
  test('extracts cycles and labels for bare-identifier sections', () => {
    const code = [
      'const verse = s("bd*2")',
      'const chorus = s("bd sd bd sd")',
      '',
      'arrange(',
      '  [8, verse],',
      '  [8, chorus],',
      '  [16, chorus],',
      ')',
    ].join('\n');

    const [a] = parseArrangements(code);
    assert.equal(a.sections.length, 3);
    assert.deepEqual(
      a.sections.map((s) => ({ cycles: s.cycles, label: s.label, line: s.line })),
      [
        { cycles: 8, label: 'verse', line: 5 },
        { cycles: 8, label: 'chorus', line: 6 },
        { cycles: 16, label: 'chorus', line: 7 },
      ],
    );
    assert.equal(a.totalCycles, 32);
    assert.equal(a.line, 4);
  });

  test('recovers labels from string literals', () => {
    const code = "arrange([4, 'intro'], [8, \"drop\"])";
    const [a] = parseArrangements(code);
    assert.deepEqual(
      a.sections.map((s) => s.label),
      ['intro', 'drop'],
    );
  });

  test('returns null label for complex expressions', () => {
    const code = 'arrange([8, verse.slow(2)], [4, stack(a, b)])';
    const [a] = parseArrangements(code);
    assert.equal(a.sections[0].label, null);
    assert.equal(a.sections[0].rawExpr, 'verse.slow(2)');
    assert.equal(a.sections[1].label, null);
    assert.equal(a.sections[1].rawExpr, 'stack(a, b)');
  });

  test('accepts fractional and single-digit cycle counts', () => {
    const code = 'arrange([1, a], [0.5, b], [2.25, c])';
    const [arr] = parseArrangements(code);
    assert.deepEqual(arr.sections.map((s) => s.cycles), [1, 0.5, 2.25]);
    assert.equal(arr.totalCycles, 3.75);
  });

  test('ignores arrange inside single-line comments', () => {
    const code = [
      '// arrange([8, verse])',
      'setcpm(120)',
    ].join('\n');
    assert.deepEqual(parseArrangements(code), []);
  });

  test('ignores arrange inside block comments', () => {
    const code = [
      '/*',
      'arrange([8, verse])',
      '*/',
      's("bd")',
    ].join('\n');
    assert.deepEqual(parseArrangements(code), []);
  });

  test('ignores arrange inside string literals and template strings', () => {
    const code = [
      'const x = "arrange([8, verse])"',
      'const y = `arrange([8, chorus])`',
    ].join('\n');
    assert.deepEqual(parseArrangements(code), []);
  });

  test('ignores .arrange member access', () => {
    const code = 'pat.arrange([8, verse])';
    assert.deepEqual(parseArrangements(code), []);
  });

  test('ignores longer identifiers that start with arrange', () => {
    const code = 'arrangement([8, verse])';
    assert.deepEqual(parseArrangements(code), []);
  });

  test('returns multiple arrangements in one file', () => {
    const code = [
      'arrange([4, a], [4, b])',
      's("bd")',
      'arrange([8, c], [8, d])',
    ].join('\n');
    const arrs = parseArrangements(code);
    assert.equal(arrs.length, 2);
    assert.equal(arrs[0].totalCycles, 8);
    assert.equal(arrs[1].totalCycles, 16);
  });

  test('does not pick up bracket tuples nested inside other calls', () => {
    const code = 'arrange([4, foo([999, nope])], [2, bar])';
    const [arr] = parseArrangements(code);
    assert.equal(arr.sections.length, 2);
    assert.deepEqual(arr.sections.map((s) => s.cycles), [4, 2]);
  });

  test('tolerates trailing comma and whitespace inside tuples', () => {
    const code = 'arrange(\n  [ 8 , verse ],\n  [ 4 , chorus ],\n)';
    const [arr] = parseArrangements(code);
    assert.deepEqual(arr.sections.map((s) => s.label), ['verse', 'chorus']);
  });

  test('skips tuples that are not [number, expr]', () => {
    const code = 'arrange([verse, 8], [8, chorus], [, 4])';
    const [arr] = parseArrangements(code);
    assert.equal(arr.sections.length, 1);
    assert.equal(arr.sections[0].label, 'chorus');
  });

  test('returns an arrangement with zero sections when the call is empty', () => {
    const [arr] = parseArrangements('arrange()');
    assert.ok(arr);
    assert.equal(arr.sections.length, 0);
    assert.equal(arr.totalCycles, 0);
  });

  test('tolerates unterminated arrange at end of buffer', () => {
    const code = 'arrange([8, verse],';
    assert.deepEqual(parseArrangements(code), []);
  });
});

describe('locatePlayhead()', () => {
  const arrangement = {
    callStart: 0, openParen: 7, closeParen: 50, line: 1, totalCycles: 20,
    sections: [
      { cycles: 8, label: 'verse',  rawExpr: 'verse',  start: 0, end: 0, line: 1 },
      { cycles: 4, label: 'chorus', rawExpr: 'chorus', start: 0, end: 0, line: 1 },
      { cycles: 8, label: 'bridge', rawExpr: 'bridge', start: 0, end: 0, line: 1 },
    ],
  };

  test('maps cycle inside first section', () => {
    const p = locatePlayhead(arrangement, 2);
    assert.equal(p.index, 0);
    assert.equal(p.sectionProgress, 0.25);
    assert.equal(p.totalProgress, 0.1);
  });

  test('maps cycle inside second section', () => {
    const p = locatePlayhead(arrangement, 10);
    assert.equal(p.index, 1);
    assert.equal(p.sectionProgress, 0.5);
  });

  test('wraps cycles past totalCycles back into the arrangement', () => {
    const p = locatePlayhead(arrangement, 22);
    assert.equal(p.index, 0);
    assert.equal(p.sectionProgress, 0.25);
  });

  test('returns null for empty arrangement', () => {
    assert.equal(locatePlayhead({ sections: [], totalCycles: 0 }, 0), null);
  });
});
