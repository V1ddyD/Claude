-- =============================================================================
-- Sinclair AI Dealership Automation Platform
-- Proposed schema — Phase 0. Not yet applied; this is the design under review.
--
-- Conventions
--   * Every tenant-owned table has a NOT NULL tenant_id and RLS enabled.
--   * All timestamps are timestamptz. Business-hours arithmetic uses tenants.timezone.
--   * Money is stored in integer minor units (cents). Never floats.
--   * Tenant-scoped uniqueness is always (tenant_id, ...).
--   * Child rows carry tenant_id and reference parents by (tenant_id, id) so a row
--     can never point at a parent in another tenant.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist";  -- EXCLUDE constraints on uuid + range
CREATE EXTENSION IF NOT EXISTS "citext";      -- case-insensitive email

CREATE SCHEMA IF NOT EXISTS app;             -- request-context helpers

-- -----------------------------------------------------------------------------
-- Tenant context. Set once per request transaction: SET LOCAL app.tenant_id = '...'
-- Every RLS policy reads this. If it is unset, tenant tables return zero rows.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
  $$;

-- =============================================================================
-- 1. TENANCY AND CONFIGURATION
-- =============================================================================

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  legal_name    text NOT NULL,
  brand_name    text NOT NULL,
  timezone      text NOT NULL DEFAULT 'America/Toronto',   -- IANA
  currency      char(3) NOT NULL DEFAULT 'CAD',
  locale        text NOT NULL DEFAULT 'en-CA',
  ticket_prefix text NOT NULL DEFAULT 'TKT',
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','onboarding')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domains (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostname   text NOT NULL UNIQUE,
  is_primary boolean NOT NULL DEFAULT false
);

-- Settings are grouped JSON blocks, each validated by a Zod schema at the
-- application edge. JSON is justified here: the shape is genuinely tenant-variable
-- and never joined or filtered on. It is NOT used for operational data.
CREATE TABLE tenant_settings (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  contact    jsonb NOT NULL DEFAULT '{}',  -- phone, email, address, map
  booking    jsonb NOT NULL DEFAULT '{}',  -- slot minutes, min notice, horizon, SLA
  lead       jsonb NOT NULL DEFAULT '{}',  -- band thresholds, auto-assign policy
  ai         jsonb NOT NULL DEFAULT '{}',  -- tone, persona, disclosures, token budget
  email      jsonb NOT NULL DEFAULT '{}',  -- from name/address, reply-to, footer
  finance    jsonb NOT NULL DEFAULT '{}',  -- default APR bps, terms, disclaimer
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department  text NOT NULL CHECK (department IN ('sales','service')),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at    time NOT NULL,
  closes_at   time NOT NULL,
  CHECK (closes_at > opens_at),
  UNIQUE (tenant_id, department, day_of_week)
);

CREATE TABLE business_closures (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department text CHECK (department IN ('sales','service')),  -- NULL = whole site
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  reason     text NOT NULL,
  CHECK (ends_on >= starts_on)
);

-- =============================================================================
-- 2. IDENTITY
-- =============================================================================

CREATE TABLE role_permissions (        -- global, seeded, not tenant-scoped
  role       text NOT NULL CHECK (role IN ('sales','service','manager','admin')),
  permission text NOT NULL,
  PRIMARY KEY (role, permission)
);

-- A row here is what grants portal access. Membership in auth.users grants nothing.
CREATE TABLE staff_users (
  id           uuid PRIMARY KEY,                -- = auth.users.id
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  full_name    text NOT NULL,
  role         text NOT NULL CHECK (role IN ('sales','service','manager','admin')),
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('invited','active','suspended')),
  phone        text,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX ON staff_users (tenant_id, role) WHERE status = 'active';

CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  auth_user_id      uuid UNIQUE,                       -- set only if they registered
  full_name         text,
  email             citext,
  phone             text,
  preferred_contact text CHECK (preferred_contact IN ('email','phone','sms','any')),
  contact_consent   boolean NOT NULL DEFAULT false,    -- may we contact them at all
  marketing_consent boolean NOT NULL DEFAULT false,    -- separate, opt-in only
  consent_source    text,                              -- 'chat' | 'form' | 'staff'
  consent_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)                               -- for composite child FKs
);
CREATE UNIQUE INDEX customers_tenant_email_key ON customers (tenant_id, email)
  WHERE email IS NOT NULL;
