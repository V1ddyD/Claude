import type { ModelSeed } from './types';
import {
  CORE_EXTERIOR, PERFORMANCE_EXTERIOR, CORE_INTERIOR, PREMIUM_INTERIOR, commonOptions,
} from './palettes';

const YEAR = 2026;

/**
 * Sinclair's combustion and hybrid range.
 *
 * Note the matrices: the entry engine is not offered on the top trim, and the
 * performance engine is not offered on the base one. That asymmetry is the
 * point — a configurator that lets you build any combination does not resemble
 * a real manufacturer's.
 */

export const S1: ModelSeed = {
  slug: 's1',
  name: 'S1',
  fullName: 'Sinclair S1',
  modelYear: YEAR,
  bodyStyle: 'sedan',
  segment: 'Compact Sedan',
  tagline: 'The shortest distance between intention and arrival.',
  overview:
    'Sinclair engineering at its most distilled. The S1 carries the range\'s ' +
    'structural rigidity and cabin isolation into a compact footprint.',
  baseMsrpCents: 3_290_000,
  displayOrder: 10,
  powertrains: [
    {
      code: '1.5T-FWD', name: '1.5 Turbo FWD', kind: 'ice',
      engineDesc: '1.5L turbocharged inline-4', transmission: '8-speed automatic',
      drivetrain: 'fwd', horsepower: 190, torqueNm: 280, consumptionL100: 7.1,
      priceDeltaCents: 0,
    },
    {
      code: '2.0T-AWD', name: '2.0 Turbo AWD', kind: 'ice',
      engineDesc: '2.0L turbocharged inline-4', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 255, torqueNm: 400, consumptionL100: 8.4,
      priceDeltaCents: 320_000,
    },
  ],
  trims: [
    { code: 'CORE', name: 'Core', tierOrder: 1, summary: 'Complete as standard.', priceDeltaCents: 0 },
    { code: 'PREMIUM', name: 'Premium', tierOrder: 2, summary: 'Material and acoustic upgrade.', priceDeltaCents: 410_000 },
  ],
  matrix: { '1.5T-FWD': ['CORE', 'PREMIUM'], '2.0T-AWD': ['PREMIUM'] },
  exteriorColours: CORE_EXTERIOR,
  interiorColours: CORE_INTERIOR,
  options: commonOptions({
    TECH: { priceCents: 245_000, standardOn: ['PREMIUM'] },
    COMFORT: { priceCents: 190_000, optionalOn: ['PREMIUM'] },
    AUDIO: { priceCents: 140_000 },
    ASSIST: { priceCents: 185_000 },
    PANO: { priceCents: 145_000 },
    TOW: { priceCents: 0, optionalOn: [] },
  }).filter((o) => o.code !== 'TOW'),
  features: {
    CORE: [
      { category: 'safety', label: 'Forward collision mitigation' },
      { category: 'technology', label: '11.5-inch centre display' },
      { category: 'comfort', label: 'Dual-zone climate control' },
    ],
    PREMIUM: [
      { category: 'safety', label: 'Blind-spot intervention' },
      { category: 'technology', label: 'Head-up display' },
      { category: 'comfort', label: 'Heated front seats and steering wheel' },
      { category: 'exterior', label: '18-inch alloy wheels' },
    ],
  },
};

