import type { ZodTypeAny, z } from 'zod';
import type { TenantDb } from '@/server/db/tenant-db';

/**
 * Tool definition.
 *
 * Read `docs/03-ai-tools.md` alongside this file. The registry enforces four
 * invariants at registration time, so a tool that breaks one fails at startup
 * rather than in a customer conversation.
 */

export interface ToolContext {
  /** From the hostname. Never a tool parameter — the model cannot name a tenant. */
  tenantId: string;
  conversationId: string;
  visitorId: string;
  /** Set only once the visitor has identified themselves. */
  customerId?: string;
  requestId: string;
  now: Date;
  tenant: {
    brandName: string;
    timezone: string;
    locale: string;
    currency: string;
    ticketPrefix: string;
  };
  /** Tenant-scoped transaction, opened by the dispatcher. */
  db: TenantDb;
}

export interface ToolDefinition<I extends ZodTypeAny = ZodTypeAny, O = unknown> {
  name: string;
  scope: 'read' | 'write';
  /** Becomes the tool description the model sees. Written for the model. */
  summary: string;
  input: I;
  /**
   * Required for every write tool. Derives a stable key so a retried or
   * duplicated call returns the first result rather than booking twice.
   */
  idempotent?: (input: z.infer<I>, ctx: ToolContext) => string;
  handler: (ctx: ToolContext, input: z.infer<I>) => Promise<O>;
  /**
   * The leak boundary: an explicit, hand-written projection of the result.
   * Nothing reaches the model's context without passing through one of these.
   */
  project: (output: O, ctx: ToolContext) => unknown;
}

export function defineTool<I extends ZodTypeAny, O>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return definition;
}

/**
 * Identity fields the model may never supply.
 *
 * These come from the server-side session. If a tool could accept one, a
 * conversation could ask for another dealership's data simply by saying so —
 * which is the whole attack against a multi-tenant assistant.
 */
export const FORBIDDEN_INPUT_FIELDS = [
  'tenantId', 'tenant_id', 'tenantSlug',
  'customerId', 'customer_id',
  'visitorId', 'visitor_id',
  'conversationId', 'conversation_id',
  'staffId', 'staff_id', 'userId', 'user_id',
] as const;

/**
 * Query-shaped fields. A tool is a fixed question with typed parameters; a
 * parameter that carries a filter, a table name or an ordering is a query
 * surface by another name.
 */
export const FORBIDDEN_QUERY_FIELDS = [
  'sql', 'query', 'where', 'filter', 'orderBy', 'order_by',
  'table', 'tableName', 'columns', 'select', 'raw',
] as const;
