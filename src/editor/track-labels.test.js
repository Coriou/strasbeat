import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  labelAtLine,
  parseLabels,
  toggleMute,
  toggleSolo,
} from './track-labels.js';

describe('parseLabels()', () => {
  test('parses basic, muted, soloed, combined, and anonymous labels', () => {
    const labels = parseLabels([
      '$: s("bd")',
      'lead_: note("c3")',
      '_bass: note("c2")',
      'Sdrums: s("sd")',
      'Slead_: note("e4")',
    ].join('\n'));

    assert.deepEqual(
      labels.map((label) => ({
        rawName: label.rawName,
        name: label.name,
        muted: label.muted,
        soloed: label.soloed,
        displayName: label.displayName,
      })),
      [
        { rawName: '$', name: '$', muted: false, soloed: false, displayName: '$1' },
        { rawName: 'lead_', name: 'lead', muted: true, soloed: false, displayName: 'lead' },
        { rawName: '_bass', name: 'bass', muted: true, soloed: false, displayName: 'bass' },
        { rawName: 'Sdrums', name: 'drums', muted: false, soloed: true, displayName: 'drums' },
        { rawName: 'Slead_', name: 'lead', muted: true, soloed: true, displayName: 'lead' },
      ],
    );
  });

  test('tracks multi-line block ownership with a preamble before the first label', () => {
    const code = [
      'setcpm(120/4)',
      '',
      'lead: stack(',
      '  note("c3 e3").s("sawtooth"),',
      '  note("g3 b3").s("square"),',
      ')',
      '',
      'drums: s("bd*2, sd")',
    ].join('\n');
    const labels = parseLabels(code);

    assert.equal(labels.length, 2);
    assert.equal(labels[0].line, 3);
    assert.equal(labels[0].endLine, 7);
    assert.equal(labels[1].line, 8);
    assert.equal(labels[1].endLine, 8);
  });

  test('ignores labels inside comments, templates, and object literals', () => {
    const code = [
      '// fake: note("c3")',
      'const meta = {',
      '  fake: "label",',
      '};',
      'const tpl = `',
      'fake: note("c4")',
      '`;',
      'real: note("g3")',
    ].join('\n');

    assert.deepEqual(
      parseLabels(code).map((label) => label.rawName),
      ['real'],
    );
  });
});

describe('toggleMute()', () => {
  test('toggles an unmuted label to muted and back', () => {
    const code = 'lead: note("c3").s("sawtooth")';
    assert.equal(toggleMute(code, 'lead'), 'lead_: note("c3").s("sawtooth")');
    assert.equal(toggleMute('lead_: note("c3").s("sawtooth")', 'lead'), code);
  });

  test('unmutes the prefix underscore form', () => {
    const code = '_lead: note("c3").s("sawtooth")';
    assert.equal(toggleMute(code, 'lead'), 'lead: note("c3").s("sawtooth")');
  });

  test('preserves the solo prefix when muting and unmuting', () => {
    const code = 'Slead: note("c3").s("sawtooth")';
    assert.equal(toggleMute(code, 'lead'), 'Slead_: note("c3").s("sawtooth")');
    assert.equal(toggleMute('Slead_: note("c3").s("sawtooth")', 'lead'), code);
  });

  test('toggles anonymous labels by display name', () => {
    const code = [
      '$: s("bd")',
      '$: s("sd")',
    ].join('\n');
    assert.equal(
      toggleMute(code, '$2'),
      [
        '$: s("bd")',
        '$_: s("sd")',
      ].join('\n'),
    );
  });

  test('preserves surrounding code', () => {
    const code = [
      'setcpm(120/4)',
      '',
      'lead: note("c3").s("sawtooth")',
      'drums: s("bd sd")',
    ].join('\n');
    assert.equal(
      toggleMute(code, 'lead'),
      [
        'setcpm(120/4)',
        '',
        'lead_: note("c3").s("sawtooth")',
        'drums: s("bd sd")',
      ].join('\n'),
    );
  });
});

describe('toggleSolo()', () => {
  test('toggles an unsoloed label to soloed and back', () => {
    const code = 'lead: note("c3").s("sawtooth")';
    assert.equal(toggleSolo(code, 'lead'), 'Slead: note("c3").s("sawtooth")');
    assert.equal(toggleSolo('Slead: note("c3").s("sawtooth")', 'lead'), code);
  });

  test('preserves a trailing mute marker', () => {
    const code = 'lead_: note("c3").s("sawtooth")';
    assert.equal(toggleSolo(code, 'lead'), 'Slead_: note("c3").s("sawtooth")');
    assert.equal(toggleSolo('Slead_: note("c3").s("sawtooth")', 'lead'), code);
  });

  test('canonicalizes the prefix mute form when soloing', () => {
    const code = '_lead: note("c3").s("sawtooth")';
    assert.equal(toggleSolo(code, 'lead'), 'Slead_: note("c3").s("sawtooth")');
  });

  test('toggles anonymous labels by display name', () => {
    const code = [
      '$: s("bd")',
      '$: s("sd")',
    ].join('\n');
    assert.equal(
      toggleSolo(code, '$2'),
      [
        '$: s("bd")',
        'S$: s("sd")',
      ].join('\n'),
    );
  });

  test('preserves surrounding code', () => {
    const code = [
      'setcpm(120/4)',
      '',
      'drums: s("bd*2, sd")',
      'lead: note("c3").s("sawtooth")',
    ].join('\n');
    assert.equal(
      toggleSolo(code, 'drums'),
      [
        'setcpm(120/4)',
        '',
        'Sdrums: s("bd*2, sd")',
        'lead: note("c3").s("sawtooth")',
      ].join('\n'),
    );
  });
});

describe('labelAtLine()', () => {
  test('returns null in the preamble before the first label', () => {
    const labels = parseLabels([
      'setcpm(120/4)',
      '',
      'lead: note("c3")',
    ].join('\n'));
    assert.equal(labelAtLine(labels, 1), null);
    assert.equal(labelAtLine(labels, 2), null);
  });

  test('finds the label on the label line, inside the body, and on the last line', () => {
    const labels = parseLabels([
      'setcpm(120/4)',
      '',
      'lead: stack(',
      '  note("c3"),',
      '  note("e3"),',
      ')',
      'drums: s("bd sd")',
    ].join('\n'));

    assert.equal(labelAtLine(labels, 3)?.name, 'lead');
    assert.equal(labelAtLine(labels, 5)?.name, 'lead');
    assert.equal(labelAtLine(labels, 6)?.name, 'lead');
    assert.equal(labelAtLine(labels, 7)?.name, 'drums');
  });
});
