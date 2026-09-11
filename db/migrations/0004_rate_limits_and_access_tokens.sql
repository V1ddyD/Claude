-- =============================================================================
-- 0004 — Durable rate limiting, scoped customer access, and retention.
--
-- Three gaps that only show up in production:
--
--   1. Rate limiting lived in an in-process Map. Every serverless instance had
--      its own, so the limit was effectively unenforced on a public endpoint
--      that calls a paid model.
--   2. A customer received a ticket number and had no way to look it up.
--   3. Conversations accumulated personal data with nothing to remove it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Rate limiting. A fixed window per (tenant, bucket, key).
--
-- Not tenant-scoped by RLS: the chat endpoint must be able to refuse a request
-- BEFORE a tenant context exists, and the table holds no customer data — only
-- an opaque key and a count.
-- -----------------------------------------------------------------------------
CREATE TABLE rate_limit_counters (
  tenant_id    uuid,
  bucket       text NOT NULL,
  subject      text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, subject, window_start)
);
CREATE INDEX rate_limit_counters_sweep_idx ON rate_limit_counters (window_start);

-- -----------------------------------------------------------------------------
-- Scoped, single-use access to ONE record.
--
-- docs/00-architecture.md §3: an email address is an identifier, never a
-- credential. This is how an unauthenticated customer sees their own ticket
-- without anything becoming a lookup-by-email endpoint — the token names
-- exactly one row, expires, and is consumed on use.
-- -----------------------------------------------------------------------------
CREATE TABLE access_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- SHA-256 of the token. The token itself is never stored, so a database
  -- leak does not hand anyone a working link.
  token_hash  text NOT NULL UNIQUE,
  scope       text NOT NULL CHECK (scope IN ('ticket', 'appointment')),
  entity_id   uuid NOT NULL,
  customer_id uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_tokens_expiry_idx ON access_tokens (expires_at);

ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_tokens
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- Per-tenant AI spend, so a monthly budget can actually be enforced rather
-- than merely configured.
-- -----------------------------------------------------------------------------
CREATE TABLE ai_usage (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period        text NOT NULL,                       -- 'YYYY-MM'
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  requests      integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_usage
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- Retention. A conversation that has been redacted keeps its shape — the lead,
-- the appointment and the ticket remain — but the message bodies are gone.
-- -----------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN redacted_at timestamptz;

GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_counters, access_tokens, ai_usage TO app_user;
