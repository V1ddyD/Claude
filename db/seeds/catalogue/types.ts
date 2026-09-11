/**
 * Seed shapes for the Sinclair catalogue.
 *
 * Configuration prices are never written by hand: they are computed as
 * base + powertrain delta + trim delta, which is the invariant the pricing
 * engine asserts at quote time. Hand-entered prices would let the two drift.
 */

export interface PowertrainSeed {
  code: string;
  name: string;
  kind: 'ice' | 'hybrid' | 'phev' | 'bev';
  engineDesc?: string;
  motorDesc?: string;
  batteryKwh?: number;
  transmission?: string;
  drivetrain: 'fwd' | 'rwd' | 'awd';
  horsepower: number;
  torqueNm: number;
  rangeKm?: number;
  consumptionL100?: number;
  consumptionLe?: number;
  priceDeltaCents: number;
}

export interface TrimSeed {
  code: string;
  name: string;
  tierOrder: number;
  summary: string;
  priceDeltaCents: number;
}

export interface ColourSeed {
  code: string;
  name: string;
  finish?: string;
  hex?: string;
  material?: string;
  priceDeltaCents: number;
  /** Absent means offered on every configuration of the model. */
  onlyOnTrims?: string[];
}

export interface OptionSeed {
  code: string;
  name: string;
  category: string;
  description: string;
  priceCents: number;
  /** Trims where this is included at no cost. */
  standardOn?: string[];
  /** Trims where it may be added. Absent means every trim. */
  optionalOn?: string[];
}

export interface OptionRuleSeed {
  option: string;
  rule: 'requires' | 'excludes';
  other: string;
}

export interface ModelSeed {
  slug: string;
  name: string;
  fullName: string;
  modelYear: number;
  bodyStyle: 'sedan' | 'coupe' | 'suv' | 'crossover' | 'pickup' | 'wagon';
  segment: string;
  tagline: string;
  overview: string;
  baseMsrpCents: number;
  displayOrder: number;
  powertrains: PowertrainSeed[];
  trims: TrimSeed[];
  /** Which trims each powertrain is offered with. This is the matrix. */
  matrix: Record<string, string[]>;
  exteriorColours: ColourSeed[];
  interiorColours: ColourSeed[];
  options: OptionSeed[];
  rules?: OptionRuleSeed[];
  /** Standard equipment shown on a trim's specification, by trim code. */
  features: Record<string, { category: string; label: string }[]>;
}
