import { AppError } from '@/server/errors';
import { formatMoney, formatAdjustment } from './money';
import type {
  BuildContext, BuildSelection, PriceBreakdown, PriceLine, PriceableOption,
} from './types';

/**
 * Price one build.
 *
 * Pure: no database, no clock, no environment. Every rule in the configurator
 * is expressed here once, so the website, the AI assistant and the Dealer
 * Portal cannot disagree about what a car costs (spec §6, §58).
 *
 * Invalid builds raise INVALID_COMBINATION carrying what IS valid, so the
 * caller — or the assistant — can offer the alternative rather than just
 * refusing.
 */
export function priceBuild(context: BuildContext, selection: BuildSelection): PriceBreakdown {
  const { model, powertrain, trim, configuration, currency, locale } = context;

  if (!configuration.isOrderable) {
    throw new AppError(
      'INVALID_COMBINATION',
      `The ${trim.name} is not currently offered with the ${powertrain.name}.`,
      { data: { modelSlug: model.slug, trim: trim.code, powertrain: powertrain.code } },
    );
  }

  assertDeltasMatchConfiguration(context);

  const lines: PriceLine[] = [
    line('base', model.slug, `${model.fullName} base price`, model.baseMsrpCents, currency, locale, false, true),
  ];

  if (powertrain.priceDeltaCents !== 0) {
    lines.push(line('powertrain', powertrain.code, powertrain.name, powertrain.priceDeltaCents, currency, locale));
  }
  if (trim.priceDeltaCents !== 0) {
    lines.push(line('trim', trim.code, `${trim.name} trim`, trim.priceDeltaCents, currency, locale));
  }

  // ---- Colours -------------------------------------------------------------
  if (selection.exteriorColourCode) {
    const colour = requireColour(context, 'exterior', selection.exteriorColourCode);
    lines.push(line('exterior_colour', colour.code, colour.name, colour.priceDeltaCents, currency, locale));
  }
  if (selection.interiorColourCode) {
    const colour = requireColour(context, 'interior', selection.interiorColourCode);
    lines.push(line('interior_colour', colour.code, colour.name, colour.priceDeltaCents, currency, locale));
  }

  // ---- Options -------------------------------------------------------------
  const selectedOptions = resolveOptions(context, selection.optionCodes ?? []);
  for (const option of selectedOptions) {
    lines.push(
      line(
        'option',
        option.code,
        option.name,
        option.isStandard ? 0 : option.priceCents,
        currency,
        locale,
        option.isStandard,
      ),
    );
  }

  const totalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);

  return {
    currency,
    configurationId: configuration.id,
    summary: [model.fullName, trim.name, powertrain.name].join(' · '),
    lines,
    totalCents,
    totalFormatted: formatMoney(totalCents, currency, locale),
  };
}

function line(
  kind: PriceLine['kind'],
  code: string,
  label: string,
  amountCents: number,
  currency: string,
  locale: string,
  included = false,
  absolute = false,
): PriceLine {
  return {
    kind,
    code,
    label,
    amountCents,
    included,
    formatted: absolute
      ? formatMoney(amountCents, currency, locale)
      : formatAdjustment(amountCents, currency, locale),
  };
}

/**
 * `model_configurations.priceCents` is authoritative for a combination, and the
 * powertrain and trim deltas are how that price is EXPLAINED to a customer.
 * Two representations of one number drift, so disagreement is a data fault and
 * is refused rather than quietly shown.
 */
function assertDeltasMatchConfiguration(context: BuildContext): void {
  const derived =
    context.model.baseMsrpCents +
    context.powertrain.priceDeltaCents +
    context.trim.priceDeltaCents;

  if (derived !== context.configuration.priceCents) {
    throw new AppError(
      'INTERNAL',
      'This configuration is temporarily unavailable to price.',
      {
        internal: {
          reason: 'configuration price does not match its itemised deltas',
          configurationId: context.configuration.id,
          configurationPriceCents: context.configuration.priceCents,
          derivedCents: derived,
        },
      },
    );
  }
}

function requireColour(context: BuildContext, kind: 'exterior' | 'interior', code: string) {
  const list = kind === 'exterior' ? context.exteriorColours : context.interiorColours;
  const found = list.find((c) => c.code === code);
  if (found) return found;

  throw new AppError(
    'INVALID_COMBINATION',
    `That ${kind} colour is not offered on this configuration.`,
    { data: { kind, requested: code, available: list.map((c) => ({ code: c.code, name: c.name })) } },
  );
}

/**
 * Resolve and validate the option selection.
 *
 * Order matters: unknown codes are reported before dependency rules, so a
 * customer who misspells an option is told that, not told it conflicts with
 * something.
 */
function resolveOptions(context: BuildContext, requested: string[]): PriceableOption[] {
  const unique = [...new Set(requested)];
  const byCode = new Map(context.options.map((o) => [o.code, o]));

  const unknown = unique.filter((code) => !byCode.has(code));
  if (unknown.length > 0) {
    throw new AppError(
      'INVALID_COMBINATION',
      unknown.length === 1
        ? 'That option is not available on this configuration.'
        : 'Some of those options are not available on this configuration.',
      {
        data: {
          unavailable: unknown,
          available: context.options.map((o) => ({
            code: o.code, name: o.name, isStandard: o.isStandard,
          })),
        },
      },
    );
  }

  const selected = new Set(unique);

  for (const rule of context.rules) {
    if (!selected.has(rule.optionCode)) continue;

    if (rule.rule === 'requires' && !selected.has(rule.otherOptionCode)) {
      const required = byCode.get(rule.otherOptionCode);
      throw new AppError(
        'INVALID_COMBINATION',
        `${byCode.get(rule.optionCode)!.name} requires ${required?.name ?? rule.otherOptionCode}.`,
        { data: { option: rule.optionCode, requires: rule.otherOptionCode } },
      );
    }

    if (rule.rule === 'excludes' && selected.has(rule.otherOptionCode)) {
      const other = byCode.get(rule.otherOptionCode);
      throw new AppError(
        'INVALID_COMBINATION',
        `${byCode.get(rule.optionCode)!.name} cannot be combined with ${other?.name ?? rule.otherOptionCode}.`,
        { data: { option: rule.optionCode, excludes: rule.otherOptionCode } },
      );
    }
  }

  // Stable order: by category then name, so the same build always renders the
  // same breakdown regardless of the order the customer clicked things.
  return unique
    .map((code) => byCode.get(code)!)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}
