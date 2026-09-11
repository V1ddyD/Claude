/**
 * Query types for the tables built so far. Lead, conversation, appointment and
 * ticket tables exist in `db/migrations/0001_initial_schema.sql` and gain
 * definitions in M3 and M4, as each is first queried.
 *
 * Defining them ahead of use would be unverified surface: `tests/schema` can
 * only check a definition against the real database once something reads it.
 */
export * from './tenancy';
export * from './identity';
export * from './catalogue';
export * from './inventory';
export * from './ops';
