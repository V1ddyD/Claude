import { z } from 'zod';
import { defineTool } from '../define';
import { createTestDrive } from '@/server/services/booking';
import { resolveCustomer, applySignals, upsertLead } from '@/server/services/leads';
import { AppError } from '@/server/errors';

/**
 * The only write tool in the walking skeleton.
 *
 * Note the shape of the contract: the model REQUESTS, the service DECIDES.
 * Opening hours, resource conflicts and inventory state are all re-checked
 * inside the booking transaction, so a model that asks for an impossible slot
 * gets a typed refusal rather than an appointment.
 */
export const createTestDriveTool = defineTool({
  name: 'createTestDrive',
  scope: 'write',
  summary:
    'Book a test drive at a time returned by getAvailableTestDriveSlots. Requires the ' +
    'customer\'s name and email, and their agreement to be contacted. Only call this ' +
    'once the customer has confirmed the specific time.',
  input: z.object({
    startsAt: z.string().datetime(),
    modelSlug: z.string().max(40).optional(),
    fullName: z.string().min(1).max(120),
    email: z.string().email(),
    phone: z.string().max(40).optional(),
    /** Must be explicit: the customer has to have agreed to be contacted. */
    contactConsent: z.literal(true),
    notes: z.string().max(500).optional(),
  }),
  // Same conversation, same slot, same person => same booking. A retried tool
  // call returns the first result rather than booking twice (spec §33).
  idempotent: (input) => `${input.startsAt}|${input.email.toLowerCase()}`,
  handler: async (ctx, input) => {
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new AppError('VALIDATION_FAILED', 'That time is not valid.');
    }
    if (startsAt <= ctx.now) {
      throw new AppError('VALIDATION_FAILED', 'That time is in the past.');
    }

    const customerId = await resolveCustomer(ctx.db, {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone ?? null,
      contactConsent: input.contactConsent,
    });
    if (!customerId) throw new AppError('VALIDATION_FAILED', 'Contact details are required.');

    // Identity is evidence too, and it is evidence the system observed rather
    // than inferred, so it is recorded at full confidence.
    const leadId = await upsertLead(ctx.db, {
      conversationId: ctx.conversationId,
      customerId,
    });
    await applySignals(
      ctx.db,
      leadId,
      {
        customerName: { value: input.fullName, confidence: 1 },
        customerEmail: { value: input.email, confidence: 1 },
        ...(input.phone ? { customerPhone: { value: input.phone, confidence: 1 } } : {}),
        ...(input.modelSlug ? { modelSlug: { value: input.modelSlug, confidence: 1 } } : {}),
      },
      { source: 'form' },
    );

    return createTestDrive(ctx.db, ctx.tenant, {
      conversationId: ctx.conversationId,
      customerId,
      startsAt,
      modelSlug: input.modelSlug,
      customerNotes: input.notes,
    });
  },
  project: (result) => ({
    booked: true,
    ticketNumber: result.ticketNumber,
    confirmationCode: result.confirmationCode,
    vehicle: result.vehicle,
    when: result.formattedWhen,
    // Queued, not sent. The assistant must not claim delivery (spec §21, §54).
    confirmationEmail: result.confirmationEmailQueued
      ? 'queued — it will arrive shortly'
      : 'not sent: no email address on file, or contact consent not given',
  }),
});
