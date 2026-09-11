import {
  pgTable, uuid, text, boolean, timestamp, integer, smallint, bigint, jsonb,
  primaryKey, unique,
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

export const financeRequests = pgTable('finance_requests', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  leadId: uuid('lead_id'),
  ticketId: uuid('ticket_id'),
  vehiclePriceCents: bigint('vehicle_price_cents', { mode: 'number' }).notNull(),
  downPaymentCents: bigint('down_payment_cents', { mode: 'number' }).notNull().default(0),
  termMonths: smallint('term_months').notNull(),
  aprBps: integer('apr_bps'),
  /** The figures quoted, stored as an estimate. Never an approval. */
  estimate: jsonb('estimate').notNull(),
  status: text('status').notNull().default('new')
    .$type<'new' | 'in_review' | 'referred' | 'closed'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tradeInRequests = pgTable('trade_in_requests', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  leadId: uuid('lead_id'),
  ticketId: uuid('ticket_id'),
  vehicleYear: smallint('vehicle_year').notNull(),
  vehicleMake: text('vehicle_make').notNull(),
  vehicleModel: text('vehicle_model').notNull(),
  vehicleTrim: text('vehicle_trim'),
  mileageKm: integer('mileage_km').notNull(),
  condition: text('condition').notNull().$type<'excellent' | 'good' | 'fair' | 'poor'>(),
  vin: text('vin'),
  ownsOutright: boolean('owns_outright'),
  payoffCents: bigint('payoff_cents', { mode: 'number' }),
  notes: text('notes'),
  /** Null until a human inspects the vehicle. The AI never fills this in. */
  appraisedValueCents: bigint('appraised_value_cents', { mode: 'number' }),
  appraisedBy: uuid('appraised_by'),
  appraisedAt: timestamp('appraised_at', { withTimezone: true }),
  status: text('status').notNull().default('new')
    .$type<'new' | 'inspection_booked' | 'appraised' | 'closed'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
