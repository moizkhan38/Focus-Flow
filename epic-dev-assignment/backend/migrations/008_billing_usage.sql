-- Focus Flow — metered usage for plan limits (Billing)
--
-- Clerk owns *entitlement* (which plan an org is on, which features it has).
-- It does not know how many epics an org generated this month, so anything
-- metered is counted here.
--
-- One row per (org, metric, billing month). Incremented with an upsert, so a
-- burst of concurrent generations cannot lose counts the way read-modify-write
-- would. `period` is the first day of the UTC month the usage falls in, which
-- makes "this month's usage" a primary-key lookup and keeps history for support
-- questions ("we were charged for what?").

CREATE TABLE IF NOT EXISTS org_usage (
  org_id     TEXT NOT NULL,
  metric     TEXT NOT NULL,
  period     DATE NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, metric, period)
);

CREATE INDEX IF NOT EXISTS idx_org_usage_period ON org_usage(period);

DROP TRIGGER IF EXISTS org_usage_touch ON org_usage;
CREATE TRIGGER org_usage_touch BEFORE UPDATE ON org_usage
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
