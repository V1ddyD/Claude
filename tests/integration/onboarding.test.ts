import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { onboardDealership } from '../../src/server/services/onboarding';
import { resolveTenantByHost, invalidateTenantCache } from '../../src/server/context/tenant';
import { getAvailableTestDriveSlots } from '../../src/server/services/booking';
import { ensureConversation } from '../../src/server/ai/extraction';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ScriptedModel } from '../helpers/scripted-model';
import { allocateTicketNumber } from '../../src/server/services/tickets/numbering';
import { vehicleModels } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

/**
 * The M6 exit criterion.
 *
 * "A new dealership should be onboarded through configuration rather than
 * requiring a rebuild of the application" (spec §3). This suite brings up a
 * third dealership from a config object alone and checks that it is genuinely
 * its own business — its own brand, hours, currency, ticket series and data —
 * without a single line of code that knows it exists.
 *
 * If this suite needs a code change to pass, the multi-tenant claim is false.
 */

const SLUG = 'meridian';
const HOSTNAME = 'meridian.test';

const CONFIG = {
  slug: SLUG,
  legalName: 'Meridian Motorwerke GmbH',
  brandName: 'Meridian',
  hostnames: [HOSTNAME],
  // Deliberately unlike Sinclair on every axis that code could have hardcoded.
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  locale: 'de-DE',
  ticketPrefix: 'MER',
  contact: { phone: '+49 30 901820', email: 'hallo@meridian.test', city: 'Berlin' },
  hours: [
    { department: 'sales' as const, dayOfWeek: 1, opensAt: '10:00', closesAt: '16:00' },
    { department: 'sales' as const, dayOfWeek: 3, opensAt: '10:00', closesAt: '16:00' },
  ],
  booking: { slotMinutes: { test_drive: 30 }, minNoticeHours: 1, maxHorizonDays: 30 },
  finance: { defaultAprBps: 399 },
  email: { fromName: 'Meridian', fromAddress: 'no-reply@meridian.test' },
  staff: [
    {
      id: '3e91d1a2-0000-4000-8000-00000000000f',
      email: 'chef@meridian.test',
      fullName: 'Meridian Chef',
      role: 'admin' as const,
    },
  ],
};

let admin: Sql;
let tenantId: string;

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
  const result = await onboardDealership(CONFIG);
  tenantId = result.tenantId;
  invalidateTenantCache();
});

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

