import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The customer never supplies, sees, or is asked for an API key.
 *
 * The key belongs to the dealership's deployment: set once, server-side, by
 * whoever runs the platform. A visitor opens the chat and types — nothing else.
 *
 * CI greps the built bundle for the same thing, but a grep only runs in CI and
 * only after a build. These assertions state the intent where the code lives.
 */

function walk(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, match));
    else if (match.test(entry)) out.push(path);
  }
  return out;
}

const SERVER_FILES = walk('src/server', /\.ts$/);
const CLIENT_FILES = [...walk('src/components', /\.tsx?$/), ...walk('src/lib', /\.ts$/)];

describe('the key is server-side only', () => {
  it('is read by exactly one module', () => {
    const readers = SERVER_FILES.filter((file) =>
      /env\.ANTHROPIC_API_KEY|process\.env\.ANTHROPIC_API_KEY/.test(readFileSync(file, 'utf8')),
    );
    // env.ts declares it; client.ts consumes it. Nothing else may touch it.
    expect(readers.sort()).toEqual([
      'src/server/ai/client.ts',
      'src/server/config/env.ts',
    ]);
  });

  it('has no NEXT_PUBLIC_ alias, which would ship it to the browser', () => {
    const all = [...SERVER_FILES, ...CLIENT_FILES, 'src/server/config/env.ts'];
    for (const file of all) {
      const source = readFileSync(file, 'utf8');
      expect.soft(source, `${file} exposes the key publicly`).not.toMatch(
        /NEXT_PUBLIC_[A-Z_]*ANTHROPIC/,
      );
    }
  });

  it('is never mentioned in anything the browser downloads', () => {
    for (const file of CLIENT_FILES) {
      const source = readFileSync(file, 'utf8');
      expect.soft(source, `${file} references the key`).not.toContain('ANTHROPIC_API_KEY');

      // A VALUE import of server code would pull that module into the bundle.
      // `import type` is erased at compile time and reaches nothing, which is
      // why the portal shell can type its props against StaffContext safely.
      const valueImports = source
        .split('\n')
        .filter((line) => /^import\s/.test(line) && !/^import\s+type\s/.test(line))
        .filter((line) => line.includes("from '@/server/"));

      expect.soft(valueImports, `${file} imports server code as a value`).toEqual([]);
    }
  });
});

describe('the chat request', () => {
  const assistant = readFileSync('src/components/site/assistant.tsx', 'utf8');

  it('carries only the customer\'s message, their conversation, and a transport flag', () => {
    const body = /body: JSON\.stringify\(\{([^}]*)\}\)/.exec(assistant)?.[1] ?? '';
    const fields = body
      .split(',')
      .map((part) => part.split(':')[0]!.trim())
      .filter(Boolean);

    // Pinned exactly, so a new field is a deliberate act. `stream` asks for
    // server-sent events; it carries no identity and no credential.
    //
    // What must never appear: a key, a model name, a tenant, a customer id —
    // the server knows every one of those from the request itself.
    expect(fields.sort()).toEqual(['conversationId', 'message', 'stream']);
  });

  it('offers the customer no way to supply a key', () => {
    expect(assistant).not.toMatch(/api[ _-]?key/i);
    expect(assistant).not.toMatch(/token|credential|secret/i);
  });
});

describe('when the deployment has no key configured', () => {
  const conversation = readFileSync('src/server/ai/conversation.ts', 'utf8');

  it('tells the customer something true and useful, not something technical', () => {
    // The message is assembled from several template literals, so the whole
    // degraded-return block is read rather than one of them.
    const block = /if \(!client\) \{[\s\S]*?\n    \};?\n  \}/.exec(conversation)?.[0] ?? '';
    const degraded = block.replace(/\/\/.*$/gm, '');

    expect(degraded).toContain('team');
    // The customer is not an operator. They must never be shown configuration,
    // asked for a key, or told which service is missing.
    expect(degraded).not.toMatch(/api|key|token|configure|environment|anthropic/i);
  });
});
