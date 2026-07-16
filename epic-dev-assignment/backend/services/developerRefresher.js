import { query } from '../db.js';
import { githubClientFor } from './githubClientFor.js';
import { IntegrationNotConnectedError } from './credentialProvider.js';

/**
 * Re-fetch one org's developers from GitHub (using THAT org's token) and update
 * Postgres. Throws IntegrationNotConnectedError when the org has no GitHub
 * integration — callers on a request path surface that as 412.
 * Returns { total, updated, failed, errors[] }.
 */
export async function refreshDevelopersForOrg(orgId) {
  const gh = await githubClientFor(orgId);

  const { rows: devs } = await query(
    `SELECT org_id, username, jira_username FROM developers WHERE org_id = $1 ORDER BY updated_at ASC`,
    [orgId]
  );

  let updated = 0, failed = 0;
  const errors = [];

  for (const dev of devs) {
    try {
      const fresh = await gh.analyzeDeveloper(dev.username, dev.username, undefined);
      if (!fresh || fresh.error) {
        throw new Error(fresh?.error || 'analysis returned no data');
      }

      // Update — preserve user-edited jira_username and availability; keyed by
      // (org_id, username) since the same GitHub user can be on several rosters.
      await query(
        `UPDATE developers SET
            avatar_url        = $2,
            primary_expertise = $3,
            experience_level  = $4,
            top_skills        = $5,
            analysis          = $6
         WHERE username = $1 AND org_id = $7`,
        [
          dev.username,
          fresh.avatar || `https://avatars.githubusercontent.com/${dev.username}`,
          fresh.analysis?.expertise?.primary || null,
          fresh.analysis?.experienceLevel?.level || null,
          (fresh.analysis?.expertise?.technologies || []).slice(0, 6),
          fresh.analysis || null,
          dev.org_id,
        ]
      );
      updated++;
      console.log(`[DevRefresh] ✓ ${dev.username} — ${fresh.analysis?.totalCommits || 0} commits`);
    } catch (err) {
      failed++;
      errors.push({ username: dev.username, error: err.message });
      console.warn(`[DevRefresh] ✗ ${dev.username}: ${err.message}`);
    }
  }

  return { total: devs.length, updated, failed, errors };
}

/**
 * Daily cron job: refresh every org that has a GitHub integration, each with its
 * own token. Orgs without one are skipped (logged once) — their developers keep
 * whatever data they last had.
 * Returns a summary { total, updated, failed, skipped, errors[] }.
 */
export async function refreshAllDevelopers() {
  const startedAt = new Date();
  console.log(`[DevRefresh] Starting daily developer refresh at ${startedAt.toISOString()}`);

  let total = 0, updated = 0, failed = 0, skipped = 0;
  const errors = [];

  try {
    const { rows: orgs } = await query(`SELECT DISTINCT org_id FROM developers ORDER BY org_id`);
    console.log(`[DevRefresh] ${orgs.length} org(s) with developers`);

    for (const { org_id: orgId } of orgs) {
      try {
        const summary = await refreshDevelopersForOrg(orgId);
        total += summary.total;
        updated += summary.updated;
        failed += summary.failed;
        errors.push(...summary.errors.map((e) => ({ ...e, orgId })));
      } catch (err) {
        if (err instanceof IntegrationNotConnectedError) {
          // Expected for orgs that haven't connected GitHub — one line, not per developer.
          const { rows } = await query(
            `SELECT COUNT(*)::int AS n FROM developers WHERE org_id = $1`,
            [orgId]
          );
          skipped += rows[0]?.n || 0;
          total += rows[0]?.n || 0;
          console.log(`[DevRefresh] — ${orgId}: GitHub not connected, skipping ${rows[0]?.n || 0} developer(s)`);
        } else {
          failed++;
          errors.push({ orgId, username: '*', error: err.message });
          console.warn(`[DevRefresh] ✗ org ${orgId}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[DevRefresh] Fatal:`, err.message);
    errors.push({ username: '*', error: err.message });
  }

  const ms = Date.now() - startedAt.getTime();
  console.log(`[DevRefresh] Done in ${ms}ms — total=${total} updated=${updated} failed=${failed} skipped=${skipped}`);
  return { total, updated, failed, skipped, errors, ranAt: startedAt.toISOString(), durationMs: ms };
}
