import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodeShareCode,
  decodeShareCode,
  SHARE_MAX_ENCODED,
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
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'patterns', 'mario-flowhacker.js'),
      'utf8',
    );
    const encoded = await encodeShareCode(raw);
    assert.ok(
      encoded.length < SHARE_MAX_ENCODED,
      `expected encoded mario to fit in ${SHARE_MAX_ENCODED}, got ${encoded.length}`,
    );
    assert.equal(await decodeShareCode(encoded), raw);
  });
});

function bytesToLegacyBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
