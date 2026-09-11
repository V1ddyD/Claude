import type { Sql } from 'postgres';
import type { ModelSeed } from './catalogue';

/**
 * Writes a ModelSeed into the catalogue tables.
 *
 * The one rule that matters here: a configuration's price is COMPUTED as
 * base + powertrain delta + trim delta, never written by hand. The pricing
 * engine asserts the same identity at quote time, so a seed that got it wrong
 * would be caught rather than quietly quoted.
 */
export async function writeModel(sql: Sql, tenantId: string, seed: ModelSeed): Promise<void> {
  const [model] = await sql<{ id: string }[]>`
    INSERT INTO vehicle_models (
      tenant_id, slug, name, full_name, model_year, body_style, segment,
      tagline, overview, base_msrp_cents, display_order, status
    ) VALUES (
      ${tenantId}, ${seed.slug}, ${seed.name}, ${seed.fullName}, ${seed.modelYear},
      ${seed.bodyStyle}, ${seed.segment}, ${seed.tagline}, ${seed.overview},
      ${seed.baseMsrpCents}, ${seed.displayOrder}, 'published'
    )
    ON CONFLICT (tenant_id, slug, model_year) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const modelId = model!.id;

  // ---- Powertrains ---------------------------------------------------------
  const powertrainIds = new Map<string, string>();
  for (const [index, pt] of seed.powertrains.entries()) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO powertrains (
        tenant_id, model_id, code, name, kind, engine_desc, motor_desc, battery_kwh,
        transmission, drivetrain, horsepower, torque_nm, range_km,
        consumption_l100, consumption_le, price_delta_cents, display_order
      ) VALUES (
        ${tenantId}, ${modelId}, ${pt.code}, ${pt.name}, ${pt.kind},
        ${pt.engineDesc ?? null}, ${pt.motorDesc ?? null}, ${pt.batteryKwh ?? null},
        ${pt.transmission ?? null}, ${pt.drivetrain}, ${pt.horsepower}, ${pt.torqueNm},
        ${pt.rangeKm ?? null}, ${pt.consumptionL100 ?? null}, ${pt.consumptionLe ?? null},
        ${pt.priceDeltaCents}, ${index}
      )
      ON CONFLICT (tenant_id, model_id, code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    powertrainIds.set(pt.code, row!.id);
  }

  // ---- Trims ---------------------------------------------------------------
  const trimIds = new Map<string, string>();
  const trimByCode = new Map(seed.trims.map((t) => [t.code, t]));
  for (const trim of seed.trims) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO trims (tenant_id, model_id, code, name, tier_order, summary, price_delta_cents)
      VALUES (${tenantId}, ${modelId}, ${trim.code}, ${trim.name}, ${trim.tierOrder},
              ${trim.summary}, ${trim.priceDeltaCents})
      ON CONFLICT (tenant_id, model_id, code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    trimIds.set(trim.code, row!.id);
  }

  // ---- The buildable matrix ------------------------------------------------
  /** configuration id -> the trim it belongs to, for availability below. */
  const configurations = new Map<string, { trimCode: string; powertrainCode: string }>();

  for (const [powertrainCode, trimCodes] of Object.entries(seed.matrix)) {
    const powertrain = seed.powertrains.find((p) => p.code === powertrainCode);
    if (!powertrain) throw new Error(`${seed.slug}: matrix names unknown powertrain ${powertrainCode}`);

    for (const trimCode of trimCodes) {
      const trim = trimByCode.get(trimCode);
      if (!trim) throw new Error(`${seed.slug}: matrix names unknown trim ${trimCode}`);

      const priceCents = seed.baseMsrpCents + powertrain.priceDeltaCents + trim.priceDeltaCents;

      const [row] = await sql<{ id: string }[]>`
        INSERT INTO model_configurations (
          tenant_id, model_id, powertrain_id, trim_id, price_cents, is_orderable
        ) VALUES (
          ${tenantId}, ${modelId}, ${powertrainIds.get(powertrainCode)!},
          ${trimIds.get(trimCode)!}, ${priceCents}, true
        )
        ON CONFLICT (tenant_id, powertrain_id, trim_id)
          DO UPDATE SET price_cents = EXCLUDED.price_cents
        RETURNING id
      `;
      configurations.set(row!.id, { trimCode, powertrainCode });
    }
  }

  // ---- Colours -------------------------------------------------------------
  for (const [kind, list] of [
    ['exterior', seed.exteriorColours],
    ['interior', seed.interiorColours],
  ] as const) {
    for (const [index, colour] of list.entries()) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO colours (
          tenant_id, model_id, kind, code, name, finish, hex, material,
          price_delta_cents, display_order
        ) VALUES (
          ${tenantId}, ${modelId}, ${kind}, ${colour.code}, ${colour.name},
          ${colour.finish ?? null}, ${colour.hex ?? null}, ${colour.material ?? null},
          ${colour.priceDeltaCents}, ${index}
        )
        ON CONFLICT (tenant_id, model_id, kind, code) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `;

      // Rows here RESTRICT the colour to those configurations. No rows means
      // it is offered everywhere, so unrestricted colours write nothing.
      if (colour.onlyOnTrims) {
        for (const [configId, config] of configurations) {
          if (!colour.onlyOnTrims.includes(config.trimCode)) continue;
          await sql`
            INSERT INTO colour_availability (tenant_id, colour_id, model_configuration_id)
            VALUES (${tenantId}, ${row!.id}, ${configId})
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }
  }

  // ---- Options and their per-configuration availability --------------------
  const optionIds = new Map<string, string>();
  for (const option of seed.options) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO options (tenant_id, model_id, code, name, category, description, price_cents)
      VALUES (${tenantId}, ${modelId}, ${option.code}, ${option.name}, ${option.category},
              ${option.description}, ${option.priceCents})
      ON CONFLICT (tenant_id, model_id, code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    optionIds.set(option.code, row!.id);

    for (const [configId, config] of configurations) {
      const isStandard = option.standardOn?.includes(config.trimCode) ?? false;
      const isOffered = isStandard || (option.optionalOn ?? seed.trims.map((t) => t.code))
        .includes(config.trimCode);

      // Absence of a row means "not offered on this build" — so skip rather
      // than insert an is_available flag that every query would have to filter.
      if (!isOffered) continue;

      await sql`
        INSERT INTO option_availability (
          tenant_id, option_id, model_configuration_id, is_standard
        ) VALUES (${tenantId}, ${row!.id}, ${configId}, ${isStandard})
        ON CONFLICT (option_id, model_configuration_id)
          DO UPDATE SET is_standard = EXCLUDED.is_standard
      `;
    }
  }

  for (const rule of seed.rules ?? []) {
    const optionId = optionIds.get(rule.option);
    const otherId = optionIds.get(rule.other);
    if (!optionId || !otherId) {
      throw new Error(`${seed.slug}: rule names an option not in this model (${rule.option} -> ${rule.other})`);
    }
    await sql`
      INSERT INTO option_rules (tenant_id, option_id, rule, other_option_id)
      VALUES (${tenantId}, ${optionId}, ${rule.rule}, ${otherId})
      ON CONFLICT DO NOTHING
    `;
  }

  // ---- Standard equipment, per configuration -------------------------------
  // A trim's features apply to every configuration of that trim, and cumulate
  // from lower trims: Luxury includes what Premium has.
  const orderedTrims = [...seed.trims].sort((a, b) => a.tierOrder - b.tierOrder);

  for (const [configId, config] of configurations) {
    const trim = trimByCode.get(config.trimCode)!;
    const inherited = orderedTrims
      .filter((t) => t.tierOrder <= trim.tierOrder)
      .flatMap((t) => seed.features[t.code] ?? []);

    for (const [index, feature] of inherited.entries()) {
      await sql`
        INSERT INTO vehicle_features (
          tenant_id, model_configuration_id, category, label, display_order
        ) VALUES (${tenantId}, ${configId}, ${feature.category}, ${feature.label}, ${index})
      `;
    }
  }
}
