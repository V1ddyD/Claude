-- =============================================================================
-- 0009 — Staff sign-in that a business can run itself.
--
-- Until now the portal had two ways in: an external identity provider that no
-- deployment configured, and a demonstration picker whose cookie was the
-- staff member's id in plain text. Fine for showing the product; not for a
-- café's customer list. This adds what a real business needs:
--
--   staff_credentials   a password per staff member, stored as a scrypt hash
--   staff_sessions      a server-side session per sign-in, so removing
--                       somebody or resetting their password signs them out
--                       everywhere, immediately
--   tenants.plan        which package the business is on, for the number of
--                       staff it may add
--
-- Both new tables are read in exactly two situations before a tenant context
-- exists: signing in (by email) and recognising a session (by token). Each of
-- those gets a policy keyed on a per-transaction setting that names the one
-- row it may see, in the same way `staff_self` lets a person read their own
-- staff row. Nothing here can be used to list another business's staff.
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'starter'
    CHECK (plan IN ('starter', 'pro', 'elite'));

-- The demonstration shows everything.
UPDATE tenants SET plan = 'elite' WHERE id = '5171c1a1-0000-4000-8000-000000000001';

-- For the composite keys below: a credential or a session can only ever point
-- at a staff member of its own business.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_users_tenant_id_id_key') THEN
    ALTER TABLE staff_users ADD CONSTRAINT staff_users_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app.login_email() RETURNS citext
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.login_email', true), '')::citext
  $$;

CREATE OR REPLACE FUNCTION app.session_token_hash() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.session_token_hash', true), '')
  $$;

-- -----------------------------------------------------------------------------
-- 1. Passwords.
-- -----------------------------------------------------------------------------
CREATE TABLE staff_credentials (
  staff_id             uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- A copy of the staff email, so sign-in can find the row by what the person
  -- typed without reading staff_users across every business.
  email                citext NOT NULL,
  -- scrypt$N$r$p$salt$hash. The password itself is never stored.
  password_hash        text NOT NULL,
  -- Set when somebody else chose the password (a new account, a reset): the
  -- next sign-in must replace it before anything else.
  must_change_password boolean NOT NULL DEFAULT true,
  failed_attempts      smallint NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX staff_credentials_email_idx ON staff_credentials (email);

ALTER TABLE staff_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_credentials
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- Sign-in: only the rows for the email being signed in with.
CREATE POLICY sign_in_lookup ON staff_credentials
  FOR SELECT USING (email = app.login_email());
CREATE POLICY sign_in_attempts ON staff_credentials
  FOR UPDATE USING (email = app.login_email()) WITH CHECK (email = app.login_email());

-- -----------------------------------------------------------------------------
-- 2. Sessions.
-- -----------------------------------------------------------------------------
CREATE TABLE staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id      uuid NOT NULL,
  -- SHA-256 of the cookie's token. A database leak does not hand anyone a
  -- working session.
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff_users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX staff_sessions_staff_idx ON staff_sessions (tenant_id, staff_id);
CREATE INDEX staff_sessions_expiry_idx ON staff_sessions (expires_at);

ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_sessions
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- Recognising a session: only the one row whose token was presented.
CREATE POLICY session_lookup ON staff_sessions
  FOR SELECT USING (token_hash = app.session_token_hash());
CREATE POLICY session_sign_out ON staff_sessions
  FOR UPDATE USING (token_hash = app.session_token_hash())
  WITH CHECK (token_hash = app.session_token_hash());

GRANT SELECT, INSERT, UPDATE, DELETE ON staff_credentials, staff_sessions TO app_user;
