import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation } from '../../src/server/ai/extraction';
import { RuleBasedModel } from '../../src/server/ai/rule-based';
import { features } from '../../src/server/config/env';
import { modelClient, setModelClient } from '../../src/server/ai/client';

/**
 * The enquiry scenarios a dealership actually gets (spec §33).
 *
 * Each one drives the real conversation loop against the real database. What
 * is asserted is workflow behaviour — which system was consulted, what was
 * persisted, what the customer was and was not told — never that a particular
 * sentence came back.
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

function chat() {
  const client = new RuleBasedModel();
  const session = ensureConversation(SINCLAIR_TENANT_ID, {});

  return async function say(message: string) {
    const { conversationId, visitorId } = await session;
    return respondToMessage({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId,
      visitorId,
      userMessage: message,
      requestId: 'scenarios',
      client,
    });
  };
}

describe('finding a vehicle', () => {
  it('searches on a budget expressed any number of ways', async () => {
    for (const phrasing of [
      'I am looking for an SUV around $50,000',
      'I have about 50 grand to spend and want an SUV',
      'What SUVs do you have around 50k?',
      'Can you recommend an SUV for roughly fifty thousand?',
    ]) {
      const reply = await chat()(phrasing);
      expect.soft(reply.toolsUsed, phrasing).toContain('searchVehicles');
      expect.soft(reply.text, phrasing).toMatch(/\$/);
    }
  });

  it('searches on a body style with no budget at all', async () => {
    const reply = await chat()('Do you make a pickup?');
    expect(reply.toolsUsed).toContain('searchVehicles');
  });

  it('searches on a powertrain rather than a price', async () => {
    const reply = await chat()('I want something electric');
    expect(reply.toolsUsed).toContain('searchVehicles');
    // Only electric models, so a petrol-only car must not appear.
    const petrolOnly = await admin<{ name: string }[]>`
      SELECT m.full_name AS name FROM vehicle_models m
      WHERE m.tenant_id = ${SINCLAIR_TENANT_ID}
        AND NOT EXISTS (
          SELECT 1 FROM powertrains p WHERE p.model_id = m.id AND p.kind = 'bev'
        )
    `;
    for (const model of petrolOnly) {
      expect.soft(reply.text, model.name).not.toContain(`**${model.name}**`);
    }
  });

  it('says so plainly when nothing fits', async () => {
    const reply = await chat()('I am looking for a convertible under $20,000');
    expect(reply.text).toMatch(/nothing in the range|closest/i);
    expect(reply.text).not.toMatch(/\*\*Sinclair/);
  });

  it('compares two models on catalogue data', async () => {
    const reply = await chat()('Compare the S5 and the X7');
    expect(reply.toolsUsed).toContain('compareVehicles');
    expect(reply.text).toContain('Sinclair S5');
    expect(reply.text).toContain('Sinclair X7');
  });
});

describe('a service enquiry', () => {
  it('answers hours from the service department, not sales', async () => {
    const reply = await chat()('When is your service department open?');
    expect(reply.toolsUsed).toContain('getDealershipHours');
    expect(reply.text).toMatch(/service/i);
  });

  it('raises a service ticket rather than inventing a price or a slot', async () => {
    const say = chat();
    const opened = await say('My car needs a service, how much is a brake fluid change?');

    // No service price list exists, so no figure may appear.
    expect(opened.text).not.toMatch(/\$\d/);

    await say('Ines Halvorsen, ines.halvorsen@example.test');
    const raised = await say('Yes, that is fine');

    expect(raised.toolsUsed).toContain('createSupportTicket');
    const [ticket] = await admin<{ type: string }[]>`
      SELECT type FROM tickets
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND number = ${raised.receipt!.ticketNumber}
    `;
    expect(ticket!.type).toBe('service');
  });
});

describe('a test drive that cannot happen', () => {
  it('will not book a time that was never offered', async () => {
    const say = chat();
    await say('I would like to test drive the S5');
    // 4am is not in the diary and never will be.
    const reply = await say('Can I come at 4am on Sunday?');

    expect(reply.toolsUsed).not.toContain('createTestDrive');
    expect(reply.receipt).toBeUndefined();
    expect(reply.text).toMatch(/which of those times|suits you/i);
  });

  it('refuses the second booking of one slot without claiming success', async () => {
    // Two customers, the same first offered slot.
    const book = async (name: string, email: string) => {
      const say = chat();
      await say('I would like to test drive the S3');
      await say('The first one please');
      await say(`${name}, ${email}`);
      return say('Yes, that is fine');
    };

    const first = await book('Ada First', `ada.${Date.now()}@example.test`);
    const second = await book('Bo Second', `bo.${Date.now()}@example.test`);

    expect(first.toolsUsed).toContain('createTestDrive');
    expect(first.receipt?.confirmationCode).toBeTruthy();

    // The second customer is told something true either way: a booking of a
    // different slot, or that the slot went. Never a confirmation for a
    // booking that did not commit.
    if (second.receipt) {
      expect(second.receipt.confirmationCode).not.toBe(first.receipt!.confirmationCode);
      expect(second.receipt.when).not.toBe(first.receipt!.when);
    } else {
      expect(second.text).not.toMatch(/booked/i);
    }

    const [appointments] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM appointments a
        JOIN appointment_resources r ON r.appointment_id = a.id
      WHERE a.tenant_id = ${SINCLAIR_TENANT_ID}
        AND a.confirmation_code = ${first.receipt!.confirmationCode!}
        AND r.status = 'active'
    `;
    expect(appointments!.count).toBeGreaterThan(0);
  });
});

describe('a financing enquiry', () => {
  it('passes it to a specialist without approving anything', async () => {
    const say = chat();
    const estimate = await say('What would the S5 cost me a month over 60 months?');
    expect(estimate.toolsUsed).toContain('calculateFinanceEstimate');

    await say('Yes please, I would like a specialist to confirm the terms');
    await say('Tomas Ek, tomas.ek@example.test');
    const requested = await say('Yes, that is fine');

    expect(requested.toolsUsed).toContain('createFinancingRequest');
    expect(requested.text).toMatch(/nothing is approved|specialist/i);

    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM finance_requests
      WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;
    expect(row!.count).toBeGreaterThan(0);
  });
});

describe('the configured provider', () => {
  it('is the scripted assistant when no credential exists', () => {
    // This suite runs without ANTHROPIC_API_KEY, which is the point: AI_PROVIDER
    // defaults to 'auto' and resolves to the assistant that can actually run.
    expect(features.ai).toBe(false);
    expect(features.aiProvider).toBe('scripted');
  });

  it('hands the conversation a scripted client through the normal factory', () => {
    setModelClient(null);
    expect(modelClient()).toBeInstanceOf(RuleBasedModel);
  });

  it('reports which assistant answered, for operators rather than customers', async () => {
    const reply = await chat()('Hello');
    expect(reply.mode).toBe('scripted');
    expect(reply.degraded).toBe(false);
    expect(reply.text).not.toMatch(/scripted|rule|provider|model/i);
  });
});
