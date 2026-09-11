import {
  pgTable, uuid, text, timestamp, jsonb, bigint, smallint, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Append-only. The application role holds INSERT and SELECT but not UPDATE or
 * DELETE (migration 0002), so an audit trail cannot be rewritten by the code
 * that writes it.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id').notNull(),
    actorType: text('actor_type').notNull().$type<'staff' | 'customer' | 'ai' | 'system'>(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_entity_idx').on(t.tenantId, t.entityType, t.entityId, t.createdAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    recipientId: uuid('recipient_id'),
    roleTarget: text('role_target'),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    linkPath: text('link_path'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_unread_idx').on(t.tenantId, t.recipientId, t.createdAt)],
);

export const jobQueue = pgTable(
  'job_queue',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending')
      .$type<'pending' | 'running' | 'done' | 'failed' | 'dead'>(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_queue_claim_idx').on(t.status, t.runAt)],
);
