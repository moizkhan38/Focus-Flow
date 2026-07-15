// Claim legacy (pre-tenancy) rows for a Clerk organization.
// Usage: node scripts/backfill-org.js org_xxxxxxxxxxxx
import 'dotenv/config';
import { pool, query } from '../db.js';

const orgId = process.argv[2];
if (!orgId || !orgId.startsWith('org_')) {
  console.error('Usage: node scripts/backfill-org.js <clerk-org-id>   (starts with "org_")');
  process.exit(1);
}

const TABLES = ['projects', 'developers', 'standups', 'retrospectives', 'assignments'];

try {
  for (const t of TABLES) {
    const r = await query(`UPDATE ${t} SET org_id = $1 WHERE org_id IS NULL`, [orgId]);
    console.log(`[Backfill] ${t}: ${r.rowCount} row(s) claimed`);
  }
  console.log(`[Backfill] Done — legacy rows now belong to ${orgId}`);
} finally {
  await pool.end();
}
