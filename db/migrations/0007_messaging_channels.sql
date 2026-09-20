-- =============================================================================
-- 0007 — Messaging channels.
--
-- The assistant has only ever been reachable through a browser on the
-- dealership's own site: the tenant came from the hostname, the person from a
-- signed cookie, and the reply went back down the same HTTP response.
--
-- A direct message has none of those. The tenant must be resolved from the
-- account the message was sent TO, the person from a platform-scoped id that
-- means nothing outside that platform, and the reply has to be delivered by a
-- separate outbound call minutes later.
--
-- These four tables supply exactly those missing pieces. Nothing else about
-- the conversation changes: the same `conversations` and `messages` rows, the
-- same tools, the same scoring. A channel is where a conversation arrives
-- from, not a second kind of conversation.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The business's own connected account.
--
-- Readable WITHOUT a tenant context, and for the same reason `tenant_domains`
-- is: an inbound webhook has to work out which dealership it belongs to BEFORE
-- a context can be set. A hostname does that for the web; the platform's
-- account id does it here.
--
-- Unlike tenant_domains this table holds a credential, so the read policy is
-- narrowed to the columns that resolution needs by a view rather than granting
-- SELECT on the token to an unscoped reader. See `v_channel_account_lookup`.
-- -----------------------------------------------------------------------------
CREATE TABLE channel_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('instagram','messenger','whatsapp')),
  -- Instagram professional account id, Facebook Page id, or WhatsApp phone
  -- number id, depending on the channel.
  external_account_id text NOT NULL,
  -- What the dealership calls it. Shown to staff, never to a customer.
  display_name        text,
  -- The token that lets us send AS this account. Long-lived but not eternal:
  -- Instagram's is 60 days and must be refreshed before it lapses.
  access_token        text,
  token_expires_at    timestamptz,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Global, not per-tenant: one Instagram account belongs to one dealership.
  -- Two tenants claiming the same account is the ambiguity that would let a
  -- message be answered with the wrong business's data.
  UNIQUE (channel, external_account_id),
  UNIQUE (tenant_id, id)
);

ALTER TABLE channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_accounts FORCE ROW LEVEL SECURITY;
-- Staff and jobs see their own dealership's accounts, token included.
DROP POLICY IF EXISTS tenant_isolation ON channel_accounts;
CREATE POLICY tenant_isolation ON channel_accounts
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- The unscoped resolution surface.
--
-- A webhook needs one fact before it can set a tenant context: which tenant
-- owns this account. It does NOT need the token — that is read afterwards,
-- inside the tenant's own context, under the policy above.
--
-- `security_invoker = off` lets this view be read without a context while the
-- table beneath it stays scoped. The view exposes no credential, so an
-- unscoped read reveals nothing beyond a mapping the sender already knows.
-- -----------------------------------------------------------------------------
CREATE VIEW v_channel_account_lookup
  WITH (security_invoker = off) AS
  SELECT id, tenant_id, channel, external_account_id, is_active
  FROM channel_accounts;

-- -----------------------------------------------------------------------------
-- 2. The person on the other end.
--
-- A platform sender id is scoped to the receiving account: the same human
-- messaging two dealerships is two ids, and neither is an email address or a
-- phone number. So it cannot identify a customer on its own — it maps to a
-- visitor, exactly as the browser cookie does, and becomes a customer only
-- once they volunteer a name and an email like anyone else.
-- -----------------------------------------------------------------------------
CREATE TABLE channel_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('instagram','messenger','whatsapp')),
  external_user_id text NOT NULL,
  visitor_id       uuid REFERENCES visitors(id) ON DELETE SET NULL,
  customer_id      uuid,
  -- The @handle or display name the platform gives us, when it gives us one.
  display_name     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  UNIQUE (tenant_id, channel, external_user_id)
);
CREATE INDEX channel_identities_visitor_idx ON channel_identities (tenant_id, visitor_id);

