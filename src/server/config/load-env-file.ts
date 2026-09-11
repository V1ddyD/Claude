import { readFileSync, existsSync } from 'node:fs';

/**
 * Loads `.env.test.local` / `.env.local` for CLI entry points (migrations,
 * seeds). The Next.js runtime loads these itself; standalone scripts do not,
 * which otherwise makes `npm run db:migrate` fail immediately after
 * `./scripts/test-db.sh start` for no reason a newcomer could guess.
 *
 * Real environment always wins, so CI and production are unaffected.
 */
export function loadEnvFile(...files: string[]): void {
  for (const file of files.length > 0 ? files : ['.env.test.local', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match && process.env[match[1]!] === undefined) {
        process.env[match[1]!] = match[2];
      }
    }
  }
}
