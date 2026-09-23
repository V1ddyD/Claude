import { z } from 'zod';
import { defineTool } from '../define';
import { applySignals, identifyConversationCustomer } from '@/server/services/leads';
import { canDeliverEmail } from '@/server/services/email/provider';
import {
  createCustomerRequest, createTradeIn, createFinancingRequest, requestHandoff,
} from '@/server/services/tickets';
import { calculateFinanceEstimate } from '@/server/services/finance';
import { AppError } from '@/server/errors';
import type { ToolContext } from '../define';

/**
 * Request tools.
 *
 * Each is the same shape: identify the customer, record what we learned as
 * evidence, create the request through the shared service, and hand back a
 * ticket number. None of them promises an outcome — a trade-in request is not a
 * valuation, and a financing request is not an approval (spec §40, §41, §54).
 */

/** Contact details are required for every request: a request nobody can answer is noise. */
const contactFields = {
  fullName: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  contactConsent: z.literal(true),
};

async function identify(
  ctx: ToolContext,
  input: { fullName: string; email: string; phone?: string; contactConsent: true },
): Promise<{ customerId: string; leadId: string }> {
  const identified = await identifyConversationCustomer(ctx.db, ctx.conversationId, {
    fullName: input.fullName,
    email: input.email,
    phone: input.phone ?? null,
    contactConsent: input.contactConsent,
  });
  if (!identified) throw new AppError('VALIDATION_FAILED', 'Contact details are required.');
  const { customerId, leadId } = identified;

  // Identity the system observed, not inferred: full confidence, source 'form'.
  await applySignals(
    ctx.db,
    leadId,
    {
      customerName: { value: input.fullName, confidence: 1 },
      customerEmail: { value: input.email, confidence: 1 },
      ...(input.phone ? { customerPhone: { value: input.phone, confidence: 1 } } : {}),
    },
    { source: 'form' },
  );

  return { customerId, leadId };
}

export const createCallbackRequest = defineTool({
  name: 'createCallbackRequest',
  scope: 'write',
  summary:
    'Ask the team to call the customer back. Use when they want to speak to someone but ' +
    'do not want to book a visit.',
  input: z.object({
    ...contactFields,
    phone: z.string().min(5).max(40),
    reason: z.string().max(500).optional(),
    preferredTime: z.string().max(120).optional(),
  }),
  idempotent: (input) => `callback|${input.email.toLowerCase()}`,
  handler: async (ctx, input) => {
    const { customerId, leadId } = await identify(ctx, input);
    await applySignals(
      ctx.db,
      leadId,
      { wantsSalesperson: { value: true, confidence: 1 } },
      { source: 'form' },
    );

    return createCustomerRequest(ctx.db, ctx.tenant, {
      type: 'callback',
      subject: 'Callback requested',
      body: [input.reason, input.preferredTime && `Prefers: ${input.preferredTime}`]
        .filter(Boolean)
        .join('\n'),
      customerId,
      conversationId: ctx.conversationId,
      emailTemplate: 'callback_received',
    });
  },
  project: (result) => ({
    created: true,
    ticketNumber: result.ticketNumber,
    confirmationEmail: result.confirmationEmailQueued && canDeliverEmail() ? 'queued' : 'not sent',
    nextStep: 'A specialist will call. Do not say when unless the dealership has told you.',
  }),
});

export const createSupportTicket = defineTool({
  name: 'createSupportTicket',
  scope: 'write',
  summary:
    'Record a question or request the team needs to answer. Use when you cannot answer ' +
    'something from a tool and the customer wants a reply.',
  input: z.object({
    ...contactFields,
    type: z.enum(['sales_enquiry', 'general', 'support', 'service']),
    subject: z.string().min(3).max(140),
    details: z.string().min(1).max(1500),
  }),
  idempotent: (input) => `ticket|${input.email.toLowerCase()}|${input.subject}`,
  handler: async (ctx, input) => {
    const { customerId } = await identify(ctx, input);
    return createCustomerRequest(ctx.db, ctx.tenant, {
      type: input.type,
      subject: input.subject,
      body: input.details,
      customerId,
      conversationId: ctx.conversationId,
      // Service work goes to the service team, never into the sales queue.
      notifyRole: input.type === 'service' ? 'service' : 'sales',
      emailTemplate: 'enquiry_received',
    });
  },
  project: (result) => ({
    created: true,
    ticketNumber: result.ticketNumber,
    confirmationEmail: result.confirmationEmailQueued && canDeliverEmail() ? 'queued' : 'not sent',
  }),
});

