import {
  pgTable, uuid, text, boolean, timestamp, integer, smallint, bigint, char,
  numeric, jsonb, primaryKey, unique, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The vehicle catalogue.
 *
 * The shape that matters: a model does not have one price. It has a matrix of
 * offered powertrain x trim combinations (`modelConfigurations`), and options,
 * colours and features hang off that matrix rather than off the model — because
 * the base engine is usually not offered on the top trim, and an option that is
 * standard on Premium is a paid extra on Core.
 *
 * See docs/04-spec-review.md §19 for why this level exists.
 */

export const vehicleModels = pgTable(
  'vehicle_models',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    modelYear: smallint('model_year').notNull(),
    bodyStyle: text('body_style').notNull()
      .$type<'sedan' | 'coupe' | 'suv' | 'crossover' | 'pickup' | 'wagon'>(),
    segment: text('segment').notNull(),
    tagline: text('tagline'),
    overview: text('overview'),
    baseMsrpCents: bigint('base_msrp_cents', { mode: 'number' }).notNull(),
    heroImageUrl: text('hero_image_url'),
    displayOrder: integer('display_order').notNull().default(0),
    status: text('status').notNull().default('published')
      .$type<'draft' | 'published' | 'archived'>(),
    sourceTemplateId: uuid('source_template_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.slug, t.modelYear)],
);

export const powertrains = pgTable(
  'powertrains',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    modelId: uuid('model_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().$type<'ice' | 'hybrid' | 'phev' | 'bev'>(),
    engineDesc: text('engine_desc'),
    motorDesc: text('motor_desc'),
    batteryKwh: numeric('battery_kwh'),
    transmission: text('transmission'),
    drivetrain: text('drivetrain').notNull().$type<'fwd' | 'rwd' | 'awd'>(),
    horsepower: integer('horsepower'),
    torqueNm: integer('torque_nm'),
    rangeKm: integer('range_km'),
    consumptionL100: numeric('consumption_l100'),
    consumptionLe: numeric('consumption_le'),
    priceDeltaCents: bigint('price_delta_cents', { mode: 'number' }).notNull().default(0),
    displayOrder: integer('display_order').notNull().default(0),
  },
  (t) => [unique().on(t.tenantId, t.modelId, t.code)],
);

export const trims = pgTable(
  'trims',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    modelId: uuid('model_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    tierOrder: smallint('tier_order').notNull(),
    summary: text('summary'),
    priceDeltaCents: bigint('price_delta_cents', { mode: 'number' }).notNull().default(0),
  },
  (t) => [unique().on(t.tenantId, t.modelId, t.code)],
);

/** The buildable matrix. `priceCents` is authoritative for the combination. */
export const modelConfigurations = pgTable(
  'model_configurations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    modelId: uuid('model_id').notNull(),
    powertrainId: uuid('powertrain_id').notNull(),
    trimId: uuid('trim_id').notNull(),
    priceCents: bigint('price_cents', { mode: 'number' }).notNull(),
    isOrderable: boolean('is_orderable').notNull().default(true),
  },
  (t) => [unique().on(t.tenantId, t.powertrainId, t.trimId)],
);

export const colours = pgTable(
  'colours',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    modelId: uuid('model_id').notNull(),
    kind: text('kind').notNull().$type<'exterior' | 'interior'>(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    finish: text('finish'),
    hex: char('hex', { length: 7 }),
    material: text('material'),
    priceDeltaCents: bigint('price_delta_cents', { mode: 'number' }).notNull().default(0),
    swatchUrl: text('swatch_url'),
    displayOrder: integer('display_order').notNull().default(0),
  },
  (t) => [unique().on(t.tenantId, t.modelId, t.kind, t.code)],
);

/** Presence restricts a colour to those configurations; absence means all. */
export const colourAvailability = pgTable(
  'colour_availability',
  {
    tenantId: uuid('tenant_id').notNull(),
    colourId: uuid('colour_id').notNull(),
    modelConfigurationId: uuid('model_configuration_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.colourId, t.modelConfigurationId] })],
);

export const options = pgTable(
  'options',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    modelId: uuid('model_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    description: text('description'),
    priceCents: bigint('price_cents', { mode: 'number' }).notNull().default(0),
  },
  (t) => [unique().on(t.tenantId, t.modelId, t.code)],
);

/**
 * An option's relationship to one configuration. A row must exist for the
 * option to be selectable at all: absence means "not offered on this build".
 */
export const optionAvailability = pgTable(
  'option_availability',
  {
    tenantId: uuid('tenant_id').notNull(),
    optionId: uuid('option_id').notNull(),
    modelConfigurationId: uuid('model_configuration_id').notNull(),
    isStandard: boolean('is_standard').notNull().default(false),
    priceOverrideCents: bigint('price_override_cents', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.optionId, t.modelConfigurationId] })],
);

export const optionRules = pgTable('option_rules', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  optionId: uuid('option_id').notNull(),
  rule: text('rule').notNull().$type<'requires' | 'excludes'>(),
  otherOptionId: uuid('other_option_id').notNull(),
});

export const vehicleFeatures = pgTable(
  'vehicle_features',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    modelConfigurationId: uuid('model_configuration_id').notNull(),
    category: text('category').notNull(),
    label: text('label').notNull(),
    displayOrder: integer('display_order').notNull().default(0),
  },
  (t) => [index('vehicle_features_config_idx').on(t.modelConfigurationId)],
);

/** A visitor's chosen build, with the price as quoted at the time. */
export const savedBuilds = pgTable('saved_builds', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  visitorId: uuid('visitor_id'),
  customerId: uuid('customer_id'),
  modelConfigurationId: uuid('model_configuration_id').notNull(),
  exteriorColourId: uuid('exterior_colour_id'),
  interiorColourId: uuid('interior_colour_id'),
  optionIds: uuid('option_ids').array().notNull().default(sql`'{}'`),
  priceBreakdown: jsonb('price_breakdown').notNull(),
  totalPriceCents: bigint('total_price_cents', { mode: 'number' }).notNull(),
  shareToken: text('share_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const catalogueEvents = pgTable('catalogue_events', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  visitorId: uuid('visitor_id'),
  event: text('event').notNull(),
  modelId: uuid('model_id'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
