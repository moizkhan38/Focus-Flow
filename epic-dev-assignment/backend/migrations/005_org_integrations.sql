-- Focus Flow — per-org integration credentials (Phase 2, step 2.1)
--
-- One row per (org, provider) holding that organization's own Jira / GitHub
-- credentials. `ciphertext` is the AES-256-GCM envelope produced by
-- services/cryptoService.js (step 2.2) — an opaque JSON string
-- ({v, kv, dekIv, dekTag, dekCt, iv, tag, ct}, all base64). Plaintext
-- credentials MUST NEVER be written to this table.
--
-- key_version tracks which master key wrapped the DEK, so a future key
-- rotation (or the KMS swap) can re-wrap rows without a schema change.
--
-- Note: the plan numbers this migration 004; 004 was taken by
-- developers_email (step 1.7), so it lands as 005.

CREATE TABLE IF NOT EXISTS org_integrations (
  org_id      TEXT NOT NULL,
  provider    TEXT NOT NULL CHECK (provider IN ('jira','github')),
  ciphertext  TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, provider)
);

-- The composite PK already indexes org_id as its leading column, so
-- "list this org's integrations" needs no extra index.

DROP TRIGGER IF EXISTS org_integrations_touch ON org_integrations;
CREATE TRIGGER org_integrations_touch BEFORE UPDATE ON org_integrations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
