/**
 * How long a lead has been waiting, in the words someone would use.
 *
 * A salesperson deciding who to call next needs the age of a lead more than its
 * timestamp: "14 Sept, 09:12" requires arithmetic, "3 hours ago" does not. The
 * exact time is on the lead itself, where it matters.
 *
 * Rendered on the server, so it is the dealership's clock rather than a
 * visitor's, and it does not tick — the page is re-rendered on every request.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(when: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - when.getTime();

  // A clock that is slightly behind the database should not produce "in 4
  // seconds" on a lead that was just created.
  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 30 * DAY) return plural(Math.floor(elapsed / DAY), 'day');

  return new Intl.DateTimeFormat('en-CA', { day: 'numeric', month: 'short' }).format(when);
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
