import 'server-only';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { accessTokens, tickets, appointments, customers } from '@/server/db/schema';
import { withTenant, type TenantDb } from '@/server/db/tenant-db';
import { notFound } from '@/server/errors';

/**
 * Letting a customer see their own ticket, without an account.
 *
 * The rule this exists to keep (docs/00-architecture.md §3): an email address
 * is an identifier, never a credential. There is no "look up my ticket by
 * email" — that would be a customer-data enumeration endpoint. Instead a link
 * is emailed that names exactly one record, expires, and works once.
 *
 * Only the SHA-256 of the token is stored, so a database leak does not hand
 * anyone a working link.
 */

const TOKEN_TTL_HOURS = 72;

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export async function issueAccessToken(
  db: TenantDb,
  params: { scope: 'ticket' | 'appointment'; entityId: string; customerId: string },
): Promise<IssuedToken> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3600_000);

  await db.insert(accessTokens).values({
    tenantId: db.tenantId,
    tokenHash: hash(token),
    scope: params.scope,
    entityId: params.entityId,
    customerId: params.customerId,
    expiresAt,
  });

  return { token, expiresAt };
}

export interface TicketView {
  number: string;
  type: string;
  status: string;
  subject: string;
  createdAt: Date;
  customerName: string | null;
  appointment: {
    startsAt: Date;
    confirmationCode: string;
    status: string;
  } | null;
}

/**
 * Redeem a token and return the one record it names.
 *
 * Consumed on use. A link forwarded to someone else works once and then does
 * not, which is a far smaller exposure than a link that works forever.
 */
export async function redeemTicketToken(
  tenantId: string,
  token: string,
): Promise<TicketView> {
  return withTenant(tenantId, async (db) => {
    const rows = await db
      .select({
        id: accessTokens.id,
        entityId: accessTokens.entityId,
        scope: accessTokens.scope,
      })
      .from(accessTokens)
      .where(
        and(
          eq(accessTokens.tenantId, db.tenantId),
          eq(accessTokens.tokenHash, hash(token)),
          gt(accessTokens.expiresAt, new Date()),
          isNull(accessTokens.usedAt),
        ),
      )
      .limit(1);

    const grant = rows[0];
    // Expired, already used, or never real — all the same answer. Telling them
    // apart tells a guesser which guesses were close.
    if (!grant || grant.scope !== 'ticket') throw notFound('That link');

    const ticketRows = await db
      .select({
        number: tickets.number,
        type: tickets.type,
        status: tickets.status,
        subject: tickets.subject,
        createdAt: tickets.createdAt,
        appointmentId: tickets.appointmentId,
        customerName: customers.fullName,
      })
      .from(tickets)
      .innerJoin(customers, eq(customers.id, tickets.customerId))
      .where(and(eq(tickets.tenantId, db.tenantId), eq(tickets.id, grant.entityId)))
      .limit(1);

    const ticket = ticketRows[0];
    if (!ticket) throw notFound('That request');

    let appointment: TicketView['appointment'] = null;
    if (ticket.appointmentId) {
      const [row] = await db
        .select({
          startsAt: appointments.startsAt,
          confirmationCode: appointments.confirmationCode,
          status: appointments.status,
        })
        .from(appointments)
        .where(
          and(eq(appointments.tenantId, db.tenantId), eq(appointments.id, ticket.appointmentId)),
        )
        .limit(1);
      appointment = row ?? null;
    }

    // Marked used only once the record was actually returned, so a failure
    // does not burn the customer's one chance to see it.
    await db
      .update(accessTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(accessTokens.tenantId, db.tenantId), eq(accessTokens.id, grant.id)));

    return {
      number: ticket.number,
      type: ticket.type,
      status: ticket.status,
      subject: ticket.subject,
      createdAt: ticket.createdAt,
      customerName: ticket.customerName,
      appointment,
    };
  });
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
