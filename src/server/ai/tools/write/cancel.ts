import { z } from 'zod';
import { defineTool } from '../define';
import { cancelTestDrive } from '@/server/services/booking';
import { formatSlot } from '@/server/services/booking/availability';

/**
 * Cancelling a booking.
 *
 * Without this a customer who cannot make it has to telephone — and the car
 * and the specialist stay blocked until someone notices. The dealership loses
 * the slot and the customer feels the friction.
 *
 * Two factors: the confirmation code AND the email it was booked with. A
 * six-character code on its own would let anyone cancel a stranger's
 * appointment by guessing.
 */
export const cancelTestDriveTool = defineTool({
  name: 'cancelTestDrive',
  scope: 'write',
  summary:
    'Cancel a booked test drive. Needs the confirmation code from their booking AND the ' +
    'email address it was made with. Ask for both — never cancel on the code alone.',
  input: z.object({
    confirmationCode: z.string().min(4).max(12),
    email: z.string().email(),
    reason: z.string().max(300).optional(),
  }),
  idempotent: (input) => `cancel|${input.confirmationCode.toUpperCase()}`,
  handler: async (ctx, input) => {
    const result = await cancelTestDrive(ctx.db, input);
    return {
      ...result,
      formatted: formatSlot(
        { startsAt: result.wasAt, endsAt: result.wasAt },
        ctx.tenant.timezone,
        ctx.tenant.locale,
      ),
    };
  },
  project: (result) => ({
    cancelled: true,
    was: result.formatted,
    note: 'The slot is free again. Offer to rebook if they would like another time.',
  }),
});
