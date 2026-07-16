import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// The envelope must hold up in the unit run, not only in scripts/crypto-selftest.js
// (G2 item 6). An ephemeral master key keeps this hermetic — a fresh checkout with
// no .env still exercises the crypto.
process.env.CREDENTIALS_MASTER_KEY ||= crypto.randomBytes(32).toString('base64');

const { encryptJson, decryptJson } = await import('../services/cryptoService.js');

const SECRET = { domain: 'acme.atlassian.net', email: 'you@acme.com', apiToken: 'ATATT-super-secret' };

test('round-trips a credential payload', () => {
  assert.deepEqual(decryptJson(encryptJson(SECRET)), SECRET);
});

test('ciphertext is opaque — no plaintext survives in the blob', () => {
  const blob = encryptJson(SECRET);
  for (const leak of ['acme.atlassian.net', 'you@acme.com', 'ATATT-super-secret']) {
    assert.ok(!blob.includes(leak), `blob leaked ${leak}`);
  }
});

test('envelope has the documented shape', () => {
  const env = JSON.parse(encryptJson(SECRET));
  for (const k of ['v', 'kv', 'dekIv', 'dekTag', 'dekCt', 'iv', 'tag', 'ct']) {
    assert.ok(env[k] !== undefined, `missing ${k}`);
  }
});

test('rejects a tampered payload (GCM auth tag)', () => {
  const env = JSON.parse(encryptJson(SECRET));
  const ct = Buffer.from(env.ct, 'base64');
  ct[0] ^= 0xff;
  env.ct = ct.toString('base64');
  assert.throws(() => decryptJson(JSON.stringify(env)));
});

test('rejects a tampered DEK', () => {
  const env = JSON.parse(encryptJson(SECRET));
  const dek = Buffer.from(env.dekCt, 'base64');
  dek[0] ^= 0xff;
  env.dekCt = dek.toString('base64');
  assert.throws(() => decryptJson(JSON.stringify(env)));
});

test('rejects a blob wrapped by a different master key', async () => {
  const blob = encryptJson(SECRET);
  const original = process.env.CREDENTIALS_MASTER_KEY;
  try {
    process.env.CREDENTIALS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    // Fresh module instance so it reads the swapped key.
    const other = await import(`../services/cryptoService.js?rotated=${Date.now()}`);
    assert.throws(() => other.decryptJson(blob));
  } finally {
    process.env.CREDENTIALS_MASTER_KEY = original;
  }
});
