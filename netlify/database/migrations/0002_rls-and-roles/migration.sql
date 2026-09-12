-- =============================================================================
-- 0002 — Row Level Security, the application role, and grants.
--
-- This migration is what makes tenant isolation a property of the database
-- rather than a property of the application being correct. Policies are
-- GENERATED for every table carrying tenant_id, so a table added later without
-- a policy is impossible by omission rather than caught by review.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Request context helpers.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_auth_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.auth_user_id', true), '')::uuid
  $$;

-- -----------------------------------------------------------------------------
-- The request-path role. Deliberately unprivileged: not the table owner, no
-- BYPASSRLS, no superuser. If the application layer's tenant scoping is ever
-- bypassed by a bug, this role still cannot read another tenant's rows.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN;
  END IF;
END $$;

-- Guard against a misconfigured deployment handing the request path a role that
-- can see everything. Cheap to check, catastrophic to get wrong.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'app_user must not be SUPERUSER or BYPASSRLS: RLS would not apply to it';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, app TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- audit_logs is append-only for the application. Revoked after the blanket
-- grant above so ordering cannot accidentally re-grant it.
REVOKE UPDATE, DELETE ON audit_logs FROM app_user;

-- Global reference data: readable, never writable from the request path.
REVOKE INSERT, UPDATE, DELETE ON role_permissions, inventory_transitions FROM app_user;

-- -----------------------------------------------------------------------------
-- Tenant isolation policies, generated for every table with a tenant_id column.
-- -----------------------------------------------------------------------------
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    -- FORCE so the policy applies to the table owner too. Without this, a
    -- migration or admin connection silently sees every tenant.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.relname);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (tenant_id = app.current_tenant_id())
        WITH CHECK (tenant_id = app.current_tenant_id())
    $f$, t.relname);
  END LOOP;
END $$;

-- The `tenants` table itself has no tenant_id. A tenant may read only its own
-- row; nothing in the request path may enumerate the tenant list.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

-- tenant_domains is the one deliberate exception: hostname -> tenant resolution
-- must happen BEFORE a tenant context exists. It is readable without a context
-- and carries no customer data — only a hostname and the tenant it maps to.
ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_domains FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS domain_lookup ON tenant_domains;
CREATE POLICY domain_lookup ON tenant_domains
  FOR SELECT USING (true);
DROP POLICY IF EXISTS domain_write ON tenant_domains;
CREATE POLICY domain_write ON tenant_domains
  FOR ALL USING (tenant_id = app.current_tenant_id())
           WITH CHECK (tenant_id = app.current_tenant_id());

-- staff_users is read during sign-in, before a tenant context is established:
-- the user's own row is what DETERMINES their tenant. Scoped to the
-- authenticated subject rather than the tenant, so it cannot be used to
-- enumerate another dealership's staff.
DROP POLICY IF EXISTS tenant_isolation ON staff_users;
CREATE POLICY staff_self ON staff_users
  FOR SELECT USING (id = app.current_auth_user_id());
CREATE POLICY staff_tenant ON staff_users
  FOR ALL USING (tenant_id = app.current_tenant_id())
           WITH CHECK (tenant_id = app.current_tenant_id());

-- Global reference tables are not tenant-scoped and stay readable.
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY reference_read ON role_permissions FOR SELECT USING (true);
ALTER TABLE inventory_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY reference_read ON inventory_transitions FOR SELECT USING (true);

-- -----------------------------------------------------------------------------
-- Seeded permission matrix (docs/00-architecture.md §3). Global, not per tenant:
-- what a SALES role may do is a property of the product, not of a dealership.
-- Row-level scoping (assigned vs all) rides on top in the service layer.
-- -----------------------------------------------------------------------------
INSERT INTO role_permissions (role, permission) VALUES
  ('sales','lead.read.assigned'), ('sales','lead.status.write'),
  ('sales','lead.note.write'), ('sales','customer.read'),
  ('sales','appointment.read'), ('sales','appointment.write'),
  ('sales','ticket.sales.read'), ('sales','ticket.sales.write'),
  ('sales','inventory.read'), ('sales','catalogue.read'),
  ('sales','conversation.read'),

  ('service','customer.read'), ('service','appointment.read'),
  ('service','appointment.write'), ('service','ticket.service.read'),
  ('service','ticket.service.write'), ('service','inventory.read'),
  ('service','catalogue.read'),

  ('manager','lead.read.all'), ('manager','lead.assign'),
  ('manager','lead.status.write'), ('manager','lead.note.write'),
  ('manager','customer.read'), ('manager','customer.pii.export'),
  ('manager','appointment.read'), ('manager','appointment.write'),
  ('manager','ticket.sales.read'), ('manager','ticket.sales.write'),
  ('manager','ticket.service.read'), ('manager','ticket.service.write'),
  ('manager','inventory.read'), ('manager','inventory.status.write'),
  ('manager','catalogue.read'), ('manager','conversation.read'),
  ('manager','analytics.read'), ('manager','staff.manage'),

  ('admin','lead.read.all'), ('admin','lead.assign'),
  ('admin','lead.status.write'), ('admin','lead.note.write'),
  ('admin','customer.read'), ('admin','customer.pii.export'),
  ('admin','appointment.read'), ('admin','appointment.write'),
  ('admin','ticket.sales.read'), ('admin','ticket.sales.write'),
  ('admin','ticket.service.read'), ('admin','ticket.service.write'),
  ('admin','inventory.read'), ('admin','inventory.status.write'),
  ('admin','inventory.price.write'), ('admin','catalogue.read'),
  ('admin','catalogue.write'), ('admin','conversation.read'),
  ('admin','analytics.read'), ('admin','staff.manage'),
  ('admin','settings.write'), ('admin','audit.read')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Inventory state machine, as data (docs/00-architecture.md §8).
-- -----------------------------------------------------------------------------
INSERT INTO inventory_transitions (from_status, to_status, required_permission) VALUES
  ('available','reserved','inventory.status.write'),
  ('available','service_hold','inventory.status.write'),
  ('available','unavailable','inventory.status.write'),
  ('reserved','available','inventory.status.write'),
  ('reserved','pending_delivery','inventory.status.write'),
  ('reserved','sold','inventory.status.write'),
  ('pending_delivery','sold','inventory.status.write'),
  ('pending_delivery','available','inventory.status.write'),
  ('service_hold','available','inventory.status.write'),
  ('unavailable','available','inventory.status.write')
ON CONFLICT DO NOTHING;
