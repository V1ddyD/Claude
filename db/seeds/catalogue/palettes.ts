import type { ColourSeed, OptionSeed } from './types';

/**
 * Shared paint and option palettes.
 *
 * Manufacturers carry paint across a range rather than inventing it per model,
 * and these are cloned per model at seed time so a dealership can still price
 * or withdraw a colour on one model without touching another.
 */

export const CORE_EXTERIOR: ColourSeed[] = [
  { code: 'OBSIDIAN', name: 'Obsidian Black', finish: 'metallic', hex: '#0b0b0d', priceDeltaCents: 0 },
  { code: 'GLACIER', name: 'Glacier White', finish: 'pearl', hex: '#eef0f1', priceDeltaCents: 90_000 },
  { code: 'GRAPHITE', name: 'Graphite Grey', finish: 'metallic', hex: '#4a4e54', priceDeltaCents: 65_000 },
  { code: 'MERIDIAN', name: 'Meridian Blue', finish: 'metallic', hex: '#1d3a5c', priceDeltaCents: 65_000 },
  { code: 'SLATE', name: 'Slate Silver', finish: 'metallic', hex: '#9aa0a6', priceDeltaCents: 0 },
];

export const PERFORMANCE_EXTERIOR: ColourSeed[] = [
  { code: 'CARMINE', name: 'Carmine Red', finish: 'pearl', hex: '#8e1f26', priceDeltaCents: 125_000 },
  { code: 'SIGNAL', name: 'Signal Yellow', finish: 'solid', hex: '#d8a415', priceDeltaCents: 125_000 },
];

export const CORE_INTERIOR: ColourSeed[] = [
  { code: 'CHARCOAL', name: 'Charcoal', material: 'Leatherette', priceDeltaCents: 0 },
  { code: 'STONE', name: 'Stone', material: 'Leatherette', priceDeltaCents: 0 },
];

export const PREMIUM_INTERIOR: ColourSeed[] = [
  { code: 'CHARCOAL_NAPPA', name: 'Charcoal Nappa', material: 'Nappa leather', priceDeltaCents: 145_000 },
  { code: 'SADDLE_NAPPA', name: 'Saddle Nappa', material: 'Nappa leather', priceDeltaCents: 145_000 },
];

/** Options common across the range. Pricing and availability vary per model. */
export function commonOptions(overrides: Partial<Record<string, Partial<OptionSeed>>> = {}): OptionSeed[] {
  const base: OptionSeed[] = [
    {
      code: 'TECH',
      name: 'Technology Package',
      category: 'package',
      description: 'Head-up display, 360-degree camera, adaptive matrix headlamps.',
      priceCents: 320_000,
    },
    {
      code: 'COMFORT',
      name: 'Comfort Package',
      category: 'package',
      description: 'Ventilated front seats, four-zone climate, acoustic glass.',
      priceCents: 245_000,
    },
    {
      code: 'AUDIO',
      name: 'Signature Audio',
      category: 'audio',
      description: '18-speaker system with active noise cancellation.',
      priceCents: 180_000,
    },
    {
      code: 'ASSIST',
      name: 'Driver Assistance Plus',
      category: 'safety',
      description: 'Highway pilot, lane-change assist, evasive steering support.',
      priceCents: 215_000,
    },
    {
      code: 'PANO',
      name: 'Panoramic Roof',
      category: 'comfort',
      description: 'Full-length glass roof with powered sunshade.',
      priceCents: 165_000,
    },
    {
      code: 'TOW',
      name: 'Towing Package',
      category: 'utility',
      description: 'Integrated hitch, trailer sway control, uprated cooling.',
      priceCents: 120_000,
    },
  ];

  return base.map((option) => ({ ...option, ...(overrides[option.code] ?? {}) }));
}
