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
        soloSuppressed: label.soloSuppressed,
        displayName: label.displayName,
      })),
      [
        { rawName: '$', name: '$', muted: false, soloed: false, soloSuppressed: false, displayName: '$1' },
        { rawName: 'lead_', name: 'lead', muted: true, soloed: false, soloSuppressed: false, displayName: 'lead' },
        { rawName: '_bass', name: 'bass', muted: true, soloed: false, soloSuppressed: false, displayName: 'bass' },
        { rawName: 'Sdrums', name: 'drums', muted: false, soloed: true, soloSuppressed: false, displayName: 'drums' },
        // `Slead_` can no longer be written by any toggle, but a hand-edited
        // file can still contain it. repl.mjs's p() short-circuits to silence
        // on the `_` BEFORE registering the id, so the track never reaches the
        // solo scan: mute wins and the solo is inert. Report what the engine
        // does, and flag the discrepancy separately so the UI can say so.
        { rawName: 'Slead_', name: 'lead', muted: true, soloed: false, soloSuppressed: true, displayName: 'lead' },
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

  test('muting a soloed label clears the solo', () => {
    // `Slead_` is unwritable: Strudel drops the track entirely AND skips solo
    // filtering for the whole pattern, so the label would describe a state the
    // engine will not honour. Mute and solo are mutually exclusive per track.
    const code = 'Slead: note("c3").s("sawtooth")';
    assert.equal(toggleMute(code, 'lead'), 'lead_: note("c3").s("sawtooth")');
  });

  test('unmuting a hand-written combined label lands on the plain name', () => {
    assert.equal(
      toggleMute('Slead_: note("c3").s("sawtooth")', 'lead'),
      'lead: note("c3").s("sawtooth")',
    );
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

  test('soloing a suffix-muted label clears the mute', () => {
    const code = 'lead_: note("c3").s("sawtooth")';
    assert.equal(toggleSolo(code, 'lead'), 'Slead: note("c3").s("sawtooth")');
  });

  test('soloing a prefix-muted label clears the mute', () => {
    const code = '_lead: note("c3").s("sawtooth")';
    assert.equal(toggleSolo(code, 'lead'), 'Slead: note("c3").s("sawtooth")');
  });

  test('soloing a hand-written combined label turns the inert solo into a real one', () => {
    // Mute won in `Slead_`, so the label reads as un-soloed — one shift-click
    // makes the solo actually take effect rather than toggling it off.
    assert.equal(
      toggleSolo('Slead_: note("c3").s("sawtooth")', 'lead'),
      'Slead: note("c3").s("sawtooth")',
    );
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

// ─── Audible outcome: mute + solo are mutually exclusive (BUG-1) ─────────
//
// Asserting the emitted label text is not enough here — the whole bug was that
// a label the UI happily displayed ("Muted and soloed") made Strudel do the
// exact opposite of what was asked. So these tests run the source through a
// faithful re-implementation of the engine's two decision points and assert
// which tracks actually SOUND.
//
// Transcribed from @strudel/core 1.2.6:
//   repl.mjs:172  Pattern.prototype.p  — `_x` / `x_` short-circuits to silence
//                 BEFORE the id is registered, so a muted track is invisible to
//                 the solo scan below. Mute and solo are not orthogonal.
//   repl.mjs:240  the solo scan over Object.entries(pPatterns) — the first key
//                 matching /^S./ clears everything collected so far and from
//                 then on only S-prefixed keys are kept.
// If those ever change upstream, this harness is what should fail first.
function audibleTracks(code) {
  const pPatterns = new Map(); // id → the label's display name
  let anonymousIndex = 0;
  for (const label of parseLabels(code)) {
    let id = label.rawName;
    if (id.startsWith('_') || id.endsWith('_')) continue; // p() → silence
    if (id.includes('$')) {
      id = `${id}${anonymousIndex}`;
      anonymousIndex++;
    }
    pPatterns.set(id, label.displayName);
  }

  let patterns = [];
  let soloActive = false;
  for (const [key, displayName] of pPatterns) {
    const isSolod = key.length > 1 && key.startsWith('S');
    if (isSolod && soloActive === false) {
      patterns = [];
      soloActive = true;
    }
    if (!soloActive || (soloActive && isSolod)) patterns.push(displayName);
  }
  return patterns;
}

describe('audibleTracks() harness', () => {
  // The harness is the measuring instrument for every test below it, so pin
  // the three upstream rules it encodes with hand-derived expectations.
  test('with no decorations every track sounds', () => {
    assert.deepEqual(audibleTracks('a: s("bd")\nb: s("sd")'), ['a', 'b']);
  });

  test('a solo silences every other track', () => {
    assert.deepEqual(audibleTracks('a: s("bd")\nSb: s("sd")\nc: s("hh")'), ['b']);
  });

  test('both mute spellings drop their own track only', () => {
    assert.deepEqual(audibleTracks('a_: s("bd")\n_b: s("sd")\nc: s("hh")'), ['c']);
  });

  test('a muted+soloed track is dropped and its solo never takes effect', () => {
    // The root fact behind BUG-1, stated as the engine sees it.
    assert.deepEqual(audibleTracks('a: s("bd")\nSb_: s("sd")\nc: s("hh")'), ['a', 'c']);
  });
});

describe('mute + solo are mutually exclusive (design/work/27 BUG-1)', () => {
  const CODE = [
    'drums: s("bd*2")',
    'bass: note("c2")',
    'lead: note("c4")',
  ].join('\n');

  test('soloing a muted track actually isolates it', () => {
    // The reachable gesture: click a track to mute it, then shift-click to
    // solo it. Before the fix this emitted `Sbass_`, which Strudel drops —
    // so the one track you asked to hear was the only one that went silent.
    const muted = toggleMute(CODE, 'bass');
    assert.deepEqual(audibleTracks(muted), ['drums', 'lead']);

    const soloed = toggleSolo(muted, 'bass');
    assert.deepEqual(audibleTracks(soloed), ['bass']);
  });

  test('muting a soloed track brings the other tracks back', () => {
    const soloed = toggleSolo(CODE, 'bass');
    assert.deepEqual(audibleTracks(soloed), ['bass']);

    const muted = toggleMute(soloed, 'bass');
    assert.deepEqual(audibleTracks(muted), ['drums', 'lead']);
  });

  test('unmuting after mute-while-soloed restores the whole pattern', () => {
    // Before the fix, `Sbass` → mute → `Sbass_` → unmute → `Sbass`: the click
    // labelled "unmute" made every other track disappear.
    const twice = toggleMute(toggleMute(toggleSolo(CODE, 'bass'), 'bass'), 'bass');
    assert.deepEqual(audibleTracks(twice), ['drums', 'bass', 'lead']);
  });

  test('unsoloing after solo-while-muted restores the whole pattern', () => {
    const twice = toggleSolo(toggleSolo(toggleMute(CODE, 'bass'), 'bass'), 'bass');
    assert.deepEqual(audibleTracks(twice), ['drums', 'bass', 'lead']);
  });

  test('no toggle from any starting label can emit the combined form', () => {
    // Every shape the parser recognises, put through both toggles. The
    // combined form is what makes the state unrepresentable, so it must be
    // unreachable from every entry point — they all share these two functions.
    const starts = ['bass', 'bass_', '_bass', 'Sbass', 'Sbass_', '$', '$_', '_$', 'S$', 'S$_'];
    const produced = [];
    for (const raw of starts) {
      const code = `${raw}: note("c2")`;
      const name = parseLabels(code)[0].displayName;
      produced.push(toggleMute(code, name), toggleSolo(code, name));
    }
    const combined = produced.filter((code) => /^S[A-Za-z0-9_$]*_\s*:/.test(code));
    assert.deepEqual(combined, []);
  });
});

describe('toggle round-trips', () => {
  // Applying the same toggle twice must return the buffer byte-for-byte, so a
  // mute-then-unmute leaves nothing in the diff.
  //
  // A toggle only round-trips when it does not have to clear the OTHER flag to
  // get there. `Slead` --mute--> `lead_` --mute--> `lead` is destructive on
  // purpose: mutual exclusion means muting a soloed track drops the solo, and
  // there is nowhere in the source to remember it. Those cases are asserted
  // explicitly in the toggleMute()/toggleSolo() suites instead.
  const forms = [
    ['named', 'lead', ['mute', 'solo']],
    ['suffix-muted', 'lead_', ['mute']],
    ['soloed', 'Slead', ['solo']],
    ['anonymous', '$', ['mute', 'solo']],
    ['muted anonymous', '$_', ['mute']],
    ['soloed anonymous', 'S$', ['solo']],
  ];
  const toggles = { mute: toggleMute, solo: toggleSolo };

  for (const [description, raw, roundTrippable] of forms) {
    for (const kind of roundTrippable) {
      test(`${description} (${raw}) survives a ${kind} round-trip`, () => {
        const code = `${raw}: note("c3")\nother: s("bd")`;
        const name = parseLabels(code)[0].displayName;
        const toggle = toggles[kind];
        assert.equal(toggle(toggle(code, name), name), code);
      });
    }
  }

  test('prefix-muted labels normalise to the suffix form on a mute round-trip', () => {
    // The one non-destructive case that still cannot round-trip byte-
    // identically: unmuting `_lead` erases which spelling the author used, and
    // re-muting has to pick one. Both spellings are equally valid to Strudel,
    // so this is a cosmetic normalisation, not an audible change.
    const code = '_lead: note("c3")';
    assert.equal(toggleMute(code, 'lead'), 'lead: note("c3")');
    assert.equal(toggleMute(toggleMute(code, 'lead'), 'lead'), 'lead_: note("c3")');
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
