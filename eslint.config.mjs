import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * Layering rules, enforced rather than documented.
 *
 * docs/02-project-structure.md states these as architecture. A rule that lives
 * only in a document is a rule that erodes: this file is what actually keeps
 * business logic out of components and secrets out of the browser bundle.
 */
export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'db/validate/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ---- Components are presentation. They may not reach the server layer. ----
  {
    files: ['src/components/**/*.{ts,tsx}', 'src/lib/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/*', '@/server/**'],
              message:
                'Components must not import from src/server. Pass data in as props from a ' +
                'server component, or the module may end up in the browser bundle.',
            },
            {
              group: ['postgres', 'drizzle-orm', 'drizzle-orm/*'],
              message: 'Database access belongs in src/server, never in a component.',
            },
          ],
        },
      ],
    },
  },

  // ---- Routes call services. They may not reach repositories or the pool. ----
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/db/repositories/*', '@/server/db/client'],
              message:
                'Route handlers and pages call services, not repositories or the raw ' +
                'client. Business logic belongs in src/server/services.',
            },
          ],
        },
      ],
    },
  },

  // ---- AI tools call services, never repositories. ----
  {
    files: ['src/server/ai/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/db/*', '@/server/db/**'],
              message:
                'AI tools must call services, so they pass through the same validation the ' +
                'Dealer Portal does. A tool that queries directly is how the assistant ends ' +
                'up able to do things the UI forbids.',
            },
          ],
        },
      ],
    },
  },

  // ---- Only one module opens a connection. ----
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/server/db/client.ts', 'src/server/db/migrate.ts', 'src/server/auth/dev-directory.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'postgres',
              message:
                'Connections are created in src/server/db/client.ts only. Use withTenant().',
            },
          ],
        },
      ],
    },
  },

  // ---- Only the env module reads process.env. ----
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    // migrate.ts is a CLI entry point that runs before the app boots, so it
    // reads its connection string directly rather than through the validated env.
    ignores: [
      'src/server/config/env.ts',
      // Populating process.env from a dotenv file is this module's entire job.
      'src/server/config/load-env-file.ts',
      'src/middleware.ts',
      'src/server/db/migrate.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'Read configuration from @/server/config/env, which validates it. Scattered ' +
            'process.env reads are how a secret reaches a module that gets bundled for ' +
            'the browser.',
        },
      ],
    },
  },

  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'db/**/*.ts', 'src/server/db/migrate.ts'],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off', 'no-restricted-imports': 'off' },
  },
];
