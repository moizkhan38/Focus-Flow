import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default to the repo's standup-bot data file; override with an explicit path:
//   node scripts/import-standups.js [/path/to/standup_data.json] [org_id]
const JSON_PATH = process.argv[2]
  || path.resolve(__dirname, '..', '..', '..', 'standup-bot', 'standup_data.json');

// standups.org_id is NOT NULL since 003_org_enforce. These rows predate tenancy,
// so the owning org has to come from configuration — the bot serves exactly one
// organization (D6), which is the same value the backend pins for the internal
// lane.
const ORG_ID = process.argv[3] || process.env.INTERNAL_ORG_ID || process.env.STANDUP_ORG_ID;

// The JSON was written by several generations of the bot. Field names drifted:
// early rows carry blocker_type/impact at the top level, later ones a
// blocker_details object, and the summaries were called ai_summary_* before the
// yesterday/today columns existed.
function normalize(e) {
  let ts = e.timestamp;
  if (ts && !ts.includes('T')) ts = ts.replace(' ', 'T') + 'Z';

  const details = e.blocker_details
    || (e.blocker_type ? { type: e.blocker_type, impact: e.impact } : null);

  return {
    user_id: e.user_id || 'unknown',
    project_key: e.project_key || null,
    timestamp: ts || null,
    yesterday: e.yesterday || e.ai_summary_yesterday || null,
    today: e.today || e.ai_summary_today || null,
    blocker: e.blocker || e.blocker_summary || details?.recommendation || null,
    is_blocker: !!e.is_blocker,
    blocker_details: details,
    sentiment: e.sentiment || null,
    finished_tickets: e.finished_tickets || null,
    today_tickets: e.today_tickets || null,
    full_text: e.full_text || null,
    raw_analysis: e.raw_analysis || e, // keep the raw record for reference
  };
}

async function run() {
  if (!ORG_ID) {
    console.error('[Import] No org id. Pass it as argv[3] or set INTERNAL_ORG_ID.');
    process.exit(1);
  }
  console.log(`[Import] Reading ${JSON_PATH}`);
  console.log(`[Import] Target org: ${ORG_ID}`);
  const raw = await fs.readFile(JSON_PATH, 'utf8');
  const entries = JSON.parse(raw);
  console.log(`[Import] Found ${entries.length} standup entries`);

  let imported = 0, duplicate = 0, skipped = 0;
  for (const entry of entries) {
    const r = normalize(entry);
    try {
      // Re-running the import must not duplicate history. (user_id, timestamp)
      // within an org identifies a submission — the bot writes one row per
      // /standup, and the timestamp has microsecond precision.
      const existing = await query(
        `SELECT 1 FROM standups WHERE org_id = $1 AND user_id = $2 AND timestamp = $3`,
        [ORG_ID, r.user_id, r.timestamp]
      );
      if (existing.rowCount > 0) { duplicate++; continue; }

      await query(
        `INSERT INTO standups
          (org_id, user_id, project_key, timestamp, yesterday, today, blocker,
           is_blocker, blocker_details, sentiment, finished_tickets, today_tickets,
           full_text, raw_analysis)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          ORG_ID, r.user_id, r.project_key, r.timestamp, r.yesterday, r.today,
          r.blocker, r.is_blocker, r.blocker_details, r.sentiment,
          r.finished_tickets, r.today_tickets, r.full_text, r.raw_analysis,
        ]
      );
      imported++;
    } catch (err) {
      console.warn(`[Import] Skipped entry ${r.timestamp} (${err.message})`);
      skipped++;
    }
  }

  console.log(`[Import] ✓ Imported: ${imported}, Already present: ${duplicate}, Skipped: ${skipped}`);
  await pool.end();
}

run().catch(err => {
  console.error('[Import] Failed:', err.message);
  process.exit(1);
});
