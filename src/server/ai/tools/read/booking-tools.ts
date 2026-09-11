import { z } from 'zod';
import { defineTool } from '../define';
import { getAvailableTestDriveSlots, formatSlot } from '@/server/services/booking';
import { AppError } from '@/server/errors';

export const getAvailableTestDriveSlots_tool = defineTool({
  name: 'getAvailableTestDriveSlots',
  scope: 'read',
  summary:
    'Bookable test drive times. Offers only times when both a specialist and a ' +
    'demonstrator are free. Always call this before proposing a time — never guess ' +
    'one from opening hours. Pass the same modelSlug you will book: availability is ' +
    'per model, and times free for one car are not necessarily free for another.',
  input: z.object({
    modelSlug: z.string().max(40).optional(),
    /** Inclusive, YYYY-MM-DD in the dealership's local time. */
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  handler: async (ctx, input) => {
    const from = new Date(`${input.fromDate}T00:00:00Z`);
    const to = new Date(`${input.toDate}T23:59:59Z`);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
      throw new AppError('VALIDATION_FAILED', 'That date range is not valid.');
    }
    // A 14-day horizon is a tenant setting; a wider request is narrowed rather
    // than refused, so the customer still gets an answer.
    const capped = new Date(Math.min(to.getTime(), from.getTime() + 21 * 864e5));

    const slots = await getAvailableTestDriveSlots(ctx.db, ctx.tenant, {
      from, to: capped, now: ctx.now, modelSlug: input.modelSlug,
    });
    return slots.slice(0, 12);
  },
  project: (slots, ctx) => ({
    count: slots.length,
    // ISO for the booking call, formatted for quoting to the customer. Always
    // an absolute local date with a zone, never a bare weekday.
    slots: slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      label: formatSlot(s, ctx.tenant.timezone, ctx.tenant.locale),
    })),
    note: slots.length === 0 ? 'No times are available in that range.' : undefined,
  }),
});
