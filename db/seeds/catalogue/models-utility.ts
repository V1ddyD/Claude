import type { ModelSeed } from './types';
import {
  CORE_EXTERIOR, PERFORMANCE_EXTERIOR, CORE_INTERIOR, PREMIUM_INTERIOR, commonOptions,
} from './palettes';

const YEAR = 2026;

export const X7: ModelSeed = {
  slug: 'x7',
  name: 'X7',
  fullName: 'Sinclair X7',
  modelYear: YEAR,
  bodyStyle: 'suv',
  segment: 'Full-Size Luxury SUV',
  tagline: 'Seven seats, no compromises among them.',
  overview:
    'The X7 carries the S7\'s isolation into a three-row body, with a third row ' +
    'sized for adults and air suspension across the range.',
  baseMsrpCents: 8_950_000,
  displayOrder: 50,
  powertrains: [
    {
      code: '3.0T-AWD', name: '3.0 Turbo AWD', kind: 'ice',
      engineDesc: '3.0L turbocharged inline-6', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 395, torqueNm: 550, consumptionL100: 11.2,
      priceDeltaCents: 0,
    },
    {
      code: '4.4T-AWD', name: '4.4 Twin Turbo AWD', kind: 'ice',
      engineDesc: '4.4L twin-turbocharged V8', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 530, torqueNm: 750, consumptionL100: 13.1,
      priceDeltaCents: 1_180_000,
    },
  ],
  trims: [
    { code: 'LUXURY', name: 'Luxury', tierOrder: 1, summary: 'Seven seats, air suspension.', priceDeltaCents: 0 },
    { code: 'EXECUTIVE', name: 'Executive', tierOrder: 2, summary: 'Six-seat second row, rear entertainment.', priceDeltaCents: 890_000 },
  ],
  matrix: { '3.0T-AWD': ['LUXURY', 'EXECUTIVE'], '4.4T-AWD': ['EXECUTIVE'] },
  exteriorColours: CORE_EXTERIOR,
  interiorColours: PREMIUM_INTERIOR,
  options: commonOptions({
    TECH: { standardOn: ['LUXURY', 'EXECUTIVE'] },
    COMFORT: { standardOn: ['EXECUTIVE'] },
    PANO: { standardOn: ['LUXURY', 'EXECUTIVE'] },
    TOW: { priceCents: 150_000 },
  }),
  features: {
    LUXURY: [
      { category: 'chassis', label: 'Adaptive air suspension with terrain modes' },
      { category: 'interior', label: 'Seven-seat configuration' },
      { category: 'comfort', label: 'Four-zone climate control' },
    ],
    EXECUTIVE: [
      { category: 'interior', label: 'Six-seat configuration with captain\'s chairs' },
      { category: 'technology', label: 'Dual rear entertainment displays' },
      { category: 'comfort', label: 'Heated and ventilated second row' },
    ],
  },
};

export const GT: ModelSeed = {
  slug: 'gt',
  name: 'GT',
  fullName: 'Sinclair GT',
  modelYear: YEAR,
  bodyStyle: 'coupe',
  segment: 'Grand Touring Coupe',
  tagline: 'For the long way round.',
  overview:
    'A two-door built for distance rather than lap times: long gearing, deep ' +
    'seats and a boot that takes two weekends\' luggage.',
  baseMsrpCents: 9_450_000,
  displayOrder: 60,
  powertrains: [
    {
      code: '4.4T-RWD', name: '4.4 Twin Turbo RWD', kind: 'ice',
      engineDesc: '4.4L twin-turbocharged V8', transmission: '8-speed automatic',
      drivetrain: 'rwd', horsepower: 530, torqueNm: 750, consumptionL100: 11.8,
      priceDeltaCents: 0,
    },
    {
      code: '4.4T-AWD', name: '4.4 Twin Turbo AWD', kind: 'ice',
      engineDesc: '4.4L twin-turbocharged V8', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 560, torqueNm: 780, consumptionL100: 12.4,
      priceDeltaCents: 480_000,
    },
  ],
  trims: [
    { code: 'TOURING', name: 'Touring', tierOrder: 1, summary: 'Grand touring as intended.', priceDeltaCents: 0 },
    { code: 'PERFORMANCE', name: 'Performance', tierOrder: 2, summary: 'Carbon-ceramic brakes, rear-axle steering.', priceDeltaCents: 1_240_000 },
  ],
  matrix: { '4.4T-RWD': ['TOURING'], '4.4T-AWD': ['TOURING', 'PERFORMANCE'] },
  exteriorColours: [...CORE_EXTERIOR, ...PERFORMANCE_EXTERIOR],
  interiorColours: PREMIUM_INTERIOR,
  options: commonOptions({
    TECH: { standardOn: ['TOURING', 'PERFORMANCE'] },
    COMFORT: { standardOn: ['PERFORMANCE'] },
    AUDIO: { standardOn: ['PERFORMANCE'] },
  }).filter((o) => !['TOW', 'PANO'].includes(o.code)),
  features: {
    TOURING: [
      { category: 'chassis', label: 'Adaptive damping' },
      { category: 'interior', label: 'Nappa leather throughout' },
      { category: 'technology', label: 'Head-up display' },
    ],
    PERFORMANCE: [
      { category: 'chassis', label: 'Carbon-ceramic braking system' },
      { category: 'chassis', label: 'Rear-axle steering' },
      { category: 'exterior', label: '21-inch forged wheels' },
    ],
  },
};

