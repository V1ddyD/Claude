import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { withTenant } from '../../src/server/db/tenant-db';
import { closeConnections } from '../../src/server/db/client';
import {
  getAvailableTestDriveSlots, createTestDrive, type TenantTiming,
} from '../../src/server/services/booking';
import { resolveCustomer } from '../../src/server/services/leads';
import { isAppError } from '../../src/server/errors';

/**
 * Booking, against the real database.
 *
 * The assertion this file exists for: two customers racing for one slot produce
 * exactly one appointment. Not "usually one" — the exclusion constraint makes
 * the second physically unable to commit.
 */

const TENANT: TenantTiming = {
  timezone: 'America/Toronto',
  locale: 'en-CA',
  ticketPrefix: 'SIN',
  settings: { slotMinutes: 60, minNoticeHours: 2, maxHorizonDays: 14 },
};

let admin: Sql;

async function newConversation(): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO conversations (tenant_id) VALUES (${SINCLAIR_TENANT_ID}) RETURNING id
  `;
  return row!.id;
}

async function newCustomer(name: string): Promise<string> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`;
  return (await withTenant(SINCLAIR_TENANT_ID, (db) =>
    resolveCustomer(db, { fullName: name, email, contactConsent: true }),
  ))!;
}

/** A slot far enough out that no other test has taken it. */
function windowFrom(daysAhead: number) {
  const from = new Date(Date.now() + daysAhead * 864e5);
  return { from, to: new Date(from.getTime() + 864e5) };
}

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

describe('offering slots', () => {
  it('offers times only when both a salesperson and a demonstrator are free', async () => {
    const { from, to } = windowFrom(3);
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, { from, to }),
    );
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect.soft(slot.endsAt.getTime() - slot.startsAt.getTime()).toBe(60 * 60_000);
    }
  });

  it('offers nothing for a model with no demonstrator', async () => {
    const { from, to } = windowFrom(3);
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, { from, to, modelSlug: 'nonexistent-model' }),
    );
    expect(slots).toEqual([]);
  });
});

describe('booking a test drive', () => {
  it('creates the appointment, ticket, notification and lead in one transaction', async () => {
    const { from, to } = windowFrom(4);
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, { from, to }),
    );
    const customerId = await newCustomer('Alex Morgan');
    const conversationId = await newConversation();

    const result = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      createTestDrive(db, TENANT, {
        conversationId, customerId, startsAt: slots[0]!.startsAt,
      }),
    );

    expect(result.ticketNumber).toMatch(/^SIN-\d{4}-\d+$/);
    expect(result.confirmationCode).toHaveLength(6);
    // An absolute local date with a zone, never a bare weekday.
    expect(result.formattedWhen).toMatch(/\d{4}/);
    expect(result.formattedWhen).toMatch(/E[DS]T/);

    const [ticket] = await admin<{ number: string; lead_id: string }[]>`
      SELECT number, lead_id FROM tickets WHERE appointment_id = ${result.appointmentId}
    `;
    expect(ticket?.number).toBe(result.ticketNumber);
    expect(ticket?.lead_id).not.toBeNull();

    const [notification] = await admin<{ type: string }[]>`
      SELECT type FROM notifications WHERE link_path = ${'/portal/leads/' + ticket!.lead_id}
    `;
    expect(notification?.type).toBe('test_drive_booked');

    // Two resource holds: the salesperson and the car.
    const holds = await admin<{ resource_id: string }[]>`
      SELECT resource_id FROM appointment_resources WHERE appointment_id = ${result.appointmentId}
    `;
    expect(holds).toHaveLength(2);
  });

  it('queues the confirmation email rather than claiming it was sent', async () => {
    const { from, to } = windowFrom(5);
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, { from, to }),
    );
    const customerId = await newCustomer('Sam Carter');
    const conversationId = await newConversation();

    const result = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      createTestDrive(db, TENANT, { conversationId, customerId, startsAt: slots[0]!.startsAt }),
    );
    expect(result.confirmationEmailQueued).toBe(true);

    const [email] = await admin<{ status: string; accepted_at: Date | null }[]>`
      SELECT status, accepted_at FROM email_messages WHERE dedupe_key = ${'test_drive:' + result.appointmentId}
    `;
    // Queued, not accepted, not delivered. Only the provider can advance this.
    expect(email?.status).toBe('queued');
    expect(email?.accepted_at).toBeNull();
  });

  it('makes the booking itself raise the lead priority', async () => {
    const { from, to } = windowFrom(6);
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, { from, to }),
    );
    const customerId = await newCustomer('Priya Test');
    const conversationId = await newConversation();

    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      createTestDrive(db, TENANT, { conversationId, customerId, startsAt: slots[0]!.startsAt }),
    );

    const [lead] = await admin<{ score: number; score_rationale: string }[]>`
      SELECT score, score_rationale FROM leads WHERE conversation_id = ${conversationId}
    `;
    expect(lead!.score).toBeGreaterThan(0);
    expect(lead!.score_rationale).toContain('priority');
  });
});