CREATE INDEX ON customers (tenant_id, phone) WHERE phone IS NOT NULL;

-- Anonymous browsing identity. No PII. Linked to a customer once one identifies.
CREATE TABLE visitors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   uuid,
  session_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);

-- =============================================================================
-- 3. VEHICLE CATALOGUE
--    model → powertrain ⨯ trim = model_configurations (the buildable matrix)
--    See docs/04-spec-review.md §7 and §19 for why the matrix table exists.
-- =============================================================================

CREATE TABLE vehicle_models (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  name            text NOT NULL,                 -- 'S5'
  full_name       text NOT NULL,                 -- 'Sinclair S5'
  model_year      smallint NOT NULL,
  body_style      text NOT NULL CHECK (body_style IN
                    ('sedan','coupe','suv','crossover','pickup','wagon')),
  segment         text NOT NULL,                 -- 'Premium Mid-Size SUV'
  tagline         text,
  overview        text,
  base_msrp_cents bigint NOT NULL CHECK (base_msrp_cents > 0),
  hero_image_url  text,
  display_order   integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'published'
                    CHECK (status IN ('draft','published','archived')),
  source_template_id uuid,                       -- future shared-catalogue lineage
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug, model_year),
  UNIQUE (tenant_id, id)
);

CREATE TABLE powertrains (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  model_id         uuid NOT NULL,
  code             text NOT NULL,                -- '2.0T-AWD'
  name             text NOT NULL,                -- '2.0 Turbo AWD'
  kind             text NOT NULL CHECK (kind IN ('ice','hybrid','phev','bev')),
  engine_desc      text,                         -- '2.0L turbocharged inline-4'
  motor_desc       text,
  battery_kwh      numeric(5,1),
  transmission     text,
  drivetrain       text NOT NULL CHECK (drivetrain IN ('fwd','rwd','awd')),
  horsepower       integer,
  torque_nm        integer,
  range_km         integer,                      -- BEV/PHEV
  consumption_l100 numeric(4,1),                 -- ICE/hybrid
  consumption_le   numeric(4,1),                 -- BEV, Le/100km
  price_delta_cents bigint NOT NULL DEFAULT 0,
  display_order    integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, model_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES vehicle_models (tenant_id, id)
    ON DELETE CASCADE,
  CHECK ((kind = 'bev') = (battery_kwh IS NOT NULL))
);

CREATE TABLE trims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  model_id          uuid NOT NULL,
  code              text NOT NULL,               -- 'PREMIUM'
  name              text NOT NULL,               -- 'Premium'   (varies per model)
  tier_order        smallint NOT NULL,
  summary           text,
  price_delta_cents bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, model_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES vehicle_models (tenant_id, id)
    ON DELETE CASCADE
);

-- The buildable matrix: not every trim is offered with every powertrain.
CREATE TABLE model_configurations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  model_id        uuid NOT NULL,
  powertrain_id   uuid NOT NULL,
  trim_id         uuid NOT NULL,
  price_cents     bigint NOT NULL,               -- resolved base for this combination
  is_orderable    boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, powertrain_id, trim_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, model_id)      REFERENCES vehicle_models (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, powertrain_id) REFERENCES powertrains   (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, trim_id)       REFERENCES trims         (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE colours (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  model_id          uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('exterior','interior')),
  code              text NOT NULL,
  name              text NOT NULL,               -- 'Obsidian Black'
  finish            text,                        -- 'metallic' | 'pearl' | 'matte'
  hex               char(7),
  material          text,                        -- interior: 'Nappa leather'
  price_delta_cents bigint NOT NULL DEFAULT 0,
  swatch_url        text,
  display_order     integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, model_id, kind, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES vehicle_models (tenant_id, id) ON DELETE CASCADE
);

