/**
 * Query types, checked against `information_schema` by `tests/schema`.
 *
 * The SQL in `db/migrations/` remains the source of truth; these definitions
 * exist to type queries, and a definition is added when something first reads
 * the table so the parity test can verify it for real.
 */
export * from './tenancy';
export * from './identity';
export * from './catalogue';
export * from './inventory';
export * from './conversations';
export * from './channels';
export * from './leads';
export * from './appointments';
export * from './tickets';
export * from './comms';
export * from './limits';
export * from './ops';
