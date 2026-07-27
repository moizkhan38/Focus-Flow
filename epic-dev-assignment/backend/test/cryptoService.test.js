import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// The envelope must hold up in the unit run, not only in scripts/crypto-selftest.js
// (G2 item 6). An ephemeral master key keeps this hermetic — a fresh checkout with
// no .env still exercises the crypto.
process.env.CREDENTIALS_MASTER_KEY ||= crypto.randomBytes(32).toString('base64');

const { encryptJson, decryptJson, envelopeVersion } = await import('../services/cryptoService.js');

const SECRET = { domain: 'acme.atlassian.net', email: 'you@acme.com', apiToken: 'ATATT-super-secret' };
const CTX = { orgId: 'org_acme', provider: 'jira' };

test('round-trips a credential payload', () => {
  assert.deepEqual(decryptJson(encryptJson(SECRET, CTX), CTX), SECRET);
});

test('ciphertext is opaque — no plaintext survives in the blob', () => {
  const blob = encryptJson(SECRET, CTX);
  for (const leak of ['acme.atlassian.net', 'you@acme.com', 'ATATT-super-secret']) {
    assert.ok(!blob.includes(leak), `blob leaked ${leak}`);
  }
});

test('the same secret never encrypts to the same blob twice', () => {
  // Random DEK + random IV per save: two orgs using the same token, or one org
  // re-saving an unchanged token, must not be linkable by anyone reading the table.
  assert.notEqual(encryptJson(SECRET, CTX), encryptJson(SECRET, CTX));
});

test('envelope has the documented shape', () => {
  const env = JSON.parse(encryptJson(SECRET, CTX));
  for (const k of ['v', 'kv', 'dekIv', 'dekTag', 'dekCt', 'iv', 'tag', 'ct']) {
    assert.ok(env[k] !== undefined, `missing ${k}`);
  }
});

test('rejects a tampered payload (GCM auth tag)', () => {
  const env = JSON.parse(encryptJson(SECRET, CTX));
  const ct = Buffer.from(env.ct, 'base64');
  ct[0] ^= 0xff;
  env.ct = ct.toString('base64');
  assert.throws(() => decryptJson(JSON.stringify(env), CTX));
});

test('rejects a tampered DEK', () => {
  const env = JSON.parse(encryptJson(SECRET, CTX));
  const dek = Buffer.from(env.dekCt, 'base64');
  dek[0] ^= 0xff;
  env.dekCt = dek.toString('base64');
  assert.throws(() => decryptJson(JSON.stringify(env), CTX));
});

test('rejects a blob wrapped by a different master key', async () => {
  const blob = encryptJson(SECRET, CTX);
  const original = process.env.CREDENTIALS_MASTER_KEY;
  try {
    process.env.CREDENTIALS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    // Fresh module instance so it reads the swapped key.
    const other = await import(`../services/cryptoService.js?rotated=${Date.now()}`);
    assert.throws(() => other.decryptJson(blob, CTX));
  } finally {
    process.env.CREDENTIALS_MASTER_KEY = original;
  }
});

// ─── context binding (AAD) ──────────────────────────────────────────────────
// These are the regression tests for the cross-tenant relocation attack: someone
// with DB write but no master key copying another org's envelope into their row.

test('a blob cannot be relocated to a different org', () => {
  const blob = encryptJson(SECRET, { orgId: 'org_victim', provider: 'jira' });
  assert.throws(
    () => decryptJson(blob, { orgId: 'org_attacker', provider: 'jira' }),
    /unable to authenticate|Unsupported state/i
  );
});

test('a blob cannot be relocated to a different provider', () => {
  const blob = encryptJson(SECRET, { orgId: 'org_acme', provider: 'jira' });
  assert.throws(
    () => decryptJson(blob, { orgId: 'org_acme', provider: 'github' }),
    /unable to authenticate|Unsupported state/i
  );
});

test('encrypt and decrypt both refuse to run without a row context', () => {
  assert.throws(() => encryptJson(SECRET), /requires \{ orgId, provider \}/);
  const blob = encryptJson(SECRET, CTX);
  assert.throws(() => decryptJson(blob), /requires \{ orgId, provider \}/);
  assert.throws(() => decryptJson(blob, { orgId: 'org_acme' }), /requires \{ orgId, provider \}/);
});

test('new writes are v2 envelopes', () => {
  assert.equal(envelopeVersion(encryptJson(SECRET, CTX)), 2);
});

test('legacy v1 envelopes are still readable so an upgrade locks nobody out', () => {
  // Hand-build a v1 blob the way the pre-AAD code did: no setAAD on either layer.
  const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
  const enc = (k, pt) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    return { iv, tag: c.getAuthTag(), ct };
  };
  const dek = crypto.randomBytes(32);
  const payload = enc(dek, Buffer.from(JSON.stringify(SECRET), 'utf8'));
  const wrapped = enc(key, dek);
  const v1 = JSON.stringify({
    v: 1, kv: 1,
    dekIv: wrapped.iv.toString('base64'),
    dekTag: wrapped.tag.toString('base64'),
    dekCt: wrapped.ct.toString('base64'),
    iv: payload.iv.toString('base64'),
    tag: payload.tag.toString('base64'),
    ct: payload.ct.toString('base64'),
  });

  assert.equal(envelopeVersion(v1), 1);
  assert.deepEqual(decryptJson(v1, CTX), SECRET);
});

test('rejects an unknown envelope version', () => {
  const env = JSON.parse(encryptJson(SECRET, CTX));
  env.v = 99;
  assert.throws(() => decryptJson(JSON.stringify(env), CTX), /Unsupported credential envelope version/);
});

test('rejects a master key that is a passphrase rather than canonical base64', async () => {
  const original = process.env.CREDENTIALS_MASTER_KEY;
  try {
    // Decodes to exactly 32 bytes because Node's base64 decoder drops the
    // out-of-alphabet characters — the length check alone let this through.
    const passphrase = 'focus-flow-prod-credentials-master-key-2026';
    assert.equal(Buffer.from(passphrase, 'base64').length, 32, 'precondition');
    process.env.CREDENTIALS_MASTER_KEY = passphrase;
    const weak = await import(`../services/cryptoService.js?weak=${Date.now()}`);
    assert.throws(() => weak.encryptJson(SECRET, CTX), /not canonical base64/);
  } finally {
    process.env.CREDENTIALS_MASTER_KEY = original;
  }
});