-- A colour may be restricted to certain configurations (e.g. Sport-only paint).
CREATE TABLE colour_availability (
  tenant_id               uuid NOT NULL,
  colour_id               uuid NOT NULL,
  model_configuration_id  uuid NOT NULL,
  PRIMARY KEY (colour_id, model_configuration_id),
  FOREIGN KEY (tenant_id, colour_id) REFERENCES colours (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, model_configuration_id)
    REFERENCES model_configurations (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  model_id    uuid NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,                     -- 'Technology Package'
  category    text NOT NULL,                     -- 'package' | 'wheels' | 'comfort' …
  description text,
  price_cents bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, model_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES vehicle_models (tenant_id, id) ON DELETE CASCADE
);

-- Standard on one trim, optional on another, unavailable on a third.
CREATE TABLE option_availability (
  tenant_id              uuid NOT NULL,
  option_id              uuid NOT NULL,
  model_configuration_id uuid NOT NULL,
  is_standard            boolean NOT NULL DEFAULT false,
  price_override_cents   bigint,
  PRIMARY KEY (option_id, model_configuration_id),
  FOREIGN KEY (tenant_id, option_id) REFERENCES options (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, model_configuration_id)
    REFERENCES model_configurations (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE option_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  option_id      uuid NOT NULL,
  rule           text NOT NULL CHECK (rule IN ('requires','excludes')),
  other_option_id uuid NOT NULL,
  FOREIGN KEY (tenant_id, option_id)       REFERENCES options (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, other_option_id) REFERENCES options (tenant_id, id) ON DELETE CASCADE,
  CHECK (option_id <> other_option_id)
);

CREATE TABLE vehicle_features (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  model_configuration_id uuid NOT NULL,
  category    text NOT NULL,                     -- 'safety' | 'technology' | …
  label       text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, model_configuration_id)
    REFERENCES model_configurations (tenant_id, id) ON DELETE CASCADE
);

-- A visitor's configuration. Distinct from the catalogue matrix above.
CREATE TABLE saved_builds (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id             uuid REFERENCES visitors(id) ON DELETE SET NULL,
  customer_id            uuid,
  model_configuration_id uuid NOT NULL,
  exterior_colour_id     uuid,
  interior_colour_id     uuid,
  option_ids             uuid[] NOT NULL DEFAULT '{}',
  price_breakdown        jsonb NOT NULL,         -- snapshot: itemised, at a point in time
  total_price_cents      bigint NOT NULL,
  share_token            text UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, model_configuration_id)
    REFERENCES model_configurations (tenant_id, id),
  UNIQUE (tenant_id, id)
);

-- =============================================================================
-- 4. INVENTORY
-- =============================================================================

CREATE TABLE inventory_units (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model_configuration_id uuid NOT NULL,
  exterior_colour_id     uuid,
  interior_colour_id     uuid,
  vin                    text,
  stock_number           text NOT NULL,
  status                 text NOT NULL DEFAULT 'available' CHECK (status IN
                           ('available','reserved','pending_delivery','sold',
                            'service_hold','unavailable')),
  condition              text NOT NULL DEFAULT 'new' CHECK (condition IN ('new','demo','used')),
  mileage_km             integer NOT NULL DEFAULT 0,
  asking_price_cents     bigint NOT NULL,
  location               text,
  estimated_delivery_on  date,
  reserved_until         timestamptz,
  reserved_for_customer_id uuid,
  is_demo_vehicle        boolean NOT NULL DEFAULT false,   -- eligible for test drives
  version                integer NOT NULL DEFAULT 1,       -- optimistic concurrency
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, stock_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, model_configuration_id)
    REFERENCES model_configurations (tenant_id, id),
  CHECK ((status = 'reserved') = (reserved_until IS NOT NULL))
);
CREATE UNIQUE INDEX inventory_units_vin_key ON inventory_units (tenant_id, vin)
  WHERE vin IS NOT NULL;
CREATE INDEX ON inventory_units (tenant_id, model_configuration_id) WHERE status = 'available';

CREATE TABLE inventory_unit_options (
  tenant_id uuid NOT NULL,
  unit_id   uuid NOT NULL,
  option_id uuid NOT NULL,
  PRIMARY KEY (unit_id, option_id),
  FOREIGN KEY (tenant_id, unit_id)   REFERENCES inventory_units (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, option_id) REFERENCES options (tenant_id, id)
);

