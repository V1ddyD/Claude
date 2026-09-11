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

export function projectPowertrain(pt: {
  code: string; name: string; kind: string; drivetrain: string;
  horsepower: number | null; rangeKm: number | null; offeredWithTrims: string[];
}) {
  return {
    code: pt.code,
    name: pt.name,
    type: pt.kind,
    drivetrain: pt.drivetrain.toUpperCase(),
    horsepower: pt.horsepower,
    electricRangeKm: pt.rangeKm,
    // So the assistant can only propose combinations that are actually built.
    offeredWithTrims: pt.offeredWithTrims,
  };
}

export function projectTrim(
  trim: { code: string; name: string; fromPriceCents: number },
  m: Money,
) {
  return { code: trim.code, name: trim.name, priceFrom: money(trim.fromPriceCents, m) };
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