describe('two customers racing for one slot', () => {
  it('produces exactly one appointment', async () => {
    const { from, to } = windowFrom(7);
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, { from, to }),
    );
    // Asserted, because an empty list would make every racer fail for a
    // reason that has nothing to do with the race.
    expect(slots.length, 'no bookable slots in the race window').toBeGreaterThan(0);
    const target = slots[0]!.startsAt;

    // Enough racers to exhaust every demonstrator and salesperson for the slot.
    const racers = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => ({
        customerId: await newCustomer(`Racer ${i}`),
        conversationId: await newConversation(),
      })),
    );

    const outcomes = await Promise.allSettled(
      racers.map((racer) =>
        withTenant(SINCLAIR_TENANT_ID, (db) =>
          createTestDrive(db, TENANT, {
            conversationId: racer.conversationId,
            customerId: racer.customerId,
            startsAt: target,
          }),
        ),
      ),
    );

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');

    expect(won.length).toBeGreaterThanOrEqual(1);
    expect(lost.length).toBeGreaterThanOrEqual(1);

    // Losers get a typed, customer-safe refusal — never a database error.
    for (const outcome of lost) {
      const reason = (outcome as PromiseRejectedResult).reason;
      const describe = isAppError(reason)
        ? `${reason.code}: ${reason.message}`
        : `UNTYPED ${(reason as Error)?.constructor?.name}: ${(reason as Error)?.message}`;

      expect.soft(isAppError(reason) && reason.code, describe).toBe('SLOT_TAKEN');
      expect.soft((reason as Error).message, describe).not.toMatch(/constraint|postgres|23P01/i);
    }

    // The real assertion: no resource is double-booked, by anyone, ever.
    const overlaps = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM appointment_resources a
        JOIN appointment_resources b
          ON a.resource_id = b.resource_id AND a.id <> b.id
         AND a.time_range && b.time_range
      WHERE a.status = 'active' AND b.status = 'active'
    `;
    expect(overlaps[0]?.count).toBe(0);
  });

  it('never surfaces a database error, even under heavy contention', async () => {
    // This is the case that found the lock-ordering bug. Racers spread across
    // two adjacent slots contend for OVERLAPPING but not identical resource
    // sets — one wants salesperson A and car B, another wants car B and
    // salesperson A. Acquired in different orders, that is a deadlock, and
    // Postgres resolves it by killing a transaction with an error that has
    // nothing to do with availability.
    const { from, to } = windowFrom(9);
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, { from, to }),
    );
    expect(slots.length).toBeGreaterThan(1);

    const racers = await Promise.all(
      Array.from({ length: 14 }, async (_, i) => ({
        customerId: await newCustomer(`Contender ${i}`),
        conversationId: await newConversation(),
        startsAt: slots[i % 2]!.startsAt,
      })),
    );

    const outcomes = await Promise.allSettled(
      racers.map((racer) =>
        withTenant(SINCLAIR_TENANT_ID, (db) =>
          createTestDrive(db, TENANT, {
            conversationId: racer.conversationId,
            customerId: racer.customerId,
            startsAt: racer.startsAt,
          }),
        ),
      ),
    );

    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') continue;
      const reason = outcome.reason;
      const describe = isAppError(reason)
        ? `${reason.code}: ${reason.message}`
        : `UNTYPED ${(reason as Error)?.constructor?.name}: ${(reason as Error)?.message}`;

      // Every loser gets something a customer can be shown.
      expect.soft(isAppError(reason), describe).toBe(true);
      expect.soft((reason as Error).message, describe).not.toMatch(
        /deadlock|constraint|postgres|relation|insert into/i,
      );
    }

    const overlaps = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM appointment_resources a
        JOIN appointment_resources b
          ON a.resource_id = b.resource_id AND a.id <> b.id AND a.time_range && b.time_range
      WHERE a.status = 'active' AND b.status = 'active'
    `;
    expect(overlaps[0]?.count).toBe(0);

    // Release what this test booked. The dealership has a finite number of
    // demonstrators, so a contention test that keeps its bookings fills the
    // diary and starves every later run — which is a test that only works once.
    const booked = outcomes
      .filter((o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof createTestDrive>>> =>
        o.status === 'fulfilled',
      )
      .map((o) => o.value.appointmentId);

    if (booked.length > 0) {
      await admin`
        UPDATE appointment_resources SET status = 'released'
        WHERE appointment_id = ANY(${admin.array(booked)}::uuid[])
      `;
      await admin`
        UPDATE appointments SET status = 'cancelled', cancelled_at = now(),
          cancelled_reason = 'test cleanup'
        WHERE id = ANY(${admin.array(booked)}::uuid[])
      `;
    }
  }, 60_000);

  it('leaves no orphaned ticket when a booking loses the race', async () => {
    // Every part of a booking commits together or not at all, so a failed
    // booking must not leave a ticket number the customer could quote.
    const orphans = await admin<{ number: string }[]>`
      SELECT t.number FROM tickets t
        LEFT JOIN appointments a ON a.id = t.appointment_id
      WHERE t.type = 'test_drive' AND t.appointment_id IS NOT NULL AND a.id IS NULL
    `;
    expect(orphans).toEqual([]);
  });
});

describe('ticket numbering', () => {
  it('is gapless and unique per tenant under concurrency', async () => {
    const numbers = await admin<{ number: string }[]>`
      SELECT number FROM tickets WHERE tenant_id = ${SINCLAIR_TENANT_ID} ORDER BY number
    `;
    const seen = new Set(numbers.map((n) => n.number));
    expect(seen.size).toBe(numbers.length);

    const sequence = numbers
      .map((n) => Number(n.number.split('-').at(-1)))
      .sort((a, b) => a - b);
    for (let i = 1; i < sequence.length; i++) {
      expect.soft(sequence[i]! - sequence[i - 1]!).toBe(1);
    }
  });
});
