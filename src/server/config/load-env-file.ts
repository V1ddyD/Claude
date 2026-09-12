import { readFileSync, existsSync } from 'node:fs';

/**
 * Loads `.env.local` / `.env.test.local` for CLI entry points (migrations,
 * seeds). The Next.js runtime loads these itself; standalone scripts do not,
 * which otherwise makes `npm run db:migrate` fail immediately after
 * `./scripts/test-db.sh start` for no reason a newcomer could guess.
 *
 * `.env.local` FIRST, because that is the developer's chosen configuration and
 * it is what Next.js reads. The order used to be the other way round, so on a
 * machine that had ever run `scripts/test-db.sh` the migration and the seed
 * quietly targeted the throwaway test database while `npm run dev` targeted the
 * real one: both commands reported success and every page then returned 500.
 *
 * `npm test` is unaffected — `tests/setup.ts` reads `.env.test.local` itself,
 * before any of this, and real environment always wins.
 */
export function loadEnvFile(...files: string[]): void {
  for (const file of files.length > 0 ? files : ['.env.local', '.env.test.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match && process.env[match[1]!] === undefined) {
        process.env[match[1]!] = match[2];
      }
    }
  }
}
