import 'server-only';
import postgres from 'postgres';
import { z } from 'zod';
import { env } from '@/server/config/env';
import { DEFAULT_SCORING_RULES } from '@/server/services/scoring/rules';
import { DEFAULT_FOLLOW_UP_RULES } from '@/server/services/follow-ups/rules';

/**
 * Onboarding a dealership.
 *
 * The claim this exists to make true: a new dealership is CONFIGURATION, not a
 * code change. Sinclair is tenant #1 and a seed file, nothing more.
 *
 * Runs as the owner, because creating a tenant is the one operation that
 * necessarily precedes a tenant context — the row it needs does not exist yet.
 * Everything the dealership then does runs as the application role under RLS.
 */

export const dealershipSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/, 'lowercase letters, digits and hyphens'),
  legalName: z.string().min(1).max(200),
  brandName: z.string().min(1).max(80),
  hostnames: z.array(z.string().min(3).max(255)).min(1),
  timezone: z.string().min(1),
  currency: z.string().length(3),
  locale: z.string().min(2).max(10),
  ticketPrefix: z.string().regex(/^[A-Z]{2,6}$/, 'two to six capital letters'),

  contact: z.object({
    phone: z.string().max(40).optional(),
    email: z.string().email().optional(),
    addressLine1: z.string().max(200).optional(),
    city: z.string().max(80).optional(),
    region: z.string().max(80).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(2).optional(),
  }),

  hours: z
    .array(
      z.object({
        department: z.enum(['sales', 'service']),
        dayOfWeek: z.number().int().min(0).max(6),
        opensAt: z.string().regex(/^\d{2}:\d{2}$/),
        closesAt: z.string().regex(/^\d{2}:\d{2}$/),
      }),
    )
    .min(1),

  booking: z
    .object({
      slotMinutes: z.record(z.string(), z.number().int().positive()).optional(),
      minNoticeHours: z.number().int().min(0).optional(),
      maxHorizonDays: z.number().int().positive().optional(),
      responseSlaHours: z.record(z.string(), z.number().int().positive()).optional(),
    })
    .optional(),

  finance: z
    .object({
      defaultAprBps: z.number().int().min(0).max(3000).optional(),
      termsMonths: z.array(z.number().int()).optional(),
      disclaimer: z.string().max(500).optional(),
    })
    .optional(),

  ai: z
    .object({
      tone: z.string().max(400).optional(),
      persona: z.string().max(120).optional(),
      monthlyTokenBudget: z.number().int().positive().optional(),
    })
    .optional(),

  email: z
    .object({
      fromName: z.string().max(80).optional(),
      fromAddress: z.string().email().optional(),
      replyTo: z.string().email().optional(),
    })
    .optional(),

  staff: z
    .array(
      z.object({
        /** Must match the identity provider's user id. */
        id: z.string().uuid(),
        email: z.string().email(),
        fullName: z.string().min(1).max(120),
        role: z.enum(['sales', 'service', 'manager', 'admin']),
      }),
    )
    .optional(),
});

export type DealershipConfig = z.infer<typeof dealershipSchema>;

export interface OnboardResult {
  tenantId: string;
  slug: string;
  created: boolean;
  warnings: string[];
}