-- Allowed state transitions, as data. One function validates against this table.
CREATE TABLE inventory_transitions (
  from_status         text NOT NULL,
  to_status           text NOT NULL,
  required_permission text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- The ONLY inventory surface the customer site and the AI may read.
CREATE VIEW v_public_inventory AS
  SELECT u.id, u.tenant_id, u.model_configuration_id, u.exterior_colour_id,
         u.interior_colour_id, u.stock_number, u.condition, u.mileage_km,
         u.asking_price_cents, u.location, u.estimated_delivery_on
  FROM inventory_units u
  WHERE u.status = 'available';

-- =============================================================================
-- 5. CONVERSATIONS
-- =============================================================================

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id      uuid REFERENCES visitors(id) ON DELETE SET NULL,
  customer_id     uuid,
  channel         text NOT NULL DEFAULT 'web' CHECK (channel IN ('web','portal','email')),
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','idle','handed_off','closed')),
  locale          text NOT NULL DEFAULT 'en-CA',
  rolling_summary text,                          -- older turns, compacted
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ON conversations (tenant_id, last_message_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  seq             integer NOT NULL,
  role            text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content         text,
  tool_name       text,
  tool_input      jsonb,
  tool_result     jsonb,
  input_tokens    integer,
  output_tokens   integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE
);

-- Idempotency ledger for every AI-originated write. Unique key = replay protection.
CREATE TABLE tool_invocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  tool_name       text NOT NULL,
  idempotency_key text NOT NULL,
  status          text NOT NULL CHECK (status IN ('succeeded','failed')),
  result          jsonb,
  error_code      text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE
);

-- =============================================================================
-- 6. LEADS
-- =============================================================================

CREATE TABLE leads (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id            uuid NOT NULL,
  conversation_id        uuid,
  source                 text NOT NULL DEFAULT 'ai_assistant',
  status                 text NOT NULL DEFAULT 'new' CHECK (status IN
                           ('new','contacted','qualified','appointment_scheduled',
                            'test_drive_completed','proposal_sent','negotiating',
                            'won','lost','nurture')),
  priority               text NOT NULL DEFAULT 'low' CHECK (priority IN ('low','medium','high')),
  score                  smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  score_rationale        text,                   -- assembled from fired rules
  scored_at              timestamptz,
  -- denormalized current best values (source of truth for "how we know": lead_signals)
  model_id               uuid,
  model_configuration_id uuid,
  exterior_colour_id     uuid,
  budget_cents           bigint,
  purchase_timeframe     text,
  finance_interest       boolean,
  trade_in_interest      boolean,
  ai_summary             text,                   -- internal only, never customer-facing
  ai_summary_at          timestamptz,
  assigned_staff_id      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  assigned_at            timestamptz,
  handoff_requested_at   timestamptz,
  last_activity_at       timestamptz NOT NULL DEFAULT now(),
  next_follow_up_at      timestamptz,
  closed_at              timestamptz,
  lost_reason            text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id)     REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ON leads (tenant_id, priority, status, last_activity_at DESC);
CREATE INDEX ON leads (tenant_id, assigned_staff_id) WHERE status NOT IN ('won','lost');
CREATE INDEX ON leads (tenant_id, next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

-- Per-field extracted evidence with confidence and provenance (spec §26).
CREATE TABLE lead_signals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  lead_id                uuid NOT NULL,
  field                  text NOT NULL,          -- 'budget' | 'trim' | 'timeframe' …
  value                  jsonb NOT NULL,
  confidence             numeric(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source                 text NOT NULL CHECK (source IN ('ai','form','staff')),
  extracted_from_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  superseded_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON lead_signals (lead_id, field) WHERE superseded_at IS NULL;

CREATE TABLE lead_events (               -- the activity timeline
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  lead_id     uuid NOT NULL,
  type        text NOT NULL,             -- 'created' | 'status_changed' | 'assigned' …
  actor_type  text NOT NULL CHECK (actor_type IN ('customer','staff','system','ai')),
  actor_id    uuid,
  summary     text NOT NULL,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON lead_events (lead_id, created_at DESC);

CREATE TABLE staff_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  lead_id     uuid,
  customer_id uuid,
  author_id   uuid NOT NULL REFERENCES staff_users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id)     REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE,
  CHECK (lead_id IS NOT NULL OR customer_id IS NOT NULL)
);

CREATE TABLE lead_scoring_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  description text NOT NULL,             -- becomes the staff-facing rationale line
  condition   jsonb NOT NULL,            -- declarative predicate over LeadSignals
  weight      smallint NOT NULL,         -- may be negative
  min_confidence numeric(3,2) NOT NULL DEFAULT 0.50,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, key)
);

