import {
  FEATURES, METRICS, FREE_LIMITS,
  hasFeature, getUsage, countProjects, countDevelopers,
} from '../services/billing.js';
import { query } from '../db.js';

// Paywall guards.
//
// 402 Payment Required is the contract for "your plan doesn't cover this".
// Deliberately distinct from 403 (you lack the ROLE) and 412 (the provider isn't
// CONNECTED) — the frontend renders a different thing for each, and collapsing
// them would send an org admin to the Integrations page when they needed the
// pricing page, or vice versa.
//
// Every response carries `feature` (or `limit`) so the UI can name what to buy
// rather than showing a generic "upgrade" wall.

function upgradeRequired(res, { feature, message, limit, used }) {
  return res.status(402).json({
    success: false,
    error: 'UPGRADE_REQUIRED',
    feature: feature || null,
    limit: limit ?? null,
    used: used ?? null,
    message,
  });
}

// Gate a route on a paid feature.
export function requireFeature(feature, message) {
  return async (req, res, next) => {
    try {
      if (await hasFeature(req, feature)) return next();
      return upgradeRequired(res, { feature, message });
    } catch (err) {
      return next(err);
    }
  };
}

// Gate on the monthly AI allowance. Checked BEFORE the call, so an org cannot
// overshoot by the size of one request; recorded after success, so a failed
// generation doesn't consume quota the user got nothing for.
export async function requireAiQuota(req, res, next) {
  try {
    if (await hasFeature(req, FEATURES.UNLIMITED_AI)) return next();
    const used = await getUsage(req.orgId, METRICS.AI_GENERATIONS);
    const limit = FREE_LIMITS.aiGenerationsPerMonth;
    if (used >= limit) {
      return upgradeRequired(res, {
        feature: FEATURES.UNLIMITED_AI,
        limit,
        used,
        message:
          `You've used all ${limit} AI generations included this month. ` +
          'Upgrade for unlimited generation, or wait for the allowance to reset.',
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// Gate on the project allowance.
//
// Only NEW projects count. /db/projects is an upsert, so charging on every save
// would stop a free org editing the projects it is entitled to keep — the limit
// is on how many you may HAVE, not how often you may touch them.
export async function requireProjectQuota(req, res, next) {
  try {
    if (await hasFeature(req, FEATURES.UNLIMITED_PROJECTS)) return next();

    const id = req.body?.id;
    if (id) {
      const { rows } = await query(
        'SELECT 1 FROM projects WHERE id = $1 AND org_id = $2', [id, req.orgId]
      );
      if (rows.length) return next(); // updating something they already own
    }

    const used = await countProjects(req.orgId);
    const limit = FREE_LIMITS.projects;
    if (used >= limit) {
      return upgradeRequired(res, {
        feature: FEATURES.UNLIMITED_PROJECTS,
        limit,
        used,
        message:
          `Your plan includes ${limit} project${limit === 1 ? '' : 's'} and you have ${used}. ` +
          'Upgrade for unlimited projects, or delete one to make room.',
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// Gate on the developer-roster allowance, same "only new ones count" rule.
export async function requireDeveloperQuota(req, res, next) {
  try {
    if (await hasFeature(req, FEATURES.UNLIMITED_PROJECTS)) return next();

    const username = req.body?.username;
    if (username) {
      const { rows } = await query(
        'SELECT 1 FROM developers WHERE username = $1 AND org_id = $2', [username, req.orgId]
      );
      if (rows.length) return next();
    }

    const used = await countDevelopers(req.orgId);
    const limit = FREE_LIMITS.developers;
    if (used >= limit) {
      return upgradeRequired(res, {
        feature: FEATURES.UNLIMITED_PROJECTS,
        limit,
        used,
        message:
          `Your plan includes ${limit} team members and you have ${used}. ` +
          'Upgrade to add more.',
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}
