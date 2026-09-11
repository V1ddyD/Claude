import {
  pgTable, uuid, text, boolean, timestamp, integer, bigint, date, primaryKey, unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export type InventoryStatus =
  | 'available' | 'reserved' | 'pending_delivery' | 'sold' | 'service_hold' | 'unavailable';

export const inventoryUnits = pgTable(
  'inventory_units',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    modelConfigurationId: uuid('model_configuration_id').notNull(),
    exteriorColourId: uuid('exterior_colour_id'),
    interiorColourId: uuid('interior_colour_id'),
    vin: text('vin'),
    stockNumber: text('stock_number').notNull(),
    status: text('status').notNull().default('available').$type<InventoryStatus>(),
    condition: text('condition').notNull().default('new').$type<'new' | 'demo' | 'used'>(),
    mileageKm: integer('mileage_km').notNull().default(0),
    askingPriceCents: bigint('asking_price_cents', { mode: 'number' }).notNull(),
    location: text('location'),
    estimatedDeliveryOn: date('estimated_delivery_on'),
    reservedUntil: timestamp('reserved_until', { withTimezone: true }),
    reservedForCustomerId: uuid('reserved_for_customer_id'),
    isDemoVehicle: boolean('is_demo_vehicle').notNull().default(false),
    /** Optimistic concurrency. A losing writer gets 409 and re-reads. */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.stockNumber),
    index('inventory_units_available_idx').on(t.tenantId, t.modelConfigurationId),
  ],
);

export const inventoryUnitOptions = pgTable(
  'inventory_unit_options',
  {
    tenantId: uuid('tenant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    optionId: uuid('option_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.unitId, t.optionId] })],
);

/** The state machine, as data. One function validates every transition. */
export const inventoryTransitions = pgTable(
  'inventory_transitions',
  {
    fromStatus: text('from_status').notNull().$type<InventoryStatus>(),
    toStatus: text('to_status').notNull().$type<InventoryStatus>(),
    requiredPermission: text('required_permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.fromStatus, t.toStatus] })],
);