-- =============================================================================
-- 7. APPOINTMENTS
-- =============================================================================

CREATE TABLE resources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('staff','vehicle','bay')),
  name              text NOT NULL,
  staff_user_id     uuid REFERENCES staff_users(id) ON DELETE CASCADE,
  inventory_unit_id uuid,
  is_active         boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_unit_id) REFERENCES inventory_units (tenant_id, id)
    ON DELETE CASCADE,
  CHECK (
    (kind = 'staff'   AND staff_user_id IS NOT NULL AND inventory_unit_id IS NULL) OR
    (kind = 'vehicle' AND inventory_unit_id IS NOT NULL AND staff_user_id IS NULL) OR
    (kind = 'bay'     AND staff_user_id IS NULL AND inventory_unit_id IS NULL)
  )
);

CREATE TABLE appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type              text NOT NULL CHECK (type IN ('test_drive','consultation','service','delivery')),
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN
                      ('scheduled','confirmed','completed','cancelled','no_show')),
  customer_id       uuid NOT NULL,
  lead_id           uuid,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  confirmation_code text NOT NULL,
  customer_notes    text,
  internal_notes    text,
  cancelled_at      timestamptz,
  cancelled_reason  text,
  created_by_type   text NOT NULL CHECK (created_by_type IN ('customer','staff','ai')),
  created_by_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, confirmation_code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id)     REFERENCES leads (tenant_id, id)
);
CREATE INDEX ON appointments (tenant_id, starts_at) WHERE status IN ('scheduled','confirmed');

-- Each appointment consumes one or more resources for a time range.
-- The EXCLUDE constraint makes double booking IMPOSSIBLE, not merely unlikely.
CREATE TABLE appointment_resources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  appointment_id uuid NOT NULL,
  resource_id    uuid NOT NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  time_range     tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, resource_id)    REFERENCES resources (tenant_id, id),
  CONSTRAINT appointment_resources_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    resource_id WITH =,
    time_range  WITH &&
  ) WHERE (status = 'active')
);

-- =============================================================================
-- 8. TICKETS AND REQUESTS
-- =============================================================================

-- Gapless per-tenant ticket numbering. Row-locked inside the creating transaction.
CREATE TABLE ticket_sequences (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period     text NOT NULL,                      -- '2026'
  next_value integer NOT NULL DEFAULT 10001,
  PRIMARY KEY (tenant_id, period)
);

CREATE TABLE tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number         text NOT NULL,                  -- 'SIN-2026-10482'
  type           text NOT NULL CHECK (type IN
                   ('sales_enquiry','test_drive','financing','trade_in',
                    'callback','general','support','service')),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN
                   ('open','in_progress','waiting_customer','resolved','closed')),
  subject        text NOT NULL,
  body           text,
  customer_id    uuid NOT NULL,
  lead_id        uuid,                           -- NULL for service tickets
  appointment_id uuid,
  assigned_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_type text NOT NULL CHECK (created_by_type IN ('customer','staff','ai')),
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)    REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id)        REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments (tenant_id, id)
);

CREATE TABLE ticket_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  ticket_id   uuid NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('customer','staff','ai','system')),
  author_id   uuid,
  body        text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,    -- true ⇒ never rendered to customers
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE finance_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL,
  lead_id             uuid,
  ticket_id           uuid,
  vehicle_price_cents bigint NOT NULL,
  down_payment_cents  bigint NOT NULL DEFAULT 0,
  term_months         smallint NOT NULL,
  apr_bps             integer,                   -- basis points; NULL = not quoted
  estimate            jsonb NOT NULL,            -- monthly, total, interest — ESTIMATE
  status              text NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','in_review','referred','closed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id)     REFERENCES leads (tenant_id, id)
);