ALTER TABLE channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_identities;
CREATE POLICY tenant_isolation ON channel_identities
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- 3. Inbound de-duplication.
--
-- Meta redelivers a webhook it did not get a prompt 200 from, and a redelivery
-- is indistinguishable from a new message except by its id. Without this a
-- slow reply becomes two replies, and — worse — two turns of conversation the
-- customer never sent.
--
-- The key is global rather than per-tenant because the platform's message id
-- already is, and because the check happens before the tenant context is set.
--
-- It therefore carries NO tenant_id, following migration 0005: a table that
-- cannot be RLS-scoped must not name a column implying that it is. There is
-- nothing here but a platform message id and when we saw it — no customer
-- data, nothing that identifies a dealership — so an unscoped read discloses
-- nothing.
-- -----------------------------------------------------------------------------
CREATE TABLE channel_inbound_messages (
  channel             text NOT NULL CHECK (channel IN ('instagram','messenger','whatsapp')),
  external_message_id text NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, external_message_id)
);
CREATE INDEX channel_inbound_messages_sweep_idx ON channel_inbound_messages (received_at);

-- -----------------------------------------------------------------------------
-- 4. Outbound outbox.
--
-- The same shape as `email_messages`, for the same reason: a row is written in
-- the SAME transaction as the turn that produced it, so a reply cannot be sent
-- for a conversation that rolled back, and a platform outage delays a message
-- rather than losing it. Status reaches 'accepted' only when the platform
-- actually takes it.
--
-- This is also the path a STAFF reply takes. The assistant and a salesperson
-- put a row here identically; `sent_by_type` is the only difference, so there
-- is one delivery mechanism to get right rather than two.
-- -----------------------------------------------------------------------------
CREATE TABLE channel_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel              text NOT NULL CHECK (channel IN ('instagram','messenger','whatsapp')),
  channel_account_id   uuid,
  conversation_id      uuid,
  -- Who it goes to, in the platform's own terms.
  recipient_external_id text NOT NULL,
  body                 text NOT NULL,
  sent_by_type         text NOT NULL DEFAULT 'ai' CHECK (sent_by_type IN ('ai','staff','system')),
  sent_by_id           uuid,
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','sending','accepted','failed','expired')),
  provider_message_id  text,
  -- Makes a retried turn reuse its message instead of sending a second one.
  dedupe_key           text NOT NULL,
  attempts             smallint NOT NULL DEFAULT 0,
  max_attempts         smallint NOT NULL DEFAULT 5,
  last_error           text,
  scheduled_for        timestamptz NOT NULL DEFAULT now(),
  accepted_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX channel_messages_pending_idx ON channel_messages (status, scheduled_for);

ALTER TABLE channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_messages;
CREATE POLICY tenant_isolation ON channel_messages
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- 5. A conversation can now arrive from somewhere other than the website.
--
-- `handed_off` was already a permitted status and was never set by anything:
-- the handoff tool raised a ticket and the assistant carried on answering. On
-- a website that is merely untidy. In a DM thread the customer is watching, it
-- is the assistant talking over the salesperson — so the column gains the two
-- facts needed to actually stop it.
-- -----------------------------------------------------------------------------
ALTER TABLE conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('web','portal','email','instagram','messenger','whatsapp'));

-- `staff_users` is referenced by id alone everywhere in this schema — it has no
-- (tenant_id, id) unique to hang a composite key on, and adding one to widen a
-- table every other reference already treats this way would be the odd change,
-- not the safe one. Tenant containment still holds: the conversation and the
-- staff member are both scoped by RLS, so a cross-tenant pairing is unreadable
-- even if it could be written.
ALTER TABLE conversations ADD COLUMN handed_off_at timestamptz;
ALTER TABLE conversations ADD COLUMN handed_off_to uuid
  REFERENCES staff_users(id) ON DELETE SET NULL;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON channel_accounts, channel_identities, channel_inbound_messages, channel_messages
  TO app_user;
GRANT SELECT ON v_channel_account_lookup TO app_user;
