import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';
import { confirmTarget } from './confirmTarget.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function run() {
  if (!(await confirmTarget('Applying database migrations'))) {
    await pool.end();
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    // Tracking table so each migration is applied at most once, in order.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename)
    );

    const files = (await fs.readdir(MIGRATIONS_DIR))
      .filter(f => f.endsWith('.sql'))
      .sort();
    const pending = files.filter(f => !applied.has(f));
    console.log(`[Migrate] ${files.length} migration file(s), ${pending.length} pending`);

    for (const file of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[Migrate] Applying ${file}...`);
      try {
        // Each migration runs in its own transaction: a mid-file failure rolls
        // the whole file back so the schema never ends up half-migrated.
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[Migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed (rolled back): ${err.message}`);
      }
    }

    console.log('[Migrate] Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('[Migrate] Failed:', err.message);
  process.exit(1);
});
