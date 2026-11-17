import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodeShareCode,
  decodeShareCode,
  SHARE_MAX_ENCODED,
  SHARE_MAX_ENCODED_ACCEPTED,
  SHARE_MAX_DECODED_BYTES,
  resolveSharedArrival,
  adoptSharedPattern,
  readSharedFromHash,
} from './share.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('share encoding', () => {
  test('round-trips a simple pattern', async () => {
    const code = 's("bd sd hh*4").room(0.5)';
    const encoded = await encodeShareCode(code);
    assert.ok(encoded.startsWith('z:'), 'new encoded form is gzipped');
    assert.equal(await decodeShareCode(encoded), code);
  });

  test('round-trips multi-line patterns with backticks and ${}', async () => {
    const code = [
      'setcpm(60)',
      'const chord = `<C E G>`',
      '$: note(chord).s("square")',
      'const label = `hello ${42}`',
    ].join('\n');
    assert.equal(await decodeShareCode(await encodeShareCode(code)), code);
  });

  test('decodes legacy (uncompressed) share hashes', async () => {
    // Legacy format: plain base64url of utf-8. Generated with the 1.0 encoder.
    const code = 's("bd")';
    const legacy = bytesToLegacyBase64Url(new TextEncoder().encode(code));
    assert.equal(await decodeShareCode(legacy), code);
  });

  test('compresses a real ~10KB pattern under the encoded cap', async () => {
    // Build a realistically-large, realistically-varied buffer from REAL
    // committed pattern source (not a synthetic/trivially-compressible string),
    // so this exercises genuine gzip behaviour on the kind of input a user
    // would actually share. We read whatever patterns/*.js files exist —
    // sorted for determinism — and concatenate until we clear ~10KB. Reading
    // the directory (rather than one named file) keeps the test self-sustaining
    // if a pattern is renamed or removed.
    const patternsDir = path.join(__dirname, '..', 'patterns');
    const files = fs
      .readdirSync(patternsDir)
      .filter((f) => f.endsWith('.js'))
      .sort();
    let raw = '';
    for (const file of files) {
      if (raw.length >= 10000) break;
      raw += fs.readFileSync(path.join(patternsDir, file), 'utf8') + '\n';
    }
    // Guard against the input silently degrading to something trivial (e.g. if
    // the library shrinks): the whole point is testing a large, varied buffer.
    assert.ok(
      raw.length >= 8000,
      `expected a large concatenated buffer, got ${raw.length} chars`,
    );

    const encoded = await encodeShareCode(raw);
    assert.ok(
      encoded.length < SHARE_MAX_ENCODED,
      `expected encoded buffer to fit in ${SHARE_MAX_ENCODED}, got ${encoded.length}`,
    );
    assert.equal(await decodeShareCode(encoded), raw);
  });
});

function bytesToLegacyBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('reading a share link', () => {
  // The installed app gets links through window.launchQueue, not the address
  // bar, so the hash has to be readable from a URL it was handed.
  test('reads code and name from a given hash', async () => {
    const code = 's("bd sd")';
    const params = new URLSearchParams({ code: await encodeShareCode(code), name: 'groove' });
    const url = new URL(`https://strasbeat.example/#${params}`);
    assert.deepEqual(await readSharedFromHash(url.hash), { code, name: 'groove' });
  });

  test('a hash without a code is not a share link', async () => {
    assert.equal(await readSharedFromHash('#foo=1'), null);
    assert.equal(await readSharedFromHash(''), null);
  });
});

describe('share decoding limits', () => {
  test('refuses a payload that inflates past the decoded-size budget', async () => {
    // Highly compressible: megabytes of text in a few kB of hash.
    const bomb = await encodeShareCode('a'.repeat(SHARE_MAX_DECODED_BYTES * 4));
    assert.ok(bomb.length < SHARE_MAX_ENCODED_ACCEPTED, 'small enough to reach the inflater');
    await assert.rejects(decodeShareCode(bomb), /too large/);
  });

  test('refuses an oversized hash before decoding it', async () => {
    await assert.rejects(decodeShareCode('z:' + 'A'.repeat(SHARE_MAX_ENCODED_ACCEPTED)), /too large/);
    await assert.rejects(decodeShareCode('A'.repeat(SHARE_MAX_ENCODED_ACCEPTED + 1)), /too large/);
  });

  test('still decodes anything the encoder is allowed to produce', async () => {
    const code = 's("bd sd")\n'.repeat(4000); // ~44 kB of source
    const encoded = await encodeShareCode(code);
    assert.ok(encoded.length <= SHARE_MAX_ENCODED);
    assert.equal(await decodeShareCode(encoded), code);
  });
});

function makeShareStore({ records = {}, userPatterns = [] } = {}) {
  const recs = new Map(Object.entries(records));
  let idx = { lastOpen: null, userPatterns: [...userPatterns] };
  return {
    get: (n) => (recs.has(n) ? recs.get(n) : null),
    set: (n, r) => { recs.set(n, r); return true; },
    getIndex: () => structuredClone(idx),
    setIndex: (i) => { idx = structuredClone(i); },
    _records: recs,
  };
}

