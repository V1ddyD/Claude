import { describe, it, expect } from 'vitest';
import { computeAvailableSlots, formatSlot } from '../../src/server/services/booking/availability';
import type { SlotRequest } from '../../src/server/services/booking/availability';

/**
 * Slot computation, with the clock as an argument.
 *
 * These are the cases a materialised slot table gets wrong quietly: a closure
 * mid-range, a slot that would run past closing, the minimum-notice boundary,
 * and the day the clocks change.
 */

const TZ = 'America/Toronto';

// Mon-Fri 09:00-19:00, Sat 10:00-17:00, closed Sunday.
const HOURS = [
  ...[1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt: '09:00', closesAt: '19:00' })),
  { dayOfWeek: 6, opensAt: '10:00', closesAt: '17:00' },
];

function request(overrides: Partial<SlotRequest> = {}): SlotRequest {
  return {
    // Thursday 17 September 2026, 08:00 Toronto time.
    now: new Date('2026-09-17T12:00:00Z'),
    from: new Date('2026-09-18T00:00:00Z'),
    to: new Date('2026-09-20T00:00:00Z'),
    timezone: TZ,
    slotMinutes: 60,
    minNoticeHours: 2,
    maxHorizonDays: 14,
    hours: HOURS,
    closures: [],
    bookings: [],
    ...overrides,
  };
}

function localTimes(slots: { startsAt: Date }[]): string[] {
  return slots.map((s) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(s.startsAt),
  );
}

describe('opening hours', () => {
  it('offers slots only while the dealership is open', () => {
    const slots = computeAvailableSlots(request());
    const times = localTimes(slots);
    expect(times.every((t) => !t.includes('Sun'))).toBe(true);
    // Friday runs 09:00-19:00, so ten one-hour slots, first at 09:00.
    expect(times.filter((t) => t.startsWith('Fri'))).toHaveLength(10);
    expect(times.filter((t) => t.startsWith('Fri'))[0]).toContain('09:00');
  });

  it('never offers a slot that would run past closing', () => {
    // Saturday is 10:00-17:00. On a 90-minute grid that is 10:00, 11:30, 13:00
    // and 14:30; 16:00 would end at 17:30, after closing, so it is not offered.
    const slots = computeAvailableSlots(
      request({
        from: new Date('2026-09-19T00:00:00Z'),
        to: new Date('2026-09-20T00:00:00Z'),
        slotMinutes: 90,
      }),
    );
    const saturday = localTimes(slots).filter((t) => t.startsWith('Sat'));
    expect(saturday).toHaveLength(4);
    expect(saturday.at(-1)).toContain('14:30');
    // Every offered slot ends by closing time.
    const lastSlot = slots.at(-1)!;
    expect(lastSlot.endsAt.getTime() - lastSlot.startsAt.getTime()).toBe(90 * 60_000);
  });

  it('skips days the dealership is closed', () => {
    const slots = computeAvailableSlots(
      request({ closures: [{ startsOn: '2026-09-18', endsOn: '2026-09-18' }] }),
    );
    expect(localTimes(slots).some((t) => t.startsWith('Fri'))).toBe(false);
    expect(localTimes(slots).some((t) => t.startsWith('Sat'))).toBe(true);
  });
});

describe('notice and horizon', () => {
  it('honours minimum notice', () => {
    // Friday 08:00 Toronto, four hours' notice: nothing before 12:00.
    const slots = computeAvailableSlots(
      request({
        now: new Date('2026-09-18T12:00:00Z'),
        from: new Date('2026-09-18T00:00:00Z'),
        to: new Date('2026-09-19T00:00:00Z'),
        minNoticeHours: 4,
      }),
    );
    const times = localTimes(slots);
    expect(times[0]).toContain('12:00');
  });

  it('refuses to look beyond the booking horizon', () => {
    const slots = computeAvailableSlots(
      request({ to: new Date('2026-12-01T00:00:00Z'), maxHorizonDays: 2 }),
    );
    const last = slots.at(-1)!.startsAt;
    expect(last.getTime()).toBeLessThanOrEqual(
      new Date('2026-09-17T12:00:00Z').getTime() + 2 * 86_400_000,
    );
  });

  it('returns nothing when the window is entirely in the past', () => {
    const slots = computeAvailableSlots(
      request({ from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') }),
    );
    expect(slots).toEqual([]);
  });
});

describe('existing bookings', () => {
  it('removes a taken slot', () => {
    const base = computeAvailableSlots(request());
    const target = base.find((s) => localTimes([s])[0]!.includes('11:00'))!;

    const after = computeAvailableSlots(
      request({ bookings: [{ startsAt: target.startsAt, endsAt: target.endsAt }] }),
    );
    expect(after).toHaveLength(base.length - 1);
    expect(after.some((s) => s.startsAt.getTime() === target.startsAt.getTime())).toBe(false);
  });

  it('keeps a slot that starts exactly when a booking ends', () => {
    const base = computeAvailableSlots(request());
    const first = base[0]!;
    const after = computeAvailableSlots(
      request({
        bookings: [{
          startsAt: new Date(first.startsAt.getTime() - 60 * 60_000),
          endsAt: first.startsAt,
        }],
      }),
    );
    // Half-open ranges: back-to-back appointments are legal, and treating them
    // as a clash would silently halve a dealership's capacity.
    expect(after.some((s) => s.startsAt.getTime() === first.startsAt.getTime())).toBe(true);
  });

  it('removes a slot a longer booking only partially covers', () => {
    const base = computeAvailableSlots(request());
    const target = base[2]!;
    const after = computeAvailableSlots(
      request({
        bookings: [{
          startsAt: new Date(target.startsAt.getTime() - 30 * 60_000),
          endsAt: new Date(target.startsAt.getTime() + 30 * 60_000),
        }],
      }),
    );
    expect(after.some((s) => s.startsAt.getTime() === target.startsAt.getTime())).toBe(false);
  });
});

describe('timezone correctness', () => {
  it('opens at 09:00 local across a daylight-saving change', () => {
    // Canadian DST ends Sunday 1 November 2026. Monday 2 November still opens
    // at 09:00 local, which is a different UTC instant from the week before.
    const before = computeAvailableSlots(
      request({
        now: new Date('2026-10-26T00:00:00Z'),
        from: new Date('2026-10-26T00:00:00Z'),
        to: new Date('2026-10-27T00:00:00Z'),
      }),
    );
    const after = computeAvailableSlots(
      request({
        now: new Date('2026-11-02T00:00:00Z'),
        from: new Date('2026-11-02T00:00:00Z'),
        to: new Date('2026-11-03T00:00:00Z'),
      }),
    );

    expect(localTimes(before)[0]).toContain('09:00');
    expect(localTimes(after)[0]).toContain('09:00');
    // Same wall clock, different UTC offset — which is the whole point.
    expect(before[0]!.startsAt.getUTCHours()).not.toBe(after[0]!.startsAt.getUTCHours());
  });

  it('formats an offer with an absolute date and zone, never a bare weekday', () => {
    const slots = computeAvailableSlots(request());
    const text = formatSlot(slots[0]!, TZ, 'en-CA');
    expect(text).toMatch(/Friday/);
    expect(text).toMatch(/September/);
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/E[DS]T/);
  });
});
