import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { ScriptedModel } from '../helpers/scripted-model';
import { SINCLAIR_TENANT_ID, SINCLAIR_STAFF } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { respondToMessage } from '../../src/server/ai/conversation';
import { extractAndScore, ensureConversation } from '../../src/server/ai/extraction';
import { getAvailableTestDriveSlots } from '../../src/server/services/booking';
import { getLeadDetail, listLeads } from '../../src/server/db/repositories/leads';
import { ROLE_PERMISSIONS, type Permission } from '../../src/server/auth/permissions';
import type { StaffContext } from '../../src/server/auth/require-staff';
import type { StaffRole } from '../../src/server/db/schema';

/**
 * Specification §44, end to end.
 *
 * This is M3's exit criterion: a customer conversation becomes a lead, an
 * appointment, a ticket and a queued confirmation, and a salesperson opening
 * the portal sees all of it without reconstructing anything.
 *
 * The model is scripted — what is being asserted is the system's behaviour, not
 * a model's phrasing.
 */

let admin: Sql;
const TENANT = { timezone: 'America/Toronto', locale: 'en-CA', ticketPrefix: 'SIN' };

function staffContext(role: StaffRole, id: string): StaffContext {
  const granted = new Set<Permission>(ROLE_PERMISSIONS[role]);
  return {
    authUserId: id, tenantId: SINCLAIR_TENANT_ID, role,
    fullName: 'Test', email: 't@sinclair.test',
    can: (p) => granted.has(p),
    assert: (p) => { if (!granted.has(p)) throw new Error(`missing ${p}`); },
  };
}

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

