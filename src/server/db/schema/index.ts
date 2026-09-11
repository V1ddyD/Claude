/**
 * Query types for the tables M1 touches. The catalogue, lead, conversation,
 * appointment and ticket tables exist in `db/migrations/0001_initial_schema.sql`
 * and gain Drizzle definitions in M2 and M3, as each is first queried.
 *
 * Defining them ahead of use would be unverified surface: `tests/schema` can
 * only check a definition against the real database once something reads it.
 */
export * from './tenancy';
export * from './identity';
export * from './ops';
