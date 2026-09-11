import type { ModelSeed } from './types';
import { CORE_EXTERIOR, CORE_INTERIOR, PREMIUM_INTERIOR, commonOptions } from './palettes';

const YEAR = 2026;

/**
 * Sinclair's electric range.
 *
 * Battery-electric powertrains carry `batteryKwh` and `rangeKm` rather than
 * fuel consumption — the schema has a CHECK enforcing that a BEV declares a
 * battery, so a mis-seeded electric car is rejected by the database.
 */

export const E2: ModelSeed = {
  slug: 'e2',
  name: 'E2',
  fullName: 'Sinclair E2',
  modelYear: YEAR,
  bodyStyle: 'crossover',
  segment: 'Compact Electric Crossover',
  tagline: 'Quiet, from the first metre.',
  overview:
    'Sinclair\'s compact electric crossover: 800-volt architecture, a flat floor ' +
    'and a cabin that feels a class above its footprint.',
  baseMsrpCents: 4_890_000,
  displayOrder: 90,
  powertrains: [
    {
      code: 'RWD-STD', name: 'Single Motor RWD', kind: 'bev',
      motorDesc: 'Rear-mounted permanent magnet motor', batteryKwh: 66,
      drivetrain: 'rwd', horsepower: 250, torqueNm: 380, rangeKm: 425,
      consumptionLe: 2.1, priceDeltaCents: 0,
    },
    {
      code: 'AWD-LR', name: 'Dual Motor AWD Long Range', kind: 'bev',
      motorDesc: 'Front and rear motors', batteryKwh: 84,
      drivetrain: 'awd', horsepower: 385, torqueNm: 610, rangeKm: 515,
      consumptionLe: 2.3, priceDeltaCents: 720_000,
    },
  ],
  trims: [
    { code: 'CORE', name: 'Core', tierOrder: 1, summary: 'Complete as standard.', priceDeltaCents: 0 },
    { code: 'PREMIUM', name: 'Premium', tierOrder: 2, summary: 'Heat pump, technology and material upgrade.', priceDeltaCents: 470_000 },
  ],
  matrix: { 'RWD-STD': ['CORE', 'PREMIUM'], 'AWD-LR': ['PREMIUM'] },
  exteriorColours: CORE_EXTERIOR,
  interiorColours: CORE_INTERIOR,
  options: commonOptions({
    TECH: { standardOn: ['PREMIUM'] },
    COMFORT: { priceCents: 190_000, optionalOn: ['PREMIUM'] },
    AUDIO: { priceCents: 150_000 },
    PANO: { standardOn: ['PREMIUM'] },
  }).filter((o) => o.code !== 'TOW'),
  features: {
    CORE: [
      { category: 'powertrain', label: '800-volt architecture, 180 kW peak charging' },
      { category: 'technology', label: '12.3-inch centre display' },
      { category: 'safety', label: 'Forward collision mitigation' },
    ],
    PREMIUM: [
      { category: 'powertrain', label: 'Heat pump thermal management' },
      { category: 'comfort', label: 'Heated front seats and steering wheel' },
      { category: 'technology', label: 'Head-up display' },
    ],
  },
};

export const E5: ModelSeed = {
  slug: 'e5',
  name: 'E5',
  fullName: 'Sinclair E5',
  modelYear: YEAR,
  bodyStyle: 'suv',
  segment: 'Premium Electric SUV',
  tagline: 'The S5, reconsidered.',
  overview:
    'A premium electric SUV on a dedicated platform: air suspension across the ' +
    'range, 800-volt charging and the isolation the S5 is known for.',
  baseMsrpCents: 6_890_000,
  displayOrder: 100,
  powertrains: [
    {
      code: 'AWD-LR', name: 'Dual Motor AWD Long Range', kind: 'bev',
      motorDesc: 'Front and rear motors', batteryKwh: 102,
      drivetrain: 'awd', horsepower: 480, torqueNm: 720, rangeKm: 560,
      consumptionLe: 2.4, priceDeltaCents: 0,
    },
    {
      code: 'AWD-PERF', name: 'Tri Motor AWD Performance', kind: 'bev',
      motorDesc: 'One front, two rear motors', batteryKwh: 102,
      drivetrain: 'awd', horsepower: 680, torqueNm: 980, rangeKm: 505,
      consumptionLe: 2.7, priceDeltaCents: 1_150_000,
    },
  ],
  trims: [
    { code: 'PREMIUM', name: 'Premium', tierOrder: 1, summary: 'Air suspension, full technology.', priceDeltaCents: 0 },
    { code: 'LUXURY', name: 'Luxury', tierOrder: 2, summary: 'Nappa leather, executive rear, acoustic glass.', priceDeltaCents: 690_000 },
  ],
  matrix: { 'AWD-LR': ['PREMIUM', 'LUXURY'], 'AWD-PERF': ['LUXURY'] },
  exteriorColours: CORE_EXTERIOR,
  interiorColours: [...CORE_INTERIOR, ...PREMIUM_INTERIOR],
  options: commonOptions({
    TECH: { standardOn: ['PREMIUM', 'LUXURY'] },
    COMFORT: { standardOn: ['LUXURY'] },
    AUDIO: { standardOn: ['LUXURY'] },
    PANO: { standardOn: ['PREMIUM', 'LUXURY'] },
    TOW: { priceCents: 135_000 },
  }),
  rules: [{ option: 'COMFORT', rule: 'requires', other: 'TECH' }],
  features: {
    PREMIUM: [
      { category: 'powertrain', label: '800-volt architecture, 250 kW peak charging' },
      { category: 'chassis', label: 'Adaptive air suspension' },
      { category: 'technology', label: '360-degree camera and head-up display' },
    ],
    LUXURY: [
      { category: 'interior', label: 'Nappa leather throughout' },
      { category: 'comfort', label: 'Ventilated and massaging front seats' },
      { category: 'comfort', label: 'Acoustic laminated glass' },
    ],
  },
};
