import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as strudelCore from '@strudel/core';

import {
  arrange,
  primeArrangementParser,
  resetRegistry,
  getRegistry,
  subscribeRegistry,
  setSolo,
  clearSolo,
  getSoloKey,
  validateSolo,
  beginEvaluate,
  endEvaluate,
} from './arrange.js';

// Every test starts with a clean registry/queue/solo so module state
// from a previous test doesn't bleed in.
beforeEach(() => {
  primeArrangementParser([]);
  resetRegistry();
  clearSolo();
});

const pat = (name) => strudelCore.pure(name);

describe('arrange() wrapper', () => {
  test('delegates to strudelCore.arrange for the audible pattern', () => {
    // The wrapper returns a Pattern; we render a couple of cycles and
    // expect the same hap values as core.arrange would produce.
    const sections = [[2, pat('a')], [2, pat('b')]];
    const ours = arrange(...sections);
    const theirs = strudelCore.arrange([2, pat('a')], [2, pat('b')]);

    const ourHaps = ours.queryArc(0, 4).map((h) => h.value);
    const theirHaps = theirs.queryArc(0, 4).map((h) => h.value);
    assert.deepEqual(ourHaps, theirHaps);
  });

  test('returns silence and warns when called with no sections', () => {
    const result = arrange();
    assert.ok(result?._Pattern === true);
    // silence pattern yields no haps in any cycle
    assert.equal(result.queryArc(0, 4).length, 0);
  });

  test('registers one entry per call with accurate cycle counts', () => {
    arrange([4, pat('a')], [2, pat('b')]);
    const reg = getRegistry();
    assert.equal(reg.length, 1);
    assert.equal(reg[0].totalCycles, 6);
    assert.deepEqual(
      reg[0].sections.map((s) => s.cycles),
      [4, 2],
    );
  });

  test('merges labels from the primed parser queue when counts match', () => {
    primeArrangementParser([
      {
        line: 1,
        callStart: 0,
        openParen: 7,
        closeParen: 40,
        totalCycles: 6,
        sections: [
          { label: 'verse',  start: 8,  end: 18, line: 1, cycles: 4, rawExpr: 'verse' },
          { label: 'chorus', start: 20, end: 38, line: 1, cycles: 2, rawExpr: 'chorus' },
        ],
      },
    ]);
    arrange([4, pat('v')], [2, pat('c')]);
    const [entry] = getRegistry();
    assert.equal(entry.sections[0].label, 'verse');
    assert.equal(entry.sections[1].label, 'chorus');
    assert.equal(entry.sections[0].sourceStart, 8);
  });

  test('falls back to numbered labels when parsed count mismatches', () => {
    // Parser found 1 section, but runtime has 2 — simulating a nested arrange
    // (parent consumed the queue entry for the outer call) or dynamic spread.
    primeArrangementParser([
      {
        line: 1,
        callStart: 0,
        openParen: 7,
        closeParen: 20,
        totalCycles: 4,
        sections: [
          { label: 'outer', start: 8, end: 18, line: 1, cycles: 4, rawExpr: 'outer' },
        ],
      },
    ]);
    arrange([2, pat('a')], [2, pat('b')]);
    const [entry] = getRegistry();
    assert.equal(entry.sections[0].label, 'Section 1');
    assert.equal(entry.sections[1].label, 'Section 2');
  });

  test('drains the queue across multiple sibling arranges', () => {
    primeArrangementParser([
      {
        line: 1, callStart: 0, openParen: 7, closeParen: 30, totalCycles: 4,
        sections: [
          { label: 'v', start: 8, end: 14, line: 1, cycles: 2, rawExpr: 'v' },
          { label: 'c', start: 16, end: 22, line: 1, cycles: 2, rawExpr: 'c' },
        ],
      },
      {
        line: 2, callStart: 32, openParen: 39, closeParen: 60, totalCycles: 8,
        sections: [
          { label: 'b', start: 40, end: 46, line: 2, cycles: 8, rawExpr: 'b' },
        ],
      },
    ]);
    arrange([2, pat('a')], [2, pat('b')]);
    arrange([8, pat('c')]);

    const reg = getRegistry();
    assert.equal(reg.length, 2);
    assert.deepEqual(reg[0].sections.map((s) => s.label), ['v', 'c']);
    assert.equal(reg[0].arrangeIndex, 0);
    assert.deepEqual(reg[1].sections.map((s) => s.label), ['b']);
    assert.equal(reg[1].arrangeIndex, 1);
  });

  test('numbers labels when the queue is empty', () => {
    arrange([1, pat('a')], [1, pat('b')]);
    const [entry] = getRegistry();
    assert.deepEqual(
      entry.sections.map((s) => s.label),
      ['Section 1', 'Section 2'],
    );
  });

  test('resetRegistry clears entries and resets the ordinal counter', () => {
    arrange([1, pat('a')]);
    arrange([1, pat('b')]);
    assert.equal(getRegistry().length, 2);
    resetRegistry();
    assert.equal(getRegistry().length, 0);
    arrange([1, pat('c')]);
    assert.equal(getRegistry()[0].arrangeIndex, 0);
  });
});