describe('a dealership created from configuration alone', () => {
  it('comes up with no code change', async () => {
    expect(tenantId).toBeTruthy();
    expect(tenantId).not.toBe(SINCLAIR_TENANT_ID);
  });

  it('serves its own hostname with its own identity', async () => {
    const tenant = await resolveTenantByHost(HOSTNAME);
    expect(tenant.brandName).toBe('Meridian');
    expect(tenant.currency).toBe('EUR');
    expect(tenant.locale).toBe('de-DE');
    expect(tenant.timezone).toBe('Europe/Berlin');
    expect(tenant.ticketPrefix).toBe('MER');
  });

  it('keeps its own ticket series, not a shared one', async () => {
    const number = await withTenant(tenantId, (db) =>
      allocateTicketNumber(db, { prefix: 'MER' }),
    );
    expect(number).toMatch(/^MER-\d{4}-\d+$/);

    // Sequences are per tenant, so one dealership's volume is not inferable
    // from another's numbers.
    const [sinclair] = await admin<{ next_value: number }[]>`
      SELECT next_value FROM ticket_sequences WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;
    const [meridian] = await admin<{ next_value: number }[]>`
      SELECT next_value FROM ticket_sequences WHERE tenant_id = ${tenantId}
    `;
    expect(meridian!.next_value).toBeLessThan(sinclair!.next_value);
  });

  it('uses its own opening hours, in its own timezone', async () => {
    const slots = await withTenant(tenantId, (db) =>
      getAvailableTestDriveSlots(
        db,
        {
          timezone: 'Europe/Berlin',
          locale: 'de-DE',
          ticketPrefix: 'MER',
          settings: { slotMinutes: 30, minNoticeHours: 1, maxHorizonDays: 30 },
        },
        {
          from: new Date(Date.now() + 864e5),
          to: new Date(Date.now() + 21 * 864e5),
        },
      ),
    );

    // No demonstrators and no staff resources yet, so nothing is bookable —
    // which is correct, and different from "the hours are wrong".
    expect(slots).toEqual([]);

    const hours = await admin<{ day_of_week: number; opens_at: string }[]>`
      SELECT day_of_week, opens_at FROM business_hours
      WHERE tenant_id = ${tenantId} AND department = 'sales' ORDER BY day_of_week
    `;
    expect(hours.map((h) => h.day_of_week)).toEqual([1, 3]);
    expect(hours[0]!.opens_at).toMatch(/^10:00/);
  });

  it('gets its own tunable scoring and follow-up rules', async () => {
    const [scoring] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM lead_scoring_rules WHERE tenant_id = ${tenantId}
    `;
    const [followUps] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM follow_up_rules WHERE tenant_id = ${tenantId}
    `;
    expect(scoring!.count).toBeGreaterThan(10);
    expect(followUps!.count).toBeGreaterThan(3);
  });

  it('runs the assistant under its own brand', async () => {
    const session = await ensureConversation(tenantId, {});
    const model = new ScriptedModel([{ text: 'Guten Tag.' }]);

    await respondToMessage({
      tenantId,
      conversationId: session.conversationId,
      visitorId: session.visitorId,
      userMessage: 'Hallo',
      requestId: 'onboard-test',
      client: model,
    });

    const system = model.requests[0]!.system;
    expect(system).toContain('Meridian');
    // Nothing about the first dealership leaks into the second's prompt.
    expect(system).not.toContain('Sinclair');
    expect(system).not.toContain('S5');
  });

  it('cannot see the first dealership data, and is not seen by it', async () => {
    const theirs = await withTenant(tenantId, (db) =>
      db
        .select({ slug: vehicleModels.slug })
        .from(vehicleModels)
        .where(eq(vehicleModels.tenantId, db.tenantId)),
    );
    // A brand-new dealership has no catalogue — and certainly not another
    // dealership's.
    expect(theirs).toEqual([]);

    const [sinclairLeads] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM leads WHERE tenant_id = ${tenantId}
    `;
    expect(sinclairLeads!.count).toBe(0);
  });

  it('is idempotent — onboarding twice updates rather than duplicates', async () => {
    const again = await onboardDealership({ ...CONFIG, brandName: 'Meridian Automobile' });
    expect(again.tenantId).toBe(tenantId);
    expect(again.created).toBe(false);

    invalidateTenantCache();
    const tenant = await resolveTenantByHost(HOSTNAME);
    expect(tenant.brandName).toBe('Meridian Automobile');
  });
});

describe('onboarding refuses bad configuration', () => {
  it('rejects a hostname that belongs to another dealership', async () => {
    await expect(
      onboardDealership({ ...CONFIG, slug: 'imposter', hostnames: ['sinclair.test'] }),
    ).rejects.toThrow(/already belongs to another dealership/);
  });

  it('rejects a malformed configuration with the field named', async () => {
    await expect(
      onboardDealership({ ...CONFIG, slug: 'Not A Slug', ticketPrefix: 'lowercase' }),
    ).rejects.toThrow(/slug|ticketPrefix/);
  });

  it('warns rather than fails when something is merely incomplete', async () => {
    const result = await onboardDealership({
      ...CONFIG,
      slug: 'sparse',
      hostnames: ['sparse.test'],
      email: {},
      staff: [],
    });
    // A dealership can be brought up and completed later; it just should not
    // be a surprise that nothing can email or administer it yet.
    expect(result.warnings.join(' ')).toMatch(/sender address/);
    expect(result.warnings.join(' ')).toMatch(/administrator/);
  });
});
