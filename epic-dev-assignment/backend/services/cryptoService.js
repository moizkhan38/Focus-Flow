import crypto from 'node:crypto';

// Envelope encryption for per-org integration credentials (Phase 2, step 2.2).
//
// Two-layer ("envelope") scheme:
//   1. A fresh random 32-byte Data Encryption Key (DEK) is generated per secret
//      and encrypts the JSON payload with AES-256-GCM.
//   2. That DEK is itself encrypted ("wrapped") with the master Key-Encryption
//      Key (KEK) read from CREDENTIALS_MASTER_KEY, also AES-256-GCM.
// Only the wrapped DEK and the payload ciphertext are ever stored. The plaintext
// DEK exists solely in memory for the duration of an encrypt/decrypt call.
//
// ─── KMS SWAP SEAM ──────────────────────────────────────────────────────────
// To move key custody to a KMS/HSM later, replace ONLY the bodies of wrapDek()
// and unwrapDek() with KMS Encrypt/Decrypt calls (so the KEK never leaves the
// KMS). Nothing else in this file — and none of its callers — needs to change.
// ────────────────────────────────────────────────────────────────────────────

const ENVELOPE_VERSION = 1;    // bump if the stored blob's shape changes
const CURRENT_KEY_VERSION = 1; // which master key wrapped the DEK (rotation seam)
const KEY_BYTES = 32;          // AES-256
const IV_BYTES = 12;           // 96-bit nonce — recommended size for GCM

let cachedMasterKey = null;

function loadMasterKey() {
  const raw = process.env.CREDENTIALS_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'CREDENTIALS_MASTER_KEY is not set. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
      'then set it in the backend .env. Keep a secure backup — losing it makes ' +
      'every stored integration credential permanently unrecoverable.'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIALS_MASTER_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
      'Generate a valid one with ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))".'
    );
  }
  return key;
}

function getMasterKey() {
  if (!cachedMasterKey) cachedMasterKey = loadMasterKey();
  return cachedMasterKey;
}

// Boot-time fail-fast primitive. The integrations route (step 2.4) calls this at
// mount so a missing/malformed master key crashes the server loudly at startup
// rather than at the first credential save.
export function assertMasterKey() {
  try {
    getMasterKey();
  } catch (err) {
    console.error(`[cryptoService] ${err.message}`);
    process.exit(1);
  }
}

// ─── internal AES-256-GCM primitives ───────────────────────────────────────
function aesEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ct };
}

function aesDecrypt(key, iv, tag, ct) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag); // GCM: throws on final() if the tag/ciphertext was tampered
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ─── KMS SWAP SEAM: wrap/unwrap the DEK with the master key ─────────────────
// Replace the bodies of these two functions (only) to delegate to a KMS.
function wrapDek(dek) {
  const { iv, tag, ct } = aesEncrypt(getMasterKey(), dek);
  return { dekIv: iv, dekTag: tag, dekCt: ct };
}

function unwrapDek({ dekIv, dekTag, dekCt }) {
  return aesDecrypt(getMasterKey(), dekIv, dekTag, dekCt);
}

// ─── public API ─────────────────────────────────────────────────────────────

// encryptJson(obj) → opaque envelope string (safe to store in org_integrations.ciphertext)
export function encryptJson(obj) {
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const dek = crypto.randomBytes(KEY_BYTES);
  const payload = aesEncrypt(dek, plaintext);
  const wrapped = wrapDek(dek);
  const blob = {
    v: ENVELOPE_VERSION,
    kv: CURRENT_KEY_VERSION,
    dekIv: wrapped.dekIv.toString('base64'),
    dekTag: wrapped.dekTag.toString('base64'),
    dekCt: wrapped.dekCt.toString('base64'),
    iv: payload.iv.toString('base64'),
    tag: payload.tag.toString('base64'),
    ct: payload.ct.toString('base64'),
  };
  return JSON.stringify(blob);
}

// decryptJson(string) → original object. Throws if the envelope is malformed,
// an unsupported version, or fails GCM authentication (tampering / wrong key).
export function decryptJson(str) {
  let blob;
  try {
    blob = JSON.parse(str);
  } catch {
    throw new Error('Malformed credential envelope (not JSON).');
  }
  if (!blob || blob.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported credential envelope version: ${blob ? blob.v : 'null'}`);
  }
  const dek = unwrapDek({
    dekIv: Buffer.from(blob.dekIv, 'base64'),
    dekTag: Buffer.from(blob.dekTag, 'base64'),
    dekCt: Buffer.from(blob.dekCt, 'base64'),
  });
  const plaintext = aesDecrypt(
    dek,
    Buffer.from(blob.iv, 'base64'),
    Buffer.from(blob.tag, 'base64'),
    Buffer.from(blob.ct, 'base64'),
  );
  return JSON.parse(plaintext.toString('utf8'));
}

// The key version stamped on newly-encrypted secrets. credentialProvider (2.3)
// mirrors this into org_integrations.key_version so rotation tooling can find
// rows wrapped by an old key without decrypting them.
export const CURRENT_KEY_VERSION_OUT = CURRENT_KEY_VERSION;
