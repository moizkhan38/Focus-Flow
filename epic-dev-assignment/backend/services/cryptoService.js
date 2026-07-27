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

// v2 binds the ciphertext to its (org_id, provider) with GCM additional
// authenticated data. v1 (no AAD) is still ACCEPTED on read so existing rows keep
// working; run scripts/rewrap-credentials.js to migrate them.
const ENVELOPE_VERSION = 2;    // what new writes produce
const LEGACY_VERSION = 1;      // accepted on read only
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
  // The length check alone is not enough. Node's base64 decoder silently drops
  // characters outside the alphabet, so a memorable passphrase of the right
  // rough shape — 'focus-flow-prod-credentials-master-key-2026' — also decodes
  // to 32 bytes and passed, yielding a key with tens of bits of guessable
  // entropy instead of 256 while the startup check reported success. Requiring
  // the value to round-trip means only canonical base64 of 32 real bytes is
  // accepted.
  if (key.toString('base64') !== raw.trim()) {
    throw new Error(
      'CREDENTIALS_MASTER_KEY is not canonical base64 — it looks like a passphrase, ' +
      'or characters were lost in transit. It must be the exact 44-character output of:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
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

// ─── context binding (AAD) ─────────────────────────────────────────────────
// GCM authenticates the bytes, but nothing tied those bytes to the ROW they were
// written for. decryptJson() received only the blob, so an envelope lifted from
// one tenant's row and pasted into another's decrypted perfectly and was then
// used as that tenant's credential — turning DB-write access (which cannot forge
// or read an envelope) into full cross-tenant credential USE.
//
// Feeding org_id and provider as additional authenticated data folds them into
// the auth tag. The ciphertext is unchanged, but decryption now fails unless the
// row identity presented at read time matches the one used at write time, so a
// relocated blob is inert.
function aad({ orgId, provider }) {
  return Buffer.from(`ff-cred|v${ENVELOPE_VERSION}|${orgId}|${provider}`, 'utf8');
}

function requireContext(context, op) {
  const orgId = context?.orgId;
  const provider = context?.provider;
  if (!orgId || !provider) {
    throw new Error(
      `cryptoService.${op} requires { orgId, provider } — the envelope is bound to its row.`
    );
  }
  return { orgId, provider };
}

// ─── internal AES-256-GCM primitives ───────────────────────────────────────
// `ad` is optional so legacy v1 envelopes (written before context binding) can
// still be read back; every new write passes one.
function aesEncrypt(key, plaintext, ad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (ad) cipher.setAAD(ad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ct };
}

function aesDecrypt(key, iv, tag, ct, ad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (ad) decipher.setAAD(ad);
  decipher.setAuthTag(tag); // GCM: throws on final() if the tag/ciphertext was tampered
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ─── KMS SWAP SEAM: wrap/unwrap the DEK with the master key ─────────────────
// Replace the bodies of these two functions (only) to delegate to a KMS.
// The DEK is bound to the same context as the payload, so an attacker cannot
// mix a relocated payload with a legitimately-wrapped DEK either.
function wrapDek(dek, ad) {
  const { iv, tag, ct } = aesEncrypt(getMasterKey(), dek, ad);
  return { dekIv: iv, dekTag: tag, dekCt: ct };
}

function unwrapDek({ dekIv, dekTag, dekCt }, ad) {
  return aesDecrypt(getMasterKey(), dekIv, dekTag, dekCt, ad);
}

// ─── public API ─────────────────────────────────────────────────────────────

// encryptJson(obj, { orgId, provider }) → opaque envelope string
// (safe to store in org_integrations.ciphertext for exactly that row).
export function encryptJson(obj, context) {
  const ctx = requireContext(context, 'encryptJson');
  const ad = aad(ctx);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const dek = crypto.randomBytes(KEY_BYTES);
  const payload = aesEncrypt(dek, plaintext, ad);
  const wrapped = wrapDek(dek, ad);
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
export function decryptJson(str, context) {
  let blob;
  try {
    blob = JSON.parse(str);
  } catch {
    throw new Error('Malformed credential envelope (not JSON).');
  }
  if (!blob || (blob.v !== ENVELOPE_VERSION && blob.v !== LEGACY_VERSION)) {
    throw new Error(`Unsupported credential envelope version: ${blob ? blob.v : 'null'}`);
  }

  // v1 predates context binding and carries no AAD. Read it so an upgrade does
  // not lock anyone out of their own credentials; scripts/rewrap-credentials.js
  // converts these to v2. Until it has run, those rows remain relocatable.
  const legacy = blob.v === LEGACY_VERSION;
  if (legacy) warnLegacyOnce();
  const ad = legacy ? null : aad(requireContext(context, 'decryptJson'));

  const dek = unwrapDek({
    dekIv: Buffer.from(blob.dekIv, 'base64'),
    dekTag: Buffer.from(blob.dekTag, 'base64'),
    dekCt: Buffer.from(blob.dekCt, 'base64'),
  }, ad);
  const plaintext = aesDecrypt(
    dek,
    Buffer.from(blob.iv, 'base64'),
    Buffer.from(blob.tag, 'base64'),
    Buffer.from(blob.ct, 'base64'),
    ad,
  );
  return JSON.parse(plaintext.toString('utf8'));
}

// Which envelope version a stored blob uses, without decrypting it. Used by the
// rewrap script to find rows still on v1.
export function envelopeVersion(str) {
  try {
    return JSON.parse(str)?.v ?? null;
  } catch {
    return null;
  }
}

let legacyWarned = false;
function warnLegacyOnce() {
  if (legacyWarned) return;
  legacyWarned = true;
  console.warn(
    '[cryptoService] Reading a v1 credential envelope (no context binding). ' +
    'Run `node scripts/rewrap-credentials.js` to re-encrypt stored credentials ' +
    'bound to their (org_id, provider).'
  );
}

export const ENVELOPE_VERSION_OUT = ENVELOPE_VERSION;

// The key version stamped on newly-encrypted secrets. credentialProvider (2.3)
// mirrors this into org_integrations.key_version so rotation tooling can find
// rows wrapped by an old key without decrypting them.
export const CURRENT_KEY_VERSION_OUT = CURRENT_KEY_VERSION;
