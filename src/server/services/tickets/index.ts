import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  tickets, notifications, emailMessages, customers, leads,
  financeRequests, tradeInRequests, type TicketType,
} from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';
import { notFound } from '@/server/errors';
import { recordAudit } from '@/server/services/audit';
import { allocateTicketNumber } from './numbering';
import { upsertLead, recordLeadEvent, recomputePriority } from '@/server/services/leads';

/**
 * One path for every customer-initiated request.
 *
 * Ticket number, ticket, lead attachment, staff notification, queued
 * confirmation, timeline entry and audit — all in the caller's transaction, so
 * a request either exists completely or not at all. Every request tool goes
 * through here rather than assembling its own version, which is how the
 * customer's receipt and the dealership's record stay in step.
 */

export interface CustomerRequest {
  type: TicketType;
  subject: string;
  body?: string;
  customerId: string;
  conversationId?: string;
  /** Which team should see it. Service work must not land in the sales queue. */
  notifyRole?: 'sales' | 'service';
  emailTemplate?: string;
  emailPayload?: Record<string, unknown>;
}

export interface RequestResult {
  ticketNumber: string;
  ticketId: string;
  leadId: string | null;
  confirmationEmailQueued: boolean;
}

export async function createCustomerRequest(
  db: TenantDb,
  tenant: { ticketPrefix: string; brandName: string },
  request: CustomerRequest,
): Promise<RequestResult> {
  const customerRows = await db
    .select({
      id: customers.id,
      fullName: customers.fullName,
      email: customers.email,
      consent: customers.contactConsent,
    })
    .from(customers)
    .where(and(eq(customers.tenantId, db.tenantId), eq(customers.id, request.customerId)))
    .limit(1);

  const customer = customerRows[0];
  if (!customer) throw notFound('That customer');

  // Sales-intent requests attach to the lead; a service request has none, which
  // is why lead_id is nullable (docs/04-spec-review.md §4).
  const leadId =
    request.conversationId && request.type !== 'service'
      ? await upsertLead(db, {
          conversationId: request.conversationId,
          customerId: request.customerId,
        })
      : null;

  const ticketNumber = await allocateTicketNumber(db, { prefix: tenant.ticketPrefix });

  const created = await db
    .insert(tickets)
    .values({
      tenantId: db.tenantId,
      number: ticketNumber,
      type: request.type,
      subject: request.subject,
      body: request.body ?? null,
      customerId: request.customerId,
      leadId,
      createdByType: 'ai',
    })
    .returning({ id: tickets.id });

  const ticketId = created[0]!.id;

  await db.insert(notifications).values({
    tenantId: db.tenantId,
    roleTarget: request.notifyRole ?? 'sales',
    type: `ticket.${request.type}`,
    title: request.subject,
    body: `${customer.fullName ?? 'A customer'} · ${ticketNumber}`,
    linkPath: leadId ? `/portal/leads/${leadId}` : `/portal/tickets`,
  });

  // Consent is checked here, not at send time: no consent, no queued message,
  // and the customer still gets their ticket number on screen (spec §31).
  let emailQueued = false;
  if (request.emailTemplate && customer.email && customer.consent) {
    await db.insert(emailMessages).values({
      tenantId: db.tenantId,
      templateKey: request.emailTemplate,
      toEmail: customer.email,
      toName: customer.fullName,
      subject: `${tenant.brandName} — ${request.subject} (${ticketNumber})`,
      payload: { ticketNumber, ...(request.emailPayload ?? {}) },
      dedupeKey: `ticket:${ticketId}`,
    });
    emailQueued = true;
  }

  if (leadId) {
    await recordLeadEvent(db, leadId, {
      type: 'ticket_created',
      actorType: 'ai',
      summary: `${request.subject} (${ticketNumber}).`,
      payload: { ticketNumber, type: request.type },
    });
  }

  await recordAudit(db, {
    actor: { type: 'ai' },
    action: `ticket.created.${request.type}`,
    entityType: 'ticket',
    entityId: ticketId,
    after: { number: ticketNumber, leadId },
  });

  return { ticketNumber, ticketId, leadId, confirmationEmailQueued: emailQueued };
}

/**
 * Mark a lead for human follow-up (spec §15).
 *
 * The assistant stops trying to close, the right team is told, and the customer
 * is told plainly that someone will follow up. It never implies a person has
 * already replied.
 */
export async function requestHandoff(
  db: TenantDb,
  tenant: { ticketPrefix: string; brandName: string },
  params: {
    customerId: string;
    conversationId: string;
    reason: string;
    notifyRole?: 'sales' | 'service';
  },
): Promise<RequestResult> {
  const result = await createCustomerRequest(db, tenant, {
    type: 'sales_enquiry',
    subject: 'Customer asked to speak to someone',
    body: params.reason,
    customerId: params.customerId,
    conversationId: params.conversationId,
    notifyRole: params.notifyRole ?? 'sales',
  });

  if (result.leadId) {
    await db
      .update(leads)
      .set({ handoffRequestedAt: new Date() })
      .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, result.leadId)));

    // Asking for a person is itself strong evidence of intent, so the lead is
    // rescored now rather than at the next extraction pass.
    await recomputePriority(db, result.leadId);
  }

  return result;
}

export async function createTradeIn(
  db: TenantDb,
  tenant: { ticketPrefix: string; brandName: string },
  params: {
    customerId: string;
    conversationId: string;
    year: number;
    make: string;
    model: string;
    trim?: string;
    mileageKm: number;
    condition: 'excellent' | 'good' | 'fair' | 'poor';
    notes?: string;
  },
): Promise<RequestResult> {
  const result = await createCustomerRequest(db, tenant, {
    type: 'trade_in',
    subject: `Trade-in appraisal — ${params.year} ${params.make} ${params.model}`,
    body: params.notes,
    customerId: params.customerId,
    conversationId: params.conversationId,
    emailTemplate: 'trade_in_received',
  });

  await db.insert(tradeInRequests).values({
    tenantId: db.tenantId,
    customerId: params.customerId,
    leadId: result.leadId,
    ticketId: result.ticketId,
    vehicleYear: params.year,
    vehicleMake: params.make,
    vehicleModel: params.model,
    vehicleTrim: params.trim ?? null,
    mileageKm: params.mileageKm,
    condition: params.condition,
    notes: params.notes ?? null,
    // appraisedValueCents stays null: there is no valuation until a human
    // inspects the car, and the assistant must never imply otherwise (spec §41).
  });

  return result;
}

export async function createFinancingRequest(
  db: TenantDb,
  tenant: { ticketPrefix: string; brandName: string },
  params: {
    customerId: string;
    conversationId: string;
    vehiclePriceCents: number;
    downPaymentCents: number;
    termMonths: number;
    aprBps?: number;
    estimate: Record<string, unknown>;
  },
): Promise<RequestResult> {
  const result = await createCustomerRequest(db, tenant, {
    type: 'financing',
    subject: 'Financing enquiry',
    customerId: params.customerId,
    conversationId: params.conversationId,
    emailTemplate: 'financing_received',
  });

  await db.insert(financeRequests).values({
    tenantId: db.tenantId,
    customerId: params.customerId,
    leadId: result.leadId,
    ticketId: result.ticketId,
    vehiclePriceCents: params.vehiclePriceCents,
    downPaymentCents: params.downPaymentCents,
    termMonths: params.termMonths,
    aprBps: params.aprBps ?? null,
    // An estimate, stored as one. Never an approval (spec §40, §54).
    estimate: params.estimate as never,
  });

  return result;
}

export { allocateTicketNumber } from './numbering';
