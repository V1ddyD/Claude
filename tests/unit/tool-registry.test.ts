import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/server/ai/tools/registry';
import { defineTool } from '../../src/server/ai/tools/define';
import { TOOLS } from '../../src/server/ai/tools';

/**
 * The registry's four invariants (docs/03-ai-tools.md).
 *
 * These are checked at construction, so a tool that breaks one fails at startup
 * rather than in a customer conversation — and this suite is what proves the
 * check is real rather than a comment.
 */

const ok = {
  scope: 'read' as const,
  summary: 'A tool.',
  handler: async () => ({ value: 1 }),
  project: (o: { value: number }) => o,
};

describe('identity may never be a tool parameter', () => {
  it.each(['tenantId', 'customerId', 'visitorId', 'conversationId', 'tenant_id', 'staffId'])(
    'rejects a tool declaring %s',
    (field) => {
      const tool = defineTool({
        ...ok, name: 'bad', input: z.object({ [field]: z.string() }),
      });
      expect(() => new ToolRegistry([tool])).toThrow(/Identity comes from the server-side session/);
    },
  );

  it('accepts ordinary domain parameters', () => {
    const tool = defineTool({
      ...ok, name: 'fine', input: z.object({ modelSlug: z.string(), limit: z.number() }),
    });
    expect(() => new ToolRegistry([tool])).not.toThrow();
  });
});

describe('tools may not expose a query surface', () => {
  it.each(['sql', 'query', 'where', 'filter', 'orderBy', 'table', 'columns'])(
    'rejects a tool declaring %s',
    (field) => {
      const tool = defineTool({ ...ok, name: 'bad', input: z.object({ [field]: z.string() }) });
      expect(() => new ToolRegistry([tool])).toThrow(/query surface/);
    },
  );
});

describe('write tools', () => {
  it('must declare idempotency', () => {
    const tool = defineTool({
      ...ok, name: 'writes', scope: 'write', input: z.object({ a: z.string() }),
    });
    expect(() => new ToolRegistry([tool])).toThrow(/must define idempotent/);
  });

  it('are accepted once they do', () => {
    const tool = defineTool({
      ...ok, name: 'writes', scope: 'write', input: z.object({ a: z.string() }),
      idempotent: (i: { a: string }) => i.a,
    });
    expect(() => new ToolRegistry([tool])).not.toThrow();
  });
});

describe('every tool must project its result', () => {
  it('is rejected without one', () => {
    const tool = {
      name: 'unprojected', scope: 'read' as const, summary: 'x',
      input: z.object({}), handler: async () => ({ secret: 1 }),
    };
    // @ts-expect-error deliberately missing project
    expect(() => new ToolRegistry([tool])).toThrow(/must define project/);
  });
});

describe('the real tool set', () => {
  const registry = new ToolRegistry(TOOLS);

  it('builds', () => {
    expect(registry.list().length).toBe(TOOLS.length);
  });

  it('produces a schema the model API can consume', () => {
    for (const schema of registry.schemas()) {
      expect.soft(schema.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      expect.soft(schema.description.length).toBeGreaterThan(20);
      expect.soft(schema.input_schema).toHaveProperty('type', 'object');
    }
  });

  it('has exactly one write tool in the walking skeleton', () => {
    const writes = TOOLS.filter((t) => t.scope === 'write');
    expect(writes.map((t) => t.name)).toEqual(['createTestDrive']);
  });

  it('does not include the tools that would breach a stated rule', () => {
    const names = TOOLS.map((t) => t.name);
    // Each of these appears in spec §9 but breaches a rule stated elsewhere in
    // the same specification. See docs/03-ai-tools.md.
    expect(names).not.toContain('getCustomerProfile');
    expect(names).not.toContain('sendConfirmationEmail');
    expect(names).not.toContain('updateLead');
    expect(names).not.toContain('getLeadConversation');
  });

  it('has no tool that deletes or changes inventory state', () => {
    for (const name of TOOLS.map((t) => t.name)) {
      expect.soft(name).not.toMatch(/delete|remove|cancelAll|reserve|markSold/i);
    }
  });

  it('caps every list-returning tool', () => {
    // An uncapped tool is how the entire catalogue ends up in a reply (spec §7).
    const uncapped = TOOLS.filter((t) => {
      const source = t.handler.toString();
      return /\.select\(/.test(source) && !/limit\(/.test(source);
    });
    expect(uncapped.map((t) => t.name)).toEqual([]);
  });
});
