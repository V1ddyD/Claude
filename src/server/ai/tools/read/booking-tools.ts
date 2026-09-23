import { z } from 'zod';
import { defineTool } from '../define';
import { getAvailableTestDriveSlots, formatSlot } from '@/server/services/booking';
import { AppError } from '@/server/errors';

/**
 * A sample of the diary that covers the range asked for.
 *
 * The first twelve slots of a fortnight are one day and a half, so "this
 * weekend" was never in them and a customer who works Wednesdays was offered
 * nothing but Wednesdays. The cap is now per day, sized so a short range shows
 * most of its times and a long one still reaches its last week.
 */
function spreadAcrossDays<T extends { startsAt: Date }>(slots: T[], timezone: string): T[] {
  const dayOf = (slot: T) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(slot.startsAt);
  const days = new Set(slots.map(dayOf)).size || 1;
  const perDay = Math.max(3, Math.ceil(15 / days));

  const counts = new Map<string, number>();
  const picked: T[] = [];
  for (const slot of slots) {
    const day = dayOf(slot);
    const used = counts.get(day) ?? 0;
    if (used >= perDay) continue;
    counts.set(day, used + 1);
    picked.push(slot);
    if (picked.length === 15) break;
  }
  return picked;
}

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
    return spreadAcrossDays(slots, ctx.tenant.timezone);
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