describe('the demonstration scenario', () => {
  it('turns a conversation into dealership operations', async () => {
    const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
    const { conversationId, visitorId } = session;

    const say = (userMessage: string, model: ScriptedModel) =>
      respondToMessage({
        tenantId: SINCLAIR_TENANT_ID, conversationId, visitorId,
        userMessage, requestId: 'demo', client: model,
      });

    // ---- 1. "I'm looking for an SUV around $50,000..." --------------------
    await say(
      "I'm looking for an SUV around $50,000. I might buy in the next two months. " +
        "I'd prefer AWD and I have a BMW to trade in.",
      new ScriptedModel([
        {
          toolUses: [{
            name: 'searchVehicles',
            input: { bodyStyle: 'suv', maxPriceCents: 5_500_000, drivetrain: 'awd' },
          }],
        },
        { text: 'The S5 is our mid-size SUV and starts at $52,900. Would you like to see it?' },
      ]),
    );

    // ---- 2. "What engines does the S5 have?" -----------------------------
    const engineTurn = new ScriptedModel([
      { toolUses: [{ name: 'getVehiclePowertrains', input: { modelSlug: 's5' } }] },
      { text: 'Three: a 2.0 Turbo AWD, a 2.5 Hybrid AWD and a 3.0 Turbo AWD.' },
    ]);
    await say('What engines does the S5 have?', engineTurn);

    // The assistant was given the matrix, so it cannot offer a combination the
    // factory does not build.
    const powertrainResult = JSON.stringify(
      (await admin<{ tool_result: unknown }[]>`
        SELECT tool_result FROM messages
        WHERE conversation_id = ${conversationId} AND tool_name = 'getVehiclePowertrains'
      `)[0]!.tool_result,
    );
    expect(powertrainResult).toContain('offeredWithTrims');

    // ---- 3. Price the exact configuration --------------------------------
    await say(
      "I'd like the 2.0 Turbo AWD in Premium, Obsidian Black.",
      new ScriptedModel([
        {
          toolUses: [{
            name: 'calculateVehiclePrice',
            input: {
              modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'PREMIUM',
              exteriorColourCode: 'OBSIDIAN',
            },
          }],
        },
        { text: 'That comes to $58,900 before taxes and fees.' },
      ]),
    );

    const [priceRow] = await admin<{ tool_result: { total: { cents: number } } }[]>`
      SELECT tool_result FROM messages
      WHERE conversation_id = ${conversationId} AND tool_name = 'calculateVehiclePrice'
    `;
    // Computed from the catalogue, not asserted by the model.
    expect(priceRow!.tool_result.total.cents).toBe(5_890_000);

    // ---- 4. "I'd like to test drive it Saturday." ------------------------
    // Ask across the whole bookable horizon and take the first free time,
    // rather than naming a day that another test may already have filled — or
    // that falls outside the dealership's 14-day booking horizon.
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, {
        from: new Date(Date.now() + 2 * 864e5),
        to: new Date(Date.now() + 13 * 864e5),
      }),
    );
    expect(slots.length).toBeGreaterThan(0);

    await say(
      "I'd like to test drive it. I'm Alex Morgan, alex.morgan@example.test.",
      new ScriptedModel([
        { toolUses: [{ name: 'getAvailableTestDriveSlots', input: {
          modelSlug: 's5',
          fromDate: slots[0]!.startsAt.toISOString().slice(0, 10),
          toDate: slots[0]!.startsAt.toISOString().slice(0, 10),
        } }] },
        {
          toolUses: [{
            name: 'createTestDrive',
            input: {
              startsAt: slots[0]!.startsAt.toISOString(),
              modelSlug: 's5', fullName: 'Alex Morgan',
              email: 'alex.morgan@example.test', contactConsent: true,
            },
          }],
        },
        { text: "You're booked. Your reference is on screen and a confirmation is on its way." },
      ]),
    );

    // ---- 5. Extraction and scoring (Pass B) ------------------------------
    const extraction = await extractAndScore({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId,
      client: new ScriptedModel([
        {
          toolUses: [{
            name: 'record_signals',
            input: {
              modelSlug: { value: 's5', confidence: 0.95 },
              trimCode: { value: 'PREMIUM', confidence: 0.95 },
              powertrainCode: { value: '2.0T-AWD', confidence: 0.95 },
              exteriorColourCode: { value: 'OBSIDIAN', confidence: 0.9 },
              budgetCents: { value: 5_000_000, confidence: 0.85 },
              purchaseTimeframe: { value: 'one_to_three_months', confidence: 0.8 },
              tradeInInterest: { value: true, confidence: 0.9 },
            },
          }],
        },
      ]),
    });

    // ---- The dealership's side ------------------------------------------
    expect(extraction.priority).toBe('high');
    expect(extraction.rationale).toContain('High priority');

    const salesperson = staffContext('sales', SINCLAIR_STAFF.sales.id);
    const detail = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getLeadDetail(db, salesperson, extraction.leadId!),
    );

    expect(detail).not.toBeNull();
    const seen = detail!;

    // Everything spec §44 says the portal must show, without the salesperson
    // reconstructing any of it.
    expect(seen.customer.fullName).toBe('Alex Morgan');
    expect(seen.customer.email).toBe('alex.morgan@example.test');
    expect(seen.lead.priority).toBe('high');
    expect(seen.lead.budgetCents).toBe(5_000_000);
    expect(seen.lead.purchaseTimeframe).toBe('one_to_three_months');
    expect(seen.lead.tradeInInterest).toBe(true);
    expect(seen.lead.aiSummary).toContain('S5');
    expect(seen.appointments).toHaveLength(1);
    expect(seen.tickets[0]!.number).toMatch(/^SIN-\d{4}-\d+$/);

    // The exact configuration, with how confident we are in each part.
    const byField = Object.fromEntries(seen.signals.map((s) => [s.field, s]));
    expect(byField.trimCode!.value).toBe('PREMIUM');
    expect(byField.powertrainCode!.value).toBe('2.0T-AWD');
    expect(Number(byField.budgetCents!.confidence)).toBeGreaterThan(0.5);
    // Identity the system observed at booking is recorded as such, not as a guess.
    expect(byField.customerEmail!.source).toBe('form');

    // The whole conversation is there to read.
    const customerTurns = seen.transcript.filter((m) => m.role === 'user');
    expect(customerTurns.length).toBe(4);
    expect(customerTurns[0]!.content).toContain('SUV');

    // And it is at the top of the list a salesperson works.
    const list = await withTenant(SINCLAIR_TENANT_ID, (db) => listLeads(db, salesperson));
    expect(list[0]!.priority).toBe('high');
    expect(list[0]!.customerName).toBe('Alex Morgan');
  });

  it('keeps the customer side free of anything internal', async () => {
    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM messages
      WHERE role = 'assistant'
        AND (content ILIKE '%priority%' OR content ILIKE '%score%' OR content ILIKE '%lead%')
    `;
    // Nothing the assistant said mentions internal handling (spec §54).
    expect(row?.count).toBe(0);
  });

  it('queued the confirmation email rather than claiming delivery', async () => {
    const [email] = await admin<{ status: string; delivered_at: Date | null }[]>`
      SELECT status, delivered_at FROM email_messages
      WHERE to_email = 'alex.morgan@example.test'
    `;
    expect(email?.status).toBe('queued');
    expect(email?.delivered_at).toBeNull();
  });

  it('notified the sales team', async () => {
    const [notification] = await admin<{ type: string; role_target: string }[]>`
      SELECT type, role_target FROM notifications
      WHERE type = 'test_drive_booked' ORDER BY created_at DESC LIMIT 1
    `;
    expect(notification?.role_target).toBe('sales');
  });
});
