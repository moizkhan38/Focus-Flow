import 'dotenv/config';
import { pool, query } from '../db.js';
import { encryptJson, decryptJson, envelopeVersion, ENVELOPE_VERSION_OUT } from '../services/cryptoService.js';

// Re-encrypt stored integration credentials as v2 envelopes, bound to their
// (org_id, provider) via GCM additional authenticated data.
//
// WHY: a v1 envelope authenticates its bytes but not the row it belongs to, so
// anyone with DB WRITE access could copy another tenant's blob into their own
// row and have the backend drive that tenant's Jira/GitHub as them — without
// ever holding CREDENTIALS_MASTER_KEY. After this runs, a relocated blob fails
// to authenticate and is inert.
//
// SAFETY: reads and rewrites one row at a time inside a transaction, verifies the
// new envelope decrypts back to the identical payload BEFORE committing, and
// never prints secret material. Rerunnable — v2 rows are skipped.
//
//   node scripts/rewrap-credentials.js          # migrate
//   node scripts/rewrap-credentials.js --check  # report only, no writes

const checkOnly = process.argv.includes('--check');

async function main() {
  const { rows } = await query(
    'SELECT org_id, provider, ciphertext FROM org_integrations ORDER BY org_id, provider'
  );

  const legacy = rows.filter((r) => envelopeVersion(r.ciphertext) !== ENVELOPE_VERSION_OUT);
  console.log(
    `${rows.length} credential row(s); ${legacy.length} still on a pre-v${ENVELOPE_VERSION_OUT} envelope.`
  );

  if (checkOnly || legacy.length === 0) {
    if (!checkOnly && rows.length) console.log('Nothing to do — all rows are context-bound.');
    return;
  }

  let migrated = 0;
  for (const row of legacy) {
    const { org_id: orgId, provider } = row;
    const label = `${orgId}/${provider}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Re-read inside the transaction so a concurrent save is not clobbered.
      const { rows: locked } = await client.query(
        'SELECT ciphertext FROM org_integrations WHERE org_id = $1 AND provider = $2 FOR UPDATE',
        [orgId, provider]
      );
      if (locked.length === 0) {
        await client.query('ROLLBACK');
        console.log(`  ${label}: row vanished, skipped`);
        continue;
      }
      const current = locked[0].ciphertext;
      if (envelopeVersion(current) === ENVELOPE_VERSION_OUT) {
        await client.query('ROLLBACK');
        console.log(`  ${label}: already migrated by another run, skipped`);
        continue;
      }

      const payload = decryptJson(current, { orgId, provider });
      const rewrapped = encryptJson(payload, { orgId, provider });

      // Prove the new envelope is readable in its own right before committing.
      const verified = decryptJson(rewrapped, { orgId, provider });
      if (JSON.stringify(verified) !== JSON.stringify(payload)) {
        throw new Error('verification failed — re-encrypted payload does not round-trip');
      }

      await client.query(
        'UPDATE org_integrations SET ciphertext = $3 WHERE org_id = $1 AND provider = $2',
        [orgId, provider, rewrapped]
      );
      await client.query('COMMIT');
      migrated++;
      console.log(`  ${label}: rewrapped -> v${ENVELOPE_VERSION_OUT}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  ${label}: FAILED (${err.message}) — left untouched`);
    } finally {
      client.release();
    }
  }

  console.log(`\nDone. ${migrated}/${legacy.length} row(s) migrated.`);
  if (migrated < legacy.length) {
    console.error('Some rows could not be migrated. They still decrypt, but remain relocatable.');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
