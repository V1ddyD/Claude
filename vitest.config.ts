import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Integration and isolation tests share one database; running files in
    // parallel would let one suite's fixtures race another's assertions.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      // `server-only` throws when resolved outside a React Server Component.
      // Under Vitest there is no RSC graph, so it resolves to the package's own
      // no-op build. The guard still does its job where it matters: the Next.js
      // bundler, which is what would otherwise ship a server module to a browser.
      'server-only': resolve(import.meta.dirname, 'node_modules/server-only/empty.js'),
    },
  },
});
