import express from 'express';
import { sendServerError } from '../utils/httpError.js';
import { analyzeDeveloper } from '../services/githubService.js';
import { query } from '../db.js';

const router = express.Router();
// Auth: enforced by the default-closed /api gate in server.js.

// POST /api/analyze-developers - Analyze multiple developers
// Accepts either:
//   { developers: [{ username, owner?, repo? }] }
//   { github_usernames: ["user1", "user2"] }
router.post('/analyze-developers', async (req, res) => {
  try {
    let devList = req.body.developers;

    // Support simple string array from frontend
    if (!devList && Array.isArray(req.body.github_usernames)) {
      devList = req.body.github_usernames.map((u) => ({ username: u }));
    }

    if (!devList || !Array.isArray(devList)) {
      return res.status(400).json({
        success: false,
        error: 'developers array or github_usernames array is required'
      });
    }

    // Analyze all developers in parallel for speed
    const results = await Promise.all(
      devList
        .filter((dev) => {
          const username = typeof dev === 'string' ? dev : dev.username;
          return username && username.trim();
        })
        .map(async (dev) => {
          const username = typeof dev === 'string' ? dev : dev.username;
          try {
            return await analyzeDeveloper(
              username,
              dev.owner || username,
              dev.repo
            );
          } catch (error) {
            console.error(`Error analyzing ${username}:`, error);
            return { username, error: error.message };
          }
        })
    );

    // Flatten nested analysis fields so frontend can use dev.login, dev.primary_expertise, etc.
    const devs = results.filter(r => !r.error).map(r => ({
      ...r,
      login: r.username,
      avatar_url: r.avatar || `https://avatars.githubusercontent.com/${r.username}`,
      primary_expertise: r.analysis?.expertise?.primary || 'Full Stack',
      experience_level: r.analysis?.experienceLevel?.level || 'Junior',
      top_skills: (r.analysis?.expertise?.technologies || []).slice(0, 6),
    }));

    if (devs.length === 0 && devList.length > 0) {
      return res.status(422).json({
        success: false,
        error: 'All developer analyses failed. Check GitHub usernames and try again.',
        failedUsernames: results.filter(r => r.error).map(r => r.username)
      });
    }

    // Persist to Postgres so the daily refresh job can keep them up-to-date.
    // Best-effort — never fail the analysis response if the DB write fails.
    for (const d of devs) {
      try {
        await query(
          `INSERT INTO developers
             (org_id, username, avatar_url, primary_expertise, experience_level, top_skills, analysis)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (org_id, username) DO UPDATE SET
             avatar_url        = EXCLUDED.avatar_url,
             primary_expertise = EXCLUDED.primary_expertise,
             experience_level  = EXCLUDED.experience_level,
             top_skills        = EXCLUDED.top_skills,
             analysis          = EXCLUDED.analysis`,
          [req.orgId, d.username, d.avatar_url, d.primary_expertise, d.experience_level, d.top_skills, d.analysis || null]
        );
      } catch (err) {
        console.warn(`[Developers] DB upsert failed for ${d.username}: ${err.message}`);
      }
    }

    res.json({
      success: true,
      developers: devs
    });
  } catch (error) {
    sendServerError(res, error, 'Failed to analyze developers');
  }
});

export default router;
