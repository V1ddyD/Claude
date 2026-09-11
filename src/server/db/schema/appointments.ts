import {
  pgTable, uuid, text, boolean, timestamp, unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const resources = pgTable('resources', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull().$type<'staff' | 'vehicle' | 'bay'>(),
  name: text('name').notNull(),
  staffUserId: uuid('staff_user_id'),
  inventoryUnitId: uuid('inventory_unit_id'),
  isActive: boolean('is_active').notNull().default(true),
});

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    type: text('type').notNull().$type<'test_drive' | 'consultation' | 'service' | 'delivery'>(),
    status: text('status').notNull().default('scheduled')
      .$type<'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'>(),
    customerId: uuid('customer_id').notNull(),
    leadId: uuid('lead_id'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    confirmationCode: text('confirmation_code').notNull(),
    customerNotes: text('customer_notes'),
    internalNotes: text('internal_notes'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledReason: text('cancelled_reason'),
    createdByType: text('created_by_type').notNull().$type<'customer' | 'staff' | 'ai'>(),
    createdById: uuid('created_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.confirmationCode),
    index('appointments_diary_idx').on(t.tenantId, t.startsAt),
  ],
);

/**
 * What an appointment occupies.
 *
 * A test drive consumes a salesperson AND a demonstrator, each with its own
 * time range. The EXCLUDE constraint on this table (migration 0001) makes an
 * overlap on any one resource impossible under concurrency — double booking is
 * prevented by Postgres, not by check-then-insert.
 *
 * `timeRange` is a generated column; it is never written from application code.
 */
export const appointmentResources = pgTable('appointment_resources', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  appointmentId: uuid('appointment_id').notNull(),
  resourceId: uuid('resource_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active').$type<'active' | 'released'>(),
});
