-- Focus Flow — remember who filed a standup, not just their Slack id.
--
-- The dashboard renders `user_name || user_id`, and with no name on the row it
-- fell back to the raw Slack id ("U0A3MQDQTUP"), which nobody recognises as a
-- teammate.
--
-- The name has to be stored at write time rather than resolved at read time.
-- Standups used to be fetched from the bot, which enriched them via Slack's
-- users_info; they now come from Postgres, and the API layer has no Slack token
-- to look names up with — nor should it, since that would be a Slack API call
-- per row on every dashboard load.
--
-- Nullable on purpose: rows written before this column existed have no name to
-- backfill from, and Slack lookups can fail at write time. The UI already falls
-- back to the id.

ALTER TABLE standups ADD COLUMN IF NOT EXISTS user_name TEXT;
