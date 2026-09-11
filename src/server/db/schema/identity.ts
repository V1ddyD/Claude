import {
  pgTable, uuid, text, boolean, timestamp, integer, primaryKey, unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { citext } from './_shared';

export type StaffRole = 'sales' | 'service' | 'manager' | 'admin';

/** Global reference data: what a role may do is a property of the product. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    role: text('role').notNull().$type<StaffRole>(),
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.role, t.permission] })],
);

/**
 * A row here is what grants Dealer Portal access. Membership in the auth
 * provider's user pool grants nothing: customers and staff share one pool, and
 * this table is the only thing separating them.
 */
export const staffUsers = pgTable(
  'staff_users',
  {
    id: uuid('id').primaryKey(), // = auth user id
    tenantId: uuid('tenant_id').notNull(),
    email: citext('email').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role').notNull().$type<StaffRole>(),
    status: text('status').notNull().default('invited').$type<'invited' | 'active' | 'suspended'>(),
    phone: text('phone'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.email)],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    authUserId: uuid('auth_user_id'),
    fullName: text('full_name'),
    email: citext('email'),
    phone: text('phone'),
    preferredContact: text('preferred_contact').$type<'email' | 'phone' | 'sms' | 'any' | null>(),
    contactConsent: boolean('contact_consent').notNull().default(false),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    consentSource: text('consent_source'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('customers_tenant_phone_idx').on(t.tenantId, t.phone)],
);

/** Anonymous browsing identity. Carries no PII until a customer is linked. */
export const visitors = pgTable('visitors', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  customerId: uuid('customer_id'),
  sessionCount: integer('session_count').notNull().default(1),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});
