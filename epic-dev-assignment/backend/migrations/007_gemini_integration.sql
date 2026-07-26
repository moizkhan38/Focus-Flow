-- Focus Flow — allow Gemini in org_integrations
--
-- Per decision D5 the Gemini key stays PLATFORM-OWNED: AI generation is the
-- product, and the platform absorbs its cost. This migration does not reverse
-- that. It adds an OPTIONAL per-organization override so an org that has hit
-- the free-tier quota, or that wants its usage billed to its own Google Cloud
-- project, can supply its own key.
--
-- Resolution order at generation time:
--   1. the org's stored key (if it connected one here)
--   2. the platform GEMINI_API_KEY in the Flask service's environment
--
-- An org that connects nothing behaves exactly as before.

ALTER TABLE org_integrations DROP CONSTRAINT IF EXISTS org_integrations_provider_check;

ALTER TABLE org_integrations
  ADD CONSTRAINT org_integrations_provider_check
  CHECK (provider IN ('jira', 'github', 'slack', 'gemini'));
