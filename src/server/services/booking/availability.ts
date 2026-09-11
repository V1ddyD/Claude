import type { Cents } from '@/server/services/pricing';

/**
 * Slot availability is COMPUTED, never materialised.
 *
 * docs/04-spec-review.md §6: a slots table drifts out of step with opening
 * hours, closures, staff changes and durations, and needs a regeneration job.
 * Deriving it makes desynchronisation impossible.
 *
 * This module is pure — the clock is an argument — so the awkward cases
 * (a closure mid-range, a slot that would run past closing, the minimum-notice
 * boundary) are exhaustively testable.
 */

export interface OpeningHours {
  /** 0 = Sunday. */
  dayOfWeek: number;
  /** 'HH:MM' or 'HH:MM:SS' in the tenant's timezone. */
  opensAt: string;
  closesAt: string;
}

export interface Closure {
  /** 'YYYY-MM-DD', inclusive. */
  startsOn: string;
  endsOn: string;
}

export interface Booking {
  startsAt: Date;
  endsAt: Date;
}

export interface SlotRequest {
  from: Date;
  to: Date;
  now: Date;
  timezone: string;
  slotMinutes: number;
  minNoticeHours: number;
  maxHorizonDays: number;
  hours: OpeningHours[];
  closures: Closure[];
  /** Existing bookings for the resource being offered. */
  bookings: Booking[];
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

const MINUTE = 60_000;

/** Calendar parts of an instant in a named timezone, avoiding UTC drift. */
function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dayOfWeek: weekdays[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/**
 * The instant at which a given wall-clock time occurs on a given date in a
 * timezone. Derived by probing rather than assuming a fixed offset, so it stays
 * correct across daylight saving transitions.
 */
function zonedInstant(dateIso: string, minutesFromMidnight: number, timezone: string): Date {
  const [y, m, d] = dateIso.split('-').map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, Math.floor(minutesFromMidnight / 60), minutesFromMidnight % 60);

  // First guess assumes UTC, then correct by the zone's offset at that instant.
  let guess = new Date(naive);
  for (let i = 0; i < 2; i++) {
    const parts = zonedParts(guess, timezone);
    const actual = parts.minutes;
    const wantedDayDelta =
      (Date.parse(`${dateIso}T00:00:00Z`) - Date.parse(`${parts.date}T00:00:00Z`)) / 86_400_000;
    const driftMinutes = (minutesFromMidnight - actual) + wantedDayDelta * 1440;
    if (driftMinutes === 0) break;
    guess = new Date(guess.getTime() + driftMinutes * MINUTE);
  }
  return guess;
}

function parseTime(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function isClosed(dateIso: string, closures: Closure[]): boolean {
  return closures.some((c) => dateIso >= c.startsOn && dateIso <= c.endsOn);
}

export function computeAvailableSlots(request: SlotRequest): Slot[] {
  const {
    from, to, now, timezone, slotMinutes, minNoticeHours, maxHorizonDays,
    hours, closures, bookings,
  } = request;

  const earliest = new Date(now.getTime() + minNoticeHours * 60 * MINUTE);
  const latest = new Date(now.getTime() + maxHorizonDays * 24 * 60 * MINUTE);

  const windowStart = from > earliest ? from : earliest;
  const windowEnd = to < latest ? to : latest;
  if (windowStart >= windowEnd) return [];

  const hoursByDay = new Map(hours.map((h) => [h.dayOfWeek, h]));
  const slots: Slot[] = [];

  // Walk calendar days in the tenant's timezone rather than in UTC: a day
  // boundary in Toronto is not a day boundary in UTC, and iterating the wrong
  // one silently drops or duplicates a day's slots.
  let cursor = new Date(windowStart);
  const seenDates = new Set<string>();

  while (cursor <= windowEnd) {
    const { date, dayOfWeek } = zonedParts(cursor, timezone);

    if (!seenDates.has(date)) {
      seenDates.add(date);
      const dayHours = hoursByDay.get(dayOfWeek);

      if (dayHours && !isClosed(date, closures)) {
        const opens = parseTime(dayHours.opensAt);
        const closes = parseTime(dayHours.closesAt);

        for (let start = opens; start + slotMinutes <= closes; start += slotMinutes) {
          const startsAt = zonedInstant(date, start, timezone);
          const endsAt = new Date(startsAt.getTime() + slotMinutes * MINUTE);

          if (startsAt < windowStart || startsAt > windowEnd) continue;
          // Half-open overlap: a slot starting exactly when another ends is free.
          const taken = bookings.some((b) => startsAt < b.endsAt && endsAt > b.startsAt);
          if (!taken) slots.push({ startsAt, endsAt });
        }
      }
    }

    cursor = new Date(cursor.getTime() + 6 * 60 * MINUTE);
  }

  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Slot offers always carry an absolute local date (docs/04-spec-review.md §5). */
export function formatSlot(slot: Slot, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(slot.startsAt);
}

export type { Cents };
