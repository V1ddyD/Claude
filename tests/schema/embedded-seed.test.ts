import { describe, it, expect } from 'vitest';
import { DEMONSTRATION_SEED_SQL, SEED_ROW_COUNT } from '../../src/server/db/seed.generated';

/**
 * The demonstration dealership, as one SQL script.
 *
 * The hosted demo's database is in a different region from the functions that
 * reach it, and the seeding code issues several hundred small statements — at a
 * fifth of a second each that is minutes, and a serverless function is killed
 * after thirty seconds. The first attempt wrote one model of ten before dying,
 * which left a half-built dealership: pages half rendered and the assistant
 * offered cars it could not price.
 *
 * As one statement it is a single round trip, 225ms from empty.
 *
 * These assertions guard the two properties that make it applicable at all —
 * it has to be executable by a driver, and its rows have to arrive in an order
 * their foreign keys permit — plus the completeness that makes it worth
 * applying.
 */

describe('the embedded seed', () => {
  it('carries a whole dealership', () => {
    expect(SEED_ROW_COUNT).toBeGreaterThan(700);

    for (const table of [
      'tenants', 'tenant_settings', 'tenant_domains', 'staff_users', 'business_hours',
      'vehicle_models', 'powertrains', 'trims', 'model_configurations', 'colours',
      'options', 'option_availability', 'inventory_units', 'resources',
      'lead_scoring_rules', 'follow_up_rules', 'vehicle_features',
    ]) {
      expect.soft(DEMONSTRATION_SEED_SQL, table).toContain(`INSERT INTO public.${table} `);
    }
  });

  it('has the whole catalogue, not part of one', () => {
    const models = (DEMONSTRATION_SEED_SQL.match(/^INSERT INTO public\.vehicle_models /gm) ?? []).length;
    const units = (DEMONSTRATION_SEED_SQL.match(/^INSERT INTO public\.inventory_units /gm) ?? []).length;

    expect(models).toBe(10);
    expect(units).toBeGreaterThan(80);
  });

  it('contains no psql meta-commands, which a driver cannot execute', () => {
    // pg_dump emits \restrict and friends. Applied through postgres.js, a
    // backslash command is a syntax error and the whole seed fails.
    expect(DEMONSTRATION_SEED_SQL).not.toMatch(/^\\/m);
  });

  it('inserts rows only after the rows they reference', () => {
    const order = [...DEMONSTRATION_SEED_SQL.matchAll(/^-- ([a-z_]+)$/gm)].map((m) => m[1]!);

    // pg_dump orders tables alphabetically, which puts colours before the
    // models they belong to. Dependency order is what makes this applicable
    // without the elevated privileges that disabling triggers needs.
    expect(order.indexOf('tenants')).toBe(0);
    expect(order.indexOf('vehicle_models')).toBeLessThan(order.indexOf('colours'));
    expect(order.indexOf('vehicle_models')).toBeLessThan(order.indexOf('powertrains'));
    expect(order.indexOf('model_configurations')).toBeLessThan(order.indexOf('inventory_units'));
  });

  it('leaves out what the schema migrations already populate', () => {
    // Re-inserting the permission matrix would fail on its primary key.
    expect(DEMONSTRATION_SEED_SQL).not.toContain('INSERT INTO public.role_permissions ');
    expect(DEMONSTRATION_SEED_SQL).not.toContain('INSERT INTO public.inventory_transitions ');
  });

  it('leaves out anything a visitor did', () => {
    for (const table of [
      'conversations', 'messages', 'leads', 'lead_signals', 'customers',
      'appointments', 'tickets', 'audit_logs', 'job_queue', 'email_messages',
    ]) {
      expect.soft(DEMONSTRATION_SEED_SQL, table).not.toContain(`INSERT INTO public.${table} `);
    }
  });
});
