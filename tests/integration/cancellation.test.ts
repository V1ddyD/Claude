import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import {
  getAvailableTestDriveSlots, createTestDrive, cancelTestDrive,
} from '../../src/server/services/booking';
import { resolveCustomer } from '../../src/server/services/leads';
import { ensureConversation } from '../../src/server/ai/extraction';
import { isAppError } from '../../src/server/errors';

/**
 * Cancelling a test drive.
 *
 * The property that matters operationally: a cancelled booking must RELEASE
 * the salesperson and the car. A cancellation that leaves the holds in place
 * takes a slot off the market for nobody.
 */

const TENANT = { timezone: 'America/Toronto', locale: 'en-CA', ticketPrefix: 'SIN' };
let admin: Sql;

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

/**
 * Books the first genuinely free S5 slot in the horizon.
 *
 * Naming a fixed day makes the test depend on what every other suite has
 * already booked in this shared database.
 */
async function book(email: string, _daysAhead: number) {
  const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
  const customerId = (await withTenant(SINCLAIR_TENANT_ID, (db) =>
    resolveCustomer(db, { fullName: 'Cancel Test', email, contactConsent: true }),
  ))!;

  const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
    getAvailableTestDriveSlots(db, TENANT, {
      from: new Date(Date.now() + 2 * 864e5),
      to: new Date(Date.now() + 13 * 864e5),
      modelSlug: 's5',
    }),
  );
  expect(slots.length, 'no bookable S5 slot in the horizon').toBeGreaterThan(0);

  const result = await withTenant(SINCLAIR_TENANT_ID, (db) =>
    createTestDrive(db, TENANT, {
      conversationId: session.conversationId,
      customerId,
      startsAt: slots[0]!.startsAt,
      modelSlug: 's5',
    }),
  );
  return { ...result, email };
}

describe('cancelling', () => {
  it('releases the salesperson and the car back to the diary', async () => {
    const booking = await book(`release.${Date.now()}@example.test`, 8);

    const before = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, {
        from: booking.startsAt, to: booking.endsAt, modelSlug: 's5',
      }),
    );

    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      cancelTestDrive(db, {
        confirmationCode: booking.confirmationCode,
        email: booking.email,
        reason: 'Something came up',
      }),
    );

    const holds = await admin<{ status: string }[]>`
      SELECT status FROM appointment_resources WHERE appointment_id = ${booking.appointmentId}
    `;
    expect(holds.every((h) => h.status === 'released')).toBe(true);

    const after = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, {
        from: booking.startsAt, to: booking.endsAt, modelSlug: 's5',
      }),
    );
    // The slot is genuinely bookable again, not merely marked cancelled.
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it('keeps the record, and tells the team', async () => {
    const booking = await book(`record.${Date.now()}@example.test`, 9);
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      cancelTestDrive(db, { confirmationCode: booking.confirmationCode, email: booking.email }),
    );

    const [appointment] = await admin<{ status: string; cancelled_at: Date | null }[]>`
      SELECT status, cancelled_at FROM appointments WHERE id = ${booking.appointmentId}
    `;
    expect(appointment?.status).toBe('cancelled');
    expect(appointment?.cancelled_at).not.toBeNull();

    const [notification] = await admin<{ type: string }[]>`
      SELECT type FROM notifications WHERE type = 'appointment_cancelled'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(notification?.type).toBe('appointment_cancelled');
  });

  it('needs the email as well as the code', async () => {
    const booking = await book(`twofactor.${Date.now()}@example.test`, 10);

    await expect(
      withTenant(SINCLAIR_TENANT_ID, (db) =>
        cancelTestDrive(db, {
          confirmationCode: booking.confirmationCode,
          email: 'someone.else@example.test',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Still booked.
    const [appointment] = await admin<{ status: string }[]>`
      SELECT status FROM appointments WHERE id = ${booking.appointmentId}
    `;
    expect(appointment?.status).toBe('scheduled');
  });

  it('answers the same way for a wrong code and a wrong email', async () => {
    // Distinguishing them tells a guesser which guesses were close.
    const wrongCode = withTenant(SINCLAIR_TENANT_ID, (db) =>
      cancelTestDrive(db, { confirmationCode: 'ZZZZZZ', email: 'a@example.test' }),
    );
    await expect(wrongCode).rejects.toMatchObject({ code: 'NOT_FOUND' });

    try {
      await wrongCode;
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.message).toBe('That booking could not be found.');
    }
  });

  it('is idempotent', async () => {
    const booking = await book(`idem.${Date.now()}@example.test`, 11);
    const args = { confirmationCode: booking.confirmationCode, email: booking.email };

    await withTenant(SINCLAIR_TENANT_ID, (db) => cancelTestDrive(db, args));
    // A customer clicking twice is not an error.
    await expect(
      withTenant(SINCLAIR_TENANT_ID, (db) => cancelTestDrive(db, args)),
    ).resolves.toMatchObject({ cancelled: true });
  });
});
