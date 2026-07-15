-- Focus Flow — developer email (Phase 1, step 1.7)
-- The frontend roster tracks each developer's Jira account email (used for Jira
-- invitations and assignee lookup). It previously lived only in localStorage.

ALTER TABLE developers ADD COLUMN IF NOT EXISTS email TEXT;
