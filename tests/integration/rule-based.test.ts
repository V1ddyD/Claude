import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation } from '../../src/server/ai/extraction';
import { RuleBasedModel } from '../../src/server/ai/rule-based';
import { leads as leadsTable, customers } from '../../src/server/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * The assistant with no model behind it.
 *
 * Nothing here is scripted: the same message a customer would type goes in,
 * and what comes back is whatever the rules and the real tools produce. That
 * is the point of the exercise — the workflow can be demonstrated end to end,
 * against live catalogue and diary data, before a key exists.
 */

let admin: Sql;

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

async function conversation() {
  const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
  const client = new RuleBasedModel();

  return {
    ...session,
    say: (userMessage: string) =>
      respondToMessage({
        tenantId: SINCLAIR_TENANT_ID,
        conversationId: session.conversationId,
        visitorId: session.visitorId,
        userMessage,
        requestId: 'rule-based-test',
        client,
      }),
  };
}

describe('the rule-based assistant', () => {
  it('answers catalogue questions from tools, never from memory', async () => {
    const chat = await conversation();

    const search = await chat.say('I am looking for an SUV around $60,000 with all wheel drive');
    expect(search.toolsUsed).toContain('searchVehicles');
    expect(search.mode).toBe('scripted');
    expect(search.degraded).toBe(false);
    expect(search.text).toMatch(/\$/);

    const engines = await chat.say('What engines does the S5 have?');
    expect(engines.toolsUsed).toEqual(['getVehiclePowertrains']);
    expect(engines.text.toLowerCase()).toContain('hp');

    // A named trim has to be priced, not estimated: two lookups to resolve the
    // codes, then the pricing tool itself.
    const price = await chat.say('How much is the S5 Premium?');
    expect(price.toolsUsed).toContain('calculateVehiclePrice');
    expect(price.text).toMatch(/Total: \$/);
    expect(price.text).toMatch(/Excludes taxes/i);
  });

  it('only offers a colour or a car the catalogue actually has', async () => {
    const chat = await conversation();

    const colours = await chat.say('What colours can I get the E5 in?');
    expect(colours.toolsUsed).toEqual(['getVehicleColours']);
    expect(colours.text).toContain('Obsidian Black');
    // Paint and upholstery are not one list.
    expect(colours.text).toContain('Paint:');
    expect(colours.text).toContain('Interior:');

    const nonsense = await chat.say('Do you sell the Z9?');
    // Says plainly that it does not exist and names what does — and attaches
    // no figure to anything, because no tool priced it.
    expect(nonsense.text).toMatch(/do not make a Z9/i);
    expect(nonsense.text).toContain('Sinclair E5');
    expect(nonsense.text).not.toMatch(/\$\d/);
  });

  it('books a test drive only after a time, a name, an email and consent', async () => {
    const chat = await conversation();

    await chat.say('Tell me about the S5');

    const offered = await chat.say('Can I book a test drive?');
    expect(offered.toolsUsed).toEqual(['getAvailableTestDriveSlots']);
    expect(offered.text).toContain('1.');
    expect(offered.receipt).toBeUndefined();

    const picked = await chat.say('The first one please');
    // A time is not enough. Nothing is written yet.
    expect(picked.toolsUsed).not.toContain('createTestDrive');
    expect(picked.text).toMatch(/name and email/i);

    const identified = await chat.say('Alex Mercer, alex.mercer@example.com');
    expect(identified.toolsUsed).not.toContain('createTestDrive');
    // An email address is an identifier, not a permission.
    expect(identified.text).toMatch(/happy for the team to contact you/i);

    const booked = await chat.say('Yes, that is fine');
    expect(booked.toolsUsed).toContain('createTestDrive');
    expect(booked.receipt?.ticketNumber).toMatch(/^SIN-/);
    expect(booked.receipt?.confirmationCode).toMatch(/^[23456789BCDFGHJKLMNPQRSTVWXZ]{6}$/);
    expect(booked.text).toContain(booked.receipt!.confirmationCode!);
    // Queued is not delivered.
    expect(booked.text).toMatch(/on its way/i);
    expect(booked.text).not.toMatch(/has arrived|has been sent/i);

    const [appointment] = await admin<{ status: string }[]>`
      SELECT status FROM appointments
      WHERE tenant_id = ${SINCLAIR_TENANT_ID}
        AND confirmation_code = ${booked.receipt!.confirmationCode!}
    `;
    expect(appointment!.status).toBe('scheduled');

    // The booking reached the portal as a lead, with the contact details on it.
    const found = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      db
        .select({ name: customers.fullName, email: customers.email, priority: leadsTable.priority })
        .from(leadsTable)
        .innerJoin(customers, eq(customers.id, leadsTable.customerId))
        .where(
          and(
            eq(leadsTable.tenantId, db.tenantId),
            eq(leadsTable.conversationId, chat.conversationId),
          ),
        ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('Alex Mercer');
    expect(found[0]!.email).toBe('alex.mercer@example.com');

    // And it can be cancelled with the code it just gave out.
    const cancelled = await chat.say(
      `I need to cancel ${booked.receipt!.confirmationCode}, my email is alex.mercer@example.com`,
    );
    expect(cancelled.toolsUsed).toContain('cancelTestDrive');
    expect(cancelled.text).toMatch(/cancelled/i);
  });

  it('passes an unanswerable question to the team rather than guessing', async () => {
    const chat = await conversation();

    const asked = await chat.say('Does the S5 tow a three horse trailer in winter?');
    expect(asked.toolsUsed).toEqual([]);
    expect(asked.text).toMatch(/will not guess/i);
    expect(asked.text).toMatch(/pass it on/i);

    await chat.say('Yes please');
    await chat.say('Dana Okafor, dana@example.com');
    const ticketed = await chat.say('Yes');

    expect(ticketed.toolsUsed).toContain('createSupportTicket');
    expect(ticketed.receipt?.ticketNumber).toMatch(/^SIN-/);

    const [ticket] = await admin<{ subject: string }[]>`
      SELECT subject FROM tickets
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND number = ${ticketed.receipt!.ticketNumber}
    `;
    expect(ticket!.subject).toContain('horse trailer');
  });

  it('hands over to a person when asked for one', async () => {
    const chat = await conversation();

    const asked = await chat.say('I would rather speak to a salesperson about a discount');
    expect(asked.text).toMatch(/name and email/i);

    await chat.say('Priya Raman, priya@example.com');
    const handed = await chat.say('Yes, please contact me');

    expect(handed.toolsUsed).toContain('requestHumanHandoff');
    // Never implies a person has already replied.
    expect(handed.text).toMatch(/not replied yet/i);
  });

  it('says a combination is not built rather than pricing a different one', async () => {
    const chat = await conversation();

    const asked = await chat.say('How much is the S5 Luxury with the 2.0 Turbo?');

    // The 2.0 Turbo is not offered on the Luxury. Substituting a compatible
    // engine would return a real price for a car they did not ask about.
    expect(asked.toolsUsed).not.toContain('calculateVehiclePrice');
    expect(asked.text).toMatch(/not offered on the Luxury/i);
    expect(asked.text).toMatch(/3\.0 Turbo AWD/);
    expect(asked.text).not.toMatch(/Total/);
  });

  it('says a colour is not offered before listing the ones that are', async () => {
    const chat = await conversation();

    const asked = await chat.say('Can I get the S5 Premium in lime green?');
    expect(asked.toolsUsed).toEqual(['getVehicleColours']);
    expect(asked.text).toMatch(/do not offer a green/i);
    expect(asked.text).toContain('Obsidian Black');
  });

  it('hands a negotiation to a person instead of quoting list price', async () => {
    const chat = await conversation();

    const asked = await chat.say('What is the best price you can do on an S5 if I buy today?');
    expect(asked.toolsUsed).toEqual([]);
    expect(asked.text).not.toMatch(/\$/);
    expect(asked.text).toMatch(/specialist/i);
  });

  it('separates what is standard from what costs extra', async () => {
    const chat = await conversation();

    const standard = await chat.say('What is standard on the S5 Premium?');
    expect(standard.toolsUsed).toContain('getVehicleFeatures');
    expect(standard.text.length).toBeGreaterThan(40);

    const extras = await chat.say('And what packages can I add?');
    expect(extras.toolsUsed).toContain('getVehicleOptions');
  });

  it('records a trade-in as an appraisal, never as a valuation', async () => {
    const chat = await conversation();

    const opened = await chat.say('I want to trade in my old car against an S5');
    expect(opened.text).toMatch(/year, make, model and rough mileage/i);

    const described = await chat.say('2019 Toyota Camry with 80,000 km');
    expect(described.text).toMatch(/excellent, good, fair or poor/i);

    await chat.say('Good condition');
    await chat.say('Sam Whitfield, sam.whitfield@example.com');
    const recorded = await chat.say('Yes');

    expect(recorded.toolsUsed).toContain('createTradeInRequest');
    // No figure, and it says why there is no figure.
    expect(recorded.text).toMatch(/appraisal, not a valuation/i);
    expect(recorded.text).not.toMatch(/worth \$|value of \$/i);

    const [request] = await admin<
      { vehicle_make: string; mileage_km: number; appraised_value_cents: number | null }[]
    >`
      SELECT vehicle_make, mileage_km, appraised_value_cents FROM trade_in_requests
      WHERE tenant_id = ${SINCLAIR_TENANT_ID}
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(request!.vehicle_make).toBe('Toyota');
    expect(request!.mileage_km).toBe(80_000);
    // No valuation exists until a person has looked at the car.
    expect(request!.appraised_value_cents).toBeNull();
  });

  it('takes a callback only once it has a number to call', async () => {
    const chat = await conversation();

    await chat.say('Could you call me about the X7?');
    const needsNumber = await chat.say('Jo Lindqvist, jo@example.com');
    expect(needsNumber.text).toMatch(/what number/i);
    expect(needsNumber.toolsUsed).not.toContain('createCallbackRequest');

    await chat.say('416 555 0134');
    const created = await chat.say('Yes, that is fine');

    expect(created.toolsUsed).toContain('createCallbackRequest');
    expect(created.receipt?.ticketNumber).toMatch(/^SIN-/);
  });

  it('estimates finance from a real price and calls it an estimate', async () => {
    const chat = await conversation();

    const estimate = await chat.say('What would the S3 cost me a month over 60 months?');
    expect(estimate.toolsUsed).toContain('calculateFinanceEstimate');
    expect(estimate.text).toMatch(/a month/i);
    expect(estimate.text).toMatch(/estimate/i);
    // Says outright what it is not, rather than leaving it to be assumed.
    expect(estimate.text).toMatch(/not an offer of credit/i);
    expect(estimate.text).toMatch(/not a guarantee of approval/i);
  });
});
