import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The migration set Netlify applies on deploy.
 *
 * The hosted demonstration has no connection string reachable from outside, so
 * it provisions its own database: Netlify applies the SQL in
 * `netlify/database/migrations/` immediately before publishing a deploy.
 *
 * That means a second copy of the schema exists, and a second copy of a schema
 * is a liability. `db/migrations/` remains the single source of truth and the
 * copies are generated from it; these assertions are what stop the two drifting
 * apart quietly, which would show up as a deployed site whose database is a
 * migration behind its code.
 */

const SOURCE = 'db/migrations';
const TARGET = 'netlify/database/migrations';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

const manifest = JSON.parse(readFileSync(join(TARGET, 'manifest.json'), 'utf8')) as
  Record<string, string>;

describe('every schema migration', () => {
  const sources = readdirSync(SOURCE).filter((f) => f.endsWith('.sql')).sort();

  it('is carried over, with none missing', () => {
    const copied = readdirSync(TARGET, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    // The schema migrations plus exactly one seed.
    expect(copied.length).toBe(sources.length + 1);
    expect(copied.filter((name) => name.startsWith('0100_'))).toHaveLength(1);
  });

  it.each(sources)('%s is byte-identical to its copy', (file) => {
    const number = /^(\d+)_/.exec(file)![1]!;
    const slug = file.replace(/\.sql$/, '').replace(/^\d+_/, '').replace(/_/g, '-');
    const copy = join(TARGET, `${number}_${slug}`, 'migration.sql');

    expect(existsSync(copy), `${copy} is missing — run \`npm run netlify:migrations\``).toBe(true);

    const original = readFileSync(join(SOURCE, file), 'utf8');
    expect(readFileSync(copy, 'utf8')).toBe(original);
    // And the manifest agrees, so a hand-edited pair cannot pass unnoticed.
    expect(manifest[file]).toBe(digest(original));
  });
});

describe('the seed migration', () => {
  const seed = readFileSync(
    join(TARGET, '0100_seed-demonstration-dealership', 'migration.sql'),
    'utf8',
  );

  it('carries a whole dealership', () => {
    // Enough to be the demonstration rather than an empty shell.
    expect((seed.match(/^INSERT INTO/gm) ?? []).length).toBeGreaterThan(500);
    for (const table of [
      'tenants', 'tenant_settings', 'tenant_domains', 'staff_users', 'business_hours',
      'vehicle_models', 'powertrains', 'trims', 'model_configurations', 'colours',
      'options', 'inventory_units', 'resources',
    ]) {
      expect.soft(seed, table).toContain(`INSERT INTO public.${table} `);
    }
  });

  it('contains no psql meta-commands, which the migration runner cannot execute', () => {
    // pg_dump emits \restrict and friends; Netlify applies SQL through a
    // driver, where a backslash command is a syntax error.
    expect(seed).not.toMatch(/^\\/m);
  });

  it('inserts a table\'s rows only after the rows they reference', () => {
    const order = [...seed.matchAll(/^-- ([a-z_]+)$/gm)].map((m) => m[1]!);
    // pg_dump orders alphabetically, which would put colours first. Dependency
    // order is what makes the seed applicable without disabling triggers.
    expect(order.indexOf('tenants')).toBe(0);
    expect(order.indexOf('vehicle_models')).toBeLessThan(order.indexOf('colours'));
    expect(order.indexOf('vehicle_models')).toBeLessThan(order.indexOf('powertrains'));
    expect(order.indexOf('model_configurations')).toBeLessThan(order.indexOf('inventory_units'));
  });

  it('leaves out what the schema migrations already populate', () => {
    // Re-inserting the permission matrix would fail on its primary key.
    expect(seed).not.toContain('INSERT INTO public.role_permissions ');
    expect(seed).not.toContain('INSERT INTO public.inventory_transitions ');
  });

  it('leaves out anything a visitor did', () => {
    for (const table of [
      'conversations', 'messages', 'leads', 'lead_signals', 'customers',
      'appointments', 'tickets', 'audit_logs', 'job_queue', 'email_messages',
    ]) {
      expect.soft(seed, table).not.toContain(`INSERT INTO public.${table} `);
    }
  });

  it('registers the hostnames the deployment answers on', () => {
    expect(seed).toContain('INSERT INTO public.tenant_domains ');
    expect(seed).toContain('netlify.app');
  });
});
