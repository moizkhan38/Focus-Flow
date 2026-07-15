-- Focus Flow — enforce organization tenancy (Phase 1, step 1.6)
-- Requires 002 applied AND legacy rows backfilled (scripts/backfill-org.js).
-- Fresh installs run 001→002→003 with zero rows, which is trivially valid.

ALTER TABLE projects        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE developers      ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE standups        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE retrospectives  ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE assignments     ALTER COLUMN org_id SET NOT NULL;

-- Developers are per-org now (the same GitHub username can be on several
-- clients' rosters). Nothing FK-references developers(username) — verified
-- against 001_init.sql before this change.
ALTER TABLE developers DROP CONSTRAINT developers_pkey;
ALTER TABLE developers ADD PRIMARY KEY (org_id, username);