export const S3: ModelSeed = {
  slug: 's3',
  name: 'S3',
  fullName: 'Sinclair S3',
  modelYear: YEAR,
  bodyStyle: 'sedan',
  segment: 'Sport Sedan',
  tagline: 'Composure, at pace.',
  overview:
    'Rear-biased balance, adaptive damping and a chassis developed for sustained ' +
    'load. The S3 is the range\'s driver\'s car below the R.',
  baseMsrpCents: 4_690_000,
  displayOrder: 20,
  powertrains: [
    {
      code: '2.0T-RWD', name: '2.0 Turbo RWD', kind: 'ice',
      engineDesc: '2.0L turbocharged inline-4', transmission: '8-speed automatic',
      drivetrain: 'rwd', horsepower: 265, torqueNm: 400, consumptionL100: 8.2,
      priceDeltaCents: 0,
    },
    {
      code: '3.0T-AWD', name: '3.0 Turbo AWD', kind: 'ice',
      engineDesc: '3.0L turbocharged inline-6', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 385, torqueNm: 520, consumptionL100: 9.6,
      priceDeltaCents: 620_000,
    },
  ],
  trims: [
    { code: 'SPORT', name: 'Sport', tierOrder: 1, summary: 'Adaptive damping as standard.', priceDeltaCents: 0 },
    { code: 'SPORT_PLUS', name: 'Sport Plus', tierOrder: 2, summary: 'Limited-slip differential and sport exhaust.', priceDeltaCents: 540_000 },
  ],
  matrix: { '2.0T-RWD': ['SPORT'], '3.0T-AWD': ['SPORT', 'SPORT_PLUS'] },
  exteriorColours: [...CORE_EXTERIOR, ...PERFORMANCE_EXTERIOR],
  interiorColours: [...CORE_INTERIOR, ...PREMIUM_INTERIOR],
  options: commonOptions({
    TECH: { standardOn: ['SPORT_PLUS'] },
    TOW: { optionalOn: [] },
  }).filter((o) => o.code !== 'TOW'),
  rules: [{ option: 'AUDIO', rule: 'requires', other: 'TECH' }],
  features: {
    SPORT: [
      { category: 'chassis', label: 'Adaptive damping' },
      { category: 'technology', label: '12.3-inch driver display' },
      { category: 'safety', label: 'Lane-keeping assistance' },
    ],
    SPORT_PLUS: [
      { category: 'chassis', label: 'Electronic limited-slip differential' },
      { category: 'chassis', label: 'Uprated braking system' },
      { category: 'exterior', label: '19-inch forged wheels' },
      { category: 'interior', label: 'Sport seats with extended bolstering' },
    ],
  },
};

export const S5: ModelSeed = {
  slug: 's5',
  name: 'S5',
  fullName: 'Sinclair S5',
  modelYear: YEAR,
  bodyStyle: 'suv',
  segment: 'Premium Mid-Size SUV',
  tagline: 'Room for everything you intended to do.',
  overview:
    'The S5 is the centre of the Sinclair range: a mid-size SUV with the ' +
    'isolation of the executive cars and a cabin sized for real use.',
  baseMsrpCents: 5_290_000,
  displayOrder: 30,
  powertrains: [
    {
      code: '2.0T-AWD', name: '2.0 Turbo AWD', kind: 'ice',
      engineDesc: '2.0L turbocharged inline-4', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 275, torqueNm: 420, consumptionL100: 9.1,
      priceDeltaCents: 350_000,
    },
    {
      code: '3.0T-AWD', name: '3.0 Turbo AWD', kind: 'ice',
      engineDesc: '3.0L turbocharged inline-6', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 395, torqueNm: 550, consumptionL100: 10.4,
      priceDeltaCents: 780_000,
    },
    {
      code: '2.5H-AWD', name: '2.5 Hybrid AWD', kind: 'hybrid',
      engineDesc: '2.5L inline-4 with integrated motor', motorDesc: 'Single rear motor',
      transmission: 'e-CVT', drivetrain: 'awd', horsepower: 305, torqueNm: 460,
      consumptionL100: 6.4, priceDeltaCents: 520_000,
    },
  ],
  trims: [
    { code: 'CORE', name: 'Core', tierOrder: 1, summary: 'The complete S5.', priceDeltaCents: 0 },
    { code: 'PREMIUM', name: 'Premium', tierOrder: 2, summary: 'Technology and material upgrade.', priceDeltaCents: 250_000 },
    { code: 'LUXURY', name: 'Luxury', tierOrder: 3, summary: 'Nappa leather, air suspension, executive rear.', priceDeltaCents: 720_000 },
  ],
  matrix: {
    '2.0T-AWD': ['CORE', 'PREMIUM'],
    '2.5H-AWD': ['PREMIUM', 'LUXURY'],
    '3.0T-AWD': ['PREMIUM', 'LUXURY'],
  },
  exteriorColours: CORE_EXTERIOR,
  interiorColours: [...CORE_INTERIOR, ...PREMIUM_INTERIOR],
  options: commonOptions({
    TECH: { standardOn: ['PREMIUM', 'LUXURY'] },
    COMFORT: { standardOn: ['LUXURY'] },
    AUDIO: { standardOn: ['LUXURY'] },
    PANO: { standardOn: ['LUXURY'] },
  }),
  rules: [
    { option: 'COMFORT', rule: 'requires', other: 'TECH' },
    { option: 'TOW', rule: 'excludes', other: 'PANO' },
  ],
  features: {
    CORE: [
      { category: 'safety', label: 'Forward collision mitigation with junction assist' },
      { category: 'technology', label: '12.3-inch centre display' },
      { category: 'comfort', label: 'Three-zone climate control' },
      { category: 'exterior', label: '19-inch alloy wheels' },
    ],
    PREMIUM: [
      { category: 'technology', label: 'Head-up display' },
      { category: 'technology', label: '360-degree camera' },
      { category: 'comfort', label: 'Heated and power front seats' },
      { category: 'exterior', label: '20-inch alloy wheels' },
    ],
    LUXURY: [
      { category: 'chassis', label: 'Adaptive air suspension' },
      { category: 'interior', label: 'Nappa leather throughout' },
      { category: 'comfort', label: 'Ventilated and massaging front seats' },
      { category: 'comfort', label: 'Rear window blinds' },
    ],
  },
};

