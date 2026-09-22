import type { Cents } from './money';

/**
 * Everything needed to price one configuration, already fetched and already
 * filtered to that configuration. Keeping this separate from the database lets
 * the pricing rules be tested exhaustively as pure functions.
 */

export interface PriceableModel {
  slug: string;
  name: string;
  fullName: string;
  baseMsrpCents: Cents;
}

export interface PriceablePowertrain {
  code: string;
  name: string;
  priceDeltaCents: Cents;
}

export interface PriceableTrim {
  code: string;
  name: string;
  priceDeltaCents: Cents;
}

export interface PriceableColour {
  code: string;
  name: string;
  kind: 'exterior' | 'interior';
  priceDeltaCents: Cents;
}

export interface PriceableOption {
  code: string;
  name: string;
  category: string;
  /** The dealership's own description of what the pack contains. */
  description: string | null;
  /** Included with this trim — selectable, but never charged. */
  isStandard: boolean;
  /** Resolved for this configuration: the override if set, else the list price. */
  priceCents: Cents;
}

export interface OptionRule {
  optionCode: string;
  rule: 'requires' | 'excludes';
  otherOptionCode: string;
}

export interface BuildContext {
  currency: string;
  locale: string;
  model: PriceableModel;
  powertrain: PriceablePowertrain;
  trim: PriceableTrim;
  configuration: { id: string; priceCents: Cents; isOrderable: boolean };
  /** Already restricted to this configuration. */
  exteriorColours: PriceableColour[];
  interiorColours: PriceableColour[];
  options: PriceableOption[];
  rules: OptionRule[];
}

export interface BuildSelection {
  exteriorColourCode?: string;
  interiorColourCode?: string;
  optionCodes?: string[];
}

export type PriceLineKind =
  | 'base' | 'powertrain' | 'trim' | 'exterior_colour' | 'interior_colour' | 'option';

export interface PriceLine {
  kind: PriceLineKind;
  code: string;
  label: string;
  amountCents: Cents;
  /** Standard equipment: shown on the breakdown, charged at zero. */
  included: boolean;
  formatted: string;
}

export interface PriceBreakdown {
  currency: string;
  configurationId: string;
  summary: string;
  lines: PriceLine[];
  totalCents: Cents;
  totalFormatted: string;
}
