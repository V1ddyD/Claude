import {
  pgTable, uuid, text, timestamp, integer, jsonb, unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    visitorId: uuid('visitor_id'),
    customerId: uuid('customer_id'),
    channel: text('channel').notNull().default('web').$type<'web' | 'portal' | 'email'>(),
    status: text('status').notNull().default('active')
      .$type<'active' | 'idle' | 'handed_off' | 'closed'>(),
    locale: text('locale').notNull().default('en-CA'),
    rollingSummary: text('rolling_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when retention removed the message bodies. The shape remains. */
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
  },
  (t) => [index('conversations_recent_idx').on(t.tenantId, t.lastMessageAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull().$type<'user' | 'assistant' | 'tool'>(),
    content: text('content'),
    toolName: text('tool_name'),
    toolInput: jsonb('tool_input'),
    toolResult: jsonb('tool_result'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.conversationId, t.seq)],
);

/**
 * Idempotency ledger for AI-originated writes.
 *
 * The unique key is what makes a retried tool call return the first result
 * instead of creating a second appointment (spec §33).
 */
export const toolInvocations = pgTable(
  'tool_invocations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    toolName: text('tool_name').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().$type<'succeeded' | 'failed'>(),
    result: jsonb('result'),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.idempotencyKey)],
);
