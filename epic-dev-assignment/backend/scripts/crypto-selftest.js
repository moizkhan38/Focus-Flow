// Sanity check for services/cryptoService.js — envelope round-trip, opacity,
// tamper detection, and wrong-key rejection. Run:  node scripts/crypto-selftest.js
//
// Uses the configured CREDENTIALS_MASTER_KEY if present; otherwise generates an
// ephemeral one for this run so the crypto logic can be exercised on a fresh
// checkout. (The real boot-time key requirement lives in
// cryptoService.assertMasterKey(), wired by the integrations route in step 2.4.)
import crypto from 'node:crypto';

if (!process.env.CREDENTIALS_MASTER_KEY) {
  process.env.CREDENTIALS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  console.log('[selftest] CREDENTIALS_MASTER_KEY not set — using an ephemeral key for this run.');
}

const { encryptJson, decryptJson } = await import('../services/cryptoService.js');

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

// A representative Jira credential payload (fake values).
const secret = { domain: 'acme.atlassian.net', email: 'a@acme.io', apiToken: 'ATATT-not-a-real-token' };
const blob = encryptJson(secret);

// 1. Round-trip fidelity
check('round-trip preserves the payload', JSON.stringify(decryptJson(blob)) === JSON.stringify(secret));

// 2. Opacity — no plaintext substring leaks into the stored blob
check('envelope leaks no plaintext', !blob.includes('atlassian.net') && !blob.includes('ATATT'));

// 3. Envelope shape
const parsed = JSON.parse(blob);
check('envelope has all expected fields',
  ['v', 'kv', 'dekIv', 'dekTag', 'dekCt', 'iv', 'tag', 'ct'].every((k) => k in parsed));

// 4. Tamper the payload ciphertext → GCM auth must reject
const t1 = { ...parsed };
const ct = Buffer.from(t1.ct, 'base64'); ct[0] ^= 0x01; t1.ct = ct.toString('base64');
let threw1 = false;
try { decryptJson(JSON.stringify(t1)); } catch { threw1 = true; }
check('tampered payload ciphertext is rejected', threw1);

// 5. Tamper the wrapped DEK → unwrap must reject
const t2 = { ...parsed };
const dk = Buffer.from(t2.dekCt, 'base64'); dk[0] ^= 0x01; t2.dekCt = dk.toString('base64');
let threw2 = false;
try { decryptJson(JSON.stringify(t2)); } catch { threw2 = true; }
check('tampered wrapped-DEK is rejected', threw2);

// 6. A different master key cannot decrypt (fresh module instance, new key)
process.env.CREDENTIALS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
const other = await import(`../services/cryptoService.js?k=${parsed.iv}`);
let threw3 = false;
try { other.decryptJson(blob); } catch { threw3 = true; }
check('a different master key cannot decrypt', threw3);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
