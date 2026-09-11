import {
  pgTable, uuid, text, boolean, timestamp, integer, primaryKey, unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export type TicketType =
  | 'sales_enquiry' | 'test_drive' | 'financing' | 'trade_in'
  | 'callback' | 'general' | 'support' | 'service';

/** Gapless per-tenant numbering, row-locked inside the creating transaction. */
export const ticketSequences = pgTable(
  'ticket_sequences',
  {
    tenantId: uuid('tenant_id').notNull(),
    period: text('period').notNull(),
    nextValue: integer('next_value').notNull().default(10001),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.period] })],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    number: text('number').notNull(),
    type: text('type').notNull().$type<TicketType>(),
    status: text('status').notNull().default('open')
      .$type<'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed'>(),
    subject: text('subject').notNull(),
    body: text('body'),
    customerId: uuid('customer_id').notNull(),
    leadId: uuid('lead_id'),
    appointmentId: uuid('appointment_id'),
    assignedStaffId: uuid('assigned_staff_id'),
    createdByType: text('created_by_type').notNull().$type<'customer' | 'staff' | 'ai'>(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.number)],
);

export const ticketMessages = pgTable('ticket_messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  authorType: text('author_type').notNull().$type<'customer' | 'staff' | 'ai' | 'system'>(),
  authorId: uuid('author_id'),
  body: text('body').notNull(),
  /** True rows are never rendered on a customer-facing surface. */
  isInternal: boolean('is_internal').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
