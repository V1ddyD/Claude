import {
  pgTable, uuid, text, boolean, timestamp, smallint, unique, index, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Messaging channels — see migration 0007.
 *
 * A channel is where a conversation arrives from, not a second kind of
 * conversation. Everything downstream of these four tables is the same code
 * that answers the website: one conversation model, one tool registry, one
 * lead pipeline.
 */

export type MessagingChannel = 'instagram' | 'messenger' | 'whatsapp';

/**
 * The dealership's own connected account.
 *
 * Holds the token that lets us send as them, so it is tenant-scoped like
 * anything else. Resolution — which tenant owns an inbound message — reads
 * `v_channel_account_lookup` instead, which carries no credential.
 */
export const channelAccounts = pgTable(
  'channel_accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    channel: text('channel').notNull().$type<MessagingChannel>(),
    /** Instagram account id, Page id, or WhatsApp phone number id. */
    externalAccountId: text('external_account_id').notNull(),
    displayName: text('display_name'),
    accessToken: text('access_token'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.channel, t.externalAccountId)],
);

/**
 * The person on the other end of a thread.
 *
 * A platform sender id is scoped to the receiving account and is not an email
 * or a phone number, so it identifies a VISITOR — the same thing a browser
 * cookie does — and becomes a customer only when they give their details.
 */
export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    channel: text('channel').notNull().$type<MessagingChannel>(),
    externalUserId: text('external_user_id').notNull(),
    visitorId: uuid('visitor_id'),
    customerId: uuid('customer_id'),
    displayName: text('display_name'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.channel, t.externalUserId),
    index('channel_identities_visitor_idx').on(t.tenantId, t.visitorId),
  ],
);

/**
 * Inbound de-duplication ledger.
 *
 * Meta redelivers any webhook it did not get a prompt 200 from, and a
 * redelivery is indistinguishable from a new message except by its id.
 *
 * Deliberately carries no tenant_id: the check runs before a tenant context
 * exists, so the table cannot be RLS-scoped, and migration 0005 settled that
 * such a table must not name a column implying that it is.
 */
export const channelInboundMessages = pgTable(
  'channel_inbound_messages',
  {
    channel: text('channel').notNull().$type<MessagingChannel>(),
    externalMessageId: text('external_message_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channel, t.externalMessageId] })],
);

/**
 * Outbound outbox — the same shape as `email_messages`, deliberately.
 *
 * Written in the same transaction as the turn that produced it, so a reply
 * cannot be sent for a conversation that rolled back. Also the path a staff
 * reply takes: one delivery mechanism, not two.
 */
export const channelMessages = pgTable(
  'channel_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    channel: text('channel').notNull().$type<MessagingChannel>(),
    channelAccountId: uuid('channel_account_id'),
    conversationId: uuid('conversation_id'),
    recipientExternalId: text('recipient_external_id').notNull(),
    body: text('body').notNull(),
    sentByType: text('sent_by_type').notNull().default('ai').$type<'ai' | 'staff' | 'system'>(),
    sentById: uuid('sent_by_id'),
    status: text('status').notNull().default('queued')
      .$type<'queued' | 'sending' | 'accepted' | 'failed' | 'expired'>(),
    providerMessageId: text('provider_message_id'),
    dedupeKey: text('dedupe_key').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.dedupeKey),
    index('channel_messages_pending_idx').on(t.status, t.scheduledFor),
  ],
);
