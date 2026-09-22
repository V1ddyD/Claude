import { formatMoney } from '@/server/services/pricing';

/**
 * The leak boundary.
 *
 * Every tool result passes through one of these before entering the model's
 * context. Hand-written whitelists, not spreads: a spread picks up whatever a
 * query happens to select, and the day someone adds `acquisitionCostCents` to
 * a select list is the day it reaches a customer.
 *
 * Never projected: cost or margin, days in stock, internal notes, lead priority
 * or score, AI summaries, staff identity beyond a first name, other customers,
 * other tenants, email logs, audit rows.
 */

interface Money {
  currency: string;
  locale: string;
}

/** Formatted for quoting, plus minor units so the model never does decimal maths. */
export function money(cents: number, { currency, locale }: Money) {
  return { formatted: formatMoney(cents, currency, locale), cents };
}

export function projectModelSummary(
  model: {
    slug: string; name: string; fullName: string; segment: string;
    bodyStyle: string; tagline: string | null; baseMsrpCents: number;
  },
  m: Money,
) {
  return {
    slug: model.slug,
    name: model.fullName,
    segment: model.segment,
    bodyStyle: model.bodyStyle,
    tagline: model.tagline,
    priceFrom: money(model.baseMsrpCents, m),
  };
}

/**
 * An engine, in the detail a customer actually asks about.
 *
 * This used to project four fields out of a dozen, and the rest — what the
 * engine IS, what gearbox it has, what it pulls, what it drinks — sat in the
 * database and never reached anyone. The result was an assistant that said "I
 * don't have that" about a figure it was holding.
 *
 * Nothing here is computed or inferred. Every field is a column the dealership
 * filled in, and a column they left empty comes back null and is simply not
 * mentioned.
 */
export function projectPowertrain(pt: {
  code: string; name: string; kind: string; drivetrain: string;
  horsepower: number | null; rangeKm: number | null; offeredWithTrims: string[];
  engineDesc?: string | null; motorDesc?: string | null; transmission?: string | null;
  torqueNm?: number | null; batteryKwh?: string | null;
  consumptionL100?: string | null; consumptionLe?: string | null;
}) {
  return {
    code: pt.code,
    name: pt.name,
    type: pt.kind,
    drivetrain: pt.drivetrain.toUpperCase(),
    horsepower: pt.horsepower,
    electricRangeKm: pt.rangeKm,
    engine: pt.engineDesc ?? null,
    motor: pt.motorDesc ?? null,
    transmission: pt.transmission ?? null,
    torqueNm: pt.torqueNm ?? null,
    batteryKwh: numeric(pt.batteryKwh),
    // Two different units for two different kinds of car. Kept apart rather
    // than merged into one "efficiency" number that means neither.
    fuelConsumptionL100: numeric(pt.consumptionL100),
    electricConsumptionLe: numeric(pt.consumptionLe),
    // So the assistant can only propose combinations that are actually built.
    offeredWithTrims: pt.offeredWithTrims,
  };
}

/** Postgres numerics arrive as strings. Null stays null; nonsense stays out. */
function numeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectTrim(
  trim: { code: string; name: string; fromPriceCents: number; summary?: string | null },
  m: Money,
) {
  return {
    code: trim.code,
    name: trim.name,
    priceFrom: money(trim.fromPriceCents, m),
    // The dealership's own one-line description of the trim. Written by them,
    // for customers, and previously never shown to one.
    summary: trim.summary ?? null,
  };
}

export function projectInventoryUnit(
  unit: {
    stockNumber: string; exteriorColour: string | null; interiorColour: string | null;
    askingPriceCents: number; estimatedDeliveryOn: string | null; condition: string;
  },
  m: Money,
  asOf: Date,
) {
  return {
    stockNumber: unit.stockNumber,
    exteriorColour: unit.exteriorColour,
    interiorColour: unit.interiorColour,
    condition: unit.condition,
    price: money(unit.askingPriceCents, m),
    estimatedDelivery: unit.estimatedDeliveryOn,
    // Availability is a fact with a timestamp, not a standing promise.
    asOf: asOf.toISOString(),
  };
}
