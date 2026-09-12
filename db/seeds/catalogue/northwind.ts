import type { ModelSeed } from './types';

/**
 * The second tenant's catalogue.
 *
 * Deliberately nothing like Sinclair's: a different model name, different trim
 * names, different colour names, different engine codes. That is what makes
 * isolation testable rather than asserted — the Northwind assistant does not
 * recognise "S5" because "S5" is not in Northwind's vocabulary, and the
 * Sinclair assistant cannot mention a Meridian because it has never seen one.
 *
 * One model is enough. This exists to prove a boundary, not to sell cars.
 */
export const NORTHWIND_CATALOGUE: ModelSeed[] = [
  {
    slug: 'harrier',
    name: 'Harrier',
    fullName: 'Northwind Harrier',
    modelYear: 2026,
    bodyStyle: 'wagon',
    segment: 'Touring Wagon',
    tagline: 'For the long way round.',
    overview:
      'Northwind\'s touring wagon: a long roof, a low load lip and enough range ' +
      'between fills to make a day of it.',
    baseMsrpCents: 4_450_000,
    displayOrder: 10,
    powertrains: [
      {
        code: 'NW-2.4T', name: '2.4 Turbo FWD', kind: 'ice',
        engineDesc: '2.4-litre turbocharged four', transmission: '8-speed automatic',
        drivetrain: 'fwd', horsepower: 240, torqueNm: 370,
        consumptionL100: 7.4, priceDeltaCents: 0,
      },
      {
        code: 'NW-2.4T-AWD', name: '2.4 Turbo AWD', kind: 'ice',
        engineDesc: '2.4-litre turbocharged four', transmission: '8-speed automatic',
        drivetrain: 'awd', horsepower: 240, torqueNm: 370,
        consumptionL100: 8.1, priceDeltaCents: 280_000,
      },
    ],
    trims: [
      {
        code: 'DRIFTER', name: 'Drifter', tierOrder: 1,
        summary: 'Everything needed and nothing spare.', priceDeltaCents: 0,
      },
      {
        code: 'NAVIGATOR', name: 'Navigator', tierOrder: 2,
        summary: 'Leather, towing pack and a bigger screen.', priceDeltaCents: 390_000,
      },
    ],
    matrix: { 'NW-2.4T': ['DRIFTER', 'NAVIGATOR'], 'NW-2.4T-AWD': ['NAVIGATOR'] },
    exteriorColours: [
      { code: 'NW-HARBOUR', name: 'Harbour Grey', finish: 'metallic', hex: '#5b6169', priceDeltaCents: 0 },
      { code: 'NW-FOG', name: 'Fogbank White', finish: 'solid', hex: '#f1f2f0', priceDeltaCents: 0 },
      { code: 'NW-SPRUCE', name: 'Spruce Green', finish: 'metallic', hex: '#2c4034', priceDeltaCents: 70_000 },
    ],
    interiorColours: [
      { code: 'NW-OAT', name: 'Oat Weave', material: 'Recycled textile', priceDeltaCents: 0 },
      { code: 'NW-PEAT', name: 'Peat Leather', material: 'Leather', priceDeltaCents: 120_000 },
    ],
    options: [
      {
        code: 'NW-TOWPACK', name: 'Towing Pack', category: 'utility',
        description: 'Detachable tow bar, trailer stability assist and a 13-pin socket.',
        priceCents: 145_000, standardOn: ['NAVIGATOR'],
      },
      {
        code: 'NW-WINTER', name: 'Winter Pack', category: 'comfort',
        description: 'Heated seats, heated wheel and a headlamp washer system.',
        priceCents: 95_000,
      },
    ],
    features: {
      DRIFTER: [
        { category: 'utility', label: '620-litre boot with a flat load floor' },
        { category: 'safety', label: 'Lane keeping and blind spot monitoring' },
      ],
      NAVIGATOR: [
        { category: 'comfort', label: 'Peat leather upholstery' },
        { category: 'utility', label: 'Towing pack as standard' },
      ],
    },
  },
];
