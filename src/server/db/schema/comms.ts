import {
  pgTable, uuid, text, timestamp, smallint, jsonb, unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Transactional outbox.
 *
 * A row is written in the SAME transaction as the business action, so email
 * cannot be sent for a booking that rolled back, and a provider outage delays
 * mail rather than failing the booking. Status only advances to `accepted` when
 * the provider actually accepts it — which is what makes "never claim an email
 * was sent" (spec §21) enforceable rather than a prompt instruction.
 */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    templateKey: text('template_key').notNull(),
    toEmail: text('to_email').notNull(),
    toName: text('to_name'),
    subject: text('subject').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('queued')
      .$type<'queued' | 'sending' | 'accepted' | 'delivered' | 'bounced' | 'failed' | 'suppressed'>(),
    providerMessageId: text('provider_message_id'),
    dedupeKey: text('dedupe_key').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.dedupeKey),
    index('email_messages_pending_idx').on(t.status, t.scheduledFor),
  ],
);

export const emailEvents = pgTable('email_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  emailMessageId: uuid('email_message_id').notNull(),
  type: text('type').notNull(),
  providerPayload: jsonb('provider_payload'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});
