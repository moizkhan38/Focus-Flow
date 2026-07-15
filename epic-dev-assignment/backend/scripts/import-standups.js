import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default to the repo's standup-bot data file; override with an explicit path:
//   node scripts/import-standups.js /path/to/standup_data.json
const JSON_PATH = process.argv[2]
  || path.resolve(__dirname, '..', '..', '..', 'standup-bot', 'standup_data.json');

async function run() {
  console.log(`[Import] Reading ${JSON_PATH}`);
  const raw = await fs.readFile(JSON_PATH, 'utf8');
  const entries = JSON.parse(raw);
  console.log(`[Import] Found ${entries.length} standup entries`);

  let imported = 0, skipped = 0;
  for (const e of entries) {
    try {
      // Normalize timestamp — some are "YYYY-MM-DD HH:MM:SS.ffffff", some ISO
      let ts = e.timestamp;
      if (ts && !ts.includes('T')) ts = ts.replace(' ', 'T') + 'Z';

      await query(
        `INSERT INTO standups
          (user_id, project_key, timestamp, yesterday, today, blocker,
           is_blocker, blocker_details, sentiment, finished_tickets, today_tickets,
           full_text, raw_analysis)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          e.user_id || 'unknown',
          e.project_key || null,
          ts || null,
          e.ai_summary_yesterday || null,
          e.ai_summary_today || null,
          e.blocker_summary || null,
          !!e.is_blocker,
          e.blocker_details || (e.blocker_type ? { type: e.blocker_type, impact: e.impact } : null),
          e.sentiment || null,
          e.finished_tickets || null,
          e.today_tickets || null,
          e.full_text || null,
          e, // keep the raw record for reference
        ]
      );
      imported++;
    } catch (err) {
      console.warn(`[Import] Skipped entry (${err.message})`);
      skipped++;
    }
  }

  console.log(`[Import] ✓ Imported: ${imported}, Skipped: ${skipped}`);
  await pool.end();
}

run().catch(err => {
  console.error('[Import] Failed:', err.message);
  process.exit(1);
});
