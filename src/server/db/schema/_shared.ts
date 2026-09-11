import { customType } from 'drizzle-orm/pg-core';

/**
 * The SQL in `db/migrations/` is the single source of truth for the schema.
 * These Drizzle definitions exist to give queries types — they are not used to
 * generate DDL, and `drizzle-kit generate` is deliberately not part of the
 * migration path. A mismatch between the two is caught by `tests/schema`, which
 * compares these definitions against `information_schema` on a real database.
 */

/** Postgres `citext` — case-insensitive text, used for email columns. */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/** Money is always integer minor units. A bare `price` is a review flag. */
export const centsToNumber = (value: string | number | null): number | null =>
  value === null ? null : typeof value === 'number' ? value : Number(value);
