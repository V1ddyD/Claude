import { pgTable, uuid, text, timestamp, integer, bigint, primaryKey, index }
  from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Rate limiting, scoped access, and AI spend.
 *
 * `rate_limit_counters` is deliberately NOT tenant-scoped by RLS: the chat
 * endpoint has to be able to refuse a request before a tenant context exists.
 *
 * It therefore carries no `tenant_id` — the tenant is part of the opaque
 * subject key instead. A tenant_id column here would imply a scoping that does
 * not exist, and the isolation suite requires every column of that name to
 * have a policy behind it.
 */
export const rateLimitCounters = pgTable(
  'rate_limit_counters',
  {
    bucket: text('bucket').notNull(),
    subject: text('subject').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.subject, t.windowStart] })],
);

/**
 * Single-use access to exactly one record.
 *
 * The token itself is never stored — only its SHA-256 — so a database leak
 * does not hand anyone a working link.
 */
export const accessTokens = pgTable(
  'access_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    scope: text('scope').notNull().$type<'ticket' | 'appointment'>(),
    entityId: uuid('entity_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('access_tokens_expiry_lookup_idx').on(t.expiresAt)],
);

export const aiUsage = pgTable(
  'ai_usage',
  {
    tenantId: uuid('tenant_id').notNull(),
    period: text('period').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    requests: integer('requests').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.period] })],
);
