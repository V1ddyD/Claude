import {
  pgTable, uuid, text, boolean, timestamp, jsonb, char, time, date, smallint,
  unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull().unique(),
  legalName: text('legal_name').notNull(),
  brandName: text('brand_name').notNull(),
  timezone: text('timezone').notNull().default('America/Toronto'),
  currency: char('currency', { length: 3 }).notNull().default('CAD'),
  locale: text('locale').notNull().default('en-CA'),
  ticketPrefix: text('ticket_prefix').notNull().default('TKT'),
  status: text('status').notNull().default('active').$type<'active' | 'suspended' | 'onboarding'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantDomains = pgTable('tenant_domains', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  hostname: text('hostname').notNull().unique(),
  isPrimary: boolean('is_primary').notNull().default(false),
});

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  contact: jsonb('contact').notNull().default({}),
  booking: jsonb('booking').notNull().default({}),
  lead: jsonb('lead').notNull().default({}),
  ai: jsonb('ai').notNull().default({}),
  email: jsonb('email').notNull().default({}),
  finance: jsonb('finance').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const businessHours = pgTable(
  'business_hours',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    department: text('department').notNull().$type<'sales' | 'service'>(),
    dayOfWeek: smallint('day_of_week').notNull(),
    opensAt: time('opens_at').notNull(),
    closesAt: time('closes_at').notNull(),
  },
  (t) => [unique().on(t.tenantId, t.department, t.dayOfWeek)],
);

export const businessClosures = pgTable(
  'business_closures',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    department: text('department').$type<'sales' | 'service' | null>(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [index('business_closures_range_idx').on(t.tenantId, t.startsOn)],
);