describe('share arrival', () => {
  const user = (code) => ({ code, modified: 't', isUserPattern: true });

  test('a new link lands as shared-<name>', () => {
    const store = makeShareStore();
    assert.deepEqual(
      resolveSharedArrival({ shared: { code: 'X', name: 'beat' }, store, patterns: {} }),
      { name: 'shared-beat', code: 'X', create: true },
    );
  });

  test("never overwrites the recipient's edited copy — a re-opened link gets a new name", () => {
    const store = makeShareStore({ records: { 'shared-beat': user('X plus an hour of edits') }, userPatterns: ['shared-beat'] });
    const r = resolveSharedArrival({ shared: { code: 'X', name: 'beat' }, store, patterns: {} });
    assert.deepEqual(r, { name: 'shared-beat-2', code: 'X', create: true });
  });

  test('a different link with the same name does not collide either', () => {
    const store = makeShareStore({ records: { 'shared-shared': user('first'), 'shared-shared-2': user('second') } });
    const r = resolveSharedArrival({ shared: { code: 'third', name: 'shared' }, store, patterns: {} });
    assert.equal(r.name, 'shared-shared-3');
    assert.equal(r.create, true);
  });

  test('re-opening an unedited link reuses the existing copy instead of piling up duplicates', () => {
    const store = makeShareStore({ records: { 'shared-beat': user('edited'), 'shared-beat-2': user('X') } });
    assert.deepEqual(
      resolveSharedArrival({ shared: { code: 'X', name: 'beat' }, store, patterns: {} }),
      { name: 'shared-beat-2', code: 'X', create: false },
    );
  });

  test("the sharer's own link resolves to the pattern it came from when unchanged", () => {
    const store = makeShareStore({ records: { 'my-song': user('X') }, userPatterns: ['my-song'] });
    assert.deepEqual(
      resolveSharedArrival({ shared: { code: 'X', name: 'my-song' }, store, patterns: {} }),
      { name: 'my-song', code: 'X', create: false },
    );
    // …and a Demo everyone has, likewise — unless a local working copy differs.
    assert.equal(resolveSharedArrival({ shared: { code: 'DEMO', name: '01-demo' }, store, patterns: { '01-demo': 'DEMO' } }).name, '01-demo');
    store.set('01-demo', { code: 'DEMO edited', modified: 't', isUserPattern: false });
    assert.equal(resolveSharedArrival({ shared: { code: 'DEMO', name: '01-demo' }, store, patterns: { '01-demo': 'DEMO' } }).name, 'shared-01-demo');
  });

  test('never lands on a shipped pattern name', () => {
    const store = makeShareStore();
    const r = resolveSharedArrival({ shared: { code: 'X', name: 'beat' }, store, patterns: { 'shared-beat': 'DEMO' } });
    assert.equal(r.name, 'shared-beat-2');
  });

  test('sanitises and bounds the name', () => {
    const store = makeShareStore();
    const r = resolveSharedArrival({ shared: { code: 'X', name: '../<b>my song</b>' + 'x'.repeat(80) }, store, patterns: {} });
    assert.match(r.name, /^[a-z0-9_-]+$/i);
    assert.ok(r.name.length <= 40);
  });

  test('adopting writes the record, lists it in the library, then clears the hash', () => {
    const store = makeShareStore({ userPatterns: ['mine'] });
    let cleared = 0;
    const r = adoptSharedPattern({ shared: { code: 'X', name: 'beat' }, store, patterns: {}, clearHash: () => { cleared++; } });
    assert.deepEqual(r, { name: 'shared-beat', code: 'X', saved: true, created: true });
    assert.equal(store.get('shared-beat').code, 'X');
    assert.equal(store.get('shared-beat').isUserPattern, true);
    assert.deepEqual(store.getIndex().userPatterns, ['mine', 'shared-beat']);
    assert.equal(cleared, 1);
  });

  test('after adoption a reload (no hash) plus edits can never be clobbered by the same link', () => {
    const store = makeShareStore();
    const link = { code: 'X', name: 'beat' };
    adoptSharedPattern({ shared: link, store, patterns: {}, clearHash: () => {} });
    store.set('shared-beat', { ...store.get('shared-beat'), code: 'X edited' });
    const again = adoptSharedPattern({ shared: link, store, patterns: {}, clearHash: () => {} });
    assert.equal(again.name, 'shared-beat-2');
    assert.equal(store.get('shared-beat').code, 'X edited');
    assert.deepEqual(store.getIndex().userPatterns, ['shared-beat', 'shared-beat-2']);
  });

  test('adopting an existing but unlisted copy lists it', () => {
    const store = makeShareStore({ records: { 'shared-beat': user('X') } });
    const r = adoptSharedPattern({ shared: { code: 'X', name: 'beat' }, store, patterns: {}, clearHash: () => {} });
    assert.equal(r.created, false);
    assert.deepEqual(store.getIndex().userPatterns, ['shared-beat']);
  });

  test('the hash is kept when storage only lasts for the session', () => {
    const store = makeShareStore();
    let cleared = 0;
    const r = adoptSharedPattern({
      shared: { code: 'X', name: 'beat' }, store, patterns: {},
      clearHash: () => { cleared++; },
      isEphemeral: () => true,
    });
    assert.equal(r.saved, true);
    assert.equal(store.get('shared-beat').code, 'X');
    assert.equal(cleared, 0, 'the link is still the only durable copy');
  });

  test('the hash is kept when the pattern could not be stored', () => {
    const store = makeShareStore();
    store.set = () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; };
    let cleared = 0;
    const r = adoptSharedPattern({ shared: { code: 'X', name: 'beat' }, store, patterns: {}, clearHash: () => { cleared++; } });
    assert.equal(r.saved, false);
    assert.equal(r.code, 'X');
    assert.equal(cleared, 0);
    assert.deepEqual(store.getIndex().userPatterns, []);
  });
});
