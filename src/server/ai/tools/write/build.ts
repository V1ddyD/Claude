import { z } from 'zod';
import { defineTool } from '../define';
import { savedBuilds } from '@/server/db/schema';
import * as catalogue from '@/server/db/repositories/catalogue';
import { priceBuild } from '@/server/services/pricing';
import { applySignals, upsertLead, identifyConversationCustomer } from '@/server/services/leads';
import { notFound } from '@/server/errors';

/**
 * Save the configuration a customer arrived at.
 *
 * The price is stored as a SNAPSHOT: when the dealership raises prices, the
 * build the customer was quoted must still show what they were told
 * (docs/01-data-model.md §4).
 */
export const saveBuild = defineTool({
  name: 'saveBuild',
  scope: 'write',
  summary:
    'Save the configuration the customer has settled on, so the team sees exactly what ' +
    'they chose. Use after pricing a build they are happy with.',
  input: z.object({
    modelSlug: z.string().min(1).max(40),
    powertrainCode: z.string().min(1).max(40),
    trimCode: z.string().min(1).max(40),
    exteriorColourCode: z.string().max(40).optional(),
    interiorColourCode: z.string().max(40).optional(),
    optionCodes: z.array(z.string().max(40)).max(20).optional(),
  }),
  idempotent: (input) =>
    `build|${input.modelSlug}|${input.powertrainCode}|${input.trimCode}|` +
    `${input.exteriorColourCode ?? ''}|${[...(input.optionCodes ?? [])].sort().join(',')}`,
  handler: async (ctx, input) => {
    const context = await catalogue.getBuildContext(ctx.db, input, {
      currency: ctx.tenant.currency,
      locale: ctx.tenant.locale,
    });
    if (!context) throw notFound('That combination');

    // Priced through the same engine the configurator uses, so a saved build
    // can never carry a figure the website would not show.
    const breakdown = priceBuild(context, input);

    await ctx.db.insert(savedBuilds).values({
      tenantId: ctx.tenantId,
      visitorId: ctx.visitorId,
      customerId: ctx.customerId ?? null,
      modelConfigurationId: context.configuration.id,
      optionIds: [],
      priceBreakdown: breakdown as never,
      totalPriceCents: breakdown.totalCents,
    });

    // The chosen configuration is evidence of intent, and the scorer weights a
    // complete configuration heavily.
    const leadId = ctx.customerId
      ? await upsertLead(ctx.db, {
          conversationId: ctx.conversationId,
          customerId: ctx.customerId,
        })
      : null;

    if (leadId) {
      await applySignals(
        ctx.db,
        leadId,
        {
          modelSlug: { value: input.modelSlug, confidence: 1 },
          trimCode: { value: input.trimCode, confidence: 1 },
          powertrainCode: { value: input.powertrainCode, confidence: 1 },
          ...(input.exteriorColourCode
            ? { exteriorColourCode: { value: input.exteriorColourCode, confidence: 1 } }
            : {}),
        },
        { source: 'form' },
      );
    }

    return breakdown;
  },
  project: (breakdown) => ({
    saved: true,
    summary: breakdown.summary,
    total: breakdown.totalFormatted,
  }),
});

/**
 * Record who the customer is and how they want to be contacted.
 *
 * This is how a conversation becomes a lead without the customer having to book
 * anything — the most common path from "just asking" to "worth a call".
 */
export const updateContactPreferences = defineTool({
  name: 'updateContactPreferences',
  scope: 'write',
  summary:
    'Record the customer\'s name, contact details and how they prefer to be reached, ' +
    'once they have offered them. Only call this if they have agreed to be contacted.',
  input: z.object({
    fullName: z.string().min(1).max(120),
    email: z.string().email(),
    phone: z.string().max(40).optional(),
    preferredContact: z.enum(['email', 'phone', 'sms', 'any']).optional(),
    contactConsent: z.literal(true),
  }),
  idempotent: (input) => `contact|${input.email.toLowerCase()}`,
  handler: async (ctx, input) => {
    const identified = await identifyConversationCustomer(ctx.db, ctx.conversationId, {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone ?? null,
      contactConsent: input.contactConsent,
    });
    if (!identified) throw notFound('That customer');
    const { leadId } = identified;

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

    return { recorded: true };
  },
  project: () => ({
    recorded: true,
    note: 'The team can now follow up. Do not repeat their details back to them.',
  }),
});
