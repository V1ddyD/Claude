import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { drainOutbox, applyDeliveryEvent } from '../../src/server/services/email/outbox';
import { setEmailProvider, type EmailProvider, type OutgoingEmail, type SendResult }
  from '../../src/server/services/email/provider';
import { createCustomerRequest } from '../../src/server/services/tickets';
import { resolveCustomer } from '../../src/server/services/leads';
import { renderTemplate } from '../../src/server/services/email/templates';

/**
 * The transactional outbox.
 *
 * The property under test: nothing is ever reported as sent before the provider
 * says so, and nothing is reported as delivered before the provider's webhook
 * says so (spec §21, §54).
 */

let admin: Sql;
const TENANT = { ticketPrefix: 'SIN', brandName: 'Sinclair' };

/**
 * A fake provider.
 *
 * Note the per-send id: a real provider never reuses one, and a fake that did
 * made delivery lookups ambiguous as soon as a drain swept more than one
 * message — which is exactly what a shared test database produces.
 */
class RecordingProvider implements EmailProvider {
  readonly name = 'recording';
  readonly sent: OutgoingEmail[] = [];
  private counter = 0;

  constructor(private readonly outcome: SendResult | ((n: number) => SendResult)) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    this.sent.push(email);
    this.counter++;
    return typeof this.outcome === 'function' ? this.outcome(this.counter) : this.outcome;
  }
}

const acceptsEach = (): SendResult | ((n: number) => SendResult) => (n: number) => ({
  accepted: true,
  providerMessageId: `prov_${Date.now()}_${n}`,
});

/** The id the provider actually assigned to this message. */
async function providerIdFor(sql: Sql, email: string): Promise<string> {
  const [row] = await sql<{ provider_message_id: string }[]>`
    SELECT provider_message_id FROM email_messages WHERE to_email = ${email}
  `;
  return row!.provider_message_id;
}

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterEach(() => setEmailProvider(null));
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

async function queueOne(email: string): Promise<string> {
  return withTenant(SINCLAIR_TENANT_ID, async (db) => {
    const customerId = (await resolveCustomer(db, {
      fullName: 'Outbox Test', email, contactConsent: true,
    }))!;
    const result = await createCustomerRequest(db, TENANT, {
      type: 'general',
      subject: 'Outbox test',
      customerId,
      emailTemplate: 'enquiry_received',
    });
    return result.ticketNumber;
  });
}

describe('queueing', () => {
  it('writes the message in the business transaction, unsent', async () => {
    const email = `queued.${Date.now()}@example.test`;
    await queueOne(email);

    const [row] = await admin<{ status: string; accepted_at: Date | null }[]>`
      SELECT status, accepted_at FROM email_messages WHERE to_email = ${email}
    `;
    expect(row?.status).toBe('queued');
    expect(row?.accepted_at).toBeNull();
  });

  it('does not queue anything without contact consent', async () => {
    const email = `noconsent.${Date.now()}@example.test`;
    await withTenant(SINCLAIR_TENANT_ID, async (db) => {
      const customerId = (await resolveCustomer(db, {
        fullName: 'No Consent', email, contactConsent: false,
      }))!;
      await createCustomerRequest(db, TENANT, {
        type: 'general', subject: 'No consent', customerId, emailTemplate: 'enquiry_received',
      });
    });

    const rows = await admin`SELECT id FROM email_messages WHERE to_email = ${email}`;
    // The customer still gets their ticket number; we just do not write to them.
    expect(rows).toHaveLength(0);
  });
});