CREATE TABLE trade_in_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL,
  lead_id             uuid,
  ticket_id           uuid,
  vehicle_year        smallint NOT NULL,
  vehicle_make        text NOT NULL,
  vehicle_model       text NOT NULL,
  vehicle_trim        text,
  mileage_km          integer NOT NULL,
  condition           text NOT NULL CHECK (condition IN ('excellent','good','fair','poor')),
  vin                 text,
  owns_outright       boolean,
  payoff_cents        bigint,
  notes               text,
  -- Deliberately nullable: no valuation exists until a human inspects the vehicle.
  appraised_value_cents bigint,
  appraised_by        uuid REFERENCES staff_users(id),
  appraised_at        timestamptz,
  status              text NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','inspection_booked','appraised','closed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id)     REFERENCES leads (tenant_id, id)
);

-- =============================================================================
-- 9. OPERATIONS: EMAIL OUTBOX, NOTIFICATIONS, FOLLOW-UPS, JOBS, AUDIT
-- =============================================================================

CREATE TABLE email_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_key        text NOT NULL,
  to_email            citext NOT NULL,
  to_name             text,
  subject             text NOT NULL,
  payload             jsonb NOT NULL,            -- template variables
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN
                        ('queued','sending','accepted','delivered','bounced','failed','suppressed')),
  provider_message_id text,
  dedupe_key          text NOT NULL,
  attempts            smallint NOT NULL DEFAULT 0,
  last_error          text,
  scheduled_for       timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX ON email_messages (status, scheduled_for) WHERE status IN ('queued','sending');

CREATE TABLE email_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  email_message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  type             text NOT NULL,
  provider_payload jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_id uuid REFERENCES staff_users(id) ON DELETE CASCADE,
  role_target  text,                             -- broadcast to a role if no recipient
  type         text NOT NULL,
  title        text NOT NULL,
  body         text,
  link_path    text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (recipient_id IS NOT NULL OR role_target IS NOT NULL)
);
CREATE INDEX ON notifications (tenant_id, recipient_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE follow_up_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key                text NOT NULL,
  description        text NOT NULL,
  trigger            jsonb NOT NULL,
  delay_minutes      integer NOT NULL,
  business_hours_only boolean NOT NULL DEFAULT true,
  recommended_action text NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, key)
);

CREATE TABLE follow_up_tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  lead_id            uuid,
  appointment_id     uuid,
  rule_key           text NOT NULL,
  reason             text NOT NULL,
  recommended_action text NOT NULL,
  due_at             timestamptz NOT NULL,
  assigned_staff_id  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','done','dismissed')),
  completed_by       uuid REFERENCES staff_users(id),
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, lead_id, rule_key, due_at)   -- no duplicate nagging
);

CREATE TABLE job_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','failed','dead')),
  run_at      timestamptz NOT NULL DEFAULT now(),
  attempts    smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 5,
  locked_by   text,
  locked_at   timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON job_queue (status, run_at) WHERE status = 'pending';

-- Append-only. The application role gets INSERT and SELECT; no UPDATE, no DELETE.
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type  text NOT NULL CHECK (actor_type IN ('staff','customer','ai','system')),
  actor_id    uuid,
  action      text NOT NULL,                     -- 'lead.status.changed'
  entity_type text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  request_id  text,
  ip_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs (tenant_id, entity_type, entity_id, created_at DESC);

CREATE TABLE catalogue_events (        -- feeds "popular configurations" analytics
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id  uuid REFERENCES visitors(id) ON DELETE SET NULL,
  event       text NOT NULL,                     -- 'model_viewed' | 'build_priced' …
  model_id    uuid,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 10. ROW LEVEL SECURITY
--     Backstop only — the application also scopes every query. Both must hold.
--     The application connects as a role that is neither table owner nor BYPASSRLS.
-- =============================================================================
-- Applied to every table above carrying tenant_id, e.g.:
--
--   ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE leads FORCE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON leads
--     USING      (tenant_id = app.current_tenant_id())
--     WITH CHECK (tenant_id = app.current_tenant_id());
--
-- Generated for all tenant tables by the migration so none can be forgotten,
-- and asserted table-by-table by the tenant isolation test suite.