export const createTradeInRequest = defineTool({
  name: 'createTradeInRequest',
  scope: 'write',
  summary:
    'Record a vehicle the customer wants to trade in. This books an appraisal — it does ' +
    'NOT produce a value. Never estimate what their car is worth: a value requires an ' +
    'inspection by a specialist.',
  input: z.object({
    ...contactFields,
    year: z.number().int().min(1950).max(2030),
    make: z.string().min(1).max(60),
    model: z.string().min(1).max(60),
    trim: z.string().max(60).optional(),
    mileageKm: z.number().int().min(0).max(1_000_000),
    condition: z.enum(['excellent', 'good', 'fair', 'poor']),
    notes: z.string().max(500).optional(),
  }),
  idempotent: (input) => `tradein|${input.email.toLowerCase()}|${input.year}${input.make}${input.model}`,
  handler: async (ctx, input) => {
    const { customerId, leadId } = await identify(ctx, input);
    await applySignals(
      ctx.db,
      leadId,
      { tradeInInterest: { value: true, confidence: 1 } },
      { source: 'form' },
    );

    return createTradeIn(ctx.db, ctx.tenant, {
      customerId,
      conversationId: ctx.conversationId,
      year: input.year,
      make: input.make,
      model: input.model,
      trim: input.trim,
      mileageKm: input.mileageKm,
      condition: input.condition,
      notes: input.notes,
    });
  },
  project: (result) => ({
    created: true,
    ticketNumber: result.ticketNumber,
    confirmationEmail: result.confirmationEmailQueued && canDeliverEmail() ? 'queued' : 'not sent',
    // Stated here so the model has no room to imply a figure is coming by email.
    valuation: 'none — a trade-in value requires an in-person inspection',
  }),
});

export const createFinancingRequestTool = defineTool({
  name: 'createFinancingRequest',
  scope: 'write',
  summary:
    'Pass a financing enquiry to the team, with the estimate you showed the customer. ' +
    'This is NOT an application and NOT an approval — say a specialist will confirm terms.',
  input: z.object({
    ...contactFields,
    vehiclePriceCents: z.number().int().positive(),
    downPaymentCents: z.number().int().min(0).default(0),
    termMonths: z.number().int().min(12).max(96),
    aprBps: z.number().int().min(0).max(3000).optional(),
  }),
  idempotent: (input) => `finance|${input.email.toLowerCase()}|${input.vehiclePriceCents}`,
  handler: async (ctx, input) => {
    const { customerId, leadId } = await identify(ctx, input);
    await applySignals(
      ctx.db,
      leadId,
      { financeInterest: { value: true, confidence: 1 } },
      { source: 'form' },
    );

    // Recomputed here rather than trusting a figure passed in: the record must
    // match what the maths actually produces.
    const estimate = calculateFinanceEstimate(
      { ...input, aprBps: input.aprBps ?? 649 },
      { currency: ctx.tenant.currency, locale: ctx.tenant.locale },
    );

    return createFinancingRequest(ctx.db, ctx.tenant, {
      customerId,
      conversationId: ctx.conversationId,
      vehiclePriceCents: input.vehiclePriceCents,
      downPaymentCents: input.downPaymentCents,
      termMonths: input.termMonths,
      aprBps: input.aprBps,
      estimate: { ...estimate.formatted, termMonths: estimate.termMonths },
    });
  },
  project: (result) => ({
    created: true,
    ticketNumber: result.ticketNumber,
    confirmationEmail: result.confirmationEmailQueued && canDeliverEmail() ? 'queued' : 'not sent',
    approval: 'none — a specialist reviews financing and confirms terms',
  }),
});

export const requestHumanHandoff = defineTool({
  name: 'requestHumanHandoff',
  scope: 'write',
  summary:
    'Hand the conversation to a person. Use when the customer asks for one, wants to ' +
    'negotiate, has a complaint, or you cannot answer something twice. Tell them a ' +
    'specialist will follow up — never imply one has already replied.',
  input: z.object({
    ...contactFields,
    reason: z.string().min(1).max(500),
    department: z.enum(['sales', 'service']).default('sales'),
  }),
  idempotent: (input) => `handoff|${input.email.toLowerCase()}`,
  handler: async (ctx, input) => {
    const { customerId, leadId } = await identify(ctx, input);
    await applySignals(
      ctx.db,
      leadId,
      { wantsSalesperson: { value: true, confidence: 1 } },
      { source: 'form' },
    );

    return requestHandoff(ctx.db, ctx.tenant, {
      customerId,
      conversationId: ctx.conversationId,
      reason: input.reason,
      notifyRole: input.department,
    });
  },
  project: (result) => ({
    handedOff: true,
    ticketNumber: result.ticketNumber,
    nextStep: 'A specialist has been notified and will follow up. They have NOT replied yet.',
  }),
});