describe('sending', () => {
  it('marks a message accepted only when the provider accepts it', async () => {
    const email = `accepted.${Date.now()}@example.test`;
    await queueOne(email);

    setEmailProvider(new RecordingProvider(acceptsEach()));
    await drainOutbox();

    const [row] = await admin<{ status: string; provider_message_id: string; delivered_at: Date | null }[]>`
      SELECT status, provider_message_id, delivered_at FROM email_messages WHERE to_email = ${email}
    `;
    expect(row?.status).toBe('accepted');
    expect(row?.provider_message_id).toMatch(/^prov_/);
    // Accepted is NOT delivered. Only the webhook can say that.
    expect(row?.delivered_at).toBeNull();
  });

  it('requeues a retryable failure with backoff rather than losing it', async () => {
    const email = `retry.${Date.now()}@example.test`;
    await queueOne(email);

    setEmailProvider(new RecordingProvider({ accepted: false, error: '503 upstream', retryable: true }));
    await drainOutbox();

    const [row] = await admin<{ status: string; attempts: number; scheduled_for: Date }[]>`
      SELECT status, attempts, scheduled_for FROM email_messages WHERE to_email = ${email}
    `;
    expect(row?.status).toBe('queued');
    expect(row?.attempts).toBe(1);
    expect(row!.scheduled_for.getTime()).toBeGreaterThan(Date.now());
  });

  it('fails a non-retryable rejection instead of looping on it', async () => {
    const email = `rejected.${Date.now()}@example.test`;
    await queueOne(email);

    setEmailProvider(
      new RecordingProvider({ accepted: false, error: '422 invalid recipient', retryable: false }),
    );
    await drainOutbox();

    const [row] = await admin<{ status: string; last_error: string }[]>`
      SELECT status, last_error FROM email_messages WHERE to_email = ${email}
    `;
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toContain('422');
  });

  it('never reports success when no provider is configured', async () => {
    const email = `noprovider.${Date.now()}@example.test`;
    await queueOne(email);

    setEmailProvider(null); // falls back to the unconfigured provider
    await drainOutbox();

    const [row] = await admin<{ status: string }[]>`
      SELECT status FROM email_messages WHERE to_email = ${email}
    `;
    // Still queued. It must never silently look sent.
    expect(row?.status).toBe('queued');
  });
});

describe('delivery', () => {
  it('is set only by a provider event', async () => {
    const email = `delivered.${Date.now()}@example.test`;
    await queueOne(email);
    setEmailProvider(new RecordingProvider(acceptsEach()));
    await drainOutbox();

    const applied = await applyDeliveryEvent({
      providerMessageId: await providerIdFor(admin, email),
      type: 'delivered',
    });
    expect(applied).toBe(true);

    const [row] = await admin<{ status: string; delivered_at: Date | null }[]>`
      SELECT status, delivered_at FROM email_messages WHERE to_email = ${email}
    `;
    expect(row?.status).toBe('delivered');
    expect(row?.delivered_at).not.toBeNull();
  });

  it('records a bounce', async () => {
    const email = `bounced.${Date.now()}@example.test`;
    await queueOne(email);
    setEmailProvider(new RecordingProvider(acceptsEach()));
    await drainOutbox();

    await applyDeliveryEvent({
      providerMessageId: await providerIdFor(admin, email),
      type: 'bounced',
    });

    const [row] = await admin<{ status: string }[]>`
      SELECT status FROM email_messages WHERE to_email = ${email}
    `;
    expect(row?.status).toBe('bounced');
  });

  it('ignores an event for a message it does not know', async () => {
    expect(await applyDeliveryEvent({ providerMessageId: 'nope', type: 'delivered' })).toBe(false);
  });
});

describe('templates', () => {
  it('states plainly that a trade-in has no value attached', () => {
    const rendered = renderTemplate('trade_in_received', 'Trade-in', {
      brandName: 'Sinclair',
      customerName: 'Alex',
      payload: { ticketNumber: 'SIN-2026-1' },
    });
    expect(rendered.text).toContain('in-person inspection');
    expect(rendered.text).not.toMatch(/\$\d/);
  });

  it('labels financing figures as estimates, never offers', () => {
    const rendered = renderTemplate('financing_received', 'Financing', {
      brandName: 'Sinclair',
      payload: { ticketNumber: 'SIN-2026-2' },
    });
    expect(rendered.text).toContain('estimates');
    expect(rendered.text).toContain('not an offer of credit');
  });

  it('escapes customer-supplied content', () => {
    const rendered = renderTemplate('enquiry_received', 'Enquiry', {
      brandName: 'Sinclair',
      customerName: '<script>alert(1)</script>',
      payload: { ticketNumber: 'SIN-2026-3' },
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});
