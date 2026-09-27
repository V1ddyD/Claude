-- =============================================================================
-- 0011 — "Done": a customer who has been taken care of.
--
-- A lead's status says where it is in the sale; it does not say whether
-- anybody still needs to do anything about it. A customer who asked about
-- opening hours and was answered is not "won" or "lost", but they should stop
-- appearing in the lists of people to call.
--
-- done_at is that: set when a member of staff marks the lead done, cleared
-- when they reopen it or when the customer gets in touch again. Every
-- to-do list in the portal leaves out leads with it set.
-- =============================================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS done_at timestamptz,
  ADD COLUMN IF NOT EXISTS done_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS leads_open_idx ON leads (tenant_id, priority) WHERE done_at IS NULL;
