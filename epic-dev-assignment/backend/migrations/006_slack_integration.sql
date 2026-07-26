-- Focus Flow — allow Slack in org_integrations
--
-- The standup bot's Slack credentials (bot token, signing secret, optional
-- analyzer webhook) move out of the bot's .env and into the same encrypted,
-- per-org store as Jira and GitHub, so an org admin can paste them from the
-- Integrations UI instead of editing a file on the server.
--
-- This does NOT make the bot multi-workspace (D6 still holds): one deployment
-- still serves one workspace, bound to one org via STANDUP_ORG_ID. It only
-- changes where that workspace's credentials live.

ALTER TABLE org_integrations DROP CONSTRAINT IF EXISTS org_integrations_provider_check;

ALTER TABLE org_integrations
  ADD CONSTRAINT org_integrations_provider_check
  CHECK (provider IN ('jira', 'github', 'slack'));
