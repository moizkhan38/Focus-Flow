-- Focus Flow — organization tenancy columns (Phase 1, step 1.5)
--
-- org_id holds the Clerk organization id (e.g. org_2abc...). Nullable at this
-- stage so existing single-tenant rows keep working; claim them with
--   node scripts/backfill-org.js <clerk-org-id>
-- 003_org_enforce.sql (step 1.6) sets NOT NULL + composite keys after backfill.

ALTER TABLE projects        ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE developers      ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE standups        ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE retrospectives  ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE assignments     ADD COLUMN IF NOT EXISTS org_id TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_org       ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_developers_org     ON developers(org_id);
CREATE INDEX IF NOT EXISTS idx_standups_org       ON standups(org_id);
CREATE INDEX IF NOT EXISTS idx_retrospectives_org ON retrospectives(org_id);
CREATE INDEX IF NOT EXISTS idx_assignments_org    ON assignments(org_id);
