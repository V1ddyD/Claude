import { readFileSync, existsSync } from 'node:fs';

/**
 * Loads connection details written by `scripts/test-db.sh start`, so `npm test`
 * works without the caller keeping variables exported in their shell.
 * Real environment always wins, which is how CI supplies its service container.
 */
const file = '.env.test.local';
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2];
    }
  }
}
if (!process.env.NODE_ENV) {
  Object.assign(process.env, { NODE_ENV: 'test' });
}

/**
 * Email delivery, as a configured deployment has it.
 *
 * Without a provider the assistant rightly never mentions a confirmation
 * email, so most tests would stop seeing the wording they assert. A stand-in
 * that accepts everything keeps the default case the configured one; the
 * email tests install their own recorder, and the unconfigured case is
 * tested by resetting to null.
 */
const { setEmailProvider } = await import('../src/server/services/email/provider');
let sent = 0;
setEmailProvider({
  name: 'test-default',
  async send() {
    sent++;
    return { accepted: true, providerMessageId: `test-${sent}` };
  },
});