export const R: ModelSeed = {
  slug: 'r',
  name: 'R',
  fullName: 'Sinclair R',
  modelYear: YEAR,
  bodyStyle: 'sedan',
  segment: 'High Performance Sedan',
  tagline: 'Developed where it is used.',
  overview:
    'The R is the S3 taken to its conclusion: bespoke cooling, a wider track ' +
    'and a powertrain calibrated for repeated full-load running.',
  baseMsrpCents: 11_200_000,
  displayOrder: 70,
  powertrains: [
    {
      code: '4.4T-AWD-R', name: '4.4 Twin Turbo AWD', kind: 'ice',
      engineDesc: '4.4L twin-turbocharged V8', transmission: '8-speed automatic',
      drivetrain: 'awd', horsepower: 625, torqueNm: 800, consumptionL100: 12.9,
      priceDeltaCents: 0,
    },
    {
      code: '4.4T-AWD-RS', name: '4.4 Twin Turbo AWD Competition', kind: 'ice',
      engineDesc: '4.4L twin-turbocharged V8, competition calibration',
      transmission: '8-speed automatic', drivetrain: 'awd', horsepower: 700,
      torqueNm: 850, consumptionL100: 13.4, priceDeltaCents: 890_000,
    },
  ],
  trims: [
    { code: 'PERFORMANCE', name: 'Performance', tierOrder: 1, summary: 'The R, complete.', priceDeltaCents: 0 },
    { code: 'TRACK', name: 'Track', tierOrder: 2, summary: 'Roll bar, bucket seats, no rear bench.', priceDeltaCents: 1_650_000 },
  ],
  matrix: { '4.4T-AWD-R': ['PERFORMANCE'], '4.4T-AWD-RS': ['PERFORMANCE', 'TRACK'] },
  exteriorColours: [...CORE_EXTERIOR, ...PERFORMANCE_EXTERIOR],
  interiorColours: PREMIUM_INTERIOR,
  options: commonOptions({
    TECH: { standardOn: ['PERFORMANCE', 'TRACK'] },
    AUDIO: { standardOn: ['PERFORMANCE'], optionalOn: [] },
  }).filter((o) => !['TOW', 'PANO', 'COMFORT'].includes(o.code)),
  features: {
    PERFORMANCE: [
      { category: 'chassis', label: 'Carbon-ceramic braking system' },
      { category: 'chassis', label: 'Active rear differential' },
      { category: 'interior', label: 'Carbon-backed sport seats' },
    ],
    TRACK: [
      { category: 'chassis', label: 'Bolt-in rear roll structure' },
      { category: 'interior', label: 'Fixed-back carbon bucket seats' },
      { category: 'interior', label: 'Rear bench delete' },
    ],
  },
};

export const T4: ModelSeed = {
  slug: 't4',
  name: 'T4',
  fullName: 'Sinclair T4',
  modelYear: YEAR,
  bodyStyle: 'pickup',
  segment: 'Full-Size Pickup',
  tagline: 'Built to be used, finished to be kept.',
  overview:
    'A full-size pickup with a fully boxed frame, 3.5 tonne towing and a cabin ' +
    'built to the standards of the rest of the range.',
  baseMsrpCents: 6_240_000,
  displayOrder: 80,
  powertrains: [
    {
      code: '3.5T-4WD', name: '3.5 Turbo 4WD', kind: 'ice',
      engineDesc: '3.5L twin-turbocharged V6', transmission: '10-speed automatic',
      drivetrain: 'awd', horsepower: 410, torqueNm: 690, consumptionL100: 12.6,
      priceDeltaCents: 0,
    },
    {
      code: '3.5H-4WD', name: '3.5 Hybrid 4WD', kind: 'hybrid',
      engineDesc: '3.5L twin-turbocharged V6 with integrated motor',
      motorDesc: 'Integrated 35 kW motor', transmission: '10-speed automatic',
      drivetrain: 'awd', horsepower: 440, torqueNm: 760, consumptionL100: 10.1,
      priceDeltaCents: 460_000,
    },
  ],
  trims: [
    { code: 'WORK', name: 'Work', tierOrder: 1, summary: 'Vinyl floor, steel wheels, full capability.', priceDeltaCents: 0 },
    { code: 'ADVENTURE', name: 'Adventure', tierOrder: 2, summary: 'All-terrain tyres, locking rear differential.', priceDeltaCents: 620_000 },
    { code: 'SUMMIT', name: 'Summit', tierOrder: 3, summary: 'Leather, air suspension, full technology.', priceDeltaCents: 1_380_000 },
  ],
  matrix: {
    '3.5T-4WD': ['WORK', 'ADVENTURE', 'SUMMIT'],
    '3.5H-4WD': ['ADVENTURE', 'SUMMIT'],
  },
  exteriorColours: CORE_EXTERIOR,
  interiorColours: [...CORE_INTERIOR, ...PREMIUM_INTERIOR],
  options: commonOptions({
    TECH: { standardOn: ['SUMMIT'] },
    COMFORT: { standardOn: ['SUMMIT'], optionalOn: ['ADVENTURE', 'SUMMIT'] },
    TOW: { priceCents: 145_000, standardOn: ['ADVENTURE', 'SUMMIT'] },
    PANO: { optionalOn: ['SUMMIT'] },
  }),
  features: {
    WORK: [
      { category: 'capability', label: '3,500 kg maximum towing' },
      { category: 'capability', label: 'Integrated bed power outlet' },
      { category: 'safety', label: 'Trailer sway control' },
    ],
    ADVENTURE: [
      { category: 'capability', label: 'Locking rear differential' },
      { category: 'capability', label: 'All-terrain tyres and underbody protection' },
      { category: 'exterior', label: 'Recovery points front and rear' },
    ],
    SUMMIT: [
      { category: 'chassis', label: 'Adaptive air suspension' },
      { category: 'interior', label: 'Nappa leather throughout' },
      { category: 'technology', label: '360-degree camera with trailer view' },
    ],
  },
};
