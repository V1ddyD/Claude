import {
  pgTable, uuid, text, boolean, timestamp, smallint, integer, bigint, numeric, jsonb,
  unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export type LeadPriority = 'low' | 'medium' | 'high';
export type LeadStatus =
  | 'new' | 'contacted' | 'qualified' | 'appointment_scheduled'
  | 'test_drive_completed' | 'proposal_sent' | 'negotiating'
  | 'won' | 'lost' | 'nurture';

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    conversationId: uuid('conversation_id'),
    source: text('source').notNull().default('ai_assistant'),
    status: text('status').notNull().default('new').$type<LeadStatus>(),
    /** Computed by the rule engine, never set by the model or by staff. */
    priority: text('priority').notNull().default('low').$type<LeadPriority>(),
    score: smallint('score').notNull().default(0),
    scoreRationale: text('score_rationale'),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    modelId: uuid('model_id'),
    modelConfigurationId: uuid('model_configuration_id'),
    exteriorColourId: uuid('exterior_colour_id'),
    budgetCents: bigint('budget_cents', { mode: 'number' }),
    purchaseTimeframe: text('purchase_timeframe'),
    financeInterest: boolean('finance_interest'),
    tradeInInterest: boolean('trade_in_interest'),
    /** Internal only. Never rendered on any customer-facing surface. */
    aiSummary: text('ai_summary'),
    aiSummaryAt: timestamp('ai_summary_at', { withTimezone: true }),
    assignedStaffId: uuid('assigned_staff_id'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    handoffRequestedAt: timestamp('handoff_requested_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('leads_pipeline_idx').on(t.tenantId, t.priority, t.status, t.lastActivityAt),
    index('leads_assigned_idx').on(t.tenantId, t.assignedStaffId),
  ],
);

/**
 * Per-field evidence with confidence and provenance.
 *
 * `leads` holds the current best value for querying; this holds how we know it.
 * The scoring engine weights an uncertain budget below a stated one, and staff
 * can see which message a figure came from rather than an unsourced number.
 */
export const leadSignals = pgTable(
  'lead_signals',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    field: text('field').notNull(),
    value: jsonb('value').notNull(),
    confidence: numeric('confidence').notNull(),
    source: text('source').notNull().$type<'ai' | 'form' | 'staff'>(),
    extractedFromMessageId: uuid('extracted_from_message_id'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lead_signals_current_idx').on(t.leadId, t.field)],
);

export const leadEvents = pgTable(
  'lead_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    type: text('type').notNull(),
    actorType: text('actor_type').notNull().$type<'customer' | 'staff' | 'system' | 'ai'>(),
    actorId: uuid('actor_id'),
    summary: text('summary').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lead_events_timeline_idx').on(t.leadId, t.createdAt)],
);

export const staffNotes = pgTable('staff_notes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  leadId: uuid('lead_id'),
  customerId: uuid('customer_id'),
  authorId: uuid('author_id').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const followUpRules = pgTable(
  'follow_up_rules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    key: text('key').notNull(),
    description: text('description').notNull(),
    trigger: jsonb('trigger').notNull(),
    delayMinutes: integer('delay_minutes').notNull(),
    businessHoursOnly: boolean('business_hours_only').notNull().default(true),
    recommendedAction: text('recommended_action').notNull(),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [unique().on(t.tenantId, t.key)],
);

/**
 * A task for a person. Never a message to a customer.
 *
 * The unique key is what makes evaluation idempotent: a worker that runs twice
 * must not nag a salesperson twice.
 */
export const followUpTasks = pgTable(
  'follow_up_tasks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    leadId: uuid('lead_id'),
    appointmentId: uuid('appointment_id'),
    ruleKey: text('rule_key').notNull(),
    reason: text('reason').notNull(),
    recommendedAction: text('recommended_action').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    assignedStaffId: uuid('assigned_staff_id'),
    status: text('status').notNull().default('pending')
      .$type<'pending' | 'done' | 'dismissed'>(),
    completedBy: uuid('completed_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.leadId, t.ruleKey, t.dueAt)],
);

/** Tenant-configurable weights. The engine reads these, not constants. */
export const leadScoringRules = pgTable(
  'lead_scoring_rules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    key: text('key').notNull(),
    description: text('description').notNull(),
    condition: jsonb('condition').notNull(),
    weight: smallint('weight').notNull(),
    minConfidence: numeric('min_confidence').notNull().default('0.50'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [unique().on(t.tenantId, t.key)],
);