export const S7: ModelSeed = {
  slug: 's7',
  name: 'S7',
  fullName: 'Sinclair S7',
  modelYear: YEAR,
  bodyStyle: 'sedan',
  segment: 'Executive Sedan',
  tagline: 'Arrive unhurried.',
  overview:
    'The S7 is Sinclair\'s executive sedan: long wheelbase, air suspension and ' +
    'a rear cabin designed to be worked from.',
  baseMsrpCents: 7_890_000,
  displayOrder: 40,
  powertrains: [
    {
      code: '3.0T-AWD', name: '3.0 Turbo AWD', kind: 'ice',
      engineDesc: '3.0L turbocharged inline-6', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 395, torqueNm: 550, consumptionL100: 9.8,
      priceDeltaCents: 0,
    },
    {
      code: '3.0PHEV-AWD', name: '3.0 Plug-in Hybrid AWD', kind: 'phev',
      engineDesc: '3.0L turbocharged inline-6', motorDesc: 'Integrated 100 kW motor',
      batteryKwh: 25.7, transmission: '8-speed automatic', drivetrain: 'awd',
      horsepower: 490, torqueNm: 700, rangeKm: 82, consumptionL100: 2.9,
      priceDeltaCents: 940_000,
    },
  ],
  trims: [
    { code: 'PREMIUM', name: 'Premium', tierOrder: 1, summary: 'The executive standard.', priceDeltaCents: 0 },
    { code: 'LUXURY', name: 'Luxury', tierOrder: 2, summary: 'Rear executive seating.', priceDeltaCents: 680_000 },
    { code: 'EXECUTIVE', name: 'Executive', tierOrder: 3, summary: 'Four-seat rear cabin, rear entertainment.', priceDeltaCents: 1_450_000 },
  ],
  matrix: {
    '3.0T-AWD': ['PREMIUM', 'LUXURY'],
    '3.0PHEV-AWD': ['LUXURY', 'EXECUTIVE'],
  },
  exteriorColours: CORE_EXTERIOR,
  interiorColours: PREMIUM_INTERIOR,
  options: commonOptions({
    TECH: { standardOn: ['PREMIUM', 'LUXURY', 'EXECUTIVE'] },
    COMFORT: { standardOn: ['LUXURY', 'EXECUTIVE'] },
    AUDIO: { standardOn: ['EXECUTIVE'] },
    PANO: { standardOn: ['LUXURY', 'EXECUTIVE'] },
  }).filter((o) => o.code !== 'TOW'),
  features: {
    PREMIUM: [
      { category: 'chassis', label: 'Adaptive air suspension' },
      { category: 'technology', label: 'Head-up display' },
      { category: 'interior', label: 'Nappa leather throughout' },
    ],
    LUXURY: [
      { category: 'comfort', label: 'Ventilated and massaging front seats' },
      { category: 'comfort', label: 'Heated rear seats' },
      { category: 'technology', label: 'Rear touchscreen climate control' },
    ],
    EXECUTIVE: [
      { category: 'interior', label: 'Four-seat rear cabin with centre console' },
      { category: 'comfort', label: 'Reclining rear seats with footrest' },
      { category: 'technology', label: 'Dual rear entertainment displays' },
    ],
  },
};