describe('solo state', () => {
  test('setSolo() toggles the same coord off, different coord swaps', () => {
    setSolo(0, 2);
    assert.deepEqual(getSoloKey(), { arrangeIndex: 0, sectionIndex: 2 });
    setSolo(0, 2);
    assert.equal(getSoloKey(), null);
    setSolo(0, 2);
    setSolo(1, 0);
    assert.deepEqual(getSoloKey(), { arrangeIndex: 1, sectionIndex: 0 });
  });

  test('wrapper returns a single-section arrangement when section is soloed', () => {
    setSolo(0, 1);
    const result = arrange([2, pat('a')], [2, pat('b')]);
    // The soloed output should render only "b" haps — "a" shouldn't appear
    // at all across a few loops.
    const vals = result.queryArc(0, 8).map((h) => h.value);
    assert.ok(vals.includes('b'));
    assert.ok(!vals.includes('a'));
  });

  test('wrapper ignores solo when the coord points past the section list', () => {
    setSolo(0, 99);
    const result = arrange([2, pat('a')], [2, pat('b')]);
    const vals = result.queryArc(0, 8).map((h) => h.value);
    assert.ok(vals.includes('a'));
    assert.ok(vals.includes('b'));
  });

  test('wrapper ignores solo when arrangeIndex does not match', () => {
    setSolo(5, 0);
    const result = arrange([2, pat('a')], [2, pat('b')]);
    const vals = result.queryArc(0, 8).map((h) => h.value);
    assert.ok(vals.includes('a'));
    assert.ok(vals.includes('b'));
  });

  test('validateSolo clears a stale coord (registry shrinks)', () => {
    arrange([1, pat('a')], [1, pat('b')]);
    setSolo(0, 1);
    assert.deepEqual(getSoloKey(), { arrangeIndex: 0, sectionIndex: 1 });

    resetRegistry();
    arrange([1, pat('a')]); // only one section now
    validateSolo(); // runs when evalInProgress = false
    assert.equal(getSoloKey(), null);
  });

  test('validateSolo is a no-op mid-evaluate (transient empty registry)', () => {
    arrange([1, pat('a')], [1, pat('b')]);
    setSolo(0, 1);

    // Simulate eval start: reset + begin. Registry is transiently empty.
    resetRegistry();
    beginEvaluate();
    validateSolo();
    // Solo should survive — the wrapper hasn't re-registered yet.
    assert.deepEqual(getSoloKey(), { arrangeIndex: 0, sectionIndex: 1 });

    // Wrapper fires, re-registers. Eval completes.
    arrange([1, pat('a')], [1, pat('b')]);
    endEvaluate();
    assert.deepEqual(getSoloKey(), { arrangeIndex: 0, sectionIndex: 1 });
  });

  test('solo state persists across evaluates', () => {
    // Evaluate once with a two-section arrange + solo.
    arrange([1, pat('a')], [1, pat('b')]);
    setSolo(0, 0);

    // Simulate next evaluate: reset registry (but NOT solo — that's the contract).
    resetRegistry();
    assert.deepEqual(getSoloKey(), { arrangeIndex: 0, sectionIndex: 0 });

    const result = arrange([1, pat('a')], [1, pat('b')]);
    const vals = result.queryArc(0, 4).map((h) => h.value);
    assert.ok(vals.includes('a'));
    assert.ok(!vals.includes('b'));
  });
});

describe('subscribers', () => {
  test('subscribeRegistry fires immediately and on every emit', () => {
    const calls = [];
    const unsub = subscribeRegistry(({ registry, soloKey }) => {
      calls.push({ len: registry.length, solo: soloKey });
    });
    assert.equal(calls.length, 1); // initial snapshot

    arrange([1, pat('a')]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].len, 1);

    setSolo(0, 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].solo, { arrangeIndex: 0, sectionIndex: 0 });

    unsub();
    arrange([1, pat('b')]);
    assert.equal(calls.length, 3); // no more calls after unsub
  });
});