export async function onboardDealership(config: unknown): Promise<OnboardResult> {
  const parsed = dealershipSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid dealership configuration:\n  ${issues.join('\n  ')}`);
  }
  const dealership = parsed.data;
  const warnings: string[] = [];

  // Onboarding is not a request-path operation. It creates the tenant that
  // every other query is scoped to, so it necessarily runs before one exists.
  const url = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql`SET row_security = off`;

    const existing = await sql<{ id: string }[]>`
      SELECT id FROM tenants WHERE slug = ${dealership.slug}
    `;
    const created = existing.length === 0;

    const [tenant] = await sql<{ id: string }[]>`
      INSERT INTO tenants (
        slug, legal_name, brand_name, timezone, currency, locale, ticket_prefix, status
      ) VALUES (
        ${dealership.slug}, ${dealership.legalName}, ${dealership.brandName},
        ${dealership.timezone}, ${dealership.currency}, ${dealership.locale},
        ${dealership.ticketPrefix}, 'active'
      )
      ON CONFLICT (slug) DO UPDATE SET
        legal_name = EXCLUDED.legal_name,
        brand_name = EXCLUDED.brand_name,
        timezone = EXCLUDED.timezone,
        currency = EXCLUDED.currency,
        locale = EXCLUDED.locale,
        updated_at = now()
      RETURNING id
    `;
    const tenantId = tenant!.id;

    for (const [index, hostname] of dealership.hostnames.entries()) {
      // A hostname maps to exactly one dealership, so a collision is a real
      // conflict rather than something to overwrite silently.
      const clash = await sql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM tenant_domains WHERE hostname = ${hostname.toLowerCase()}
      `;
      if (clash[0] && clash[0].tenant_id !== tenantId) {
        throw new Error(`The hostname "${hostname}" already belongs to another dealership.`);
      }

      await sql`
        INSERT INTO tenant_domains (tenant_id, hostname, is_primary)
        VALUES (${tenantId}, ${hostname.toLowerCase()}, ${index === 0})
        ON CONFLICT (hostname) DO UPDATE SET is_primary = EXCLUDED.is_primary
      `;
    }

    await sql`
      INSERT INTO tenant_settings (tenant_id, contact, booking, lead, ai, email, finance)
      VALUES (
        ${tenantId},
        ${sql.json(dealership.contact)},
        ${sql.json(dealership.booking ?? {})},
        ${sql.json({ bands: { high: 60, medium: 30 }, conversationRetentionMonths: 24 })},
        ${sql.json(dealership.ai ?? {})},
        ${sql.json(dealership.email ?? {})},
        ${sql.json(dealership.finance ?? {})}
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        contact = EXCLUDED.contact, booking = EXCLUDED.booking,
        ai = EXCLUDED.ai, email = EXCLUDED.email, finance = EXCLUDED.finance,
        updated_at = now()
    `;

    for (const window of dealership.hours) {
      await sql`
        INSERT INTO business_hours (tenant_id, department, day_of_week, opens_at, closes_at)
        VALUES (${tenantId}, ${window.department}, ${window.dayOfWeek},
                ${window.opensAt}::time, ${window.closesAt}::time)
        ON CONFLICT (tenant_id, department, day_of_week)
          DO UPDATE SET opens_at = EXCLUDED.opens_at, closes_at = EXCLUDED.closes_at
      `;
    }

    // Scoring and follow-up rules are seeded as ROWS so the dealership can tune
    // them without a deploy. Defaults, not decisions.
    for (const rule of DEFAULT_SCORING_RULES) {
      await sql`
        INSERT INTO lead_scoring_rules (
          tenant_id, key, description, condition, weight, min_confidence
        ) VALUES (
          ${tenantId}, ${rule.key}, ${rule.description},
          ${sql.json(rule.condition as never)}, ${rule.weight}, ${rule.minConfidence}
        )
        ON CONFLICT (tenant_id, key) DO NOTHING
      `;
    }

    for (const rule of DEFAULT_FOLLOW_UP_RULES) {
      await sql`
        INSERT INTO follow_up_rules (
          tenant_id, key, description, trigger, delay_minutes, business_hours_only,
          recommended_action
        ) VALUES (
          ${tenantId}, ${rule.key}, ${rule.description}, ${sql.json({ kind: rule.key })},
          ${rule.delayMinutes}, ${rule.businessHoursOnly}, ${rule.recommendedAction}
        )
        ON CONFLICT (tenant_id, key) DO NOTHING
      `;
    }

    for (const member of dealership.staff ?? []) {
      await sql`
        INSERT INTO staff_users (id, tenant_id, email, full_name, role, status)
        VALUES (${member.id}, ${tenantId}, ${member.email}, ${member.fullName},
                ${member.role}, 'active')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status
      `;
    }

    if (!dealership.email?.fromAddress) {
      warnings.push('No sender address configured — confirmation emails will be suppressed.');
    }
    if (!(dealership.staff ?? []).some((s) => s.role === 'admin')) {
      warnings.push('No administrator — nobody can change this dealership\'s settings.');
    }
    if (!dealership.hours.some((h) => h.department === 'sales')) {
      warnings.push('No sales hours — no test drive slots can be offered.');
    }

    return { tenantId, slug: dealership.slug, created, warnings };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
